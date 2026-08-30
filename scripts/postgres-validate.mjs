import process from 'node:process';
import pg from 'pg';

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL ?? process.env.NEON_DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL or NEON_DATABASE_URL is required.');
const client = new Client({ connectionString: databaseUrl, application_name: 'dealguard-schema-validation' });
await client.connect();
try {
  const migrations = await client.query(`SELECT MAX(version)::int AS version, COUNT(*)::int AS count FROM dealguard.schema_migrations`);
  const tables = await client.query(`SELECT COUNT(*)::int AS count FROM information_schema.tables WHERE table_schema = 'dealguard' AND table_type = 'BASE TABLE'`);
  const constraints = await client.query(`SELECT COUNT(*)::int AS count FROM information_schema.table_constraints WHERE constraint_schema = 'dealguard' AND constraint_type = 'FOREIGN KEY'`);
  const tenantIndexes = await client.query(`SELECT COUNT(*)::int AS count FROM pg_indexes WHERE schemaname = 'dealguard' AND indexdef ILIKE '%(portal_id%'`);
  const currencyColumns = await client.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'dealguard'
      AND table_name = 'assessment_history'
      AND column_name IN ('deal_currency_code', 'deal_amount_in_company_currency')
    ORDER BY column_name
  `);
  const decisionColumns = await client.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'dealguard'
      AND table_name = 'deal_decision_snapshots'
      AND column_name IN (
        'portal_id', 'deal_id', 'assessment_at', 'generated_at', 'brief_status',
        'attention_score', 'coverage_percent', 'next_action_due_at',
        'risk_summary_json', 'dimensions_json'
      )
    ORDER BY column_name
  `);
  const decisionIndexes = await client.query(`
    SELECT COUNT(*)::int AS count
    FROM pg_indexes
    WHERE schemaname = 'dealguard'
      AND tablename = 'deal_decision_snapshots'
      AND indexname IN ('idx_deal_decision_snapshots_queue', 'idx_deal_decision_snapshots_freshness')
  `);
  const executiveColumns = await client.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'dealguard'
      AND table_name = 'executive_revenue_snapshots'
      AND column_name IN (
        'portal_id', 'snapshot_date', 'deal_id', 'captured_at',
        'amount', 'currency_code', 'amount_in_company_currency',
        'close_date', 'forecast_category', 'readiness_score',
        'decision_status', 'decision_attention_score'
      )
    ORDER BY column_name
  `);
  const executiveIndexes = await client.query(`
    SELECT COUNT(*)::int AS count
    FROM pg_indexes
    WHERE schemaname = 'dealguard'
      AND tablename = 'executive_revenue_snapshots'
      AND indexname IN (
        'idx_executive_revenue_snapshots_period',
        'idx_executive_revenue_snapshots_movement',
        'idx_executive_revenue_snapshots_concentration'
      )
  `);
  const recommendationColumns = await client.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'dealguard'
      AND (
        (table_name = 'recommendation_instances' AND column_name IN (
          'portal_id', 'deal_id', 'recommendation_fingerprint', 'recommendation_code',
          'status', 'due_at', 'accepted_at', 'completed_at', 'dismissed_at',
          'baseline_assessment_at', 'baseline_readiness_score', 'baseline_stage_id',
          'baseline_attention_score', 'baseline_dimensions_json'
        ))
        OR (table_name = 'recommendation_events' AND column_name IN (
          'portal_id', 'recommendation_id', 'deal_id', 'event_type', 'metadata_json', 'occurred_at'
        ))
        OR (table_name = 'recommendation_outcomes' AND column_name IN (
          'recommendation_id', 'portal_id', 'deal_id', 'evaluation_status', 'observed_progress',
          'observation_generated_at', 'readiness_delta', 'attention_delta', 'dimension_deltas_json',
          'recommendation_still_current', 'explanation', 'causal_attribution'
        ))
      )
    ORDER BY table_name, column_name
  `);
  const recommendationIndexes = await client.query(`
    SELECT COUNT(*)::int AS count
    FROM pg_indexes
    WHERE schemaname = 'dealguard'
      AND indexname IN (
        'idx_recommendation_instances_queue',
        'idx_recommendation_instances_analytics',
        'idx_recommendation_instances_completed',
        'idx_recommendation_events_portal_time',
        'idx_recommendation_events_instance',
        'idx_recommendation_outcomes_portal_progress',
        'idx_recommendation_outcomes_deal'
      )
  `);
  const result = {
    migrationVersion: Number(migrations.rows[0]?.version ?? 0),
    migrationCount: Number(migrations.rows[0]?.count ?? 0),
    tableCount: Number(tables.rows[0]?.count ?? 0),
    foreignKeyCount: Number(constraints.rows[0]?.count ?? 0),
    tenantLeadingIndexCount: Number(tenantIndexes.rows[0]?.count ?? 0),
    trustworthyCurrencyColumnCount: currencyColumns.rowCount ?? 0,
    decisionSnapshotColumnCount: decisionColumns.rowCount ?? 0,
    decisionSnapshotIndexCount: Number(decisionIndexes.rows[0]?.count ?? 0),
    executiveSnapshotColumnCount: executiveColumns.rowCount ?? 0,
    executiveSnapshotIndexCount: Number(executiveIndexes.rows[0]?.count ?? 0),
    recommendationOutcomeColumnCount: recommendationColumns.rowCount ?? 0,
    recommendationOutcomeIndexCount: Number(recommendationIndexes.rows[0]?.count ?? 0),
  };
  if (result.migrationVersion < 18 || result.migrationCount < 18) throw new Error(`Expected migrations through 0018, got ${JSON.stringify(result)}.`);
  if (result.tableCount < 75) throw new Error(`Expected at least 75 DealGuard tables, got ${result.tableCount}.`);
  if (result.foreignKeyCount < 62) throw new Error(`Expected tenant and relationship foreign keys, got ${result.foreignKeyCount}.`);
  if (result.tenantLeadingIndexCount < 40) throw new Error(`Expected tenant-leading indexes, got ${result.tenantLeadingIndexCount}.`);
  if (result.trustworthyCurrencyColumnCount !== 2) throw new Error(`Expected trustworthy currency columns on assessment_history, got ${result.trustworthyCurrencyColumnCount}.`);
  if (result.decisionSnapshotColumnCount !== 10) throw new Error(`Expected manager decision snapshot columns, got ${result.decisionSnapshotColumnCount}.`);
  if (result.decisionSnapshotIndexCount !== 2) throw new Error(`Expected manager decision queue indexes, got ${result.decisionSnapshotIndexCount}.`);
  if (result.executiveSnapshotColumnCount !== 12) throw new Error(`Expected executive revenue snapshot columns, got ${result.executiveSnapshotColumnCount}.`);
  if (result.executiveSnapshotIndexCount !== 3) throw new Error(`Expected executive revenue indexes, got ${result.executiveSnapshotIndexCount}.`);
  if (result.recommendationOutcomeColumnCount !== 32) throw new Error(`Expected recommendation outcome columns, got ${result.recommendationOutcomeColumnCount}.`);
  if (result.recommendationOutcomeIndexCount !== 7) throw new Error(`Expected recommendation outcome indexes, got ${result.recommendationOutcomeIndexCount}.`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await client.end();
}
