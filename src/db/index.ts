import 'server-only';
import { Pool, type PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    'DATABASE_URL is not set. Copy .env.example to .env and fill the placeholders. ' +
      'Never commit real credentials.'
  );
}

const isLocal = /localhost|127\.0\.0\.1/.test(url);

/**
 * Server-side connection pool.
 * - Runtime uses the Supabase Transaction Pooler (port 6543): short-lived,
 *   serverless-friendly connections; pool kept tiny on Vercel.
 * - 'server-only' guarantees this module can never be bundled for the browser.
 */
export const pool = new Pool({
  connectionString: url,
  max: process.env.VERCEL ? 1 : Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: 20_000,
  connectionTimeoutMillis: 10_000,
  ssl: isLocal ? undefined : { rejectUnauthorized: false }
});

export const db = drizzle(pool);

/**
 * The query-capable surface shared by the global pool and a checked-out
 * transaction client. Lets auth/audit helpers run on the caller's connection
 * when they are invoked inside withTransaction — required on Vercel where
 * pool max is 1, and strictly better hygiene everywhere (atomic audit rows).
 */
export interface QueryExecutor {
  query: PoolClient['query'];
}

/**
 * Transactional helper for multi-statement atomic operations.
 *
 * Hardening:
 * - If the connection is broken, ROLLBACK itself fails; that secondary error
 *   is logged and swallowed so the ORIGINAL business error is what propagates
 *   (the transaction is dead either way — there is nothing to roll back).
 * - client.release() failures are logged, never thrown: a release failure must
 *   not replace or hide the transaction result/error the caller is waiting on.
 *   Connection-management problems are surfaced via this log line and by the
 *   pool on subsequent checkouts — not silently swallowed.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error(
        '[db] ROLLBACK failed (connection likely broken); original error preserved:',
        err instanceof Error ? err.message : err
      );
      void rollbackErr;
    }
    throw err;
  } finally {
    try {
      client.release();
    } catch (releaseErr) {
      console.error(
        '[db] client.release() failed:',
        releaseErr instanceof Error ? releaseErr.message : releaseErr
      );
    }
  }
}
