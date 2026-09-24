import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectReleaseBaseline, releaseVersionPolicy } from './release-baseline.mjs';
import { digest, readEvidenceFile, reportFailures, SIGNOFF_GATES } from './production-signoff.mjs';

const repository = 'KartikeyAI/hubspot-dealguard';
const encode = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
function requireCandidate(value, stable = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 4 || value.repository !== repository
    || !/^[a-f0-9]{40}$/.test(value.commit ?? '') || !/^[a-f0-9]{40}$/.test(value.tree ?? '')
    || !releaseVersionPolicy(value.version, stable ? 'production' : 'staging').ok
    || (stable && !/^3\.\d+\.\d+$/.test(value.version))) {
    throw new Error('Evidence requires an exact candidate; assembly requires stable v3.');
  }
}
async function destination(path) {
  const output = resolve(path), parent = dirname(output);
  // The operator must choose a new directory under a real, existing parent.
  if ((await realpath(parent)) !== parent || !(await lstat(parent)).isDirectory()) {
    throw new Error('Evidence output parent must be a real directory without symlink ancestors.');
  }
  await mkdir(output, { mode: 0o700 }); // Existing output, even empty, is never replaced.
  await mkdir(resolve(output, 'reports'), { mode: 0o700 });
  return output;
}

/** Scaffolding contains no measurements or passing results and cannot authorize release. */
export async function initializeEvidence({ output, candidate }) {
  requireCandidate(candidate);
  const files = Object.fromEntries(Object.entries(SIGNOFF_GATES).map(([gate, checks]) => [gate,
    encode({ schemaVersion: 1, gate, candidate, startedAt: null, completedAt: null,
      checks: checks.map(id => ({ id, status: 'not_run' })), measurements: null,
      evidenceReferences: [] })]));
  const root = await destination(output);
  for (const [gate, bytes] of Object.entries(files)) {
    await writeFile(resolve(root, 'reports', `${gate}.json`), bytes, { mode: 0o600, flag: 'wx' });
  }
  return { schemaVersion: 1, kind: 'unverified-evidence-scaffold', candidate,
    reports: Object.keys(files), approvalAccepted: false, productionReady: false };
}

/** Copies the exact validated report bytes, but never creates keys or signatures. */
export async function prepareEvidence({ input, output, candidate, stagingRunId, hours = 12, now = Date.now() }) {
  requireCandidate(candidate, true);
  if (!/^[1-9]\d*$/.test(stagingRunId ?? '') || !Number.isFinite(now)
    || !Number.isInteger(hours) || hours < 1 || hours > 24) {
    throw new Error('Use a staging run ID and an approval window of 1 to 24 hours.');
  }
  const reports = new Map(), gates = {}, failures = [];
  for (const gate of Object.keys(SIGNOFF_GATES)) {
    const path = `reports/${gate}.json`, bytes = await readEvidenceFile(input, path);
    let report;
    try { report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new Error('A production evidence report is not valid UTF-8 JSON.'); }
    failures.push(...reportFailures(report, gate, candidate, now, now));
    reports.set(path, bytes); gates[gate] = { path, sha256: digest(bytes) };
  }
  if (failures.length) throw new Error(`Evidence is incomplete or invalid:\n${failures.map(f => `- ${f}`).join('\n')}`);
  const dossier = { schemaVersion: 1, kind: 'dealguard-production-approval', candidate,
    stagingRunId, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + hours * 3_600_000).toISOString(), gates };
  const bytes = encode(dossier);
  // Validate all input before creating output; partial/failed input produces no dossier.
  const root = await destination(output);
  for (const [path, content] of reports) await writeFile(resolve(root, path), content, { mode: 0o600, flag: 'wx' });
  await writeFile(resolve(root, 'signatures.json'), '[]\n', { mode: 0o600, flag: 'wx' });
  // Dossier written last; an IO failure cannot leave an apparently complete package.
  await writeFile(resolve(root, 'dossier.json'), bytes, { mode: 0o600, flag: 'wx' });
  return { schemaVersion: 1, kind: 'unsigned-evidence-preparation', candidate, stagingRunId,
    dossierSha256: digest(bytes), reports: reports.size, readyForIndependentReview: true,
    approvalAccepted: false, productionReady: false };
}

export function parsePreparationArgs(args) {
  const [command, ...rest] = args, options = {};
  if (!['init', 'assemble'].includes(command) || rest.length % 2 !== 0) throw new Error('Use init or assemble with named option/value pairs.');
  for (let i = 0; i < rest.length; i += 2) {
    const [key, value] = rest.slice(i, i + 2);
    if (!['--input', '--output', '--staging-run', '--hours'].includes(key)
      || Object.hasOwn(options, key) || !value || value.startsWith('--')) throw new Error('Invalid or repeated evidence-preparation option.');
    options[key] = value;
  }
  if (!options['--output'] || (command === 'assemble' && (!options['--input'] || !options['--staging-run']))
    || (command === 'init' && Object.keys(options).length !== 1)
    || (options['--hours'] !== undefined && !/^(?:[1-9]|1\d|2[0-4])$/.test(options['--hours']))) {
    throw new Error('init needs --output; assemble needs --input, --output, --staging-run and optional --hours (1-24).');
  }
  return { command, options };
}
async function main() {
  const { command, options } = parsePreparationArgs(process.argv.slice(2));
  const baseline = await collectReleaseBaseline({ target: command === 'assemble' ? 'production' : 'staging', expectedCommit: process.env.RELEASE_SHA });
  const candidate = { repository: process.env.GITHUB_REPOSITORY ?? repository,
    commit: baseline.source.commit, tree: baseline.source.tree, version: baseline.release.version };
  const result = command === 'init'
    ? await initializeEvidence({ output: options['--output'], candidate })
    : await prepareEvidence({ input: options['--input'], output: options['--output'], candidate,
      stagingRunId: options['--staging-run'], hours: Number(options['--hours'] ?? 12) });
  console.log(JSON.stringify(result, null, 2));
  console.log('No production approval was created. Independent review, detached signatures and release:signoff are still required.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error?.code ? 'Evidence files are missing, unsafe, or output already exists.' : error.message); process.exitCode = 1; });
}
