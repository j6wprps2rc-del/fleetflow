'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';
import { registerVisitAction } from '../actions';

function newIdempotencyKey(): string {
  // Stable per form instance until submission succeeds or the user resets —
  // retries (double-click, network retry) reuse the same key safely.
  return `reg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function NewVisitForm({ companies }: { companies: { id: string; name: string }[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [plate, setPlate] = useState('');
  const [companyId, setCompanyId] = useState(companies[0]?.id ?? '');
  const [newCompanyName, setNewCompanyName] = useState('');
  const [driverName, setDriverName] = useState('');
  const [driverPhone, setDriverPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setFeedback(null);
    setConflict(null);

    startTransition(async () => {
      const result = await registerVisitAction({
        plate,
        companyId,
        newCompanyName: companyId === 'new' ? newCompanyName : undefined,
        driverName: driverName || undefined,
        driverPhone: driverPhone || undefined,
        notes: notes || undefined,
        idempotencyKey
      });

      if (result.ok && result.visitId) {
        router.push(`/visits/${result.visitId}`);
        router.refresh();
        return;
      }

      setFeedback({ ok: false, message: result.message });
      if (result.conflict) {
        setConflict(result.conflict.visitId);
      }
    });
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-4 rounded-2xl border border-ff-border bg-ff-surface/60 p-6 shadow-card"
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Vehicle plate *</span>
        <input
          required
          value={plate}
          onChange={(e) => setPlate(e.target.value)}
          placeholder="e.g. ABC-1234"
          className="rounded-lg border border-ff-border bg-ff-bg px-3 py-2 text-sm text-white outline-none focus:border-ff-cyan"
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Company *</span>
        <select
          value={companyId}
          onChange={(e) => setCompanyId(e.target.value)}
          className="rounded-lg border border-ff-border bg-ff-bg px-3 py-2 text-sm text-white"
        >
          {companies.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
          <option value="new">+ New company…</option>
        </select>
      </label>

      {companyId === 'new' ? (
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">New company name *</span>
          <input
            required
            value={newCompanyName}
            onChange={(e) => setNewCompanyName(e.target.value)}
            className="rounded-lg border border-ff-border bg-ff-bg px-3 py-2 text-sm text-white outline-none focus:border-ff-cyan"
          />
        </label>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Driver name</span>
          <input
            value={driverName}
            onChange={(e) => setDriverName(e.target.value)}
            className="rounded-lg border border-ff-border bg-ff-bg px-3 py-2 text-sm text-white outline-none focus:border-ff-cyan"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Driver phone</span>
          <input
            value={driverPhone}
            onChange={(e) => setDriverPhone(e.target.value)}
            placeholder="+966…"
            className="rounded-lg border border-ff-border bg-ff-bg px-3 py-2 text-sm text-white outline-none focus:border-ff-cyan"
          />
        </label>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Notes</span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          className="rounded-lg border border-ff-border bg-ff-bg px-3 py-2 text-sm text-white outline-none focus:border-ff-cyan"
        />
      </label>

      {feedback ? (
        <div
          role="alert"
          className={`rounded-lg border px-4 py-3 text-sm ${
            feedback.ok
              ? 'border-ff-success/40 bg-ff-success/10 text-ff-success'
              : 'border-ff-danger/40 bg-ff-danger/10 text-ff-danger'
          }`}
        >
          <p>{feedback.message}</p>
          {conflict ? (
            <Link href={`/visits/${conflict}`} className="mt-1 inline-block text-xs font-medium text-ff-cyan hover:underline">
              Open the active visit →
            </Link>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3 border-t border-ff-border pt-4">
        <button
          type="button"
          onClick={() => setIdempotencyKey(newIdempotencyKey())}
          className="text-xs text-slate-500 hover:text-slate-300"
        >
          Reset form
        </button>
        <div className="flex gap-3">
          <Link
            href="/visits"
            className="rounded-lg border border-ff-border px-4 py-2 text-sm font-medium text-slate-300 transition hover:text-white"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-ff-petrol px-4 py-2 text-sm font-semibold text-white transition hover:bg-ff-petrol/80 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? 'Registering…' : 'Register visit'}
          </button>
        </div>
      </div>
    </form>
  );
}
