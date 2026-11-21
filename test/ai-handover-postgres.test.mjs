import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, databaseUrl } from './helpers/postgres-fixture.mjs';
import { aiAssistance, aiAdministration } from '../dist/ai-assistance.js';
import { loadAiEvidence } from '../dist/ai-evidence.js';
import { aiConfiguration } from '../dist/ai-provider.js';
import { changeIntelligenceConsent } from '../dist/intelligence-consent.js';
import { sha256Hex } from '../dist/crypto.js';
import { buildSourceEvidence } from '../dist/source-evidence.js';

const output = { sections: [{ heading: 'handover', text: 'Review the recorded handoff gaps with the delivery team before confirming readiness.', evidenceIds: ['handoff_status', 'issue_count'] }] };
const response = () => Response.json({ status: 'completed', model: 'approved-test-model', usage: { input_tokens: 100, output_tokens: 50 },
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] });
async function setup(t, closed = true, won = true) {
  const f = await fixture(t, 'ai-handoff');
  const actor = { portalId: f.portal, userId: '7', userEmail: 'admin@example.test', appId: 'fixture' };
  const source = new Date(Date.now() - 3600000).toISOString();
  await f.first.query(`INSERT INTO enterprise_role_assignments(id,portal_id,user_id,role,created_at,updated_at)
    VALUES($1,$2,'7','administrator',$3,$3)`, [randomUUID(), f.portal, source]);
  await f.first.query(`INSERT INTO deal_assessments(portal_id,deal_id,deal_name,pipeline_label,stage_label,score,grade,status,
    readiness_summary,issues_json,is_closed,is_won,handoff_eligible,assessed_at)
    VALUES($1,'101','Private customer name','Pipeline','Stage',80,'B','at_risk','Private context',
      '[{"code":"missing_owner","message":"Private account details"}]',$2,$3,0,$4)`, [f.portal, closed ? 1 : 0, won ? 1 : 0, source]);
  Object.assign(f.env, { DEALGUARD_AI_ENABLED: 'true', DEALGUARD_AI_MODEL: 'approved-test-model',
    DEALGUARD_AI_API_KEY: 'not-a-real-provider-key', DEALGUARD_AI_PRICING_VERIFIED_AT: new Date(Date.now() - 1000).toISOString(),
    DEALGUARD_AI_INPUT_USD_PER_MILLION: '1', DEALGUARD_AI_OUTPUT_USD_PER_MILLION: '2', TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') });
  await changeIntelligenceConsent(f.env, actor, 'ai', { enabled: true, revision: 0, confirmation: 'ENABLE_AI' });
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => response();
  return { ...f, actor, source, input: { dealId: '101', purpose: 'handover', requestKey: randomUUID() } };
}

test('closed-won AI handovers are scoped to the exact current cycle', { skip: !databaseUrl, concurrency: false }, async t => {
  await t.test('closed-won handover includes real cycle and missing-evidence facts, with encrypted idempotent caching', async t => {
    const f = await setup(t);
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls++;
      assert(!init.body.includes('Private'));
      const packet = JSON.parse(JSON.parse(init.body).input);
      assert.equal(packet.purpose, 'handover');
      assert.equal(packet.facts.find(x => x.id === 'handoff_cycle').value, 1);
      assert.equal(packet.facts.find(x => x.id === 'documents_verified').value, false);
      assert.equal(packet.facts.find(x => x.id === 'handoff_ready').value, false);
      assert(packet.facts.every(x => x.sourceAt));
      return response();
    };
    const result = await aiAssistance(f.env, f.actor, f.input);
    assert.equal(result.handoffCycle, 1);
    assert.equal(result.actionsExecuted, false);
    assert.equal(result.requiresHumanReview, true);
    assert.equal((await aiAssistance(f.env, f.actor, f.input)).cached, true);
    assert.equal(calls, 1);
    const run = (await f.first.query('SELECT * FROM ai_runs WHERE portal_id=$1', [f.portal])).rows[0];
    assert.equal(run.handoff_cycle, 1);
    assert.equal(run.state, 'completed');
    assert(!run.response_cipher.includes('delivery team'));
    assert.equal((await aiAdministration(f.env, f.actor)).usage.requests, 1);
  });
  await t.test('purpose cannot silently switch lifecycle or consume budget for unsupported evidence', async t => {
    const open = await setup(t, false, false);
    await assert.rejects(aiAssistance(open.env, open.actor, open.input), { code: 'ai_evidence_unavailable' });
    assert.equal((await aiAdministration(open.env, open.actor)).usage.requests, 0);
    const lost = await setup(t, true, false);
    await assert.rejects(aiAssistance(lost.env, lost.actor, lost.input), { code: 'ai_evidence_unavailable' });
    const won = await setup(t);
    await assert.rejects(aiAssistance(won.env, won.actor, { ...won.input, purpose: 'risk' }), { code: 'ai_evidence_unavailable' });
    await assert.rejects(aiAssistance(won.env, { ...won.actor, portalId: won.other }, won.input), { code: 'intelligence_consent_required' });
  });
  await t.test('confirmation during generation invalidates the draft without losing cost accounting', async t => {
    const f = await setup(t);
    globalThis.fetch = async () => {
      const result = await f.second.query("SELECT * FROM dealguard.confirm_handoff_cycle($1,'101',$2,'7',NULL)", [f.portal, f.source]);
      assert.equal(result.rows[0].result, 'confirmed');
      return response();
    };
    await assert.rejects(aiAssistance(f.env, f.actor, f.input), { code: 'ai_evidence_changed' });
    const row = (await f.first.query('SELECT state,response_cipher,accounted_micro FROM ai_runs WHERE portal_id=$1', [f.portal])).rows[0];
    assert.equal(row.state, 'failed');
    assert.equal(row.response_cipher, null);
    assert.equal(Number(row.accounted_micro), 200);
  });
  await t.test('reopening and later winning creates a new handover and rejects the old request', async t => {
    const f = await setup(t);
    globalThis.fetch = async () => {
      await f.second.query('UPDATE deal_assessments SET is_closed=0,is_won=0,assessed_at=$2 WHERE portal_id=$1', [f.portal, new Date(Date.parse(f.source) + 1000).toISOString()]);
      await f.second.query('UPDATE deal_assessments SET is_closed=1,is_won=1,assessed_at=$2 WHERE portal_id=$1', [f.portal, new Date(Date.parse(f.source) + 2000).toISOString()]);
      return response();
    };
    await assert.rejects(aiAssistance(f.env, f.actor, f.input), { code: 'ai_evidence_changed' });
    globalThis.fetch = async () => response();
    const next = await aiAssistance(f.env, f.actor, { ...f.input, requestKey: randomUUID() });
    assert.equal(next.handoffCycle, 2);
    const old = (await f.first.query('SELECT state,response_cipher FROM ai_runs WHERE portal_id=$1 AND request_key=$2', [f.portal, f.input.requestKey])).rows[0];
    assert.equal(old.state, 'failed');
    assert.equal(old.response_cipher, null);
  });
  await t.test('SQL settlement rejects a changed cycle even if an old worker misses the application check', async t => {
    const f = await setup(t);
    const evidence = await loadAiEvidence(f.env, f.actor, '101', 'ai.use', 'handover');
    const model = await sha256Hex(aiConfiguration(f.env).revision);
    const params = [f.portal, f.input.requestKey, '7', '101', 'handover', evidence.fingerprint, model, 1, f.source, null, 35168, 'lease'];
    const oldAdmission = await f.first.query('SELECT dealguard.reserve_ai_run($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) result', params);
    assert.equal(oldAdmission.rows[0].result.error, 'source');
    const admitted = await f.first.query('SELECT dealguard.reserve_ai_run_v3($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) result', [...params, evidence.handoffCycle, evidence.handoffVersion]);
    assert.equal(admitted.rows[0].result.admitted, true);
    await f.second.query("SELECT * FROM dealguard.confirm_handoff_cycle($1,'101',$2,'7',NULL)", [f.portal, f.source]);
    const finished = await f.first.query("SELECT dealguard.finish_ai_run($1,$2,'lease',true,200,'cipher','iv') accepted", [f.portal, f.input.requestKey]);
    assert.equal(finished.rows[0].accepted, false);
    assert.equal((await aiAdministration(f.env, f.actor)).usage.reservedMicroUsd, 0);
    const row = (await f.first.query('SELECT response_cipher FROM ai_runs WHERE portal_id=$1', [f.portal])).rows[0];
    assert.equal(row.response_cipher, null);
  });
  await t.test('role and scope revocation prevent a cached handover from being disclosed', async t => {
    const f = await setup(t);
    await aiAssistance(f.env, f.actor, f.input);
    await f.first.query(`UPDATE enterprise_role_assignments SET pipeline_ids_json='["outside"]' WHERE portal_id=$1`, [f.portal]);
    await assert.rejects(aiAssistance(f.env, f.actor, f.input), { code: 'record_scope_denied' });
    assert.equal((await f.first.query('SELECT requests FROM ai_daily_usage WHERE portal_id=$1', [f.portal])).rows[0].requests, 1);
  });
});

test('manager-review evidence compares only recent open observations under the same recorded policy version', { skip: !databaseUrl }, async t => {
  const f = await setup(t, false, false);
  const policy = randomUUID(), otherPolicy = randomUUID();
  for (const [id, version] of [[policy, 1], [otherPolicy, 2]]) {
    await f.first.query(`INSERT INTO policy_versions(id,portal_id,version_number,name,status,rules_json,checksum,created_at,updated_at)
      VALUES($1,$2,$3,'Fixture policy','published','{}','fixture',$4,$4)`, [id, f.portal, version, f.source]);
  }
  const insert = async (at, score, issues, { policyId = policy, closed = 0, portal = f.portal, pipeline = 'pipeline', owner = '7' } = {}) => {
    const id = randomUUID();
    await f.first.query(`INSERT INTO assessment_history(id,portal_id,deal_id,score,grade,status,issue_codes_json,issue_count,
      pipeline_label,stage_label,is_closed,is_won,policy_id,trigger_type,assessed_at,pipeline_id,owner_id)
      VALUES($1,$2,'101',$3,'B','at_risk','[]',$4,'Pipeline','Stage',$5,0,$6,'manual',$7,$8,$9)`,
    [id, portal, score, issues, closed, policyId, at, pipeline, owner]);
    return id;
  };
  const values = evidence => Object.fromEntries(evidence.facts.map(f => [f.id, f.value]));
  assert.equal(values(await loadAiEvidence(f.env, f.actor, '101', 'ai.use', 'manager_review')).comparison_available, false);
  await insert(f.source, 80, 1);
  const before = delta => new Date(Date.parse(f.source) - delta).toISOString();
  const previousAt = before(2 * 3600000);
  const previousId = await insert(previousAt, 60, 3);
  await insert(before(3000), 99, 0, { portal: f.other });
  await insert(before(8 * 86400000), 10, 20);
  await insert('not-a-date', 1, 20);
  await insert(before(-1000), 100, 0);
  const evidence = await loadAiEvidence(f.env, f.actor, '101', 'ai.use', 'manager_review');
  const facts = values(evidence);
  assert.equal(facts.comparison_available, true);
  assert.equal(facts.previous_observed_at, previousAt);
  assert.equal(facts.previous_readiness_score, 60);
  assert.equal(facts.readiness_change, 20);
  assert.equal(facts.issue_count_change, -2);
  assert.equal(evidence.facts.find(f => f.id === 'previous_readiness_score').sourceAt, previousAt);
  for (const options of [{ policyId: otherPolicy }, { closed: 1 }, { pipeline: 'different' }]) {
    const intervening = await insert(before(1000), 95, 0, options);
    assert.equal(values(await loadAiEvidence(f.env, f.actor, '101', 'ai.use', 'manager_review')).comparison_available, false,
      'An intervening policy, lifecycle or pipeline change must not be skipped to manufacture a trend.');
    await f.first.query('DELETE FROM assessment_history WHERE id=$1', [intervening]);
  }
  await f.first.query(`UPDATE enterprise_role_assignments SET owner_ids_json='["7"]' WHERE portal_id=$1`, [f.portal]);
  await f.first.query("UPDATE assessment_history SET owner_id='8' WHERE id=$1", [previousId]);
  assert.equal(values(await loadAiEvidence(f.env, f.actor, '101', 'ai.use', 'manager_review')).comparison_available, false,
    'Current record access must not disclose an older observation outside the historical scope.');
  await f.first.query("UPDATE assessment_history SET owner_id='7' WHERE id=$1", [previousId]);
  assert.equal(values(await loadAiEvidence(f.env, f.actor, '101', 'ai.use', 'manager_review')).comparison_available, true);
  await f.first.query('DELETE FROM assessment_history WHERE portal_id=$1 AND assessed_at=$2', [f.portal, previousAt]);
  await insert('today', 20, 10); // PostgreSQL accepts relative clocks; evidence provenance must not.
  const missing = values(await loadAiEvidence(f.env, f.actor, '101', 'ai.use', 'manager_review'));
  assert.equal(missing.comparison_available, false);
  assert.equal(missing.readiness_change, undefined);
});

test('AI optional risk facts keep source observation time when a later snapshot is generated', { skip: !databaseUrl }, async t => {
  const f = await setup(t, false, false);
  const historyAt = new Date(Date.parse(f.source) - 2 * 3600000).toISOString();
  const generatedAt = new Date(Date.parse(f.source) + 1000).toISOString();
  const dimensions = { momentum: { score: 40 }, sourceEvidence: buildSourceEvidence({ readiness: f.source, history: historyAt }) };
  await f.first.query(`INSERT INTO deal_decision_snapshots(portal_id,deal_id,assessment_at,generated_at,methodology,
    brief_status,attention_score,confidence,coverage_percent,freshness_status,next_action_code,risk_summary_json,dimensions_json,created_at,updated_at)
    VALUES($1,'101',$2,$3,'fixture','watch',50,'medium',50,'fresh','review_timing','[{"code":"stage_stall"}]',$4,$3,$3)`,
  [f.portal,f.source,generatedAt,JSON.stringify(dimensions)]);
  const evidence = await loadAiEvidence(f.env, f.actor, '101');
  assert.equal(evidence.snapshotAt, generatedAt);
  assert.equal(evidence.facts.find(f => f.id === 'risk_0').sourceAt, historyAt);
  assert.equal(evidence.facts.find(f => f.id === 'next_action').sourceAt, historyAt);
  assert.equal(evidence.facts.find(f => f.id === 'readiness_score').sourceAt, f.source);
  dimensions.commercial = { score: 40 };
  dimensions.sourceEvidence = buildSourceEvidence({ readiness: f.source, history: historyAt, commercial: f.source });
  await f.first.query('UPDATE deal_decision_snapshots SET dimensions_json=$2 WHERE portal_id=$1', [f.portal, JSON.stringify(dimensions)]);
  await f.first.query(`UPDATE tenants SET scopes_json='["crm.objects.line_items.read","crm.objects.quotes.read"]' WHERE portal_id=$1`, [f.portal]);
  assert.equal((await loadAiEvidence(f.env, f.actor, '101')).snapshotAt, generatedAt);
  await f.first.query("UPDATE tenants SET scopes_json='[]' WHERE portal_id=$1", [f.portal]);
  const revoked = await loadAiEvidence(f.env, f.actor, '101');
  assert.equal(revoked.snapshotAt, null);
  assert.equal(revoked.facts.find(f => f.id === 'risk_0'), undefined);
  assert.equal(revoked.facts.find(f => f.id === 'readiness_score').value, 80);
});
