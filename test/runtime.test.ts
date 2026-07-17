import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

test('demo runtime leaves the repository unchanged without a model key',async()=>{
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'relay-runtime-'));const input=path.join(base,'input'),workspace=path.join(base,'workspace'),agentOutput=path.join(base,'output');await fs.mkdir(input);await fs.mkdir(workspace);await fs.mkdir(agentOutput);await fs.mkdir(path.join(input,'.git'));await fs.writeFile(path.join(input,'.git','config'),'secret metadata');await fs.writeFile(path.join(input,'hello.txt'),'hello');await fs.chmod(path.join(input,'hello.txt'),0o444);
  const logs=await new Promise<string>((resolve,reject)=>{ const child=spawn(process.execPath,[path.resolve('agent-runtime/run.js')],{env:{...process.env,TASK:'Inspect this',OPENAI_API_KEY:'',DIRECT_WORKSPACE:'0',WORKSPACE_ROOT:workspace,REPO_INPUT:input,REPO_OUTPUT:agentOutput},cwd:workspace});let text='';child.stdout.on('data',d=>text+=d);child.on('error',reject);child.on('close',code=>code===0?resolve(text):reject(new Error(`exit ${code}`))); });
  assert.match(logs,/RELAY_RESULT: Demo inspected the repository without changing it/);
  assert.match(logs,/RELAY_WORKSPACE: .* writable/);
  assert.deepEqual(await fs.readdir(agentOutput),['hello.txt']);
  assert.ok(((await fs.stat(path.join(workspace,'hello.txt'))).mode&0o200)!==0);
  await assert.rejects(fs.access(path.join(workspace,'.git')));
});
