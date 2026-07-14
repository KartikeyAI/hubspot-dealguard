import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import pg from 'pg';

const { Client } = pg;
const [command, ...rawArguments] = process.argv.slice(2);
const argumentsMap = parseArguments(rawArguments);
const batchSize = positiveInteger(option('--batch-size', '2000'), '--batch-size');
const excludedSourceTables = new Set(['d1_migrations', 'schema_migrations', '_cf_KV']);

function parseArguments(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    if (!name?.startsWith('--')) throw new Error(`Unexpected positional argument: ${name ?? ''}`);
    const value = values[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
    result.set(name, value);
    index += 1;
  }
  return result;
}

function option(name, fallback = null) {
  return argumentsMap.get(name) ?? fallback;
}

function requiredOption(name) {
  const value = option(name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10000) throw new Error(`${name} must be an integer between 1 and 10000.`);
  return parsed;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function safeIdentifier(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Unsupported database identifier: ${value}`);
  return value;
}

function quoted(value) {
  return `"${safeIdentifier(value).replaceAll('"', '""')}"`;
}

function sourceTableAllowed(name) {
  return !excludedSourceTables.has(name) && !name.startsWith('sqlite_') && !name.startsWith('_cf_');
}

function rowsFromWrangler(value) {
  if (Array.isArray(value)) {
    const output = [];
    for (const item of value) {
      if (Array.isArray(item?.results)) output.push(...item.results);
      else if (Array.isArray(item)) output.push(...item);
    }
    return output;
  }
  if (Array.isArray(value?.results)) return value.results;
  throw new Error('Wrangler returned an unsupported JSON result shape.');
}

function parseWranglerOutput(output) {
  const text = String(output ?? '').trim();
  const arrayStart = text.indexOf('[');
  const objectStart = text.indexOf('{');
  const starts = [arrayStart, objectStart].filter((index) => index >= 0);
  if (!starts.length) throw new Error('Wrangler did not return JSON output.');
  const start = Math.min(...starts);
  const opener = text[start];
  const end = opener === '[' ? text.lastIndexOf(']') : text.lastIndexOf('}');
  if (end < start) throw new Error('Wrangler returned incomplete JSON output.');
  return JSON.parse(text.slice(start, end + 1));
}

function executeD1(database, sql) {
  const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const parameters = ['wrangler', 'd1', 'execute', database, '--remote', '--json', '--command', sql];
  const config = option('--config');
  if (config) parameters.push('--config', config);
  const result = spawnSync(executable, parameters, {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const error = String(result.stderr || result.stdout || 'unknown Wrangler failure').trim().slice(0, 4000);
    throw new Error(`Source database query failed: ${error}`);
  }
  return rowsFromWrangler(parseWranglerOutput(result.stdout));
}

function rawTableHash(rows, columns) {
  const encoded = rows.map((row) => stableJson(Object.fromEntries(columns.map((column) => [column, row[column] ?? null])))).sort();
  return sha256(encoded.join('\n'));
}

async function writeJson(path, value) {
  const destination = resolve(process.cwd(), path);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function createSnapshot() {
  const database = requiredOption('--database');
  const output = option('--output', '.release/migration/source-snapshot.json');
  const discovered = executeD1(database, `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
  const tables = [];

  for (const entry of discovered) {
    const name = safeIdentifier(String(entry.name));
    if (!sourceTableAllowed(name)) continue;
    const columnRows = executeD1(database, `PRAGMA table_info(${quoted(name)})`);
    const columns = columnRows.sort((left, right) => Number(left.cid) - Number(right.cid)).map((column) => safeIdentifier(String(column.name)));
    if (!columns.length) throw new Error(`Source table ${name} has no columns.`);
    const primaryKey = columnRows.filter((column) => Number(column.pk) > 0).sort((left, right) => Number(left.pk) - Number(right.pk)).map((column) => safeIdentifier(String(column.name)));
    if (!primaryKey.length && /WITHOUT\s+ROWID/i.test(String(entry.sql ?? ''))) throw new Error(`Source table ${name} has no primary key and no rowid.`);
    const countRows = executeD1(database, `SELECT COUNT(*) AS row_count FROM ${quoted(name)}`);
    const count = Number(countRows[0]?.row_count ?? 0);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Source table ${name} returned an invalid row count.`);
    const orderBy = primaryKey.length ? primaryKey.map(quoted).join(', ') : 'rowid';
    const rows = [];
    for (let offset = 0; offset < count; offset += batchSize) {
      rows.push(...executeD1(database, `SELECT * FROM ${quoted(name)} ORDER BY ${orderBy} LIMIT ${batchSize} OFFSET ${offset}`));
    }
    if (rows.length !== count) throw new Error(`Source table ${name} changed during snapshot creation: expected ${count} rows, received ${rows.length}.`);
    tables.push({ name, columns, primaryKey, count, rawHash: rawTableHash(rows, columns), rows });
    console.log(`snapshotted ${name}: ${count} row(s)`);
  }

  const payload = {
    schemaVersion: 1,
    source: { provider: 'cloudflare-d1', database },
    createdAt: new Date().toISOString(),
    batchSize,
    tables,
  };
  const snapshot = { ...payload, manifestChecksum: sha256(stableJson(payload)) };
  await writeJson(output, snapshot);
  console.log(JSON.stringify({ output, tables: tables.length, rows: tables.reduce((total, table) => total + table.count, 0), manifestChecksum: snapshot.manifestChecksum }));
}

async function loadSnapshot(path) {
  const value = JSON.parse(await readFile(resolve(process.cwd(), path), 'utf8'));
  const { manifestChecksum, ...payload } = value;
  if (payload.schemaVersion !== 1 || !Array.isArray(payload.tables)) throw new Error('Unsupported migration snapshot schema.');
  const expected = sha256(stableJson(payload));
  if (manifestChecksum !== expected) throw new Error('Migration snapshot manifest checksum does not match.');
  for (const table of payload.tables) {
    safeIdentifier(table.name);
    if (!Array.isArray(table.columns) || !Array.isArray(table.primaryKey) || !Array.isArray(table.rows)) throw new Error(`Snapshot table ${table.name} is malformed.`);
    table.columns.forEach(safeIdentifier);
    table.primaryKey.forEach(safeIdentifier);
    if (table.count !== table.rows.length) throw new Error(`Snapshot table ${table.name} row count does not match its manifest.`);
    if (table.rawHash !== rawTableHash(table.rows, table.columns)) throw new Error(`Snapshot table ${table.name} content hash does not match.`);
  }
  return value;
}

async function targetMetadata(client) {
  const columnResult = await client.query(`
    SELECT table_name, column_name, data_type, udt_name, ordinal_position
    FROM information_schema.columns
    WHERE table_schema = 'dealguard'
    ORDER BY table_name, ordinal_position
  `);
  const primaryKeyResult = await client.query(`
    SELECT tc.table_name, kcu.column_name, kcu.ordinal_position
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_schema = tc.constraint_schema
      AND kcu.constraint_name = tc.constraint_name
    WHERE tc.table_schema = 'dealguard' AND tc.constraint_type = 'PRIMARY KEY'
    ORDER BY tc.table_name, kcu.ordinal_position
  `);
  const foreignKeyResult = await client.query(`
    SELECT tc.table_name AS child_table, ccu.table_name AS parent_table
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_schema = tc.constraint_schema
      AND ccu.constraint_name = tc.constraint_name
    WHERE tc.table_schema = 'dealguard'
      AND ccu.table_schema = 'dealguard'
      AND tc.constraint_type = 'FOREIGN KEY'
    ORDER BY child_table, parent_table
  `);

  const tables = new Map();
  for (const row of columnResult.rows) {
    const table = tables.get(row.table_name) ?? { columns: new Map(), primaryKey: [] };
    table.columns.set(row.column_name, { dataType: row.data_type, udtName: row.udt_name, ordinal: Number(row.ordinal_position) });
    tables.set(row.table_name, table);
  }
  for (const row of primaryKeyResult.rows) tables.get(row.table_name)?.primaryKey.push(row.column_name);
  return { tables, foreignKeys: foreignKeyResult.rows };
}

function importOrder(snapshot, metadata) {
  const names = new Set(snapshot.tables.map((table) => table.name));
  for (const table of snapshot.tables) {
    if (!metadata.tables.has(table.name)) throw new Error(`Source table ${table.name} does not exist in the target schema.`);
    const target = metadata.tables.get(table.name);
    for (const column of table.columns) if (!target.columns.has(column)) throw new Error(`Source column ${table.name}.${column} does not exist in the target schema.`);
    if (stableJson(table.primaryKey) !== stableJson(target.primaryKey)) throw new Error(`Primary key mismatch for ${table.name}.`);
  }

  const dependencies = new Map([...names].map((name) => [name, new Set()]));
  for (const relation of metadata.foreignKeys) {
    const child = relation.child_table;
    const parent = relation.parent_table;
    if (!names.has(child) || !names.has(parent)) continue;
    if (child === parent) {
      const source = snapshot.tables.find((table) => table.name === child);
      if (source?.count) throw new Error(`Self-referential source table ${child} requires an explicit migration strategy.`);
      continue;
    }
    dependencies.get(child).add(parent);
  }

  const ordered = [];
  const remaining = new Set(names);
  while (remaining.size) {
    const ready = [...remaining].filter((name) => [...dependencies.get(name)].every((dependency) => !remaining.has(dependency))).sort();
    if (!ready.length) throw new Error(`Foreign-key dependency cycle prevents automatic import: ${[...remaining].sort().join(', ')}`);
    for (const name of ready) {
      ordered.push(name);
      remaining.delete(name);
    }
  }
  return ordered;
}

function normalizedNumber(value) {
  const text = String(value).trim();
  if (/^[+-]?\d+(?:\.\d+)?$/.test(text)) {
    const sign = text.startsWith('-') ? '-' : '';
    const unsigned = text.replace(/^[+-]/, '');
    const [integerPart, fractionalPart = ''] = unsigned.split('.');
    const integer = integerPart.replace(/^0+(?=\d)/, '') || '0';
    const fraction = fractionalPart.replace(/0+$/, '');
    const normalized = fraction ? `${integer}.${fraction}` : integer;
    return normalized === '0' ? '0' : `${sign}${normalized}`;
  }
  const numeric = Number(text);
  return Number.isFinite(numeric) ? String(numeric) : text;
}

function normalizedValue(value, metadata) {
  if (value === null || value === undefined) return null;
  const dataType = metadata.dataType;
  if (['smallint', 'integer', 'bigint', 'numeric', 'decimal', 'real', 'double precision'].includes(dataType)) return normalizedNumber(value);
  if (dataType === 'boolean') return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true' ? 'true' : 'false';
  if (dataType === 'json' || dataType === 'jsonb') {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return stableJson(parsed);
  }
  if (dataType === 'bytea') {
    if (Buffer.isBuffer(value)) return value.toString('base64');
    if (Array.isArray(value)) return Buffer.from(value).toString('base64');
    if (value && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data).toString('base64');
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return stableJson(value);
  return String(value);
}

function normalizedHash(rows, columns, tableMetadata) {
  const encoded = rows.map((row) => stableJson(Object.fromEntries(columns.map((column) => [column, normalizedValue(row[column], tableMetadata.columns.get(column))])))).sort();
  return sha256(encoded.join('\n'));
}

function convertedValue(value, metadata) {
  if (value === null || value === undefined) return null;
  if (metadata.dataType === 'boolean') return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
  if (metadata.dataType === 'json' || metadata.dataType === 'jsonb') return typeof value === 'string' ? JSON.parse(value) : value;
  if (metadata.dataType === 'bytea') {
    if (Buffer.isBuffer(value)) return value;
    if (Array.isArray(value)) return Buffer.from(value);
    if (value && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data);
    if (typeof value === 'string' && value.startsWith('base64:')) return Buffer.from(value.slice(7), 'base64');
    throw new Error('A source binary value is not in a supported deterministic representation.');
  }
  return value;
}

async function assertEmptyTarget(client, snapshot) {
  const occupied = [];
  for (const table of snapshot.tables) {
    const result = await client.query(`SELECT COUNT(*)::bigint AS count FROM dealguard.${quoted(table.name)}`);
    const count = Number(result.rows[0]?.count ?? 0);
    if (count !== 0) occupied.push(`${table.name}:${count}`);
  }
  if (occupied.length) throw new Error(`Target contains application rows and cannot receive a cutover import: ${occupied.join(', ')}`);
}

async function insertTable(client, table, metadata) {
  if (!table.rows.length) return 0;
  const target = metadata.tables.get(table.name);
  const columns = table.columns;
  const maximumRows = Math.max(1, Math.min(250, Math.floor(60000 / columns.length)));
  let inserted = 0;
  for (let offset = 0; offset < table.rows.length; offset += maximumRows) {
    const rows = table.rows.slice(offset, offset + maximumRows);
    const values = [];
    const tuples = rows.map((row) => {
      const placeholders = columns.map((column) => {
        values.push(convertedValue(row[column] ?? null, target.columns.get(column)));
        return `$${values.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    await client.query(
      `INSERT INTO dealguard.${quoted(table.name)} (${columns.map(quoted).join(', ')}) VALUES ${tuples.join(', ')}`,
      values,
    );
    inserted += rows.length;
  }
  return inserted;
}

async function verifySnapshot(client, snapshot, metadata) {
  const tables = [];
  for (const source of snapshot.tables) {
    const targetMetadata = metadata.tables.get(source.name);
    const selected = source.columns.map(quoted).join(', ');
    const targetRows = (await client.query(`SELECT ${selected} FROM dealguard.${quoted(source.name)}`)).rows;
    const sourceHash = normalizedHash(source.rows, source.columns, targetMetadata);
    const targetHash = normalizedHash(targetRows, source.columns, targetMetadata);
    const sourcePrimaryKeyHash = normalizedHash(source.rows, source.primaryKey, targetMetadata);
    const targetPrimaryKeyHash = normalizedHash(targetRows, source.primaryKey, targetMetadata);
    const item = {
      name: source.name,
      sourceCount: source.count,
      targetCount: targetRows.length,
      sourceHash,
      targetHash,
      sourcePrimaryKeyHash,
      targetPrimaryKeyHash,
      ok: source.count === targetRows.length && sourceHash === targetHash && sourcePrimaryKeyHash === targetPrimaryKeyHash,
    };
    tables.push(item);
  }
  const invalidConstraints = (await client.query(`
    SELECT conname
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = 'dealguard' AND c.contype = 'f' AND NOT c.convalidated
    ORDER BY conname
  `)).rows.map((row) => row.conname);
  return {
    tables,
    invalidConstraints,
    summary: {
      tables: tables.length,
      passed: tables.filter((table) => table.ok).length,
      failed: tables.filter((table) => !table.ok).length,
      sourceRows: tables.reduce((total, table) => total + table.sourceCount, 0),
      targetRows: tables.reduce((total, table) => total + table.targetCount, 0),
    },
  };
}

async function databaseIdentity(client) {
  const result = await client.query(`SELECT current_database() AS database, current_user AS role`);
  return result.rows[0];
}

async function runImportOrVerify(mode) {
  const input = requiredOption('--input');
  const reportPath = option('--report', `.release/migration/${mode}-report.json`);
  const databaseUrl = process.env.DATABASE_URL ?? process.env.NEON_DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL or NEON_DATABASE_URL is required.');
  const snapshot = await loadSnapshot(input);
  const client = new Client({ connectionString: databaseUrl, application_name: `dealguard-d1-neon-${mode}` });
  const report = {
    schemaVersion: 1,
    mode,
    startedAt: new Date().toISOString(),
    source: snapshot.source,
    snapshotChecksum: snapshot.manifestChecksum,
    status: 'failed',
    target: null,
    verification: null,
    error: null,
  };

  await client.connect();
  try {
    report.target = await databaseIdentity(client);
    await client.query(mode === 'import' ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if (mode === 'import') await client.query(`SELECT pg_advisory_xact_lock(hashtext('dealguard-d1-neon-cutover'))`);
    await client.query(`SET LOCAL search_path TO dealguard, public`);
    const metadata = await targetMetadata(client);
    const order = importOrder(snapshot, metadata);

    if (mode === 'import') {
      await assertEmptyTarget(client, snapshot);
      const byName = new Map(snapshot.tables.map((table) => [table.name, table]));
      for (const name of order) {
        const inserted = await insertTable(client, byName.get(name), metadata);
        console.log(`imported ${name}: ${inserted} row(s)`);
      }
    }

    report.verification = await verifySnapshot(client, snapshot, metadata);
    if (report.verification.summary.failed || report.verification.invalidConstraints.length) {
      const failedTables = report.verification.tables.filter((table) => !table.ok).map((table) => table.name);
      throw new Error(`Verification failed for ${failedTables.length ? failedTables.join(', ') : 'foreign-key validation'}.`);
    }
    await client.query('COMMIT');
    report.status = 'passed';
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    report.error = (error instanceof Error ? error.message : String(error)).slice(0, 4000);
  } finally {
    report.completedAt = new Date().toISOString();
    await client.end();
    await writeJson(reportPath, report);
  }

  console.log(JSON.stringify({ report: reportPath, mode, status: report.status, summary: report.verification?.summary ?? null }));
  if (report.status !== 'passed') throw new Error(report.error ?? `${mode} failed.`);
}

if (command === 'snapshot') await createSnapshot();
else if (command === 'import') await runImportOrVerify('import');
else if (command === 'verify') await runImportOrVerify('verify');
else throw new Error('Usage: d1-to-neon.mjs snapshot --database <name> [--output <file>] [--config <wrangler.toml>] [--batch-size <n>] | import --input <file> [--report <file>] | verify --input <file> [--report <file>]');
