import test from'node:test';import assert from'node:assert/strict';import{createHash}from'node:crypto';import fs from'node:fs';
import{parseBreezeInvocation,routeBreeze,breezeActionBindings,BREEZE_TOOLS}from'../dist/breeze-tools.js';
const env={HUBSPOT_CLIENT_SECRET:'test-secret',HUBSPOT_APP_ID:'123',DEALGUARD_BREEZE_ENABLED:'true',DEALGUARD_BREEZE_ACTION_IDS:JSON.stringify({evidence:'900'})};
const payload=()=>({callbackId:'callback-one',origin:{portalId:1234,userId:7,actionDefinitionId:900},context:{agentId:500,source:'AGENTS'},inputFields:{dealId:'101'},fields:{dealId:'101'}});
function signed(body,url='https://example.test/api/v1/breeze/evidence',version='v2'){
 const text=JSON.stringify(body);return new Request(url,{method:'POST',body:text,headers:{'x-hubspot-signature-version':version,'x-hubspot-signature':createHash('sha256').update(version==='v2'?env.HUBSPOT_CLIENT_SECRET+'POST'+url+text:env.HUBSPOT_CLIENT_SECRET+text).digest('hex')}});}
test('Breeze validates bound v2 origin identities and never accepts body-only signatures',async()=>{
 const value=await parseBreezeInvocation(signed(payload()),env,'evidence');assert.equal(value.identity.portalId,'1234');assert.equal(value.identity.userId,'7');assert.equal(value.identity.userEmail,null);assert.equal(value.dealId,'101');
 await assert.rejects(parseBreezeInvocation(signed(payload(),undefined,'v1'),env,'evidence'),{code:'invalid_signature'});
 await assert.rejects(parseBreezeInvocation(signed(payload(),'https://example.test/api/v1/breeze/evidence?userId=8'),env,'evidence'),{code:'breeze_identity_ambiguous'});
});
test('conflicting aliases, wrong definitions and workflow impersonation are rejected',async()=>{
 const variants=[{...payload(),fields:{dealId:'999'}},{...payload(),inputFields:{dealId:'101',userId:'7'},fields:{dealId:'101',userId:'7'}},
 {...payload(),context:{source:'WORKFLOWS',agentId:500}},{...payload(),origin:{portalId:1234,userId:7,actionDefinitionId:901}},
 {...payload(),origin:{portalId:1234,userId:9007199254740992,actionDefinitionId:900}},{...payload(),inputFields:{dealId:'../secrets'},fields:{dealId:'../secrets'}}];
 for(const body of variants)await assert.rejects(parseBreezeInvocation(signed(body),env,'evidence'));
});
test('Breeze is disabled by default and cannot invoke a definition absent from approved bindings',async()=>{
 assert.throws(()=>breezeActionBindings({}),{code:'breeze_disabled'});
 assert.throws(()=>breezeActionBindings({...env,DEALGUARD_BREEZE_ACTION_IDS:'{}'}),{code:'breeze_bindings_unavailable'});
 await assert.rejects(parseBreezeInvocation(signed(payload()),env,'risk'),{code:'breeze_tool_unapproved'});
 assert.equal((await routeBreeze(new Request('https://example.test/api/v1/breeze/evidence'),env)).status,405);
});
test('optional manifests are unpublished, read-only and excluded from the canonical project',()=>{
 const files=fs.readdirSync('optional/breeze/workflow-actions').filter(f=>f.endsWith('-hsmeta.json'));assert.equal(files.length,5);
 for(const file of files){const m=JSON.parse(fs.readFileSync('optional/breeze/workflow-actions/'+file,'utf8'));assert.equal(m.config.isPublished,false);assert.equal(m.type,'workflow-action');
 assert.deepEqual(m.config.supportedClients.map(c=>[c.client,c.toolType]),[['AGENTS','GET_DATA']]);assert(m.config.supportedClients[0].llmConfig.actionDescription);
 assert.deepEqual(m.config.inputFields.map(f=>f.typeDefinition.name),['dealId']);assert(m.config.outputFields.every(f=>f.typeDefinition.type==='string'));
 assert.equal(fs.existsSync('src/app/workflow-actions/'+file),false);}
 assert.equal(BREEZE_TOOLS.length,5);
});
