import { requireUser } from '@/lib/auth';
import { pool } from '@/db';

export const dynamic = 'force-dynamic';

interface StatusCount {
  status: string;
  c: number;
}

interface RecentVisit {
  id: string;
  visit_code: string;
  status: string;
  created_at: string;
  plate_display: string;
  company: string;
}

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

const STATUS_COLOR: Record<string, string> = {
  REGISTERED: 'border-ff-cyan/40 bg-ff-cyan/10 text-ff-cyan',
  WAITING_FOR_SECURITY: 'border-ff-petrol/40 bg-ff-petrol/10 text-ff-petrol',
  AT_SECURITY: 'border-ff-petrol/40 bg-ff-petrol/10 text-ff-petrol',
  WAITING_FOR_LAB: 'border-ff-petrol/40 bg-ff-petrol/10 text-ff-petrol',
  AT_LAB: 'border-ff-petrol/40 bg-ff-petrol/10 text-ff-petrol',
  COMPLETED: 'border-ff-success/40 bg-ff-success/10 text-ff-success',
  ON_HOLD: 'border-ff-warning/40 bg-ff-warning/10 text-ff-warning',
  REJECTED: 'border-ff-danger/40 bg-ff-danger/10 text-ff-danger',
  CANCELLED: 'border-ff-danger/40 bg-ff-danger/10 text-ff-danger'
};

export default async function DashboardPage() {
  await requireUser();

  const statusResult = await pool.query(
    'select status::text as status, count(*)::int as c from vehicle_visits group by status'
  );
  const recentResult = await pool.query(
    `select v.id::text as id, v.visit_code, v.status::text as status, v.created_at,
            ve.plate_display, co.name as company
       from vehicle_visits v
       join vehicles ve on ve.id = v.vehicle_id
       join companies co on co.id = v.company_id
      order by v.created_at desc
      limit 10`
  );

  const counts = new Map(
    (statusResult.rows as StatusCount[]).map((row) => [row.status, row.c])
  );
  const recent = recentResult.rows as RecentVisit[];

  const count = (status: string): number => counts.get(status) ?? 0;
  const inWorkflow =
    count('REGISTERED') +
    count('WAITING_FOR_SECURITY') +
    count('AT_SECURITY') +
    count('WAITING_FOR_LAB') +
    count('AT_LAB') +
    count('ON_HOLD');

  const kpis = [
    { label: 'In workflow now', value: inWorkflow, accent: 'text-ff-cyan' },
    { label: 'Awaiting Security', value: count('WAITING_FOR_SECURITY'), accent: 'text-ff-petrol' },
    { label: 'At Security', value: count('AT_SECURITY'), accent: 'text-ff-petrol' },
    { label: 'Awaiting Laboratory', value: count('WAITING_FOR_LAB'), accent: 'text-ff-petrol' },
    { label: 'At Laboratory', value: count('AT_LAB'), accent: 'text-ff-petrol' },
    { label: 'Completed', value: count('COMPLETED'), accent: 'text-ff-success' },
    { label: 'On Hold', value: count('ON_HOLD'), accent: 'text-ff-warning' },
    { label: 'Rejected / Cancelled', value: count('REJECTED') + count('CANCELLED'), accent: 'text-ff-danger' }
  ];

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-xl font-bold tracking-tight text-white">Operations Dashboard</h1>
        <p className="mt-1 text-sm text-slate-400">
          Live counts from the database. Overdue detection and real-time updates arrive in the next checkpoint.
        </p>
      </header>

      <section aria-label="Key metrics" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {kpis.map((kpi) => (
          <div key={kpi.label} className="rounded-2xl border border-ff-border bg-ff-surface/60 p-4 shadow-card">
            <p className={`text-2xl font-bold ${kpi.accent}`}>{kpi.value}</p>
            <p className="mt-1 text-xs font-medium text-slate-400">{kpi.label}</p>
          </div>
        ))}
      </section>

      <section className="rounded-2xl border border-ff-border bg-ff-surface/60 p-5 shadow-card">
        <h2 className="text-sm font-semibold text-white">Recent vehicle visits</h2>
        {recent.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">
            No vehicle visits registered yet — visit registration arrives in the next checkpoint.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-ff-border text-xs uppercase tracking-wider text-slate-500">
                  <th className="px-3 py-2">Visit</th>
                  <th className="px-3 py-2">Plate</th>
                  <th className="px-3 py-2">Company</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Registered</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((visit) => (
                  <tr key={visit.id} className="border-b border-ff-border/50">
                    <td className="px-3 py-2 font-mono text-xs text-slate-300">{visit.visit_code}</td>
                    <td className="px-3 py-2 font-medium text-white">{visit.plate_display}</td>
                    <td className="px-3 py-2 text-slate-400">{visit.company}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[visit.status] ?? ''}`}>
                        {STATUS_LABEL[visit.status] ?? visit.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-slate-400">
                      {new Date(visit.created_at).toLocaleString()}
                    </td>
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
