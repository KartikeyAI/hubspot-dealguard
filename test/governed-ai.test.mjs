import test from 'node:test';import assert from 'node:assert/strict';
import {aiConfiguration,validateAiOutput,generateAiExplanation}from'../dist/ai-provider.js';
import {routeIntelligence}from'../dist/routes-intelligence.js';
const settings=()=>({DEALGUARD_AI_ENABLED:'true',DEALGUARD_AI_MODEL:'approved-test-model',DEALGUARD_AI_API_KEY:'not-a-real-provider-key',
 DEALGUARD_AI_PRICING_VERIFIED_AT:new Date(Date.now()-1000).toISOString(),DEALGUARD_AI_INPUT_USD_PER_MILLION:'1',DEALGUARD_AI_OUTPUT_USD_PER_MILLION:'2'});
const facts=[{id:'readiness_score',kind:'readiness_score',value:80}],draft={sections:[{heading:'risk_summary',text:'Review the recorded readiness gaps before progressing.',evidenceIds:['readiness_score']}]};
test('AI is disabled unless provider, exact model and recently verified rates are configured',()=>{
 assert.throws(()=>aiConfiguration({}),{code:'ai_disabled'});assert.throws(()=>aiConfiguration({...settings(),DEALGUARD_AI_INPUT_USD_PER_MILLION:undefined}),{code:'ai_configuration_unavailable'});
 assert.throws(()=>aiConfiguration({...settings(),DEALGUARD_AI_PRICING_VERIFIED_AT:new Date(Date.now()-31*86400000).toISOString()}),{code:'ai_configuration_unavailable'});
 assert.throws(()=>aiConfiguration({...settings(),DEALGUARD_AI_PRICING_VERIFIED_AT:new Date(Date.now()+10000).toISOString()}),{code:'ai_configuration_unavailable'});
 assert.equal(aiConfiguration(settings()).reservationMicro,35168);
});
test('AI structural verifier rejects unknown evidence, numeric claims, active links and action requests',()=>{
 assert.deepEqual(validateAiOutput(draft,facts),draft);
 for(const override of [{text:'The win probability is high.'},{text:'The score is 100.'},{text:'See https://example.test'},{text:'<script>alert()</script>'},{text:'Guaranteed revenue uplift.'},{evidenceIds:['unknown']}])
 assert.throws(()=>validateAiOutput({sections:[{...draft.sections[0],...override}]},facts),{code:'ai_output_invalid'});
 assert.throws(()=>validateAiOutput({...draft,tool_calls:[{}]},facts),{code:'ai_output_invalid'});
});
test('AI output sections must match the selected evidence purpose',()=>{
 const handover={sections:[{heading:'handover',text:'Review the recorded handoff gaps before confirming readiness.',evidenceIds:['readiness_score']}]};
 assert.deepEqual(validateAiOutput(handover,facts,'handover'),handover);
 assert.throws(()=>validateAiOutput(draft,facts,'handover'),{code:'ai_output_invalid'});
 for(const purpose of ['risk','manager_review','next_action'])
  assert.throws(()=>validateAiOutput(handover,facts,purpose),{code:'ai_output_invalid'});
});
test('AI review prose rejects the demonstrated spelled-value and unsupported handover assertions',()=>{
 const handoffFacts=[...facts,{id:'handoff_status',kind:'handoff_status',value:'pending'},
  {id:'delivery_assignment_recorded',kind:'handoff_limitation',value:false},{id:'documents_verified',kind:'handoff_limitation',value:false}];
 const output=text=>({sections:[{heading:'handover',text,evidenceIds:['handoff_status']}]});
 for(const text of [
  'The contract is worth one million dollars and the delivery team is assigned.',
  'Review the contract value of one million dollars.',
  'Check the two hundred thousand rupees recorded in the contract.',
  'Review the expected ten percent improvement.',
  'Review the ＄１００ contract.',
  'Review the Ⅳ pending tasks.',
  'Review the o\u200bne required document.',
  'The delivery team is assigned.',
  'Review the assigned delivery team.',
  'Review the completed documents.',
  'Check the signed contract with the delivery team.',
  'Review the handover; the documents are complete.',
  'Review the handover. The delivery team is assigned.',
  'Review the handover, and the documents are complete.',
  'Why are the documents complete?',
  'Why is the delivery team already assigned?',
  'The buyer has approved the handover.',
 ])assert.throws(()=>validateAiOutput(output(text),handoffFacts,'handover'),{code:'ai_output_invalid'},text);
});
test('AI review prose preserves useful evidence-bound questions and requests without claiming completion',()=>{
 const handoffFacts=[...facts,{id:'handoff_status',kind:'handoff_status',value:'pending'},
  {id:'delivery_assignment_recorded',kind:'handoff_limitation',value:false},{id:'documents_verified',kind:'handoff_limitation',value:false}];
 for(const text of [
  'Review the recorded handoff gaps with the delivery team before confirming readiness.',
  'Are the delivery assignments recorded?',
  'Are the required documents complete?',
  'Check whether the delivery team is assigned.',
  'Verify whether the documents are complete.',
  'Which documents still need verification?',
  'Who should review the missing delivery assignments?',
  'Review the recorded gaps. What evidence is still missing?',
  'Review the next action; clarify its responsible role.',
 ]){
  const output={sections:[{heading:'handover',text,evidenceIds:['handoff_status']}]};
  assert.deepEqual(validateAiOutput(output,handoffFacts,'handover'),output,text);
 }
});
test('financial declarations and unsupported extra sentences fail even when citation IDs are valid',()=>{
 for(const text of ['The contract value is significant.','Review the recorded facts. Revenue is assured.','The score improved.','Create a delivery task.'])
  assert.throws(()=>validateAiOutput({sections:[{...draft.sections[0],text}]},facts,'risk'),{code:'ai_output_invalid'},text);
});
test('provider adapter uses a fixed origin, no storage/tools, strict schema and reported usage',{concurrency:false},async t=>{
 const old=globalThis.fetch;t.after(()=>globalThis.fetch=old);let sent;
 globalThis.fetch=async(url,init)=>{sent={url,init,body:JSON.parse(init.body)};return Response.json({model:'approved-test-model',status:'completed',usage:{input_tokens:100,output_tokens:50},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(draft)}]}]});};
 assert.equal((await generateAiExplanation(aiConfiguration(settings()),'risk',facts)).accountedMicro,200);
 assert.equal(sent.url,'https://api.openai.com/v1/responses');assert.equal(sent.init.redirect,'error');assert.equal(sent.body.store,false);assert.equal(sent.body.background,false);
 assert.equal(sent.body.tools,undefined);assert.equal(sent.body.text.format.strict,true);assert.equal(sent.body.max_output_tokens,1200);
});
test('provider rejects an invented handover without exposing it or discarding attempted usage',{concurrency:false},async t=>{
 const old=globalThis.fetch;t.after(()=>globalThis.fetch=old);
 const handoffFacts=[{id:'handoff_status',kind:'handoff_status',value:'pending'},
  {id:'delivery_assignment_recorded',kind:'handoff_limitation',value:false},{id:'documents_verified',kind:'handoff_limitation',value:false}];
 const invented='The contract is worth one million dollars and the delivery team is assigned.';
 globalThis.fetch=async()=>Response.json({model:'approved-test-model',status:'completed',usage:{input_tokens:100,output_tokens:50},
  output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({sections:[{heading:'handover',text:invented,evidenceIds:['handoff_status']}]})}]}]});
 await assert.rejects(generateAiExplanation(aiConfiguration(settings()),'handover',handoffFacts),
  error=>error.code==='ai_provider_unavailable'&&error.accountedMicro===200&&!error.message.includes(invented));
});
test('refusals, malformed responses, excessive tokens and wrong model fail without exposing provider text',{concurrency:false},async t=>{
 const old=globalThis.fetch;t.after(()=>globalThis.fetch=old);
 for(const raw of [{status:'incomplete'},{status:'completed',model:'other',output:[]},{status:'completed',model:'approved-test-model',output:[{type:'message',content:[{type:'refusal',refusal:'private'}]}]},
   {status:'completed',model:'approved-test-model',usage:{input_tokens:100,output_tokens:1201},output:[]}]){
 globalThis.fetch=async()=>Response.json(raw);await assert.rejects(generateAiExplanation(aiConfiguration(settings()),'risk',facts),e=>e.code==='ai_provider_unavailable'&&!e.message.includes('private'));}
 globalThis.fetch=async()=>new Response('x'.repeat(65000));await assert.rejects(generateAiExplanation(aiConfiguration(settings()),'risk',facts),{code:'ai_provider_unavailable'});
});
test('AI endpoints require signed HubSpot identity and reject unsupported methods',async()=>{
 const ctx={waitUntil(){}};
 for(const path of ['status','consent','limits','assist'])await assert.rejects(routeIntelligence(new Request('https://example.test/api/v1/enterprise/ai/'+path,{method:path==='status'?'GET':path==='assist'?'POST':'PUT'}),{HUBSPOT_CLIENT_SECRET:'test'},ctx),{status:401});
 assert.equal((await routeIntelligence(new Request('https://example.test/api/v1/enterprise/ai/assist'),{},ctx)).status,405);
});
