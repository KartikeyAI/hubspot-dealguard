import test from 'node:test';
import assert from 'node:assert/strict';
import { operationalPermissionsForRole } from '../dist/authorization.js';
import { assessDeal } from '../dist/scoring.js';
import { parseSettings } from '../dist/validation.js';

const baseRules = {
  staleDays: 7,
  maxStageAgeDays: 21,
  requireOwner: true,
  requireAmount: true,
  requireCloseDate: true,
  requireNextStep: true,
  requireCompany: true,
  requireContact: true,
  excludedPipelineIds: [],
  excludedStageIds: [],
  customRequiredProperties: [],
};

test('enterprise governance is plan-gated and approval-safe by default', () => {
  const free = parseSettings({ governance: { enabled: true, requireApproval: false, preventSelfApproval: false } }, 'free');
  assert.equal(free.governance.enabled, false);
  const growth = parseSettings({ governance: { enabled: true } }, 'growth');
  assert.equal(growth.governance.enabled, true);
  assert.equal(growth.governance.requireApproval, true);
  assert.equal(growth.governance.preventSelfApproval, true);
});

test('operational permissions protect destructive and configuration actions', () => {
  const admin = operationalPermissionsForRole('admin');
  assert.equal(admin.includes('data.delete'), true);
  assert.equal(admin.includes('settings.manage'), true);
  assert.equal(operationalPermissionsForRole('viewer').length, 0);
  assert.deepEqual(operationalPermissionsForRole('manager'), ['scan.run']);
  assert.equal(operationalPermissionsForRole('policy_admin').includes('integration.manage'), false);
});

test('assessments carry commercial context for enterprise analytics', () => {
  const result = assessDeal({
    id: 'enterprise-1',
    properties: {
      dealname: 'Enterprise transformation',
      pipeline: 'enterprise-sales',
      dealstage: 'security-review',
      hubspot_owner_id: 'owner-42',
      amount: '250000.50',
      closedate: '2026-12-01T00:00:00.000Z',
      hs_next_step: 'Complete procurement review',
      hs_last_sales_activity_timestamp: '1782864000000',
      hs_date_entered_security_review: '1782864000000',
    },
    contactCount: 2,
    companyCount: 1,
    stage: {
      id: 'security-review',
      label: 'Security review',
      pipelineId: 'enterprise-sales',
      pipelineLabel: 'Enterprise Sales',
      isClosed: false,
      isWon: false,
      enteredAtProperty: 'hs_date_entered_security_review',
    },
  }, baseRules, Date.parse('2026-07-13T00:00:00.000Z'));
  assert.equal(result.pipelineId, 'enterprise-sales');
  assert.equal(result.stageId, 'security-review');
  assert.equal(result.ownerId, 'owner-42');
  assert.equal(result.dealAmount, 250000.5);
});
