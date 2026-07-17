import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { grantWorkspaceAccess, validateRepoUrl } from '../src/repository.js';

test('accepts allowlisted HTTPS repository URLs',()=>{ assert.equal(validateRepoUrl('https://github.com/example/project.git').hostname,'github.com'); });
test('rejects unsafe repository protocols',()=>{ assert.throws(()=>validateRepoUrl('ssh://github.com/example/project.git'),/Only HTTPS/); assert.throws(()=>validateRepoUrl('file:///etc/passwd'),/Only HTTPS/); });
test('rejects embedded credentials',()=>{ assert.throws(()=>validateRepoUrl('https://token@github.com/example/project.git'),/credentials/); });
test('rejects hosts outside the allowlist',()=>{ assert.throws(()=>validateRepoUrl('https://example.com/repository.git'),/Only HTTPS/); });

test('grants the agent access to the complete Git workspace without following symlinks',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-access-'));
  const outside=await fs.mkdtemp(path.join(os.tmpdir(),'relay-outside-'));
  await fs.mkdir(path.join(root,'.git')); await fs.writeFile(path.join(root,'.git','HEAD'),'ref: refs/heads/main\n');
  await fs.symlink(outside,path.join(root,'outside'));
  const uid=process.getuid?.()??10001,gid=process.getgid?.()??10001;
  await grantWorkspaceAccess(root,uid,gid);
  assert.equal((await fs.lstat(path.join(root,'.git','HEAD'))).uid,uid);
  assert.equal((await fs.lstat(path.join(root,'outside'))).uid,uid);
  assert.equal((await fs.lstat(outside)).uid,process.getuid?.()??uid);
});
