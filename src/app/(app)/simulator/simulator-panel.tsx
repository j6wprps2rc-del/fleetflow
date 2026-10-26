'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  createGatewayAction,
  rotateGatewayKeyAction,
  setGatewayActiveAction,
  simulateDetectionAction
} from './actions';
import type { GatewayRow } from '@/lib/ingestion';

const ZONES = ['PARKING', 'SECURITY', 'LABORATORY'] as const;

export function SimulatorPanel({ gateways }: { gateways: GatewayRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [label, setLabel] = useState('');
  const [zone, setZone] = useState<string>(ZONES[0]);
  const [tag, setTag] = useState('');
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string; key?: string } | null>(null);

  function run(fn: () => Promise<{ ok: boolean; message: string; plaintextKey?: string }>) {
    setFeedback(null);
    startTransition(async () => {
      const result = await fn();
      setFeedback({ ok: result.ok, message: result.message, key: result.plaintextKey });
      if (result.ok) router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-6">
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
          {feedback.key ? (
            <div className="mt-2">
              <p className="text-[10px] uppercase tracking-wider text-slate-500">Gateway key (shown once)</p>
              <code className="mt-1 block break-all rounded bg-ff-bg px-2 py-1.5 font-mono text-xs text-ff-cyan">
                {feedback.key}
              </code>
            </div>
          ) : null}
        </div>
      ) : null}

      <section className="rounded-2xl border border-ff-border bg-ff-surface/60 p-5 shadow-card">
        <h2 className="text-sm font-semibold text-white">Register a gateway</h2>
        <div className="mt-4 flex flex-wrap gap-3">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Security gate receiver #1"
            className="min-w-[200px] flex-1 rounded-lg border border-ff-border bg-ff-bg px-3 py-2 text-sm text-white outline-none focus:border-ff-cyan"
          />
          <select
            value={zone}
            onChange={(e) => setZone(e.target.value)}
            className="rounded-lg border border-ff-border bg-ff-bg px-3 py-2 text-sm text-white"
          >
            {ZONES.map((z) => (
              <option key={z} value={z}>{z}</option>
            ))}
          </select>
          <button
            type="button"
            disabled={pending || label.trim().length < 3}
            onClick={() =>
              run(() => createGatewayAction({ label, zoneCode: zone })).then(() => setLabel(''))
            }
            className="rounded-lg bg-ff-petrol px-4 py-2 text-sm font-semibold text-white transition hover:bg-ff-petrol/80 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? 'Working…' : 'Create gateway'}
          </bton>
        </div>
      </section>

      <section className="rounded-2xl border border-ff-border bg-ff-surface/60 p-5 shadow-card">
        <h2 className="text-sm font-semibold text-white">Gateways</h2>
        {gateways.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">No gateways registered yet.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-ff-border text-xs uppercase tracking-wider text-stext-slate-500">
                  <th className="px-3 py-2">Label</th>
                  <th className="px-3 py-2">Zone</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Last seen</th>
                  <th className="px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {gateways.map((g) => (
                  <tr key={g.id} className="border-b border-ff-border/50">
                    <td className="px-3 py-2 text-white">{g.label}</td>
                    <td className="px-3 py-2 text-slate-300">{g.zoneName}</td>
                    <td className="px-3 py-2">
                      {g.isActive ? (
                        <span className="rounded-full border border-ff-success/40 bg-ff-success/10 px-2 py-0.5 text-xs text-ff-success">Active</span>
                      ) : (
                        <span className="rounded-full border border-ff-danger/40 bg-ff-danger/10 px-2 py-0.5 text-xs text-ff-danger">Inactive</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-400">
                      {g.lastSeenAt ? new Date(g.lastSeenAt).toLocaleString() : 'Never'}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => run(() => rotateGatewayKeyAction(g.id))}
                          className="rounded border border-ff-border px-2 py-1 text-xs text-slate-300 hover:border-ff-cyan hover:text-ff-cyan"
                        >
                          Rotate key
                        </button>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => run(() => setGatewayActiveAction(g.id, !g.isActive))}
                          className="rounded border border-فت border-ff-border px-2 py-1 text-xs text-slate-300 hover:border-ff-warning hover:text-ff-warning"
                        >
                          {g.isActive ? 'Deactivate' : 'Activate'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-ff-warning/30 bg-ff-warning/5 p-5">
        <h2 className="text-sm font-semibold text-ff-warning">Simulate a detection (SIMULATED data)</h2>
        <p className="mt-1 text-xs text-slate-400">
          Sends a simulated BLE tag detection through the real ingestion pipeline. The resulting
          movement row is recorded with method SIMULATED and is labeled as such everywhere.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <input
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="BLE tag id (e.g. TAG-001)"
            className="min-w-[200px] flex-1 rounded-lg border border-ff-border bg-ff-bg px-3 py-2 text-sm text-white outline-none focus:border-ff-warning"
          />
          <button
            type="button"
            disabled={pending || tag.trim().length < 2}
            onClick={() =>
              run(async () => {
                const key = window.prompt('Gateway key (paste the key you saved)');
                if (!key) return { ok: false, message: 'Simulation cancelled — no key provided.' };
                return simulateDetectionAction({ gatewayKey: key, bleTagId: tag.trim() });
              })
            }
            className="rounded-lg border border-ff-warning/50 px-4 py-2 text-sm font-semibold text-ff-warning transition hover:bg-ff-warning/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? 'Sending…' : 'Send simulated detection'}
          </button>
        </div>
        <p className="mt-2 text-[10px] text-slate-500">
          The key is requested at use-time and is never stored in the browser.
        </p>
      </section>
    </div>
  );
}
