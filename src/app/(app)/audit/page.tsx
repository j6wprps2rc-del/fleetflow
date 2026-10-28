import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth';
import { canViewAudit } from '@/lib/rbac';
import { pool } from '@/db';
import { AR } from '@/lib/i18n';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 30;

interface AuditRow {
  id: string;
  action: string;
  target_table: string;
  target_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
  actor_name: string | null;
  actor_email: string | null;
}

/** Super-admin-only audit trail viewer (reads the append-only audit_logs). */
export default async function AuditPage({
  searchParams
}: {
  searchParams: { [key: string]: string | string[] | undefined };
}) {
  const { profile } = await requireUser();
  if (!canViewAudit(profile.role)) {
    redirect('/dashboard');
  }

  const page = Math.max(1, Number(searchParams.page ?? 1) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const countResult = await pool.query('select count(*)::int as c from audit_logs');
  const total = (countResult.rows[0] as { c: number }).c;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const result = await pool.query(
    `select a.id::text as id, a.action, a.target_table, a.target_id,
            a.details, a.created_at,
            pr.full_name as actor_name, pr.email as actor_email
       from audit_logs a
       left join profiles pr on pr.id = a.actor
      order by a.created_at desc, a.id desc
      limit $1 offset $2`,
    [PAGE_SIZE, offset]
  );
  const entries = result.rows as AuditRow[];

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-xl font-bold tracking-tight text-white">{AR.audit}</h1>
        <p className="mt-1 text-sm text-slate-400">
          سجل دائم لكل فعل مميّز — لا يمكن تعديله أو حذفه. معروض {entries.length} من {total} سجل.
        </p>
      </header>

      <section className="rounded-2xl border border-ff-border bg-ff-surface/60 p-5 shadow-card">
        {entries.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-500">
            لسه مفيش سجلات — بتظهر مع تسجيل الزيارات وتنفيذ الانتقالات.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-right text-sm">
              <thead>
                <tr className="border-b border-ff-border text-xs uppercase tracking-wider text-slate-500">
                  <th className="px-3 py-2">الوقت</th>
                  <th className="px-3 py-2">الفاعل</th>
                  <th className="px-3 py-2">الفعل</th>
                  <th className="px-3 py-2">الهدف</th>
                  <th className="px-3 py-2">التفاصيل</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} className="border-b border-ff-border/50 align-top">
                    <td className="whitespace-nowrap px-3 py-2 text-slate-400">
                      {new Date(e.created_at).toLocaleString('ar-EG')}
                    </td>
                    <td className="px-3 py-2 text-white">
                      {e.actor_name ?? 'النظام'}
                      {e.actor_email ? (
                        <span className="ml-1 text-xs text-slate-500" dir="ltr">({e.actor_email})</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      <span className="rounded border border-ff-border px-1.5 py-0.5 font-mono text-xs text-ff-cyan" dir="ltr">
                        {e.action}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-slate-400">
                      <span dir="ltr" className="inline-block">{e.target_table}</span>
                      {e.target_id ? (
                        <span className="ml-1 font-mono text-xs text-slate-500" dir="ltr">
                          #{e.target_id.slice(0, 8)}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-400" dir="ltr">
                      {Object.keys(e.details ?? {}).length > 0
                        ? JSON.stringify(e.details).slice(0, 120)
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {pages > 1 ? (
          <nav className="mt-4 flex items-center justify-between text-xs text-slate-400" aria-label="تنقل بين الصفحات">
            <span>صفحة {page} من {pages}</span>
            <span className="flex gap-2">
              {page > 1 ? (
                <a href={`/audit?page=${page - 1}`} className="rounded border border-ff-border px-2 py-1 hover:text-white">
                  ← السابقة
                </a>
              ) : null}
              {page < pages ? (
                <a href={`/audit?page=${page + 1}`} className="rounded border border-ff-border px-2 py-1 hover:text-white">
                  التالية →
                </a>
              ) : null}
            </span>
          </nav>
        ) : null}
      </section>
    </div>
  );
}
