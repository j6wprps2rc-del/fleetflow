'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { transitionVisitAction } from '../actions';
import type { WorkflowStatus } from '@/lib/workflow';
import { AR } from '@/lib/i18n';

const ACTION_LABEL: Partial<Record<WorkflowStatus, string>> = {
  WAITING_FOR_SECURITY: 'إرسال للأمن',
  AT_SECURITY: 'تأكيد دخول الأمن',
  WAITING_FOR_LAB: 'إرسال للمعمل',
  AT_LAB: 'تأكيد دخول المعمل',
  COMPLETED: 'إنهاء الزيارة'
};

export function StageActions({
  visitId,
  targets
}: {
  visitId: string;
  targets: WorkflowStatus[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(target: WorkflowStatus) {
    setError(null);
    startTransition(async () => {
      const result = await transitionVisitAction({ visitId, target });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    });
  }

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-3">
        {targets.map((target) => (
          <button
            key={target}
            type="button"
            disabled={pending}
            onClick={() => run(target)}
            className="rounded-lg bg-ff-petrol px-4 py-2 text-sm font-semibold text-white transition hover:bg-ff-petrol/80 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? 'جارٍ التنفيذ…' : ACTION_LABEL[target] ?? AR.statusLabels[target] ?? target}
          </button>
        ))}
      </div>
      {error ? (
        <p role="alert" className="rounded-lg border border-ff-danger/40 bg-ff-danger/10 px-3 py-2 text-xs text-ff-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export function AdminActions({
  visitId,
  targets
}: {
  visitId: string;
  targets: WorkflowStatus[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  function run(target: WorkflowStatus) {
    setError(null);
    startTransition(async () => {
      const result = await transitionVisitAction({ visitId, target, reason });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setReason('');
      router.refresh();
    });
  }

  const ADMIN_LABEL: Partial<Record<WorkflowStatus, string>> = {
    ON_HOLD: 'تعليق الزيارة',
    REJECTED: 'رفض الزيارة',
    CANCELLED: 'إلغاء الزيارة'
  };

  return (
    <section className="flex flex-col gap-2 rounded-2xl border border-ff-warning/30 bg-ff-warning/5 p-4">
      <p className="text-xs font-semibold tracking-wider text-ff-warning">
        إجراءات إدارية (أدمن رئيسي — السبب بيتسجّل بشكل دائم)
      </p>
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="السبب (إجباري، ٣ حروف على الأقل)…"
        className="rounded-lg border border-ff-border bg-ff-bg px-3 py-2 text-sm text-white outline-none focus:border-ff-warning"
      />
      <div className="flex flex-wrap gap-3">
        {targets.map((target) => (
          <button
            key={target}
            type="button"
            disabled={pending}
            onClick={() => run(target)}
            className="rounded-lg border border-ff-warning/50 px-4 py-2 text-sm font-medium text-ff-warning transition hover:bg-ff-warning/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? 'جارٍ التنفيذ…' : ADMIN_LABEL[target] ?? AR.statusLabels[target] ?? target}
          </button>
        ))}
      </div>
      {error ? (
        <p role="alert" className="rounded-lg border border-ff-danger/40 bg-ff-danger/10 px-3 py-2 text-xs text-ff-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
