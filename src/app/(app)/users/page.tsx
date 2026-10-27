import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth';
import { canManageUsers, isAppRole, type AppRole } from '@/lib/rbac';
import { pool } from '@/db';
import { AR } from '@/lib/i18n';
import { UserRowActions } from './user-row-actions';

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
  const roles = Object.keys(AR.roleLabels) as AppRole[];

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-xl font-bold tracking-tight text-white">إدارة المستخدمين</h1>
        <p className="mt-1 text-sm text-slate-400">
          توزيع الأدوار وتشغيل/إيقاف الحسابات. الحسابات بتها من لوحة تحكم Supabase
          (Authentication ← Users ← Add user)، والبروفايل بيتعمل تلقائي بأقل دور ممكن.
        </p>
      </header>

      <section className="rounded-2xl border border-ff-border bg-ff-surface/60 p-5 shadow-card">
        {users.length === 0 ? (
          <p className="text-sm text-slate-500">مفيش مستخدمين مسجّلين.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-right text-sm">
              <thead>
                <tr className="border-b border-ff-border text-xs uppercase tracking-wider text-slate-500">
                  <th className="px-3 py-2">الاسم</th>
                  <th className="px-3 py-2">الإيميل</th>
                  <th className="px-3 py-2">الدور</th>
                  <th className="px-3 py-2">الحالة</th>
                  <th className="px-3 py-2">الإجراءات</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => {
                  const isSelf = user.id === profile.id;
                  return (
                    <tr key={user.id} className="border-b border-ff-border/50 align-middle">
                      <td className="px-3 py-3 font-medium text-white">
                        {user.full_name}
                        {isSelf ? <span className="ml-2 text-xs text-ff-cyan">(أنت)</span> : null}
                      </td>
                      <td className="px-3 py-3 text-slate-400" dir="ltr">
                        {user.email || '—'}
                      </td>
                      <td className="px-3 py-3">
                        <UserRowActions
                          user={{
                            id: user.id,
                            fullName: user.full_name,
                            role: isAppRole(user.role) ? user.role : 'SUPERVISOR',
                            isActive: user.is_active,
                            isSelf
                          }}
                          roles={roles}
                        />
                      </td>
                      <td className="px-3 py-3">
                        <span
                          className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
                            user.is_active
                              ? 'border-ff-success/40 bg-ff-success/10 text-ff-success'
                              : 'border-ff-danger/40 bg-ff-danger/10 text-ff-danger'
                          }`}
                        >
                          {user.is_active ? 'شغّال' : 'موقوف'}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-xs text-slate-400">
                        {new Date(user.created_at).toLocaleDateString('ar-EG')}
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
