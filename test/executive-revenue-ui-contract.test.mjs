import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('executive view is on-demand, bounded and read-only', () => {
  const panel = read('src/app/pages/ExecutiveRevenuePanel.tsx');
  assert.match(panel, /\/enterprise\/executive-revenue/);
  assert.match(panel, /method: 'GET'/);
  assert.match(panel, /CANDIDATE_LIMIT = 10/);
  assert.match(panel, /refresh', 'true'/);
  assert.match(panel, /if \(!enabled\) return/);
  assert.match(panel, /Load executive evidence when needed/);
  assert.doesNotMatch(panel, /useEffect/);
  assert.doesNotMatch(panel, /\/crm\//);
  assert.doesNotMatch(panel, /method: 'POST'|method: 'PATCH'|method: 'DELETE'|method: 'PUT'/);
});

test('executive panel exposes period, movement, confidence and review surfaces', () => {
  const panel = read('src/app/pages/ExecutiveRevenuePanel.tsx');
  assert.match(panel, /Current quarter/);
  assert.match(panel, /Next quarter/);
  assert.match(panel, /Next 90 days/);
  assert.match(panel, /RECORDED COMMIT/);
  assert.match(panel, /OVERDUE CLOSE DATES/);
  assert.match(panel, /SLIPPAGE REVIEW/);
  assert.match(panel, /PULL-IN REVIEW/);
  assert.match(panel, /EVIDENCE CONFIDENCE/);
  assert.match(panel, /Movement baseline established/);
  assert.match(panel, /Portfolio concentration/);
  assert.match(panel, /HHI/);
});

test('executive panel preserves currency and interpretation boundaries', () => {
  const panel = read('src/app/pages/ExecutiveRevenuePanel.tsx');
  assert.match(panel, /Different currencies are never combined/);
  assert.match(panel, /No safe comparable-currency cohort/);
  assert.match(panel, /deterministic review prompt, not a prediction/);
  assert.match(panel, /not buyer intent, a calibrated forecast, a win probability, expected revenue, or expected financial loss/);
  assert.match(panel, /Period pipeline coverage is not quota coverage/);
});

test('manager workspace composes the existing queue and executive panel', () => {
  const wrapper = read('src/app/pages/ManagerDecisionQueuePanel.tsx');
  const core = read('src/app/pages/ManagerDecisionQueueCore.tsx');
  assert.match(wrapper, /ManagerDecisionQueueCore/);
  assert.match(wrapper, /ExecutiveRevenuePanel/);
  assert.match(wrapper, /<ManagerDecisionQueueCore enabled=\{enabled\} \/>/);
  assert.match(wrapper, /<ExecutiveRevenuePanel enabled=\{enabled\} \/>/);
  assert.match(core, /export function ManagerDecisionQueuePanel/);
});

test('documentation and focused CI cover the App Home executive surface', () => {
  const docs = read('docs/EXECUTIVE_REVENUE_VIEW.md');
  const workflow = read('.github/workflows/p2-decision-intelligence.yml');
  assert.match(docs, /App Home product surface/);
  assert.match(docs, /loaded on demand/);
  assert.match(docs, /Period pipeline coverage is not quota coverage/);
  assert.doesNotMatch(docs, /panel is deliberately deferred/);
  assert.match(workflow, /ExecutiveRevenuePanel\.tsx/);
  assert.match(workflow, /ManagerDecisionQueueCore\.tsx/);
  assert.match(workflow, /executive-revenue-ui-contract\.test\.mjs/);
});
