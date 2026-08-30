import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const config = fs.readFileSync(new URL('../worker/src/config.ts', import.meta.url), 'utf8');
const history = fs.readFileSync(new URL('../worker/src/deal-history.ts', import.meta.url), 'utf8');

test('history enrichment requests the exact five approved deal properties', () => {
  assert.match(config, /DEAL_HISTORY_PROPERTIES = \['dealstage','closedate','amount','hubspot_owner_id','hs_next_step'\]/);
  assert.match(history, /DEAL_HISTORY_PROPERTIES\.join\(','\)/);
  assert.doesNotMatch(history, /description|email|meeting|call_recording|notes/);
});

test('history and pipeline metadata use HubSpot date-versioned 2026-03 endpoints', () => {
  assert.match(history, /\/crm\/objects\/2026-03\/deals\//);
  assert.match(history, /\/crm\/pipelines\/2026-03\/deals/);
  assert.match(history, /propertiesWithHistory=/);
});

test('history values are normalized chronologically and stage order is retained', () => {
  assert.match(history, /new Date\(item\.timestamp\)\.toISOString\(\)/);
  assert.match(history, /\.sort\(\(left, right\) => Date\.parse\(left\.timestamp\) - Date\.parse\(right\.timestamp\)\)/);
  assert.match(history, /displayOrder: Number\(stage\.displayOrder \?\? 0\)/);
  assert.match(history, /pipelineId: pipeline\.id/);
});
