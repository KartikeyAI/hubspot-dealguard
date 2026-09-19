import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { releaseVersionPolicy } from '../scripts/release-baseline.mjs';

const root = new URL('../', import.meta.url);
const json = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'));

test('product, Worker and all HubSpot extension release identities agree', async () => {
  const product = await json('package.json');
  const runtime = await readFile(new URL('worker/src/version.ts', root), 'utf8');
  assert.equal(runtime.match(/DEALGUARD_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1], product.version);
  for (const path of ['src/app/cards/package.json', 'src/app/settings/package.json', 'src/app/pages/package.json']) {
    assert.equal((await json(path)).version, product.version, path);
  }
});

test('current release is staging-eligible without weakening production version policy', async () => {
  const { version } = await json('package.json');
  const staging = releaseVersionPolicy(version, 'staging');
  assert.equal(staging.ok, true);
  assert.equal(releaseVersionPolicy(version, 'production').ok, staging.channel === 'stable');
  assert.equal(releaseVersionPolicy('3.0.0-alpha.1', 'production').ok, false);
  assert.equal(releaseVersionPolicy('3.0.0', 'production').ok, true);
});

test('health endpoint uses the shared Worker release identity', async () => {
  const source = await readFile(new URL('worker/src/index.ts', root), 'utf8');
  assert.match(source, /import\s*\{\s*DEALGUARD_VERSION\s*\}\s*from\s*['"]\.\/version\.js['"]/);
  assert.match(source, /version:\s*DEALGUARD_VERSION/);
});
