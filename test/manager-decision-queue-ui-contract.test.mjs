import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const component = await readFile('src/app/pages/ManagerDecisionQueuePanel.tsx', 'utf8');
const home = await readFile('src/app/pages/EnterpriseHomeV4.tsx', 'utf8');
const workflow = await readFile('.github/workflows/p2-decision-intelligence.yml', 'utf8');
const docs = await readFile('docs/MANAGER_DECISION_QUEUE.md', 'utf8');

test('App Home panel loads the scoped manager queue with bounded server-side filters', () => {
  assert.match(component, /\/enterprise\/decision-queue/);
  assert.match(component, /const QUEUE_LIMIT = 25/);
  assert.match(component, /params\.set\('band', band\)/);
  assert.match(component, /params\.set\('evidenceMode', evidence\)/);
  assert.match(component, /if \(!enabled\) return;/);
  assert.doesNotMatch(component, /\/crm\/objects\//);
  assert.doesNotMatch(component, /method:\s*'(POST|PUT|PATCH|DELETE)'/);
});

test('panel exposes management summaries, filters, ranked evidence and direct record navigation', () => {
  for (const label of [
    'Manager Decision Queue',
    'PRIORITY FILTER',
    'EVIDENCE FILTER',
    'ACT NOW',
    'OVERDUE ACTIONS',
    'FULL DEAL BRIEF COVERAGE',
    'Why this deal is prioritised',
    'Open deal record',
  ]) assert.match(component, new RegExp(label));
  assert.match(component, /href=\{\{ url: item\.recordUrl, external: true \}\}/);
  assert.match(component, /item\.nextAction\.overdue/);
  assert.match(component, /item\.evidenceCoveragePercent/);
  assert.match(component, /item\.commercialImportanceScore/);
});

test('panel states the deterministic and currency-safe interpretation boundary', () => {
  assert.match(component, /currencies are never combined/i);
  assert.match(component, /not buyer intent, a forecast category, a win probability, or expected financial loss/i);
  assert.match(component, /missing evidence is not proof that a deal will be lost/i);
  assert.match(component, /No safe comparable-currency percentile is available/);
});

test('deployed Enterprise Home renders the queue panel behind entitlement', () => {
  assert.match(home, /import \{ ManagerDecisionQueuePanel \} from '\.\/ManagerDecisionQueuePanel'/);
  assert.match(home, /<ManagerDecisionQueuePanel enabled=\{access\.entitled\} \/>/);
});

test('documentation and focused CI cover the App Home product surface', () => {
  assert.match(docs, /## App Home product surface/);
  assert.match(docs, /priority and evidence filters/);
  assert.match(workflow, /src\/app\/pages\/ManagerDecisionQueuePanel\.tsx/);
  assert.match(workflow, /test\/manager-decision-queue-ui-contract\.test\.mjs/);
  assert.match(workflow, /manager-decision-queue-ui-contract\.test\.mjs/);
});
