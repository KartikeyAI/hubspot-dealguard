import type { DealHistoryContext, DealPropertyHistoryValue, MomentumStageDefinition } from './deal-history.js';
import type { MomentumSignal } from './deal-momentum-types.js';
import type { NormalizedDeal, RuleSettings } from './types.js';

const DAY_MS = 86_400_000;
export const MOMENTUM_WINDOW_DAYS = 90;

export interface PropertyChange {
  from: string | null;
  to: string | null;
  timestamp: string;
}

export interface StageTransition extends PropertyChange {
  fromStage: MomentumStageDefinition | null;
  toStage: MomentumStageDefinition | null;
  direction: 'advance' | 'regression' | 'pipeline_change' | 'unknown';
}

export interface CloseDateMove extends PropertyChange {
  fromDate: string | null;
  toDate: string | null;
  deltaDays: number | null;
  direction: 'push' | 'pull_in' | 'unknown';
}

export interface MomentumEvidence {
  windowDays: number;
  windowStartedAt: string;
  fetchedAt: string;
  evidenceCoveragePercent: number;
  trackedPropertiesWithEvidence: number;
  stageTransitions: StageTransition[];
  closeDateMoves: CloseDateMove[];
  ownerChanges: PropertyChange[];
  amountChanges: PropertyChange[];
  nextStepChanges: PropertyChange[];
  lastMaterialChangeAt: string | null;
  daysSinceMaterialChange: number | null;
  currentStageAgeDays: number | null;
  currentActivityAgeDays: number | null;
  currentCloseDate: string | null;
  daysToClose: number | null;
  hasNextStep: boolean;
  stageAgeLimitDays: number;
  staleActivityLimitDays: number;
  signals: MomentumSignal[];
}

function time(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numeric(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function historyFor(
  history: DealHistoryContext,
  property: string,
  windowStart: number,
): DealPropertyHistoryValue[] {
  return (history.propertyHistory[property] ?? [])
    .filter((item) => (time(item.timestamp) ?? 0) >= windowStart)
    .sort((left, right) => (time(left.timestamp) ?? 0) - (time(right.timestamp) ?? 0));
}

function changes(values: DealPropertyHistoryValue[]): PropertyChange[] {
  const output: PropertyChange[] = [];
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1]!;
    const current = values[index]!;
    if ((previous.value ?? null) === (current.value ?? null)) continue;
    output.push({ from: previous.value ?? null, to: current.value ?? null, timestamp: current.timestamp });
  }
  return output;
}

function stageTransitions(
  values: DealPropertyHistoryValue[],
  definitions: MomentumStageDefinition[],
): StageTransition[] {
  const stages = new Map(definitions.map((stage) => [stage.id, stage]));
  return changes(values).map((item) => {
    const fromStage = item.from ? stages.get(item.from) ?? null : null;
    const toStage = item.to ? stages.get(item.to) ?? null : null;
    let direction: StageTransition['direction'] = 'unknown';
    if (fromStage && toStage) {
      if (fromStage.pipelineId !== toStage.pipelineId) direction = 'pipeline_change';
      else if (toStage.displayOrder > fromStage.displayOrder) direction = 'advance';
      else if (toStage.displayOrder < fromStage.displayOrder) direction = 'regression';
    }
    return { ...item, fromStage, toStage, direction };
  });
}

function closeDateMoves(values: DealPropertyHistoryValue[]): CloseDateMove[] {
  return changes(values).map((item) => {
    const fromAt = time(item.from);
    const toAt = time(item.to);
    const deltaDays = fromAt === null || toAt === null ? null : Math.round((toAt - fromAt) / DAY_MS);
    const direction: CloseDateMove['direction'] = deltaDays === null || deltaDays === 0
      ? 'unknown'
      : deltaDays > 0 ? 'push' : 'pull_in';
    return { ...item, fromDate: item.from, toDate: item.to, deltaDays, direction };
  });
}

function latestTimestamp(groups: Array<Array<{ timestamp: string }>>): string | null {
  const values = groups.flat().map((item) => item.timestamp).filter((item) => time(item) !== null);
  return values.sort((left, right) => (time(right) ?? 0) - (time(left) ?? 0))[0] ?? null;
}

function ageDays(value: string | null | undefined, now: number): number | null {
  const parsed = time(value);
  return parsed === null ? null : Math.max(0, Math.floor((now - parsed) / DAY_MS));
}

function currentStageAge(deal: NormalizedDeal, now: number): number | null {
  const property = deal.stage?.enteredAtProperty;
  return property ? ageDays(deal.properties[property], now) : null;
}

function signal(
  code: string,
  label: string,
  direction: MomentumSignal['direction'],
  severity: MomentumSignal['severity'],
  observedAt: string | null,
  detail: string,
): MomentumSignal {
  return { code, label, direction, severity, observedAt, detail };
}

export function collectMomentumEvidence(
  deal: NormalizedDeal,
  settings: RuleSettings,
  history: DealHistoryContext,
  now = Date.now(),
): MomentumEvidence {
  const windowStart = now - MOMENTUM_WINDOW_DAYS * DAY_MS;
  const stageHistory = historyFor(history, 'dealstage', windowStart);
  const closeHistory = historyFor(history, 'closedate', windowStart);
  const ownerHistory = historyFor(history, 'hubspot_owner_id', windowStart);
  const amountHistory = historyFor(history, 'amount', windowStart);
  const nextStepHistory = historyFor(history, 'hs_next_step', windowStart);
  const transitions = stageTransitions(stageHistory, history.stageDefinitions);
  const closeMoves = closeDateMoves(closeHistory);
  const ownerChanges = changes(ownerHistory);
  const amountChanges = changes(amountHistory).filter((item) => numeric(item.from) !== numeric(item.to));
  const nextStepChanges = changes(nextStepHistory);
  const lastMaterialChangeAt = latestTimestamp([transitions, closeMoves, ownerChanges, amountChanges, nextStepChanges]);
  const tracked = [stageHistory, closeHistory, ownerHistory, amountHistory, nextStepHistory];
  const trackedPropertiesWithEvidence = tracked.filter((items) => items.length > 0).length;
  const evidenceCoveragePercent = Math.round((trackedPropertiesWithEvidence / tracked.length) * 100);
  const stageAge = currentStageAge(deal, now);
  const activityAge = ageDays(deal.properties.hs_last_sales_activity_timestamp, now);
  const currentCloseDate = deal.properties.closedate ?? null;
  const closeAt = time(currentCloseDate);
  const daysToClose = closeAt === null ? null : Math.ceil((closeAt - now) / DAY_MS);
  const signals: MomentumSignal[] = [];
  const advances = transitions.filter((item) => item.direction === 'advance');
  const regressions = transitions.filter((item) => item.direction === 'regression');
  const pushes = closeMoves.filter((item) => item.direction === 'push');
  const pullIns = closeMoves.filter((item) => item.direction === 'pull_in');

  if (advances.length > 0) signals.push(signal('stage_advance', 'Stage progression', 'positive', 'info', advances.at(-1)?.timestamp ?? null, `${advances.length} forward stage movement${advances.length === 1 ? '' : 's'} detected in 90 days.`));
  if (regressions.length > 0) signals.push(signal('stage_regression', 'Stage regression', 'negative', 'warning', regressions.at(-1)?.timestamp ?? null, `${regressions.length} backward stage movement${regressions.length === 1 ? '' : 's'} detected in 90 days.`));
  if (pushes.length > 0) signals.push(signal('close_date_push', 'Close date pushed', 'negative', pushes.length >= 2 ? 'critical' : 'warning', pushes.at(-1)?.timestamp ?? null, `${pushes.length} later close-date change${pushes.length === 1 ? '' : 's'} detected in 90 days.`));
  if (pullIns.length > 0) signals.push(signal('close_date_pull_in', 'Close date pulled in', 'positive', 'info', pullIns.at(-1)?.timestamp ?? null, `${pullIns.length} earlier close-date change${pullIns.length === 1 ? '' : 's'} detected in 90 days.`));
  if (ownerChanges.length > 1) signals.push(signal('owner_churn', 'Ownership changed repeatedly', 'negative', 'warning', ownerChanges.at(-1)?.timestamp ?? null, `${ownerChanges.length} owner changes detected in 90 days.`));
  if (stageAge !== null && stageAge > settings.maxStageAgeDays) signals.push(signal('stage_age_above_policy', 'Stage age above policy', 'negative', stageAge > settings.maxStageAgeDays * 2 ? 'critical' : 'warning', null, `Current stage age is ${stageAge} days; policy allows ${settings.maxStageAgeDays}.`));
  if (activityAge !== null && activityAge > settings.staleDays) signals.push(signal('recorded_activity_stale', 'Recorded sales activity is stale', 'negative', activityAge > settings.staleDays * 2 ? 'critical' : 'warning', deal.properties.hs_last_sales_activity_timestamp ?? null, `Last recorded sales activity was ${activityAge} days ago; policy allows ${settings.staleDays}.`));
  if ((deal.properties.hs_next_step ?? '').trim() && nextStepChanges.length > 0) signals.push(signal('next_step_refreshed', 'Next step refreshed', 'positive', 'info', nextStepChanges.at(-1)?.timestamp ?? null, 'The recorded next step changed during the evidence window.'));

  return {
    windowDays: MOMENTUM_WINDOW_DAYS,
    windowStartedAt: new Date(windowStart).toISOString(),
    fetchedAt: history.fetchedAt,
    evidenceCoveragePercent,
    trackedPropertiesWithEvidence,
    stageTransitions: transitions,
    closeDateMoves: closeMoves,
    ownerChanges,
    amountChanges,
    nextStepChanges,
    lastMaterialChangeAt,
    daysSinceMaterialChange: ageDays(lastMaterialChangeAt, now),
    currentStageAgeDays: stageAge,
    currentActivityAgeDays: activityAge,
    currentCloseDate,
    daysToClose,
    hasNextStep: Boolean((deal.properties.hs_next_step ?? '').trim()),
    stageAgeLimitDays: settings.maxStageAgeDays,
    staleActivityLimitDays: settings.staleDays,
    signals,
  };
}
