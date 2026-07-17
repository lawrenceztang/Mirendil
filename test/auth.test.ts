import test from 'node:test';
import assert from 'node:assert/strict';
import { cookieValue } from '../src/auth.js';

test('extracts only the requested authentication cookie',()=>{
  assert.equal(cookieValue('theme=dark; relay_session=abc%20123; other=value','relay_session'),'abc 123');
  assert.equal(cookieValue('theme=dark','relay_session'),null);
});
