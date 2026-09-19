import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { portfolioHistoryWindow, portfolioHistoryPoint, buildPortfolioHistoryQuery } from '../dist/portfolio-history.js';

const now = Date.parse('2026-03-08T12:30:00.000Z');
test('history window is bounded to whole UTC calendar days including the partial current day', () => {
  const window = portfolioHistoryWindow(new URLSearchParams('days=7'), now);
  assert.deepEqual(window, { days: 7, startDate: '2026-03-02', endDate: '2026-03-08',
    startAt: '2026-03-02T00:00:00.000Z', generatedAt: '2026-03-08T12:30:00.000Z' });
  assert.equal(portfolioHistoryWindow(new URLSearchParams('days=1'), now).startDate, '2026-03-08');
  assert.equal(portfolioHistoryWindow(new URLSearchParams('days=3'), Date.parse('2028-03-01T00:00:00Z')).startDate, '2028-02-28');
  assert.equal(portfolioHistoryWindow(new URLSearchParams(), now).days, 30);
});
test('invalid, duplicate, fractional, infinite and oversized windows fail without silent truncation', () => {
  for (const value of ['0', '-1', '91', '730', '1.5', 'Infinity', '1e1', '', '01', ' 7 ', 'NaN']) {
    assert.throws(() => portfolioHistoryWindow(new URLSearchParams({ days: value }), now), { status: 400 });
  }
  assert.throws(() => portfolioHistoryWindow(new URLSearchParams('days=7&days=30'), now), { status: 400 });
  assert.throws(() => portfolioHistoryWindow(new URLSearchParams(), Infinity), { status: 400 });
  assert.throws(() => portfolioHistoryWindow(new URLSearchParams(), 1e20), { status: 400 });
});
const row = (extra = {}) => ({ date: '2026-03-08', snapshot_at: '2026-03-08T12:30:00.000Z',
  known_deals: 2, open_deals: 2, closed_deals: 0, scored_deals: 2, average_score: '62.5',
  gap_deals: 1, assessed_deals: 1, fresh_deals: 1, aging_deals: 0, stale_deals: 1,
  oldest_observed_at: '2026-03-01T12:30:00.000Z', latest_observed_at: '2026-03-08T10:00:00.000Z',
  amount_deals: 2, company_amount_deals: 2, currency_deals: 2, currency_count: 2,
  currency_code: 'INR', source_amount: 110, source_gap_amount: 10, company_amount: 1010,
  company_gap_amount: 10, ...extra });
test('daily summaries preserve source age separately from snapshot and distinguish observed from carried', () => {
  const point = portfolioHistoryPoint(row());
  assert.equal(point.assessedDeals, 1); assert.equal(point.carriedForwardDeals, 1);
  assert.equal(point.freshness.staleDeals, 1);
  assert.notEqual(point.snapshotAt, point.freshness.oldestObservedAt);
  assert.equal(point.averageScore, 62.5);
  assert.equal(point.monetary.mode, 'company_currency');
  assert.equal(point.monetary.pipelineAmount, 1010);
  assert.equal(point.monetary.currencyCode, null);
});
test('missing history and scores never become a fabricated healthy zero', () => {
  const point = portfolioHistoryPoint(row({ known_deals: 0, open_deals: 0, scored_deals: 0,
    average_score: null, amount_deals: 0, company_amount_deals: 0, assessed_deals: 0 }));
  assert.equal(point.evidenceStatus, 'no_observations');
  assert.equal(point.averageScore, null); assert.equal(point.monetary.pipelineAmount, null);
  assert.equal(point.monetary.amountCoveragePercent, null);
  assert.equal(portfolioHistoryPoint(row({ scored_deals: 1 })).averageScore, null);
  assert.equal(portfolioHistoryPoint(row({ average_score: 'NaN' })).averageScore, null);
});
test('single-source-currency fallback works but mixed and unknown currencies are suppressed', () => {
  const single = portfolioHistoryPoint(row({ company_amount_deals: 1, currency_count: 1, currency_code: 'USD' }));
  assert.equal(single.monetary.mode, 'single_deal_currency');
  assert.equal(single.monetary.pipelineAmount, 110);
  for (const extra of [{ currency_count: 2 }, { currency_deals: 1 }, { currency_code: null }, { source_amount: 'NaN' }]) {
    const point = portfolioHistoryPoint(row({ company_amount_deals: 1, currency_count: 1, currency_code: 'USD', ...extra }));
    assert.equal(point.monetary.mode, 'unavailable'); assert.equal(point.monetary.pipelineAmount, null);
  }
});
test('genuine zero amounts and readiness scores remain zero', () => {
  const point = portfolioHistoryPoint(row({ average_score: 0, company_amount: 0, company_gap_amount: 0 }));
  assert.equal(point.averageScore, 0); assert.equal(point.monetary.pipelineAmount, 0);
});
test('SQL binds scope values and constructs transitions before applying historical filters', () => {
  const value = "owner' OR TRUE --";
  const query = buildPortfolioHistoryQuery('100', { ownerId: [value, '2'] }, { ownerId: [value, '2'] },
    portfolioHistoryWindow(new URLSearchParams('days=7'), now));
  assert.ok(!query.sql.includes(value)); assert.equal(query.params.filter((v) => v === value).length, 2);
  assert.equal((query.sql.match(/\?/g) ?? []).length, query.params.length);
  assert.ok(query.sql.indexOf('LEAD(observed_at)') < query.sql.indexOf('state.owner_id IN'));
  assert.match(query.sql, /observed_at DESC NULLS FIRST, id DESC/);
  assert.match(query.sql, /AT TIME ZONE 'UTC'/);
  assert.match(query.sql, /pg_input_is_valid/);
  assert.doesNotMatch(query.sql, /INSERT INTO|UPDATE |DELETE FROM/);
});
test('route and App Home integrate an on-demand, signed, Enterprise-scoped read', () => {
  const route = fs.readFileSync('worker/src/routes-v17.ts', 'utf8');
  const panel = fs.readFileSync('src/app/pages/PortfolioHistoryPanel.tsx', 'utf8');
  const composition = fs.readFileSync('src/app/pages/ManagerDecisionQueuePanel.tsx', 'utf8');
  const endpoint = route.slice(route.indexOf("if (url.pathname === '/api/v1/enterprise/portfolio-history')"), route.indexOf('if (url.pathname === `${SLO_ROOT}/evaluate`)'));
  assert.match(endpoint, /request.method !== 'GET'/);
  assert.match(endpoint, /validateHubSpotRequest\(request, env\)/);
  assert.match(endpoint, /requireCommercialTier\(env, identity.portalId, 'enterprise'\)/);
  assert.match(endpoint, /portfolioHistory\(env, identity, url\)/);
  assert.match(composition, /<PortfolioHistoryPanel enabled=\{enabled\}/);
  assert.match(panel, /if \(!enabled \|\| busy\) return/);
  assert.match(panel, /id === requestId.current/);
  assert.doesNotMatch(panel, /method: 'POST'|setInterval/);
  for (const phrase of ['No retained observation', 'Today is partial', 'carried', 'Oldest open evidence']) assert.ok(panel.includes(phrase));
});
