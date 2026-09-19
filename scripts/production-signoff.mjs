import { createHash, createPublicKey, verify } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectReleaseBaseline, releaseVersionPolicy } from './release-baseline.mjs';

export const SIGNOFF_DOMAIN = 'DealGuard production approval v1\n';
export const SIGNOFF_GATES = Object.freeze({
  source: ['merged_scope_complete', 'unmerged_work_reconciled', 'optional_capabilities_disclosed'],
  ci: ['canonical_workflow', 'worker_and_ui_types', 'full_regression', 'migrations_and_schema'],
  governance: ['required_pr_review', 'required_ci', 'stale_approval_dismissal', 'no_force_push', 'no_branch_deletion', 'production_reviewers', 'production_ref_restrictions'],
  acceptance: ['install', 'upgrade', 'seller', 'manager', 'executive', 'administrator', 'uninstall', 'permission_denial', 'optional_source_failure'],
  security: ['tenant_isolation', 'record_authorization', 'consent_and_erasure', 'injection_and_abuse', 'dependencies', 'independent_review'],
  commercial: ['growth_monthly', 'growth_annual', 'enterprise_monthly', 'enterprise_annual', 'webhook_retries_and_ordering', 'cancellation', 'usage_reconciliation', 'subscription_expiry'],
  intelligence: ['outcome_evaluation', 'ineligible_predictions_disabled', 'native_ai_provider_evaluation', 'ai_budget_enforcement', 'ai_disabled_fallback', 'breeze_disabled_or_approved'],
  load: ['advertised_capacity', 'multiple_tenants', 'provider_rate_limits', 'queue_recovery'],
  recovery: ['encrypted_backup_restore', 'row_integrity', 'object_reference_integrity', 'rollback_rehearsal'],
  pilot: ['consented_accounts', 'customer_workflows', 'blocking_defects_resolved'],
  operations: ['monitoring_alerts', 'on_call_runbooks', 'support_terms', 'installation_docs', 'privacy_security_docs', 'incident_response'],
});
for (const checks of Object.values(SIGNOFF_GATES)) Object.freeze(checks);
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9_-]{1,64}$/;
const DAY = 86_400_000;
const roles = ['release_owner', 'security_reviewer'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function fail(message) { throw new Error(message); }
function clock(value) {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : null;
}
function json(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('Sign-off JSON is invalid.'); }
}
function candidate(value, expected) {
  return object(value) && Object.keys(expected).every(key => value[key] === expected[key]);
}
function exactKeys(value, expected) {
  return object(value) && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

/** Keys are supplied by a protected operator-controlled trust store, never by a dossier. */
export function trustedSigners(trust, now = Date.now()) {
  if (!object(trust) || trust.schemaVersion !== 1 || !Array.isArray(trust.keys)
    || trust.keys.length < 2 || trust.keys.length > 20) fail('Protected sign-off trust configuration is missing or invalid.');
  const keys = new Map(), material = new Set();
  for (const entry of trust.keys) {
    if (!object(entry) || !ID.test(entry.id ?? '') || keys.has(entry.id) || !roles.includes(entry.role)
      || !/^github:[1-9]\d{0,19}$/.test(entry.principal ?? '')
      || typeof entry.publicKeyPem !== 'string' || entry.publicKeyPem.length > 1000
      || !entry.publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----\n') || entry.publicKeyPem.includes('PRIVATE KEY')
      || clock(entry.notBefore) === null || clock(entry.notAfter) === null
      || clock(entry.notBefore) > now || clock(entry.notAfter) <= now) fail('Protected signer identity or key validity is invalid.');
    let key;
    try { key = createPublicKey(entry.publicKeyPem); } catch { fail('Protected sign-off public key is invalid.'); }
    if (key.asymmetricKeyType !== 'ed25519') fail('Production sign-off requires Ed25519 public keys.');
    const fingerprint = digest(key.export({ format: 'der', type: 'spki' }));
    if (material.has(fingerprint)) fail('A signing key cannot represent multiple approvers.');
    material.add(fingerprint); keys.set(entry.id, { ...entry, key });
  }
  return keys;
}

/** All paths are relative report filenames; no URLs, symlinks, devices, or parent traversal. */
export async function readEvidenceFile(root, path, maximum = 1_048_576) {
  if (typeof path !== 'string' || !/^(?:reports\/)?[A-Za-z0-9][A-Za-z0-9_-]*\.json$/.test(path)) fail('Evidence path is not an allowed JSON filename.');
  const resolvedRoot = await realpath(root);
  if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) fail('Evidence root must be a regular directory.');
  let current = resolvedRoot;
  for (const part of path.split('/')) {
    current = resolve(current, part);
    if ((await lstat(current)).isSymbolicLink()) fail('Evidence paths must not contain symlinks.');
  }
  const handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > maximum) fail('Evidence file exceeds its size limit or is not regular.');
    const buffer = Buffer.alloc(maximum + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size || offset > maximum) fail('Evidence file changed or exceeded its size limit.');
    return buffer.subarray(0, offset);
  } finally { await handle.close(); }
}

function reportFailures(report, gate, expected, now, approvedAt) {
  const errors = [];
  const require = (condition, code) => { if (!condition) errors.push(`${gate}: ${code}`); };
  require(object(report) && report.schemaVersion === 1 && report.gate === gate, 'report identity invalid');
  require(candidate(report?.candidate, expected), 'report source does not match candidate');
  const start = clock(report?.startedAt), end = clock(report?.completedAt);
  require(start !== null && end !== null && start <= end && end <= approvedAt && end <= now
    && start >= now - 7 * DAY, 'report timestamps invalid or stale');
  const checks = Array.isArray(report?.checks) ? report.checks : [];
  require(checks.length === SIGNOFF_GATES[gate].length && new Set(checks.map(c => c?.id)).size === checks.length
    && SIGNOFF_GATES[gate].every(id => checks.some(c => c?.id === id && c.status === 'passed')),
  'all required checks must pass exactly once');
  const m = report?.measurements;
  if (gate === 'ci') {
    require(object(m) && Number.isSafeInteger(m.testsPassed) && m.testsPassed > 0
      && m.testsFailed === 0 && m.testsSkipped === 0 && m.testsTotal === m.testsPassed,
    'full regression counts invalid');
    require(m?.workflowPath === '.github/workflows/ci.yml' && /^[1-9]\d*$/.test(m?.runId ?? '')
      && m?.conclusion === 'success', 'canonical CI receipt invalid');
  }
  if (gate === 'security') require(m?.unresolvedCritical === 0 && m?.unresolvedHigh === 0, 'critical or high findings unresolved or unreported');
  if (gate === 'acceptance') require(Array.isArray(m?.hubspotProfiles) && m.hubspotProfiles.length > 0
    && m.hubspotProfiles.every(p => typeof p === 'string' && p.trim() === p && p.length > 0 && p.length <= 120)
    && new Set(m.hubspotProfiles).size === m.hubspotProfiles.length
    && /^[1-9]\d*$/.test(m?.projectBuildId ?? ''), 'supported HubSpot profiles or real project build missing');
  if (gate === 'load') require(Number.isFinite(m?.cachedReadP95Ms) && m.cachedReadP95Ms > 0 && m.cachedReadP95Ms <= 2000
    && Number.isSafeInteger(m?.testedDeals) && m.testedDeals >= 10_000
    && Number.isSafeInteger(m?.concurrentPortals) && m.concurrentPortals >= 2, 'agreed load targets not met');
  if (gate === 'recovery') require(Number.isFinite(m?.rpoSeconds) && m.rpoSeconds >= 0 && m.rpoSeconds <= 3600
    && Number.isFinite(m?.rtoSeconds) && m.rtoSeconds > 0 && m.rtoSeconds <= 14_400
    && m?.providerDatabaseRestored === true && m?.providerObjectsReconciled === true, 'provider recovery targets not met');
  if (gate === 'pilot') require(Array.isArray(m?.accountFingerprints) && m.accountFingerprints.length >= 3
    && m.accountFingerprints.every(p => typeof p === 'string' && HASH.test(p))
    && new Set(m.accountFingerprints).size === m.accountFingerprints.length
    && m?.unresolvedBlockingDefects === 0, 'three distinct consenting pilot accounts and no blockers required');
  return errors;
}

/** Validates evidence integrity and designated approvals, not the truth of an experiment. */
export async function verifyProductionSignoff({ directory, expected, stagingRunId, trust, now = Date.now() }) {
  if (!Number.isFinite(now) || !exactKeys(expected, ['repository', 'commit', 'tree', 'version'])
    || expected.repository !== 'KartikeyAI/hubspot-dealguard' || !SHA.test(expected.commit ?? '') || !SHA.test(expected.tree ?? '')
    || !releaseVersionPolicy(expected.version, 'production').ok || !/^3\.\d+\.\d+$/.test(expected.version)
    || !/^[1-9]\d*$/.test(stagingRunId ?? '')) fail('Production approval requires an exact stable v3 candidate and staging run.');
  const keys = trustedSigners(trust, now);
  const bytes = await readEvidenceFile(directory, 'dossier.json', 131_072);
  const dossier = json(bytes);
  const signatures = json(await readEvidenceFile(directory, 'signatures.json', 16_384));
  if (!exactKeys(dossier, ['schemaVersion', 'kind', 'candidate', 'stagingRunId', 'createdAt', 'expiresAt', 'gates'])
    || dossier.schemaVersion !== 1 || dossier.kind !== 'dealguard-production-approval'
    || !candidate(dossier.candidate, expected) || dossier.stagingRunId !== stagingRunId) fail('Production approval source or staging identity does not match.');
  const issued = clock(dossier.createdAt), expires = clock(dossier.expiresAt);
  if (issued === null || expires === null || issued > now || expires <= now || expires <= issued
    || expires - issued > DAY || now - issued > DAY) fail('Production approval is expired or has invalid timestamps.');
  if (!Array.isArray(signatures) || signatures.length !== 2) fail('Two independent production approvals are required.');
  const accepted = [];
  for (const signature of signatures) {
    if (!exactKeys(signature, ['keyId', 'signature']) || !ID.test(signature.keyId ?? '')
      || typeof signature.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature.signature)) fail('Production approval signature is invalid.');
    const signer = keys.get(signature.keyId);
    const decoded = Buffer.from(signature.signature, 'base64url');
    if (!signer || decoded.length !== 64 || decoded.toString('base64url') !== signature.signature
      || issued < clock(signer.notBefore) || expires > clock(signer.notAfter)
      || !verify(null, Buffer.concat([Buffer.from(SIGNOFF_DOMAIN), bytes]), signer.key, decoded)) fail('Production approval signature is untrusted or invalid.');
    accepted.push({ principal: signer.principal, role: signer.role, keyId: signature.keyId });
  }
  if (new Set(accepted.map(a => a.principal)).size !== 2 || new Set(accepted.map(a => a.role)).size !== 2
    || !roles.every(role => accepted.some(a => a.role === role))) fail('Release owner and security reviewer must be independent approved principals.');
  if (!exactKeys(dossier.gates, Object.keys(SIGNOFF_GATES))) fail('All production gates are required; no waived or unknown gates are accepted.');
  const errors = [], reports = [], paths = new Set();
  for (const gate of Object.keys(SIGNOFF_GATES)) {
    const entry = dossier.gates[gate];
    if (!exactKeys(entry, ['path', 'sha256']) || !/^reports\//.test(entry.path ?? '')
      || !HASH.test(entry.sha256 ?? '') || paths.has(entry.path)) fail('Each gate requires a unique digest-bound report.');
    paths.add(entry.path);
    const content = await readEvidenceFile(directory, entry.path);
    if (digest(content) !== entry.sha256) fail('Production evidence digest mismatch.');
    errors.push(...reportFailures(json(content), gate, expected, now, issued));
    reports.push({ gate, sha256: entry.sha256 });
  }
  if (errors.length) fail(`Production sign-off rejected:\n${errors.map(e => `- ${e}`).join('\n')}`);
  return { schemaVersion: 1, kind: 'verified-production-approval', candidate: expected, stagingRunId,
    verifiedAt: new Date(now).toISOString(), expiresAt: dossier.expiresAt,
    dossierSha256: digest(bytes), approvers: accepted, reports, approvalAccepted: true, productionReady: false };
}

async function main() {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i], value = process.argv[i + 1];
    if (!['--input', '--output'].includes(key) || options[key] !== undefined || !value || value.startsWith('--')) fail('Usage: production-signoff.mjs --input directory [--output receipt.json]');
    options[key] = value;
  }
  if (!options['--input'] || process.env.RELEASE_TARGET !== 'production') fail('Production sign-off requires an explicit evidence directory and production target.');
  const trustInput = process.env.PRODUCTION_SIGNOFF_TRUST_JSON ?? 'null';
  if (Buffer.byteLength(trustInput) > 32_768) fail('Protected sign-off trust configuration exceeds its size limit.');
  const trust = json(Buffer.from(trustInput));
  const baseline = await collectReleaseBaseline({ target: 'production', expectedCommit: process.env.RELEASE_SHA });
  const receipt = await verifyProductionSignoff({ directory: resolve(options['--input']), trust,
    stagingRunId: process.env.STAGING_RUN_ID, expected: { repository: process.env.GITHUB_REPOSITORY,
      commit: baseline.source.commit, tree: baseline.source.tree, version: baseline.release.version } });
  const output = resolve(options['--output'] ?? '.release/production-signoff-receipt.json');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  console.log('Production approval verified for the exact source. Deployment and post-deployment sign-off are still required.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    // Never print report contents, public-key input, provider receipts, or filesystem details.
    console.error(error?.code || error?.status !== undefined ? 'Production sign-off evidence is missing or unreadable.' : error.message);
    process.exitCode = 1;
  });
}
