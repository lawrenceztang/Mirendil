import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const task=process.env.TASK||'Inspect the repository';
const root=process.env.WORKSPACE_ROOT||'/workspace';
const execFileAsync=promisify(execFile);

async function files(dir=root,depth=0){
  if(depth>3)return[];const result=[];
  for(const entry of await fs.readdir(dir,{withFileTypes:true})){
    if(['.git','node_modules','dist','.relay-diff.patch'].includes(entry.name))continue;
    const item=path.join(dir,entry.name);
    if(entry.isDirectory())result.push(...await files(item,depth+1));else result.push(path.relative(root,item));
    if(result.length>100)break;
  }
  return result;
}

if(!process.env.OPENAI_API_KEY){
  const repoFiles=await files();
  const report=`# Relay demo run\n\n## Request\n\n${task}\n\n## Repository snapshot\n\n${repoFiles.slice(0,30).map(x=>`- ${x}`).join('\n')||'- Empty workspace'}\n\n## Next step\n\nAdd an OPENAI_API_KEY to enable the Codex coding agent.\n`;
  await fs.writeFile(path.join(root,'RELAY_DEMO_RESULT.md'),report);
  console.log('RELAY_RESULT: Demo completed in an isolated container and produced RELAY_DEMO_RESULT.md.');
  process.exit(0);
}

const finalMessage='/tmp/codex-last-message.txt';
const codexHome='/home/agent/.codex';
await fs.mkdir(codexHome,{recursive:true,mode:0o700});
const {stdout:codexVersion}=await execFileAsync('codex',['--version']);
console.log(`RELAY_CODEX: ${codexVersion.trim()}`);
const codexEnv={...process.env,CODEX_HOME:codexHome};
await new Promise((resolve,reject)=>{
  const login=spawn('codex',['login','--with-api-key'],{stdio:['pipe','inherit','inherit'],env:codexEnv});
  login.on('error',reject);login.on('close',code=>code===0?resolve():reject(new Error(`Codex API-key login exited with status ${code}`)));
  login.stdin.end(`${process.env.OPENAI_API_KEY}\n`);
});
delete codexEnv.OPENAI_API_KEY;
const prompt=`Work on this repository as an autonomous coding agent.\n\nUser request: ${task}\n\nInspect the existing code, make the smallest complete change, and run relevant tests or checks. Do not only explain what to do: implement it. Do not commit, push, or modify .git; Relay handles delivery. Finish with a concise summary and verification results.`;
const args=['exec','--dangerously-bypass-approvals-and-sandbox','--ephemeral','--ignore-user-config','--skip-git-repo-check','--color','never','--output-last-message',finalMessage,'--cd',root];
if(process.env.CODEX_MODEL)args.push('--model',process.env.CODEX_MODEL);
args.push(prompt);

const exitCode=await new Promise((resolve,reject)=>{
  const child=spawn('codex',args,{cwd:root,stdio:['ignore','inherit','inherit'],env:codexEnv});
  child.on('error',reject);child.on('close',resolve);
});
if(exitCode!==0)throw new Error(`Codex exited with status ${exitCode}`);
let summary='Codex completed the repository task.';
try{summary=(await fs.readFile(finalMessage,'utf8')).trim()||summary;}catch{}
console.log(`RELAY_RESULT: ${summary.replaceAll('\n',' ').slice(0,4000)}`);
