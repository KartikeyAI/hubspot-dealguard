import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID}from'node:crypto';
import {fixture,databaseUrl} from './helpers/postgres-fixture.mjs';
import {Repository} from '../dist/repository.js';import {saveAssessmentContext}from'../dist/assessment-context.js';
import {authorizeRecordedDeal,authorizeFreshDeal}from'../dist/record-access.js';
import {enterpriseAccessContext}from'../dist/enterprise-access.js';
import {enrichStoredAssessmentForPortal}from'../dist/assessment-service.js';
import {HubSpotClient}from'../dist/hubspot.js';
test('record access uses current tenant-scoped dimensions and explicit mutation permission',{skip:!databaseUrl},async t=>{
 const {first,portal,other,env,at}=await fixture(t,'record-access');
 const actor={portalId:portal,userId:'7',userEmail:'user@example.test'};
 const insertRole=async(p,role)=>first.query(`INSERT INTO enterprise_role_assignments(id,portal_id,user_id,user_email,role,pipeline_ids_json,owner_ids_json,created_at,updated_at)
  VALUES($1,$2,'7','user@example.test',$3,'["p"]','["o"]',$4,$4)`,[randomUUID(),p,role,at(0)]);
 await insertRole(portal,'sales_manager');await insertRole(other,'viewer');
 const assessment={dealId:'3',dealName:'test',pipelineId:'p',ownerId:'o',pipelineLabel:'Sales',stageLabel:'Open',score:80,grade:'B',status:'ready',issues:[],readinessSummary:'test',isClosed:false,isWon:false,handoffEligible:false,assessedAt:at(0)};
 await new Repository(env).saveAssessment(portal,assessment);await saveAssessmentContext(env,portal,assessment);
 await t.test('matching current pipeline/owner allows a review and records its actor',async()=>{
  const access=await authorizeRecordedDeal(env,actor,'3');assert.equal(access.resource.ownerId,'o');
  await new Repository(env).markReviewed(actor,'3');
  const row=(await first.query('SELECT reviewed_by_user_id FROM deal_reviews WHERE portal_id=$1',[portal])).rows[0];assert.equal(row.reviewed_by_user_id,'7');
 });
 await t.test('another portal and read-only role cannot perform the record mutation',async()=>{
  await assert.rejects(new Repository(env).markReviewed({...actor,portalId:other},'3'),{code:'record_permission_denied'});
  assert.equal((await first.query('SELECT count(*) FROM deal_reviews WHERE portal_id=$1',[other])).rows[0].count,'0');
 });
 await t.test('new assessment without matching dimensions cannot reuse prior scope',async()=>{
  await new Repository(env).saveAssessment(portal,{...assessment,assessedAt:at(1)});
  await assert.rejects(authorizeRecordedDeal(env,actor,'3'),{code:'record_scope_denied'});
  await saveAssessmentContext(env,portal,{...assessment,assessedAt:at(1),ownerId:'outside'});
  await assert.rejects(authorizeRecordedDeal(env,actor,'3'),{code:'record_scope_denied'});
 });
 await t.test('a denied cached read stops before accessing a HubSpot client',async()=>{
  const original=HubSpotClient.forPortal;let called=false;
  HubSpotClient.forPortal=async()=>{called=true;throw new Error('should not run');};
  try{await assert.rejects(enrichStoredAssessmentForPortal(env,portal,'3',actor),{code:'record_scope_denied'});assert.equal(called,false);}finally{HubSpotClient.forPortal=original;}
 });
 await t.test('fresh provider dimensions are checked independently from earlier stored authorization',async()=>{
  await authorizeFreshDeal(env,actor,{id:'3',properties:{pipeline:'p',hubspot_owner_id:'o'}});
  await assert.rejects(authorizeFreshDeal(env,actor,{id:'3',properties:{pipeline:'p',hubspot_owner_id:'outside'}}),{code:'record_scope_denied'});
 });
 await t.test('email fallback cannot inherit a role explicitly attached to a different user ID',async()=>{
  const context=await enterpriseAccessContext(env,{...actor,userId:'8'});assert.equal(context.role,'viewer');
 });
 await t.test('corrupt stored scope fails closed instead of becoming unrestricted',async()=>{
  await first.query("UPDATE enterprise_role_assignments SET owner_ids_json='invalid' WHERE portal_id=$1",[portal]);
  await assert.rejects(authorizeRecordedDeal(env,actor,'3'),{code:'enterprise_scope_invalid'});
 });
});
