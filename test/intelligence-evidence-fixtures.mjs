// Test-only evidence. Never used by the Worker, release workflow or acceptance runtime.
import { intelligenceFingerprint, INTELLIGENCE_TEST_IDS } from '../scripts/intelligence-certification.mjs';

export function context(version = '2.1.0', target = 'staging') {
  return { version, commit: 'a'.repeat(40), target,
    baseUrl: target === 'staging' ? 'https://dealguard-api-staging.rokad.co' : 'https://dealguard-api.rokad.co',
    portalId: '123', testDealId: '987', workflowRunId: '456', workflowRunAttempt: '1' };
}
export function intelligenceEvidence(expected = context()) {
  return { schemaVersion: 1, release: expected.version, profile: 'intelligence-convergence',
    startedAt: new Date(Date.now() - 2000).toISOString(), finishedAt: new Date(Date.now() - 1000).toISOString(),
    environment: { certificationRequired: true, gitSha: expected.commit, releaseTarget: expected.target,
      baseUrl: expected.baseUrl, portalId: expected.portalId, testDealId: expected.testDealId,
      workflowRunId: expected.workflowRunId, workflowRunAttempt: expected.workflowRunAttempt },
    summary: { passed: 12, failed: 0, skipped: 0, requiredFailed: 0 },
    results: INTELLIGENCE_TEST_IDS.map((id) => ({ id, status: 'passed', required: true, actual: id === 'DG-INT-001' ? { entitled: true } : {} })) };
}
export function deploymentRecord(version = '2.1.0', target = 'staging') {
  const expected = context(version, target);
  const intelligence = intelligenceEvidence(expected);
  const acceptance = { ...structuredClone(intelligence), profile: 'full',
    summary: { passed: 14, failed: 0, skipped: 0, requiredFailed: 0 },
    results: Array.from({ length: 14 }, (_, index) => ({ id: `DG-LIVE-${String(index + 1).padStart(3, '0')}`, status: 'passed', required: true })) };
  return { schemaVersion: 4, repository: 'KartikeyAI/hubspot-dealguard', workflow: 'Controlled deploy',
    runId: expected.workflowRunId, runAttempt: expected.workflowRunAttempt, target, version,
    commit: expected.commit, acceptanceContext: expected, result: 'passed', promotable: target === 'staging',
    backupReference: `backups/${target}/test.sql.enc`, backupSha256: 'b'.repeat(64),
    preflight: { total: 48, passed: 48, failed: 0 },
    health: { service: 'dealguard-api', status: 'ok', version },
    baseline: { target, source: { commit: expected.commit, clean: true }, release: { version }, verification: { repository: 'passed' } },
    smoke: { target, commit: expected.commit, baseUrl: expected.baseUrl, expectedVersion: version,
      summary: { total: 7, passed: 7, failed: 0 },
      checks: Array.from({ length: 7 }, (_, index) => ({ id: `DG-PROD-${String(index + 1).padStart(3, '0')}`, result: 'passed' })) },
    acceptance, intelligence, intelligenceSha256: intelligenceFingerprint(intelligence) };
}
export function workflowMetadata() {
  return { id: 456, run_attempt: 1, event: 'workflow_dispatch', path: '.github/workflows/controlled-deploy.yml',
    status: 'completed', conclusion: 'success', repository: { full_name: 'KartikeyAI/hubspot-dealguard' },
    head_sha: 'c'.repeat(40) };
}
