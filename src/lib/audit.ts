/**
 * Append-only audit logging. Never throws into the caller's business flow —
 * failures are logged server-side instead, so a logging hiccup cannot roll
 * back a legitimate workflow action silently.
 */
import 'server-only';
import { pool } from '@/db';

export async function audit(
  actor: string | null,
  action: string,
  targetTable: string,
  targetId: string | null,
  details: Record<string, unknown> = {}
): Promise<void> {
  try {
    await pool.query(
      `insert into audit_logs (actor, action, target_table, target_id, details)
       values ($1, $2, $3, $4, $5::jsonb)`,
      [actor, action, targetTable, targetId, JSON.stringify(details)]
    );
  } catch (err) {
    console.error('[audit] failed to write audit log:', err instanceof Error ? err.message : err);
  }
}
