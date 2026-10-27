import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth';
import { pool } from '@/db';
import {
  TRANSITIONS,
  isWorkflowStatus,
  type WorkflowStatus
} from '@/lib/workflow';
import { authorizedRolesForTransition } from '@/lib/visit-mapping';
import { AR } from '@/lib/i18n';
import { StageActions, AdminActions } from './stage-actions';

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

interface VisitDetail {
  id: string;
  visit_code: string;
  status: string;
  plate_display: string;
  company: string;
  notes: string | null;
  created_at: string;
  completed_at: string | null;
  registered_by_name: string | null;
}

interface MovementRow {
  id: string;
  zone: string;
  direction: string;
  method: string;
  reason: string | null;
  occurred_at: string;
  confirmed_by_name: string | null;
}

export default async function VisitDetailPage({
  params
}: {
  params: { id: string }
}) {
  const { profile } = await requireUser();
  const id = params.id;

  const visitResult = await pool.query(
    `select v.id::text as id, v.visit_code, v.status::text as status,
            v.notes, v.created_at, v.completed_at,
            ve.plate_display, co.name as company,
            pr.full_name as registered_by_name
       from vehicle_visits v
       join vehicles ve on ve.id = v.vehicle_id
       join companies co on co.id = v.company_id
       left join profiles pr on pr.id = v.registered_by
      where v.id = $1`,
    [id]
  );
  const visit = visitResult.rows[0] as VisitDetail | undefined;
  if (!visit) notFound();

  const movements = await pool.query(
    `select m.id::text as id, z.code::text as zone, m.direction::text as direction,
            m.method::text as method, m.reason, m.occurred_at,
            pr.full_name as confirmed_by_name
       from gate_movements m
       join zones z on z.id = m.zone_id
       left join profiles pr on pr.id = m.confirmed_by
      where m.visit_id = $1
      order by m.occurred_at desc, m.id desc`,
    [id]
  );
  const timeline = movements.rows as MovementRow[];

  const status = isWorkflowStatus(visit.status) ? visit.status : 'REGISTERED';
  const isTerminal = ['COMPLETED', 'REJECTED', 'CANCELLED'].includes(status);

  // Server-side computed action sets for THIS role. UI hiding is cosmetic;
  // the transition action re-checks authorization under the row lock.
  const available = (TRANSITIONS[status] ?? []).filter((target) =>
    authorizedRolesForTransition(status, target).includes(profile.role)
  );
  const adminTargets: WorkflowStatus[] = profile.role === 'SUPER_ADMIN' && !isTerminal
    ? ['ON_HOLD', 'REJECTED', 'CANCELLED']
    : [];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-mono text-xs text-slate-500" dir="ltr">{visit.visit_code}</p>
          <h1 className="mt-1 flex items-center gap-3 text-xl font-bold tracking-tight text-white">
            <span dir="ltr">{visit.plate_display}</span>
            <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[status] ?? ''}`}>
              {AR.statusLabels[status]}
            </span>
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            {visit.company} · تسجيلها {new Date(visit.created_at).toLocaleString('ar-EG')}
            {visit.registered_by_name ? ` بواسطة ${visit.registered_by_name}` : ''}
          </p>
        </div>
        <Link href="/visits" className="text-xs font-medium text-ff-cyan hover:underline">
          → كل الزيارات
        </Link>
      </header>

      {available.length > 0 ? (
        <StageActions
          visitId={visit.id}
          targets={available as WorkflowStatus[]}
        />
      ) : null}

      {adminTargets.length > 0 ? (
        <AdminActions visitId={visit.id} targets={adminTargets} />
      ) : null}

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-ff-border bg-ff-surface/60 p-5 shadow-card lg:col-span-1">
          <h2 className="text-sm font-semibold text-white">التفاصيل</h2>
          <dl className="mt-3 flex flex-col gap-2 text-sm">
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">الشركة</dt>
              <dd className="text-left text-slate-300">{visit.company}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">الحالة</dt>
              <dd className="text-left text-slate-300">{AR.statusLabels[status]}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-slate-500">تاريخ التسجيل</dt>
              <dd className="text-left text-slate-300">{new Date(visit.created_at).toLocaleString('ar-EG')}</dd>
            </div>
            {visit.completed_at ? (
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500">اكتملت</dt>
                <dd className="text-left text-ff-success">{new Date(visit.completed_at).toLocaleString('ar-EG')}</dd>
              </div>
            ) : null}
          </dl>
          {visit.notes ? (
            <div className="mt-4 border-t border-ff-border pt-3">
              <p className="text-xs font-semibold tracking-wider text-slate-500">ملاحظات</p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-slate-300">{visit.notes}</p>
            </div>
          ) : null}
        </div>

        <div className="rounded-2xl border border-ff-border bg-ff-surface/60 p-5 shadow-card lg:col-span-2">
          <h2 className="text-sm font-semibold text-white">سجل الحركة</h2>
          {timeline.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">
              لسه مفيش حركات متسجّلة — أول حركة بتظهر لما الزيارة تتساب للأمن.
            </p>
          ) : (
            <ol className="mt-4 flex flex-col gap-4">
              {timeline.map((m) => (
                <li key="" key={m.id} className="flex gap-3">
                  <span
                    className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                      m.direction === 'ENTRY' ? 'bg-ff-success' : 'bg-ff-warning'
                    }`}
                    aria-hidden
                  />
                  <div>
                    <p className="text-sm text-white">
                      {m.direction === 'ENTRY' ? 'دخول' : 'خروج'} {AR.zoneLabels[m.zone] ?? m.zone}
                      <span className="ml-2 rounded border border-ff-border px-1.5 py-0.5 text-[10px] tracking-wider text-slate-500">
                        تسجيل يدوي
                      </span>
                    </p>
                    <p className="text-xs text-slate-500">
                      {new Date(m.occurred_at).toLocaleString('ar-EG')}
                      {m.confirmed_by_name ? ` · بواسطة ${m.confirmed_by_name}` : ''}
                      {m.reason ? ` · ${m.reason}` : ''}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>
    </div>
  );
}
