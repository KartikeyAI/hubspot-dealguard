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

function snapshotTable(name, columns, primaryKey, rows) {
  return { name, columns, primaryKey, count: rows.length, rawHash: rawTableHash(rows, columns), rows };
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
  assert.match(source, /orderRowsForSelfReferences/);
  assert.match(source, /Self-referential cycle prevents automatic import/);
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

test('fixture snapshot imports tenant and self-referential policy history', {
  skip: !process.env.DEALGUARD_CUTOVER_TEST_DATABASE_URL,
}, async () => {
  const databaseUrl = process.env.DEALGUARD_CUTOVER_TEST_DATABASE_URL;
  const root = await mkdtemp(join(tmpdir(), 'dealguard-cutover-'));
  const snapshotPath = join(root, 'snapshot.json');
  const importReportPath = join(root, 'import-report.json');
  const verificationReportPath = join(root, 'verification-report.json');
  const portalId = 'cutover-fixture-portal';
  const timestamp = '2026-07-14T16:30:00.000Z';

  const tenantColumns = [
    'portal_id', 'app_id', 'account_name', 'hub_domain', 'installer_email',
    'access_token_cipher', 'access_token_iv', 'refresh_token_cipher', 'refresh_token_iv',
    'token_expires_at', 'scopes_json', 'settings_json', 'plan', 'status',
    'installed_at', 'updated_at', 'last_scan_at', 'next_scan_at', 'last_digest_at',
  ];
  const tenantRows = [{
    portal_id: portalId,
    app_id: '123456',
    account_name: 'Cutover fixture',
    hub_domain: 'fixture.example',
    installer_email: 'fixture@example.com',
    access_token_cipher: 'ciphertext',
    access_token_iv: 'iv',
    refresh_token_cipher: 'refresh-ciphertext',
    refresh_token_iv: 'refresh-iv',
    token_expires_at: '2026-07-14T18:30:00.000Z',
    scopes_json: '[]',
    settings_json: '{}',
    plan: 'free',
    status: 'active',
    installed_at: timestamp,
    updated_at: timestamp,
    last_scan_at: null,
    next_scan_at: '2026-07-14T16:45:00.000Z',
    last_digest_at: null,
  }];

  const policyColumns = [
    'id', 'portal_id', 'version_number', 'name', 'description', 'status', 'rules_json',
    'checksum', 'change_summary', 'based_on_policy_id', 'created_by_user_id',
    'created_by_email', 'submitted_at', 'approved_at', 'approved_by_user_id',
    'approved_by_email', 'published_at', 'published_by_user_id', 'published_by_email',
    'created_at', 'updated_at',
  ];
  const policyRows = [
    {
      id: 'policy-child', portal_id: portalId, version_number: 2, name: 'Child', description: '',
      status: 'draft', rules_json: '{}', checksum: 'child-checksum', change_summary: 'child',
      based_on_policy_id: 'policy-parent', created_by_user_id: 'user-1', created_by_email: 'fixture@example.com',
      submitted_at: null, approved_at: null, approved_by_user_id: null, approved_by_email: null,
      published_at: null, published_by_user_id: null, published_by_email: null, created_at: timestamp, updated_at: timestamp,
    },
    {
      id: 'policy-parent', portal_id: portalId, version_number: 1, name: 'Parent', description: '',
      status: 'published', rules_json: '{}', checksum: 'parent-checksum', change_summary: 'parent',
      based_on_policy_id: null, created_by_user_id: 'user-1', created_by_email: 'fixture@example.com',
      submitted_at: timestamp, approved_at: timestamp, approved_by_user_id: 'user-1', approved_by_email: 'fixture@example.com',
      published_at: timestamp, published_by_user_id: 'user-1', published_by_email: 'fixture@example.com', created_at: timestamp, updated_at: timestamp,
    },
  ];

  const tables = [
    snapshotTable('policy_versions', policyColumns, ['id'], policyRows),
    snapshotTable('tenants', tenantColumns, ['portal_id'], tenantRows),
  ];
  const payload = {
    schemaVersion: 1,
    source: { provider: 'cloudflare-d1', database: 'cutover-fixture' },
    createdAt: timestamp,
    batchSize: 2000,
    tables,
  };
  const snapshot = { ...payload, manifestChecksum: sha256(stableJson(payload)) };
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });

  const cleanup = async () => {
    const client = new Client({ connectionString: databaseUrl, application_name: 'dealguard-cutover-test-cleanup' });
    await client.connect();
    try {
      await client.query(`DELETE FROM dealguard.tenants WHERE portal_id = $1`, [portalId]);
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
    assert.equal(importReport.verification.summary.sourceRows, 3);
    assert.equal(importReport.verification.summary.targetRows, 3);
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
    assert.equal(verificationReport.verification.tables.every((table) => table.ok), true);

    const client = new Client({ connectionString: databaseUrl, application_name: 'dealguard-cutover-test-read' });
    await client.connect();
    try {
      const result = await client.query(`SELECT id, based_on_policy_id FROM dealguard.policy_versions WHERE portal_id = $1 ORDER BY version_number`, [portalId]);
      assert.deepEqual(result.rows, [
        { id: 'policy-parent', based_on_policy_id: null },
        { id: 'policy-child', based_on_policy_id: 'policy-parent' },
      ]);
    } finally {
      await client.end();
    }
  } finally {
    await cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
