import Docker from 'dockerode';
import { Writable } from 'node:stream';
import { config } from './config.js';
import { db } from './db.js';
import { changedFiles, ensureWorkspace, headRevision, makeAgentWritable, prepareAgentBranch, publishPullRequest } from './repository.js';
import type { Run, Session } from './types.js';
import { vault } from './vault.js';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

export function chatContainerName(sessionId: string): string {
  return `relay-chat-${sessionId}`;
}

async function chatContainer(session: Session, workspace: string): Promise<Docker.Container> {
  const name=chatContainerName(session.id);
  const existing=docker.getContainer(name);
  try {
    const details=await existing.inspect();
    const hasWorkspace=details.Mounts.some(m=>m.Destination==='/workspace'&&m.Source===workspace&&m.RW);
    if(details.State.Running&&details.Config.Image===config.agentImage&&hasWorkspace)return existing;
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
    HostConfig:{ AutoRemove:false, NetworkMode:'bridge', Memory:1024*1024*1024, NanoCpus:1_000_000_000, PidsLimit:128, CapDrop:['ALL'], SecurityOpt:['no-new-privileges'], Mounts:[{Type:'bind',Source:workspace,Target:'/workspace',ReadOnly:false}] }
  });
  await created.start();
  return created;
}

export async function execute(run: Run, session: Session, signal: AbortSignal): Promise<string> {
  await db.addEvent(run.id,'setup','Preparing isolated workspace',session.repoUrl || 'Blank git workspace');
  const githubToken=session.userId&&session.repoUrl?.includes('github.com')?await vault.getUser(session.userId,'github_token'):null;
  const openAiKey=session.userId?await vault.getUser(session.userId,'openai_api_key'):null;
  const workspace=await ensureWorkspace(session,githubToken);
  const branch=await prepareAgentBranch(session,workspace);if(!session.prBranch){await db.setSessionBranch(session.id,branch);session.prBranch=branch;}
  const headBefore=await headRevision(workspace);
  await makeAgentWritable(workspace);
  await db.addEvent(run.id,'setup','Mounting scoped Codex workspace',`Codex may commit and push ${branch}`);
  await db.addEvent(run.id,'setup','Starting Codex agent in chat container',config.agentImage);
  const container=await chatContainer(session,workspace);
  const agent=await container.exec({
    Cmd:['node','/runner/run.js'], AttachStdout:true, AttachStderr:true,
    Env:[`RUN_ID=${run.id}`,`TASK=${run.prompt}`,`AGENT_COUNT=${session.agentCount}`,`OPENAI_API_KEY=${openAiKey||''}`,`GITHUB_TOKEN=${githubToken||''}`,`CODEX_MODEL=${process.env.CODEX_MODEL||''}`,`DIRECT_WORKSPACE=1`],
    WorkingDir:'/workspace', User:'10001:10001'
  });
  let output='';
  const stream=await agent.start({hijack:true,stdin:false});
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
  const headChanged=(await headRevision(workspace))!==headBefore;
  if(changes.length)await db.addEvent(run.id,'result','Repository files changed',changes.slice(0,20).join(', '));
  const marker=output.split('\n').find(line=>line.startsWith('RELAY_RESULT:'));
  const summary=marker ? marker.slice('RELAY_RESULT:'.length).trim() : 'The agent completed its workspace task.';
  if((changes.length||headChanged) && githubToken) {
    await db.addEvent(run.id,'publish',session.prUrl?'Updating existing pull request':'Creating pull request');
    const published=await publishPullRequest(session,run.id,run.prompt,summary,workspace,githubToken);
    if(published){await db.setPullRequest(run.id,published.url);if(published.created)await db.setSessionPullRequest(session.id,published.url,published.branch);await db.addEvent(run.id,'publish',published.created?'Pull request created':'Pull request updated',published.url);}
  }
  return summary;
}
