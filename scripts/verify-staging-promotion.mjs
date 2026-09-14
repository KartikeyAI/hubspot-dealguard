import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { deploymentEvidenceFailures, stagingRunFailures } from './intelligence-certification.mjs';

function valueAfter(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}
async function main() {
  const input = resolve(valueAfter('--input') ?? '.release/staging-evidence');
  const expectedCommit = String(process.env.RELEASE_SHA ?? '').trim();
  const expectedVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
  const metadata = JSON.parse(await readFile(resolve(valueAfter('--run-metadata') ?? '.release/staging-run.json'), 'utf8'));
  const paths = [];
  let visited = 0;
  async function walk(directory, depth = 0) {
    if (depth > 8) throw new Error('Staging evidence directory exceeds depth limit.');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++visited > 1000) throw new Error('Staging evidence directory exceeds entry limit.');
      if (entry.isSymbolicLink()) throw new Error('Staging evidence must not contain symlinks.');
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile() && entry.name === 'deployment-record.json') paths.push(path);
    }
  }
  await walk(input);
  if (paths.length !== 1) throw new Error('Exactly one staging deployment record is required.');
  const record = JSON.parse(await readFile(paths[0], 'utf8'));
  const failures = deploymentEvidenceFailures(record);
  failures.push(...stagingRunFailures(metadata, record, process.env.GITHUB_REPOSITORY, process.env.STAGING_RUN_ID));
  if (record.target !== 'staging') failures.push('evidence target is not staging');
  if (record.result !== 'passed' || record.promotable !== true) failures.push('staging deployment is not promotable');
  if (record.commit !== expectedCommit) failures.push('staging commit does not match requested production commit');
  if (record.version !== expectedVersion) failures.push('staging version does not match package version');
  if (record.acceptance?.profile !== 'full') failures.push('staging acceptance profile is not full');
  if (failures.length) throw new Error(`Production promotion rejected:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
  console.log(`Production promotion approved from staging run ${record.runId} attempt ${record.runAttempt} for ${record.commit}.`);
}
main().catch((error) => {
  // Filesystem/JSON errors are deliberately generic: evidence may contain private data.
  console.error(error instanceof SyntaxError || error?.code ? 'Production promotion rejected: evidence is missing or unreadable.' : error.message);
  process.exitCode = 1;
});
