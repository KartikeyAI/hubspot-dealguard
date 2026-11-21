import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {hookHarness,deferredFetch} from './helpers/ui-hook-harness.mjs';

const ui=ts.transpileModule(readFileSync('src/app/pages/product-ui.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
const modules={'./product-ui':await import(`data:text/javascript;base64,${Buffer.from(ui).toString('base64')}`)};
const nodes=value=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];
const words=value=>Array.isArray(value)?value.map(words).join(' '):value&&typeof value==='object'?words(typeof value.type==='function'?value.type(value.props):value.props?.children):typeof value==='string'||typeof value==='number'?String(value):'';
const button=(host,label)=>nodes(host.current).find(node=>node.type==='Button'&&words(node).replace(/\s+/g,' ').trim()===label);
const field=(host,name)=>nodes(host.current).find(node=>node.props?.name===name);
const scope={pipelineIds:[],ownerIds:[],teamIds:[],regionCodes:[]};
const access={role:'administrator',permissions:['*'],scope,entitled:true,explicitAssignment:true};
const request={id:'request-1',changeType:'role.assign',resourceType:'enterprise_role',resourceId:'9',payload:{userId:'9',userEmail:'reviewer@example.test',role:'reviewer',permissions:['forecast.approve'],scope},status:'pending',requestedByUserId:'7',requestedByEmail:'requester@example.test',decidedByUserId:null,decidedByEmail:null,decisionComment:null,requestedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString()};
function setup(t,options={}) {
  const api=deferredFetch(),updates=[];
  const props={access,entitled:true,currentUser:{id:'8',email:'reviewer@example.test'},reloadToken:0,onAccessChanged:async()=>{updates.push('refreshed');},...options};
  const host=hookHarness('src/app/pages/RoleChangeApprovalsPanel.tsx','RoleChangeApprovalsPanel',props,api.fetch,modules);
  t.after(()=>host.dispose());return{api,host,props,updates};
}
async function load(f,rows=[request]) {
  button(f.host,'Load role change requests').props.onClick();f.api.calls[0].resolve(access);await f.host.flush();
  assert.match(f.api.calls[1].url,/\/change-approvals$/);f.api.calls[1].resolve({approvals:rows});await f.host.flush();
  if(rows.length){button(f.host,`Inspect request ${rows[0].id}`).props.onClick();await f.host.flush();}
}
test('role approvals require entitled portal-wide view permission and reject stale access responses',async t=>{
  for(const props of [{entitled:false},{access:{...access,permissions:['role.manage']}},{access:{...access,scope:{...scope,pipelineIds:['one']}}}]) {
    const f=setup(t,props);assert.equal(f.host.current,null);assert.equal(f.api.calls.length,0);
  }
  const f=setup(t);button(f.host,'Load role change requests').props.onClick();
  const stale=button(f.host,'Load role change requests').props.onClick;
  f.host.render({...f.props,entitled:false});await f.host.flush();f.api.calls[0].resolve(access);await f.host.flush();stale();
  assert.equal(f.api.calls.length,1);assert.equal(f.host.current,null);
});
test('requesters cannot approve their own role change and expired or unidentified requests cannot be reviewed',async t=>{
  for(const row of [request,{...request,requestedByUserId:'8',requestedByEmail:'renamed@example.test'},
    {...request,requestedByUserId:null},{...request,expiresAt:new Date(Date.now()-1000).toISOString()}]) {
    const f=setup(t,{currentUser:{id:row===request?'7':'8',email:'reviewer@example.test'}});await load(f,[row]);
    assert.equal(button(f.host,'Approve role request'),undefined);assert.equal(f.api.calls.length,2);
  }
});
test('independent review records a decision and reloads evidence without applying the role',async t=>{
  const f=setup(t);await load(f);
  field(f.host,'role-approval-comment').props.onChange('Checked the named person and scope.');await f.host.flush();
  field(f.host,'role-approval-confirm').props.onChange('APPROVE ROLE CHANGE');await f.host.flush();
  const submit=button(f.host,'Approve role request');assert.equal(submit.props.disabled,false);submit.props.onClick();submit.props.onClick();
  assert.equal(f.api.calls.length,3);assert.match(f.api.calls[2].url,/\/change-approvals\/request-1\/approve$/);
  assert.deepEqual(f.api.calls[2].options.body,{comment:'Checked the named person and scope.'});
  f.api.calls[2].resolve({status:'approved'});await f.host.flush();f.api.calls[3].resolve(access);await f.host.flush();
  f.api.calls[4].resolve({approvals:[{...request,status:'approved',decidedByUserId:'8',decidedByEmail:'reviewer@example.test'}]});await f.host.flush();
  assert.deepEqual(f.updates,[]);assert.match(words(f.host.current),/must explicitly apply this exact request/);
  assert.equal(f.api.calls.filter(call=>call.options.method==='PUT').length,0);
});
test('applying approval replays exact stored body and URL approval ID, then reloads Home access',async t=>{
  const f=setup(t);await load(f,[{...request,status:'approved'}]);
  field(f.host,'role-apply-confirm').props.onChange('APPLY APPROVED ROLE CHANGE');await f.host.flush();
  button(f.host,'Apply approved role change').props.onClick();assert.match(f.api.calls[2].url,/\/roles\?approvalId=request-1$/);
  assert.equal(f.api.calls[2].options.method,'PUT');assert.deepEqual(f.api.calls[2].options.body,request.payload);
  assert.equal('approvalId' in f.api.calls[2].options.body,false);
  f.api.calls[2].resolve({ok:true});await f.host.flush();assert.deepEqual(f.updates,['refreshed']);
});
test('approval UI refuses unknown roles, legacy wildcard grants and arbitrary stored destinations',async t=>{
  for(const row of [{...request,payload:{...request.payload,role:'superuser'}},{...request,payload:{...request.payload,permissions:['*']}},
    {...request,payload:{...request.payload,endpoint:'/data'}}]) {
    const f=setup(t);await load(f,[{...row,status:'approved'}]);assert.equal(button(f.host,'Apply approved role change'),undefined);
    assert.match(words(f.host.current),/does not match the current role schema/);assert.equal(f.api.calls.length,2);
  }
});
test('approved removal uses only the named assignment and no fabricated request body',async t=>{
  const targetState={id:'assignment-123',user_id:'9',user_email:'target@example.test',role:'reviewer',permissions_json:'["forecast.approve"]',pipeline_ids_json:'["restricted"]',team_ids_json:'[]',owner_ids_json:'[]',region_codes_json:'[]',updated_at:new Date().toISOString()};
  const f=setup(t);await load(f,[{...request,changeType:'role.remove',resourceId:'assignment-123',payload:{},targetState,status:'approved'}]);
  assert.match(words(f.host.current),/target@example.test/);assert.match(words(f.host.current),/pipelineIds\s*:\s*restricted/);
  field(f.host,'role-apply-confirm').props.onChange('APPLY APPROVED ROLE CHANGE');await f.host.flush();button(f.host,'Apply approved role change').props.onClick();
  assert.match(f.api.calls[2].url,/\/roles\/assignment-123\?approvalId=request-1$/);assert.equal(f.api.calls[2].options.method,'DELETE');assert.equal(f.api.calls[2].options.body,undefined);
  f.api.calls[2].resolve({error:{message:'Final administrator protection prevented the removal.'}},409);await f.host.flush();
  assert.deepEqual(f.updates,[]);assert.match(words(f.host.current),/Final administrator protection/);
});
test('removal cannot be approved or applied without the matching recorded assignment',async t=>{
  for(const targetState of [undefined,null,{id:'different-assignment'}]) {
    const f=setup(t);await load(f,[{...request,changeType:'role.remove',resourceId:'assignment-123',payload:{},targetState,status:'approved'}]);
    assert.equal(button(f.host,'Apply approved role change'),undefined);assert.match(words(f.host.current),/recorded removal target/);
  }
});
