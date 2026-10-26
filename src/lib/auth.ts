/**
 * Server-side authentication & authorization helpers.
 * - Session is verified against Supabase Auth on EVERY request (never trusted
 *   from the client).
 * - Role/active checks are loaded server-side from the `profiles` table.
 * - requireUser(): for pages (redirects unauthenticated users to /login).
 * - assertRole(): for server actions (throws PermissionError — never relies on
 *   hidden UI buttons).
 *
 * Connection policy (pool-starvation fix): getProfile/assertRole accept an
 * optional QueryExecutor (the caller's transaction client). Inside
 * withTransaction on Vercel (pool max 1) the authorization query MUST run on
 * the already-checked-out transaction connection; going through the global
 * pool would block forever waiting for a second connection. Authorization is
 * still performed against the POST-LOCK state (not moved before the txn).
 */
import 'server-only';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { pool, type QueryExecutor } from '@/db';
import { isAppRole, type AppRole, type ProfileRow } from '@/lib/rbac';

export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionError';
  }
}

export async function getCurrentUser() {
  const supabase = createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  return user ?? null;
}

export async function getProfile(
  userId: string,
  client?: QueryExecutor
): Promise<ProfileRow | null> {
  const executor: QueryExecutor = client ?? pool;
  const result = await executor.query(
    `select id::text as id, full_name, coalesce(email, '') as email,
            role::text as role, is_active
       from profiles
      where id = $1`,
    [userId]
  );
  const row = result.rows[0] as
    | { id: string; full_name: string; email: string; role: string; is_active: boolean }
    | undefined;
  if (!row || !isAppRole(row.role)) return null;
  return { ...row, role: row.role } as ProfileRow;
}

/** Page-level guard: redirects unauthenticated/inactive users to /login. */
export async function requireUser(): Promise<{
  user: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;
  profile: ProfileRow;
}> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const profile = await getProfile(user.id);
  if (!profile || !profile.is_active) {
    redirect('/login?error=inactive');
  }
  return { user, profile };
}

/** Action-level guard: throws — for server actions / API route handlers. */
export async function assertRole(
  roles: readonly AppRole[],
  client?: QueryExecutor
): Promise<{
  user: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;
  profile: ProfileRow;
}> {
  const user = await getCurrentUser();
  if (!user) throw new PermissionError('Not authenticated.');
  const profile = await getProfile(user.id, client);
  if (!profile || !profile.is_active) throw new PermissionError('Account is inactive.');
  if (!roles.includes(profile.role)) {
    throw new PermissionError(`Forbidden for role ${profile.role}.`);
  }
  return { user, profile };
}
