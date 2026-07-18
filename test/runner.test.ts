import test from 'node:test';
import assert from 'node:assert/strict';
import { codexVolumeName, runContainerName } from '../src/runner.js';

test('uses a unique Docker container name for every run',()=>{
  assert.equal(runContainerName('ef7b1f0c-1234'),'relay-run-ef7b1f0c-1234');
});

test('uses one persistent Codex volume for every run in a chat',()=>{
  assert.equal(codexVolumeName('ef7b1f0c-1234'),'relay-codex-ef7b1f0c-1234');
});
