import Docker from 'dockerode';
import { Writable } from 'node:stream';
import { config } from './config.js';
import { db } from './db.js';
import { changedFiles, ensureWorkspace, makeAgentWritable, prepareAgentBranch } from './repository.js';
import type { Run, Session } from './types.js';
import { vault } from './vault.js';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

export function chatContainerName(sessionId: string): string {
  return `relay-chat-${sessionId}`;
}

export function codexVolumeName(sessionId:string):string{return `relay-codex-${sessionId}`;}

async function chatContainer(session: Session, workspace: string): Promise<{container:Docker.Container;reused:boolean}> {
  const name=chatContainerName(session.id);
  const image=await docker.getImage(config.agentImage).inspect();
  const existing=docker.getContainer(name);
  try {
    const details=await existing.inspect();
    const hasWorkspace=details.Mounts.some(m=>m.Destination==='/workspace'&&m.Source===workspace&&m.RW);
    const hasCodexHome=details.Mounts.some(m=>m.Destination==='/home/agent/.codex'&&m.Name===codexVolumeName(session.id)&&m.RW);
    if(details.State.Running&&details.Image===image.Id&&hasWorkspace&&hasCodexHome)return {container:existing,reused:true};
    await existing.remove({force:true});
  } catch(error) {
    const status=(error as {statusCode?:number}).statusCode;
    if(status!==404)throw error;
  }
  const created=await docker.createContainer({
    Image:config.agentImage,
    name,
    Labels:{'relay.chat':session.id},
    Entrypoint:['/bin/sh','-c'], Cmd:['while :; do sleep 3600; done'],
    WorkingDir:'/workspace', User:'10001:10001',
    HostConfig:{ AutoRemove:false, NetworkMode:'bridge', Memory:1024*1024*1024, NanoCpus:1_000_000_000, PidsLimit:128, CapDrop:['ALL'], SecurityOpt:['no-new-privileges'], Mounts:[{Type:'bind',Source:workspace,Target:'/workspace',ReadOnly:false},{Type:'volume',Source:codexVolumeName(session.id),Target:'/home/agent/.codex',ReadOnly:false}] }
  });
  await created.start();
  return {container:created,reused:false};
}

export async function execute(run: Run, session: Session, signal: AbortSignal): Promise<string> {
  const githubToken=session.userId&&session.repoUrl?.includes('github.com')?await vault.getUser(session.userId,'github_token'):null;
  const openAiKey=session.userId?await vault.getUser(session.userId,'openai_api_key'):null;
  const workspace=await ensureWorkspace(session,githubToken);
  const prepared=await prepareAgentBranch(session,workspace,githubToken);const branch=prepared.branch;
  if(prepared.replacedMergedPullRequest){await db.replaceMergedPullRequest(session.id,branch);session.prUrl=null;session.prBranch=branch;await db.addEvent(run.id,'setup','Starting a new pull request',`The previous pull request was merged; using ${branch}`);}
  else if(!session.prBranch){await db.setSessionBranch(session.id,branch);session.prBranch=branch;}
  else if(session.prUrl)await db.setPullRequest(run.id,session.prUrl);
  const chat=await chatContainer(session,workspace);const container=chat.container;
  await makeAgentWritable(workspace,!chat.reused||prepared.replacedMergedPullRequest);
  if(!chat.reused)await db.addEvent(run.id,'setup','Starting new chat container',`${config.agentImage} · ${session.repoUrl||'Blank workspace'}`);
  const agent=await container.exec({
    Cmd:['node','/runner/run.js'], AttachStdout:true, AttachStderr:true,
    Env:[`RUN_ID=${run.id}`,`TASK=${run.prompt}`,`AGENT_COUNT=${session.agentCount}`,`OPENAI_API_KEY=${openAiKey||''}`,`GITHUB_TOKEN=${githubToken||''}`,`CODEX_MODEL=${process.env.CODEX_MODEL||''}`,`CODEX_THINKING_LEVEL=${run.thinkingLevel||''}`,`DIRECT_WORKSPACE=1`],
    WorkingDir:'/workspace', User:'10001:10001'
  });
  let output='';
  const stream=await agent.start({hijack:true,stdin:false});
  await db.addEvent(run.id,'agent',chat.reused?'Continuing Codex conversation':'Codex process started',chat.reused?'Prompt passed to the existing chat thread':branch);
  const sink=new Writable({write(chunk,_encoding,callback){output=(output+chunk.toString()).slice(-2_000_000);callback();}});
  docker.modem.demuxStream(stream,sink,sink);
  const stop=async()=>{ try { await container.remove({force:true}); } catch {} };
  signal.addEventListener('abort',stop,{once:true});
  await new Promise<void>((resolve,reject)=>{stream.on('end',resolve);stream.on('error',reject);});
  const result=await agent.inspect(); signal.removeEventListener('abort',stop);
  if(signal.aborted)throw new Error('Run cancelled');
  if(result.ExitCode!==0)throw new Error(output.slice(-4000)||`Agent exited ${result.ExitCode}`);
  const codexMarker=output.split('\n').find(line=>line.startsWith('RELAY_CODEX:'));
  if(codexMarker)await db.addEvent(run.id,'agent','Codex agent verified',codexMarker.slice('RELAY_CODEX:'.length).trim());
  const changes=await changedFiles(workspace);
  if(changes.length)await db.addEvent(run.id,'result','Repository files changed',changes.slice(0,20).join(', '));
  const marker=output.split('\n').find(line=>line.startsWith('RELAY_RESULT:'));
  const summary=marker ? marker.slice('RELAY_RESULT:'.length).trim() : 'The agent completed its workspace task.';
  const prMarker=output.split('\n').filter(line=>line.startsWith('RELAY_PR:')).at(-1);
  if(prMarker){
    const published=JSON.parse(prMarker.slice('RELAY_PR:'.length)) as {url:string;branch:string};const url=new URL(published.url);
    if(url.protocol==='https:'&&url.hostname==='github.com'&&/^\/[^/]+\/[^/]+\/pull\/\d+$/.test(url.pathname)&&published.branch){await db.setPullRequest(run.id,published.url);await db.setSessionPullRequest(session.id,published.url,published.branch);await db.addEvent(run.id,'publish','Pull request published by Codex',published.url);}
  }
  return summary;
}
