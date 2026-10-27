import Link from 'next/link';
import { requireUser } from '@/lib/auth';
import { pool } from '@/db';
import { isWorkflowStatus, TRANSITIONS, type WorkflowStatus } from '@/lib/workflow';
import { AR } from '@/lib/i18n';

export const dynamic = 'force-dynamic';

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

const PAGE_SIZE = 15;

interface VisitRow {
  id: string;
  visit_code: string;
  status: string;
  plate_display: string;
  company: string;
  created_at: string;
}

export default async function VisitsPage({
  searchParams
}: {
  searchParams: { [key: string]: string | string[] | undefined };
}) {
  await requireUser();

  const q = typeof searchParams.q === 'string' ? searchParams.q.trim() : '';
  const statusParam = typeof searchParams.status === 'string' ? searchParams.status : '';
  const status = isWorkflowStatus(statusParam) ? statusParam : '';
  const page = Math.max(1, Number(searchParams.page ?? 1) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (q) {
    params.push(`%${q.toUpperCase().replace(/[\s\-_.]/g, '')}%`);
    conditions.push(`ve.plate_normalized like $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`v.status = $${params.length}::workflow_status`);
  }
  const where = conditions.length ? `where ${conditions.join(' and ')}` : '';

  const countResult = await pool.query(
    `select count(*)::int as c
       from vehicle_visits v
       join vehicles ve on ve.id = v.vehicle_id
       join companies co on co.id = v.company_id
      ${where}`,
    params
  );
  const total = (countResult.rows[0] as { c: number }).c;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const result = await pool.query(
    `select v.id::text as id, v.visit_code, v.status::text as status,
            ve.plate_display, co.name as company, v.created_at
       from vehicle_visits v
       join vehicles ve on ve.id = v.vehicle_id
       join companies co on co.id = v.company_id
      ${where}
      order by v.created_at desc
      limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, PAGE_SIZE, offset]
  );
  const visits = result.rows as VisitRow[];

  const qs = (over: Record<string, string>): string => {
    const sp = new URLSearchParams();
    if (q) sp.set('q', q);
    if (status) sp.set('status', status);
    for (const [k, v] of Object.entries(over)) sp.set(k, v);
    return sp.toString();
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-white">زيارات العربيات</h1>
          <p className="mt-1 text-sm text-slate-400">
            تسجيل ومتابعة كل زيارة عبر مراحل العمل: الجراج ← الأمن ← المعمل.
          </p>
        </div>
        <Link
          href="/visits/new"
          className="rounded-lg bg-ff-petrol px-4 py-2 text-sm font-semibold text-white transition hover:bg-ff-petrol/80"
        >
          + {AR.registerVisit}
        </Link>
      </header>

      <form method="get" className="flex flex-wrap gap-3" role="search">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="ابحث برقم اللوحة…"
          className="min-w-[200px] flex-1 rounded-lg border border-ff-border bg-ff-bg px-3 py-2 text-sm text-white outline-none focus:border-ff-cyan"
        />
        <select
          name="status"
          defaultValue={status}
          className="rounded-lg border border-ff-border bg-ff-bg px-3 py-2 text-sm text-white"
        >
          <option value="">كل الحالات</option>
          {(Object.keys(TRANSITIONS) as WorkflowStatus[]).map((s) => (
            <option key={s} value={s}>
              {AR.statusLabels[s] ?? s}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded-lg border border-ff-border px-4 py-2 text-sm font-medium text-slate-300 transition hover:border-ff-cyan hover:text-white"
        >
          بحث
        </button>
      </form>

      <section className="rounded-2xl border border-ff-border bg-ff-surface/60 p-5 shadow-card">
        {visits.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-500">
            {q || status
              ? 'مفيش نتائج للبحث أو الفلتر ده.'
              : 'لسه مفيش زيارات — سجّل أول زيارة.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-right text-sm">
              <thead>
                <tr className="border-b border-ff-border text-xs uppercase tracking-wider text-slate-500">
                  <th className="px-3 py-2">الزيارة</th>
                  <th className="px-3 py-2">رقم اللوحة</th>
                  <th className="px-3 py-2">الشركة</th>
                  <th className="px-3 py-2">الحالة</th>
                  <th className="px-3 py-2">تاريخ التسجيل</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {visits.map((visit) => (
                  <tr key={visit.id} className="border-b border-ff-border/50">
                    <td className="px-3 py-2 font-mono text-xs text-slate-300" dir="ltr">{visit.visit_code}</td>
                    <td className="px-3 py-2 font-medium text-white" dir="ltr">{visit.plate_display}</td>
                    <td className="px-3 py-2 text-slate-400">{visit.company}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[visit.status] ?? ''}`}>
                        {AR.statusLabels[visit.status] ?? visit.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-slate-400">
                      {new Date(visit.created_at).toLocaleString('ar-EG')}
                    </td>
                    <td className="px-3 py-2 text-left">
                      <Link
                        href={`/visits/${visit.id}`}
                        className="text-xs font-medium text-ff-cyan hover:underline"
                      >
                        افتح ←
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {pages > 1 ? (
          <nav className="mt-4 flex items-center justify-between text-xs text-slate-400" aria-label="تنقل بين الصفحات">
            <span>صفحة {page} من {pages} · {total} زيارة</span>
            <span className="flex gap-2">
              {page > 1 ? (
                <Link href={`/visits?${qs({ page: String(page - 1) })}`} className="rounded border border-ff-border px-2 py-1 hover:text-white">
                  ← السابقة
                </Link>
              ) : null}
              {page < pages ? (
                <Link href={`/visits?${qs({ page: String(page + 1) })}`} className="rounded border border-ff-border px-2 py-1 hover:text-white">
                  التالية →
                </Link>
              ) : null}
            </span>
          </nav>
        ) : null}
      </section>
    </div>
  );
}
