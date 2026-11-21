import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL ?? process.env.NEON_DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL or NEON_DATABASE_URL is required.');
const client = new pg.Client({ connectionString: databaseUrl, application_name: 'dealguard-v3-validation' });
const tables = ['intelligence_consents', 'outcome_datasets', 'outcome_evaluations',
  'ai_limits', 'ai_daily_usage', 'ai_runs', 'breeze_settings', 'breeze_daily_usage', 'breeze_invocations',
  'outcome_evaluation_jobs', 'forecast_controls', 'forecast_models', 'forecast_monitors',
  'forecast_predictions', 'forecast_cache', 'forecast_outcome_reports'];
const requiredColumns = {
  tenants: ['authorization_epoch_at', 'deletion_requested_at', 'deletion_source_epoch', 'deletion_attempts', 'deletion_next_attempt_at', 'deletion_lease_token', 'deletion_lease_expires_at', 'deletion_last_error'],
  change_approval_requests: ['target_state_json'],
  change_approval_executions: ['lease_token'],
  ai_runs: ['handoff_cycle', 'handoff_version', 'consent_revision', 'response_cipher', 'response_iv', 'accounted_micro'],
  remediation_cases: ['task_delivery_state', 'task_delivery_token', 'task_delivery_error', 'task_started_at'],
  forecast_models: ['artifact_fingerprint', 'reviewed_by', 'review_evidence_sha256', 'expires_at', 'consent_revision'],
  outcome_evaluation_jobs: ['lease_token', 'lease_expires_at', 'attempts', 'result_artifact', 'result_fingerprint'],
};
const triggers = ['immutable_outcome_dataset', 'immutable_outcome_evaluation', 'immutable_forecast_prediction',
  'immutable_forecast_outcome_report', 'immutable_forecast_artifact', 'invalidate_forecasts',
  'revoke_ai_content', 'revoke_intelligence_on_deactivation', 'tenant_authorization_epoch'];
const functions = { reserve_ai_run_v3: 14, finish_ai_run: 7, create_remediation_work: 7,
  escalate_remediation_work: 5, claim_remediation_task: 5, finish_remediation_task: 4,
  enqueue_outcome_evaluation: 7, finish_outcome_evaluation: 8, review_forecast_model: 7,
  store_forecast_prediction: 12, mutate_enterprise_role: 6, list_enterprise_roles: 3,
  enterprise_role_manager_state: 3, lock_oauth_install_authorization: 2,
  request_portal_deletion: 3, claim_portal_deletion: 2, portal_deletion_guard: 3,
  defer_portal_deletion: 4, portal_deletion_held: 1, finalize_portal_deletion: 3,
  enterprise_role_bootstrap_status: 3, mutate_enterprise_role_bootstrap: 5,
  controlled_change_actor: 5, controlled_role_target: 4, request_controlled_change: 9,
  decide_controlled_change: 6, claim_controlled_change: 9, finish_controlled_change: 7,
  apply_approved_enterprise_role: 9, normalize_controlled_role_assignment: 1 };

await client.connect();
try {
  const files = (await readdir(new URL('../database/migrations/', import.meta.url))).filter(f => /^\d{4}_.+\.sql$/.test(f));
  const expectedVersion = Math.max(...files.map(f => Number(f.slice(0, 4))));
  const migrations = (await client.query('SELECT MAX(version)::int version, COUNT(*)::int count FROM dealguard.schema_migrations')).rows[0];
  assert.equal(migrations.version, expectedVersion, 'Database must include the current release migrations.');
  assert.equal(migrations.count, files.length, 'Every release migration must be recorded.');
  const present = (await client.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema='dealguard' AND table_type='BASE TABLE' AND table_name=ANY($1::text[])`, [tables])).rows.map(r => r.table_name);
  assert.deepEqual(present.sort(), [...tables].sort(), 'All optional-intelligence tables must exist.');
  const primaryKeys = (await client.query(`SELECT r.relname table_name, a.attname first_column
    FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
    JOIN pg_attribute a ON a.attrelid=r.oid AND a.attnum=c.conkey[1]
    WHERE n.nspname='dealguard' AND c.contype='p' AND r.relname=ANY($1::text[])`, [tables])).rows;
  assert.equal(primaryKeys.length, tables.length, 'Every intelligence table must have a primary key.');
  assert(primaryKeys.every(r => r.first_column === 'portal_id'), 'Intelligence identities must include their portal first.');
  const foreignKeys = (await client.query(`SELECT r.relname table_name, a.attname local_column, b.attname referenced_column, c.confdeltype
    FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
    JOIN pg_attribute b ON b.attrelid=c.confrelid AND b.attnum=c.confkey[1]
    WHERE n.nspname='dealguard' AND c.contype='f' AND r.relname=ANY($1::text[])`, [tables])).rows;
  assert(foreignKeys.length >= tables.length, 'Intelligence tables must be bound to tenant-owned records.');
  assert(foreignKeys.every(r => r.local_column === 'portal_id' && r.referenced_column === 'portal_id' && r.confdeltype === 'c'),
    'Intelligence foreign keys must preserve portal identity and cascade deleted tenant evidence.');
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const result = await client.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='dealguard' AND table_name=$1 AND column_name=ANY($2::text[])`, [table, columns]);
    assert.equal(result.rows.length, columns.length, `${table} is missing release-critical lifecycle fields.`);
  }
  const actualTriggers = (await client.query(`SELECT t.tgname FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname='dealguard' AND NOT t.tgisinternal
    AND t.tgenabled='O' AND t.tgname=ANY($1::text[])`, [triggers])).rows.map(r => r.tgname);
  assert.deepEqual(actualTriggers.sort(), [...triggers].sort(), 'Immutability and consent-revocation triggers must be enabled.');
  for (const [name, argumentCount] of Object.entries(functions)) {
    const result = await client.query(`SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='dealguard' AND p.proname=$1 AND p.pronargs=$2`, [name, argumentCount]);
    assert.equal(result.rows.length, 1, `Missing atomic operation ${name}.`);
    assert.equal(result.rows[0].prosecdef, false, `${name} must not elevate the database caller.`);
  }
  const binding = await client.query(`SELECT 1 FROM pg_constraint c WHERE c.conrelid='dealguard.ai_runs'::regclass
    AND c.conname='ai_handoff_binding' AND c.contype='c' AND c.convalidated`);
  assert.equal(binding.rowCount, 1, 'AI handover cycle and revision must be bound together.');
  const unique = await client.query(`SELECT 1 FROM pg_index i JOIN pg_class r ON r.oid=i.indexrelid
    JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname='dealguard' AND r.relname='idx_forecast_active_cohort'
    AND i.indisunique AND i.indisvalid AND i.indpred IS NOT NULL`);
  assert.equal(unique.rowCount, 1, 'Only one active forecast may serve a portal/pipeline/policy cohort.');
  console.log(JSON.stringify({ migrationVersion: expectedVersion, intelligenceTables: tables.length,
    tenantBoundForeignKeys: foreignKeys.length, lifecycleTriggers: triggers.length,
    atomicOperations: Object.keys(functions).length, handoverBinding: true, uniqueActiveForecast: true }, null, 2));
} finally { await client.end(); }
