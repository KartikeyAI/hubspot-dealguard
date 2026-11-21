import type { CommercialTier, SubscriptionStatus } from './billing.js';
import type { PlanId } from './types.js';

export interface EntitlementState {
  status: SubscriptionStatus | string;
  currentPeriodEnd?: string | null;
  trialEndsAt?: string | null;
  graceEndsAt?: string | null;
  cancelAtPeriodEnd?: boolean;
}

export interface EntitlementRow {
  tier: CommercialTier;
  status: SubscriptionStatus;
  current_period_end: string | null;
  trial_ends_at: string | null;
  grace_ends_at: string | null;
  cancel_at_period_end: number;
}

function future(value: unknown, now: number): boolean {
  return typeof value === 'string' && value.trim() !== ''
    && Number.isFinite(Date.parse(value)) && Date.parse(value) > now;
}

/** Evaluate recorded authorization at request time without mutating provider state.
 * Open-ended manual contracts and active recurring records without an optional
 * period boundary remain compatible. Every explicit boundary is binding.
 */
export function subscriptionEntitled(state: EntitlementState, now = Date.now()): boolean {
  if (!Number.isFinite(now)) return false;
  if (state.status === 'on_hold' || state.status === 'past_due') return future(state.graceEndsAt, now);
  if (!['active', 'trialing', 'manual'].includes(state.status)) return false;
  if (state.currentPeriodEnd != null && !future(state.currentPeriodEnd, now)) return false;
  if (state.cancelAtPeriodEnd && !future(state.currentPeriodEnd, now)) return false;
  return state.status !== 'trialing' || future(state.trialEndsAt, now);
}

export function rowEntitled(row: EntitlementRow, now = Date.now()): boolean {
  return subscriptionEntitled({ status: row.status, currentPeriodEnd: row.current_period_end,
    trialEndsAt: row.trial_ends_at, graceEndsAt: row.grace_ends_at,
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end) }, now);
}

export function entitlementPlan(tier: CommercialTier, entitled: boolean): PlanId {
  return !entitled ? 'free' : tier === 'enterprise' ? 'beta_growth' : tier === 'growth' ? 'growth' : 'free';
}
