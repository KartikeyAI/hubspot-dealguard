import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync}from'node:fs';
import {assertRecordScope,authorizeRecordedDeal,requireRecordActor} from '../dist/record-access.js';
import {enterpriseAccessContext} from '../dist/enterprise-access.js';
const id={portalId:'100',userId:'7',userEmail:'reader@example.test'};
const resource={pipelineId:'p',ownerId:'o',teamId:'t',regionCode:'r'};
const context={role:'sales_manager',permissions:[],scope:{pipelineIds:['p','q'],ownerIds:['o','p'],teamIds:['t'],regionCodes:['r']}};
test('record authorization intersects every assigned dimension and denies missing values',()=>{
 assertRecordScope(context,resource);
 for(const k of Object.keys(resource)) for(const value of ['other',null])assert.throws(()=>assertRecordScope(context,{...resource,[k]:value}),{status:403});
});
const role=(extra={})=>({role:'sales_manager',permissions_json:'[]',pipeline_ids_json:'["p"]',owner_ids_json:'["o"]',team_ids_json:'["t"]',region_codes_json:'["r"]',...extra});
const env=(assignment=role(),row={assessed_at:'2026-01-01T00:00:00.000Z',pipeline_id:'p',owner_id:'o',team_id:'t',region_code:'r'},status='active')=>({DB:{prepare(sql){return{bind(...params){return{async first(){if(sql.startsWith('SELECT status FROM tenants'))return{status};if(sql.includes('FROM enterprise_role_assignments'))return assignment;if(sql.includes('FROM deal_assessments')){assert.deepEqual(params,['100','3']);return row;}throw new Error('Unexpected SQL');}};}};}}});
test('record permission and active installation are required before exposing data',async()=>{
 await requireRecordActor(env(),id,'handoff.confirm');
 await assert.rejects(requireRecordActor(env(role({role:'viewer'})),id,'handoff.confirm'),{code:'record_permission_denied'});
 await assert.rejects(requireRecordActor(env(role(),null,'deleted'),id,'analytics.view'),{code:'installation_inactive'});
 await assert.rejects(requireRecordActor(env(),{portalId:'100'},'analytics.view'),{code:'record_user_required'});
});
test('unknown current scope cannot be replaced by an older or permissive cached record',async()=>{
 await authorizeRecordedDeal(env(),id,'3');
 await assert.rejects(authorizeRecordedDeal(env(role(),null),id,'3'),{code:'record_scope_denied'});
 await assert.rejects(authorizeRecordedDeal(env(role(),{pipeline_id:'p',owner_id:'o',team_id:'t',region_code:'elsewhere'}),id,'3'),{code:'record_scope_denied'});
});
test('malformed persisted scope cannot turn into unrestricted access',async()=>{
 for(const scope of ['bad','{}','null','[null]','[""]','[" p"]']) await assert.rejects(enterpriseAccessContext(env(role({owner_ids_json:scope})),id),{code:'enterprise_scope_invalid'});
});
test('URL-bound identity and fresh/cached record scope are wired into canonical paths',()=>{
 const source=p=>readFileSync(new URL(`../worker/src/${p}`,import.meta.url),'utf8');
 assert.match(source('routes-v9.ts'),/authorizeFreshDeal\(env, identity, deal, 'handoff.confirm'\)/);
 assert.match(source('routes-v2.ts'),/action === 'review' \? 'deal.review'/);
 assert.match(source('assessment-service.ts'),/assertRecordScope\(current.context,result.resource\)/);
 assert.match(source('commercial-assessment.ts'),/sha256Hex\(JSON.stringify\(baseAssessment\)\)/);
 assert.match(source('enterprise-access.ts'),/user_id IS NULL OR user_id = \?/);
});
