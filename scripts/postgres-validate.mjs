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
  const result = {
    migrationVersion: Number(migrations.rows[0]?.version ?? 0),
    migrationCount: Number(migrations.rows[0]?.count ?? 0),
    tableCount: Number(tables.rows[0]?.count ?? 0),
    foreignKeyCount: Number(constraints.rows[0]?.count ?? 0),
    tenantLeadingIndexCount: Number(tenantIndexes.rows[0]?.count ?? 0),
    trustworthyCurrencyColumnCount: currencyColumns.rowCount ?? 0,
  };
  if (result.migrationVersion < 15 || result.migrationCount < 15) throw new Error(`Expected migrations through 0015, got ${JSON.stringify(result)}.`);
  if (result.tableCount < 70) throw new Error(`Expected at least 70 DealGuard tables, got ${result.tableCount}.`);
  if (result.foreignKeyCount < 55) throw new Error(`Expected tenant and relationship foreign keys, got ${result.foreignKeyCount}.`);
  if (result.tenantLeadingIndexCount < 30) throw new Error(`Expected tenant-leading indexes, got ${result.tenantLeadingIndexCount}.`);
  if (result.trustworthyCurrencyColumnCount !== 2) throw new Error(`Expected trustworthy currency columns on assessment_history, got ${result.trustworthyCurrencyColumnCount}.`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await client.end();
}
