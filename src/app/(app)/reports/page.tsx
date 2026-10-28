import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth';
import { canViewReports } from '@/lib/rbac';
import { pool } from '@/db';
import { AR } from '@/lib/i18n';

export const dynamic = 'force-dynamic';

/**
 * التقارير والتحليلات — بيانات التسجيل اليدوي فقط. كل الأرقام مشتقة من
 * البيانات المسجلة يدويًا (vehicle_visits + gate_movements التي يكتبها
 * سير العمل المخوّل حصريًا). لا توجد بيانات أجهزة أو محاكاة.
 */
export default async function ReportsPage() {
  const { profile } = await requireUser();
  if (!canViewReports(profile.role)) {
    redirect('/dashboard');
  }

  const [visitsToday, statusDist, zoneDwell, slowVisits] = await Promise.all([
    pool.query(
      `select count(*)::int as c
         from vehicle_visits
        where created_at >= date_trunc('day', now())`
    ),
    pool.query(
      `select status::text as status, count(*)::int as c
         from vehicle_visits
        group by status
        order by c desc`
    ),
    pool.query(
      `select z.code::text as zone, count(*)::int as movements
         from gate_movements m
         join zones z on z.id = m.zone_id
        where m.occurred_at >= now() - interval '7 days'
        group by z.code
        order by movements desc`
    ),
    pool.query(
      `select visit_code, status::text as status, created_at
         from vehicle_visits
        where status not in ('COMPLETED', 'REJECTED', 'CANCELLED')
          and created_at < now() - interval '4 hours'
        order by created_at asc
        limit 10`
    )
  ]);

  const todayCount = (visitsToday.rows[0] as { c: number }).c;
  const statusCounts = statusDist.rows as { status: string; c: number }[];
  const zoneActivity = zoneDwell.rows as { zone: string; movements: number }[];
  const slow = slowVisits.rows as {
    visit_code: string;
    status: string;
    created_at: string;
  }[];

  const activeCount = statusCounts
    .filter((s) => !['COMPLETED', 'REJECTED', 'CANCELLED'].includes(s.status))
    .reduce((sum, s) => sum + s.c, 0);

  const avgMovementsPerZone =
    zoneActivity.length > 0
      ? Math.round(zoneActivity.reduce((a, z) => a + z.movements, 0) / zoneActivity.length)
      : 0;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-xl font-bold tracking-tight text-white">التقارير والتحليلات</h1>
        <p className="mt-1 text-sm text-slate-400">
          أداء التشغيل بناءً على البيانات المسجّلة يدويًا. للقراءة فقط.
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-2xl border border-ff-border bg-ff-surface/60 p-5 shadow-card">
          <p className="text-xs uppercase tracking-wider text-slate-500">زيارات النهاردة</p>
          <p className="mt-2 text-3xl font-bold text-white">{todayCount}</p>
        </div>
        <div className="rounded-2xl border border-ff-border bg-ff-surface/60 p-5 shadow-card">
          <p className="text-xs uppercase tracking-wider text-slate-500">زيارات شغّالة</p>
          <p className="mt-2 text-3xl font-bold text-white">{activeCount}</p>
        </div>
        <div className="rounded-2xl border border-ff-border bg-ff-surface/60 p-5 shadow-card">
          <p className="text-xs uppercase tracking-wider text-slate-500">مكتملة</p>
          <p className="mt-2 text-3xl font-bold text-ff-success">
            {statusCounts.find((s) => s.status === 'COMPLETED')?.c ?? 0}
          </p>
        </div>
        <div className="rounded-2xl border border-ff-border bg-ff-surface/60 p-5 shadow-card">
          <p className="text-xs uppercase tracking-wider text-slate-500">متوسط الحركات لكل منطقة (٧ يوم)</p>
          <p className="mt-2 text-3xl font-bold text-white">{avgMovementsPerZone}</p>
          <p className="mt-1 text-[10px] text-slate-500">حركات مؤكدة يدويًا.</p>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-ff-border bg-ff-surface/60 p-5 shadow-card">
          <h2 className="text-sm font-semibold text-white">توزيع حالات الزيارات</h2>
          {statusCounts.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">لسه مفيش زيارات مسجّلة.</p>
          ) : (
            <ul className="mt-4 flex flex-col gap-2">
              {statusCounts.map((s) => (
                <li key={s.status} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-slate-300">{AR.statusLabels[s.status] ?? s.status}</span>
                  <span className="font-mono text-slate-400">{s.c}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-2xl border border-ff-border bg-ff-surface/60 p-5 shadow-card">
          <h2 className="text-sm font-semibold text-white">نشاط المناطق — آخر ٧ أيام</h2>
          {zoneActivity.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">مفيش حركات في آخر ٧ أيام.</p>
          ) : (
            <ul className="mt-4 flex flex-col gap-2">
              {zoneActivity.map((z) => (
                <li key={z.zone} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-slate-300">{AR.zoneLabels[z.zone] ?? z.zone}</span>
                  <span className="font-mono text-slate-400">{z.movements} حركة</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="rounded-2xl border border-ff-border bg-ff-surface/60 p-5 shadow-card">
        <h2 className="text-sm font-semibold text-white">زيارات محتاجة متابعة (شغّالة أكتر من ٤ ساعات)</h2>
        {slow.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">
            مفيش زيارات شغّالة أكتر من ٤ ساعات — التشغيل سليم.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[480px] text-right text-sm">
              <thead>
                <tr className="border-b border-ff-border text-xs uppercase tracking-wider text-slate-500">
                  <th className="px-3 py-2">الزيارة</th>
                  <th className="px-3 py-2">الحالة</th>
                  <th className="px-3 py-2">التسجيل</th>
                </tr>
              </thead>
              <tbody>
                {slow.map((v) => (
                  <tr key={v.visit_code} className="border-b border-ff-border/50">
                    <td className="px-3 py-2 font-mono text-xs text-slate-300" dir="ltr">{v.visit_code}</td>
                    <td className="px-3 py-2 text-slate-300">{AR.statusLabels[v.status] ?? v.status}</td>
                    <td className="px-3 py-2 text-slate-400">{new Date(v.created_at).toLocaleString('ar-EG')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
