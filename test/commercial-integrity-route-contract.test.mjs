import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('commercial wrapper remains active in the converged route chain', () => {
  assert.match(read('worker/src/index.ts'), /routes-v17\.js/);
  assert.match(read('worker/src/routes-v12.ts'), /routes-v11\.js/);
});

test('commercial enrichment wraps only deal assessment GET and POST requests', () => {
  const source = read('worker/src/routes-v11.ts');
  assert.match(source, /assessmentDealId/);
  assert.match(source, /\['GET', 'POST'\]/);
  assert.match(source, /routeV10\(request, env, ctx\)/);
  assert.match(source, /augmentAssessmentWithCommercialIntegrity/);
});

test('commercial access is progressive and permission checked', () => {
  const source = read('worker/src/routes-v11.ts');
  assert.match(source, /commercial-access/);
  assert.match(source, /integration\.manage/);
  assert.match(source, /optional_scope/);
  assert.match(source, /missingScopes/);
});
