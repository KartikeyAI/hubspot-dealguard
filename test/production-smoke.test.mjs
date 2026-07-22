import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const packageJson = JSON.parse(await readFile('package.json', 'utf8'));

function runSmoke(baseUrl, output) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      'scripts/production-smoke.mjs', '--base-url', baseUrl, '--output', output,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PRODUCTION_SMOKE_ALLOW_NON_PRODUCTION: 'true',
        PRODUCTION_SMOKE_EXPECT_VERSION: packageJson.version,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('production smoke accepts a valid release surface and writes evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dealguard-production-smoke-'));
  const output = join(root, 'evidence.json');
  let origin = '';
  const server = createServer((request, response) => {
    const url = new URL(request.url, origin);
    if (url.pathname === '/health') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: 'ok', service: 'dealguard-api', version: packageJson.version }));
      return;
    }
    if (url.pathname === '/status') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: 'operational' }));
      return;
    }
    if (['/docs', '/privacy', '/terms', '/support'].includes(url.pathname)) {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(`<html><body>${'DealGuard production information. '.repeat(12)}</body></html>`);
      return;
    }
    if (url.pathname === '/api/v1/billing') {
      response.statusCode = 401;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: { code: 'signature_required' } }));
      return;
    }
    if (url.pathname === '/oauth/install') {
      const target = new URL('https://app.hubspot.com/oauth/authorize');
      target.searchParams.set('client_id', '123456');
      target.searchParams.set('redirect_uri', `${origin}/oauth/callback`);
      target.searchParams.set('scope', 'crm.objects.deals.read crm.objects.deals.write');
      target.searchParams.set('state', 'state-value');
      response.statusCode = 302;
      response.setHeader('location', target.toString());
      response.end();
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });

  origin = await listen(server);
  try {
    const result = await runSmoke(origin, output);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const evidence = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(evidence.expectedVersion, packageJson.version);
    assert.equal(evidence.summary.failed, 0);
    assert.equal(evidence.summary.passed, 7);
    assert.equal(evidence.checks.every((check) => check.result === 'passed'), true);
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test('production smoke fails when deployed release identity is wrong', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dealguard-production-smoke-fail-'));
  const output = join(root, 'evidence.json');
  let origin = '';
  const server = createServer((request, response) => {
    const url = new URL(request.url, origin);
    if (url.pathname === '/health') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: 'ok', service: 'dealguard-api', version: '0.0.0' }));
      return;
    }
    if (url.pathname === '/status') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: 'operational' }));
      return;
    }
    if (['/docs', '/privacy', '/terms', '/support'].includes(url.pathname)) {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(`<html><body>${'DealGuard production information. '.repeat(12)}</body></html>`);
      return;
    }
    if (url.pathname === '/api/v1/billing') {
      response.statusCode = 401;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: { code: 'signature_required' } }));
      return;
    }
    if (url.pathname === '/oauth/install') {
      const target = new URL('https://app.hubspot.com/oauth/authorize');
      target.searchParams.set('client_id', '123456');
      target.searchParams.set('redirect_uri', `${origin}/oauth/callback`);
      target.searchParams.set('scope', 'crm.objects.deals.read');
      target.searchParams.set('state', 'state-value');
      response.statusCode = 302;
      response.setHeader('location', target.toString());
      response.end();
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });

  origin = await listen(server);
  try {
    const result = await runSmoke(origin, output);
    assert.notEqual(result.status, 0);
    const evidence = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(evidence.summary.failed, 1);
    assert.equal(evidence.checks.find((check) => check.id === 'DG-PROD-002')?.result, 'failed');
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});
