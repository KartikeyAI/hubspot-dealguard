import process from 'node:process';
import pg from 'pg';

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL ?? process.env.NEON_DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL or NEON_DATABASE_URL is required.');

const client = new Client({
  connectionString: databaseUrl,
  application_name: 'dealguard-recommendation-operations-validation',
});
await client.connect();
try {
  const migrations = await client.query(
    `SELECT MAX(version)::int AS version, COUNT(*)::int AS count
     FROM dealguard.schema_migrations`,
  );
  const tables = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM information_schema.tables
     WHERE table_schema = 'dealguard'
       AND table_type = 'BASE TABLE'
       AND table_name IN (
         'recommendation_follow_up_batches',
         'recommendation_follow_up_items',
         'recommendation_follow_up_deliveries',
         'recommendation_evidence_exports',
         'recommendation_evidence_export_items'
       )`,
  );
  const columns = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM information_schema.columns
     WHERE table_schema = 'dealguard'
       AND (table_name, column_name) IN (
         ('recommendation_follow_up_batches', 'portal_id'),
         ('recommendation_follow_up_batches', 'status'),
         ('recommendation_follow_up_batches', 'confirmation_token_hash'),
         ('recommendation_follow_up_batches', 'payload_cipher'),
         ('recommendation_follow_up_batches', 'payload_iv'),
         ('recommendation_follow_up_batches', 'recipient_count'),
         ('recommendation_follow_up_batches', 'expires_at'),
         ('recommendation_follow_up_batches', 'created_by_user_id'),
         ('recommendation_follow_up_items', 'batch_id'),
         ('recommendation_follow_up_items', 'recommendation_id'),
         ('recommendation_follow_up_items', 'deal_id'),
         ('recommendation_follow_up_items', 'item_status'),
         ('recommendation_follow_up_items', 'skip_reason'),
         ('recommendation_follow_up_items', 'recommendation_text'),
         ('recommendation_follow_up_deliveries', 'batch_id'),
         ('recommendation_follow_up_deliveries', 'recipient_hash'),
         ('recommendation_follow_up_deliveries', 'status'),
         ('recommendation_follow_up_deliveries', 'provider_message_id'),
         ('recommendation_follow_up_deliveries', 'error_code'),
         ('recommendation_evidence_exports', 'portal_id'),
         ('recommendation_evidence_exports', 'status'),
         ('recommendation_evidence_exports', 'token_hash'),
         ('recommendation_evidence_exports', 'row_count'),
         ('recommendation_evidence_exports', 'content_sha256'),
         ('recommendation_evidence_exports', 'expires_at'),
         ('recommendation_evidence_exports', 'downloaded_at'),
         ('recommendation_evidence_export_items', 'export_id'),
         ('recommendation_evidence_export_items', 'recommendation_id'),
         ('recommendation_evidence_export_items', 'ordinal'),
         ('recommendation_evidence_export_items', 'evidence_json'),
         ('recommendation_evidence_export_items', 'portal_id')
       )`,
  );
  const indexes = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM pg_indexes
     WHERE schemaname = 'dealguard'
       AND indexname IN (
         'idx_recommendation_follow_up_batches_creator',
         'idx_recommendation_follow_up_batches_status',
         'idx_recommendation_follow_up_items_batch',
         'idx_recommendation_follow_up_items_recommendation',
         'idx_recommendation_follow_up_deliveries_batch',
         'idx_recommendation_follow_up_deliveries_status',
         'idx_recommendation_evidence_exports_expiry',
         'idx_recommendation_evidence_exports_creator',
         'idx_recommendation_evidence_export_items_portal',
         'idx_recommendation_evidence_export_items_recommendation'
       )`,
  );
  const foreignKeys = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM information_schema.table_constraints
     WHERE constraint_schema = 'dealguard'
       AND constraint_type = 'FOREIGN KEY'
       AND table_name IN (
         'recommendation_follow_up_batches',
         'recommendation_follow_up_items',
         'recommendation_follow_up_deliveries',
         'recommendation_evidence_exports',
         'recommendation_evidence_export_items'
       )`,
  );
  const trigger = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM information_schema.triggers
     WHERE trigger_schema = 'dealguard'
       AND event_object_table = 'recommendation_follow_up_deliveries'
       AND trigger_name = 'trg_hash_recommendation_follow_up_recipient'`,
  );
  const result = {
    migrationVersion: Number(migrations.rows[0]?.version ?? 0),
    migrationCount: Number(migrations.rows[0]?.count ?? 0),
    operationsTableCount: Number(tables.rows[0]?.count ?? 0),
    operationsRequiredColumnCount: Number(columns.rows[0]?.count ?? 0),
    operationsIndexCount: Number(indexes.rows[0]?.count ?? 0),
    operationsForeignKeyCount: Number(foreignKeys.rows[0]?.count ?? 0),
    recipientHashTriggerCount: Number(trigger.rows[0]?.count ?? 0),
  };
  if (result.migrationVersion < 20 || result.migrationCount < 20) {
    throw new Error(`Expected migrations through 0020, got ${JSON.stringify(result)}.`);
  }
  if (result.operationsTableCount !== 5) {
    throw new Error(`Expected five recommendation operations tables, got ${result.operationsTableCount}.`);
  }
  if (result.operationsRequiredColumnCount !== 31) {
    throw new Error(`Expected 31 required recommendation operations columns, got ${result.operationsRequiredColumnCount}.`);
  }
  if (result.operationsIndexCount !== 10) {
    throw new Error(`Expected ten recommendation operations indexes, got ${result.operationsIndexCount}.`);
  }
  if (result.operationsForeignKeyCount !== 10) {
    throw new Error(`Expected ten recommendation operations foreign keys, got ${result.operationsForeignKeyCount}.`);
  }
  if (result.recipientHashTriggerCount !== 1) {
    throw new Error('Expected the recommendation follow-up recipient hashing trigger.');
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  await client.end();
}
