import { PostgresDatabase } from './postgres.js';
import type { Env, WorkerBindings } from './types.js';

export function createRuntimeEnv(bindings: WorkerBindings): Env {
  const connectionString = bindings.NEON_DATABASE_URL;
  if (!connectionString) {
    throw new Error('NEON_DATABASE_URL is required.');
  }
  return {
    ...bindings,
    DB: new PostgresDatabase(connectionString),
  };
}
