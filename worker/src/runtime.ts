import { PostgresDatabase } from './postgres.js';
import type { Env, WorkerBindings } from './types.js';

export function createRuntimeEnv(bindings: WorkerBindings): Env {
  return {
    ...bindings,
    DB: new PostgresDatabase(bindings.HYPERDRIVE.connectionString),
  };
}
