import { createHash } from 'node:crypto';
import { postgresSql } from '../dist/postgres.js';

export function localFixtureUrl(variable, confirmation) {
  if (process.env[variable] !== confirmation) throw new Error(`Set ${variable} to the exact disposable-rehearsal confirmation.`);
  const source = new URL(process.env.DATABASE_URL ?? '');
  if (!['127.0.0.1', '[::1]'].includes(source.hostname) || source.pathname !== '/dealguard_test'
    || !['postgres:', 'postgresql:'].includes(source.protocol)) {
    throw new Error('This rehearsal requires the loopback dealguard_test database.');
  }
  return source;
}

export async function schemaEvidence(client) {
  const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='dealguard' ORDER BY tablename")).rows;
  const evidence = {};
  for (const { tablename } of tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(tablename)) throw new Error('Unexpected test schema identifier.');
    const rows = (await client.query(`SELECT to_jsonb(t)::text AS value FROM dealguard.${tablename} t ORDER BY to_jsonb(t)::text LIMIT 100001`)).rows;
    if (rows.length > 100000) throw new Error('The disposable test schema exceeds the fixture limit.');
    evidence[tablename] = { rows: rows.length,
      sha256: createHash('sha256').update(rows.map(row => row.value).join('\n')).digest('hex') };
  }
  return evidence;
}

// Local instrumentation, not a replacement for the deployed Neon HTTP adapter.
// The caller also enables PostgreSQL default_transaction_read_only on this client.
export function readOnlyPortalAdapter(client, portal, allPortals, stats) {
  const normalize = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value]));
  const prepare = (query, values = []) => {
    const execute = async () => {
      const sql = postgresSql.placeholders(postgresSql.qualifyRelations(query));
      if (!/^\s*SELECT\b/i.test(sql) || /;|\b(?:INSERT|UPDATE|DELETE|MERGE|CALL|COPY|ALTER|CREATE|DROP|TRUNCATE)\b/i.test(sql)) {
        stats.writeAttempts++;
        throw new Error('Recorded-read rehearsal attempted a non-read statement.');
      }
      const predicates = [...sql.matchAll(/\bportal_id\s*=\s*\$(\d+)\b/gi)];
      const scalar = /^\s*SELECT\s+dealguard\.(?:record_is_available|forecast_actor_authorized)\(\s*\$(\d+)/i.exec(sql);
      const scoped = predicates.some(match => values[Number(match[1]) - 1] === portal)
        || (scalar && values[Number(scalar[1]) - 1] === portal);
      if (!scoped || values.some(value => allPortals.includes(value) && value !== portal)) {
        stats.unexpectedTenantParameters++;
        throw new Error('Recorded-read rehearsal attempted an unscoped or other-portal query.');
      }
      stats.queries++;
      const result = await client.query(sql, values);
      for (const row of result.rows) {
        if (Object.hasOwn(row, 'portal_id') && row.portal_id !== portal) {
          stats.unexpectedTenantRows++;
          throw new Error('Recorded-read rehearsal returned another portal row.');
        }
      }
      stats.rows += result.rows.length;
      return { success: true, results: result.rows.map(normalize), meta: { changes: 0, rowCount: result.rowCount, command: result.command } };
    };
    return {
      bind(...args) { return prepare(query, args); },
      async first(column) { const row = (await execute()).results[0] ?? null; return row && column ? row[column] : row; },
      all: execute,
      run: execute,
    };
  };
  return { prepare, async batch() { stats.writeAttempts++; throw new Error('Recorded reads must not batch mutations.'); },
    async exec() { stats.writeAttempts++; throw new Error('Recorded reads must not execute raw statements.'); } };
}
