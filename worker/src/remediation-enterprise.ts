import { sha256Hex } from './crypto.js';
import { requireEnterprisePermission } from './enterprise-access.js';
import { AppError } from './errors.js';
import { transitionRemediationCase, type RemediationCase } from './remediation.js';
import { attachTaskToExistingRemediation } from './remediation-task.js';
import { requireRemediationRecord } from './remediation-access.js';
import { requireRecordActor, type RecordPermission } from './record-access.js';
import { Repository } from './repository.js';
import type { DatabasePreparedStatement, Env, RequestIdentity } from './types.js';

function clean(value: unknown,max:number):string {return typeof value==='string'?value.trim().slice(0,max):'';}
async function caseRow(env:Env,portalId:string,caseId:string):Promise<Record<string,unknown>> {
 const row=await env.DB.prepare('SELECT * FROM remediation_cases WHERE portal_id=? AND id=?').bind(portalId,caseId).first<Record<string,unknown>>();
 if(!row) throw new AppError(404,'remediation_case_not_found','The remediation case does not exist.');return row;
}
async function accessCase(env:Env,identity:RequestIdentity,caseId:string,permission:RecordPermission) {
 const row=await caseRow(env,identity.portalId,caseId);
 const access=await requireRemediationRecord(env,identity,String(row.deal_id),permission);
 return {row,access};
}
async function commitCaseWork(env:Env,identity:RequestIdentity,caseId:string,permission:RecordPermission,action:string,
 build:(row:Record<string,unknown>,stamp:string)=>Promise<{statements:DatabasePreparedStatement[];metadata:Record<string,unknown>;result?:Record<string,unknown>}>) {
 const {row,access}=await accessCase(env,identity,caseId,permission);
 const stamp=new Date().toISOString(),operation=await build(row,stamp);
 try {
  await env.DB.batch([
   env.DB.prepare('SELECT dealguard.assert_current_work_record(?,?,?,?,?)').bind(identity.portalId,row.deal_id,access.assessmentAt,caseId,String(row.work_revision)),
   ...operation.statements,
   env.DB.prepare('INSERT INTO remediation_events(id,portal_id,case_id,action,actor_user_id,actor_email,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .bind(crypto.randomUUID(),identity.portalId,caseId,action,identity.userId,identity.userEmail,JSON.stringify(operation.metadata),stamp),
   env.DB.prepare('INSERT INTO audit_events(id,portal_id,user_id,user_email,action,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)')
    .bind(crypto.randomUUID(),identity.portalId,identity.userId,identity.userEmail,`remediation.${action}`,JSON.stringify({caseId,...operation.metadata}),stamp),
  ]);
 } catch(error) {
  if(error && typeof error==='object' && 'code' in error && error.code==='40001') throw new AppError(409,'remediation_changed','The case or deal changed; refresh and retry.');
  throw error;
 }
 await requireRemediationRecord(env,identity,String(row.deal_id),permission);
 return operation.result??{};
}
export async function configureRemediationControls(env:Env,identity:RequestIdentity,caseId:string,
 input:{evidenceRequired?:boolean;acknowledgementRequired?:boolean;managerOwnerId?:string|null;managerOwnerEmail?:string|null}):Promise<void> {
 if(typeof input.evidenceRequired!=='boolean' || typeof input.acknowledgementRequired!=='boolean')
  throw new AppError(400,'remediation_controls_invalid','Specify boolean evidence and acknowledgement requirements.');
 await commitCaseWork(env,identity,caseId,'remediation.manage','controls_updated',async(row,stamp)=>({
  statements:[env.DB.prepare(`UPDATE remediation_cases SET evidence_required=?, evidence_status=CASE WHEN ?=0 THEN 'not_required'
    WHEN evidence_required=1 THEN evidence_status ELSE 'missing' END, acknowledgement_required=?,manager_owner_id=?,manager_owner_email=?,updated_at=? WHERE portal_id=? AND id=?`)
   .bind(input.evidenceRequired?1:0,input.evidenceRequired?1:0,input.acknowledgementRequired?1:0,input.managerOwnerId===undefined?row.manager_owner_id:clean(input.managerOwnerId,128)||null,
    input.managerOwnerEmail===undefined?row.manager_owner_email:clean(input.managerOwnerEmail,254)||null,stamp,identity.portalId,caseId)],metadata:{evidenceRequired:input.evidenceRequired,acknowledgementRequired:input.acknowledgementRequired}
 }));
}
export async function addRemediationComment(env:Env,identity:RequestIdentity,caseId:string,bodyValue:unknown):Promise<Record<string,unknown>> {
 const body=clean(bodyValue,8000);if(!body) throw new AppError(400,'remediation_comment_required','A comment is required.');
 return commitCaseWork(env,identity,caseId,'remediation.manage','commented',async(row,stamp)=>{
  const id=crypto.randomUUID();return {statements:[
   env.DB.prepare('INSERT INTO remediation_comments(id,portal_id,case_id,body,actor_user_id,actor_email,created_at) VALUES(?,?,?,?,?,?,?)')
    .bind(id,identity.portalId,caseId,body,identity.userId,identity.userEmail,stamp),
   env.DB.prepare('UPDATE remediation_cases SET updated_at=? WHERE portal_id=? AND id=?').bind(stamp,identity.portalId,caseId)
  ],metadata:{commentId:id},result:{id,body,actorEmail:identity.userEmail,createdAt:stamp}};
 });
}
export async function addRemediationEvidence(env:Env,identity:RequestIdentity,caseId:string,value:unknown):Promise<Record<string,unknown>> {
 const input=value && typeof value==='object'?value as Record<string,unknown>:{};
 const type=String(input.type??'text'),label=clean(input.label,255),evidenceValue=clean(input.value,16000);
 if(!['url','text','hubspot_object','external_reference'].includes(type)||!label||!evidenceValue) throw new AppError(400,'remediation_evidence_required','A supported evidence type, label and value are required.');
 if(type==='url') {let parsed:URL;try{parsed=new URL(evidenceValue);}catch{throw new AppError(400,'remediation_evidence_url_invalid','Use an HTTPS evidence URL.');}
  if(parsed.protocol!=='https:'||parsed.username||parsed.password) throw new AppError(400,'remediation_evidence_https_required','Use an HTTPS URL without embedded credentials.');}
 const hash=await sha256Hex(`${type}:${label}:${evidenceValue}`);
 return commitCaseWork(env,identity,caseId,'remediation.evidence','evidence_submitted',async(row,stamp)=>{
  const prior=await env.DB.prepare('SELECT id FROM remediation_evidence WHERE portal_id=? AND case_id=? AND content_hash=? LIMIT 1').bind(identity.portalId,caseId,hash).first();
  if(prior) throw new AppError(409,'remediation_evidence_duplicate','This evidence has already been submitted.');
  const id=crypto.randomUUID();return {statements:[
   env.DB.prepare('INSERT INTO remediation_evidence(id,portal_id,case_id,evidence_type,label,value,content_hash,submitted_by_user_id,submitted_by_email,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .bind(id,identity.portalId,caseId,type,label,evidenceValue,hash,identity.userId,identity.userEmail,stamp),
   env.DB.prepare("UPDATE remediation_cases SET evidence_status='submitted',updated_at=? WHERE portal_id=? AND id=?").bind(stamp,identity.portalId,caseId)
  ],metadata:{evidenceId:id,type,label,hash},result:{id,type,label,value:evidenceValue,hash,createdAt:stamp}};
 });
}
export async function reviewRemediationEvidence(env:Env,identity:RequestIdentity,caseId:string,decision:'accepted'|'rejected',comment:string):Promise<void> {
 if(!['accepted','rejected'].includes(decision)) throw new AppError(400,'remediation_review_invalid','Choose accepted or rejected.');
 await commitCaseWork(env,identity,caseId,'remediation.review',`evidence_${decision}`,async(row,stamp)=>{
  if(Number(row.evidence_required)!==1) throw new AppError(409,'remediation_evidence_not_required','This case does not require evidence.');
  const evidence=await env.DB.prepare('SELECT COUNT(*) AS count FROM remediation_evidence WHERE portal_id=? AND case_id=?').bind(identity.portalId,caseId).first<{count:number}>();
  if(!Number(evidence?.count)) throw new AppError(409,'remediation_evidence_missing','Submit evidence before review.');
  return {statements:[env.DB.prepare('UPDATE remediation_cases SET evidence_status=?,updated_at=? WHERE portal_id=? AND id=?').bind(decision,stamp,identity.portalId,caseId)],metadata:{comment:clean(comment,4000)}};
 });
}
export async function transitionEnterpriseRemediation(env:Env,identity:RequestIdentity,caseId:string,action:string,value:unknown):Promise<RemediationCase> {
 // Evidence/acknowledgement gates execute under the case lock, not just a preceding read.
 return transitionRemediationCase(env,identity,caseId,action,value);
}
export async function remediationDetail(env:Env,identity:RequestIdentity,caseId:string):Promise<Record<string,unknown>> {
 const {row}=await accessCase(env,identity,caseId,'remediation.view');
 const [comments,evidence,events,links]=await Promise.all([
  env.DB.prepare('SELECT id,body,actor_user_id,actor_email,created_at FROM remediation_comments WHERE portal_id=? AND case_id=? ORDER BY created_at DESC LIMIT 201').bind(identity.portalId,caseId).all<Record<string,unknown>>(),
  env.DB.prepare('SELECT id,evidence_type,label,value,content_hash,object_upload_id,object_key,content_type,size_bytes,object_etag,submitted_by_user_id,submitted_by_email,created_at FROM remediation_evidence WHERE portal_id=? AND case_id=? ORDER BY created_at DESC LIMIT 201').bind(identity.portalId,caseId).all<Record<string,unknown>>(),
  env.DB.prepare('SELECT id,action,actor_user_id,actor_email,metadata_json,created_at FROM remediation_events WHERE portal_id=? AND case_id=? ORDER BY created_at DESC LIMIT 201').bind(identity.portalId,caseId).all<Record<string,unknown>>(),
  env.DB.prepare('SELECT recommendation_id,created_at FROM recommendation_remediation_links WHERE portal_id=? AND case_id=? ORDER BY created_at DESC LIMIT 201').bind(identity.portalId,caseId).all<Record<string,unknown>>()
 ]);
 await requireRemediationRecord(env,identity,String(row.deal_id),'remediation.view');
 const bounded=(rows:Record<string,unknown>[]|undefined)=>(rows??[]).slice(0,200);
 return {case:{id:row.id,dealId:row.deal_id,issueCode:row.issue_code,title:row.title,description:row.description,severity:row.severity,status:row.status,
  priority:row.priority,ownerId:row.owner_id,ownerEmail:row.owner_email,managerOwnerId:row.manager_owner_id,managerOwnerEmail:row.manager_owner_email,
  dueAt:row.due_at,evidenceRequired:Number(row.evidence_required)===1,evidenceStatus:row.evidence_status,acknowledgementRequired:Number(row.acknowledgement_required)===1,
  escalationLevel:Number(row.escalation_level??0),hubSpotTaskId:row.hubspot_task_id,createdAt:row.created_at,updatedAt:row.updated_at},
  comments:bounded(comments.results),evidence:bounded(evidence.results),events:bounded(events.results).map(e=>({...e,metadata:JSON.parse(String(e.metadata_json??'{}'))})),
  linkedRecommendations:bounded(links.results),truncated:[comments,evidence,events,links].some(r=>(r.results??[]).length>200)};
}

type BulkOperation = 'assign' | 'acknowledge' | 'start' | 'resolve' | 'waive' | 'create_tasks' | 'set_due_date' | 'set_priority';

export async function createRemediationBulkJob(env: Env, identity: RequestIdentity, value: unknown): Promise<Record<string, unknown>> {
  await requireRecordActor(env, identity, 'remediation.bulk');
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const allowed: BulkOperation[] = ['assign', 'acknowledge', 'start', 'resolve', 'waive', 'create_tasks', 'set_due_date', 'set_priority'];
  const operation = allowed.includes(input.operation as BulkOperation) ? input.operation as BulkOperation : null;
  const caseIds = Array.isArray(input.caseIds)
    ? [...new Set(input.caseIds.filter((id): id is string => typeof id === 'string' && id.length <= 128))].slice(0, 1000)
    : [];
  if (!operation || caseIds.length === 0) throw new AppError(400, 'remediation_bulk_invalid', 'A supported operation and at least one case ID are required.');
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO remediation_bulk_jobs (id, portal_id, operation, input_json, status, total_count, requested_by_user_id, requested_by_email, created_at)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`
  ).bind(id, identity.portalId, operation, JSON.stringify({ caseIds, parameters: input.parameters ?? {} }), caseIds.length, identity.userId, identity.userEmail, now).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'remediation.bulk_requested', { jobId: id, operation, caseCount: caseIds.length });
  return { id, operation, status: 'queued', totalCount: caseIds.length, createdAt: now };
}

export async function runRemediationBulkJob(env: Env, identity: RequestIdentity, jobId: string): Promise<Record<string, unknown>> {
  await requireRecordActor(env, identity, 'remediation.bulk');
  const job = await env.DB.prepare(`SELECT * FROM remediation_bulk_jobs WHERE portal_id = ? AND id = ?`)
    .bind(identity.portalId, jobId).first<Record<string, unknown>>();
  if (!job) throw new AppError(404, 'remediation_bulk_job_not_found', 'The remediation bulk job does not exist.');
  if (!['queued', 'failed'].includes(String(job.status))) throw new AppError(409, 'remediation_bulk_job_not_runnable', 'This bulk job is already running or complete.');
  const input = JSON.parse(String(job.input_json)) as { caseIds: string[]; parameters: Record<string, unknown> };
  const operation = String(job.operation) as BulkOperation;
  if(job.requested_by_user_id ? job.requested_by_user_id!==identity.userId : !identity.userEmail || job.requested_by_email!==identity.userEmail)
    throw new AppError(403,'remediation_bulk_owner_required','Only the requesting user can run this batch.');
  const claimed=await env.DB.prepare(`UPDATE remediation_bulk_jobs SET status='running' WHERE portal_id=? AND id=? AND status IN ('queued','failed') RETURNING id`)
    .bind(identity.portalId,jobId).first();
  if(!claimed) throw new AppError(409,'remediation_bulk_already_running','The batch is already running.');
  const failures: Array<{ caseId: string; error: string }> = [];
  let succeeded = 0;
  for (const caseId of input.caseIds) {
    try {
      if (operation === 'assign') await transitionEnterpriseRemediation(env, identity, caseId, 'assign', input.parameters);
      else if (['acknowledge', 'start', 'resolve', 'waive'].includes(operation)) await transitionEnterpriseRemediation(env, identity, caseId, operation, input.parameters);
      else if (operation === 'set_due_date' || operation === 'set_priority') await transitionRemediationCase(env,identity,caseId,operation,input.parameters);
      else if (operation === 'create_tasks') await attachTaskToExistingRemediation(env,identity,caseId);
      succeeded += 1;
    } catch (error) {
      failures.push({ caseId, error: error instanceof AppError ? error.message : 'The operation failed. Retry after checking the case.' });
    }
  }
  const completedAt = new Date().toISOString();
  const status = failures.length === 0 ? 'completed' : succeeded > 0 ? 'partially_failed' : 'failed';
  await env.DB.prepare(
    `UPDATE remediation_bulk_jobs SET status = ?, succeeded_count = ?, failed_count = ?, result_json = ?, completed_at = ? WHERE portal_id = ? AND id = ?`
  ).bind(status, succeeded, failures.length, JSON.stringify({ failures }), completedAt, identity.portalId, jobId).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'remediation.bulk_completed', { jobId, status, succeeded, failed: failures.length });
  return { id: jobId, status, succeededCount: succeeded, failedCount: failures.length, failures, completedAt };
}
