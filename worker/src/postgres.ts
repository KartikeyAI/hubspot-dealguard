import { neon } from '@neondatabase/serverless';
import type { Database, DatabasePreparedStatement, DatabaseResult } from './types.js';

const QUERY_TIMEOUT_MS = 20_000;
const APP_SCHEMA = 'dealguard';

const APP_RELATIONS = new Set([
  'tenants','oauth_states','deal_assessments','deal_reviews','handoffs','scan_runs','audit_events',
  'slack_installations','slack_delivery_log','native_sync_state','governance_roles','policy_versions',
  'policy_approvals','policy_simulations','policy_exceptions','assessment_context','analytics_snapshots',
  'remediation_cases','remediation_events','enterprise_alerts','alert_deliveries','compliance_exports',
  'compliance_export_events','audit_chain','audit_chain_anchors','billing_subscriptions','billing_events',
  'billing_usage','billing_usage_counters','billing_schedules','data_retention_policies','retention_runs',
  'secure_downloads','change_approvals','change_approval_executions','policy_dimension_mappings','async_jobs',
  'dead_letter_jobs','object_attachments','outbox_events','siem_destinations','synthetic_checks',
  'alert_instances','alert_suppressions','analytics_saved_views','assessment_history','audit_events_v2',
  'backup_manifests','billing_allowances','billing_contracts','billing_usage_events','business_calendars',
  'change_approval_requests','compliance_settings','data_export_jobs','enterprise_role_assignments',
  'escalation_policies','inbound_events','incidents','integration_oauth_states','job_leases',
  'legacy_audit_promotions','legal_holds','notification_channels','notification_destinations',
  'notification_events','notification_routes','object_uploads','operational_metrics','outbox_deliveries',
  'policy_diffs','policy_exception_comments','policy_exception_evidence','policy_import_exports',
  'policy_segments','policy_templates','remediation_bulk_jobs','remediation_comments','remediation_evidence',
  'restore_tests','scan_checkpoints','secure_download_tokens','service_health','service_slos','slack_connections',
  'subscriptions','subscriptions_v2',
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
  return sql.replace(/\b(FROM|JOIN|UPDATE|INTO|DELETE\s+FROM)\s+([A-Za-z_][A-Za-z0-9_]*)(?!\s*\.)/gi, (match, keyword: string, relation: string) => {
    if (!APP_RELATIONS.has(relation.toLowerCase())) return match;
    return `${keyword} ${APP_SCHEMA}.${relation}`;
  });
}

function normalizeValue(value: unknown): unknown { if (value === undefined) return null; if (value instanceof Date) return value.toISOString(); return value; }
function normalizeRow<T>(row: T): T { if (!row || typeof row !== 'object') return row; for (const [key, value] of Object.entries(row as Record<string, unknown>)) if (value instanceof Date) (row as Record<string, unknown>)[key] = value.toISOString(); return row; }
function prepared(query: string): string { return placeholders(qualifyRelations(query)); }
function fetchOptions(): { signal: AbortSignal } { return { signal: AbortSignal.timeout(QUERY_TIMEOUT_MS) }; }

type FullResult = { rows: Record<string, unknown>[]; rowCount?: number; command?: string };

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
  private readonly sql;
  constructor(private readonly connectionString: string) {
    if (!connectionString) throw new Error('Neon PostgreSQL connection string is missing.');
    this.sql = neon(connectionString);
  }
  prepare(query: string): DatabasePreparedStatement { return new PostgresPreparedStatement(this, query); }
  async execute<T = unknown>(query: string, values: readonly unknown[] = []): Promise<DatabaseResult<T>> {
    const started = Date.now();
    const result = await this.sql.query(prepared(query), [...values], { fullResults: true, fetchOptions: fetchOptions() }) as FullResult;
    return { success: true, results: result.rows.map((row) => normalizeRow(row)) as T[], meta: { changes: result.rowCount ?? 0, rowCount: result.rowCount ?? 0, durationMs: Date.now() - started, command: result.command ?? '' } };
  }
  async batch<T = unknown>(statements: DatabasePreparedStatement[]): Promise<DatabaseResult<T>[]> {
    const items = statements.map((item) => {
      if (!(item instanceof PostgresPreparedStatement) || item.database !== this) throw new Error('Database batch contains a statement from a different adapter.');
      return { query: prepared(item.query), values: [...item.boundValues()] };
    });
    const started = Date.now();
    const results = await this.sql.transaction((txn) => items.map((item) => txn.query(item.query, item.values)), { fullResults: true, fetchOptions: fetchOptions() }) as FullResult[];
    return results.map((result) => ({ success: true, results: result.rows.map((row) => normalizeRow(row)) as T[], meta: { changes: result.rowCount ?? 0, rowCount: result.rowCount ?? 0, durationMs: Date.now() - started, command: result.command ?? '' } }));
  }
  async exec(query: string): Promise<DatabaseResult> { return this.execute(query); }
}

export const postgresSql = { placeholders, qualifyRelations, relations: APP_RELATIONS };
