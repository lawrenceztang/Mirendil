import Docker from 'dockerode';
import fs from 'node:fs/promises';
import { Writable } from 'node:stream';
import { config } from './config.js';
import { db } from './db.js';
import { applyAgentOutput, changedFiles, ensureWorkspace, prepareAgentOutput, publishPullRequest } from './repository.js';
import type { Run, Session } from './types.js';
import { vault } from './vault.js';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

export async function execute(run: Run, session: Session, signal: AbortSignal): Promise<string> {
  await db.addEvent(run.id,'setup','Preparing isolated workspace',session.repoUrl || 'Blank git workspace');
  const githubToken=session.userId&&session.repoUrl?.includes('github.com')?await vault.getUser(session.userId,'github_token'):null;
  const openAiKey=session.userId?await vault.getUser(session.userId,'openai_api_key'):null;
  const workspace=await ensureWorkspace(session,githubToken);
  const agentOutput=await prepareAgentOutput(run.id);
  await db.addEvent(run.id,'setup','Creating private Codex workspace','Host repository mounted read-only');
  await db.addEvent(run.id,'setup','Starting Codex agent container',config.agentImage);
  const container=await docker.createContainer({
    Image: config.agentImage,
    name: `relay-${run.id}`,
    Env: [`RUN_ID=${run.id}`,`TASK=${run.prompt}`,`AGENT_COUNT=${session.agentCount}`,`OPENAI_API_KEY=${openAiKey||''}`,`CODEX_MODEL=${process.env.CODEX_MODEL||''}`],
    WorkingDir:'/workspace', User:'10001:10001',
    HostConfig:{ AutoRemove:true, NetworkMode:openAiKey?'bridge':'none', Memory:1024*1024*1024, NanoCpus:1_000_000_000, PidsLimit:128, CapDrop:['ALL'], SecurityOpt:['no-new-privileges'], Mounts:[{Type:'bind',Source:workspace,Target:'/repo-input',ReadOnly:true},{Type:'bind',Source:agentOutput,Target:'/repo-output',ReadOnly:false}] }
  });
  let output='';
  const stream=await container.attach({stream:true,stdout:true,stderr:true});
  const sink=new Writable({write(chunk,_encoding,callback){output=(output+chunk.toString()).slice(-2_000_000);callback();}});
  docker.modem.demuxStream(stream,sink,sink);
  const stop=async()=>{ try { await container.stop({t:2}); } catch {} };
  signal.addEventListener('abort',stop,{once:true});
  await container.start(); const result=await container.wait(); signal.removeEventListener('abort',stop);
  if(signal.aborted){await fs.rm(agentOutput,{recursive:true,force:true});throw new Error('Run cancelled');}
  if(result.StatusCode!==0){await fs.rm(agentOutput,{recursive:true,force:true});throw new Error(output.slice(-4000)||`Agent exited ${result.StatusCode}`);}
  const codexMarker=output.split('\n').find(line=>line.startsWith('RELAY_CODEX:'));
  if(codexMarker)await db.addEvent(run.id,'agent','Codex agent verified',codexMarker.slice('RELAY_CODEX:'.length).trim());
  await applyAgentOutput(workspace,agentOutput);
  await db.addEvent(run.id,'result','Validated Codex output imported');
  const changes=await changedFiles(workspace);
  if(changes.length)await db.addEvent(run.id,'result','Repository files changed',changes.slice(0,20).join(', '));
  const marker=output.split('\n').find(line=>line.startsWith('RELAY_RESULT:'));
  const summary=marker ? marker.slice('RELAY_RESULT:'.length).trim() : 'The agent completed its workspace task.';
  if(changes.length && githubToken) {
    await db.addEvent(run.id,'publish',session.prUrl?'Updating existing pull request':'Creating draft pull request');
    const published=await publishPullRequest(session,run.id,run.prompt,summary,workspace,githubToken);
    if(published){await db.setPullRequest(run.id,published.url);if(published.created)await db.setSessionPullRequest(session.id,published.url,published.branch);await db.addEvent(run.id,'publish',published.created?'Draft pull request created':'Pull request updated',published.url);}
  }
  return summary;
}
