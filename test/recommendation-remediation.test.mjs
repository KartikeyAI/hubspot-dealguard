import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { remediationLinkInput, requireWorkResult } from '../dist/recommendation-remediation.js';
import { mapRecommendation } from '../dist/recommendation-outcome-storage.js';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const input={confirm:true,ownerId:'12',dueAt:'2026-09-10T15:30:00+05:30',expectedRevision:'0'};
test('case confirmation binds explicit owner, revision, and a normalized deadline',()=>{
 assert.deepEqual(remediationLinkInput(input),{ownerId:'12',dueAt:'2026-09-10T10:00:00.000Z',expectedRevision:'0'});
 for(const patch of [{confirm:false},{confirm:'true'},{ownerId:' 12'},{ownerId:12},{ownerId:'abc'},{dueAt:'2026-09-10T12:00:00'},
  {dueAt:'2026-02-30T00:00:00Z'},{expectedRevision:'-1'},{expectedRevision:'1.5'},{expectedRevision:'00'}]) assert.throws(()=>remediationLinkInput({...input,...patch}));
});
test('work result rejects unverifiable success and maps conflicts without leaking database details',()=>{
 for(const value of [null,{result:[]},{result:null},{result:'ok'}])assert.throws(()=>requireWorkResult(value));
 assert.throws(()=>requireWorkResult({result:{error:'record_changed'}}),e=>e.status===409);
 assert.throws(()=>requireWorkResult({result:{error:'not_found'}}),e=>e.status===404);
 assert.equal(requireWorkResult({result:{changed:false}}).changed,false);
});
test('linked case metadata remains separate from the recommendation lifecycle',()=>{
 const mapped=mapRecommendation({id:'r',deal_id:'d',status:'completed',priority:'high',owner_role:'deal_owner',recommendation_code:'x',
  work_revision:'42',linked_case_id:'c',linked_case_status:'open',linked_case_owner_id:'12',linked_case_due_at:'2026-09-10T00:00:00Z'});
 assert.equal(mapped.status,'completed');assert.equal(mapped.remediation.status,'open');assert.equal(mapped.revision,'42');
});
test('atomic work SQL keeps local creation, events and audit separate from external effects',()=>{
 const sql=read('database/migrations/0030_recommendation_remediation.sql');
 assert.match(sql,/FOREIGN KEY \(portal_id,case_id,deal_id\)/);assert.match(sql,/FOREIGN KEY \(portal_id,recommendation_id,deal_id\)/);
 assert.match(sql,/advance_work_revision/);assert.match(sql,/FOR UPDATE/);assert.match(sql,/INSERT INTO dealguard.audit_events/);
 assert.match(sql,/created_case:=FOUND/);assert.match(sql,/request_fingerprint<>p_fingerprint/);
 assert.doesNotMatch(read('worker/src/recommendation-remediation.ts'),/HubSpotClient|enqueueDelivery|createRemediationTask/);
});
test('case mutations and public collections use the current deal scope rather than the case assignee',()=>{
 assert.match(read('worker/src/remediation-access.ts'),/c.updated_at=a.assessed_at/);
 assert.match(read('worker/src/remediation-enterprise.ts'),/assert_current_work_record/);
 assert.match(read('worker/src/remediation-enterprise.ts'),/env.DB.batch/);
 assert.doesNotMatch(read('worker/src/remediation-enterprise.ts'),/requireEnterprisePermission\(env, identity, 'remediation\.(manage|view)', \{ ownerId/);
 const route=read('worker/src/routes-v2.ts');assert.match(route,/listRemediationCases\(env, identity, url\)/);
 assert.match(route,/remediationSummary\(env, identity\)/);
});
test('UI uses explicit confirmation and ignores responses for superseded deal requests',()=>{
 const ui=read('src/app/cards/deal-recommendation-lifecycle.tsx');assert.match(ui,/expectedRevision:item.revision/);
 assert.match(ui,/Confirm case creation or linking/);assert.match(ui,/token!==requestId.current/);assert.match(ui,/loadedDeal!==dealId/);
 assert.match(ui,/case resolution are separate/);
});
