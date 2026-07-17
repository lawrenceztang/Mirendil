import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

test('demo runtime produces an artifact without a model key',async()=>{
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'relay-runtime-')); await fs.writeFile(path.join(workspace,'hello.txt'),'hello');
  const output=await new Promise<string>((resolve,reject)=>{ const child=spawn(process.execPath,[path.resolve('agent-runtime/run.js')],{env:{...process.env,TASK:'Inspect this',OPENAI_API_KEY:'',WORKSPACE_ROOT:workspace},cwd:workspace});let text='';child.stdout.on('data',d=>text+=d);child.on('error',reject);child.on('close',code=>code===0?resolve(text):reject(new Error(`exit ${code}`))); });
  assert.match(output,/RELAY_RESULT/); assert.match(await fs.readFile(path.join(workspace,'RELAY_DEMO_RESULT.md'),'utf8'),/Inspect this/);
});
