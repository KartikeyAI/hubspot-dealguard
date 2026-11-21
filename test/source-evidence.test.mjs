import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSourceEvidence, readSourceEvidence, sourceBoundSnapshotFreshness, sourceObservation } from '../dist/source-evidence.js';
import { snapshotFreshness } from '../dist/evidence-freshness.js';
const now=Date.parse('2026-09-19T12:00:00Z'),hour=3600000,at=h=>new Date(now-h*hour).toISOString();
const base=()=>snapshotFreshness({assessmentAt:at(1),snapshotAssessmentAt:at(1),generatedAt:at(0),recordedStatus:'fresh'},now);
const dims=(history=at(2))=>({readiness:{score:80},momentum:{score:50},sourceEvidence:buildSourceEvidence({readiness:at(1),history},now)});
test('independent source clocks age without inheriting generation or readiness time',()=>{
 const d=dims(at(80)),f=sourceBoundSnapshotFreshness(base(),d,now);
 assert.equal(f.usable,false);assert.equal(f.reason,'source_history_stale');assert.equal(f.status,'stale');
 assert.equal(d.sourceEvidence.sources.readiness.status,'fresh');
});
test('partial sources remain explicitly unavailable without rejecting absent optional dimensions',()=>{
 const d={readiness:{score:80},sourceEvidence:buildSourceEvidence({readiness:at(1)},now)};
 assert.equal(d.sourceEvidence.sources.commercial.status,'unavailable');
 assert.equal(sourceBoundSnapshotFreshness(base(),d,now).usable,true);
 d.commercial={score:90};assert.equal(sourceBoundSnapshotFreshness(base(),d,now).usable,false);
});
test('legacy snapshots cannot claim verified enrichment clocks',()=>{
 assert.equal(sourceBoundSnapshotFreshness(base(),{readiness:{score:80}},now).reason,'source_provenance_unavailable');
});
test('usable aging sources cap combined confidence state even with a fresh assessment',()=>{
 assert.equal(sourceBoundSnapshotFreshness(base(),dims(at(48)),now).status,'aging');
});
test('receipts reject future, impossible, local and post-generation clocks',()=>{
 for(const value of [null,'2026-02-30T01:00:00Z','2026-09-19T01:00:00',at(-1)]) assert.equal(sourceObservation(value,now).usable,false);
 const d=dims();d.sourceEvidence.sources.history=sourceObservation(at(-1),now+hour);
 assert.equal(sourceBoundSnapshotFreshness(base(),d,now+hour).reason,'source_after_generation');
});
test('stored source degradation is not upgraded and elapsed age is recalculated',()=>{
 const d=dims();d.sourceEvidence.sources.history.status='stale';
 assert.equal(readSourceEvidence(d.sourceEvidence,now).sources.history.status,'stale');
 assert.equal(readSourceEvidence(dims().sourceEvidence,now+80*hour).sources.history.status,'stale');
});
test('receipts bind readiness to the exact assessment instant and validate all entries',()=>{
 const d=dims();d.sourceEvidence.sources.readiness.observedAt=at(2);
 assert.equal(sourceBoundSnapshotFreshness(base(),d,now).usable,false);
 for(const receipt of [null,{},[],{version:2,sources:{}},{version:1,sources:{}}]) assert.equal(readSourceEvidence(receipt,now),null);
});
test('all enriched dimension keys require their corresponding independent source',()=>{
 for(const [dimension,source] of [['momentum','history'],['closeDate','history'],['relationship','relationships'],['engagement','engagement'],['commercial','commercial']]) {
  const d={readiness:{score:80},[dimension]:{score:50},sourceEvidence:buildSourceEvidence({readiness:at(1),[source]:at(80)},now)};
  assert.equal(sourceBoundSnapshotFreshness(base(),d,now).reason,`source_${source}_stale`);
 }
});
