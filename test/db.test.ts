import test from 'node:test';
import assert from 'node:assert/strict';
import { leaseRunSql } from '../src/db.js';

test('queue claim locks both the run and its session',()=>{
  assert.match(leaseRunSql,/JOIN sessions chat/);
  assert.match(leaseRunSql,/FOR UPDATE OF (?:chat,candidate|candidate,chat) SKIP LOCKED/);
});
