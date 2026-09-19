import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizedDealEvent,webhookClaimQuery } from '../dist/hubspot-events.js';
const event={eventId:0,subscriptionId:1,portalId:100,objectId:'123',objectTypeId:'0-3',subscriptionType:'object.deletion',occurredAt:Date.now()-1000};
test('webhook identity validates type, safe integers and source timestamps',()=>{
  assert.ok(normalizedDealEvent(event));assert.ok(normalizedDealEvent({...event,subscriptionType:'deal.restore',objectTypeId:undefined}));
  for(const bad of [{objectTypeId:'0-1'},{objectTypeId:undefined},{portalId:9007199254740992},{occurredAt:NaN},{occurredAt:Date.now()+600000},{subscriptionType:'object.merge'}]) assert.equal(normalizedDealEvent({...event,...bad}),null);
});
test('duplicate event keys include deal, subscription and topic but not retry number or property content',()=>{
  assert.equal(normalizedDealEvent(event).key,normalizedDealEvent({...event,attemptNumber:3,propertyValue:'private text'}).key);
  for(const delta of [{objectId:'124'},{subscriptionId:2},{subscriptionType:'object.restore'}]) assert.notEqual(normalizedDealEvent(event).key,normalizedDealEvent({...event,...delta}).key);
});
test('receipt is awaited before acknowledgment and retry polling remains durable',()=>{
  const route=fs.readFileSync('worker/src/routes-v2.ts','utf8');assert.match(route,/json\(await processHubSpotWebhookEvents/);assert.doesNotMatch(route,/waitUntil\(processHubSpotWebhookEvents/);
  const q=webhookClaimQuery('lease');assert.deepEqual(q.params,['lease']);assert.match(q.sql,/SKIP LOCKED/);assert.match(q.sql,/attempts < 8/);
  const manifest=JSON.parse(fs.readFileSync('src/app/webhooks/deal-events-hsmeta.json','utf8'));
  for(const kind of ['object.deletion','object.restore'])assert.ok(manifest.config.subscriptions.crmObjects.some(s=>s.subscriptionType===kind&&s.objectType==='deal'));
});
