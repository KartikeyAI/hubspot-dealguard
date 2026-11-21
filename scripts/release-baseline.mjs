import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Release channels are deliberately narrower than the complete SemVer grammar. */
export function releaseVersionPolicy(version, target) {
  const match = typeof version === 'string'
    ? /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/.exec(version)
    : null;
  const channel = match ? (match[4] ?? 'stable') : null;
  const ok = ['staging', 'production'].includes(target) && Boolean(match && match[0] === version)
    && (target !== 'production' || channel === 'stable');
  return { ok, channel, rule: target === 'production'
    ? 'Production requires stable semver without prerelease or build metadata.'
    : 'Staging accepts stable semver or alpha.N, beta.N, and rc.N prereleases.' };
}

export function releaseTarget(value = 'staging') {
  if (!['staging', 'production'].includes(value)) throw new Error('Release target must be staging or production.');
  return value;
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fingerprint = (entries) => sha256(JSON.stringify(entries));

/** Read only committed repository objects. This does not inspect a live service or database. */
export async function collectReleaseBaseline({ root = process.cwd(), target = 'staging', expectedCommit } = {}) {
  target = releaseTarget(target);
  root = await realpath(root);
  const git = (args) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (await realpath(git(['rev-parse', '--show-toplevel']).trim()) !== root) {
    throw new Error('Run release baseline from the repository root.');
  }
  const commit = git(['rev-parse', 'HEAD']).trim();
  if (expectedCommit !== undefined && (!/^[a-f0-9]{40}$/i.test(expectedCommit) || expectedCommit.toLowerCase() !== commit)) {
    throw new Error('Checked-out commit does not match the requested full release SHA.');
  }
  if (git(['status', '--porcelain', '--untracked-files=no']).trim()) {
    throw new Error('Tracked worktree or index changes prevent an immutable release baseline.');
  }
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z', '--',
    'worker/src', 'src/app', 'database/migrations', 'scripts', '.github/workflows',
    'package.json', 'hsproject.json', 'wrangler.toml', 'tsconfig.json']);
  if (untracked) throw new Error('Untracked release source must be committed or removed before baselining.');

  const entries = git(['ls-tree', '-rz', '--full-tree', commit]).split('\0').filter(Boolean).map((entry) => {
    const [header, path] = entry.split('\t');
    const [mode, type, object] = header.split(' ');
    return { path, mode, type, object };
  });
  const tree = new Map(entries.map((entry) => [entry.path, entry]));
  const read = (path) => {
    const entry = tree.get(path);
    if (!entry || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) {
      throw new Error(`Missing or non-regular release file: ${path}`);
    }
    return git(['show', `${commit}:${path}`]);
  };
  const json = (path) => {
    try { return JSON.parse(read(path)); } catch { throw new Error(`Invalid release JSON: ${path}`); }
  };
  const digest = (path) => ({ path, sha256: sha256(read(path)) });
  const packageJson = json('package.json');
  const policy = releaseVersionPolicy(packageJson.version, target);
  if (!policy.ok) throw new Error(policy.rule);
  const runtime = read('worker/src/version.ts').match(/\bDEALGUARD_VERSION\s*=\s*['"]([^'"]+)['"]/);
  if (runtime?.[1] !== packageJson.version) throw new Error('Worker release version does not match package.json.');
  const project = json('hsproject.json');
  if (typeof project.platformVersion !== 'string' || !project.platformVersion) {
    throw new Error('HubSpot project must declare its platform version.');
  }

  const paths = [...tree.keys()].sort();
  const migrationPaths = paths.filter((path) => /^database\/migrations\/.*\.sql$/.test(path));
  if (!migrationPaths.length || migrationPaths.some((path, index) => {
    const match = /^database\/migrations\/(\d{4})_[A-Za-z0-9_]+\.sql$/.exec(path);
    return !match || Number(match[1]) !== index + 1;
  })) throw new Error('SQL migrations must be non-empty, uniquely numbered, and contiguous from 0001.');
  const migrations = migrationPaths.map(digest);

  const manifestPaths = paths.filter((path) => path.startsWith('src/app/') && path.endsWith('-hsmeta.json'));
  const seen = new Set();
  const components = manifestPaths.map((path) => {
    const manifest = json(path);
    if (typeof manifest.uid !== 'string' || !manifest.uid || typeof manifest.type !== 'string' || !manifest.type) {
      throw new Error(`HubSpot component identity is missing: ${path}`);
    }
    if (seen.has(manifest.uid)) throw new Error('Duplicate HubSpot component UID in release.');
    seen.add(manifest.uid);
    return { ...digest(path), uid: manifest.uid, type: manifest.type };
  });
  const app = json('src/app/app-hsmeta.json');
  const auth = app.config?.auth;
  const scopes = (value) => {
    if (!Array.isArray(value) || value.some((scope) => typeof scope !== 'string' || !scope)
      || new Set(value).size !== value.length) throw new Error('OAuth scope inventory must contain unique strings.');
    return [...value].sort();
  };
  const requiredScopes = scopes(auth?.requiredScopes);
  const optionalScopes = scopes(auth?.optionalScopes ?? []);
  if (requiredScopes.some((scope) => optionalScopes.includes(scope))) throw new Error('Required and optional scopes overlap.');
  const packages = paths.filter((path) => path === 'package.json'
    || /^src\/app\/[^/]+\/package\.json$/.test(path)).map((path) => ({ ...digest(path), version: json(path).version ?? null }));
  if (packages.some((entry) => entry.version !== packageJson.version)) {
    throw new Error('Every HubSpot UI package version must match the root and Worker release identity.');
  }
  const configuration = ['package.json', 'worker/src/version.ts', 'hsproject.json', 'wrangler.toml'].map(digest);

  return {
    schemaVersion: 1,
    evidenceType: 'repository_baseline',
    generatedAt: new Date().toISOString(),
    target,
    source: { commit, tree: git(['rev-parse', `${commit}^{tree}`]).trim(), clean: true },
    release: { version: packageJson.version, channel: policy.channel, packages },
    database: { requiredMigrationVersion: migrations.length, migrationCount: migrations.length,
      manifestSha256: fingerprint(migrations), migrations, appliedVersion: null },
    hubspot: { platformVersion: project.platformVersion, projectBuildId: null,
      requiredScopes, optionalScopes, components, manifestSha256: fingerprint(components) },
    configuration,
    verification: { repository: 'passed', liveDatabase: 'not_verified', hubspotInstallation: 'not_verified',
      stagingAcceptance: 'not_verified', productionDeployment: 'not_verified' },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--target', '--output'].includes(key) || options[key] !== undefined
      || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Usage: release-baseline.mjs [--target staging|production] [--output file.json]');
    options[key] = args[index + 1];
  }
  const target = releaseTarget(options['--target'] ?? process.env.RELEASE_TARGET ?? 'staging');
  if (process.env.RELEASE_TARGET !== undefined && target !== releaseTarget(process.env.RELEASE_TARGET)) {
    throw new Error('CLI target conflicts with the protected release environment.');
  }
  const evidence = await collectReleaseBaseline({ target, expectedCommit: process.env.RELEASE_SHA });
  const output = resolve(options['--output'] ?? '.release/release-baseline.json');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(`Repository baseline recorded: ${evidence.release.version} / ${evidence.source.commit} / ${target}. Live deployment is not verified.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    // Do not print child-process stderr, environment variables, or connection strings.
    console.error(error?.status !== undefined ? 'Release baseline could not read Git repository metadata.' : error.message);
    process.exitCode = 1;
  });
}
