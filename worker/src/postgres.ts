import { Client, types as pgTypes, type QueryResultRow } from 'pg';
import type { Database, DatabasePreparedStatement, DatabaseResult } from './types.js';

pgTypes.setTypeParser(20, (value) => value);
pgTypes.setTypeParser(1700, (value) => value);

const STATEMENT_TIMEOUT_MS = 30_000;
const LOCK_TIMEOUT_MS = 5_000;

function placeholders(sql: string): string {
  let output = '';
  let parameter = 0;
  let index = 0;
  let state: 'normal' | 'single' | 'double' | 'line' | 'block' | 'dollar' = 'normal';
  let dollarTag = '';

  while (index < sql.length) {
    const char = sql[index]!;
    const next = sql[index + 1] ?? '';

    if (state === 'normal') {
      if (char === "'") { state = 'single'; output += char; index += 1; continue; }
      if (char === '"') { state = 'double'; output += char; index += 1; continue; }
      if (char === '-' && next === '-') { state = 'line'; output += '--'; index += 2; continue; }
      if (char === '/' && next === '*') { state = 'block'; output += '/*'; index += 2; continue; }
      if (char === '$') {
        const match = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
        if (match) {
          dollarTag = match[0];
          state = 'dollar';
          output += dollarTag;
          index += dollarTag.length;
          continue;
        }
      }
      if (char === '?') {
        parameter += 1;
        output += `$${parameter}`;
        index += 1;
        continue;
      }
      output += char;
      index += 1;
      continue;
    }

    output += char;
    index += 1;
    if (state === 'single' && char === "'") {
      if (sql[index] === "'") { output += sql[index]; index += 1; }
      else state = 'normal';
    } else if (state === 'double' && char === '"') {
      if (sql[index] === '"') { output += sql[index]; index += 1; }
      else state = 'normal';
    } else if (state === 'line' && char === '\n') state = 'normal';
    else if (state === 'block' && char === '*' && sql[index] === '/') {
      output += '/'; index += 1; state = 'normal';
    } else if (state === 'dollar' && output.endsWith(dollarTag)) state = 'normal';
  }

  return output;
}

function normalizeValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function normalizeRow<T extends QueryResultRow>(row: T): T {
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Date) (row as Record<string, unknown>)[key] = value.toISOString();
  }
  return row;
}

async function configure(client: Client): Promise<void> {
  await client.query(`SET search_path TO dealguard, public`);
  await client.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
  await client.query(`SET lock_timeout = ${LOCK_TIMEOUT_MS}`);
  await client.query(`SET application_name = 'dealguard-worker'`);
}

class PostgresPreparedStatement implements DatabasePreparedStatement {
  private values: unknown[] = [];

  constructor(
    readonly database: PostgresDatabase,
    readonly query: string,
  ) {}

  bind(...values: unknown[]): DatabasePreparedStatement {
    const statement = new PostgresPreparedStatement(this.database, this.query);
    statement.values = values.map(normalizeValue);
    return statement;
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const result = await this.database.execute<T>(this.query, this.values);
    const row = result.results?.[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }

  async run<T = unknown>(): Promise<DatabaseResult<T>> {
    return this.database.execute<T>(this.query, this.values);
  }

  async all<T = Record<string, unknown>>(): Promise<DatabaseResult<T>> {
    return this.database.execute<T>(this.query, this.values);
  }

  boundValues(): readonly unknown[] { return this.values; }
}

export class PostgresDatabase implements Database {
  constructor(private readonly connectionString: string) {
    if (!connectionString) throw new Error('Hyperdrive PostgreSQL connection string is missing.');
  }

  prepare(query: string): DatabasePreparedStatement {
    return new PostgresPreparedStatement(this, query);
  }

  async execute<T = unknown>(query: string, values: readonly unknown[] = []): Promise<DatabaseResult<T>> {
    const client = new Client({ connectionString: this.connectionString });
    const started = Date.now();
    try {
      await client.connect();
      await configure(client);
      const result = await client.query(placeholders(query), [...values]);
      return {
        success: true,
        results: result.rows.map((row) => normalizeRow(row)) as T[],
        meta: {
          changes: result.rowCount ?? 0,
          rowCount: result.rowCount ?? 0,
          durationMs: Date.now() - started,
          command: result.command,
        },
      };
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async batch<T = unknown>(statements: DatabasePreparedStatement[]): Promise<DatabaseResult<T>[]> {
    const client = new Client({ connectionString: this.connectionString });
    const results: DatabaseResult<T>[] = [];
    try {
      await client.connect();
      await configure(client);
      await client.query('BEGIN');
      for (const item of statements) {
        if (!(item instanceof PostgresPreparedStatement) || item.database !== this) {
          throw new Error('Database batch contains a statement from a different adapter.');
        }
        const started = Date.now();
        const result = await client.query(placeholders(item.query), [...item.boundValues()]);
        results.push({
          success: true,
          results: result.rows.map((row) => normalizeRow(row)) as T[],
          meta: {
            changes: result.rowCount ?? 0,
            rowCount: result.rowCount ?? 0,
            durationMs: Date.now() - started,
            command: result.command,
          },
        });
      }
      await client.query('COMMIT');
      return results;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async exec(query: string): Promise<DatabaseResult> {
    return this.execute(query);
  }
}

export const postgresSql = { placeholders };
