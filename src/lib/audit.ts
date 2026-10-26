/**
 * Append-only audit logging. Never throws into the caller's business flow —
 * failures are logged server-side instead, so a logging hiccup cannot roll
 * back a legitimate workflow action silently.
 *
 * Connection policy (pool-starvation fix):
 * - `client` omitted → global pool (standalone audit entries).
 * - `client` supplied  → the caller's transaction connection, so the audit row
 *   commits or rolls back WITH the business operation. On Vercel (pool max 1)
 *   this is mandatory: going through the pool from inside a transaction would
 *   wait forever for a second connection.
 */
import 'server-only';
import { pool, type QueryExecutor } from '@/db';

export async function audit(
  actor: string | null,
  action: string,
  targetTable: string,
  targetId: string | null,
  details: Record<string, unknown> = {},
  client?: QueryExecutor
): Promise<void> {
  const executor: QueryExecutor = client ?? pool;
  try {
    await executor.query(
      `insert into audit_logs (actor, action, target_table, target_id, details)
       values ($1, $2, $3, $4, $5::jsonb)`,
      [actor, action, targetTable, targetId, JSON.stringify(details)]
    );
  } catch (err) {
    console.error(
      '[audit] failed to write audit log:',
      err instanceof Error ? err.message : err
    );

    if (client) {
      throw err;
    }
  }
}