import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('deal record exposes governed recommendation lifecycle controls', () => {
  const card = read('src/app/cards/DealGuardActionsCard.tsx');
  const lifecycle = read('src/app/cards/deal-recommendation-lifecycle.tsx');
  assert.match(card, /RecommendationLifecyclePanel/);
  assert.match(card, /reloadToken=\{recommendationReload\}/);
  assert.match(lifecycle, /\/enterprise\/access/);
  assert.match(lifecycle, /recommendations\?limit=20/);
  assert.match(lifecycle, /remediation\.view/);
  assert.match(lifecycle, /remediation\.manage/);
  assert.match(lifecycle, /accept' \| 'complete' \| 'dismiss'/);
  assert.match(lifecycle, /TextArea/);
  assert.match(lifecycle, /Dismissal reason/);
  assert.match(lifecycle, /Confirm dismissal/);
  assert.match(lifecycle, /timeout: 15_000/);
});

test('record lifecycle UI preserves non-autonomous and non-causal boundaries', () => {
  const lifecycle = read('src/app/cards/deal-recommendation-lifecycle.tsx');
  assert.match(lifecycle, /without changing the deal record automatically/i);
  assert.match(lifecycle, /Completing an action does not prove impact/i);
  assert.match(lifecycle, /observed association only/i);
  assert.match(lifecycle, /missing evidence is not treated as success or failure/i);
  assert.doesNotMatch(lifecycle, /HubSpotClient|api\.hubapi\.com|crm\/v3\/objects/);
});

test('App Home exposes recommendation adoption and observed-outcome analytics', () => {
  const panel = read('src/app/pages/RecommendationOutcomePanel.tsx');
  const wrapper = read('src/app/pages/ManagerDecisionQueuePanel.tsx');
  assert.match(wrapper, /RecommendationOutcomePanel/);
  assert.match(panel, /recommendation-outcomes\?days=\$\{windowDays\}/);
  assert.match(panel, /WINDOW_OPTIONS = \[30, 90, 180\]/);
  assert.match(panel, /ACCEPTANCE RATE/);
  assert.match(panel, /COMPLETION RATE/);
  assert.match(panel, /OVERDUE ACCEPTED/);
  assert.match(panel, /OBSERVED OUTCOMES/);
  assert.match(panel, /Recommendation adoption/);
  assert.match(panel, /Recent recommendation evidence/);
  assert.match(panel, /Observed association only/);
  assert.match(panel, /timeout: 15_000/);
});

test('outcome UI does not turn observations into predictive or causal claims', () => {
  const panel = read('src/app/pages/RecommendationOutcomePanel.tsx');
  assert.match(panel, /does not prove impact/i);
  assert.match(panel, /missing evidence does not mean success or failure/i);
  assert.match(panel, /win probability/);
  assert.match(panel, /forecast category/);
  assert.match(panel, /expected revenue/);
  assert.match(panel, /expected loss/);
  assert.doesNotMatch(panel, /caused the deal|guaranteed impact|predicted win/i);
});

test('existing backend remains permission-aware, audited and CRM-read-free', () => {
  const route = read('worker/src/routes-v13.ts');
  const lifecycle = read('worker/src/recommendation-lifecycle.ts');
  const observation = read('worker/src/recommendation-observation.ts');
  assert.match(route, /dealRecommendationsPath/);
  assert.match(route, /recommendations/);
  assert.match(route, /accept\|complete\|dismiss/);
  assert.match(lifecycle, /requireEnterprisePermission\(env, identity, 'remediation\.view'/);
  assert.match(lifecycle, /requireEnterprisePermission\(env, identity, 'remediation\.manage'/);
  assert.match(lifecycle, /new Repository\(env\)\.audit/);
  assert.doesNotMatch(`${lifecycle}\n${observation}`, /HubSpotClient|api\.hubapi\.com|\/crm\//);
});

test('documentation and focused CI retain the product-surface contract', () => {
  const workflow = read('.github/workflows/p2-decision-intelligence.yml');
  const docs = read('docs/RECOMMENDATION_OUTCOMES.md');
  assert.match(workflow, /src\/app\/cards\/\*\*/);
  assert.match(workflow, /ManagerDecisionQueuePanel\.tsx/);
  assert.match(docs, /Deal record lifecycle controls/i);
  assert.match(docs, /App Home adoption and outcome analytics/i);
  assert.match(docs, /no new HubSpot OAuth scope/i);
  assert.match(docs, /observed association, not causal attribution/i);
});
