import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

// Always creates its own local cluster. Never consumes DATABASE_URL or .env.
// Supply a directory containing PostgreSQL 18+ binaries, or put them on PATH.
const root = resolve(import.meta.dirname, '..');
const binary = name => process.env.DEALGUARD_POSTGRES_BIN ? join(process.env.DEALGUARD_POSTGRES_BIN, name) : name;
const directory = await mkdtemp(join(tmpdir(), 'dealguard-tests-'));
let server;
let serverExit;
let log = '';
let stopping = false;
async function command(executable, args, env = process.env, quiet = false) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, env, stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let output = '';
    if (quiet) for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-16000); });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${executable} failed (${signal ?? code}).${quiet ? '\n' + output : ''}`)));
  });
}
async function stop() {
  if (stopping) return;
  stopping = true;
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGINT');
    await Promise.race([serverExit, delay(5000)]);
    if (server.exitCode === null && server.signalCode === null) { server.kill('SIGKILL'); await serverExit; }
  }
  await rm(directory, { recursive: true, force: true });
}
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void stop().finally(() => process.exit(130)); });
try {
  const port = await new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); });
  });
  await command(binary('initdb'), ['-D', directory, '-U', 'dealguard_test', '--auth=trust', '--encoding=UTF8', '--no-locale'], process.env, true);
  server = spawn(binary('postgres'), ['-D', directory, '-h', '127.0.0.1', '-p', String(port), '-k', '', '-c', 'max_connections=150'], { stdio: ['ignore', 'pipe', 'pipe'] });
  serverExit = new Promise(resolve => { server.once('exit', resolve); server.once('error', error => { log += error.message; resolve(); }); });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-12000); });
  const databaseUrl = `postgresql://dealguard_test@127.0.0.1:${port}/dealguard_test`;
  const administrativeUrl = new URL(databaseUrl);
  administrativeUrl.pathname = '/postgres';
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const client = new pg.Client({ connectionString: administrativeUrl.toString(), connectionTimeoutMillis: 250 });
    try { await client.connect(); await client.query('CREATE DATABASE dealguard_test'); ready = true; break; }
    catch { if (server.exitCode !== null || server.signalCode !== null) break; await delay(100); }
    finally { await client.end().catch(() => undefined); }
  }
  if (!ready) throw new Error(`Disposable PostgreSQL did not become ready.\n${log}`);
  const env = { ...process.env, DATABASE_URL: databaseUrl, NEON_DATABASE_URL: databaseUrl,
    DEALGUARD_ANALYTICS_TEST_DATABASE_URL: databaseUrl, DEALGUARD_CUTOVER_TEST_DATABASE_URL: databaseUrl,
    DEALGUARD_REQUIRE_POSTGRES_TESTS: 'true' };
  console.log('Using a new disposable PostgreSQL database; external databases are not used.');
  await command(process.execPath, ['scripts/postgres-migrate.mjs'], env, true);
  await command(process.execPath, ['scripts/postgres-migrate.mjs', '--check'], env, true);
  let args = process.argv.slice(2);
  if (args[0] === '--') args = args.slice(1);
  if (args.length) await command(args[0], args.slice(1), env);
  else {
    await command('npm', ['run', 'db:validate'], env);
    await command('npm', ['run', 'check'], env);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally { await stop(); }
