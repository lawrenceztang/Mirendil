import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeAgentWritable, pullRequestState, validateRepoUrl } from '../src/repository.js';
import type { Session } from '../src/types.js';

test('accepts allowlisted HTTPS repository URLs',()=>{ assert.equal(validateRepoUrl('https://github.com/example/project.git').hostname,'github.com'); });
test('rejects unsafe repository protocols',()=>{ assert.throws(()=>validateRepoUrl('ssh://github.com/example/project.git'),/Only HTTPS/); assert.throws(()=>validateRepoUrl('file:///etc/passwd'),/Only HTTPS/); });
test('rejects embedded credentials',()=>{ assert.throws(()=>validateRepoUrl('https://token@github.com/example/project.git'),/credentials/); });
test('rejects hosts outside the allowlist',()=>{ assert.throws(()=>validateRepoUrl('https://example.com/repository.git'),/Only HTTPS/); });

const session={id:'session',userId:'user',title:'Chat',repoUrl:'https://github.com/example/project.git',branch:'main',agentCount:1,status:'completed',prUrl:'https://github.com/example/project/pull/42',prBranch:'relay/chat-session',createdAt:'',updatedAt:''} satisfies Session;

test('keeps using the current pull request while it is open',async()=>{
  const request=async()=>new Response(JSON.stringify({state:'open'}),{status:200});
  assert.equal(await pullRequestState(session,'token',request as typeof fetch),'open');
});

test('replaces a pull request that is no longer open',async()=>{
  const request=async()=>new Response(JSON.stringify({state:'closed'}),{status:200});
  assert.equal(await pullRequestState(session,'token',request as typeof fetch),'closed');
});

test('detects a merged pull request separately from a closed one',async()=>{
  const request=async()=>new Response(JSON.stringify({state:'closed',merged_at:'2026-07-17T12:00:00Z'}),{status:200});
  assert.equal(await pullRequestState(session,'token',request as typeof fetch),'merged');
});

test('warm permission repair fixes source files without scanning dependencies',async()=>{
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'relay-permissions-'));const source=path.join(workspace,'source.ts'),modules=path.join(workspace,'node_modules'),dependency=path.join(modules,'package.js');
  await fs.writeFile(source,'source');await fs.mkdir(modules);await fs.writeFile(dependency,'dependency');await fs.chmod(source,0o444);await fs.chmod(dependency,0o444);
  await makeAgentWritable(workspace,false);
  assert.ok(((await fs.stat(source)).mode&0o200)!==0);
  assert.equal((await fs.stat(dependency)).mode&0o200,0);
});
