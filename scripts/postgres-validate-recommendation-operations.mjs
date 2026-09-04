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
         'recommendation_followup_batches',
         'recommendation_followup_items',
         'recommendation_routing_policies',
         'recommendation_policy_dispatches'
       )`,
  );
  const columns = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM information_schema.columns
     WHERE table_schema = 'dealguard'
       AND (table_name, column_name) IN (
         ('recommendation_followup_batches', 'portal_id'),
         ('recommendation_followup_batches', 'kind'),
         ('recommendation_followup_batches', 'severity'),
         ('recommendation_followup_batches', 'manager_note'),
         ('recommendation_followup_batches', 'authorization_mode'),
         ('recommendation_followup_batches', 'automation_policy_id'),
         ('recommendation_followup_batches', 'status'),
         ('recommendation_followup_batches', 'requested_count'),
         ('recommendation_followup_batches', 'eligible_count'),
         ('recommendation_followup_batches', 'delivery_ready_count'),
         ('recommendation_followup_batches', 'confirmed_count'),
         ('recommendation_followup_batches', 'delivered_count'),
         ('recommendation_followup_batches', 'failed_count'),
         ('recommendation_followup_batches', 'routing_summary_json'),
         ('recommendation_followup_batches', 'preview_expires_at'),
         ('recommendation_followup_batches', 'created_by_user_id'),
         ('recommendation_followup_batches', 'created_by_email'),
         ('recommendation_followup_batches', 'confirmed_by_user_id'),
         ('recommendation_followup_batches', 'confirmed_by_email'),
         ('recommendation_followup_batches', 'confirmed_at'),
         ('recommendation_followup_batches', 'completed_at'),
         ('recommendation_followup_batches', 'created_at'),
         ('recommendation_followup_batches', 'updated_at'),
         ('recommendation_followup_items', 'portal_id'),
         ('recommendation_followup_items', 'batch_id'),
         ('recommendation_followup_items', 'recommendation_id'),
         ('recommendation_followup_items', 'policy_dispatch_id'),
         ('recommendation_followup_items', 'deal_id'),
         ('recommendation_followup_items', 'recommendation_code'),
         ('recommendation_followup_items', 'recommendation_label'),
         ('recommendation_followup_items', 'recommendation_text'),
         ('recommendation_followup_items', 'recommendation_status'),
         ('recommendation_followup_items', 'priority'),
         ('recommendation_followup_items', 'due_at'),
         ('recommendation_followup_items', 'pipeline_id'),
         ('recommendation_followup_items', 'team_id'),
         ('recommendation_followup_items', 'owner_id'),
         ('recommendation_followup_items', 'region_code'),
         ('recommendation_followup_items', 'matched_route_ids_json'),
         ('recommendation_followup_items', 'matched_channel_ids_json'),
         ('recommendation_followup_items', 'routing_fingerprint'),
         ('recommendation_followup_items', 'status'),
         ('recommendation_followup_items', 'ineligibility_reason'),
         ('recommendation_followup_items', 'delivery_summary_json'),
         ('recommendation_followup_items', 'last_error'),
         ('recommendation_followup_items', 'created_at'),
         ('recommendation_followup_items', 'updated_at'),
         ('recommendation_routing_policies', 'portal_id'),
         ('recommendation_routing_policies', 'name'),
         ('recommendation_routing_policies', 'trigger_kind'),
         ('recommendation_routing_policies', 'status_scope'),
         ('recommendation_routing_policies', 'minimum_priority'),
         ('recommendation_routing_policies', 'threshold_minutes'),
         ('recommendation_routing_policies', 'cooldown_minutes'),
         ('recommendation_routing_policies', 'max_notifications'),
         ('recommendation_routing_policies', 'severity'),
         ('recommendation_routing_policies', 'route_id'),
         ('recommendation_routing_policies', 'escalation_route_id'),
         ('recommendation_routing_policies', 'escalation_after_minutes'),
         ('recommendation_routing_policies', 'manager_note'),
         ('recommendation_routing_policies', 'pipeline_ids_json'),
         ('recommendation_routing_policies', 'team_ids_json'),
         ('recommendation_routing_policies', 'owner_ids_json'),
         ('recommendation_routing_policies', 'region_codes_json'),
         ('recommendation_routing_policies', 'enabled'),
         ('recommendation_routing_policies', 'created_by_user_id'),
         ('recommendation_routing_policies', 'updated_by_user_id'),
         ('recommendation_routing_policies', 'created_at'),
         ('recommendation_routing_policies', 'updated_at'),
         ('recommendation_routing_policies', 'last_evaluated_at'),
         ('recommendation_routing_policies', 'last_match_count'),
         ('recommendation_routing_policies', 'last_queue_count'),
         ('recommendation_routing_policies', 'last_error'),
         ('recommendation_policy_dispatches', 'portal_id'),
         ('recommendation_policy_dispatches', 'policy_id'),
         ('recommendation_policy_dispatches', 'recommendation_id'),
         ('recommendation_policy_dispatches', 'state'),
         ('recommendation_policy_dispatches', 'first_matched_at'),
         ('recommendation_policy_dispatches', 'first_queued_at'),
         ('recommendation_policy_dispatches', 'last_queued_at'),
         ('recommendation_policy_dispatches', 'next_eligible_at'),
         ('recommendation_policy_dispatches', 'notification_count'),
         ('recommendation_policy_dispatches', 'escalation_count'),
         ('recommendation_policy_dispatches', 'escalated_at'),
         ('recommendation_policy_dispatches', 'last_batch_id'),
         ('recommendation_policy_dispatches', 'last_delivery_status'),
         ('recommendation_policy_dispatches', 'resolved_at'),
         ('recommendation_policy_dispatches', 'last_error'),
         ('recommendation_policy_dispatches', 'created_at'),
         ('recommendation_policy_dispatches', 'updated_at')
       )`,
  );
  const indexes = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM pg_indexes
     WHERE schemaname = 'dealguard'
       AND indexname IN (
         'idx_recommendation_followup_batches_status',
         'idx_recommendation_followup_items_delivery',
         'idx_recommendation_followup_items_recommendation',
         'idx_recommendation_routing_policies_schedule',
         'idx_recommendation_routing_policies_route',
         'idx_recommendation_policy_dispatches_due',
         'idx_recommendation_policy_dispatches_recommendation',
         'idx_recommendation_policy_dispatches_delivery',
         'idx_recommendation_followup_batches_policy',
         'idx_recommendation_followup_items_dispatch'
       )`,
  );
  const foreignKeys = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM information_schema.table_constraints
     WHERE constraint_schema = 'dealguard'
       AND constraint_type = 'FOREIGN KEY'
       AND table_name IN (
         'recommendation_followup_batches',
         'recommendation_followup_items',
         'recommendation_routing_policies',
         'recommendation_policy_dispatches'
       )`,
  );
  const semanticChecks = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM pg_constraint constraint_info
     JOIN pg_class relation ON relation.oid = constraint_info.conrelid
     JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'dealguard'
       AND constraint_info.contype = 'c'
       AND (
         (relation.relname = 'secure_download_tokens' AND pg_get_constraintdef(constraint_info.oid) LIKE '%recommendation_evidence%')
         OR (relation.relname = 'recommendation_events' AND pg_get_constraintdef(constraint_info.oid) LIKE '%followup_requested%')
         OR (relation.relname = 'recommendation_followup_batches' AND pg_get_constraintdef(constraint_info.oid) LIKE '%configured_policy%')
       )`,
  );
  const result = {
    migrationVersion: Number(migrations.rows[0]?.version ?? 0),
    migrationCount: Number(migrations.rows[0]?.count ?? 0),
    operationsTableCount: Number(tables.rows[0]?.count ?? 0),
    operationsRequiredColumnCount: Number(columns.rows[0]?.count ?? 0),
    operationsIndexCount: Number(indexes.rows[0]?.count ?? 0),
    operationsForeignKeyCount: Number(foreignKeys.rows[0]?.count ?? 0),
    operationsSemanticCheckCount: Number(semanticChecks.rows[0]?.count ?? 0),
  };
  if (result.migrationVersion < 20 || result.migrationCount < 20) {
    throw new Error(`Expected migrations through 0020, got ${JSON.stringify(result)}.`);
  }
  if (result.operationsTableCount !== 4) {
    throw new Error(`Expected four recommendation operations tables, got ${result.operationsTableCount}.`);
  }
  if (result.operationsRequiredColumnCount !== 90) {
    throw new Error(`Expected 90 required recommendation operations columns, got ${result.operationsRequiredColumnCount}.`);
  }
  if (result.operationsIndexCount !== 10) {
    throw new Error(`Expected ten recommendation operations indexes, got ${result.operationsIndexCount}.`);
  }
  if (result.operationsForeignKeyCount !== 12) {
    throw new Error(`Expected twelve tenant-safe recommendation operations foreign keys, got ${result.operationsForeignKeyCount}.`);
  }
  if (result.operationsSemanticCheckCount !== 3) {
    throw new Error(`Expected three recommendation operations semantic constraints, got ${result.operationsSemanticCheckCount}.`);
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  await client.end();
}
