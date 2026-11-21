import test from 'node:test';
import assert from 'node:assert/strict';
import {activeForecastQuarter,forecastWindow,validForecastFeatures,validateForecastParameters,featureProfile,forecastDrift,forecastOutcomeReport,calibrationBins,modelReportQualified} from '../dist/forecast-model.js';
import {anchorFeatures} from '../dist/forecast-evidence.js';
const parameters={means:[50,4,4,0],scales:[40,4,1,1],weights:[0,2,-2,0,0],temperature:1};
test('forecast origin is the UTC quarter boundary, including year rollover',()=>{
 assert.deepEqual(activeForecastQuarter(Date.parse('2026-11-21T00:00:00Z')),{quarter:'2026-Q4',anchorAt:'2026-10-01T00:00:00.000Z',horizonAt:'2027-01-01T00:00:00.000Z'});
 assert.equal(forecastWindow('2026-Q1').anchorAt,'2026-01-01T00:00:00.000Z');
 assert.throws(()=>forecastWindow('2026-Q5'));
});
test('forecast features and model values fail closed on invalid and mismatched input',()=>{
 assert.equal(validForecastFeatures([80,2,0,1]),true);
 for(const f of [[80,2,4,1],[null,2,0,1],[101,2,0,1],[50,-1,4,0],[50,2,NaN,0],[50,2,4,0,1]])assert.equal(validForecastFeatures(f),false);
 validateForecastParameters(parameters);
 for(const change of [{weights:[1,2]},{scales:[1,1,0,1]},{temperature:0},{means:[NaN,1,1,1]}])assert.throws(()=>validateForecastParameters({...parameters,...change}));
});
test('retained anchor evidence cannot be replaced by a new observation or another cohort',()=>{
 const row={deal_id:'1',available:true,invalid_history:false,baseline:{assessed_at:'2026-09-30T12:00:00Z',pipeline_id:'p',policy_id:'v',is_closed:0,is_won:0,score:20,issue_count:8,stage_age_days:null}};
 const a={pipelineId:'p',policyId:'v'},anchor='2026-10-01T00:00:00Z';
 assert.deepEqual(anchorFeatures(row,a,anchor),[20,8,0,1]);
 for(const patch of [{assessed_at:'2026-10-02T00:00:00Z'},{assessed_at:'2026-09-20T00:00:00Z'},{pipeline_id:'outside'},{policy_id:'new'},{is_closed:1}])
  assert.equal(anchorFeatures({...row,baseline:{...row.baseline,...patch}},a,anchor),null);
 assert.equal(anchorFeatures({...row,invalid_history:true},a,anchor),null);
});
test('drift indicators require actual sufficient cohort evidence and compare feature distributions',()=>{
 const data=Array.from({length:200},(_,i)=>({features:[i%2?90:10,i%2?0:8,4,0]}));
 const reference=featureProfile(data,parameters);
 assert.equal(forecastDrift(reference,reference,0,200).status,'eligible');
 const shifted=featureProfile(Array.from({length:200},()=>({features:[100,0,4,0]})),parameters);
 assert.equal(forecastDrift(shifted,reference,0,200).status,'drifted');
 assert.equal(forecastDrift(featureProfile(data.slice(0,99),parameters),reference,0,99).status,'insufficient_evidence');
 assert.equal(forecastDrift(reference,reference,60,260).status,'drifted');
});
test('uncertainty bins report historical support and missing bins honestly',()=>{
 const samples=Array.from({length:100},(_,i)=>({features:[i%2?90:10,i%2?0:8,4,0],label:i%2}));
 const bins=calibrationBins(samples,parameters);assert.equal(bins.reduce((s,b)=>s+b.count,0),100);
 for(const b of bins){if(!b.count)assert.equal(b.observedRateInterval,null);else{
  assert.equal(b.count,50);assert.ok(b.observedRateInterval[0]>=0);assert.ok(b.observedRateInterval[1]<=1);assert.ok(b.observedRateInterval[0]<=b.observedRate);assert.ok(b.observedRateInterval[1]>=b.observedRate);
 }}
});
test('mature outcome monitoring excludes missing labels and cannot invent accuracy',()=>{
 assert.equal(forecastOutcomeReport([],[],.5,100).status,'insufficient_evidence');
 const labels=Array.from({length:120},(_,i)=>i%2);
 assert.equal(forecastOutcomeReport(labels,labels.map(y=>y?.9:.1),.5,130).status,'observed');
 assert.equal(forecastOutcomeReport(labels,labels.map(y=>y?.1:.9),.5,120).status,'drifted');
 assert.equal(modelReportQualified({status:'qualified_candidate'}),false);
});
