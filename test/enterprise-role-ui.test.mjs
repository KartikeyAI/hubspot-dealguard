import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { hookHarness,deferredFetch } from './helpers/ui-hook-harness.mjs';

const uiCode=ts.transpileModule(readFileSync('src/app/pages/product-ui.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
const modules={'./product-ui':await import(`data:text/javascript;base64,${Buffer.from(uiCode).toString('base64')}`)};
const nodes=value=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];
const words=value=>Array.isArray(value)?value.map(words).join(' '):value&&typeof value==='object'?words(value.props?.children):typeof value==='string'||typeof value==='number'?String(value):'';
const button=(host,label)=>nodes(host.current).find(node=>node.type==='Button'&&words(node).replace(/\s+/g,' ').trim()===label);
const field=(host,name)=>nodes(host.current).find(node=>node.props?.name===name);
const scope={pipelineIds:[],ownerIds:[],teamIds:[],regionCodes:[]};
const access={role:'administrator',permissions:['*'],scope,entitled:true,bootstrap:false,explicitAssignment:true};
function setup(t,options={}) {
  const api=deferredFetch(),updates=[],requests=[];
  const props={access,entitled:true,currentUser:{id:'7',email:'admin@example.test'},onAccessChanged:async()=>{updates.push('refreshed');},onApprovalRequested:()=>{requests.push('pending');},...options};
  const host=hookHarness('src/app/pages/EnterpriseRoleManagementPanel.tsx','EnterpriseRoleManagementPanel',props,api.fetch,modules);
  t.after(()=>host.dispose());return {api,host,props,updates,requests};
}
async function load(f,rows=[]) {
  button(f.host,'Load workspace role assignments').props.onClick();
  f.api.calls[0].resolve(f.props.access);await f.host.flush();
  assert.match(f.api.calls[1].url,/\/roles$/);f.api.calls[1].resolve({roles:rows});await f.host.flush();
}
async function confirm(host) {field(host,'enterprise-role-confirm').props.onChange('SAVE ROLE');await host.flush();}

test('role setup requires current entitled portal-wide management permission',async t=>{
  for(const props of [{access:{...access,role:'viewer',permissions:['analytics.view']}},
    {access:{...access,scope:{...scope,ownerIds:['restricted']}}},{access:{...access,bootstrap:true,explicitAssignment:false}},{entitled:false},{access:{...access,scope:{}}}]) {
    const f=setup(t,props);assert.equal(f.host.current,null);assert.equal(f.api.calls.length,0);
  }
});

test('a role request remains unapplied until independent approval and refreshes the request list',async t=>{
  const f=setup(t);assert.equal(f.api.calls.length,0);await load(f);
  button(f.host,'Use my HubSpot identity').props.onClick();await f.host.flush();
  assert.equal(field(f.host,'enterprise-role-user-id').props.value,'7');
  assert.equal(f.api.calls.length,2,'prefilling identity never creates an assignment');
  assert.equal(button(f.host,'Submit role change').props.disabled,true);await confirm(f.host);
  button(f.host,'Submit role change').props.onClick();button(f.host,'Submit role change').props.onClick();
  assert.equal(f.api.calls.length,3,'duplicate in-flight clicks do not dispatch a second mutation');
  assert.equal(f.api.calls[2].options.method,'PUT');
  assert.deepEqual(f.api.calls[2].options.body,{userId:'7',userEmail:'admin@example.test',role:'viewer',permissions:[],scope});
  assert.deepEqual(f.updates,[]);f.api.calls[2].resolve({error:{code:'change_approval_created',message:'Independent approval required.',details:{approvalId:'request-1'}}},409);
  await f.host.flush();assert.deepEqual(f.updates,[]);assert.deepEqual(f.requests,['pending']);
  assert.match(words(f.host.current),/request-1 is pending independent approval/);assert.match(words(f.host.current),/No role change was applied/);
  assert.equal(field(f.host,'enterprise-role-confirm').props.value,'');
});

test('editing preserves all record restrictions and adds only explicitly selected allowlisted grants',async t=>{
  const restricted={pipelineIds:['sales'],ownerIds:['21'],teamIds:['8'],regionCodes:['EU']};
  const f=setup(t);await load(f,[{id:'assignment',userId:'33',userEmail:'reviewer@example.test',role:'reviewer',permissions:[],scope:restricted}]);
  button(f.host,'Edit assignment for 33').props.onClick();await f.host.flush();
  assert.equal(field(f.host,'enterprise-role-user-id').props.readOnly,true);
  field(f.host,'grant-forecast.approve').props.onChange(true);await f.host.flush();await confirm(f.host);
  button(f.host,'Submit role change').props.onClick();
  assert.deepEqual(f.api.calls[2].options.body,{userId:'33',userEmail:'reviewer@example.test',role:'reviewer',permissions:['forecast.approve'],scope:restricted});
  f.api.calls[2].resolve({ok:true});await f.host.flush();assert.deepEqual(f.updates,['refreshed']);
});

test('email-only assignment promotion requires a numeric stable ID and retains the original identity binding',async t=>{
  const f=setup(t);await load(f,[{id:'legacy',userId:null,userEmail:'reviewer@example.test',role:'reviewer',permissions:['forecast.approve'],scope}]);
  button(f.host,'Edit assignment for reviewer@example.test').props.onClick();await f.host.flush();
  assert.equal(field(f.host,'enterprise-role-email').props.readOnly,true);assert.equal(button(f.host,'Use my HubSpot identity').props.disabled,true);
  field(f.host,'enterprise-role-user-id').props.onChange('invalid-id');await f.host.flush();await confirm(f.host);
  assert.equal(button(f.host,'Submit role change').props.disabled,true);
  field(f.host,'enterprise-role-user-id').props.onChange('33');await f.host.flush();await confirm(f.host);
  button(f.host,'Submit role change').props.onClick();assert.equal(f.api.calls[2].options.body.userId,'33');assert.equal(f.api.calls[2].options.body.userEmail,'reviewer@example.test');
  f.api.calls[2].resolve({ok:true});await f.host.flush();
});

test('legacy extra grants are not silently removed or reintroduced by the allowlisted editor',async t=>{
  const f=setup(t);await load(f,[{id:'legacy',userId:'33',userEmail:null,role:'reviewer',permissions:['*','forecast.approve'],scope}]);
  button(f.host,'Edit assignment for 33').props.onClick();await f.host.flush();await confirm(f.host);
  assert.equal(button(f.host,'Submit role change').props.disabled,true);
  assert.match(words(f.host.current),/outside this setup editor/);
  field(f.host,'replace-legacy-role-grants').props.onChange(true);await f.host.flush();await confirm(f.host);
  button(f.host,'Submit role change').props.onClick();assert.deepEqual(f.api.calls[2].options.body.permissions,['forecast.approve']);
  f.api.calls[2].resolve({ok:true});await f.host.flush();
});

test('authority changes discard in-flight role data and stale action callbacks cannot dispatch',async t=>{
  const f=setup(t);button(f.host,'Load workspace role assignments').props.onClick();
  const staleLoad=button(f.host,'Load workspace role assignments').props.onClick;
  f.host.render({...f.props,access:{...access,permissions:['analytics.view'],role:'viewer'}});await f.host.flush();
  f.api.calls[0].resolve(access);await f.host.flush();staleLoad();await f.host.flush();
  assert.equal(f.host.current,null);assert.equal(f.api.calls.length,1);assert.deepEqual(f.updates,[]);
});

test('backend last-administrator denial is shown without automatic retry or claiming a successful refresh',async t=>{
  const f=setup(t);await load(f,[{id:'self',userId:'7',userEmail:'admin@example.test',role:'administrator',permissions:[],scope}]);
  button(f.host,'Edit assignment for 7').props.onClick();await f.host.flush();
  field(f.host,'enterprise-role-remove-confirm').props.onChange('REMOVE ROLE');await f.host.flush();
  button(f.host,'Request assignment removal').props.onClick();assert.equal(f.api.calls[2].options.method,'DELETE');assert.match(f.api.calls[2].url,/\/roles\/self$/);
  f.api.calls[2].resolve({error:{message:'The final enterprise administrator cannot be removed.'}},409);await f.host.flush();
  assert.match(words(f.host.current),/final enterprise administrator cannot be removed/);assert.equal(f.api.calls.length,3);assert.deepEqual(f.updates,[]);
});
