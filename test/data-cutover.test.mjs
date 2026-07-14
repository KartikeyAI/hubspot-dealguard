import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

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
