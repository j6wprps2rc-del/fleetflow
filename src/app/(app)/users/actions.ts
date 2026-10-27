'use server';

import { revalidatePath } from 'next/cache';
import { withTransaction } from '@/db';
import { audit } from '@/lib/audit';
import { assertRole, PermissionError } from '@/lib/auth';
import { isAppRole } from '@/lib/rbac';

/**
 * Admin user-management actions.
 *
 * Atomicity (defect fix): the authorization check, the profile update, and the
 * audit entry all run inside ONE withTransaction. Previously these were two
 * separate pool calls — a crash between them left an unaudited change, and a
 * no-op update on a nonexistent profile id still wrote a success audit row.
 * Now:
 *   - assertRole runs on the transaction client (pool-starvation discipline).
 *   - rowCount === 0 (unknown target profile) throws BEFORE the audit write,
 *     so no audit row can exist for a change that did not happen.
 *   - audit() runs on the same client: if its insert fails, the error
 *     propagates (mandatory-audit behavior) and the whole update rolls back.
 */
export async function updateUserRole(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '');
  const role = String(formData.get('role') ?? '');

  if (!id) throw new Error('Missing user id.');
  if (!isAppRole(role)) throw new Error('Invalid role.');

  await withTransaction(async (client) => {
    const { profile } = await assertRole(['SUPER_ADMIN'], client);

    if (id === profile.id) {
      throw new Error('You cannot change your own role. Ask another super admin.');
    }

    const updated = await client.query(
      'update profiles set role = $1::app_role where id = $2 returning id::text as id',
      [role, id]
    );
    if (updated.rowCount === 0) {
      throw new PermissionError('User not found.');
    }

    await audit(profile.id, 'UPDATE_USER_ROLE', 'profiles', id, { newRole: role }, client);
  });

  revalidatePath('/users');
}

export async function setUserActive(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '');
  const active = String(formData.get('active') ?? '') === 'true';

  if (!id) throw new Error('Missing user id.');

  await withTransaction(async (client) => {
    const { profile } = await assertRole(['SUPER_ADMIN'], client);

    if (id === profile.id) {
      throw new Error('You cannot deactivate your own account. Ask another super admin.');
    }

    const updated = await client.query(
      'update profiles set is_active = $1 where id = $2 returning id::text as id',
      [active, id]
    );
    if (updated.rowCount === 0) {
      throw new PermissionError('User not found.');
    }

    await audit(
      profile.id,
      active ? 'ACTIVATE_USER' : 'DEACTIVATE_USER',
      'profiles',
      id,
      {},
      client
    );
  });

  revalidatePath('/users');
}
