'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { updateUserRole, setUserActive } from './actions';
import { arMessage, AR } from '@/lib/i18n';
import type { AppRole } from '@/lib/rbac';

interface Props {
  user: {
    id: string;
    fullName: string;
    role: AppRole;
    isActive: boolean;
    isSelf: boolean;
  };
  roles: AppRole[];
}

/**
 * Client wrapper for the admin user row actions.
 *
 * ROOT CAUSE of "Save does not work": the server actions throw on any failure
 * (unknown target, permission, invalid role, audit failure → rollback). When
 * bound directly to <form action={...}> the thrown error surfaces as a silent
 * production error page — the user sees "nothing happened". This wrapper
 * catches, maps to Egyptian Arabic via arMessage(), shows the message inline,
 * and refreshes the table only on success.
 *
 * Authorization and atomicity are NOT weakened: the server action still does
 * assertRole + update + audit in one transaction (see tests/users-actions.test.ts).
 */
export function UserRowActions({ user, roles }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [role, setRole] = useState<AppRole>(user.role);
  const [error, setError] = useState<string | null>(null);

  function run(fn: () => Promise<void>) {
    setError(null);
    startTransition(async () => {
      try {
        await fn();
        router.refresh();
      } catch (err) {
        setError(arMessage(err));
      }
    });
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as AppRole)}
          disabled={pending || user.isSelf}
          aria-label={`${AR.users}: ${user.fullName}`}
          className="rounded-lg border border-ff-border bg-ff-bg px-2 py-1.5 text-xs text-white disabled:opacity-50"
        >
          {roles.map((r) => (
            <option key={r} value={r}>
              {AR.roleLabels[r]}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={pending || user.isSelf || role === user.role}
          onClick={() => {
            const fd = new FormData();
            fd.append('id', user.id);
            fd.append('role', role);
            run(() => updateUserRole(fd));
          }}
          className="rounded-lg bg-ff-petrol px-2.5 py-1.5 text-xs font-medium text-white transition hover:bg-ff-petrol/80 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? AR.saving : AR.save}
        </button>
        <button
          type="button"
          disabled={pending || user.isSelf}
          onClick={() => {
            const fd = new FormData();
            fd.append('id', user.id);
            fd.append('active', user.isActive ? 'false' : 'true');
            run(() => setUserActive(fd));
          }}
          className="rounded-lg border border-ff-border px-2.5 py-1.5 text-xs font-medium text-slate-300 transition hover:border-ff-warning/50 hover:text-ff-warning disabled:cursor-not-allowed disabled:opacity-50"
        >
          {user.isActive ? 'إيقاف' : 'تشغيل'}
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-ff-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
