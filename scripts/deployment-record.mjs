import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const root = process.cwd();
const output = resolve(root, valueAfter('--output') ?? '.release/deployment-record.json');
const preflightPath = resolve(root, valueAfter('--preflight') ?? '.release/preflight.json');
const healthPath = resolve(root, valueAfter('--health') ?? '.release/health.json');
const acceptanceDir = resolve(root, valueAfter('--acceptance-dir') ?? 'artifacts/acceptance');

function valueAfter(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function findAcceptance() {
  try {
    const files = (await readdir(acceptanceDir)).filter((name) => name.endsWith('.json')).sort();
    return files.length ? json(resolve(acceptanceDir, files.at(-1))) : null;
  } catch {
    return null;
  }
}

const preflight = await json(preflightPath);
const health = await json(healthPath);
const acceptance = await findAcceptance();
const packageJson = await json(resolve(root, 'package.json'));
const target = process.env.RELEASE_TARGET === 'production' ? 'production' : 'staging';
const commit = String(process.env.RELEASE_SHA ?? process.env.GITHUB_SHA ?? '').trim();
const backupReference = String(process.env.BACKUP_REFERENCE ?? '').trim();

const record = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  repository: process.env.GITHUB_REPOSITORY ?? null,
  workflow: process.env.GITHUB_WORKFLOW ?? null,
  runId: process.env.GITHUB_RUN_ID ?? null,
  target,
  commit,
  version: packageJson.version,
  backupReference,
  preflight: preflight.summary,
  health: {
    status: health.status ?? health.ok ?? null,
    version: health.version ?? null,
  },
  acceptance: acceptance ? {
    profile: acceptance.profile ?? null,
    summary: acceptance.summary ?? null,
  } : null,
};

const failures = [];
if (!/^[0-9a-f]{40}$/i.test(record.commit)) failures.push('release commit is not a full SHA');
if (!record.backupReference) failures.push('backup reference is missing');
if (record.preflight?.failed !== 0) failures.push('release preflight did not pass');
if (record.health.version !== record.version) failures.push('deployed health version does not match package version');
if (!record.acceptance || Number(record.acceptance.summary?.failed ?? 1) !== 0) failures.push('signed acceptance did not pass');

record.result = failures.length ? 'failed' : 'passed';
record.failures = failures;
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
console.log(`Deployment record ${record.result}: ${output}`);
if (failures.length) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
}
