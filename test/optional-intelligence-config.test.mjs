import test from'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';
import{optionalIntelligenceConfiguration,renderOptionalIntelligenceVariables}from'../scripts/optional-intelligence-config.mjs';
import{aiConfiguration}from'../dist/ai-provider.js';import{breezeActionBindings}from'../dist/breeze-tools.js';
const env={DEALGUARD_AI_ENABLED:'true',DEALGUARD_AI_MODEL:'approved-fixture-model',DEALGUARD_AI_API_KEY:'fixture-not-a-provider-key',DEALGUARD_AI_PRICING_VERIFIED_AT:'2026-09-01T00:00:00Z',DEALGUARD_AI_INPUT_USD_PER_MILLION:'1',DEALGUARD_AI_OUTPUT_USD_PER_MILLION:'2'};
const now=Date.parse('2026-09-19T00:00:00Z');
test('optional configuration remains off by default without blocking deterministic releases',()=>{const c=optionalIntelligenceConfiguration({},now);assert(c.checks.every(i=>i.ok));assert.deepEqual(c.enabled,{ai:false,breeze:false,forecast:false});assert.equal(c.liveProviderVerified,false);});
test('optional provider preflight agrees with valid runtime configuration but never emits credentials',()=>{
 const c=optionalIntelligenceConfiguration(env,now);assert(c.checks.every(i=>i.ok));assert.equal(aiConfiguration(env,now).model,c.vars.DEALGUARD_AI_MODEL);assert(!JSON.stringify(c).includes(env.DEALGUARD_AI_API_KEY));assert.equal(c.secretsRendered,false);
 for(const extra of [{DEALGUARD_AI_API_KEY:''},{DEALGUARD_AI_MODEL:'../bad'},{DEALGUARD_AI_PRICING_VERIFIED_AT:'2026-02-30T00:00:00Z'},{DEALGUARD_AI_PRICING_VERIFIED_AT:'2026-09-20T00:00:00Z'},{DEALGUARD_AI_INPUT_USD_PER_MILLION:'0'}])assert(optionalIntelligenceConfiguration({...env,...extra},now).checks.some(i=>!i.ok));
});
test('Breeze only accepts unique known approved-definition bindings, not an approval assertion',()=>{
 const e={DEALGUARD_BREEZE_ENABLED:'true',DEALGUARD_BREEZE_ACTION_IDS:'{"risk":"12","evidence":13}'};
 const c=optionalIntelligenceConfiguration(e,now);assert(c.checks.every(i=>i.ok));assert.deepEqual(JSON.parse(c.vars.DEALGUARD_BREEZE_ACTION_IDS),breezeActionBindings(e));
 for(const ids of ['{}','null','{"risk":"12","evidence":12}','{"unknown":12}','{"risk":0}','{"risk":9007199254740993}'])assert(optionalIntelligenceConfiguration({...e,DEALGUARD_BREEZE_ACTION_IDS:ids},now).checks.some(i=>!i.ok));
});
test('rendering targets only selected non-secret vars, overrides stale enabled flags, and preserves release guards',()=>{
 const source='[env.staging.vars]\nAPP_BASE_URL = "https://example.test"\nDEALGUARD_AI_ENABLED = "true"\n[env.production.vars]\nAPP_BASE_URL = "https://production.test"\nDEALGUARD_AI_ENABLED = "true"\n';
 const rendered=renderOptionalIntelligenceVariables(source,'staging',{}),staging=rendered.split('[env.production.vars]')[0];assert.match(staging,/DEALGUARD_AI_ENABLED = "false"/);assert.equal((staging.match(/DEALGUARD_AI_ENABLED =/g)||[]).length,1);assert.match(rendered.split('[env.production.vars]')[1],/DEALGUARD_AI_ENABLED = "true"/);
 assert(!rendered.includes('API_KEY'));assert.throws(()=>renderOptionalIntelligenceVariables(source,'production',{DEALGUARD_AI_ENABLED:'yes'}));
 const workflow=readFileSync('.github/workflows/controlled-deploy.yml','utf8');assert.match(workflow,/DEALGUARD_AI_API_KEY: \$\{\{ secrets.DEALGUARD_AI_API_KEY \}\}/);assert.match(workflow,/DEPLOY DEALGUARD TO PRODUCTION/);assert.match(workflow,/Verify encrypted pre-change backup/);
});
