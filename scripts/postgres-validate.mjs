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
  const result = {
    migrationVersion: Number(migrations.rows[0]?.version ?? 0),
    migrationCount: Number(migrations.rows[0]?.count ?? 0),
    tableCount: Number(tables.rows[0]?.count ?? 0),
    foreignKeyCount: Number(constraints.rows[0]?.count ?? 0),
    tenantLeadingIndexCount: Number(tenantIndexes.rows[0]?.count ?? 0),
  };
  if (result.migrationVersion < 14 || result.migrationCount < 14) throw new Error(`Expected migrations through 0014, got ${JSON.stringify(result)}.`);
  if (result.tableCount < 70) throw new Error(`Expected at least 70 DealGuard tables, got ${result.tableCount}.`);
  if (result.foreignKeyCount < 55) throw new Error(`Expected tenant and relationship foreign keys, got ${result.foreignKeyCount}.`);
  if (result.tenantLeadingIndexCount < 30) throw new Error(`Expected tenant-leading indexes, got ${result.tenantLeadingIndexCount}.`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await client.end();
}
