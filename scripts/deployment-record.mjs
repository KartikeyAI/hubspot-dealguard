import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { certificationContext, deploymentEvidenceFailures, intelligenceFingerprint } from './intelligence-certification.mjs';

const root = process.cwd();
const output = resolve(root, valueAfter('--output') ?? '.release/deployment-record.json');
function valueAfter(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}
async function optionalJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}
async function singleEvidence(directory) {
  // Never select a convenient passing result from a directory containing stale or mixed runs.
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = entries.filter((entry) => entry.name.endsWith('.json'));
    if (files.length !== 1 || !files[0].isFile()) return null;
    return optionalJson(resolve(directory, files[0].name));
  } catch { return null; }
}
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const context = certificationContext(process.env, packageJson.version);
const preflight = await optionalJson(resolve(root, valueAfter('--preflight') ?? '.release/preflight.json'));
const health = await optionalJson(resolve(root, valueAfter('--health') ?? '.release/health.json'));
const smoke = await optionalJson(resolve(root, valueAfter('--smoke') ?? '.release/production-smoke/evidence.json'));
const baseline = await optionalJson(resolve(root, valueAfter('--baseline') ?? '.release/release-baseline.json'));
const acceptance = await singleEvidence(resolve(root, valueAfter('--acceptance-dir') ?? 'artifacts/acceptance'));
const intelligence = await singleEvidence(resolve(root, valueAfter('--intelligence-dir') ?? 'artifacts/intelligence-acceptance'));
const record = {
  schemaVersion: 4,
  generatedAt: new Date().toISOString(),
  repository: process.env.GITHUB_REPOSITORY ?? null,
  workflow: process.env.GITHUB_WORKFLOW ?? null,
  runId: context.workflowRunId,
  runAttempt: context.workflowRunAttempt,
  target: context.target,
  commit: context.commit,
  version: packageJson.version,
  backupReference: String(process.env.BACKUP_REFERENCE ?? '').trim(),
  backupSha256: String(process.env.BACKUP_SHA256 ?? '').trim().toLowerCase(),
  acceptanceContext: context,
  preflight: preflight?.summary ?? null,
  health: health ? { status: health.status ?? null, service: health.service ?? null, version: health.version ?? null } : null,
  baseline: baseline ? { target: baseline.target, source: baseline.source,
    release: { version: baseline.release?.version }, verification: { repository: baseline.verification?.repository } } : null,
  productionApproval: await optionalJson(resolve(root, valueAfter('--signoff') ?? '.release/production-signoff-receipt.json')),
  signoffArtifactRunId: String(process.env.SIGNOFF_RUN_ID ?? '').trim(),
  stagingRunId: String(process.env.STAGING_RUN_ID ?? '').trim(),
  smoke,
  acceptance,
  intelligence,
  intelligenceSha256: intelligence ? intelligenceFingerprint(intelligence) : null,
};
record.failures = deploymentEvidenceFailures(record);
record.result = record.failures.length ? 'failed' : 'passed';
record.promotable = record.result === 'passed' && record.target === 'staging' && acceptance?.profile === 'full';
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
console.log(`Deployment record ${record.result}: ${output}`);
if (record.failures.length) {
  for (const failure of record.failures) console.error(`- ${failure}`);
  process.exitCode = 1;
}
