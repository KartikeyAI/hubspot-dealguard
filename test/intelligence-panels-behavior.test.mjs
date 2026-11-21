import test from 'node:test';
import assert from 'node:assert/strict';
import { hookHarness,deferredFetch } from './helpers/ui-hook-harness.mjs';
const modules={'./product-ui':{safeProductError:message=>message??'Unavailable'}};
const nodes=(value)=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];
const words=value=>Array.isArray(value)?value.map(words).join(' '):value&&typeof value==='object'?words(value.props?.children):typeof value==='string'||typeof value==='number'?String(value):'';
const button=(host,label)=>nodes(host.current).find(node=>node.type==='Button'&&words(node).includes(label));

test('forecast reader has no administrator actions and unavailable probability is not rendered as zero',async t=>{
  const api=deferredFetch(),props={canForecast:true,canInspect:false,canAdminister:false,canReview:false,entitled:true};
  const host=hookHarness('src/app/pages/ForecastAdministrationPanel.tsx','ForecastAdministrationPanel',props,api.fetch,modules);t.after(()=>host.dispose());
  assert.equal(api.calls.length,0);assert.equal(button(host,'Load forecast administration'),undefined);
  const input=nodes(host.current).find(node=>node.type==='Input');input.props.onChange('11');await host.flush();
  const request=button(host,'Check deal forecast eligibility').props.onClick();
  assert.equal(api.calls.length,1);assert.equal(api.calls[0].options.method,'GET');assert.match(api.calls[0].url,/\/deal\?dealId=11$/);
  api.calls[0].resolve({status:'unavailable',reason:'globally_disabled',probability:null,quarter:'2026-Q4',anchorAt:'2026-10-01T00:00:00Z',horizonAt:'2027-01-01T00:00:00Z',limitations:[],uncertainty:null});
  await request;await host.flush();
  assert.match(words(host.current),/Probability:.*Unavailable/);assert.doesNotMatch(words(host.current),/Probability:.*0\.0%/);
  assert.equal(button(host,'Register candidate'),undefined);assert.equal(button(host,'Record independent review'),undefined);
});

test('queued, running and failed outcome reports display without invented metrics and clear on expiry',async t=>{
  const api=deferredFetch(),host=hookHarness('src/app/pages/OutcomeEvaluationPanel.tsx','OutcomeEvaluationPanel',{enabled:true,canEvaluate:true},api.fetch,modules);t.after(()=>host.dispose());
  assert.equal(api.calls.length,0);
  const request=button(host,'Load evaluation administration').props.onClick();
  api.calls[0].resolve({enabled:true,revision:1});await host.flush();assert.equal(api.calls.length,3);
  api.calls[1].resolve({items:[]});api.calls[2].resolve({items:['queued','running','failed'].map(status=>({id:`job-${status}`,report:{status,attempts:1,reason:'pending or failed'}}))});
  await request;await host.flush();
  const text=words(host.current);for(const status of ['queued','running','failed'])assert.match(text,new RegExp(`job-${status}`));
  assert.match(text,/No completed metrics are available/);assert.doesNotMatch(text,/Model Brier score/);
  host.render({enabled:true,canEvaluate:false});await host.flush();assert.doesNotMatch(words(host.current),/job-queued|job-running|job-failed/);
  const reload=button(host,'Load evaluation administration').props.onClick();api.calls[3].resolve({enabled:true,revision:1});await reload;await host.flush();
  assert.equal(api.calls.length,4,'expired administrators can inspect consent without fetching paid datasets');
  assert.match(words(host.current),/Revoke outcome consent/);assert.equal(button(host,'Queue held-out evaluation'),undefined);
});

test('revoking evaluation access while a response is pending prevents follow-on paid reads',async t=>{
  const api=deferredFetch(),host=hookHarness('src/app/pages/OutcomeEvaluationPanel.tsx','OutcomeEvaluationPanel',{enabled:true,canEvaluate:true},api.fetch,modules);t.after(()=>host.dispose());
  const request=button(host,'Load evaluation administration').props.onClick();
  host.render({enabled:true,canEvaluate:false});await host.flush();
  api.calls[0].resolve({enabled:true,revision:1});await request;await host.flush();
  assert.equal(api.calls.length,1);assert.doesNotMatch(words(host.current),/Dataset manifests/);
});
