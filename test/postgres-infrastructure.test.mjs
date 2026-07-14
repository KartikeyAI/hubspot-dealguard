import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { postgresSql } from '../dist/postgres.js';

test('PostgreSQL placeholder conversion ignores literals, identifiers and comments', () => {
  const sql = `SELECT '?' AS literal, "?" AS identifier, value FROM sample WHERE a = ? AND b = ? -- ?\n/* ? */ AND body = $$?$$`;
  assert.equal(postgresSql.placeholders(sql), `SELECT '?' AS literal, "?" AS identifier, value FROM sample WHERE a = $1 AND b = $2 -- ?\n/* ? */ AND body = $$?$$`);
});

test('release uses Neon PostgreSQL through Hyperdrive and contains no D1 runtime', async () => {
  const wrangler = await readFile('wrangler.toml', 'utf8');
  const runtime = await readFile('worker/src/runtime.ts', 'utf8');
  const adapter = await readFile('worker/src/postgres.ts', 'utf8');
  const index = await readFile('worker/src/index.ts', 'utf8');
  assert.match(wrangler, /nodejs_compat/);
  assert.match(wrangler, /\[\[env\.staging\.hyperdrive\]\]/);
  assert.match(wrangler, /\[\[env\.production\.hyperdrive\]\]/);
  assert.doesNotMatch(wrangler, /d1_databases/);
  assert.match(runtime, /HYPERDRIVE\.connectionString/);
  assert.match(adapter, /from 'pg'/);
  assert.match(index, /async queue\(/);
  await assert.rejects(() => readdir('worker/migrations'));
});

test('Tigris storage and Cloudflare Queue contracts are tenant-scoped', async () => {
  const storage = await readFile('worker/src/object-storage.ts', 'utf8');
  const attachments = await readFile('worker/src/attachments.ts', 'utf8');
  const publisher = await readFile('worker/src/queue-publisher.ts', 'utf8');
  const consumer = await readFile('worker/src/queueing.ts', 'utf8');
  const migration = await readFile('database/migrations/0014_neon_tigris_queues.sql', 'utf8');
  assert.match(storage, /t3\.storage\.dev/);
  assert.match(storage, /portals\/\$\{portalId\}\//);
  assert.match(attachments, /expected_sha256/);
  assert.match(publisher, /SCAN_QUEUE\.send/);
  assert.match(publisher, /DELIVERY_QUEUE\.send/);
  assert.match(consumer, /MAX_QUEUE_ATTEMPTS/);
  assert.match(migration, /UNIQUE \(portal_id, id\)/);
  assert.match(migration, /FOREIGN KEY \(portal_id, case_id\)/);
  assert.match(migration, /CREATE INDEX idx_async_jobs_portal/);
});
