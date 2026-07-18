import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import { agentInstructions } from './instructions.js';

const task=process.env.TASK||'Inspect the repository';
const root=process.env.WORKSPACE_ROOT||'/workspace';
const input=process.env.REPO_INPUT||'/repo-input';
const output=process.env.REPO_OUTPUT||'/repo-output';
let direct=process.env.DIRECT_WORKSPACE==='1';
const execFileAsync=promisify(execFile);

// Docker exec environments can outlive worker/container revisions. If the
// legacy copy source is absent, the mounted /workspace is unambiguously the
// production direct-workspace mode.
if(!direct){try{await fs.access(input);}catch{direct=true;}}

// Copy mode remains available for runtime tests. Production directly mounts a
// chat-scoped working tree, including Git metadata for agent-controlled pushes.
if(!direct){const inputRoot=path.resolve(input);
  await fs.cp(input,root,{recursive:true,force:true,verbatimSymlinks:true,filter:source=>{
    const relative=path.relative(inputRoot,path.resolve(source));
    return relative!=='.git'&&!relative.startsWith(`.git${path.sep}`)&&relative!=='.relay-diff.patch';
  }});
}

// Copy mode preserves source modes, so normalize only that private copy.
async function makeOwnerWritable(current){
  const stat=await fs.lstat(current);
  if(stat.isSymbolicLink())return;
  await fs.chmod(current,stat.mode|(stat.isDirectory()?0o700:0o600));
  if(stat.isDirectory())for(const entry of await fs.readdir(current))await makeOwnerWritable(path.join(current,entry));
}
if(!direct)await makeOwnerWritable(root);
const writeProbe=path.join(root,'.relay-write-probe');
await fs.writeFile(writeProbe,'ok');
await fs.rm(writeProbe);
const rootStat=await fs.stat(root);
console.log(`RELAY_WORKSPACE: uid=${process.getuid?.()??'unknown'} owner=${rootStat.uid} mode=${(rootStat.mode&0o777).toString(8)} writable`);

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

async function exportOutput(){
  if(direct)return;
  for(const entry of await fs.readdir(output))await fs.rm(path.join(output,entry),{recursive:true,force:true});
  for(const entry of await fs.readdir(root)){
    if(entry==='.git'||entry==='.relay-diff.patch')continue;
    await fs.cp(path.join(root,entry),path.join(output,entry),{recursive:true,force:true,verbatimSymlinks:true});
  }
}

if(!process.env.OPENAI_API_KEY){
  const repoFiles=await files();
  const snapshot=repoFiles.slice(0,30).join(', ')||'empty workspace';
  await exportOutput();
  console.log(`RELAY_RESULT: Demo inspected the repository without changing it (${snapshot}). Add an OpenAI API key to enable answers and coding tasks.`);
  process.exit(0);
}

const finalMessage=path.join('/tmp',`codex-last-message-${process.env.RUN_ID||process.pid}.txt`);
const codexHome='/home/agent/.codex';
await fs.mkdir(codexHome,{recursive:true,mode:0o700});
const {stdout:codexVersion}=await execFileAsync('codex',['--version']);
console.log(`RELAY_CODEX: ${codexVersion.trim()}`);
const codexEnv={...process.env,CODEX_HOME:codexHome};
if(process.env.GITHUB_TOKEN){
  const auth=Buffer.from(`x-access-token:${process.env.GITHUB_TOKEN}`).toString('base64');
  Object.assign(codexEnv,{
    GH_TOKEN:process.env.GITHUB_TOKEN,
    GIT_CONFIG_COUNT:'4',
    GIT_CONFIG_KEY_0:'http.https://github.com/.extraHeader',GIT_CONFIG_VALUE_0:`Authorization: Basic ${auth}`,
    GIT_CONFIG_KEY_1:'user.name',GIT_CONFIG_VALUE_1:'Relay Agent',
    GIT_CONFIG_KEY_2:'user.email',GIT_CONFIG_VALUE_2:'relay-agent@users.noreply.github.com',
    GIT_CONFIG_KEY_3:'push.autoSetupRemote',GIT_CONFIG_VALUE_3:'true'
  });
}
const keyMarker=path.join(codexHome,'.relay-key-hash');
const keyHash=crypto.createHash('sha256').update(process.env.OPENAI_API_KEY).digest('hex');
let authenticated=false;try{authenticated=(await fs.readFile(keyMarker,'utf8'))===keyHash;}catch{}
if(!authenticated){await new Promise((resolve,reject)=>{
    const login=spawn('codex',['login','--with-api-key'],{stdio:['pipe','inherit','inherit'],env:codexEnv});
    login.on('error',reject);login.on('close',code=>code===0?resolve():reject(new Error(`Codex API-key login exited with status ${code}`)));
    login.stdin.end(`${process.env.OPENAI_API_KEY}\n`);
  });await fs.writeFile(keyMarker,keyHash,{mode:0o600});
}
delete codexEnv.OPENAI_API_KEY;
const threadMarker=path.join(codexHome,'.relay-thread-started');
let continuing=false;try{await fs.access(threadMarker);continuing=true;}catch{}
const instructions=agentInstructions;
const prompt=continuing?`Continue the existing Relay chat.\n\nNew user request: ${task}\n\n${instructions}`:`Work in this repository as an autonomous agent.\n\nUser request: ${task}\n\n${instructions}`;
const args=continuing?['exec','resume','--last','--dangerously-bypass-approvals-and-sandbox','--ignore-user-config','--skip-git-repo-check','--output-last-message',finalMessage]:['exec','--dangerously-bypass-approvals-and-sandbox','--ignore-user-config','--skip-git-repo-check','--color','never','--output-last-message',finalMessage,'--cd',root];
if(process.env.CODEX_MODEL)args.push('--model',process.env.CODEX_MODEL);
if(process.env.CODEX_THINKING_LEVEL)args.push('--config',`model_reasoning_effort="${process.env.CODEX_THINKING_LEVEL}"`);
args.push(prompt);

const exitCode=await new Promise((resolve,reject)=>{
  const child=spawn('codex',args,{cwd:root,stdio:['ignore','inherit','inherit'],env:codexEnv});
  child.on('error',reject);child.on('close',resolve);
});
if(exitCode!==0)throw new Error(`Codex exited with status ${exitCode}`);
if(!continuing)await fs.writeFile(threadMarker,'started',{mode:0o600});
if(process.env.GITHUB_TOKEN){
  try{const {stdout:branchOutput}=await execFileAsync('git',['branch','--show-current'],{cwd:root,env:codexEnv});const branch=branchOutput.trim();if(branch){console.log(`RELAY_BRANCH: ${JSON.stringify({branch})}`);try{const {stdout:url}=await execFileAsync('gh',['pr','view','--json','url','--jq','.url'],{cwd:root,env:codexEnv});if(url.trim())console.log(`RELAY_PR: ${JSON.stringify({url:url.trim(),branch})}`);}catch{}}}catch{}
}
let summary='Codex completed the repository task.';
try{summary=(await fs.readFile(finalMessage,'utf8')).trim()||summary;}catch{}
await fs.rm(finalMessage,{force:true});
await exportOutput();
console.log(`RELAY_RESULT: ${summary.replaceAll('\n',' ').slice(0,4000)}`);
