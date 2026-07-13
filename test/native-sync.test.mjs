import test from 'node:test';
import assert from 'node:assert/strict';
import { DEALGUARD_PROPERTY_DEFINITIONS, nativePropertyValues } from '../dist/native-sync.js';
import { workflowOutputFields } from '../dist/workflow-action.js';

const assessment = {
  dealId: '123',
  dealName: 'Enterprise renewal',
  pipelineLabel: 'Sales',
  stageLabel: 'Contract',
  score: 42,
  grade: 'F',
  status: 'critical',
  issues: [
    { code: 'owner_missing', label: 'Owner missing', description: 'Assign a deal owner.', severity: 'critical', weight: 12 },
    { code: 'next_step_missing', label: 'Next step missing', description: 'Add a concrete next step.', severity: 'warning', weight: 8 },
  ],
  readinessSummary: 'Two readiness issues require attention.',
  isClosed: true,
  isWon: true,
  handoffEligible: false,
  assessedAt: '2026-07-13T00:00:00.000Z',
};

test('defines only fixed DealGuard-owned deal properties', () => {
  assert.equal(DEALGUARD_PROPERTY_DEFINITIONS.length, 7);
  assert.equal(new Set(DEALGUARD_PROPERTY_DEFINITIONS.map((property) => property.name)).size, 7);
  assert.equal(DEALGUARD_PROPERTY_DEFINITIONS.every((property) => property.name.startsWith('dealguard_')), true);
});

test('maps assessments to native HubSpot property values', () => {
  const properties = nativePropertyValues(assessment, 'confirmed', true);
  assert.equal(properties.dealguard_readiness_score, '42');
  assert.equal(properties.dealguard_readiness_status, 'critical');
  assert.equal(properties.dealguard_readiness_grade, 'F');
  assert.equal(properties.dealguard_issue_count, '2');
  assert.equal(properties.dealguard_handoff_status, 'confirmed');
  assert.equal(properties.dealguard_last_assessed_at, String(Date.parse(assessment.assessedAt)));
  assert.match(properties.dealguard_readiness_summary, /Two readiness issues/);
});

test('omits the summary when an administrator disables summary sync', () => {
  const properties = nativePropertyValues(assessment, null, false);
  assert.equal('dealguard_readiness_summary' in properties, false);
  assert.equal(properties.dealguard_handoff_status, 'required');
});

test('exposes assessment values as reusable workflow outputs', () => {
  const outputs = workflowOutputFields({ ...assessment, handoffStatus: 'confirmed' });
  assert.deepEqual(outputs, {
    readinessScore: 42,
    readinessStatus: 'critical',
    readinessGrade: 'F',
    issueCount: 2,
    handoffStatus: 'confirmed',
    readinessSummary: 'Two readiness issues require attention.',
    assessedAt: '2026-07-13T00:00:00.000Z',
  });
});
