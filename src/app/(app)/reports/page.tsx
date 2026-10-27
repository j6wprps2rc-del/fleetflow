import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth';
import { canViewReports } from '@/lib/rbac';
import { pool } from '@/db';

export const dynamic = 'force-dynamic';

/**
 * Reports & analytics — manual-workflow-only. All figures derive from the
 * manually recorded data (vehicle_visits + gate_movements written exclusively
 * by the authorized employee workflow). No device or simulated data exists.
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

  const STATUS_LABEL: Record<string, string> = {
    REGISTERED: 'Registered',
    WAITING_FOR_SECURITY: 'Awaiting Security',
    AT_SECURITY: 'At Security',
    WAITING_FOR_LAB: 'Awaiting Laboratory',
    AT_LAB: 'At Laboratory',
    COMPLETED: 'Completed',
    ON_HOLD: 'On Hold',
    REJECTED: 'Rejected',
    CANCELLED: 'Cancelled'
  };

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
        <h1 className="text-xl font-bold tracking-tight text-white">Reports &amp; Analytics</h1>
        <p className="mt-1 text-sm text-slate-400">
          Operational performance over the manually recorded workflow. Read-only.
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-2xl border border-ff-border bg-ff-surface/60 p-5 shadow-card">
          <p className="text-xs uppercase tracking-wider text-slate-500">Visits today</p>
          <p className="mt-2 text-3xl font-bold text-white">{todayCount}</p>
        </div>
        <div className="rounded-2xl border border-ff-border bg-ff-surface/60 p-5 shadow-card">
          <p className="text-xs uppercase tracking-wider text-slate-500">Active visits</p>
          <p className="mt-2 text-3xl font-bold text-white">{activeCount}</p>
        </div>
        <div className="rounded-2xl border border-ff-border bg-ff-surface/60 p-5 shadow-card">
          <p className="text-xs uppercase tracking-wider text-slate-500">Completed</p>
          <p className="mt-2 text-3xl font-bold text-ff-success">
            {statusCounts.find((s) => s.status === 'COMPLETED')?.c ?? 0}
          </p>
        </div>
        <div className="rounded-2xl border border-ff-border bg-ff-surface/60 p-5 shadow-card">
          <p className="text-xs uppercase tracking-wider text-slate-500">Avg movements per zone (7d)</p>
          <p className="mt-2 text-3xl font-bold text-white">{avgMovementsPerZone}</p>
          <p className="mt-1 text-[10px] text-slate-500">Manually confirmed movements.</p>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-ff-border bg-ff-surface/60 p-5 shadow-card">
          <h2 className="text-sm font-semibold text-white">Visit status distribution</h2>
          {statusCounts.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">No visits recorded yet.</p>
          ) : (
            <ul className="mt-4 flex flex-col gap-2">
              {statusCounts.map((s) => (
                <li key={s.status} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-slate-300">{STATUS_LABEL[s.status] ?? s.status}</span>
                  <span className="font-mono text-slate-400">{s.c}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-2xl border border-ff-border bg-ff-surface/60 p-5 shadow-card">
          <h2 className="text-sm font-semibold text-white">Zone activity — last 7 days</h2>
          {zoneActivity.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">No movements recorded in the last 7 days.</p>
          ) : (
            <ul className="mt-4 flex flex-col gap-2">
              {zoneActivity.map((z) => (
                <li key={z.zone} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-slate-300">{z.zone.charAt(0) + z.zone.slice(1).toLowerCase()}</span>
                  <span className="font-mono text-slate-400">{z.movements} movements</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="rounded-2xl border border-ff-border bg-ff-surface/60 p-5 shadow-card">
        <h2 className="text-sm font-semibold text-white">Visits needing attention (active &gt; 4h)</h2>
        {slow.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">
            No active visits older than 4 hours. Operational flow is healthy.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[480px] text-left text-sm">
              <thead>
                <tr className="border-b border-ff-border text-xs uppercase tracking-wider text-slate-500">
                  <th className="px-3 py-2">Visit</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Registered</th>
                </tr>
              </thead>
              <tbody>
                {slow.map((v) => (
                  <tr key={v.visit_code} className="border-b border-ff-border/50">
                    <td className="px-3 py-2 font-mono text-xs text-slate-300">{v.visit_code}</td>
                    <td className="px-3 py-2 text-slate-300">{STATUS_LABEL[v.status] ?? v.status}</td>
                    <td className="px-3 py-2 text-slate-400">{new Date(v.created_at).toLocaleString()}</td>
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
