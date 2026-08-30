import type {
  ConcentrationCohort,
  ConcentrationDimension,
  RevenueAmountCohort,
  RevenueMovementCohort,
} from './executive-revenue-types.js';
import {
  FORECAST_LABELS,
  percentage,
  round,
  type WorkingExecutiveDeal,
} from './executive-revenue-model.js';

export function buildAmountCohorts(items: WorkingExecutiveDeal[]): RevenueAmountCohort[] {
  const groups = new Map<string, WorkingExecutiveDeal[]>();
  for (const item of items) {
    if (!item.amount.cohortKey || item.amount.basis === 'unavailable') continue;
    const group = groups.get(item.amount.cohortKey) ?? [];
    group.push(item);
    groups.set(item.amount.cohortKey, group);
  }

  return [...groups.entries()].map(([key, members]) => {
    const first = members[0]!;
    const categoryGroups = new Map<typeof first.forecast, { deals: number; amount: number }>();
    let openAmount = 0;
    let periodAmount = 0;
    let overdueAmount = 0;
    let undatedAmount = 0;
    for (const item of members) {
      const value = item.amount.value ?? 0;
      openAmount += value;
      if (item.inPeriod) periodAmount += value;
      if (item.overdue) overdueAmount += value;
      if (item.closeDateMs === null) undatedAmount += value;
      const category = categoryGroups.get(item.forecast) ?? { deals: 0, amount: 0 };
      category.deals += 1;
      category.amount += value;
      categoryGroups.set(item.forecast, category);
    }
    return {
      key,
      basis: first.amount.basis as 'company_currency' | 'deal_currency',
      currencyCode: first.amount.currencyCode,
      label: first.amount.label,
      deals: members.length,
      dealsWithAmount: members.filter((item) => item.amount.value !== null).length,
      openAmount: round(openAmount, 2),
      periodAmount: round(periodAmount, 2),
      overdueAmount: round(overdueAmount, 2),
      undatedAmount: round(undatedAmount, 2),
      periodPipelineCoveragePercent: percentage(periodAmount, openAmount),
      categories: [...categoryGroups.entries()].map(([category, values]) => ({
        category,
        label: FORECAST_LABELS[category],
        deals: values.deals,
        amount: round(values.amount, 2),
      })).sort((left, right) => right.amount - left.amount || right.deals - left.deals),
    };
  }).sort((left, right) => right.deals - left.deals || left.label.localeCompare(right.label));
}

export function buildMovementCohorts(items: WorkingExecutiveDeal[]): RevenueMovementCohort[] {
  const groups = new Map<string, RevenueMovementCohort>();
  for (const item of items) {
    if (!item.amount.cohortKey || item.amount.basis === 'unavailable' || item.amount.value === null) continue;
    const current = groups.get(item.amount.cohortKey) ?? {
      key: item.amount.cohortKey,
      basis: item.amount.basis,
      currencyCode: item.amount.currencyCode,
      label: item.amount.label,
      periodExitAmount: 0,
      periodEntryAmount: 0,
      closeDatePushAmount: 0,
      closeDatePullInAmount: 0,
    };
    if (item.periodExit) current.periodExitAmount += item.amount.value;
    if (item.periodEntry) current.periodEntryAmount += item.amount.value;
    if ((item.closeDateDeltaDays ?? 0) > 0) current.closeDatePushAmount += item.amount.value;
    if ((item.closeDateDeltaDays ?? 0) < 0) current.closeDatePullInAmount += item.amount.value;
    groups.set(item.amount.cohortKey, current);
  }
  return [...groups.values()].map((item) => ({
    ...item,
    periodExitAmount: round(item.periodExitAmount, 2),
    periodEntryAmount: round(item.periodEntryAmount, 2),
    closeDatePushAmount: round(item.closeDatePushAmount, 2),
    closeDatePullInAmount: round(item.closeDatePullInAmount, 2),
  })).filter((item) =>
    item.periodExitAmount > 0 || item.periodEntryAmount > 0
    || item.closeDatePushAmount > 0 || item.closeDatePullInAmount > 0)
    .sort((left, right) => right.periodExitAmount - left.periodExitAmount || left.label.localeCompare(right.label));
}

function concentrationDimension(
  items: WorkingExecutiveDeal[],
  dimension: ConcentrationDimension['dimension'],
): ConcentrationDimension {
  const groups = new Map<string, { id: string | null; label: string; deals: number; amount: number }>();
  for (const item of items) {
    if (item.amount.value === null) continue;
    const id = dimension === 'owner'
      ? item.current.ownerId
      : dimension === 'pipeline'
        ? item.current.pipelineId
        : item.current.regionCode;
    const label = dimension === 'pipeline'
      ? item.current.pipelineLabel ?? item.current.pipelineId ?? 'Unassigned'
      : id ?? 'Unassigned';
    const key = id ?? '__unassigned__';
    const current = groups.get(key) ?? { id, label, deals: 0, amount: 0 };
    current.deals += 1;
    current.amount += item.amount.value;
    groups.set(key, current);
  }
  const total = [...groups.values()].reduce((sum, item) => sum + item.amount, 0);
  if (total <= 0 || groups.size === 0) {
    return {
      dimension,
      topEntityId: null,
      topEntityLabel: 'Unavailable',
      topSharePercent: 0,
      hhi: 0,
      status: 'unavailable',
      entities: [],
    };
  }
  const entities = [...groups.values()].map((item) => ({
    ...item,
    amount: round(item.amount, 2),
    sharePercent: percentage(item.amount, total),
  })).sort((left, right) => right.amount - left.amount).slice(0, 5);
  const hhi = round([...groups.values()].reduce((sum, item) => {
    const share = item.amount / total;
    return sum + share * share * 10_000;
  }, 0));
  const top = entities[0]!;
  const status = top.sharePercent >= 50 || hhi >= 2500
    ? 'concentrated'
    : top.sharePercent >= 35 || hhi >= 1800
      ? 'watch'
      : 'diversified';
  return {
    dimension,
    topEntityId: top.id,
    topEntityLabel: top.label,
    topSharePercent: top.sharePercent,
    hhi,
    status,
    entities,
  };
}

export function buildConcentration(items: WorkingExecutiveDeal[]): ConcentrationCohort[] {
  const groups = new Map<string, WorkingExecutiveDeal[]>();
  for (const item of items) {
    if (!item.amount.cohortKey || item.amount.value === null || item.amount.value <= 0) continue;
    const group = groups.get(item.amount.cohortKey) ?? [];
    group.push(item);
    groups.set(item.amount.cohortKey, group);
  }
  return [...groups.entries()].map(([key, members]) => {
    const first = members[0]!;
    return {
      key,
      basis: first.amount.basis as 'company_currency' | 'deal_currency',
      currencyCode: first.amount.currencyCode,
      label: first.amount.label,
      totalAmount: round(members.reduce((sum, item) => sum + (item.amount.value ?? 0), 0), 2),
      dimensions: [
        concentrationDimension(members, 'owner'),
        concentrationDimension(members, 'pipeline'),
        concentrationDimension(members, 'region'),
      ],
    };
  }).sort((left, right) => right.totalAmount - left.totalAmount);
}
