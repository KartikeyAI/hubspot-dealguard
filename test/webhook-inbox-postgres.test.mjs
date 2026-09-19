import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,databaseUrl } from './helpers/postgres-fixture.mjs';
import { processHubSpotWebhookEvents,webhookClaimQuery,runHubSpotWebhookInbox } from '../dist/hubspot-events.js';
import { HubSpotClient } from '../dist/hubspot.js';
import { AppError } from '../dist/errors.js';

test('durable webhook intake and claim recovery on migrated PostgreSQL',{skip:!databaseUrl},async t=>{
  const {first,second,env,envFor,sent,portalIds}=await fixture(t,'inbox');
  // Inbound HubSpot identities are numeric, unlike most isolated fixture identifiers.
  const portal=String(Date.now())+String(Math.floor(Math.random()*1000000));
  const at=new Date().toISOString();await first.query(`INSERT INTO tenants(portal_id,app_id,access_token_cipher,access_token_iv,refresh_token_cipher,refresh_token_iv,token_expires_at,settings_json,installed_at,updated_at,next_scan_at) VALUES($1,'x','x','x','x','x',$2,'{}',$2,$2,$2)`,[portal,at]);
  portalIds.push(portal);
  const event=n=>({eventId:n,portalId:portal,objectId:String(n),objectTypeId:'0-3',subscriptionType:'object.deletion',occurredAt:Date.now()-1000});
  const a=event(1),b=event(2);
  await t.test('receipt is durable and retries cannot create duplicate work',async()=>{
    assert.equal((await processHubSpotWebhookEvents(env,[a,b,a])).accepted,2);
    assert.equal((await processHubSpotWebhookEvents(env,[a,b])).accepted,0);assert.ok(sent.length>0);
    assert.equal((await first.query('SELECT count(*) FROM hubspot_webhook_inbox WHERE portal_id=$1',[portal])).rows[0].count,'2');
  });
  await t.test('unknown accounts and non-deal events do not create work',async()=>{
    assert.equal((await processHubSpotWebhookEvents(env,[{...a,portalId:'9999999999999999999999999'}])).accepted,0);
    assert.equal((await processHubSpotWebhookEvents(env,[{...a,objectTypeId:'0-1'}])).ignored,1);
  });
  await t.test('two sessions claim different records; an unexpired lease is not reclaimed',async()=>{
    const q1=webhookClaimQuery('a'),q2=webhookClaimQuery('b');
    const [x,y]=await Promise.all([env.DB.prepare(q1.sql).bind(...q1.params).first(),envFor(second).DB.prepare(q2.sql).bind(...q2.params).first()]);
    assert.ok(x&&y);assert.notEqual(x.event_key,y.event_key);
    assert.equal(await env.DB.prepare(q1.sql).bind(...q1.params).first(),null);
  });
  await t.test('crashed leases can be retried and archive verification avoids ordinary assessment side effects',async()=>{
    await first.query("UPDATE hubspot_webhook_inbox SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE portal_id=$1",[portal]);
    const old=HubSpotClient.forPortal;t.after(()=>{HubSpotClient.forPortal=old;});let calls=0;
    HubSpotClient.forPortal=async()=>({async reconcileDealLifecycle(){calls++;return 'archived';}});
    await runHubSpotWebhookInbox(env);assert.equal(calls,2);
    assert.equal((await first.query("SELECT count(*) FROM hubspot_webhook_inbox WHERE portal_id=$1 AND status='processed'",[portal])).rows[0].count,'2');
    await processHubSpotWebhookEvents(env,[a]);await runHubSpotWebhookInbox(env);assert.equal(calls,2);
  });
  await t.test('processing failure retains retry work with bounded error codes, not raw provider secrets',async()=>{
    await processHubSpotWebhookEvents(env,[event(3)]);
    HubSpotClient.forPortal=async()=>{throw new AppError(503,'provider_unavailable','secret-value-do-not-persist');};
    await runHubSpotWebhookInbox(env);
    const row=(await first.query("SELECT * FROM hubspot_webhook_inbox WHERE portal_id=$1 AND deal_id='3'",[portal])).rows[0];
    assert.equal(row.status,'retry');assert.equal(row.error_code,'provider_unavailable');assert.doesNotMatch(JSON.stringify(row),/secret-value/);
  });
  await t.test('exhausted crashed work becomes a visible dead letter',async()=>{
    await first.query("UPDATE hubspot_webhook_inbox SET status='processing',attempts=8,lease_expires_at=NOW()-INTERVAL '1 second' WHERE portal_id=$1 AND deal_id='3'",[portal]);
    await runHubSpotWebhookInbox(env);
    assert.equal((await first.query("SELECT status FROM hubspot_webhook_inbox WHERE portal_id=$1 AND deal_id='3'",[portal])).rows[0].status,'dead_letter');
  });
});
