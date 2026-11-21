import test from 'node:test';import assert from 'node:assert/strict';
import {quarterWindow,buildOutcomeCohort}from'../dist/outcome-cohort.js';
import {predictionMetrics,evaluateOutcomeCohorts}from'../dist/outcome-evaluation.js';
const now=Date.parse('2026-09-19T00:00:00Z'),created='2025-01-01T00:00:00Z';
const base=()=>({deal_id:'1',baseline_available:true,label_available:true,invalid_history:false,
 baseline:{assessed_at:'2026-03-31T12:00:00Z',score:80,issue_count:2,stage_age_days:null,pipeline_id:'p',policy_id:'v',is_closed:0,is_won:0},
 label:{assessed_at:'2026-06-30T12:00:00Z',pipeline_id:'p',policy_id:'v',is_closed:1,is_won:1}});
const build=rows=>buildOutcomeCohort(rows,'2026-Q2','p','v',created,now);
test('quarter boundaries are UTC and require seven-day label maturity',()=>{
 assert.deepEqual(quarterWindow('2026-Q2',now),{anchor:'2026-04-01T00:00:00.000Z',horizon:'2026-07-01T00:00:00.000Z'});
 assert.throws(()=>quarterWindow('2026-Q3',now),{code:'outcome_horizon_immature'});for(const v of ['2026-Q5','2026-q1',null,{}])assert.throws(()=>quarterWindow(v,now));
});
test('outcome features preserve missingness and observed open is a horizon-specific negative',()=>{
 const a=base(),b=base();b.deal_id='2';b.label.is_closed=0;b.label.is_won=0;
 const d=build([a,b]);assert.equal(d.manifest.sampleCount,2);assert.deepEqual(d.samples[0].features,[80,2,0,1]);assert.deepEqual(d.samples.map(s=>s.label),[1,0]);
});
test('missing labels, archives, reassignment and stale observations are excluded rather than labelled losses',()=>{
 const cases=[['missing',c=>c.label=null],['archived',c=>c.label_available=false],['pipeline',c=>c.label.pipeline_id='q'],['stale',c=>c.label.assessed_at='2026-06-01T00:00:00Z'],['future',c=>c.label.assessed_at='2026-07-01T00:00:00Z'],['bad',c=>c.invalid_history=true]];
 const rows=cases.map(([id,fn])=>{const c=base();c.deal_id=id;fn(c);return c;});const d=build(rows);assert.equal(d.samples.length,0);assert.equal(Object.values(d.manifest.exclusions).reduce((a,b)=>a+b,0),6);
});
test('invalid numbers, contradictory labels, duplicated IDs and future policies fail safely',()=>{
 for(const mutate of [c=>c.baseline.score=null,c=>c.baseline.issue_count=-1,c=>c.baseline.stage_age_days=-1,c=>{c.label.is_closed=0;c.label.is_won=1;},c=>c.baseline.is_closed=1]){const c=base();mutate(c);assert.equal(build([c]).samples.length,0);}
 assert.throws(()=>build([base(),base()]),{code:'outcome_duplicate_identity'});
 assert.throws(()=>buildOutcomeCohort([base()],'2026-Q2','p','v','2026-04-02T00:00:00Z',now),{code:'outcome_policy_invalid'});
 assert.throws(()=>build(Array.from({length:10001},base)),{code:'outcome_capacity_exceeded'});
});
test('metrics are exact on a small known sample including tied AUC',()=>{
 const m=predictionMetrics([0,1],[0.25,0.75]);assert.equal(m.brier,.0625);assert.equal(m.auc,1);assert.equal(m.ece,.25);
 assert.equal(predictionMetrics([0,1],[.5,.5]).auc,.5);assert.equal(predictionMetrics([1],[.5]).auc,null);
 assert.throws(()=>predictionMetrics([],[]));assert.throws(()=>predictionMetrics([1],[NaN]));assert.throws(()=>predictionMetrics([3],[.5]));
});
export function cohort(q,prefix,n=220,signal=true){const w=quarterWindow(q,now);return {manifest:{schema:'dealguard-quarter-outcomes-v1',quarter:q,...w,pipelineId:'p',policyId:'v',sampleCount:n,exclusions:{}},samples:Array.from({length:n},(_,i)=>({dealId:prefix+i,observationAt:new Date(Date.parse(w.anchor)-3600000).toISOString(),labelAt:new Date(Date.parse(w.horizon)-3600000).toISOString(),features:[signal?(i%2?90:10):50,signal?(i%2?0:8):2,4,0],label:i%2}))};}
test('separable synthetic cohorts qualify only a historical candidate, never predictions',()=>{
 const result=evaluateOutcomeCohorts(cohort('2025-Q4','t'),cohort('2026-Q1','c',120),cohort('2026-Q2','h',120));
 assert.equal(result.report.status,'qualified_candidate');assert.equal(result.report.predictionsEnabled,false);assert.equal(result.report.model.auc,1);assert.ok(result.report.model.brier<.05);
});
test('absence of predictive signal cannot pass the gate and insufficient support has no invented metric',()=>{
 const r=evaluateOutcomeCohorts(cohort('2025-Q4','t',220,false),cohort('2026-Q1','c',120,false),cohort('2026-Q2','h',120,false));assert.equal(r.report.status,'not_qualified');
 const s=evaluateOutcomeCohorts(cohort('2025-Q4','t',20),cohort('2026-Q1','c',120),cohort('2026-Q2','h',120));assert.equal(s.report.status,'insufficient_evidence');assert.equal(s.report.model,null);assert.equal(s.parameters,null);
});
test('overlapping identities cannot leak from training into evaluation',()=>{
 const r=evaluateOutcomeCohorts(cohort('2025-Q4','same'),cohort('2026-Q1','same',120),cohort('2026-Q2','h',120));assert.equal(r.report.status,'insufficient_evidence');assert.equal(r.report.duplicatesExcluded[1],120);
});
test('reversed quarters, malformed samples, oversized splits and mixed policy are denied',()=>{
 const a=cohort('2025-Q4','t'),b=cohort('2026-Q1','c',120),c=cohort('2026-Q2','h',120);
 assert.throws(()=>evaluateOutcomeCohorts(c,b,a));b.manifest.policyId='other';assert.throws(()=>evaluateOutcomeCohorts(a,b,c));b.manifest.policyId='v';
 b.samples[0].observationAt=b.manifest.horizon;assert.throws(()=>evaluateOutcomeCohorts(a,b,c));
 assert.throws(()=>evaluateOutcomeCohorts(cohort('2025-Q4','t',2001),b,c));
});
test('changing holdout labels cannot change fitted weights or calibration temperature',()=>{
 const a=cohort('2025-Q4','t'),b=cohort('2026-Q1','c',120),c=cohort('2026-Q2','h',120),r=evaluateOutcomeCohorts(a,b,c);
 c.samples.forEach(s=>s.label=1-s.label);const changed=evaluateOutcomeCohorts(a,b,c);assert.deepEqual(changed.parameters,r.parameters);assert.equal(changed.report.status,'not_qualified');
});
