import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema';

export type Database = ReturnType<typeof createDatabase>;

/**
 * One driver for both the web app and the worker. The pool size is the meaningful difference:
 * serverless wants a small pool per instance, the worker wants a stable one.
 */
export function createDatabase(connectionString: string, options: { max?: number } = {}) {
  const sql = postgres(connectionString, {
    max: options.max ?? 10,
    // Neon terminates idle connections; letting postgres.js prepare statements across a
    // pooled connection breaks when the backend changes underneath it.
    prepare: false,
  });
  return drizzle(sql, { schema });
}

let cached: Database | undefined;

/** Process-wide database handle, built from `DATABASE_URL`. */
export function db(): Database {
  if (!cached) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    cached = createDatabase(url, { max: Number(process.env.DATABASE_POOL_MAX ?? 10) });
  }
  return cached;
}
