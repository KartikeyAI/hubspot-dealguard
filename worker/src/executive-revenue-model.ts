import type {
  ExecutiveRevenueDeal,
  ExecutiveRevenuePeriod,
  ExecutiveRevenueSnapshot,
  ForecastCategory,
  RevenueAmountContext,
} from './executive-revenue-types.js';

export const DAY_MS = 86_400_000;
export const FORECAST_LABELS: Record<ForecastCategory, string> = {
  commit: 'Commit',
  best_case: 'Best case',
  pipeline: 'Pipeline',
  not_forecasted: 'Not forecasted',
  closed_won: 'Closed won',
  custom: 'Custom category',
  unavailable: 'Unavailable',
};

const FORECAST_RANK: Partial<Record<ForecastCategory, number>> = {
  not_forecasted: 0,
  pipeline: 1,
  best_case: 2,
  commit: 3,
  closed_won: 4,
};

export interface WorkingExecutiveDeal {
  current: ExecutiveRevenueDeal;
  previous: ExecutiveRevenueSnapshot | null;
  amount: RevenueAmountContext;
  previousAmount: RevenueAmountContext;
  forecast: ForecastCategory;
  previousForecast: ForecastCategory;
  closeDateMs: number | null;
  previousCloseDateMs: number | null;
  closeDateDeltaDays: number | null;
  inPeriod: boolean;
  previousInPeriod: boolean;
  overdue: boolean;
  periodExit: boolean;
  periodEntry: boolean;
  forecastUpgraded: boolean;
  forecastDowngraded: boolean;
}

export function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

export function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function percentage(numerator: number, denominator: number): number {
  return denominator > 0 ? round(numerator / denominator * 100) : 0;
}

export function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function iso(value: string | null | undefined): string | null {
  const parsed = timestamp(value);
  return parsed === null ? null : new Date(parsed).toISOString();
}

function normalizedCurrency(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase() ?? '';
  return /^[A-Z]{3}$/.test(normalized) ? normalized : null;
}

export function normalizeRecordedForecastCategory(value: string | null): ForecastCategory {
  if (!value?.trim()) return 'unavailable';
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['commit', 'committed'].includes(normalized)) return 'commit';
  if (['bestcase', 'best_case'].includes(normalized)) return 'best_case';
  if (['pipeline', 'open_pipeline'].includes(normalized)) return 'pipeline';
  if (['omit', 'not_forecasted', 'notforecasted', 'none'].includes(normalized)) return 'not_forecasted';
  if (['closedwon', 'closed_won', 'won'].includes(normalized)) return 'closed_won';
  return 'custom';
}

export function revenueAmountContext(
  amount: number | null,
  amountInCompanyCurrency: number | null,
  currency: string | null,
): RevenueAmountContext {
  if (amountInCompanyCurrency !== null && Number.isFinite(amountInCompanyCurrency) && amountInCompanyCurrency >= 0) {
    return {
      value: amountInCompanyCurrency,
      basis: 'company_currency',
      currencyCode: null,
      label: 'Company currency',
      cohortKey: 'company_currency',
      comparable: true,
    };
  }
  const code = normalizedCurrency(currency);
  if (amount !== null && Number.isFinite(amount) && amount >= 0 && code) {
    return {
      value: amount,
      basis: 'deal_currency',
      currencyCode: code,
      label: code,
      cohortKey: `deal_currency:${code}`,
      comparable: true,
    };
  }
  return {
    value: amount !== null && Number.isFinite(amount) ? amount : null,
    basis: 'unavailable',
    currencyCode: code,
    label: code ?? 'Currency unavailable',
    cohortKey: null,
    comparable: false,
  };
}

function withinPeriod(value: number | null, period: ExecutiveRevenuePeriod): boolean {
  return value !== null && value >= Date.parse(period.start) && value <= Date.parse(period.end);
}

function forecastMovement(current: ForecastCategory, previous: ForecastCategory): 'up' | 'down' | 'same' | 'unknown' {
  const currentRank = FORECAST_RANK[current];
  const previousRank = FORECAST_RANK[previous];
  if (currentRank === undefined || previousRank === undefined) return current === previous ? 'same' : 'unknown';
  return currentRank > previousRank ? 'up' : currentRank < previousRank ? 'down' : 'same';
}

export function buildWorkingDeals(
  deals: ExecutiveRevenueDeal[],
  snapshots: ExecutiveRevenueSnapshot[],
  period: ExecutiveRevenuePeriod,
  now: number,
): WorkingExecutiveDeal[] {
  const previousByDeal = new Map(snapshots.map((snapshot) => [snapshot.dealId, snapshot]));
  return deals.filter((deal) => !deal.isClosed).map((current) => {
    const previous = previousByDeal.get(current.dealId) ?? null;
    const amount = revenueAmountContext(current.amount, current.amountInCompanyCurrency, current.currencyCode);
    const previousAmount = previous
      ? revenueAmountContext(previous.amount, previous.amountInCompanyCurrency, previous.currencyCode)
      : revenueAmountContext(null, null, null);
    const forecast = normalizeRecordedForecastCategory(current.forecastCategoryRaw);
    const previousForecast = normalizeRecordedForecastCategory(previous?.forecastCategoryRaw ?? null);
    const closeDateMs = timestamp(current.closeDate);
    const previousCloseDateMs = timestamp(previous?.closeDate);
    const closeDateDeltaDays = closeDateMs !== null && previousCloseDateMs !== null
      ? round((closeDateMs - previousCloseDateMs) / DAY_MS, 1)
      : null;
    const currentInPeriod = withinPeriod(closeDateMs, period);
    const priorInPeriod = withinPeriod(previousCloseDateMs, period);
    const direction = forecastMovement(forecast, previousForecast);
    return {
      current,
      previous,
      amount,
      previousAmount,
      forecast,
      previousForecast,
      closeDateMs,
      previousCloseDateMs,
      closeDateDeltaDays,
      inPeriod: currentInPeriod,
      previousInPeriod: priorInPeriod,
      overdue: closeDateMs !== null && closeDateMs < now,
      periodExit: priorInPeriod && !currentInPeriod,
      periodEntry: !priorInPeriod && currentInPeriod,
      forecastUpgraded: direction === 'up',
      forecastDowngraded: direction === 'down',
    };
  });
}
