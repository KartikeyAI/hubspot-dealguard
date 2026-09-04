import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDealBrief } from '../dist/deal-brief.js';

const NOW = Date.parse('2026-08-30T12:00:00.000Z');

function assessment(overrides = {}) {
  return {
    dealId: '1', dealName: 'Acme', pipelineLabel: 'Sales', stageLabel: 'Negotiation',
    score: 84, grade: 'B', status: 'ready', issues: [], readinessSummary: 'Ready',
    isClosed: false, isWon: false, handoffEligible: false, assessedAt: '2026-08-30T10:00:00.000Z',
    ...overrides,
  };
}

function readiness(overrides = {}) {
  return {
    risk: { lostPoints: 0, potentialScore: 100, afterCriticalFixes: 84, contributors: [] },
    nextBestActions: [],
    stageReadiness: { stageId: 'negotiation', stageLabel: 'Negotiation', satisfied: 5, total: 5, percent: 100, blockers: [], requirements: [] },
    change: { previousAssessedAt: '2026-08-29T10:00:00.000Z', scoreDelta: 4, gradeChanged: false, statusChanged: false, newIssueCodes: [], resolvedIssueCodes: ['next_step_missing'], amountDelta: 0, stageAgeDeltaDays: 1, stageChanged: false },
    ...overrides,
  };
}

function momentum(overrides = {}) {
  return {
    decisionActions: [],
    momentum: {
      methodology: 'crm_property_history_signal', windowDays: 90, score: 88, band: 'strong', summary: 'The deal is moving through the CRM process.',
      evidenceCoveragePercent: 100, daysSinceMaterialChange: 2, lastMaterialChangeAt: '2026-08-29T09:00:00.000Z',
      signals: [{ code: 'stage_advanced', label: 'Stage advanced', direction: 'positive', severity: 'info', observedAt: '2026-08-29T09:00:00.000Z', detail: 'The deal advanced one stage.' }],
      events: { stageAdvances: 1, stageRegressions: 0, pipelineChanges: 0, closeDatePushes: 0, closeDatePullIns: 1, ownerChanges: 0, amountChanges: 0, nextStepChanges: 1 },
      limitations: 'Structured CRM movement only.',
    },
    closeDateCredibility: {
      methodology: 'deterministic_close_date_credibility', score: 90, status: 'credible', confidence: 'high', summary: 'The close date is supported by current CRM evidence.',
      currentCloseDate: '2026-09-15', daysToClose: 16, closeDatePushes90d: 0, closeDatePullIns90d: 1,
      lastCloseDateChangeAt: '2026-08-29T09:00:00.000Z', lastPushAt: null, reasons: [], notWinProbability: true,
    },
    ...overrides,
  };
}

function relationship(overrides = {}) {
  return {
    relationshipCoverage: {
      methodology: 'hubspot_association_and_contact_role_evidence', score: 92, status: 'strong', confidence: 'high', summary: 'Core buying roles are explicitly covered.',
      contactCount: 3, companyCount: 1, singleThreaded: false, explicitRoleCoveragePercent: 100, labeledAssociationCoveragePercent: 100,
      contacts: [], companies: [], primaryCompany: { name: 'Acme Corp' }, roleCoverage: [], missingCoreRoles: [], explicitRoles: ['decision_maker', 'budget_holder', 'champion'], inferredOnlyRoles: [],
      signals: [{ code: 'core_roles_covered', label: 'Core roles covered', direction: 'positive', severity: 'info', detail: 'Decision maker, budget holder, and champion are explicit.', evidenceCodes: ['decision_maker', 'budget_holder', 'champion'] }],
      relationshipActions: [], fetchedAt: '2026-08-30T10:00:00.000Z', contactsTruncated: false, companiesTruncated: false,
      limitations: ['Structured relationship evidence only.'], notBuyerIntent: true, notWinProbability: true,
    },
    relationshipActions: [],
    ...overrides,
  };
}

test('builds an on-track brief from strong deterministic evidence', () => {
  const result = buildDealBrief({ assessment: assessment(), readiness: readiness(), momentum: momentum(), relationship: relationship(), decisionActions: [] }, NOW).dealBrief;
  assert.equal(result.status, 'on_track');
  assert.equal(result.confidence, 'high');
  assert.equal(result.coverage.percent, 100);
  assert.ok(result.attentionScore < 35);
  assert.ok(result.positiveSignals.some((item) => item.code === 'relationship_strong'));
  assert.ok(result.positiveSignals.some((item) => item.code === 'close_date_credible'));
  assert.equal(result.notWinProbability, true);
  assert.equal(result.notBuyerIntent, true);
  assert.equal(result.notForecastCategory, true);
});

test('escalates a critical stalled deal with an evidence-backed next action', () => {
  const action = { code: 'reconfirm_close', label: 'Reconfirm close plan', action: 'Reconfirm the buyer-approved close plan.', priority: 'high', rationale: 'The close date moved later repeatedly.', owner: 'deal_owner', dueAt: '2026-08-31T12:00:00.000Z', evidenceCodes: ['close_date_pushes'] };
  const currentAssessment = assessment({
    score: 42,
    grade: 'F',
    status: 'critical',
    issues: [{ code: 'close_date_overdue', label: 'Close date overdue', description: 'The close date is overdue.', severity: 'critical', weight: 18 }],
  });
  const currentReadiness = readiness({
    risk: { lostPoints: 18, potentialScore: 60, afterCriticalFixes: 60, contributors: [{ code: 'close_date_overdue', label: 'Close date overdue', description: 'The close date is overdue.', severity: 'critical', weight: 18, impact: 18 }] },
    nextBestActions: [{ code: 'close_date_overdue', label: 'Close date overdue', action: 'Update the close date or resolve the deal.', impact: 18, severity: 'critical' }],
    stageReadiness: { stageId: 'negotiation', stageLabel: 'Negotiation', satisfied: 2, total: 5, percent: 40, blockers: [], requirements: [] },
    change: { previousAssessedAt: '2026-08-29T10:00:00.000Z', scoreDelta: -20, gradeChanged: true, statusChanged: true, newIssueCodes: ['close_date_overdue'], resolvedIssueCodes: [], amountDelta: 0, stageAgeDeltaDays: 4, stageChanged: false },
  });
  const currentMomentum = momentum({
    decisionActions: [action],
    momentum: { ...momentum().momentum, score: 20, band: 'stalled', summary: 'The deal has stalled.', signals: [{ code: 'stage_regressed', label: 'Stage regressed', direction: 'negative', severity: 'critical', observedAt: '2026-08-29T09:00:00.000Z', detail: 'The deal moved backward.' }], events: { ...momentum().momentum.events, stageAdvances: 0, stageRegressions: 1, closeDatePushes: 3, closeDatePullIns: 0 } },
    closeDateCredibility: { ...momentum().closeDateCredibility, score: 22, status: 'weak', summary: 'The date is weak.', closeDatePushes90d: 3, closeDatePullIns90d: 0, reasons: [{ code: 'repeated_pushes', label: 'Repeated close-date pushes', impact: 25, evidence: 'The date moved later three times.' }] },
  });
  const currentRelationship = relationship({
    relationshipCoverage: { ...relationship().relationshipCoverage, score: 25, status: 'weak', confidence: 'medium', contactCount: 1, singleThreaded: true, signals: [{ code: 'single_threaded', label: 'Single-threaded relationship', direction: 'negative', severity: 'critical', detail: 'Only one stakeholder is associated.', evidenceCodes: ['contact_count'] }] },
    relationshipActions: [],
  });
  const result = buildDealBrief({ assessment: currentAssessment, readiness: currentReadiness, momentum: currentMomentum, relationship: currentRelationship, decisionActions: [action] }, NOW).dealBrief;
  assert.equal(result.status, 'intervention_required');
  assert.ok(result.attentionScore >= 70);
  assert.equal(result.nextAction?.code, 'reconfirm_close');
  assert.ok(result.risks.some((item) => item.dimension === 'close_date'));
  assert.ok(result.risks.some((item) => item.dimension === 'relationship'));
  assert.match(result.summary, /Intervention is required/);
});

test('states when only readiness evidence is available', () => {
  const result = buildDealBrief({ assessment: assessment(), readiness: readiness(), momentum: null, relationship: null, decisionActions: [] }, NOW).dealBrief;
  assert.equal(result.status, 'insufficient_evidence');
  assert.equal(result.confidence, 'low');
  assert.equal(result.coverage.percent, 40);
  assert.deepEqual(result.coverage.missingDimensions, ['momentum', 'close_date', 'relationship']);
  assert.match(result.summary, /only 40%/);
});

test('falls back to the highest-impact readiness action when no richer action exists', () => {
  const currentAssessment = assessment({ status: 'at_risk', score: 74 });
  const currentReadiness = readiness({
    risk: { lostPoints: 10, potentialScore: 84, afterCriticalFixes: 74, contributors: [{ code: 'next_step_missing', label: 'Next step missing', description: 'No next step is recorded.', severity: 'warning', weight: 10, impact: 10 }] },
    nextBestActions: [{ code: 'next_step_missing', label: 'Next step missing', action: 'Record the next committed sales action.', impact: 10, severity: 'warning' }],
  });
  const result = buildDealBrief({ assessment: currentAssessment, readiness: currentReadiness, momentum: null, relationship: null, decisionActions: [] }, NOW).dealBrief;
  assert.equal(result.nextAction?.code, 'readiness_next_step_missing');
  assert.equal(result.nextAction?.priority, 'medium');
  assert.match(result.nextAction?.rationale ?? '', /10 readiness points/);
});

test('caps confidence when relationship evidence is truncated', () => {
  const truncatedRelationship = relationship({
    relationshipCoverage: { ...relationship().relationshipCoverage, contactsTruncated: true },
  });
  const result = buildDealBrief({ assessment: assessment(), readiness: readiness(), momentum: momentum(), relationship: truncatedRelationship, decisionActions: [] }, NOW).dealBrief;
  assert.notEqual(result.confidence, 'high');
  assert.equal(result.coverage.truncated, true);
  assert.ok(result.limitations.some((item) => item.includes('truncated')));
});
