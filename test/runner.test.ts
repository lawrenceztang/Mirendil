import test from 'node:test';
import assert from 'node:assert/strict';
import { chatContainerName, codexVolumeName } from '../src/runner.js';

test('uses one stable Docker container name for every run in a chat',()=>{
  assert.equal(chatContainerName('ef7b1f0c-1234'),'relay-chat-ef7b1f0c-1234');
});

test('uses one persistent Codex volume for every run in a chat',()=>{
  assert.equal(codexVolumeName('ef7b1f0c-1234'),'relay-codex-ef7b1f0c-1234');
});
