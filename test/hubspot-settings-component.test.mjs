import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

async function collectHsmeta(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await collectHsmeta(path));
    else if (entry.name.endsWith('-hsmeta.json') || entry.name.endsWith('hsmeta.json')) files.push(path);
  }
  return files;
}

test('HubSpot project declares at most one settings component', async () => {
  const files = await collectHsmeta('src/app');
  const settings = [];
  for (const file of files) {
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    if (manifest.type === 'settings') settings.push(file);
  }
  assert.deepEqual(settings, ['src/app/settings/dealguard-settings-hsmeta.json']);
});
