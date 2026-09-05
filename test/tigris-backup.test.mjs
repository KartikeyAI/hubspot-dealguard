import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';

const sha256 = 'a'.repeat(64);
const key = 'backups/staging/dealguard-2.1.0.sql.enc';

function childResult(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function runHead(headers, expected = sha256) {
  let observedRequest = null;
  const server = createServer((request, response) => {
    observedRequest = {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
    };
    response.writeHead(200, headers);
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    const child = spawn(process.execPath, [
      'scripts/tigris-backup.mjs',
      'head',
      key,
      expected,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TIGRIS_BUCKET: 'dealguard-staging',
        TIGRIS_ENDPOINT: `http://127.0.0.1:${address.port}`,
        TIGRIS_REGION: 'auto',
        TIGRIS_ACCESS_KEY_ID: 'tid_test_access',
        TIGRIS_SECRET_ACCESS_KEY: 'tsec_test_secret',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = await childResult(child);
    return { ...result, request: observedRequest };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function validHeaders(overrides = {}) {
  return {
    'content-length': '128',
    etag: '"test-etag"',
    'x-amz-meta-sha256': sha256,
    'x-amz-meta-source': 'dealguard-neon-pg-dump',
    'x-amz-meta-encryption': 'aes-256-cbc-pbkdf2',
    ...overrides,
  };
}

test('Tigris backup HEAD accepts exact encrypted backup metadata and emits bounded evidence', async () => {
  const result = await runHead(validHeaders());
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.request?.method, 'HEAD');
  assert.equal(result.request?.url, `/dealguard-staging/${key}`);
  assert.match(result.request?.authorization ?? '', /^AWS4-HMAC-SHA256 /);
  const evidence = JSON.parse(result.stdout.trim());
  assert.deepEqual(evidence, {
    bucket: 'dealguard-staging',
    key,
    sha256,
    source: 'dealguard-neon-pg-dump',
    encryption: 'aes-256-cbc-pbkdf2',
    sizeBytes: 128,
    etag: 'test-etag',
  });
});

test('Tigris backup HEAD rejects missing or invalid provenance, encryption and size metadata', async () => {
  const cases = [
    {
      headers: validHeaders({ 'x-amz-meta-source': '' }),
      error: /source metadata is missing or invalid/,
    },
    {
      headers: validHeaders({ 'x-amz-meta-encryption': '' }),
      error: /encryption metadata is missing or invalid/,
    },
    {
      headers: validHeaders({ 'content-length': '0' }),
      error: /content length is missing or invalid/,
    },
    {
      headers: validHeaders({ 'x-amz-meta-sha256': 'not-a-digest' }),
      error: /SHA-256 metadata is missing or invalid/,
    },
  ];

  for (const item of cases) {
    const result = await runHead(item.headers);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, item.error);
  }
});

test('Tigris backup HEAD rejects a digest that differs from independent operator evidence', async () => {
  const result = await runHead(validHeaders(), 'b'.repeat(64));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /does not match the expected SHA-256 digest/);
});
