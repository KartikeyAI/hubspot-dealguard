import { PostgresDatabase } from './postgres.js';
import type { Env, WorkerBindings } from './types.js';

export function createRuntimeEnv(bindings: WorkerBindings): Env {
  const connectionString = bindings.NEON_DATABASE_URL || bindings.HYPERDRIVE?.connectionString;
  if (!connectionString) {
    throw new Error('Either NEON_DATABASE_URL or HYPERDRIVE binding is required.');
  }
  return {
    ...bindings,
    DB: new PostgresDatabase(connectionString),
  };
}
