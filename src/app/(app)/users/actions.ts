'use server';

import { revalidatePath } from 'next/cache';
import { pool } from '@/db';
import { audit } from '@/lib/audit';
import { assertRole, PermissionError } from '@/lib/auth';
import { isAppRole } from '@/lib/rbac';

export async function updateUserRole(formData: FormData): Promise<void> {
  const { profile } = await assertRole(['SUPER_ADMIN']);

  const id = String(formData.get('id') ?? '');
  const role = String(formData.get('role') ?? '');

  if (!id) throw new Error('Missing user id.');
  if (!isAppRole(role)) throw new Error('Invalid role.');
  if (id === profile.id) {
    throw new Error('You cannot change your own role. Ask another super admin.');
  }

  await pool.query('update profiles set role = $1 where id = $2', [role, id]);
  await audit(profile.id, 'UPDATE_USER_ROLE', 'profiles', id, { newRole: role });
  revalidatePath('/users');
}

export async function setUserActive(formData: FormData): Promise<void> {
  const { profile } = await assertRole(['SUPER_ADMIN']);

  const id = String(formData.get('id') ?? '');
  const active = String(formData.get('active') ?? '') === 'true';

  if (!id) throw new Error('Missing user id.');
  if (id === profile.id) {
    throw new Error('You cannot deactivate your own account. Ask another super admin.');
  }

  await pool.query('update profiles set is_active = $1 where id = $2', [active, id]);
  await audit(profile.id, active ? 'ACTIVATE_USER' : 'DEACTIVATE_USER', 'profiles', id, {});
  revalidatePath('/users');
}
