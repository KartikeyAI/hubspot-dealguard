import test from 'node:test';
import assert from 'node:assert/strict';
import { hookHarness,deferredFetch } from './helpers/ui-hook-harness.mjs';
const filename='src/app/cards/deal-intelligence-shared.tsx';
const record=(dealId,capability=true)=>({dealId,score:80,grade:'B',status:'ready',issues:[],assessedAt:'2026-11-21T00:00:00Z',
  recordCapabilities:{canRefresh:capability,canReview:capability,canConfirmHandoff:capability}});

test('card opening performs only a recorded GET; missing evidence offers refresh only to an authorized actor', async t=>{
  for(const allowed of [false,true]) {
    const api=deferredFetch(),host=hookHarness(filename,'useDealAssessment','11',api.fetch);t.after(()=>host.dispose());
    assert.equal(api.calls.length,1);assert.equal(api.calls[0].options.method,'GET');
    api.calls[0].resolve({error:{code:'assessment_unavailable',message:'No recorded assessment.',details:{canRefresh:allowed}}},404);
    await host.flush();assert.equal(host.current.loading,false);assert.equal(host.current.assessment,null);assert.equal(host.current.canRefresh,allowed);
    const first=host.current.load(true),second=host.current.load(true);
    assert.equal(api.calls.length,allowed?2:1,'no automatic POST or duplicate in-flight refresh');
    if(allowed){assert.equal(api.calls[1].options.method,'POST');api.calls[1].resolve(record('11'));}
    await Promise.all([first,second]);await host.flush();
    assert.equal(host.current.assessment?.dealId,allowed?'11':undefined);
  }
});

test('a slow prior-deal response never replaces the current deal evidence', async t=>{
  const api=deferredFetch(),host=hookHarness(filename,'useDealAssessment','11',api.fetch);t.after(()=>host.dispose());
  host.render('22');assert.equal(host.current.assessment,null);assert.equal(host.current.loading,true);
  assert.equal(api.calls.length,2);assert.match(api.calls[1].url,/\/deals\/22\/assessment$/);
  api.calls[1].resolve(record('22'));await host.flush();assert.equal(host.current.assessment.dealId,'22');
  api.calls[0].resolve(record('11'));await host.flush();
  assert.equal(host.current.assessment.dealId,'22');assert.equal(host.current.error,null);
});

test('navigating clears loaded evidence immediately and stale callbacks cannot mutate the old record', async t=>{
  const api=deferredFetch(),host=hookHarness(filename,'useDealAssessment','11',api.fetch);t.after(()=>host.dispose());
  api.calls[0].resolve(record('11'));await host.flush();
  const previous=host.current;assert.equal(previous.canRefresh,true);
  host.render('22');assert.equal(host.current.assessment,null);assert.equal(host.current.canRefresh,false);
  await previous.postAction('review');await previous.load(true);assert.equal(api.calls.length,2);
  api.calls[1].resolve(record('22',false));await host.flush();
  await host.current.postAction('review');await host.current.postAction('handoff');await host.current.load(true);
  assert.equal(api.calls.length,2,'read-only actors cannot dispatch actions through stale or direct callbacks');
});

test('an old record action completion cannot reload or notify after navigation', async t=>{
  const api=deferredFetch(),host=hookHarness(filename,'useDealAssessment','11',api.fetch);t.after(()=>host.dispose());
  api.calls[0].resolve(record('11'));await host.flush();
  const action=host.current.postAction('review');assert.equal(api.calls.length,2);assert.match(api.calls[1].url,/\/11\/review$/);
  host.render('22');assert.equal(api.calls.length,3);
  api.calls[2].resolve(record('22'));await host.flush();
  api.calls[1].resolve({ok:true});await action;await host.flush();
  assert.equal(api.calls.length,3);assert.equal(host.current.assessment.dealId,'22');assert.equal(host.current.notice,null);
});
