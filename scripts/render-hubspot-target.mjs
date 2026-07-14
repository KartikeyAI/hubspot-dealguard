import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

const target = new URL(process.env.HUBSPOT_TARGET_BASE_URL || process.env.APP_BASE_URL || '');
if (target.protocol !== 'https:') throw new Error('HUBSPOT_TARGET_BASE_URL must be HTTPS.');
const origins = ['https://dealguard-api.rokad.co', 'https://dealguard-api-staging.rokad.co'];

async function files(root) {
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...await files(path));
    else if (/\.(json|tsx|ts)$/.test(entry.name)) output.push(path);
  }
  return output;
}

for (const path of await files('src/app')) {
  let value = await readFile(path, 'utf8');
  for (const origin of origins) value = value.replaceAll(origin, target.origin);
  if (path.endsWith('app-hsmeta.json')) {
    const manifest = JSON.parse(value);
    manifest.config.auth.redirectUrls = [...new Set(manifest.config.auth.redirectUrls)];
    manifest.config.permittedUrls.fetch = [...new Set(manifest.config.permittedUrls.fetch)];
    value = `${JSON.stringify(manifest, null, 2)}\n`;
  }
  await writeFile(path, value);
}
console.log(`Rendered HubSpot project for ${target.origin}.`);
