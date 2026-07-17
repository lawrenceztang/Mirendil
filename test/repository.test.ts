import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRepoUrl } from '../src/repository.js';

test('accepts allowlisted HTTPS repository URLs',()=>{ assert.equal(validateRepoUrl('https://github.com/example/project.git').hostname,'github.com'); });
test('rejects unsafe repository protocols',()=>{ assert.throws(()=>validateRepoUrl('ssh://github.com/example/project.git'),/Only HTTPS/); assert.throws(()=>validateRepoUrl('file:///etc/passwd'),/Only HTTPS/); });
test('rejects embedded credentials',()=>{ assert.throws(()=>validateRepoUrl('https://token@github.com/example/project.git'),/credentials/); });
test('rejects hosts outside the allowlist',()=>{ assert.throws(()=>validateRepoUrl('https://example.com/repository.git'),/Only HTTPS/); });
