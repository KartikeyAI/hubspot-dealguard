import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const target = process.env.RELEASE_TARGET === 'production' ? 'production' : 'staging';
const config = process.env.RELEASE_WRANGLER_CONFIG || '.release/wrangler.toml';
const output = process.env.RELEASE_BUNDLE_DIR || `.release/worker-${target}`;
await mkdir(output, { recursive: true });

const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(executable, [
  'wrangler',
  'deploy',
  '--dry-run',
  '--outdir', output,
  '--config', config,
  '--env', target,
], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});

if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;
