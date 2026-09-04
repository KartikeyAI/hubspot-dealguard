import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

test('release convergence contract is complete and internally consistent', () => {
  const output = execFileSync(process.execPath, ['scripts/release-convergence.mjs'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });
  const result = JSON.parse(output);
  assert.equal(result.ok, true, result.failures?.join('\n'));
  assert.equal(result.migrationRange.releaseStart, '0015');
  assert.equal(result.migrationRange.releaseEnd, '0022');
  assert.equal(result.checks.failed, 0);
  assert.ok(result.checks.total >= 80, `Expected a broad release contract, received ${result.checks.total} checks.`);
});
