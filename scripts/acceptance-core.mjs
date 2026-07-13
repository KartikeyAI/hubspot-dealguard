import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const URI_DECODINGS = {
  '%3A': ':', '%2F': '/', '%3F': '?', '%40': '@', '%21': '!', '%24': '$', '%27': "'",
  '%28': '(', '%29': ')', '%2A': '*', '%2C': ',', '%3B': ';',
};

export function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

export function required(name, value) {
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return String(value).trim();
}

export function cleanBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('ACCEPTANCE_BASE_URL must use HTTPS outside localhost.');
  }
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function safeUrl(value) {
  try {
    const url = new URL(String(value));
    return `${url.origin}${url.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}

function maskEmail(value) {
  const [local, domain] = String(value ?? '').split('@');
  return domain ? `${local?.slice(0, 1) || '*'}***@${domain}` : '[redacted]';
}

export function sanitize(value, key = '') {
  if (value === null || value === undefined) return value;
  if (/secret|token|authorization|password|api[_-]?key|signature|cookie/i.test(key)) return '[REDACTED]';
  if (/email/i.test(key) && typeof value === 'string') return maskEmail(value);
  if (/customerId|subscriptionId|productId/i.test(key) && typeof value === 'string') return value ? '[PRESENT]' : null;
  if (/url/i.test(key) && typeof value === 'string') return safeUrl(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 100).map(([childKey, childValue]) => [childKey, sanitize(childValue, childKey)]));
  if (typeof value === 'string') return value.length > 1500 ? `${value.slice(0, 1500)}…` : value;
  return value;
}

export function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function decodeHubSpotUri(uri) {
  let decoded = uri;
  for (const [encoded, value] of Object.entries(URI_DECODINGS)) decoded = decoded.replaceAll(encoded, value).replaceAll(encoded.toLowerCase(), value);
  return decoded;
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='), 'base64');
}

export class AcceptanceClient {
  constructor(config) {
    this.config = config;
  }

  identityUrl(relativePath) {
    const url = new URL(relativePath, `${this.config.baseUrl}/`);
    url.searchParams.set('portalId', this.config.portalId);
    if (this.config.appId) url.searchParams.set('appId', this.config.appId);
    if (this.config.userId) url.searchParams.set('userId', this.config.userId);
    if (this.config.userEmail) url.searchParams.set('userEmail', this.config.userEmail);
    return url;
  }

  hubSpotHeaders(method, url, rawBody) {
    const timestamp = String(Date.now());
    const source = `${method.toUpperCase()}${decodeHubSpotUri(url.toString())}${rawBody}${timestamp}`;
    return {
      'x-hubspot-request-timestamp': timestamp,
      'x-hubspot-signature-v3': createHmac('sha256', this.config.clientSecret).update(source).digest('base64'),
    };
  }

  dodoHeaders(rawBody, valid = true) {
    const webhookId = `acceptance-${randomUUID()}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const secret = this.config.dodoWebhookSecret.startsWith('whsec_')
      ? base64UrlDecode(this.config.dodoWebhookSecret.slice(6))
      : Buffer.from(this.config.dodoWebhookSecret, 'utf8');
    const signature = valid
      ? createHmac('sha256', secret).update(`${webhookId}.${timestamp}.${rawBody}`).digest('base64url')
      : 'invalid';
    return { 'webhook-id': webhookId, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` };
  }

  async http(method, url, { body, headers = {} } = {}) {
    const rawBody = body === undefined ? '' : JSON.stringify(body);
    const response = await fetch(url, {
      method,
      signal: AbortSignal.timeout(this.config.timeoutMs),
      headers: { accept: 'application/json, text/plain, text/html', ...(rawBody ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(rawBody ? { body: rawBody } : {}),
    });
    const text = await response.text();
    let json = null;
    if (text) try { json = JSON.parse(text); } catch { json = null; }
    return {
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get('content-type'),
      requestId: response.headers.get('x-request-id'),
      text,
      json,
    };
  }

  async signed(method, relativePath, body) {
    const url = this.identityUrl(relativePath);
    const rawBody = body === undefined ? '' : JSON.stringify(body);
    return this.http(method, url, { body, headers: this.hubSpotHeaders(method, url, rawBody) });
  }
}

export class EvidenceRun {
  constructor(metadata) {
    this.startedAt = new Date();
    this.runId = `dealguard-acceptance-${this.startedAt.toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    this.metadata = metadata;
    this.results = [];
  }

  async run(test, operation) {
    const started = Date.now();
    try {
      const actual = await operation();
      this.results.push({ ...test, status: 'passed', actual: sanitize(actual), durationMs: Date.now() - started });
    } catch (error) {
      this.results.push({ ...test, status: 'failed', actual: { error: sanitize(error instanceof Error ? error.message : String(error)) }, durationMs: Date.now() - started });
    }
  }

  skip(test, reason) {
    this.results.push({ ...test, status: 'skipped', actual: { reason }, durationMs: 0 });
  }

  async write(outputDir) {
    const finishedAt = new Date();
    const summary = {
      passed: this.results.filter((item) => item.status === 'passed').length,
      failed: this.results.filter((item) => item.status === 'failed').length,
      skipped: this.results.filter((item) => item.status === 'skipped').length,
      requiredFailed: this.results.filter((item) => item.required && item.status === 'failed').length,
    };
    const evidence = {
      schemaVersion: 1,
      runId: this.runId,
      ...this.metadata,
      startedAt: this.startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - this.startedAt.getTime(),
      summary,
      results: this.results,
      safety: {
        secretsRecorded: false,
        destructiveActionsExecuted: false,
        note: 'Full profile may create checkout sessions and scans. It does not pay, cancel, delete, publish policy, modify roles, or mutate a subscription plan.',
      },
    };
    await mkdir(outputDir, { recursive: true });
    const jsonPath = path.join(outputDir, `${this.runId}.json`);
    const markdownPath = path.join(outputDir, `${this.runId}.md`);
    await writeFile(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    const markdown = [
      `# DealGuard live acceptance — ${this.runId}`,
      '',
      `- Release: \`${this.metadata.release}\``,
      `- Profile: \`${this.metadata.profile}\``,
      `- Environment: \`${this.metadata.environment.baseUrl}\``,
      `- Portal: \`${this.metadata.environment.portalId}\``,
      `- Result: ${summary.failed === 0 ? 'PASS' : 'FAIL'}`,
      '',
      '| ID | Area | Required | Status | Duration |',
      '|---|---|---:|---|---:|',
      ...this.results.map((item) => `| ${item.id} | ${item.area} | ${item.required ? 'yes' : 'no'} | ${item.status} | ${item.durationMs} ms |`),
      '',
      'Detailed sanitized results are in the companion JSON file.',
      '',
    ].join('\n');
    await writeFile(markdownPath, markdown, 'utf8');
    return { evidence, jsonPath, markdownPath };
  }
}
