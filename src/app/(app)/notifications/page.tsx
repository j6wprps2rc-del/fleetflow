import { requireUser } from '@/lib/auth';
import { pool } from '@/db';
import { AR } from '@/lib/i18n';
import { AcknowledgeButton } from './acknowledge-button';

export const dynamic = 'force-dynamic';

interface NotificationRow {
  id: string;
  title: string;
  body: string;
  severity: string;
  visit_id: string | null;
  created_at: string;
  acknowledged_at: string | null;
}

const SEVERITY_COLOR: Record<string, string> = {
  info: 'border-ff-cyan/40 bg-ff-cyan/10 text-ff-cyan',
  warning: 'border-ff-warning/40 bg-ff-warning/10 text-ff-warning',
  critical: 'border-ff-danger/40 bg-ff-danger/10 text-ff-danger'
};

const SEVERITY_AR: Record<string, string> = {
  info: 'معلومة',
  warning: 'تنبيه',
  critical: 'حرج'
};

export default async function NotificationsPage() {
  const { profile } = await requireUser();

  const result = await pool.query(
    `select n.id::text as id, n.title, n.body, n.severity,
            n.visit_id::text as visit_id, n.created_at, n.acknowledged_at
       from notifications n
      where n.target_role = $1::app_role
      order by n.acknowledged_at nulls first, n.created_at desc
      limit 50`,
    [profile.role]
  );
  const notifications = result.rows as NotificationRow[];
  const unread = notifications.filter((n) => !n.acknowledged_at);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-xl font-bold tracking-tight text-white">{AR.notifications}</h1>
        <p className="mt-1 text-sm text-slate-400">
          تنبيهات لدورك ({unread.length} جديد). بتشوف بس الإشعارات المخصصة لدورك.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        {notifications.length === 0 ? (
          <p className="rounded-2xl border border-ff-border bg-ff-surface/60 p-8 text-center text-sm text-slate-500">
            لسه مفيش إشعارات — بتظهر كل ما زيارة تتحرك في مراحل العمل.
          </p>
        ) : (
          notifications.map((n) => (
            <article
              key={n.id}
              className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-4 shadow-card ${
                n.acknowledged_at
                  ? 'border-ff-border bg-ff-surface/30 opacity-70'
                  : 'border-ff-border bg-ff-surface/60'
              }`}
            >
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm font-semibold text-white">
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wider ${SEVERITY_COLOR[n.severity] ?? ''}`}>
                    {SEVERITY_AR[n.severity] ?? n.severity}
                  </span>
                  {n.title}
                </p>
                <p className="mt-1 text-sm text-slate-400">{n.body}</p>
                <p className="mt-1 text-xs text-slate-500">
                  {new Date(n.created_at).toLocaleString('ar-EG')}
                </p>
              </div>
              <div className="flex items-center gap-3">
                {n.visit_id ? (
                  <a href={`/visits/${n.visit_id}`} className="text-xs font-medium text-ff-cyan hover:underline">
                    افتح الزيارة ←
                  </a>
                ) : null}
                {!n.acknowledged_at ? (
                  <AcknowledgeButton id={n.id} />
                ) : (
                  <span className="text-xs text-slate-500">تم الاطّلاع ✓</span>
                )}
              </div>
            </article>
          ))
        )}
      </section>
    </div>
  );
}
