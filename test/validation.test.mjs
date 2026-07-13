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
  }, 'free');
  assert.equal(settings.rules.staleDays, 90);
  assert.equal(settings.rules.customRequiredProperties.length, 3);
  assert.equal(settings.rules.customRequiredProperties[0].weight, 30);
  assert.equal(settings.digest.frequency, 'weekly');
});

test('rejects enabled digest without recipient', () => {
  assert.throws(() => parseSettings({ digest: { enabled: true, recipients: [] } }, 'growth'));
});
