import { Client } from 'pg';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import assert from 'node:assert/strict';
import { forecastStatus } from '../dist/forecast-service.js';
import { localFixtureUrl, readOnlyPortalAdapter, schemaEvidence } from './local-rehearsal-support.mjs';

// An explicitly opted-in fixture rehearsal. This cannot target a provider database.
const source = localFixtureUrl('DEALGUARD_LOCAL_RECOVERY', 'RUN DISPOSABLE LOCAL REHEARSAL');
const binaryDirectory = resolve(process.env.PG_BIN ?? process.env.DEALGUARD_POSTGRES_BIN ?? '/usr/bin');
const destinationName = 'dealguard_rehearsal_' + randomBytes(8).toString('hex');
const destination = new URL(source); destination.pathname = '/' + destinationName;
const temp = await mkdtemp(join(tmpdir(), 'dealguard-recovery-'));
const sourceClient = new Client({ connectionString: source.href });
const restoreClient = new Client({ connectionString: destination.href });
const portal = 'local_recovery_' + randomUUID();
const passphrase = randomBytes(32);
const childEnvironment = { ...process.env, DEALGUARD_REHEARSAL_PASSPHRASE: passphrase.toString('base64') };
let created = false, seeded = false, restoreConnected = false;
const started = Date.now();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const run = (binary, args) => {
  // PG_BIN can use a portable PostgreSQL library bundle. System OpenSSL must not.
  const env = { ...childEnvironment };
  if (binary === 'openssl') delete env.LD_LIBRARY_PATH;
  return execFileSync(binary, args, { env, maxBuffer: 20_000_000, stdio: ['ignore', 'pipe', 'pipe'] });
};
try {
  await sourceClient.connect();
  if (Number((await sourceClient.query('SELECT COUNT(*) AS n FROM dealguard.tenants')).rows[0].n) !== 0) {
    throw new Error('The source fixture database must contain no existing tenants.');
  }
  const now = new Date().toISOString();
  await sourceClient.query(`INSERT INTO dealguard.tenants(portal_id,app_id,access_token_cipher,access_token_iv,refresh_token_cipher,refresh_token_iv,
    token_expires_at,settings_json,installed_at,updated_at,next_scan_at,commercial_tier,trial_ends_at)
    VALUES($1,'fixture','fixture-only','fixture-only','fixture-only','fixture-only',$2,'{}',$2,$2,$2,'enterprise',$3)`,
    [portal, now, new Date(Date.now()+86400000).toISOString()]);
  seeded = true;
  await sourceClient.query(`INSERT INTO dealguard.enterprise_role_assignments(id,portal_id,user_id,role,created_at,updated_at)
    VALUES($1,$2,'7','administrator',$3,$3)`, [randomUUID(), portal, now]);
  await sourceClient.query("SELECT dealguard.set_intelligence_consent($1,'outcomes',true,0,'fixture-operator')", [portal]);
  await sourceClient.query("SELECT dealguard.set_intelligence_consent($1,'ai',true,0,'fixture-operator')", [portal]);
  await sourceClient.query("SELECT dealguard.set_breeze_settings($1,true,0,200,'fixture-operator')", [portal]);
  // Deliberately not a qualified model. Every synthetic forecast row is attached
  // to a suspended artifact without a reviewer or approval evidence digest.
  const fixtureEvidence = { synthetic: true, qualification: 'none', purpose: 'disposable-local-recovery-only' };
  for (const split of ['train','calibration','holdout']) {
    await sourceClient.query(`INSERT INTO dealguard.outcome_datasets(portal_id,id,consent_revision,fingerprint,manifest,samples)
      VALUES($1,$2,1,$3,$4::jsonb,'[]')`, [portal, 'fixture-'+split, digest(split), JSON.stringify({ ...fixtureEvidence, split })]);
  }
  await sourceClient.query(`INSERT INTO dealguard.outcome_evaluations(portal_id,id,consent_revision,train_id,calibration_id,holdout_id,report,parameters)
    VALUES($1,'fixture-evaluation',1,'fixture-train','fixture-calibration','fixture-holdout',$2::jsonb,'null')`,
    [portal, JSON.stringify({ ...fixtureEvidence, status: 'insufficient_evidence' })]);
  await sourceClient.query(`INSERT INTO dealguard.outcome_evaluation_jobs(portal_id,id,actor_id,consent_revision,train_id,calibration_id,holdout_id,state)
    VALUES($1,'fixture-queued-job','7',1,'fixture-train','fixture-calibration','fixture-holdout','queued')`, [portal]);
  await sourceClient.query(`INSERT INTO dealguard.forecast_controls(portal_id,enabled,revision,changed_by)
    VALUES($1,false,1,'fixture-operator')`, [portal]);
  await sourceClient.query(`INSERT INTO dealguard.forecast_models(portal_id,id,evaluation_id,pipeline_id,policy_id,consent_revision,
    artifact,artifact_fingerprint,state,requested_by,evaluation_requested_by,expires_at,suspension_reason)
    VALUES($1,'fixture-suspended-model','fixture-evaluation','fixture-pipeline','fixture-policy',1,$2::jsonb,$3,'suspended',
      'fixture-operator','fixture-evaluator',clock_timestamp()+INTERVAL '1 day','synthetic_recovery_only')`,
    [portal, JSON.stringify(fixtureEvidence), digest(JSON.stringify(fixtureEvidence))]);
  await sourceClient.query(`INSERT INTO dealguard.forecast_monitors(portal_id,model_id,quarter,status,report,expires_at)
    VALUES($1,'fixture-suspended-model','2000-Q1','unavailable',$2::jsonb,clock_timestamp()+INTERVAL '1 day')`,
    [portal, JSON.stringify(fixtureEvidence)]);
  await sourceClient.query(`INSERT INTO dealguard.forecast_predictions(portal_id,model_id,deal_id,quarter,anchor_at,horizon_at,
    evidence_at,source_fingerprint,probability,consent_revision)
    VALUES($1,'fixture-suspended-model','fixture-deal','2000-Q1','2000-01-01Z','2000-04-01Z',
      '2000-01-01T00:00:00.000Z',$2,0.5,1)`, [portal, digest('synthetic-prediction-not-a-customer-estimate')]);
  await sourceClient.query(`INSERT INTO dealguard.forecast_cache(portal_id,model_id,deal_id,quarter,source_fingerprint,
    controls_revision,consent_revision,probability,expires_at)
    VALUES($1,'fixture-suspended-model','fixture-deal','2000-Q1',$2,1,1,0.5,clock_timestamp()+INTERVAL '1 day')`,
    [portal, digest('synthetic-prediction-not-a-customer-estimate')]);
  await sourceClient.query(`INSERT INTO dealguard.forecast_outcome_reports(portal_id,model_id,quarter,report)
    VALUES($1,'fixture-suspended-model','2000-Q1',$2::jsonb)`, [portal, JSON.stringify({ ...fixtureEvidence, status: 'insufficient_evidence' })]);
  await sourceClient.query(`INSERT INTO dealguard.ai_daily_usage(portal_id,day,requests,reserved_micro,accounted_micro)
    VALUES($1,CURRENT_DATE,2,0,200)`, [portal]);
  const before = await schemaEvidence(sourceClient);
  const forecastTables = ['outcome_evaluation_jobs','forecast_controls','forecast_models','forecast_monitors','forecast_predictions','forecast_cache','forecast_outcome_reports'];
  for (const table of forecastTables) assert.equal(before[table]?.rows, 1, 'Expected a populated synthetic forecast relation: '+table);
  const dump = join(temp, 'source.sql');
  run(join(binaryDirectory, 'pg_dump'), ['--dbname', source.href, '--schema=dealguard', '--no-owner', '--no-acl', '--format=plain', '--file', dump]);
  const plainDigest = digest(await readFile(dump));
  const encrypted = join(temp, 'source.sql.enc');
  run('openssl', ['enc', '-aes-256-cbc', '-salt', '-pbkdf2', '-in', dump, '-out', encrypted, '-pass', 'env:DEALGUARD_REHEARSAL_PASSPHRASE']);
  const encryptedBytes = await readFile(encrypted), expectedDigest = digest(encryptedBytes);
  if (encryptedBytes.subarray(0,8).toString() !== 'Salted__') throw new Error('Unexpected backup encryption envelope.');
  const corrupted = Buffer.from(encryptedBytes); corrupted[corrupted.length-1] ^= 1;
  if (digest(corrupted) === expectedDigest) throw new Error('Modified backup was not rejected by its recorded checksum.');
  // Verify the exact encrypted bytes against their independently retained receipt before decryption.
  if (digest(await readFile(encrypted)) !== expectedDigest) throw new Error('Backup checksum mismatch.');
  const decrypted = join(temp, 'restored.sql');
  run('openssl', ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-in', encrypted, '-out', decrypted, '-pass', 'env:DEALGUARD_REHEARSAL_PASSPHRASE']);
  if (digest(await readFile(decrypted)) !== plainDigest) throw new Error('Decrypted backup differs from the source dump.');
  await sourceClient.query(`CREATE DATABASE ${destinationName}`); created = true;
  const restoreStarted = Date.now();
  run(join(binaryDirectory, 'psql'), ['--dbname', destination.href, '--no-psqlrc', '--quiet', '--set', 'ON_ERROR_STOP=1', '--file', decrypted]);
  await restoreClient.connect(); restoreConnected = true;
  const after = await schemaEvidence(restoreClient);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Restored table counts or content fingerprints differ.');
  const restoredConsent = await restoreClient.query("SELECT enabled FROM dealguard.intelligence_consents WHERE portal_id=$1 AND capability='ai'", [portal]);
  if (restoredConsent.rows[0]?.enabled !== true) throw new Error('Restored consent data is incorrect.');
  const restoredModel = (await restoreClient.query('SELECT state,reviewed_by,review_evidence_sha256,artifact FROM dealguard.forecast_models WHERE portal_id=$1', [portal])).rows[0];
  assert.equal(restoredModel.state, 'suspended'); assert.equal(restoredModel.reviewed_by, null);
  assert.equal(restoredModel.review_evidence_sha256, null); assert.equal(restoredModel.artifact.qualification, 'none');
  await restoreClient.query(`INSERT INTO dealguard.legal_holds(id,portal_id,name,reason,scope_json,status,created_at)
    VALUES('fixture-hold',$1,'Synthetic local hold','Exercise restored retention lifecycle','{}','active',$2)`, [portal, now]);
  const revoked = await restoreClient.query("SELECT dealguard.set_intelligence_consent($1,'outcomes',false,1,'fixture-operator') AS consent", [portal]);
  assert.equal(revoked.rows[0].consent?.enabled, false);
  const job = (await restoreClient.query('SELECT state,error_code FROM dealguard.outcome_evaluation_jobs WHERE portal_id=$1', [portal])).rows[0];
  assert.deepEqual(job, { state: 'cancelled', error_code: 'consent_changed' });
  const controls = (await restoreClient.query('SELECT enabled,revision FROM dealguard.forecast_controls WHERE portal_id=$1', [portal])).rows[0];
  assert.deepEqual(controls, { enabled: false, revision: 2 });
  for (const table of forecastTables) assert.equal(Number((await restoreClient.query(`SELECT COUNT(*) AS n FROM dealguard.${table} WHERE portal_id=$1`, [portal])).rows[0].n), 1);
  const readStats = { queries: 0, rows: 0, writeAttempts: 0, unexpectedTenantParameters: 0, unexpectedTenantRows: 0 };
  await restoreClient.query('SET default_transaction_read_only TO on');
  const heldStatus = await forecastStatus({ DB: readOnlyPortalAdapter(restoreClient, portal, [portal], readStats) },
    { portalId: portal, userId: '7', userEmail: null, appId: 'fixture' });
  assert.deepEqual(heldStatus.models, []); assert.deepEqual(heldStatus.outcomeReports, []); assert.equal(heldStatus.predictionsEnabled, false);
  await restoreClient.query('SET default_transaction_read_only TO off');
  await restoreClient.query("UPDATE dealguard.legal_holds SET status='released',released_at=$2 WHERE portal_id=$1", [portal, now]);
  await restoreClient.query("UPDATE dealguard.tenants SET status='disconnected' WHERE portal_id=$1", [portal]);
  if ((await restoreClient.query('SELECT enabled FROM dealguard.intelligence_consents WHERE portal_id=$1', [portal])).rows.some(r => r.enabled)) {
    throw new Error('Restored lifecycle triggers did not revoke consent.');
  }
  for (const table of ['outcome_datasets','outcome_evaluations',...forecastTables.filter(table => table!=='forecast_controls')]) {
    assert.equal(Number((await restoreClient.query(`SELECT COUNT(*) AS n FROM dealguard.${table} WHERE portal_id=$1`, [portal])).rows[0].n), 0,
      'Released non-held forecast evidence did not cascade on deactivation: '+table);
  }
  const breeze = (await restoreClient.query('SELECT enabled FROM dealguard.breeze_settings WHERE portal_id=$1', [portal])).rows[0];
  assert.equal(breeze?.enabled, false);
  const receipt = {
    schema: 'dealguard-disposable-recovery-v2', observedAt: new Date().toISOString(), status: 'passed',
    providerRecoveryVerified: false, productionRpoVerified: false, productionRtoVerified: false, objectStoreRecoveryVerified: false,
    scope: 'Only a synthetic fixture seeded into an initially empty localhost PostgreSQL database; no customer/provider database or object store.',
    dumpFormat: 'plain SQL', encryption: 'aes-256-cbc-pbkdf2', checksum: 'sha256', encryptedSha256: expectedDigest,
    plaintextSha256: plainDigest, tablesVerified: Object.keys(before).length, tableFingerprints: before,
    restoredLifecycleTriggerVerified: true, modifiedBackupRejectedBeforeDecrypt: true,
    syntheticForecastFixture: true, forecastQualificationVerified: false, forecastApprovalCreated: false,
    populatedForecastTables: forecastTables, heldForecastRowsRetained: true, heldForecastDisclosureBlocked: true,
    restoredQueuedEvaluationCancelled: true, releasedForecastCascadeVerified: true,
    dumpBytes: (await readFile(dump)).length, encryptedBytes: encryptedBytes.length,
    restoreAndVerificationMilliseconds: Date.now()-restoreStarted, totalMilliseconds: Date.now()-started,
    postgresVersion: run(join(binaryDirectory,'pg_dump'),['--version']).toString().trim(), nodeVersion: process.version,
  };
  const report = resolve(process.env.DEALGUARD_RECOVERY_REPORT ?? '/tmp/dealguard-local-recovery.json');
  await writeFile(report, JSON.stringify(receipt,null,2)+'\n', {mode:0o600});
  console.log(JSON.stringify({status:receipt.status,tablesVerified:receipt.tablesVerified,totalMilliseconds:receipt.totalMilliseconds,
    restoredLifecycleTriggerVerified:true,productionRecoveryVerified:false,report},null,2));
} finally {
  if (restoreConnected) await restoreClient.end();
  if (created) await sourceClient.query(`DROP DATABASE ${destinationName}`).catch(() => undefined);
  if (seeded) await sourceClient.query('DELETE FROM dealguard.tenants WHERE portal_id=$1', [portal]).catch(() => undefined);
  await sourceClient.end().catch(() => undefined);
  passphrase.fill(0); delete childEnvironment.DEALGUARD_REHEARSAL_PASSPHRASE;
  await rm(temp, { recursive: true, force: true });
}
