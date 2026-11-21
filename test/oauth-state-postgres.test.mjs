import test from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{fixture,databaseUrl}from'./helpers/postgres-fixture.mjs';import{Repository}from'../dist/repository.js';
test('OAuth state consumption is atomic and expired or malformed clocks cannot authorize it',{skip:!databaseUrl},async t=>{
 const f=await fixture(t,'oauth-state'),repo=new Repository(f.env),secondRepo=new Repository(f.envFor(f.second));
 await t.test('a state is returned only once',async()=>{const key=randomUUID();await repo.createOAuthState(key,'/setup');assert.equal((await repo.consumeOAuthState(key)).returnTo,'/setup');await assert.rejects(repo.consumeOAuthState(key),{code:'invalid_oauth_state'});});
 await t.test('two simultaneous consumers cannot both claim the same state',async()=>{const key=randomUUID();await repo.createOAuthState(key,null);await f.first.query('BEGIN');await repo.consumeOAuthState(key);
  let done=false;const pending=secondRepo.consumeOAuthState(key).then(v=>({value:v}),e=>({error:e})).then(v=>{done=true;return v;});
  await new Promise(r=>setTimeout(r,30));assert.equal(done,false);await f.first.query('COMMIT');assert.equal((await pending).error.code,'invalid_oauth_state');});
 await t.test('expired and invalid states are consumed without returning a redirect',async()=>{for(const date of ['2000-01-01T00:00:00Z','not-a-date']){const key=randomUUID();await repo.createOAuthState(key,'/setup');await f.first.query('UPDATE oauth_states SET expires_at=$2 WHERE state_hash=$1',[key,date]);await assert.rejects(repo.consumeOAuthState(key),{code:'expired_oauth_state'});await assert.rejects(repo.consumeOAuthState(key),{code:'invalid_oauth_state'});}});
 await t.test('rollback restores the uncommitted claim',async()=>{const key=randomUUID();await repo.createOAuthState(key,null);await f.first.query('BEGIN');await repo.consumeOAuthState(key);await f.first.query('ROLLBACK');assert.equal((await repo.consumeOAuthState(key)).returnTo,null);});
});
