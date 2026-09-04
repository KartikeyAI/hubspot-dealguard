import { buildAmountCohorts, buildConcentration, buildMovementCohorts } from './executive-revenue-cohorts.js';
import { executiveConfidence, pullInCandidate, slippageCandidate } from './executive-revenue-candidates.js';
import {
  buildWorkingDeals,
  normalizeRecordedForecastCategory,
  percentage,
  revenueAmountContext,
} from './executive-revenue-model.js';
import type {
  ExecutiveCandidate,
  ExecutiveRevenueDeal,
  ExecutiveRevenueResponse,
  ExecutiveRevenueSnapshot,
} from './executive-revenue-types.js';

export { normalizeRecordedForecastCategory, revenueAmountContext } from './executive-revenue-model.js';

export function buildExecutiveRevenueView(
  deals: ExecutiveRevenueDeal[],
  snapshots: ExecutiveRevenueSnapshot[],
  input: {
    period: ExecutiveRevenueResponse['period'];
    generatedAt: string;
    fetchedAt: string;
    maxDeals: number;
    loadedDeals: number;
    sourceTruncated: boolean;
    candidateLimit?: number;
  },
): ExecutiveRevenueResponse {
  const now = Date.parse(input.generatedAt);
  const items = buildWorkingDeals(deals, snapshots, input.period, now);
  const comparisonDeals = items.filter((item) => item.previous !== null).length;
  const candidateLimit = Math.min(50, Math.max(1, Math.round(input.candidateLimit ?? 20)));
  const slippage = items.map(slippageCandidate).filter((item): item is ExecutiveCandidate => item !== null)
    .sort((left, right) => right.priorityScore - left.priorityScore || (right.amount.value ?? 0) - (left.amount.value ?? 0))
    .slice(0, candidateLimit);
  const pullIn = items.map((item) => pullInCandidate(item, input.period, now)).filter((item): item is ExecutiveCandidate => item !== null)
    .sort((left, right) => right.priorityScore - left.priorityScore || (right.amount.value ?? 0) - (left.amount.value ?? 0))
    .slice(0, candidateLimit);
  const confidence = executiveConfidence(items, comparisonDeals);
  const comparisonDates = snapshots.map((snapshot) => snapshot.snapshotDate)
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort();
  const amountIncreased = items.filter((item) =>
    item.previous !== null && item.amount.cohortKey !== null && item.amount.cohortKey === item.previousAmount.cohortKey
    && item.amount.value !== null && item.previousAmount.value !== null && item.amount.value > item.previousAmount.value * 1.01);
  const amountDecreased = items.filter((item) =>
    item.previous !== null && item.amount.cohortKey !== null && item.amount.cohortKey === item.previousAmount.cohortKey
    && item.amount.value !== null && item.previousAmount.value !== null && item.amount.value < item.previousAmount.value * .99);

  return {
    generatedAt: input.generatedAt,
    methodology: 'deterministic_executive_revenue_view_v1',
    period: input.period,
    source: {
      fetchedAt: input.fetchedAt,
      maxDeals: input.maxDeals,
      loadedDeals: input.loadedDeals,
      scopedOpenDeals: items.length,
      truncated: input.sourceTruncated,
      comparisonSnapshotDate: comparisonDates.at(-1) ?? null,
    },
    summary: {
      totalOpenDeals: items.length,
      periodDeals: items.filter((item) => item.inPeriod).length,
      overdueCloseDeals: items.filter((item) => item.overdue).length,
      undatedDeals: items.filter((item) => item.closeDateMs === null).length,
      recordedCommitDeals: items.filter((item) => item.forecast === 'commit').length,
      recordedBestCaseDeals: items.filter((item) => item.forecast === 'best_case').length,
      actNowDeals: items.filter((item) =>
        item.current.readinessStatus === 'critical'
        || item.current.decision.status === 'intervention_required'
        || (item.current.decision.attentionScore ?? 0) >= 75).length,
      slippageReviewDeals: slippage.length,
      pullInReviewDeals: pullIn.length,
    },
    coverage: {
      amountPercent: percentage(items.filter((item) => item.current.amount !== null).length, items.length),
      comparableAmountPercent: percentage(items.filter((item) => item.amount.comparable).length, items.length),
      closeDatePercent: percentage(items.filter((item) => item.closeDateMs !== null).length, items.length),
      forecastCategoryPercent: percentage(items.filter((item) => item.forecast !== 'unavailable').length, items.length),
      ownerPercent: percentage(items.filter((item) => Boolean(item.current.ownerId)).length, items.length),
      currentAssessmentPercent: percentage(items.filter((item) => item.current.readinessScore !== null && item.current.assessmentAt !== null).length, items.length),
      currentDealBriefPercent: percentage(items.filter((item) => item.current.decision.status !== null).length, items.length),
      comparisonSnapshotPercent: percentage(comparisonDeals, items.length),
    },
    confidence,
    amountCohorts: buildAmountCohorts(items),
    movement: {
      status: confidence.movement,
      comparisonDeals,
      closeDatePushedDeals: items.filter((item) => (item.closeDateDeltaDays ?? 0) > 0).length,
      closeDatePulledInDeals: items.filter((item) => (item.closeDateDeltaDays ?? 0) < 0).length,
      closeDateAddedDeals: items.filter((item) => item.previous !== null && item.previousCloseDateMs === null && item.closeDateMs !== null).length,
      closeDateRemovedDeals: items.filter((item) => item.previous !== null && item.previousCloseDateMs !== null && item.closeDateMs === null).length,
      stageChangedDeals: items.filter((item) => item.previous !== null && item.current.stageId !== item.previous.stageId).length,
      amountIncreasedDeals: amountIncreased.length,
      amountDecreasedDeals: amountDecreased.length,
      forecastUpgradedDeals: items.filter((item) => item.forecastUpgraded).length,
      forecastDowngradedDeals: items.filter((item) => item.forecastDowngraded).length,
      periodExitDeals: items.filter((item) => item.periodExit).length,
      periodEntryDeals: items.filter((item) => item.periodEntry).length,
      amountCohorts: buildMovementCohorts(items),
    },
    concentration: buildConcentration(items),
    slippageReviewCandidates: slippage,
    pullInReviewCandidates: pullIn,
    limitations: [
      'Recorded forecast categories and close dates are customer-supplied CRM evidence; DealGuard does not convert them into a win probability.',
      'Period pipeline coverage means the share of current open amount whose recorded close date falls inside the selected period. It is not quota coverage.',
      'Commercial amounts are aggregated only in HubSpot company currency or within one known original deal currency.',
      'Pull-in and slippage candidates are deterministic review prompts, not predictions.',
      confidence.movement === 'baseline_only'
        ? 'This run creates the first daily executive snapshot. Movement becomes available after a later snapshot.'
        : 'Movement compares current deal state with the latest stored daily executive snapshot before today.',
    ],
    semantics: {
      recordedForecastOnly: true,
      notWinProbability: true,
      notExpectedRevenue: true,
      notExpectedLoss: true,
      amountNeverCombinedAcrossCurrencies: true,
      pullInCandidateIsReviewPrompt: true,
      slippageCandidateIsReviewPrompt: true,
    },
  };
}
