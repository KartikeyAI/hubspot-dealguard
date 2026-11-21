import test from 'node:test';
import assert from 'node:assert/strict';
import { subscriptionEntitled, rowEntitled, entitlementPlan } from '../dist/billing-entitlements.js';

const now = Date.parse('2026-11-21T10:00:00Z');
const future = '2026-11-21T10:00:01Z';
const past = '2026-11-21T09:59:59Z';
const atBoundary = new Date(now).toISOString();

test('recorded billing deadlines expire at their exact boundary without a webhook or scheduler', () => {
  for (const status of ['active', 'manual', 'trialing']) {
    for (const end of [past, atBoundary, '', 'invalid']) {
      assert.equal(subscriptionEntitled({status, currentPeriodEnd: end, trialEndsAt: future}, now), false, `${status} ${end}`);
    }
    assert.equal(subscriptionEntitled({status, currentPeriodEnd: future, trialEndsAt: future}, now), true);
  }
  for (const trialEndsAt of [undefined, null, past, atBoundary, '', 'invalid']) {
    assert.equal(subscriptionEntitled({status: 'trialing', trialEndsAt, currentPeriodEnd: future}, now), false);
  }
  assert.equal(subscriptionEntitled({status: 'trialing', trialEndsAt: future}, now), true);
});

test('grace is non-sliding and a cancellation cannot become an open-ended entitlement', () => {
  for (const status of ['on_hold', 'past_due']) {
    assert.equal(subscriptionEntitled({status, currentPeriodEnd: past, graceEndsAt: future}, now), true);
    for (const graceEndsAt of [null, undefined, past, atBoundary, '', 'invalid']) {
      assert.equal(subscriptionEntitled({status, graceEndsAt}, now), false);
    }
  }
  for (const status of ['active', 'manual', 'trialing']) {
    for (const currentPeriodEnd of [null, undefined, past, atBoundary, 'invalid']) {
      assert.equal(subscriptionEntitled({status, currentPeriodEnd, trialEndsAt: future, cancelAtPeriodEnd: true}, now), false);
    }
    assert.equal(subscriptionEntitled({status, currentPeriodEnd: future, trialEndsAt: future, cancelAtPeriodEnd: true}, now), true);
  }
});

test('explicitly open-ended contracts and authoritative active records remain compatible', () => {
  for (const status of ['active', 'manual']) {
    assert.equal(subscriptionEntitled({status}, now), true);
    assert.equal(subscriptionEntitled({status, currentPeriodEnd: null}, now), true);
  }
  for (const status of ['pending', 'failed', 'expired', 'cancelled', 'none', 'unexpected']) {
    assert.equal(subscriptionEntitled({status, currentPeriodEnd: future, graceEndsAt: future}, now), false);
  }
  assert.equal(subscriptionEntitled({status: 'active'}, NaN), false);
  assert.equal(rowEntitled({tier: 'enterprise', status: 'manual', current_period_end: past,
    trial_ends_at: null, grace_ends_at: null, cancel_at_period_end: 0}, now), false);
  assert.equal(entitlementPlan('enterprise', false), 'free');
  assert.equal(entitlementPlan('enterprise', true), 'beta_growth');
  assert.equal(entitlementPlan('growth', true), 'growth');
});
