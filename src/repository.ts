import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import type { Session } from './types.js';

export function validateRepoUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || !config.allowedGitHosts.includes(url.hostname)) throw new Error(`Only HTTPS repositories on ${config.allowedGitHosts.join(', ')} are allowed`);
  if (url.username || url.password) throw new Error('Do not put credentials in repository URLs');
  return url;
}

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
      catch{const url=validateRepoUrl(session.repoUrl!);const auth=githubToken?['-c',`http.${url.origin}/.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${githubToken}`).toString('base64')}`]:[];await command('git',[...safe,...auth,'fetch','origin',session.prBranch],dir);await command('git',[...safe,'switch','-c',session.prBranch,'--track',`origin/${session.prBranch}`],dir);}
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

export async function prepareAgentBranch(session:Session,workspace:string):Promise<string>{const branch=session.prBranch||`relay/chat-${session.id.slice(0,8)}`;const git=(args:string[])=>command('git',['-c',`safe.directory=${workspace}`,...args],workspace);
  try{await git(['switch',branch]);}catch{await git(['switch','-c',branch]);}return branch;}

export async function makeAgentWritable(workspace:string):Promise<void>{
  async function visit(current:string):Promise<void>{
    const stat=await fs.lstat(current);if(stat.isSymbolicLink())return;
    if(stat.isDirectory())for(const entry of await fs.readdir(current))await visit(path.join(current,entry));
    await fs.chmod(current,stat.mode|(stat.isDirectory()?0o777:0o666));
  }
  await visit(workspace);
}

export async function publishPullRequest(session: Session, runId: string, prompt: string, summary: string, workspace: string, githubToken: string): Promise<{url:string;branch:string;created:boolean} | null> {
  if(!githubToken || !session.repoUrl)return null;
  const url=validateRepoUrl(session.repoUrl);
  if(url.hostname!=='github.com')return null;
  const parts=url.pathname.replace(/^\//,'').replace(/\.git$/,'').split('/');
  if(parts.length!==2 || !parts[0] || !parts[1])throw new Error('GitHub repository URL must contain owner/repository');
  const [owner,repo]=parts; const branch=session.prBranch||`relay/chat-${session.id.slice(0,8)}`;
  const git=(args:string[])=>command('git',['-c',`safe.directory=${workspace}`,...args],workspace);
  await git(['config','user.name','Relay Agent']); await git(['config','user.email','relay-agent@users.noreply.github.com']);
  if(session.prBranch)await git(['switch',branch]);else await git(['switch','-c',branch]);
  await git(['add','-A','--', '.',':!.relay-diff.patch']);
  const staged=await git(['status','--porcelain']);
  if(staged)await git(['commit','-m',`Relay: ${prompt.replaceAll('\n',' ').slice(0,72)}`]);
  const auth=Buffer.from(`x-access-token:${githubToken}`).toString('base64');
  await git(['-c',`http.${url.origin}/.extraHeader=Authorization: Basic ${auth}`,'push','--set-upstream','origin',branch]);
  if(session.prUrl)return {url:session.prUrl,branch,created:false};
  let base=session.branch;
  if(!base){try{base=(await git(['symbolic-ref','refs/remotes/origin/HEAD','--short'])).replace(/^origin\//,'');}catch{base='main';}}
  const response=await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`,{method:'POST',headers:{Authorization:`Bearer ${githubToken}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'relay-cloud-agent','Content-Type':'application/json'},body:JSON.stringify({title:prompt.replaceAll('\n',' ').slice(0,120),head:branch,base,body:`## Relay summary\n\n${summary}\n\nRun: \`${runId}\``,draft:false})});
  if(!response.ok)throw new Error(`GitHub PR creation failed (${response.status}): ${(await response.text()).slice(0,500)}`);
  const result=await response.json() as {html_url?:string}; if(!result.html_url)throw new Error('GitHub returned no pull request URL'); return {url:result.html_url,branch,created:true};
}
