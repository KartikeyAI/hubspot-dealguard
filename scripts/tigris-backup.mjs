import { createHash, createHmac } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import process from 'node:process';

const BACKUP_SOURCE = 'dealguard-neon-pg-dump';
const BACKUP_ENCRYPTION = 'aes-256-cbc-pbkdf2';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const [command, ...args] = process.argv.slice(2);
const bucket = required('TIGRIS_BUCKET');
const endpoint = new URL(process.env.TIGRIS_ENDPOINT || 'https://t3.storage.dev');
const region = process.env.TIGRIS_REGION || 'auto';
const accessKeyId = required('TIGRIS_ACCESS_KEY_ID');
const secretAccessKey = required('TIGRIS_SECRET_ACCESS_KEY');

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function validKey(value) {
  if (
    !value
    || value.startsWith('/')
    || value.includes('..')
    || !/^backups\/[a-z0-9_-]+\/[A-Za-z0-9._/-]+$/.test(value)
  ) {
    throw new Error('Backup key is invalid.');
  }
  return value;
}

function validExpectedChecksum(value) {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new Error('Expected backup checksum must be a 64-character SHA-256 digest.');
  }
  return normalized;
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function objectUrl(key) {
  const encodedKey = key
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return new URL(
    `/${bucket}${encodedKey ? `/${encodedKey}` : ''}`,
    `${endpoint.origin}/`,
  );
}

function canonicalPath(url) {
  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment));
  return `/${segments.join('/')}` || '/';
}

function canonicalQuery(url) {
  const params = Array.from(url.searchParams.entries())
    .map(([name, value]) => [name, value])
    .sort(
      ([leftName, leftValue], [rightName, rightValue]) => (
        leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue)
      ),
    );
  return params
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('&');
}

function canonicalHeaders(headers) {
  const entries = Array.from(headers.entries())
    .filter(([name]) => name !== 'authorization')
    .map(([name, value]) => [name.toLowerCase(), value.trim()]);
  entries.sort(([left], [right]) => left.localeCompare(right));
  const signedHeaders = entries.map(([name]) => name).join(';');
  const text = entries
    .map(([name, value]) => `${name}:${value.replace(/\s+/g, ' ')}\n`)
    .join('');
  return { text, signedHeaders };
}

function signRequest({ method, url, body, headers }) {
  const now = new Date();
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = digest(body ?? '');
  const requestHeaders = new Headers(headers);
  requestHeaders.set('host', url.host);
  requestHeaders.set('x-amz-date', amzDate);
  requestHeaders.set('x-amz-content-sha256', payloadHash);

  const { text: canonicalHeadersText, signedHeaders } = canonicalHeaders(requestHeaders);
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalPath(url),
    canonicalQuery(url),
    canonicalHeadersText,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const canonicalRequestHash = digest(canonicalRequest);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    canonicalRequestHash,
  ].join('\n');
  const key = createHmac('sha256', `AWS4${secretAccessKey}`).update(dateStamp).digest();
  const regionKey = createHmac('sha256', key).update(region).digest();
  const serviceKey = createHmac('sha256', regionKey).update('s3').digest();
  const signingKey = createHmac('sha256', serviceKey).update('aws4_request').digest();
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  requestHeaders.set(
    'authorization',
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  );
  return requestHeaders;
}

async function fetchWithSignature(method, url, body, headers = {}) {
  const signedHeaders = signRequest({ method, url, body, headers });
  const response = await fetch(url, {
    method,
    headers: signedHeaders,
    body,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Tigris request failed with status ${response.status}: ${text}`);
  }
  return response;
}

function verifiedBackupMetadata(response, expectedChecksum = null) {
  const sha256 = response.headers.get('x-amz-meta-sha256')?.trim().toLowerCase() ?? '';
  const source = response.headers.get('x-amz-meta-source')?.trim() ?? '';
  const encryption = response.headers.get('x-amz-meta-encryption')?.trim() ?? '';
  const sizeBytes = Number(response.headers.get('content-length') ?? 0);

  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error('Backup object SHA-256 metadata is missing or invalid.');
  }
  if (expectedChecksum && sha256 !== expectedChecksum) {
    throw new Error('Backup object checksum metadata does not match the expected SHA-256 digest.');
  }
  if (source !== BACKUP_SOURCE) {
    throw new Error('Backup object source metadata is missing or invalid.');
  }
  if (encryption !== BACKUP_ENCRYPTION) {
    throw new Error('Backup object encryption metadata is missing or invalid.');
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error('Backup object content length is missing or invalid.');
  }

  return {
    sha256,
    source,
    encryption,
    sizeBytes,
  };
}

if (command === 'upload') {
  const [file, rawKey, output = '.release/backup-reference.json'] = args;
  if (!file) throw new Error('Upload requires a file path.');
  const key = validKey(rawKey);
  const body = await readFile(file);
  if (body.byteLength <= 0) throw new Error('Backup file must not be empty.');
  const sha256 = digest(body);
  const url = objectUrl(key);
  await fetchWithSignature('PUT', url, body, {
    'content-type': 'application/octet-stream',
    'content-length': String(body.byteLength),
    'x-amz-meta-sha256': sha256,
    'x-amz-meta-source': BACKUP_SOURCE,
    'x-amz-meta-encryption': BACKUP_ENCRYPTION,
  });
  const record = {
    schemaVersion: 1,
    provider: 'tigris',
    bucket,
    key,
    sha256,
    sizeBytes: body.byteLength,
    source: BACKUP_SOURCE,
    encryption: BACKUP_ENCRYPTION,
    createdAt: new Date().toISOString(),
  };
  await writeFile(output, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(record));
} else if (command === 'head') {
  const [rawKey, rawExpected] = args;
  const key = validKey(rawKey);
  const expected = validExpectedChecksum(rawExpected);
  const url = objectUrl(key);
  const response = await fetchWithSignature('HEAD', url, undefined, { accept: '*/*' });
  const metadata = verifiedBackupMetadata(response, expected);
  console.log(JSON.stringify({
    bucket,
    key,
    ...metadata,
    etag: response.headers.get('etag')?.replaceAll('"', '') ?? null,
  }));
} else if (command === 'download') {
  const [rawKey, file, rawExpected] = args;
  if (!file) throw new Error('Download requires an output file path.');
  const key = validKey(rawKey);
  const expected = validExpectedChecksum(rawExpected);
  const url = objectUrl(key);
  const response = await fetchWithSignature('GET', url, undefined, { accept: '*/*' });
  const metadata = verifiedBackupMetadata(response, expected);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = digest(bytes);
  if (metadata.sha256 !== actual || (expected && expected !== actual)) {
    throw new Error('Downloaded backup checksum validation failed.');
  }
  if (metadata.sizeBytes !== bytes.byteLength) {
    throw new Error('Downloaded backup size does not match object metadata.');
  }
  await writeFile(file, bytes, { mode: 0o600 });
  const info = await stat(file);
  console.log(JSON.stringify({
    bucket,
    key,
    sha256: actual,
    sizeBytes: info.size,
    source: metadata.source,
    encryption: metadata.encryption,
  }));
} else {
  throw new Error(
    'Usage: tigris-backup.mjs upload <file> <key> [record] | head <key> [sha256] | download <key> <file> [sha256]',
  );
}
