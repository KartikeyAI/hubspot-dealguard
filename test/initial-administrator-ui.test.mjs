import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {hookHarness,deferredFetch} from './helpers/ui-hook-harness.mjs';
const ui=ts.transpileModule(readFileSync('src/app/pages/product-ui.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
const modules={'./product-ui':await import(`data:text/javascript;base64,${Buffer.from(ui).toString('base64')}`)};
const nodes=value=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];
const words=value=>Array.isArray(value)?value.map(words).join(' '):value&&typeof value==='object'?words(value.props?.children):typeof value==='string'||typeof value==='number'?String(value):'';
const button=(host,label)=>nodes(host.current).find(node=>node.type==='Button'&&words(node).replace(/\s+/g,' ').trim()===label);
const field=(host,name)=>nodes(host.current).find(node=>node.props?.name===name);
const scope={pipelineIds:[],ownerIds:[],teamIds:[],regionCodes:[]};
const access={role:'viewer',permissions:['analytics.view'],scope,entitled:true,explicitAssignment:false};
const proposal={id:'proposal-1',payloadHash:'a'.repeat(64),status:'pending',expiresAt:new Date(Date.now()+3600000).toISOString(),requester:{userId:'7',userEmail:'requester@example.test'},nominee:{userId:'8',userEmail:'nominee@example.test'},role:'administrator',permissions:[],scope,canAccept:true,canReject:true};
function setup(t,options={}) {
  const api=deferredFetch(),updates=[];
  const props={access,entitled:true,currentUser:{id:'8',email:'nominee@example.test'},onAccessChanged:async()=>{updates.push('refreshed');},...options};
  const host=hookHarness('src/app/pages/InitialAdministratorSetupPanel.tsx','InitialAdministratorSetupPanel',props,api.fetch,modules);
  t.after(()=>host.dispose());return{api,host,props,updates};
}
async function load(f,result) {button(f.host,'Check initial administrator setup').props.onClick();assert.match(f.api.calls[0].url,/\/roles\/bootstrap$/);f.api.calls[0].resolve(result);await f.host.flush();}
test('an entitled nominee can inspect setup without existing role management authority; unavailable identities receive no mutation UI',async t=>{
  const f=setup(t);assert.equal(f.api.calls.length,0);await load(f,{initialized:false,viewer:'nominee',canPropose:false,proposal});
  assert.ok(button(f.host,'Accept initial administrator pair'));assert.equal(button(f.host,'Propose initial administrators'),undefined);
  const unavailable=setup(t);await load(unavailable,{initialized:false,viewer:'unavailable',canPropose:false,proposal:null});
  assert.equal(button(unavailable.host,'Accept initial administrator pair'),undefined);assert.match(words(unavailable.host.current),/No initial setup action/);
  const expired=setup(t,{entitled:false});assert.equal(expired.host.current,null);assert.equal(expired.api.calls.length,0);
});
test('requester nominates exact independent identity; proposal grants nothing and reloads the fixed pair',async t=>{
  const f=setup(t,{currentUser:{id:'7',email:'requester@example.test'}});await load(f,{initialized:false,viewer:'requester',canPropose:true,proposal:null});
  field(f.host,'initial-admin-nominee-id').props.onChange('7');field(f.host,'initial-admin-nominee-email').props.onChange('nominee@example.test');await f.host.flush();
  field(f.host,'initial-admin-propose-confirm').props.onChange('PROPOSE_INITIAL_ADMINISTRATORS');await f.host.flush();assert.equal(button(f.host,'Propose initial administrators').props.disabled,true);
  field(f.host,'initial-admin-nominee-id').props.onChange('8');await f.host.flush();assert.equal(field(f.host,'initial-admin-propose-confirm').props.value,'');
  field(f.host,'initial-admin-propose-confirm').props.onChange('PROPOSE_INITIAL_ADMINISTRATORS');await f.host.flush();
  const submit=button(f.host,'Propose initial administrators');assert.equal(submit.props.disabled,false);submit.props.onClick();submit.props.onClick();assert.equal(f.api.calls.length,2);
  assert.deepEqual(f.api.calls[1].options.body,{action:'propose',nomineeUserId:'8',nomineeEmail:'nominee@example.test',confirmation:'PROPOSE_INITIAL_ADMINISTRATORS'});
  f.api.calls[1].resolve({outcome:'proposed',proposal:{...proposal,canAccept:false}});await f.host.flush();assert.equal(f.api.calls[2].options.method,'GET');
  f.api.calls[2].resolve({initialized:false,viewer:'requester',canPropose:false,proposal:{...proposal,canAccept:false}});await f.host.flush();
  assert.deepEqual(f.updates,[]);assert.match(words(f.host.current),/No administrator role has been granted/);assert.equal(button(f.host,'Accept initial administrator pair'),undefined);
});
test('nominee accepts only after explicit confirmation and sends exact proposal fingerprint before access refresh',async t=>{
  const f=setup(t);await load(f,{initialized:false,viewer:'nominee',canPropose:false,proposal});
  assert.equal(button(f.host,'Accept initial administrator pair').props.disabled,true);
  field(f.host,'initial-admin-accept-confirm').props.onChange('ACCEPT_INITIAL_ADMINISTRATORS');await f.host.flush();
  button(f.host,'Accept initial administrator pair').props.onClick();assert.equal(f.api.calls[1].options.method,'POST');
  assert.deepEqual(f.api.calls[1].options.body,{action:'accept',proposalId:'proposal-1',payloadHash:'a'.repeat(64),confirmation:'ACCEPT_INITIAL_ADMINISTRATORS'});
  assert.deepEqual(f.updates,[]);f.api.calls[1].resolve({outcome:'applied',approvalId:'approval-1'});await f.host.flush();assert.deepEqual(f.updates,['refreshed']);
});
test('expired, differently bound or altered administrator pair cannot be accepted even with an optimistic capability',async t=>{
  for(const value of [{...proposal,expiresAt:new Date(Date.now()-1000).toISOString()},
    {...proposal,nominee:{...proposal.nominee,userId:'88'}},{...proposal,role:'reviewer'},
    {...proposal,permissions:['*']},{...proposal,scope:{...scope,ownerIds:['private']}}]) {
    const f=setup(t);await load(f,{initialized:false,viewer:'nominee',canPropose:false,proposal:value});
    assert.equal(button(f.host,'Accept initial administrator pair'),undefined);assert.equal(f.api.calls.length,1);
  }
});
test('nominee rejection clears proposal through the server without access change',async t=>{
  const f=setup(t);await load(f,{initialized:false,viewer:'nominee',canPropose:false,proposal});
  field(f.host,'initial-admin-reject-confirm').props.onChange('REJECT_INITIAL_ADMINISTRATORS');await f.host.flush();
  button(f.host,'Reject or withdraw administrator setup').props.onClick();assert.deepEqual(f.api.calls[1].options.body,{action:'reject',proposalId:proposal.id,payloadHash:proposal.payloadHash,confirmation:'REJECT_INITIAL_ADMINISTRATORS'});
  f.api.calls[1].resolve({outcome:'rejected',approvalId:'approval-1'});await f.host.flush();f.api.calls[2].resolve({initialized:false,viewer:'unavailable',canPropose:false,proposal:null});await f.host.flush();
  assert.deepEqual(f.updates,[]);assert.match(words(f.host.current),/No administrator role was granted/);
});
test('identity or entitlement changes discard setup data and prevent stale proposal callbacks',async t=>{
  for(const changed of [{entitled:false},{currentUser:{id:'99',email:'someone-else@example.test'}}]) {
    const f=setup(t);await load(f,{initialized:false,viewer:'nominee',canPropose:false,proposal});
    field(f.host,'initial-admin-accept-confirm').props.onChange('ACCEPT_INITIAL_ADMINISTRATORS');await f.host.flush();
    const stale=button(f.host,'Accept initial administrator pair').props.onClick;
    f.host.render({...f.props,...changed});await f.host.flush();stale();await f.host.flush();assert.equal(f.api.calls.length,1);
    assert.equal(button(f.host,'Accept initial administrator pair'),undefined);
  }
});
