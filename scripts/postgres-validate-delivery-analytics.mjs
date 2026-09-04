import process from 'node:process';
import pg from 'pg';

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL ?? process.env.NEON_DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL or NEON_DATABASE_URL is required.');

const client = new Client({
  connectionString: databaseUrl,
  application_name: 'dealguard-recommendation-delivery-analytics-validation',
});
await client.connect();
try {
  const migrations = await client.query(
    `SELECT MAX(version)::int AS version, COUNT(*)::int AS count
     FROM dealguard.schema_migrations`,
  );
  const table = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM information_schema.tables
     WHERE table_schema = 'dealguard'
       AND table_name = 'recommendation_delivery_events'
       AND table_type = 'BASE TABLE'`,
  );
  const columns = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM information_schema.columns
     WHERE table_schema = 'dealguard'
       AND table_name = 'recommendation_delivery_events'
       AND column_name IN (
         'id', 'portal_id', 'event_type', 'authorization_mode',
         'policy_id', 'dispatch_id', 'batch_id', 'recommendation_id',
         'route_id', 'stage', 'reason_code', 'severity',
         'event_at', 'recommendation_due_at', 'sla_due_at',
         'pipeline_id', 'team_id', 'owner_id', 'region_code',
         'dedupe_key', 'metadata_json', 'created_at'
       )`,
  );
  const indexes = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM pg_indexes
     WHERE schemaname = 'dealguard'
       AND tablename = 'recommendation_delivery_events'
       AND indexname IN (
         'idx_recommendation_delivery_events_time',
         'idx_recommendation_delivery_events_policy',
         'idx_recommendation_delivery_events_route',
         'idx_recommendation_delivery_events_dispatch',
         'idx_recommendation_delivery_events_recommendation',
         'idx_recommendation_delivery_events_scope'
       )`,
  );
  const foreignKeys = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM information_schema.table_constraints
     WHERE constraint_schema = 'dealguard'
       AND table_name = 'recommendation_delivery_events'
       AND constraint_type = 'FOREIGN KEY'`,
  );
  const checks = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM information_schema.table_constraints
     WHERE constraint_schema = 'dealguard'
       AND table_name = 'recommendation_delivery_events'
       AND constraint_type = 'CHECK'`,
  );
  const uniqueConstraints = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM information_schema.table_constraints
     WHERE constraint_schema = 'dealguard'
       AND table_name = 'recommendation_delivery_events'
       AND constraint_type = 'UNIQUE'`,
  );
  const result = {
    migrationVersion: Number(migrations.rows[0]?.version ?? 0),
    migrationCount: Number(migrations.rows[0]?.count ?? 0),
    deliveryAnalyticsTableCount: Number(table.rows[0]?.count ?? 0),
    deliveryAnalyticsColumnCount: Number(columns.rows[0]?.count ?? 0),
    deliveryAnalyticsIndexCount: Number(indexes.rows[0]?.count ?? 0),
    deliveryAnalyticsForeignKeyCount: Number(foreignKeys.rows[0]?.count ?? 0),
    deliveryAnalyticsCheckCount: Number(checks.rows[0]?.count ?? 0),
    deliveryAnalyticsUniqueConstraintCount: Number(uniqueConstraints.rows[0]?.count ?? 0),
  };
  if (result.migrationVersion < 21 || result.migrationCount < 21) {
    throw new Error(`Expected migrations through 0021, got ${JSON.stringify(result)}.`);
  }
  if (result.deliveryAnalyticsTableCount !== 1) {
    throw new Error(`Expected recommendation_delivery_events, got ${result.deliveryAnalyticsTableCount}.`);
  }
  if (result.deliveryAnalyticsColumnCount !== 22) {
    throw new Error(`Expected 22 delivery analytics columns, got ${result.deliveryAnalyticsColumnCount}.`);
  }
  if (result.deliveryAnalyticsIndexCount !== 6) {
    throw new Error(`Expected six delivery analytics indexes, got ${result.deliveryAnalyticsIndexCount}.`);
  }
  if (result.deliveryAnalyticsForeignKeyCount !== 1) {
    throw new Error(`Expected one tenant foreign key, got ${result.deliveryAnalyticsForeignKeyCount}.`);
  }
  if (result.deliveryAnalyticsCheckCount < 4) {
    throw new Error(`Expected at least four delivery analytics check constraints, got ${result.deliveryAnalyticsCheckCount}.`);
  }
  if (result.deliveryAnalyticsUniqueConstraintCount !== 2) {
    throw new Error(`Expected two delivery analytics unique constraints, got ${result.deliveryAnalyticsUniqueConstraintCount}.`);
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  await client.end();
}
