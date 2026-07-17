import crypto from 'node:crypto';
import { config } from './config.js';
import { db, pool } from './db.js';
import { execute } from './runner.js';

const workerId=`worker-${crypto.randomUUID().slice(0,8)}`;
console.log(`${workerId} ready`);
let stopping=false;
process.on('SIGTERM',()=>{stopping=true;}); process.on('SIGINT',()=>{stopping=true;});

while(!stopping) {
  let run;
  try { run=await db.leaseRun(workerId); }
  catch(error) { console.error('Queue poll failed; retrying',error instanceof Error?error.message:error); await new Promise(r=>setTimeout(r,3000)); continue; }
  // Keep perceived queue latency low while retaining the database-backed
  // queue's simple multi-worker coordination.
  if(!run) { await new Promise(r=>setTimeout(r,100)); continue; }
  const session=await db.session(run.sessionId); if(!session){await db.finish(run.id,'failed',undefined,'Session missing');continue;}
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),config.runTimeoutMs);
  const heartbeat=setInterval(()=>{void (async()=>{const current=await db.run(run.id);if(current?.cancelRequested)controller.abort();else if(!await db.heartbeat(run.id,workerId))controller.abort();})().catch(error=>{console.error('Heartbeat failed',error instanceof Error?error.message:error);});},10_000);
  try { await db.addEvent(run.id,'status','Run started'); const summary=await execute(run,session,controller.signal); await db.finish(run.id,'completed',summary); await db.addEvent(run.id,'status','Run completed',summary); }
  catch(error) { const cancelled=(await db.run(run.id))?.cancelRequested || controller.signal.aborted; const message=error instanceof Error?error.message:String(error); await db.finish(run.id,cancelled?'cancelled':'failed',undefined,message); await db.addEvent(run.id,'error',cancelled?'Run cancelled':'Run failed',message); }
  finally { clearTimeout(timeout); clearInterval(heartbeat); }
}
await pool.end();
