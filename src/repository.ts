import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import type { Session } from './types.js';

export function validateRepoUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || !config.allowedGitHosts.includes(url.hostname)) throw new Error(`Only HTTPS repositories on ${config.allowedGitHosts.join(', ')} are allowed`);
  if (url.username || url.password) throw new Error('Do not put credentials in repository URLs');
  return url;
}

export function remoteBranchRefspec(branch:string):string{return `+refs/heads/${branch}:refs/remotes/origin/${branch}`;}

export function command(command: string, args: string[], cwd: string, timeout = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ['ignore','pipe','pipe'] });
    let out='', err=''; const timer=setTimeout(()=>child.kill('SIGKILL'),timeout);
    child.stdout.on('data', d => { if (out.length < 2_000_000) out += d; }); child.stderr.on('data', d => { if (err.length < 200_000) err += d; });
    child.on('error', reject); child.on('close', code => { clearTimeout(timer); code===0 ? resolve(out.trim()) : reject(new Error(err.trim() || `${command} exited ${code}`)); });
  });
}

export async function ensureWorkspace(session: Session, githubToken?: string | null): Promise<string> {
  const dir = path.join(config.workspaceRoot, session.id);
  await fs.mkdir(config.workspaceRoot, { recursive: true });
  let exists=true;try{await fs.access(path.join(dir,'.git'));}catch{exists=false;}
  if(exists){
    if(session.prBranch){
      const safe=['-c',`safe.directory=${dir}`];
      try{await command('git',[...safe,'switch',session.prBranch],dir);}
      catch{const url=validateRepoUrl(session.repoUrl!);const auth=githubToken?['-c',`http.${url.origin}/.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${githubToken}`).toString('base64')}`]:[];await command('git',[...safe,...auth,'fetch','origin',remoteBranchRefspec(session.prBranch)],dir);await command('git',[...safe,'switch','-c',session.prBranch,`refs/remotes/origin/${session.prBranch}`],dir);}
    }
    return dir;
  }
  await fs.mkdir(dir, { recursive: true });
  if (!session.repoUrl) {
    await command('git',['init'],dir); await fs.writeFile(path.join(dir,'README.md'),'# New Relay workspace\n'); return dir;
  }
  const url=validateRepoUrl(session.repoUrl); const args:string[]=[];
  if(githubToken&&url.hostname==='github.com')args.push('-c',`http.${url.origin}/.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${githubToken}`).toString('base64')}`);
  args.push('clone','--depth=1');
  if(session.branch) args.push('--branch',session.branch); args.push(url.toString(),'.');
  await command('git',args,dir,300_000); return dir;
}

export async function changedFiles(workspace:string):Promise<string[]>{const output=await command('git',['-c',`safe.directory=${workspace}`,'status','--porcelain','--untracked-files=all'],workspace);return output.split('\n').filter(Boolean).map(line=>line.slice(3)).filter(file=>file!=='.relay-diff.patch');}

export async function headRevision(workspace:string):Promise<string>{return command('git',['-c',`safe.directory=${workspace}`,'rev-parse','HEAD'],workspace);}

export async function pullRequestState(session:Session,githubToken:string,request:typeof fetch=fetch):Promise<'open'|'closed'|'merged'>{
  if(!session.prUrl||!session.repoUrl)return 'closed';
  const repoUrl=validateRepoUrl(session.repoUrl);const prUrl=new URL(session.prUrl);
  const repoParts=repoUrl.pathname.replace(/^\//,'').replace(/\.git$/,'').split('/');const parts=prUrl.pathname.replace(/^\//,'').split('/');const number=parts[3];
  if(prUrl.hostname!=='github.com'||parts.length!==4||parts[0]!==repoParts[0]||parts[1]!==repoParts[1]||parts[2]!=='pull'||!number||!/^\d+$/.test(number))return 'closed';
  const response=await request(`https://api.github.com/repos/${parts[0]}/${parts[1]}/pulls/${number}`,{headers:{Authorization:`Bearer ${githubToken}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'relay-cloud-agent'}});
  if(!response.ok)throw new Error(`GitHub PR lookup failed (${response.status}): ${(await response.text()).slice(0,500)}`);
  const pull=await response.json() as {state?:string;merged_at?:string|null};
  return pull.merged_at?'merged':pull.state==='open'?'open':'closed';
}

export async function prepareAgentBranch(session:Session,workspace:string,githubToken?:string|null):Promise<{branch:string;replacedPullRequest:boolean}>{
  const git=(args:string[])=>command('git',['-c',`safe.directory=${workspace}`,...args],workspace);
  const pullState=githubToken&&session.prUrl?await pullRequestState(session,githubToken):'open';
  if(pullState!=='open'){
    const url=validateRepoUrl(session.repoUrl!);const auth=['-c',`http.${url.origin}/.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${githubToken}`).toString('base64')}`];
    const branch=`relay/chat-${session.id.slice(0,8)}-${crypto.randomUUID().slice(0,8)}`;
    if(pullState==='merged'){
      let base=session.branch;
      if(!base){try{base=(await git(['symbolic-ref','refs/remotes/origin/HEAD','--short'])).replace(/^origin\//,'');}catch{base='main';}}
      await git([...auth,'fetch','origin',base]);
      await git(['switch','-c',branch,`origin/${base}`]);
    }else await git(['switch','-c',branch]);
    return {branch,replacedPullRequest:true};
  }
  const branch=session.prBranch||`relay/chat-${session.id.slice(0,8)}`;
  try{await git(['switch',branch]);}catch{await git(['switch','-c',branch]);}
  return {branch,replacedPullRequest:false};
}

export async function makeAgentWritable(workspace:string,includeDependencies=true):Promise<void>{
  async function visit(current:string):Promise<void>{
    const stat=await fs.lstat(current);if(stat.isSymbolicLink())return;
    if(stat.isDirectory())for(const entry of await fs.readdir(current)){if(!includeDependencies&&entry==='node_modules')continue;await visit(path.join(current,entry));}
    await fs.chmod(current,stat.mode|(stat.isDirectory()?0o777:0o666));
  }
  await visit(workspace);
}
