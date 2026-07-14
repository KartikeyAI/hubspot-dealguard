import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import pg from 'pg';

const { Client } = pg;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function rawTableHash(rows, columns) {
  return sha256(rows.map((row) => stableJson(Object.fromEntries(columns.map((column) => [column, row[column] ?? null])))).sort().join('\n'));
}

test('D1-to-Neon migration tool is syntactically valid and fails closed', async () => {
  const syntax = spawnSync(process.execPath, ['--check', 'scripts/d1-to-neon.mjs'], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, `${syntax.stdout}\n${syntax.stderr}`);

  const invalid = spawnSync(process.execPath, ['scripts/d1-to-neon.mjs', 'unsupported'], { encoding: 'utf8' });
  assert.notEqual(invalid.status, 0);
  assert.match(`${invalid.stdout}\n${invalid.stderr}`, /Usage: d1-to-neon\.mjs/);
});

test('source snapshot is bounded, deterministic and integrity protected', async () => {
  const source = await readFile('scripts/d1-to-neon.mjs', 'utf8');
  assert.match(source, /sqlite_master/);
  assert.match(source, /--remote/);
  assert.match(source, /--json/);
  assert.match(source, /--batch-size/);
  assert.match(source, /LIMIT \$\{batchSize\} OFFSET \$\{offset\}/);
  assert.match(source, /changed during snapshot creation/);
  assert.match(source, /rawTableHash/);
  assert.match(source, /manifestChecksum/);
  assert.match(source, /mode: 0o600/);
  assert.doesNotMatch(source, /console\.log\([^\n]*(row\[|JSON\.stringify\(row)/);
});

test('target import is empty-target, transactional, dependency ordered and parameterized', async () => {
  const source = await readFile('scripts/d1-to-neon.mjs', 'utf8');
  assert.match(source, /assertEmptyTarget/);
  assert.match(source, /BEGIN ISOLATION LEVEL SERIALIZABLE/);
  assert.match(source, /pg_advisory_xact_lock/);
  assert.match(source, /Foreign-key dependency cycle/);
  assert.match(source, /INSERT INTO dealguard/);
  assert.match(source, /return `\$\$\{values\.length\}`/);
  assert.match(source, /ROLLBACK/);
  assert.doesNotMatch(source, /ON CONFLICT|session_replication_role/);
});

test('verification compares exact counts, normalized content and primary keys', async () => {
  const source = await readFile('scripts/d1-to-neon.mjs', 'utf8');
  assert.match(source, /sourceCount/);
  assert.match(source, /targetCount/);
  assert.match(source, /sourceHash/);
  assert.match(source, /targetHash/);
  assert.match(source, /sourcePrimaryKeyHash/);
  assert.match(source, /targetPrimaryKeyHash/);
  assert.match(source, /NOT c\.convalidated/);

  const runbook = await readFile('docs/MIGRATION_D1_TO_NEON.md', 'utf8');
  assert.match(runbook, /Write freeze/);
  assert.match(runbook, /Row-count reconciliation/);
  assert.match(runbook, /content-hash/i);
  assert.match(runbook, /Tigris/);
  assert.match(runbook, /Rollback/);
  assert.match(runbook, /A code rollback without data reconciliation is not a valid rollback/);
});

test('package exposes explicit snapshot, import and verification commands', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(packageJson.scripts['migration:d1:snapshot'], 'node scripts/d1-to-neon.mjs snapshot');
  assert.equal(packageJson.scripts['migration:d1:import'], 'node scripts/d1-to-neon.mjs import');
  assert.equal(packageJson.scripts['migration:d1:verify'], 'node scripts/d1-to-neon.mjs verify');
});

test('fixture snapshot imports transactionally and verifies against PostgreSQL', {
  skip: !process.env.DEALGUARD_CUTOVER_TEST_DATABASE_URL,
}, async () => {
  const databaseUrl = process.env.DEALGUARD_CUTOVER_TEST_DATABASE_URL;
  const root = await mkdtemp(join(tmpdir(), 'dealguard-cutover-'));
  const snapshotPath = join(root, 'snapshot.json');
  const importReportPath = join(root, 'import-report.json');
  const verificationReportPath = join(root, 'verification-report.json');
  const columns = ['state_hash', 'return_to', 'expires_at', 'created_at'];
  const rows = [{
    state_hash: 'cutover-fixture-state',
    return_to: '/settings',
    expires_at: '2026-07-14T17:30:00.000Z',
    created_at: '2026-07-14T16:30:00.000Z',
  }];
  const table = {
    name: 'oauth_states',
    columns,
    primaryKey: ['state_hash'],
    count: rows.length,
    rawHash: rawTableHash(rows, columns),
    rows,
  };
  const payload = {
    schemaVersion: 1,
    source: { provider: 'cloudflare-d1', database: 'cutover-fixture' },
    createdAt: '2026-07-14T16:30:00.000Z',
    batchSize: 2000,
    tables: [table],
  };
  const snapshot = { ...payload, manifestChecksum: sha256(stableJson(payload)) };
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });

  const cleanup = async () => {
    const client = new Client({ connectionString: databaseUrl, application_name: 'dealguard-cutover-test-cleanup' });
    await client.connect();
    try {
      await client.query(`DELETE FROM dealguard.oauth_states WHERE state_hash = $1`, [rows[0].state_hash]);
    } finally {
      await client.end();
    }
  };

  await cleanup();
  try {
    const imported = spawnSync(process.execPath, [
      'scripts/d1-to-neon.mjs', 'import', '--input', snapshotPath, '--report', importReportPath,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: databaseUrl },
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(imported.status, 0, `${imported.stdout}\n${imported.stderr}`);
    const importReport = JSON.parse(await readFile(importReportPath, 'utf8'));
    assert.equal(importReport.status, 'passed');
    assert.equal(importReport.verification.summary.sourceRows, 1);
    assert.equal(importReport.verification.summary.targetRows, 1);
    assert.equal(importReport.verification.summary.failed, 0);

    const verified = spawnSync(process.execPath, [
      'scripts/d1-to-neon.mjs', 'verify', '--input', snapshotPath, '--report', verificationReportPath,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: databaseUrl },
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(verified.status, 0, `${verified.stdout}\n${verified.stderr}`);
    const verificationReport = JSON.parse(await readFile(verificationReportPath, 'utf8'));
    assert.equal(verificationReport.status, 'passed');
    assert.equal(verificationReport.verification.tables[0].ok, true);

    const client = new Client({ connectionString: databaseUrl, application_name: 'dealguard-cutover-test-read' });
    await client.connect();
    try {
      const result = await client.query(`SELECT return_to FROM dealguard.oauth_states WHERE state_hash = $1`, [rows[0].state_hash]);
      assert.equal(result.rows[0]?.return_to, '/settings');
    } finally {
      await client.end();
    }
  } finally {
    await cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
