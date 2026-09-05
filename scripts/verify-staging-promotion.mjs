import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const root = process.cwd();
const input = resolve(root, valueAfter('--input') ?? '.release/staging-evidence');
const expectedCommit = String(process.env.RELEASE_SHA ?? '').trim();
const expectedVersion = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version;

function valueAfter(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function findRecord(path) {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const full = resolve(path, entry.name);
    if (entry.isDirectory()) {
      const nested = await findRecord(full);
      if (nested) return nested;
    } else if (entry.name === 'deployment-record.json') {
      return full;
    }
  }
  return null;
}

const recordPath = await findRecord(input);
if (!recordPath) {
  console.error('No staging deployment record was found in the downloaded evidence.');
  process.exit(1);
}

const record = JSON.parse(await readFile(recordPath, 'utf8'));
const failures = [];
if (record.schemaVersion !== 3) failures.push('unsupported staging evidence schema');
if (record.target !== 'staging') failures.push('evidence target is not staging');
if (record.result !== 'passed') failures.push('staging deployment did not pass');
if (record.commit !== expectedCommit) failures.push('staging commit does not match requested production commit');
if (record.version !== expectedVersion) failures.push('staging version does not match package version');
if (record.preflight?.failed !== 0) failures.push('staging preflight was not successful');
if (record.health?.status !== 'ok' || record.health?.service !== 'dealguard-api') {
  failures.push('staging health identity is invalid');
}
if (record.health?.version !== expectedVersion) {
  failures.push('staging health version does not match package version');
}
if (Number(record.smoke?.summary?.failed ?? 1) !== 0) {
  failures.push('staging public smoke was not successful');
}
if (record.smoke?.expectedVersion !== expectedVersion) {
  failures.push('staging public smoke version does not match package version');
}
if (record.acceptance?.profile !== 'full') failures.push('staging acceptance profile is not full');
if (Number(record.acceptance?.summary?.failed ?? 1) !== 0) {
  failures.push('staging acceptance was not successful');
}
if (!/^backups\/staging\/[A-Za-z0-9._/-]+\.enc$/.test(record.backupReference ?? '')) {
  failures.push('staging deployment lacks a staging encrypted backup reference');
}
if (!/^[0-9a-f]{64}$/.test(record.backupSha256 ?? '')) {
  failures.push('staging deployment lacks valid backup SHA-256 evidence');
}

if (failures.length) {
  console.error('Production promotion rejected:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Production promotion approved from staging run ${record.runId ?? 'unknown'} for ${record.commit}.`);
