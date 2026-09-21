import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeEvidence, parsePreparationArgs, prepareEvidence } from '../scripts/prepare-signoff.mjs';
import { digest, SIGNOFF_DOMAIN, SIGNOFF_GATES, verifyProductionSignoff } from '../scripts/production-signoff.mjs';

// These fabricated report fixtures and ephemeral keys test the protocol, not release readiness.
const now = Date.parse('2026-09-21T10:00:00.000Z');
const candidate = {repository:'KartikeyAI/hubspot-dealguard',commit:'a'.repeat(40),tree:'b'.repeat(40),version:'3.0.0'};
async function fixture(t, complete = true) {
  const dir=await mkdtemp(join(tmpdir(),'dg-evidence-preparation-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const input=join(dir,'input'),output=join(dir,'output');
  await initializeEvidence({output:input,candidate});
  const measurements={ci:{testsTotal:1,testsPassed:1,testsFailed:0,testsSkipped:0,workflowPath:'.github/workflows/ci.yml',runId:'123',conclusion:'success'},
    acceptance:{hubspotProfiles:['synthetic-test'],projectBuildId:'456'},security:{unresolvedCritical:0,unresolvedHigh:0},
    load:{cachedReadP95Ms:1,testedDeals:10000,concurrentPortals:2},
    recovery:{rpoSeconds:0,rtoSeconds:1,providerDatabaseRestored:true,providerObjectsReconciled:true},
    pilot:{accountFingerprints:[digest('synthetic1'),digest('synthetic2'),digest('synthetic3')],unresolvedBlockingDefects:0}};
  async function read(gate){return JSON.parse(await readFile(join(input,'reports',gate+'.json')));}
  async function put(gate, report){await writeFile(join(input,'reports',gate+'.json'),JSON.stringify(report,null,3)+'\n');}
  if(complete)for(const gate of Object.keys(SIGNOFF_GATES)){
    const report=await read(gate);report.startedAt=new Date(now-60000).toISOString();report.completedAt=new Date(now-1000).toISOString();
    report.checks.forEach(c=>c.status='passed');report.measurements=measurements[gate]??{};await put(gate,report);
  }
  return {dir,input,output,read,put,prepare:extra=>prepareEvidence({input,output,candidate,stagingRunId:'789',now,...extra})};
}
test('evidence initializer never invents dates, measurements, passing checks or signatures',async t=>{
  const f=await fixture(t,false);
  for(const gate of Object.keys(SIGNOFF_GATES)){const r=await f.read(gate);assert.equal(r.startedAt,null);assert.equal(r.measurements,null);assert.ok(r.checks.every(c=>c.status==='not_run'));}
  await assert.rejects(f.prepare(),/incomplete/);await assert.rejects(readFile(join(f.output,'dossier.json')), {code:'ENOENT'});
});
test('assembly retains exact report bytes and requires subsequent independent signatures',async t=>{
  const f=await fixture(t),result=await f.prepare();
  assert.equal(result.approvalAccepted,false);assert.equal(result.productionReady,false);assert.equal(result.reports,11);
  const bytes=await readFile(join(f.output,'dossier.json'));assert.equal(digest(bytes),result.dossierSha256);
  const d=JSON.parse(bytes);assert.equal(d.stagingRunId,'789');assert.equal(Date.parse(d.expiresAt)-now,12*3600000);
  for(const gate of Object.keys(SIGNOFF_GATES)){const raw=await readFile(join(f.input,'reports',gate+'.json'));assert.deepEqual(await readFile(join(f.output,'reports',gate+'.json')),raw);assert.equal(d.gates[gate].sha256,digest(raw));}
  assert.deepEqual(JSON.parse(await readFile(join(f.output,'signatures.json'))),[]);
  const keys=['release_owner','security_reviewer'].map(role=>({role,...generateKeyPairSync('ed25519')}));
  const trust={schemaVersion:1,keys:keys.map((k,i)=>({id:'fixture-'+i,principal:'github:'+(i+1),role:k.role,
    publicKeyPem:k.publicKey.export({type:'spki',format:'pem'}),notBefore:new Date(now-86400000).toISOString(),notAfter:new Date(now+86400000).toISOString()}))};
  const verify=()=>verifyProductionSignoff({directory:f.output,expected:candidate,stagingRunId:'789',trust,now});
  await assert.rejects(verify(),/Two independent/);
  // Simulate only in this test: real reviewers retain and use their own keys outside tooling.
  await writeFile(join(f.output,'signatures.json'),JSON.stringify(keys.map((k,i)=>({keyId:'fixture-'+i,
    signature:sign(null,Buffer.concat([Buffer.from(SIGNOFF_DOMAIN),bytes]),k.privateKey).toString('base64url')}))));
  assert.equal((await verify()).approvalAccepted,true);assert.equal((await verify()).productionReady,false);
});
for(const change of [r=>r.checks[0].status='skipped',r=>r.checks.push(r.checks[0]),r=>r.candidate.commit='c'.repeat(40),
  r=>r.completedAt=new Date(now+1).toISOString(),r=>r.startedAt=new Date(now-8*86400000).toISOString()]){
  test('incomplete, mixed-source or stale evidence cannot create a dossier',async t=>{
    const f=await fixture(t),r=await f.read('commercial');change(r);await f.put('commercial',r);await assert.rejects(f.prepare(),/incomplete/);
    await assert.rejects(readFile(join(f.output,'dossier.json')),{code:'ENOENT'});
  });
}
test('alpha scaffolding is allowed but alpha approval assembly is rejected',async t=>{
  const f=await fixture(t);const alpha={...candidate,version:'3.0.0-alpha.1'};
  await initializeEvidence({output:join(f.dir,'alpha'),candidate:alpha});await assert.rejects(f.prepare({candidate:alpha}),/stable v3/);
});
test('an existing output is never overwritten',async t=>{
  const f=await fixture(t);await f.prepare();const before=await readFile(join(f.output,'dossier.json'));
  await assert.rejects(f.prepare(),{code:'EEXIST'});assert.deepEqual(await readFile(join(f.output,'dossier.json')),before);
});
test('symlink reports and symlink output parents are rejected',async t=>{
  const f=await fixture(t);const path=join(f.input,'reports','source.json');const raw=await readFile(path);
  await writeFile(join(f.dir,'external.json'),raw);await rm(path);await symlink(join(f.dir,'external.json'),path);
  await assert.rejects(f.prepare(),/symlink/);
  await symlink(f.dir,join(f.dir,'linked'));await assert.rejects(initializeEvidence({output:join(f.dir,'linked','out'),candidate}),/symlink/);
});
test('malformed JSON, oversized reports and measured target failures are rejected',async t=>{
  const f=await fixture(t),r=await f.read('load');r.measurements.cachedReadP95Ms=2500;await f.put('load',r);
  await assert.rejects(f.prepare(),/load targets/);await writeFile(join(f.input,'reports','source.json'),'{not json');await assert.rejects(f.prepare(),/UTF-8 JSON/);
  await writeFile(join(f.input,'reports','source.json'),' '.repeat(1048577));await assert.rejects(f.prepare(),/size limit/);
});
test('staging ID, validity window and command options cannot be silently ignored',async t=>{
  const f=await fixture(t);for(const extra of [{hours:0},{hours:25},{hours:1.5},{stagingRunId:'0'},{stagingRunId:'main'}])await assert.rejects(f.prepare(extra));
  for(const args of [[],['init','--input','x','--output','y'],['assemble','--output','x'],['init','--output','x','--output','y'],['init','--unknown','x'],
    ['assemble','--input','x','--output','y','--staging-run','1','--hours','1e1']])assert.throws(()=>parsePreparationArgs(args));
  assert.equal(parsePreparationArgs(['init','--output','x']).command,'init');
});
