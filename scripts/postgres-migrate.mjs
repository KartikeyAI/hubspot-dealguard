import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import pg from 'pg';

const { Client } = pg;
const root = process.cwd();
const directory = resolve(root, process.env.POSTGRES_MIGRATIONS_DIR ?? 'database/migrations');
const checkOnly = process.argv.includes('--check');
const dryRun = process.argv.includes('--dry-run');
const databaseUrl = process.env.DATABASE_URL ?? process.env.NEON_DATABASE_URL;

if (!databaseUrl) throw new Error('DATABASE_URL or NEON_DATABASE_URL is required.');
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function postgresSql(source) { return source.replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, 'SET search_path TO dealguard, public;\n\n').replace(/\bREAL\b/g, 'DOUBLE PRECISION'); }

const files = (await readdir(directory)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
if (!files.length) throw new Error(`No PostgreSQL migrations found in ${directory}.`);
const numbers = files.map((name) => Number(name.slice(0, 4)));
if (!numbers.every((number, index) => index === 0 ? number === 1 : number === numbers[index - 1] + 1)) throw new Error(`PostgreSQL migrations are not contiguous: ${numbers.join(', ')}`);

const client = new Client({ connectionString: databaseUrl, application_name: 'dealguard-migrations' });
await client.connect();
try {
  await client.query(`SET statement_timeout = 0`);
  await client.query(`SELECT pg_advisory_lock(hashtext('dealguard-schema-migrations'))`);
  if (dryRun) await client.query('BEGIN');
  const tableExists = Boolean((await client.query(`SELECT to_regclass('dealguard.schema_migrations') AS name`)).rows[0]?.name);
  if (!checkOnly) {
    await client.query(`CREATE SCHEMA IF NOT EXISTS dealguard`);
    // The canonical SQLite migrations before 0007 do not contain PRAGMA. Set the
    // namespace at the session boundary so every migration creates and resolves
    // application relations in dealguard consistently from migration 0001 onward.
    await client.query(`SET search_path TO dealguard, public`);
    await client.query(`CREATE TABLE IF NOT EXISTS dealguard.schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  } else {
    await client.query(`SET search_path TO dealguard, public`);
  }
  const appliedRows = tableExists || !checkOnly ? (await client.query(`SELECT version, name, checksum FROM dealguard.schema_migrations ORDER BY version`)).rows : [];
  const applied = new Map(appliedRows.map((row) => [Number(row.version), row]));
  const pending = [];
  for (const name of files) {
    const version = Number(name.slice(0, 4)); const source = await readFile(resolve(directory, name), 'utf8'); const sql = postgresSql(source); const checksum = digest(sql); const existing = applied.get(version);
    if (existing) { if (existing.name !== name || existing.checksum !== checksum) throw new Error(`Migration ${version} changed after application. Expected ${existing.name}/${existing.checksum}, found ${name}/${checksum}.`); console.log(`verified ${name}`); continue; }
    pending.push({ version, name, sql, checksum });
  }
  if (checkOnly) {
    if (pending.length) throw new Error(`Database is missing ${pending.length} migration(s): ${pending.map((item) => item.name).join(', ')}`);
    console.log(`PostgreSQL schema is current through ${files.at(-1)}.`);
  } else {
    for (const migration of pending) {
      if (!dryRun) await client.query('BEGIN');
      try { await client.query(migration.sql); await client.query(`INSERT INTO dealguard.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)`, [migration.version, migration.name, migration.checksum]); if (!dryRun) await client.query('COMMIT'); console.log(`${dryRun ? 'validated' : 'applied'} ${migration.name}`); }
      catch (error) { await client.query('ROLLBACK'); throw error; }
    }
    if (dryRun) { await client.query('ROLLBACK'); console.log(`Dry-run validated ${pending.length} pending migration(s).`); }
    else console.log(`PostgreSQL migrations complete through ${files.at(-1)}.`);
  }
} finally {
  await client.query(`SELECT pg_advisory_unlock(hashtext('dealguard-schema-migrations'))`).catch(() => undefined);
  await client.end();
}
