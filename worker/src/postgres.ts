import { Client, types as pgTypes, type QueryResultRow } from 'pg';
import type { Database, DatabasePreparedStatement, DatabaseResult } from './types.js';

pgTypes.setTypeParser(20, (value) => value);
pgTypes.setTypeParser(1700, (value) => value);

const STATEMENT_TIMEOUT_MS = 30_000;
const LOCK_TIMEOUT_MS = 5_000;
const APP_SCHEMA = 'dealguard';

// Application relations are deliberately schema-qualified at the adapter boundary.
// This makes every runtime query independent of session search_path and therefore
// safe when NEON_DATABASE_URL uses Neon's pooled/PgBouncer endpoint.
const APP_RELATIONS = new Set([
  'tenants','oauth_states','deal_assessments','deal_reviews','handoffs','scan_runs','audit_events',
  'slack_installations','slack_delivery_log','native_sync_state','governance_roles','policy_versions',
  'policy_approvals','policy_simulations','policy_exceptions','assessment_context','analytics_snapshots',
  'remediation_cases','remediation_events','enterprise_alerts','alert_deliveries','compliance_exports',
  'compliance_export_events','audit_chain','audit_chain_anchors','billing_subscriptions','billing_events',
  'billing_usage','billing_usage_counters','billing_schedules','data_retention_policies','retention_runs',
  'secure_downloads','change_approvals','change_approval_executions','policy_dimension_mappings','async_jobs',
  'dead_letter_jobs','object_attachments','outbox_events','siem_destinations','synthetic_checks',
]);

function placeholders(sql: string): string {
  let output = '', dollarTag = '';
  let parameter = 0, index = 0;
  let state: 'normal' | 'single' | 'double' | 'line' | 'block' | 'dollar' = 'normal';
  while (index < sql.length) {
    const char = sql[index]!, next = sql[index + 1] ?? '';
    if (state === 'normal') {
      if (char === "'") { state = 'single'; output += char; index++; continue; }
      if (char === '"') { state = 'double'; output += char; index++; continue; }
      if (char === '-' && next === '-') { state = 'line'; output += '--'; index += 2; continue; }
      if (char === '/' && next === '*') { state = 'block'; output += '/*'; index += 2; continue; }
      if (char === '$') { const match = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/); if (match) { dollarTag = match[0]; state = 'dollar'; output += dollarTag; index += dollarTag.length; continue; } }
      if (char === '?') { output += `$${++parameter}`; index++; continue; }
      output += char; index++; continue;
    }
    output += char; index++;
    if (state === 'single' && char === "'") { if (sql[index] === "'") { output += sql[index]; index++; } else state = 'normal'; }
    else if (state === 'double' && char === '"') { if (sql[index] === '"') { output += sql[index]; index++; } else state = 'normal'; }
    else if (state === 'line' && char === '\n') state = 'normal';
    else if (state === 'block' && char === '*' && sql[index] === '/') { output += '/'; index++; state = 'normal'; }
    else if (state === 'dollar' && output.endsWith(dollarTag)) state = 'normal';
  }
  return output;
}

function qualifyRelations(sql: string): string {
  // Only known DealGuard relations are rewritten. CTE names, functions and
  // external/system relations are left untouched.
  return sql.replace(/\b(FROM|JOIN|UPDATE|INTO|DELETE\s+FROM)\s+([A-Za-z_][A-Za-z0-9_]*)(?!\s*\.)/gi, (match, keyword: string, relation: string) => {
    if (!APP_RELATIONS.has(relation.toLowerCase())) return match;
    return `${keyword} ${APP_SCHEMA}.${relation}`;
  });
}

function normalizeValue(value: unknown): unknown { if (value === undefined) return null; if (value instanceof Date) return value.toISOString(); return value; }
function normalizeRow<T extends QueryResultRow>(row: T): T { for (const [key, value] of Object.entries(row)) if (value instanceof Date) (row as Record<string, unknown>)[key] = value.toISOString(); return row; }

async function configure(client: Client): Promise<void> {
  // These settings are operational only. Query correctness must never depend on
  // session state because pooled endpoints may swap server sessions.
  await client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
  await client.query(`SET lock_timeout = ${LOCK_TIMEOUT_MS}`);
  await client.query(`SET application_name = 'dealguard-worker'`);
}

class PostgresPreparedStatement implements DatabasePreparedStatement {
  private values: unknown[] = [];
  constructor(readonly database: PostgresDatabase, readonly query: string) {}
  bind(...values: unknown[]): DatabasePreparedStatement { const statement = new PostgresPreparedStatement(this.database, this.query); statement.values = values.map(normalizeValue); return statement; }
  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> { const result = await this.database.execute<T>(this.query, this.values); const row = result.results?.[0] as Record<string, unknown> | undefined; if (!row) return null; return (column ? row[column] : row) as T; }
  async run<T = unknown>(): Promise<DatabaseResult<T>> { return this.database.execute<T>(this.query, this.values); }
  async all<T = Record<string, unknown>>(): Promise<DatabaseResult<T>> { return this.database.execute<T>(this.query, this.values); }
  boundValues(): readonly unknown[] { return this.values; }
}

export class PostgresDatabase implements Database {
  constructor(private readonly connectionString: string) { if (!connectionString) throw new Error('Neon PostgreSQL connection string is missing.'); }
  prepare(query: string): DatabasePreparedStatement { return new PostgresPreparedStatement(this, query); }
  async execute<T = unknown>(query: string, values: readonly unknown[] = []): Promise<DatabaseResult<T>> {
    const client = new Client({ connectionString: this.connectionString }), started = Date.now();
    try {
      await client.connect(); await configure(client);
      const result = await client.query(placeholders(qualifyRelations(query)), [...values]);
      return { success: true, results: result.rows.map((row) => normalizeRow(row)) as T[], meta: { changes: result.rowCount ?? 0, rowCount: result.rowCount ?? 0, durationMs: Date.now() - started, command: result.command } };
    } finally { await client.end().catch(() => undefined); }
  }
  async batch<T = unknown>(statements: DatabasePreparedStatement[]): Promise<DatabaseResult<T>[]> {
    const client = new Client({ connectionString: this.connectionString }), results: DatabaseResult<T>[] = [];
    try {
      await client.connect(); await configure(client); await client.query('BEGIN');
      for (const item of statements) {
        if (!(item instanceof PostgresPreparedStatement) || item.database !== this) throw new Error('Database batch contains a statement from a different adapter.');
        const started = Date.now(), result = await client.query(placeholders(qualifyRelations(item.query)), [...item.boundValues()]);
        results.push({ success: true, results: result.rows.map((row) => normalizeRow(row)) as T[], meta: { changes: result.rowCount ?? 0, rowCount: result.rowCount ?? 0, durationMs: Date.now() - started, command: result.command } });
      }
      await client.query('COMMIT'); return results;
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { await client.end().catch(() => undefined); }
  }
  async exec(query: string): Promise<DatabaseResult> { return this.execute(query); }
}

export const postgresSql = { placeholders, qualifyRelations, relations: APP_RELATIONS };
