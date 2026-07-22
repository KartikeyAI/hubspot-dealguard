import { createHash } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import process from 'node:process';
import { HeadObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const [command, ...args] = process.argv.slice(2);
const bucket = required('TIGRIS_BUCKET');
const client = new S3Client({
  endpoint: process.env.TIGRIS_ENDPOINT || 'https://t3.storage.dev',
  region: process.env.TIGRIS_REGION || 'auto',
  credentials: { accessKeyId: required('TIGRIS_ACCESS_KEY_ID'), secretAccessKey: required('TIGRIS_SECRET_ACCESS_KEY') },
});

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
function validKey(value) {
  if (!value || value.startsWith('/') || value.includes('..') || !/^backups\/[a-z0-9_-]+\/[A-Za-z0-9._/-]+$/.test(value)) throw new Error('Backup key is invalid.');
  return value;
}
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

if (command === 'upload') {
  const [file, rawKey, output = '.release/backup-reference.json'] = args;
  if (!file) throw new Error('Upload requires a file path.');
  const key = validKey(rawKey);
  const body = await readFile(file);
  const sha256 = digest(body);
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentLength: body.byteLength, ContentType: 'application/octet-stream', Metadata: { sha256, source: 'dealguard-neon-pg-dump', encryption: 'aes-256-cbc-pbkdf2' } }));
  const record = { schemaVersion: 1, provider: 'tigris', bucket, key, sha256, sizeBytes: body.byteLength, encryption: 'aes-256-cbc-pbkdf2', createdAt: new Date().toISOString() };
  await writeFile(output, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(record));
} else if (command === 'head') {
  const [rawKey, expected] = args;
  const key = validKey(rawKey);
  const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  const actual = result.Metadata?.sha256?.toLowerCase() ?? '';
  if (!actual || (expected && actual !== expected.toLowerCase())) throw new Error('Backup object checksum metadata is missing or mismatched.');
  console.log(JSON.stringify({ bucket, key, sha256: actual, sizeBytes: Number(result.ContentLength ?? 0), etag: result.ETag?.replaceAll('"', '') ?? null }));
} else if (command === 'download') {
  const [rawKey, file, expected] = args;
  if (!file) throw new Error('Download requires an output file path.');
  const key = validKey(rawKey);
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!result.Body) throw new Error('Backup object body is missing.');
  const bytes = Buffer.from(await result.Body.transformToByteArray());
  const actual = digest(bytes);
  const metadataChecksum = result.Metadata?.sha256?.toLowerCase() ?? '';
  if (!metadataChecksum || metadataChecksum !== actual || (expected && expected.toLowerCase() !== actual)) throw new Error('Downloaded backup checksum validation failed.');
  await writeFile(file, bytes, { mode: 0o600 });
  const info = await stat(file);
  console.log(JSON.stringify({ bucket, key, sha256: actual, sizeBytes: info.size }));
} else {
  throw new Error('Usage: tigris-backup.mjs upload <file> <key> [record] | head <key> [sha256] | download <key> <file> [sha256]');
}
