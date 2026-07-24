import { PostgresDatabase } from './postgres.js';
import type { Env, WorkerBindings } from './types.js';

export function createRuntimeEnv(bindings: WorkerBindings): Env {
  const hyperdriveConnection = bindings.HYPERDRIVE ? bindings.HYPERDRIVE.connectionString : undefined;
  const connectionString = hyperdriveConnection || bindings.NEON_DATABASE_URL;
  if (!connectionString) {
    throw new Error('Either HYPERDRIVE binding or NEON_DATABASE_URL is required.');
  }
  return {
    ...bindings,
    DB: new PostgresDatabase(connectionString),
  };
}
