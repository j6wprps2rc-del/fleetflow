import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth';
import { canManageUsers, isAppRole, ROLE_LABEL, type AppRole } from '@/lib/rbac';
import { pool } from '@/db';
import { setUserActive, updateUserRole } from './actions';

export const dynamic = 'force-dynamic';

interface UserRow {
  id: string;
  full_name: string;
  email: string;
  role: AppRole;
  is_active: boolean;
  created_at: string;
}

export default async function UsersPage() {
  const { profile } = await requireUser();
  if (!canManageUsers(profile.role)) {
    redirect('/dashboard');
  }

  const result = await pool.query(
    `select id::text as id, full_name, coalesce(email, '') as email,
            role::text as role, is_active, created_at
       from profiles
      order by created_at desc`
  );
  const users = result.rows as UserRow[];

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-xl font-bold tracking-tight text-white">User Management</h1>
        <p className="mt-1 text-sm text-slate-400">
          Assign roles and activation. Accounts are created in the Supabase dashboard
          (Authentication → Users → Add user); a profile is created automatically on
          first sign-in setup with the least-privileged default role.
        </p>
      </header>

      <section className="rounded-2xl border border-ff-border bg-ff-surface/60 p-5 shadow-card">
        {users.length === 0 ? (
          <p className="text-sm text-slate-500">No user profiles found.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-ff-border text-xs uppercase tracking-wider text-slate-500">
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Email</th>
                  <th className="px-3 py-2">Role</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => {
                  const isSelf = user.id === profile.id;
                  return (
                    <tr key={user.id} className="border-b border-ff-border/50 align-middle">
                      <td className="px-3 py-3 font-medium text-white">
                        {user.full_name}
                        {isSelf ? <span className="ml-2 text-xs text-ff-cyan">(you)</span> : null}
                      </td>
                      <td className="px-3 py-3 text-slate-400">{user.email || '—'}</td>
                      <td className="px-3 py-3">
                        <form action={updateUserRole} className="flex items-center gap-2">
                          <input type="hidden" name="id" value={user.id} />
                          <select
                            name="role"
                            defaultValue={user.role}
                            disabled={isSelf}
                            className="rounded-lg border border-ff-border bg-ff-bg px-2 py-1.5 text-xs text-white disabled:opacity-50"
                          >
                            {(Object.keys(ROLE_LABEL) as AppRole[]).map((role) => (
                              <option key={role} value={role}>
                                {ROLE_LABEL[role]}
                              </option>
                            ))}
                          </select>
                          <button
                            type="submit"
                            disabled={isSelf}
                            className="rounded-lg bg-ff-petrol px-2.5 py-1.5 text-xs font-medium text-white transition hover:bg-ff-petrol/80 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Save
                          </button>
                        </form>
                      </td>
                      <td className="px-3 py-3">
                        <span
                          className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
                            user.is_active
                              ? 'border-ff-success/40 bg-ff-success/10 text-ff-success'
                              : 'border-ff-danger/40 bg-ff-danger/10 text-ff-danger'
                          }`}
                        >
                          {user.is_active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        <form action={setUserActive}>
                          <input type="hidden" name="id" value={user.id} />
                          <input type="hidden" name="active" value={user.is_active ? 'false' : 'true'} />
                          <button
                            type="submit"
                            disabled={isSelf}
                            className="rounded-lg border border-ff-border px-2.5 py-1.5 text-xs font-medium text-slate-300 transition hover:border-ff-warning/50 hover:text-ff-warning disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {user.is_active ? 'Deactivate' : 'Activate'}
                          </button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
