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

export async function prepareAgentOutput(runId:string):Promise<string>{const output=path.join(config.workspaceRoot,'.relay-outputs',runId);await fs.rm(output,{recursive:true,force:true});await fs.mkdir(output,{recursive:true});
  // Bind mounts retain host ownership. A per-run staging directory must be
  // writable by the unprivileged agent on both Linux and Docker Desktop,
  // where changing host ownership from a container may be rejected.
  await fs.chmod(output,0o777);return output;}

export async function applyAgentOutput(workspace:string,output:string):Promise<void>{
  let files=0,bytes=0;const root=path.resolve(output);
  async function validate(current:string):Promise<void>{for(const entry of await fs.readdir(current,{withFileTypes:true})){if(entry.name==='.git')throw new Error('Agent output contained forbidden .git metadata');const item=path.join(current,entry.name);const stat=await fs.lstat(item);if(stat.isSymbolicLink()){const target=await fs.readlink(item);const resolved=path.resolve(path.dirname(item),target);if(resolved!==root&&!resolved.startsWith(`${root}${path.sep}`))throw new Error(`Agent output contained unsafe symlink: ${path.relative(root,item)}`);}else if(stat.isDirectory())await validate(item);else if(stat.isFile()){files++;bytes+=stat.size;if(files>10_000||bytes>200_000_000)throw new Error('Agent output exceeded import limits');}else throw new Error('Agent output contained an unsupported file type');}}
  await validate(root);
  for(const entry of await fs.readdir(workspace)){if(entry!=='.git')await fs.rm(path.join(workspace,entry),{recursive:true,force:true});}
  for(const entry of await fs.readdir(root)){await fs.cp(path.join(root,entry),path.join(workspace,entry),{recursive:true,force:true,verbatimSymlinks:true});}
  await fs.rm(output,{recursive:true,force:true});
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
  const staged=await git(['status','--porcelain']); if(!staged)return null;
  await git(['commit','-m',`Relay: ${prompt.replaceAll('\n',' ').slice(0,72)}`]);
  const auth=Buffer.from(`x-access-token:${githubToken}`).toString('base64');
  await git(['-c',`http.${url.origin}/.extraHeader=Authorization: Basic ${auth}`,'push','--set-upstream','origin',branch]);
  if(session.prUrl)return {url:session.prUrl,branch,created:false};
  let base=session.branch;
  if(!base){try{base=(await git(['symbolic-ref','refs/remotes/origin/HEAD','--short'])).replace(/^origin\//,'');}catch{base='main';}}
  const response=await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`,{method:'POST',headers:{Authorization:`Bearer ${githubToken}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'relay-cloud-agent','Content-Type':'application/json'},body:JSON.stringify({title:prompt.replaceAll('\n',' ').slice(0,120),head:branch,base,body:`## Relay summary\n\n${summary}\n\nRun: \`${runId}\``,draft:true})});
  if(!response.ok)throw new Error(`GitHub PR creation failed (${response.status}): ${(await response.text()).slice(0,500)}`);
  const result=await response.json() as {html_url?:string}; if(!result.html_url)throw new Error('GitHub returned no pull request URL'); return {url:result.html_url,branch,created:true};
}
