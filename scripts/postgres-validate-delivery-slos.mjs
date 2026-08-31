import process from 'node:process';
import pg from 'pg';

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL ?? process.env.NEON_DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL or NEON_DATABASE_URL is required.');

const client = new Client({
  connectionString: databaseUrl,
  application_name: 'dealguard-delivery-slo-validation',
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
         'recommendation_delivery_slo_policies',
         'recommendation_delivery_slo_states',
         'recommendation_delivery_slo_incidents',
         'recommendation_delivery_slo_notifications'
       )`,
  );
  const columns = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM information_schema.columns
     WHERE table_schema = 'dealguard'
       AND table_name IN (
         'recommendation_delivery_slo_policies',
         'recommendation_delivery_slo_states',
         'recommendation_delivery_slo_incidents',
         'recommendation_delivery_slo_notifications'
       )`,
  );
  const indexes = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM pg_indexes
     WHERE schemaname = 'dealguard'
       AND indexname IN (
         'idx_recommendation_delivery_slo_policies_schedule',
         'idx_recommendation_delivery_slo_policies_target',
         'idx_recommendation_delivery_slo_states_status',
         'idx_recommendation_delivery_slo_incidents_status',
         'idx_recommendation_delivery_slo_incidents_policy',
         'idx_recommendation_delivery_slo_notifications_queue',
         'idx_recommendation_delivery_slo_notifications_incident',
         'idx_recommendation_delivery_slo_notifications_route'
       )`,
  );
  const foreignKeys = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM information_schema.table_constraints
     WHERE constraint_schema = 'dealguard'
       AND constraint_type = 'FOREIGN KEY'
       AND table_name IN (
         'recommendation_delivery_slo_policies',
         'recommendation_delivery_slo_states',
         'recommendation_delivery_slo_incidents',
         'recommendation_delivery_slo_notifications'
       )`,
  );
  const portalRouteUnique = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM pg_constraint constraint_info
     JOIN pg_class relation ON relation.oid = constraint_info.conrelid
     JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'dealguard'
       AND relation.relname = 'notification_routes'
       AND constraint_info.conname = 'uq_notification_routes_portal_id'
       AND constraint_info.contype = 'u'`,
  );
  const openIncidentIndex = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM pg_indexes
     WHERE schemaname = 'dealguard'
       AND tablename = 'recommendation_delivery_slo_incidents'
       AND indexname = 'uq_recommendation_delivery_slo_open_incident'
       AND indexdef ILIKE '%WHERE%open%acknowledged%'`,
  );
  const eventChecks = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM pg_constraint constraint_info
     JOIN pg_class relation ON relation.oid = constraint_info.conrelid
     JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'dealguard'
       AND relation.relname = 'recommendation_delivery_slo_notifications'
       AND constraint_info.contype = 'c'
       AND pg_get_constraintdef(constraint_info.oid) LIKE '%recommendation.delivery.slo.breached%'
       AND pg_get_constraintdef(constraint_info.oid) LIKE '%recommendation.delivery.slo.reminder%'
       AND pg_get_constraintdef(constraint_info.oid) LIKE '%recommendation.delivery.slo.recovered%'`,
  );
  const result = {
    migrationVersion: Number(migrations.rows[0]?.version ?? 0),
    migrationCount: Number(migrations.rows[0]?.count ?? 0),
    deliverySloTableCount: Number(tables.rows[0]?.count ?? 0),
    deliverySloColumnCount: Number(columns.rows[0]?.count ?? 0),
    deliverySloIndexCount: Number(indexes.rows[0]?.count ?? 0),
    deliverySloForeignKeyCount: Number(foreignKeys.rows[0]?.count ?? 0),
    notificationRouteTenantUniqueCount: Number(portalRouteUnique.rows[0]?.count ?? 0),
    openIncidentGuardCount: Number(openIncidentIndex.rows[0]?.count ?? 0),
    notificationEventCheckCount: Number(eventChecks.rows[0]?.count ?? 0),
  };
  if (result.migrationVersion < 22 || result.migrationCount < 22) {
    throw new Error(`Expected migrations through 0022, got ${JSON.stringify(result)}.`);
  }
  if (result.deliverySloTableCount !== 4) {
    throw new Error(`Expected four recommendation delivery SLO tables, got ${result.deliverySloTableCount}.`);
  }
  if (result.deliverySloColumnCount !== 92) {
    throw new Error(`Expected 92 recommendation delivery SLO columns, got ${result.deliverySloColumnCount}.`);
  }
  if (result.deliverySloIndexCount !== 8) {
    throw new Error(`Expected eight recommendation delivery SLO indexes, got ${result.deliverySloIndexCount}.`);
  }
  if (result.deliverySloForeignKeyCount !== 9) {
    throw new Error(`Expected nine tenant-safe recommendation delivery SLO foreign keys, got ${result.deliverySloForeignKeyCount}.`);
  }
  if (result.notificationRouteTenantUniqueCount !== 1) {
    throw new Error('Expected tenant-bound notification-route uniqueness for SLO foreign keys.');
  }
  if (result.openIncidentGuardCount !== 1) {
    throw new Error('Expected one-open-incident-per-policy database guard.');
  }
  if (result.notificationEventCheckCount !== 1) {
    throw new Error('Expected breach, reminder, and recovery notification event constraints.');
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  await client.end();
}
