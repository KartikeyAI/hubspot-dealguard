import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source,
  {compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText).toString('base64')}`;
const permissionUrl = moduleUrl(readFileSync('src/app/pages/product-ui.ts','utf8'));
const { loadHomeData } = await import(moduleUrl(readFileSync('src/app/pages/home-data.ts','utf8').replace("'./product-ui'", JSON.stringify(permissionUrl))));
const scope = {pipelineIds:[],ownerIds:[],teamIds:[],regionCodes:[]};
const billing = {tier:'enterprise',entitled:true};
const access = {role:'administrator',permissions:['*'],scope,entitled:true};
function requestFor(overrides={}) {
  const seen=[];
  const values={'/billing':billing,'/enterprise/access':access,'/dashboard':{totalOpenDeals:1},'/enterprise/overview':{policies:1},'/enterprise/analytics?days=90':{trends:[]},...overrides};
  return {seen,request:async path=>{seen.push(path);if(values[path] instanceof Error)throw values[path];return values[path];}};
}

test('billing-only access renders billing without requesting a denied analytics panel', async () => {
  const f=requestFor({'/enterprise/access':{...access,role:'billing_administrator',permissions:['billing.view','billing.manage']}});
  const result=await loadHomeData(f.request);
  assert.deepEqual(f.seen.sort(),['/billing','/enterprise/access']);
  assert.equal(result.billing,billing);assert.equal(result.dashboard,null);assert.equal(result.partial,false);
});

test('optional analytics failures preserve verified access and billing recovery', async () => {
  const f=requestFor({'/dashboard':new Error('temporarily unavailable'),'/enterprise/overview':new Error('scope denied')});
  const result=await loadHomeData(f.request);
  assert.equal(result.billing,billing);assert.equal(result.access,access);
  assert.equal(result.dashboard,null);assert.equal(result.overview,null);assert.equal(result.partial,true);
  assert.deepEqual(result.analytics,{trends:[]});
});

test('scoped and expired access never requests portal-wide enterprise summaries', async () => {
  const scoped=requestFor({'/enterprise/access':{...access,scope:{...scope,pipelineIds:['selected']}}});
  const result=await loadHomeData(scoped.request);
  assert.ok(scoped.seen.includes('/dashboard'));assert.ok(!scoped.seen.includes('/enterprise/overview'));
  assert.equal(result.overview,null);
  const expired=requestFor({'/billing':{...billing,entitled:false},'/enterprise/access':{...access,entitled:false}});
  await loadHomeData(expired.request);
  assert.deepEqual(expired.seen.sort(),['/billing','/dashboard','/enterprise/access']);
});

test('unverified required identity never displays a partly authorized workspace', async () => {
  for (const invalid of [null,{}, {...access,entitled:undefined}, {...access,permissions:null}]) {
    const f=requestFor({'/enterprise/access':invalid});
    await assert.rejects(loadHomeData(f.request), /could not be verified/);
    assert.deepEqual(f.seen.sort(),['/billing','/enterprise/access']);
  }
  const f=requestFor({'/billing':new Error('billing unavailable')});
  await assert.rejects(loadHomeData(f.request),/billing unavailable/);
  assert.deepEqual(f.seen.sort(),['/billing','/enterprise/access']);
});
