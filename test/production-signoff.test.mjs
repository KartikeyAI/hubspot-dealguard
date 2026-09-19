import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { digest, readEvidenceFile, SIGNOFF_DOMAIN, SIGNOFF_GATES, trustedSigners, verifyProductionSignoff } from '../scripts/production-signoff.mjs';

// Synthetic evidence and ephemeral test keys. None of these results authorize a real release.
const NOW = Date.parse('2026-09-19T12:00:00.000Z');
const iso = delta => new Date(NOW + delta).toISOString();
const expected = { repository: 'KartikeyAI/hubspot-dealguard', commit: 'a'.repeat(40), tree: 'b'.repeat(40), version: '3.0.0' };
const day = 86_400_000;
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dg-signoff-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'reports'));
  const pairs = ['release_owner', 'security_reviewer'].map(role => ({ role, ...generateKeyPairSync('ed25519') }));
  const trust = { schemaVersion: 1, keys: pairs.map((key, i) => ({ id: `test-key-${i}`, role: key.role,
    principal: `github:${i + 1}`, publicKeyPem: key.publicKey.export({ format: 'pem', type: 'spki' }),
    notBefore: iso(-day), notAfter: iso(day) })) };
  const dossier = { schemaVersion: 1, kind: 'dealguard-production-approval', candidate: { ...expected },
    stagingRunId: '123', createdAt: iso(-60_000), expiresAt: iso(60_000), gates: {} };
  const reports = {};
  for (const [gate, checks] of Object.entries(SIGNOFF_GATES)) {
    reports[gate] = { schemaVersion: 1, gate, candidate: { ...expected }, startedAt: iso(-3600_000), completedAt: iso(-120_000),
      checks: checks.map(id => ({ id, status: 'passed' })) };
  }
  reports.ci.measurements = { testsPassed: 581, testsTotal: 581, testsFailed: 0, testsSkipped: 0,
    workflowPath: '.github/workflows/ci.yml', runId: '456', conclusion: 'success' };
  reports.security.measurements = { unresolvedCritical: 0, unresolvedHigh: 0 };
  reports.acceptance.measurements = { hubspotProfiles: ['Sales Enterprise / test'], projectBuildId: '789' };
  reports.load.measurements = { cachedReadP95Ms: 1000, testedDeals: 10_000, concurrentPortals: 3 };
  reports.recovery.measurements = { rpoSeconds: 300, rtoSeconds: 3600, providerDatabaseRestored: true, providerObjectsReconciled: true };
  reports.pilot.measurements = { accountFingerprints: [digest('portal 1'), digest('portal 2'), digest('portal 3')], unresolvedBlockingDefects: 0 };
  async function putReports() {
    for (const [gate, report] of Object.entries(reports)) {
      const bytes = Buffer.from(JSON.stringify(report));
      await writeFile(join(directory, 'reports', `${gate}.json`), bytes);
      dossier.gates[gate] = { path: `reports/${gate}.json`, sha256: digest(bytes) };
    }
  }
  async function signDossier() {
    const bytes = Buffer.from(JSON.stringify(dossier));
    await writeFile(join(directory, 'dossier.json'), bytes);
    await writeFile(join(directory, 'signatures.json'), JSON.stringify(pairs.map((key, i) => ({ keyId: `test-key-${i}`,
      signature: sign(null, Buffer.concat([Buffer.from(SIGNOFF_DOMAIN), bytes]), key.privateKey).toString('base64url') }))));
  }
  const verify = (overrides = {}) => verifyProductionSignoff({ directory, expected, stagingRunId: '123', trust, now: NOW, ...overrides });
  await putReports(); await signDossier();
  return { directory, trust, dossier, reports, pairs, putReports, signDossier, verify };
}

test('complete signed evidence authorizes only the exact preproduction candidate, not production readiness', async t => {
  const f = await fixture(t); const result = await f.verify();
  assert.equal(result.approvalAccepted, true); assert.equal(result.productionReady, false);
  assert.deepEqual(result.candidate, expected); assert.equal(result.reports.length, 11);
  assert.equal(result.approvers.length, 2); assert.match(result.dossierSha256, /^[a-f0-9]{64}$/);
});

for (const field of ['commit', 'tree', 'version', 'repository']) {
  test(`signed source cannot substitute ${field}`, async t => {
    const f = await fixture(t); f.dossier.candidate[field] += 'x'; await f.signDossier();
    await assert.rejects(f.verify(), /identity does not match/);
  });
}
for (const version of ['3.0.0-alpha.1', '3.0.0-beta.2', '3.0.0-rc.1', '3.0.0+build', '03.0.0', '2.1.0']) {
  test(`sign-off cannot certify ${version}`, async t => {
    const f = await fixture(t); await assert.rejects(f.verify({ expected: { ...expected, version } }), /stable v3/);
  });
}
test('approval pins the verified staging workflow, not just the release', async t => {
  const f = await fixture(t); await assert.rejects(f.verify({ stagingRunId: '999' }), /identity does not match/);
});
for (const change of [d => d.expiresAt = iso(-1), d => d.createdAt = iso(1), d => d.expiresAt = iso(2 * day),
  d => d.createdAt = '2026-02-30T12:00:00.000Z', d => d.createdAt = '2026-09-19 11:59:00Z']) {
  test('expired, future, oversized or noncanonical approval clocks fail closed', async t => {
    const f = await fixture(t); change(f.dossier); await f.signDossier(); await assert.rejects(f.verify(), /timestamps|expired/);
  });
}
test('editing even harmless dossier whitespace invalidates signatures', async t => {
  const f = await fixture(t); await writeFile(join(f.directory, 'dossier.json'), JSON.stringify(f.dossier, null, 2));
  await assert.rejects(f.verify(), /signature/);
});
test('dossier cannot nominate its own public keys', async t => {
  const f = await fixture(t); f.dossier.trust = f.trust; await f.signDossier();
  await assert.rejects(f.verify(), /identity does not match/);
});
test('two key IDs cannot reuse one signing key', async t => {
  const f = await fixture(t); f.trust.keys[1].publicKeyPem = f.trust.keys[0].publicKeyPem;
  await assert.rejects(f.verify(), /multiple approvers/);
});
test('two keys for the same principal do not count as independent approval', async t => {
  const f = await fixture(t); f.trust.keys[1].principal = f.trust.keys[0].principal;
  await assert.rejects(f.verify(), /independent/);
});
test('two release owners cannot substitute the security reviewer', async t => {
  const f = await fixture(t); f.trust.keys[1].role = 'release_owner';
  await assert.rejects(f.verify(), /independent/);
});
test('unknown keys, malformed signatures and missing signatures cannot approve', async t => {
  const f = await fixture(t); const signatures = JSON.parse(await readFile(join(f.directory, 'signatures.json')));
  for (const invalid of [[], [signatures[0]], [signatures[0], signatures[0]],
    [signatures[0], { ...signatures[1], keyId: 'untrusted' }],
    [signatures[0], { ...signatures[1], signature: 'A'.repeat(86) }]]) {
    await writeFile(join(f.directory, 'signatures.json'), JSON.stringify(invalid));
    await assert.rejects(f.verify(), /signature|approvals|independent/);
  }
});
test('missing, expired and non-Ed25519 protected trust is rejected', async t => {
  const f = await fixture(t);
  assert.throws(() => trustedSigners(null, NOW), /trust/);
  f.trust.keys[0].notAfter = iso(-1); assert.throws(() => trustedSigners(f.trust, NOW), /validity/);
  f.trust.keys[0].notAfter = iso(day);
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  f.trust.keys[0].publicKeyPem = pair.publicKey.export({ format: 'pem', type: 'spki' });
  assert.throws(() => trustedSigners(f.trust, NOW), /Ed25519/);
});
for (const gate of Object.keys(SIGNOFF_GATES)) {
  test(`${gate} is mandatory even with otherwise valid approvals`, async t => {
    const f = await fixture(t); delete f.dossier.gates[gate]; await f.signDossier();
    await assert.rejects(f.verify(), /All production gates/);
  });
  test(`${gate} cannot report failed, skipped, missing or duplicated checks`, async t => {
    const f = await fixture(t); const original = structuredClone(f.reports[gate]);
    for (const change of [r => r.checks[0].status = 'failed', r => r.checks[0].status = 'skipped', r => r.checks.pop(),
      r => r.checks[1] = r.checks[0], r => r.checks = []]) {
      f.reports[gate] = structuredClone(original); change(f.reports[gate]); await f.putReports(); await f.signDossier();
      await assert.rejects(f.verify(), /required checks/);
    }
  });
}
test('reports from other source, stale runs, or runs after approval cannot certify', async t => {
  const f = await fixture(t);
  for (const change of [r => r.candidate.tree = 'c'.repeat(40), r => r.startedAt = iso(-8 * day),
    r => r.completedAt = iso(1), r => r.startedAt = iso(1)]) {
    const original = structuredClone(f.reports.ci); change(f.reports.ci); await f.putReports(); await f.signDossier();
    await assert.rejects(f.verify(), /source|timestamps/); f.reports.ci = original;
  }
});
test('tampered report bytes cannot be approved using an old signed descriptor', async t => {
  const f = await fixture(t); await writeFile(join(f.directory, 'reports', 'ci.json'), '{}');
  await assert.rejects(f.verify(), /digest mismatch/);
});
test('real metrics are required rather than green summaries alone', async t => {
  const f = await fixture(t);
  for (const [gate, change] of [['ci', m => m.testsSkipped = 1], ['ci', m => m.testsTotal = 0],
    ['security', m => m.unresolvedHigh = 1], ['acceptance', m => m.projectBuildId = null],
    ['load', m => m.testedDeals = 100], ['load', m => m.cachedReadP95Ms = 3000], ['load', m => m.concurrentPortals = 1],
    ['recovery', m => m.providerObjectsReconciled = false], ['recovery', m => m.rpoSeconds = 3601],
    ['recovery', m => m.rtoSeconds = 14401], ['pilot', m => m.accountFingerprints[1] = m.accountFingerprints[0]],
    ['pilot', m => m.unresolvedBlockingDefects = 1]]) {
    const original = structuredClone(f.reports[gate]); change(f.reports[gate].measurements); await f.putReports(); await f.signDossier();
    await assert.rejects(f.verify(), /rejected/); f.reports[gate] = original;
  }
});
test('report traversal, absolute paths and URLs are never followed', async t => {
  const f = await fixture(t);
  for (const path of ['../private.json', '/etc/passwd', 'reports/../../private.json', 'reports/http://host/x.json', 'https://host/x.json']) {
    f.dossier.gates.ci.path = path; await f.signDossier(); await assert.rejects(f.verify());
  }
});
test('symlinked files, report directories and evidence roots are rejected', async t => {
  const f = await fixture(t); await writeFile(join(f.directory, 'outside.json'), '{}');
  await symlink(join(f.directory, 'outside.json'), join(f.directory, 'link.json'));
  await assert.rejects(readEvidenceFile(f.directory, 'link.json'), /symlink/);
  await symlink(join(f.directory, 'reports'), join(f.directory, 'alias'));
  await assert.rejects(readEvidenceFile(join(f.directory, 'alias'), 'ci.json'), /regular directory/);
  await rm(join(f.directory, 'reports'), { recursive: true });
  await symlink(f.directory, join(f.directory, 'reports'));
  await assert.rejects(readEvidenceFile(f.directory, 'reports/outside.json'), /symlink/);
});
test('oversized reports and invalid UTF-8 never print evidence data', async t => {
  const f = await fixture(t); await writeFile(join(f.directory, 'large.json'), ' '.repeat(1025));
  await assert.rejects(readEvidenceFile(f.directory, 'large.json', 1024), /size limit/);
  await writeFile(join(f.directory, 'dossier.json'), Buffer.from([0xff, 0xfe]));
  await assert.rejects(f.verify(), /JSON is invalid/);
});
test('CLI refuses the current alpha and never emits a successful approval', async t => {
  const f = await fixture(t); const output = join(f.directory, 'receipt.json');
  const result = spawnSync(process.execPath, [resolve('scripts/production-signoff.mjs'), '--input', f.directory, '--output', output],
    { encoding: 'utf8', env: { ...process.env, RELEASE_TARGET: 'production', PRODUCTION_SIGNOFF_TRUST_JSON: JSON.stringify(f.trust) }, timeout: 10_000 });
  assert.notEqual(result.status, 0); await assert.rejects(readFile(output), { code: 'ENOENT' });
  assert.doesNotMatch(result.stderr, /BEGIN PUBLIC KEY|portal 1/);
});

test('approval cannot predate a signer or outlive its key authorization', async t => {
  const f = await fixture(t); const start = f.trust.keys[0].notBefore;
  f.trust.keys[0].notBefore = iso(-1000);
  await assert.rejects(f.verify(), /signature/);
  f.trust.keys[0].notBefore = start; f.trust.keys[0].notAfter = iso(1000);
  await assert.rejects(f.verify(), /signature/);
});
test('protected trust rejects accidental private-key material', async t => {
  const f = await fixture(t);
  f.trust.keys[0].publicKeyPem = f.pairs[0].privateKey.export({ format:'pem', type:'pkcs8' });
  await assert.rejects(f.verify(), /validity/);
});
