import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Repository } from '../dist/repository.js';

const at = new Date(Date.now() - 1000).toISOString();
const assessment = { dealId: '1', assessedAt: at, isClosed: true, isWon: true,
  status: 'ready', score: 80, issues: [], handoffEligible: true };
const identity = { portalId: '100', userId: '1', userEmail: 'user@example.test' };
function fixture(row) {
  const calls = [];
  const env = { DB: { prepare(sql) { return { bind(...params) { return {
    async first() { calls.push({ sql, params }); return row; }
  }; } }; } } };
  const repo = new Repository(env);
  repo.audit = async (...args) => calls.push({ audit: args });
  return { repo, calls };
}
test('assessment persistence reports database acceptance, not an assumed write', async () => {
  for (const row of [null, { deal_id: '1' }]) {
    const { repo, calls } = fixture(row);
    assert.equal(await repo.saveAssessment('100', assessment), !!row);
    assert.match(calls[0].sql, /RETURNING deal_id/);
    assert.match(calls[0].sql, /excluded.assessed_at::timestamptz > deal_assessments.assessed_at::timestamptz/);
  }
});
test('assessment persistence rejects invalid and future observations before SQL', async () => {
  const { repo, calls } = fixture({ deal_id: '1' });
  for (const value of ['bad', '2026-02-30T00:00:00Z', new Date(Date.now()+100000).toISOString()]) {
    await assert.rejects(repo.saveAssessment('100', { ...assessment, assessedAt: value }), { code: 'invalid_assessment_time' });
  }
  assert.equal(calls.length, 0);
});
test('confirmation uses the committed timestamp and only audits its first transition', async () => {
  for (const result of ['confirmed', 'already_confirmed']) {
    const { repo, calls } = fixture({ result, confirmation_time: at, cycle: 2 });
    assert.deepEqual(await repo.confirmHandoff(identity, '1', assessment), {
      changed: result === 'confirmed', confirmedAt: at, cycle: 2,
    });
    assert.equal(calls.filter(x => x.audit).length, result === 'confirmed' ? 1 : 0);
  }
});
test('stale or ineligible handoff cannot confirm or audit', async () => {
  for (const result of ['stale_assessment', 'not_eligible', 'not_found', 'cycle_conflict', 'identity_required']) {
    const { repo, calls } = fixture({ result });
    await assert.rejects(repo.confirmHandoff(identity, '1', assessment), { code: 'handoff_not_confirmable' });
    assert.equal(calls.filter(x => x.audit).length, 0);
  }
});
test('misaddressed handoff fails before database execution', async () => {
  const { repo, calls } = fixture(null);
  await assert.rejects(repo.confirmHandoff(identity, '2', assessment), { code: 'handoff_assessment_mismatch' });
  assert.equal(calls.length, 0);
});
test('handoff migration is additive, preserves unknown legacy starts, and locks assessment before handoff', () => {
  const sql = readFileSync('database/migrations/0023_handoff_lifecycle.sql', 'utf8');
  assert.match(sql, /'legacy_unknown'/);
  assert.match(sql, /PRIMARY KEY \(portal_id, deal_id, cycle_number\)/);
  assert.match(sql, /FOR EACH ROW EXECUTE FUNCTION dealguard.advance_handoff_cycle/);
  assert.match(sql, /IF NEW.assessed_at::timestamptz <= OLD.assessed_at::timestamptz THEN RETURN NULL/);
  assert.doesNotMatch(sql, /SECURITY DEFINER|DROP TABLE|TRUNCATE/);
});
