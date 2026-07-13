import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSettings } from '../dist/validation.js';

test('limits free portals to three custom rules and weekly digest', () => {
  const settings = parseSettings({
    rules: {
      staleDays: 999,
      customRequiredProperties: Array.from({ length: 5 }, (_, index) => ({
        property: `field_${index}`,
        label: `Field ${index}`,
        weight: 100,
        severity: 'warning',
        stageIds: [],
      })),
    },
    digest: { enabled: false, frequency: 'daily' },
    nativeSync: { enabled: true },
  }, 'free');
  assert.equal(settings.rules.staleDays, 90);
  assert.equal(settings.rules.customRequiredProperties.length, 3);
  assert.equal(settings.rules.customRequiredProperties[0].weight, 30);
  assert.equal(settings.digest.frequency, 'weekly');
  assert.equal(settings.notifications.slack.enabled, false);
  assert.equal(settings.nativeSync.enabled, false);
});

test('rejects enabled digest without recipient', () => {
  assert.throws(() => parseSettings({ digest: { enabled: true, recipients: [] } }, 'growth'));
});

test('enables governed Slack settings only for Growth plans', () => {
  const growth = parseSettings({ notifications: { slack: { enabled: true, cooldownMinutes: 1 } } }, 'growth');
  assert.equal(growth.notifications.slack.enabled, true);
  assert.equal(growth.notifications.slack.cooldownMinutes, 15);
  const free = parseSettings({ notifications: { slack: { enabled: true } } }, 'free');
  assert.equal(free.notifications.slack.enabled, false);
});

test('enables native property sync only for Growth plans', () => {
  const growth = parseSettings({ nativeSync: { enabled: true, includeSummary: false } }, 'growth');
  assert.equal(growth.nativeSync.enabled, true);
  assert.equal(growth.nativeSync.includeSummary, false);
  const free = parseSettings({ nativeSync: { enabled: true, includeSummary: false } }, 'free');
  assert.equal(free.nativeSync.enabled, false);
  assert.equal(free.nativeSync.includeSummary, false);
});
