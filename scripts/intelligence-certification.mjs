import { createHash } from 'node:crypto';

export const INTELLIGENCE_TEST_IDS = Object.freeze(
  Array.from({ length: 12 }, (_, index) => `DG-INT-${String(index + 1).padStart(3, '0')}`),
);

/** Release certification is narrower than an ad-hoc diagnostic run. Never log credentials. */
export function certificationContext(env = process.env, version) {
  return {
    version,
    commit: String(env.RELEASE_SHA ?? env.GITHUB_SHA ?? '').trim(),
    target: String(env.RELEASE_TARGET ?? '').trim(),
    baseUrl: String(env.ACCEPTANCE_BASE_URL ?? env.APP_BASE_URL ?? '').trim(),
    portalId: String(env.ACCEPTANCE_PORTAL_ID ?? '').trim(),
    testDealId: String(env.ACCEPTANCE_TEST_DEAL_ID ?? '').trim(),
    workflowRunId: String(env.GITHUB_RUN_ID ?? '').trim(),
    workflowRunAttempt: String(env.GITHUB_RUN_ATTEMPT ?? '').trim(),
  };
}

function origin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || !['', '/'].includes(url.pathname)) return null;
    return url.origin;
  } catch { return null; }
}

export function contextFailures(context) {
  const failures = [];
  if (!/^[0-9a-f]{40}$/i.test(context.commit ?? '')) failures.push('release commit must be a full SHA');
  if (typeof context.version !== 'string' || !context.version) failures.push('release version is required');
  if (!['staging', 'production'].includes(context.target)) failures.push('release target is invalid');
  const base = origin(context.baseUrl);
  if (!base) failures.push('release base URL must be an HTTPS origin without credentials');
  if (base && context.target === 'production' && base !== 'https://dealguard-api.rokad.co') {
    failures.push('production origin is invalid');
  }
  if (base && context.target === 'staging' && !new URL(base).hostname.includes('staging')) {
    failures.push('staging origin must identify staging');
  }
  for (const field of ['portalId', 'testDealId', 'workflowRunId', 'workflowRunAttempt']) {
    if (!/^[1-9]\d*$/.test(context[field] ?? '')) failures.push(`${field} must be a positive numeric identifier`);
  }
  return failures;
}

/** Recompute coverage; a zero-failure summary alone is never sufficient. */
export function intelligenceEvidenceFailures(evidence, expected, now = Date.now()) {
  const failures = contextFailures(expected);
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return [...failures, 'intelligence evidence is missing'];
  }
  if (evidence.schemaVersion !== 1) failures.push('unsupported intelligence evidence schema');
  if (evidence.profile !== 'intelligence-convergence') failures.push('intelligence profile is invalid');
  if (evidence.release !== expected.version) failures.push('intelligence release version mismatch');
  const environment = evidence.environment ?? {};
  if (environment.certificationRequired !== true) failures.push('diagnostic intelligence evidence cannot certify a release');
  const identities = {
    gitSha: expected.commit, releaseTarget: expected.target, portalId: expected.portalId,
    testDealId: expected.testDealId, workflowRunId: expected.workflowRunId,
    workflowRunAttempt: expected.workflowRunAttempt,
  };
  for (const [field, value] of Object.entries(identities)) {
    if (environment[field] !== value) failures.push(`intelligence ${field} mismatch`);
  }
  if (!origin(environment.baseUrl) || origin(environment.baseUrl) !== origin(expected.baseUrl)) {
    failures.push('intelligence base URL mismatch');
  }
  const start = Date.parse(evidence.startedAt);
  const end = Date.parse(evidence.finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end > now + 60_000
    || start > now + 60_000 || now - start > 24 * 60 * 60 * 1000) {
    failures.push('intelligence evidence must have ordered timestamps within the last 24 hours');
  }
  const results = Array.isArray(evidence.results) ? evidence.results : [];
  const ids = results.map((item) => item?.id);
  if (ids.length !== INTELLIGENCE_TEST_IDS.length || new Set(ids).size !== ids.length
    || INTELLIGENCE_TEST_IDS.some((id) => !ids.includes(id))) {
    failures.push('intelligence evidence must contain each DG-INT-001 through DG-INT-012 exactly once');
  }
  if (results.some((item) => item?.status !== 'passed' || item?.required !== true)) {
    failures.push('every intelligence certification test must be required and passed');
  }
  const counts = {
    passed: results.filter((item) => item?.status === 'passed').length,
    failed: results.filter((item) => item?.status === 'failed').length,
    skipped: results.filter((item) => item?.status === 'skipped').length,
    requiredFailed: results.filter((item) => item?.required && item?.status === 'failed').length,
  };
  for (const [field, value] of Object.entries(counts)) {
    if (evidence.summary?.[field] !== value) failures.push(`intelligence summary ${field} does not match results`);
  }
  if (counts.passed !== 12 || counts.failed !== 0 || counts.skipped !== 0) {
    failures.push('intelligence certification requires 12 passed tests and zero skipped or failed tests');
  }
  if (results.find((item) => item?.id === 'DG-INT-001')?.actual?.entitled !== true) {
    failures.push('intelligence certification requires active Enterprise entitlement');
  }
  return [...new Set(failures)];
}

/** Fingerprint the embedded sanitized evidence; this is integrity, not a signature/attestation. */
export function intelligenceFingerprint(evidence) {
  return createHash('sha256').update(JSON.stringify(evidence ?? null)).digest('hex');
}

export function stagingRunFailures(metadata, record, expectedRepository, expectedRunId) {
  const failures = [];
  if (!/^[1-9]\d*$/.test(expectedRunId ?? '')) failures.push('selected staging run ID is invalid');
  if (!metadata || metadata.status !== 'completed' || metadata.conclusion !== 'success') {
    failures.push('selected staging workflow run did not complete successfully');
  }
  if (!expectedRepository || metadata?.repository?.full_name !== expectedRepository
    || record.repository !== expectedRepository) failures.push('staging repository mismatch');
  if (String(metadata?.id ?? '') !== expectedRunId || record.runId !== expectedRunId) {
    failures.push('staging workflow run ID mismatch');
  }
  if (String(metadata?.run_attempt ?? '') !== record.runAttempt) failures.push('staging workflow attempt mismatch');
  if (metadata?.event !== 'workflow_dispatch' || metadata?.path !== '.github/workflows/controlled-deploy.yml'
    || record.workflow !== 'Controlled deploy') failures.push('staging evidence is not from Controlled deploy');
  // head_sha identifies the workflow ref, not necessarily the separately checked-out RELEASE_SHA.
  return failures;
}

export function liveEvidenceFailures(evidence, expected, full) {
  const failures = [];
  const results = Array.isArray(evidence?.results) ? evidence.results : [];
  const ids = results.map((item) => item?.id);
  const requiredIds = Array.from({ length: full ? 14 : 7 }, (_, index) => `DG-LIVE-${String(index + 1).padStart(3, '0')}`);
  if (new Set(ids).size !== ids.length || results.length !== 14
    || Array.from({ length: 14 }, (_, index) => `DG-LIVE-${String(index + 1).padStart(3, '0')}`).some((id) => !ids.includes(id))) {
    failures.push('signed acceptance must contain all 14 unique test results');
  }
  for (const id of requiredIds) {
    const result = results.find((item) => item?.id === id);
    // Manual Enterprise contracts have no Dodo subscription to preview. Retain the documented conditional test.
    const optionalPlanPreview = id === 'DG-LIVE-013' && result?.status === 'skipped' && result.required === false
      && result.actual?.reason === 'Portal has no Dodo subscription.';
    if (!optionalPlanPreview && (result?.status !== 'passed' || result.required !== true)) {
      failures.push(`signed acceptance ${id} did not pass`);
    }
  }
  if (results.some((item) => !['passed', 'failed', 'skipped'].includes(item?.status)
    || item.status === 'failed' || (item.required && item.status === 'skipped'))) failures.push('signed acceptance did not pass');
  for (const status of ['passed', 'failed', 'skipped']) {
    if (evidence?.summary?.[status] !== results.filter((item) => item?.status === status).length) {
      failures.push(`signed acceptance summary ${status} does not match results`);
    }
  }
  if (evidence?.schemaVersion !== 1 || evidence?.release !== expected.version) failures.push('signed acceptance release identity is invalid');
  if (evidence?.profile !== (full ? 'full' : 'read-only')) failures.push('signed acceptance profile mismatch');
  const environment = evidence?.environment ?? {};
  for (const [field, value] of Object.entries({ gitSha: expected.commit, releaseTarget: expected.target,
    portalId: expected.portalId, testDealId: expected.testDealId, workflowRunId: expected.workflowRunId,
    workflowRunAttempt: expected.workflowRunAttempt })) {
    if (environment[field] !== value) failures.push(`signed acceptance ${field} mismatch`);
  }
  if (!origin(environment.baseUrl) || origin(environment.baseUrl) !== origin(expected.baseUrl)) failures.push('signed acceptance base URL mismatch');
  return failures;
}

/** Shared validation prevents record generation and promotion from drifting apart. */
export function deploymentEvidenceFailures(record, now = Date.now()) {
  if (!record || typeof record !== 'object') return ['deployment record is missing'];
  const failures = [];
  if (record.schemaVersion !== 4) failures.push('unsupported staging evidence schema');
  const context = record.acceptanceContext ?? {};
  const full = record.acceptance?.profile === 'full';
  if (!/^[0-9a-f]{40}$/i.test(record.commit ?? '')) failures.push('release commit is not a full SHA');
  if (!['production', 'staging'].includes(record.target)) failures.push('deployment target is invalid');
  if (record.target === 'production' && (!full || !/^\d+\.\d+\.\d+$/.test(record.version ?? ''))) failures.push('production requires stable version and full acceptance');
  for (const [field, value] of Object.entries({ commit: record.commit, target: record.target, version: record.version,
    workflowRunId: record.runId, workflowRunAttempt: record.runAttempt })) {
    if (context[field] !== value) failures.push(`deployment context ${field} mismatch`);
  }
  const contextErrors = contextFailures(context);
  failures.push(...contextErrors.filter((failure) => full || !failure.startsWith('testDealId')));
  if (!record.backupReference) failures.push('backup reference is missing');
  else {
    if (!/^backups\/[a-z0-9_-]+\/[A-Za-z0-9._/-]+\.enc$/.test(record.backupReference)
      || record.backupReference.split('/').some((part) => ['', '.', '..'].includes(part))) failures.push('backup reference is not an encrypted Tigris object key');
    if (!record.backupReference.startsWith(`backups/${record.target}/`)) failures.push('backup reference does not match deployment target');
  }
  if (!/^[0-9a-f]{64}$/.test(record.backupSha256 ?? '')) failures.push('backup SHA-256 is missing or invalid');
  if (!Number.isInteger(record.preflight?.total) || record.preflight.total <= 0
    || record.preflight.failed !== 0 || record.preflight.passed !== record.preflight.total) failures.push('release preflight did not pass');
  if (record.health?.status !== 'ok' || record.health?.service !== 'dealguard-api') failures.push('deployed health identity is invalid');
  if (record.health?.version !== record.version) failures.push('deployed health version does not match package version');
  if (record.baseline?.source?.commit !== record.commit || record.baseline?.target !== record.target
    || record.baseline?.release?.version !== record.version || record.baseline?.source?.clean !== true
    || record.baseline?.verification?.repository !== 'passed') failures.push('repository baseline does not match deployment');
  const smoke = record.smoke;
  const checks = Array.isArray(smoke?.checks) ? smoke.checks : [];
  const smokeIds = checks.map((item) => item?.id);
  if (checks.length !== 7 || new Set(smokeIds).size !== 7
    || Array.from({ length: 7 }, (_, index) => `DG-PROD-${String(index + 1).padStart(3, '0')}`).some((id) => !smokeIds.includes(id))
    || checks.some((item) => item?.result !== 'passed') || smoke?.summary?.total !== 7
    || smoke?.summary?.passed !== 7 || smoke?.summary?.failed !== 0) failures.push('public deployment smoke did not pass');
  if (smoke?.expectedVersion !== record.version || smoke?.commit !== record.commit || smoke?.target !== record.target
    || !origin(smoke?.baseUrl) || origin(smoke.baseUrl) !== origin(context.baseUrl)) failures.push('public smoke release context mismatch');
  failures.push(...liveEvidenceFailures(record.acceptance, context, full));
  if (full) {
    failures.push(...intelligenceEvidenceFailures(record.intelligence, context, now));
    if (record.intelligenceSha256 !== intelligenceFingerprint(record.intelligence)) failures.push('intelligence evidence fingerprint mismatch');
  }
  return [...new Set(failures)];
}
