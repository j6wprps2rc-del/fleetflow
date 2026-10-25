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

/** Transactional helper for multi-statement atomic operations (e.g. workflow transitions). */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
