import assert from 'node:assert/strict';
import test from 'node:test';
import { augmentDealBriefWithCommercialIntegrity } from '../dist/deal-brief-commercial.js';

function base(overrides = {}) {
  return {
    dealBrief: {
      methodology: 'deterministic_evidence_synthesis',
      generatedAt: '2026-08-30T12:00:00.000Z',
      status: 'on_track',
      attentionScore: 20,
      confidence: 'high',
      summary: 'The deal is operationally on track.',
      risks: [],
      positiveSignals: [],
      changes: [],
      nextAction: null,
      coverage: { readiness: true, momentum: true, closeDate: true, relationship: true, engagement: true, percent: 100, missingDimensions: [], truncated: false },
      freshness: { assessedAt: '2026-08-30T10:00:00.000Z', ageHours: 2, status: 'fresh' },
      limitations: [],
      notWinProbability: true,
      notBuyerIntent: true,
      notForecastCategory: true,
      ...overrides,
    },
  };
}

function commercial(overrides = {}) {
  return {
    commercialIntegrity: {
      methodology: 'hubspot_quote_and_line_item_metadata',
      status: 'ready',
      score: 95,
      confidence: 'high',
      summary: 'Commercial metadata is ready.',
      authorization: { status: 'full', requestedScopes: [], grantedScopes: [], missingScopes: [] },
      deal: { amount: 100000, amountInCompanyCurrency: 100000, currencyCode: 'USD', closeDate: '2026-09-15T00:00:00.000Z', stageId: 'negotiation' },
      coverage: { lineItems: true, quotes: true, percent: 100, truncated: false, missingSources: [] },
      lineItems: { count: 2, completeCount: 2, incompleteCount: 0, amountCoveragePercent: 100, subtotal: 100000, subtotalCurrencyCode: 'USD', dealAmountDifferencePercent: 0, discountedCount: 0, maximumDiscountPercent: null, weightedDiscountPercent: null, recurringCount: 1 },
      quotes: { count: 1, currentCount: 1, draftCount: 0, pendingCount: 0, issuedCount: 0, acceptedCount: 1, expiredCount: 0, rejectedCount: 0, latestQuoteAt: '2026-08-30T10:00:00.000Z', nextExpirationAt: '2026-09-20T00:00:00.000Z', nearestExpirationDays: 21, latestCurrentQuoteAmount: 100000, latestCurrentQuoteCurrencyCode: 'USD', dealAmountDifferencePercent: 0 },
      daysToClose: 16,
      signals: [{ code: 'line_items_complete', label: 'Line-item pricing is complete', direction: 'positive', severity: 'info', detail: 'All line items are complete.', observedAt: '2026-08-30T12:00:00.000Z', evidenceCodes: ['line_items_complete'] }],
      fetchedAt: '2026-08-30T12:00:00.000Z',
      limitations: [],
      contentProcessed: false,
      notForecastCategory: true,
      notWinProbability: true,
      notExpectedLoss: true,
      ...overrides,
    },
    commercialActions: [],
  };
}

test('adds full commercial coverage and positive evidence to the Deal Brief', () => {
  const result = augmentDealBriefWithCommercialIntegrity(base(), commercial(), []).dealBrief;
  assert.equal(result.coverage.commercial, true);
  assert.equal(result.coverage.percent, 100);
  assert.equal(result.confidence, 'high');
  assert.equal(result.status, 'on_track');
  assert.ok(result.positiveSignals.some((item) => item.dimension === 'commercial'));
  assert.ok(result.attentionScore < 20);
});

test('escalates a materially weak commercial package and selects its owned action', () => {
  const action = { code: 'commercial_replace_expired_quote', label: 'Replace expired quote', action: 'Issue a valid replacement proposal.', priority: 'high', rationale: 'All quote evidence is expired.', owner: 'deal_owner', dueAt: '2026-08-31T12:00:00.000Z', evidenceCodes: ['all_quotes_expired'] };
  const weak = commercial({
    status: 'weak',
    score: 20,
    summary: 'Commercial integrity is weak.',
    signals: [{ code: 'all_quotes_expired', label: 'All quote evidence is expired', direction: 'negative', severity: 'critical', detail: 'No current quote remains.', observedAt: '2026-08-30T12:00:00.000Z', evidenceCodes: ['all_quotes_expired'] }],
  });
  weak.commercialActions = [action];
  const result = augmentDealBriefWithCommercialIntegrity(base({ status: 'watch', attentionScore: 45 }), weak, [action]).dealBrief;
  assert.equal(result.status, 'intervention_required');
  assert.equal(result.nextAction?.code, 'commercial_replace_expired_quote');
  assert.ok(result.risks.some((item) => item.code === 'commercial_all_quotes_expired'));
  assert.ok(result.attentionScore >= 50);
});

test('treats missing optional commercial authorization as a coverage gap, not a risk', () => {
  const unauthorized = commercial({
    status: 'authorization_required',
    score: null,
    confidence: 'low',
    authorization: { status: 'required', requestedScopes: ['crm.objects.line_items.read', 'crm.objects.quotes.read'], grantedScopes: [], missingScopes: ['crm.objects.line_items.read', 'crm.objects.quotes.read'] },
    coverage: { lineItems: false, quotes: false, percent: 0, truncated: false, missingSources: ['line_items', 'quotes'] },
    signals: [{ code: 'commercial_authorization_required', label: 'Commercial evidence is not authorized', direction: 'neutral', severity: 'info', detail: 'Optional scopes are missing.', observedAt: '2026-08-30T12:00:00.000Z', evidenceCodes: [] }],
  });
  const result = augmentDealBriefWithCommercialIntegrity(base(), unauthorized, []).dealBrief;
  assert.equal(result.coverage.commercial, false);
  assert.equal(result.coverage.percent, 80);
  assert.ok(result.coverage.missingDimensions.includes('commercial'));
  assert.equal(result.risks.some((item) => item.dimension === 'commercial'), false);
  assert.equal(result.status, 'on_track');
  assert.equal(result.confidence, 'medium');
});

test('caps confidence for partial or truncated commercial evidence', () => {
  const partial = commercial({
    confidence: 'medium',
    authorization: { status: 'partial', requestedScopes: [], grantedScopes: ['crm.objects.line_items.read'], missingScopes: ['crm.objects.quotes.read'] },
    coverage: { lineItems: true, quotes: false, percent: 50, truncated: true, missingSources: ['quotes'] },
  });
  const result = augmentDealBriefWithCommercialIntegrity(base(), partial, []).dealBrief;
  assert.equal(result.coverage.commercial, true);
  assert.equal(result.coverage.truncated, true);
  assert.notEqual(result.confidence, 'high');
  assert.ok(result.limitations.some((item) => item.includes('quote and line-item metadata')));
});
