import test from 'node:test';
import assert from 'node:assert/strict';
import { cookieValue } from '../src/auth.js';
import { oauthStateMatches } from '../src/github-oauth.js';

test('extracts only the requested authentication cookie',()=>{
  assert.equal(cookieValue('theme=dark; relay_session=abc%20123; other=value','relay_session'),'abc 123');
  assert.equal(cookieValue('theme=dark','relay_session'),null);
});

test('OAuth state must match the browser-bound cookie',()=>{
  assert.equal(oauthStateMatches('signed-state','signed-state'),true);
  assert.equal(oauthStateMatches('signed-state','attacker-state'),false);
  assert.equal(oauthStateMatches('signed-state',null),false);
});
