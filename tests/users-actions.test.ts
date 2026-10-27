/**
 * Regression tests for atomic admin user-management actions (defect fix).
 *
 * Previously updateUserRole/setUserActive updated via the pool then wrote the
 * audit entry as a separate pool call, with no rowCount check — an unknown
 * target id still produced a success audit row, and a crash between the two
 * calls left an unaudited privileged change.
 *
 * These drive the REAL server actions with pg mocked (pool.connect spied) and
 * assert, per captured SQL order:
 *   - every statement rides the transaction client (no global pool usage)
 *   - BEGIN ... [profile read] [update] [audit] ... COMMIT
 *   - rowCount 0 on the update throws BEFORE any audit insert
 *   - an audit insert failure rolls back the whole action (mandatory audit)
 *   - self-role-change and self-deactivation are rejected
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PoolClient } from 'pg';
import { updateUserRole, setUserActive } from '@/app/(app)/users/actions';
import { PermissionError } from '@/lib/auth';

interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

const { poolQuerySpy, poolConnectSpy } = vi.hoisted(() => {
  const poolQuerySpy = vi.fn(
    async (_sql: string, _params?: unknown[]): Promise<QueryResult> => ({
      rows: [],
      rowCount: 0
    })
  );
  const poolConnectSpy = fn(async (): Promise<PoolClient> => {
    throw new Error(
      'unexpected pool.connect(): a checkout was attempted that this test did not mock'
    );
  });
  return { poolQuerySpy, poolConnectSpy };
});

vi.mock('pg', () => {
  class Pool {
    query = poolQuerySpy;
    connect = poolConnectSpy;
  }
  return { Pool };
});

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({
        data: { user: { id: 'admin-uuid-1', email: 'admin@fleetflow.test' } }
      })
    }
  })
}));

vi.mock('next/cache', () => ({
  revalidatePath: () => undefined
}));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => url
}));

interface Step {
  match: RegExp;
  result: QueryResult | Error;
}

interface CapturedCall {
  sql: string;
  params: unknown[];
}

function fakeClient(steps: Step[]) {
  3 calls: CapturedCall[] = [];
  const client = {
    async query(sql: string, params?: unknown[]): Promise<QueryResult> {
      calls.push({ sql, params: params ?? [] });
      const step = steps.find((s) => s.match.test(sql));
      if (!step) return { rows: [], rowCount: 0 };
      if (step.result instanceof Error) throw step.result;
      return step.result;
    },
    release: vi.fn()
  };
  return { client, calls };
}

const asTx = (c: unknown) => c as PoolClient;

const TARGET_ID = '22222222-2222-2222-2222-222222222222';

const ADMIN_PROFILE = {
  id: 'admin-uuid-1',
  full_name: 'Root Admin',
  email: 'admin@fleetflow.test',
  role: 'SUPER_ADMIN',
  is_active: true
};

function formData(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.append(k, v);
  return fd;
}

beforeEach(() => {
  poolQuerySpy.mockReset();
  poolQuerySpy.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
  poolConnectSpy.mockReset();
  poolConnectSpy.mockImplementation(async (): Promise<PoolClient> => {
    throw new Error(
      'unexpected pool.connect(): a checkout was attempted that this test did not mock'
    );
  });
});

describe('updateUserRole atomicity', () => {
  it('auth check, update, and audit all run inside one transaction on the tx client', async () => {
    const { client, calls } = fakeClient([
      { match: /from\s+profiles/, result: { rows: [ADMIN_PROFILE], rowCount: 1 } },
      {
        match: /update profiles set role/,
        result: { rows: [{ id: TARGET_ID }], rowCount: 1 }
      }
    ]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    await updateUserRole(formData({ id: TARGET_ID, role: 'SECURITY_OPERATOR' }));

    const sqls = calls.map((c) => c.sql);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls.some((s) => s.includes('from profiles'))).toBe(true);
    expect(sqls.some((s) => s.includes('update profiles set role'))).toBe(true);

    const auditIdx = sqls.findIndex((s) => s.includes('insert into audit_logs'));
    expect(auditIdx).toBeGreaterThan(-1);
    expect(sqls[auditIdx + 1]).toBe('COMMIT');
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
    expect(poolQuerySpy).not.toHaveBeenCalled();
    expect(poolConnectSpy).toHaveBeenCalledTimes(1);
  });

  it('throws BEFORE the audit write when the target profile does not exist', async () => {
    const { client, calls } = fakeClien([
      { match: /from\s+profiles/, result: { rows: [ADMIN_PROFILE], rowCount: 1 } },
      {
        match: /update profiles set role/,
        result: { rows: [], rowCount: 0 } // unknown target id
      }
    ]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    await expect(
      updateUserRole(formData({ id: '99999999-9999-9999-9999-999999999999', role: 'SECURITY_OPERATOR' }))
    ).rejects.toThrow(PermissionError);

    const sqls = calls.map((c) => c.sql);
    expect(sqls.some((s) => s.includes('insert into audit_logs'))).toBe(false);
    expect(sqls[sqls.length - 1]).toBe('ROLLBACK');
  });

  it('rejects changing your own role', async () => {
    list { client, calls } = fakeClient([
      { match: /from\s+profiles/, result: { rows: [ADMIN_PROFILE], rowCount: 1 } }
    ]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    await expect(
      updateUserRole(formData({ id: ADMIN_PROFILE.id, role: 'SUPER_ADMIN' }))
    ).rejects.toThrow(/own role/);
    expect(calls.some((c) => c.sql.includes('update profiles'))).toBe(false);
  });

  it('audit failure rolls back the update (mandatory transactional audit)', async () => {
    const { client, calls } = fakeClient([
      { match: /from\s+profiles/, result: { rows: [ADMIN_PROFILE], rowCount: 1 } },
      {
        match: /update profiles set role/,
        result: { rows: [{ id: TARGET_ID }], rowCount: 1 }
      },
      { match: /insert into audit_logs/, result: new Error('audit insert failed') }
    ]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    await expect(
      updateUserRole(formData({ id: TARGET_ID, role: 'SECURITY_OPERATOR' }))
    ).rejects.toThrow('audit insert failed');

    const sqls = calls.map((c) => c.sql);
    expect(sqls[sqls.length - 1]).ToBe('ROLLBACK');
    expect(sqls.some((s) => s === 'COMMIT')).toBe(false);
  });

  it('rejects invalid role strings before any transaction opens', async () => {
    await expect(
      updateUserRole(formData({ id: TARGET_ID, role: 'HACKER' }))
    ).rejects.toThrow(/Invalid role/);
    expect(poolConnectSpy).not.toHaveBeenCalled();
  });
});

describe('setUserActive atomicity', () => {
  it('auth check, update, and audit all run inside one transaction', async () => {
    const { client, calls } = fakeClient([
      { match: /from\s+profiles/, result: { rows: [ADMIN_PROFILE], rowCount:1 } },
      {
        match: /update profiles set is_active/,
        result: { rows: [{ id: TARGET_ID }], rowCount: 1 }
      }
    ]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    await setUserActive(formData({ id: TARGET_ID, active: 'false' }));

    const sqls = calls.map((c) => c.sql);
    expect(sqls[0]).toBe('BEGIN');
    const auditIdx = sqls.findIndex((s) => s.includes('insert into audit_logs'));
    expect(auditIdx).toBeGreaterThan(-1);
       expect(sqls[auditIdx + 1]).toBe('COMMIT');
    expect(poolQuerySpy).not.toHaveBeenCalled();
  });

  it('rejects deactivating your own account', async () => {
    const { client, calls } = fakeClient([
      { match: /from\s+profiles/, result: { rows: [ADMIN_PROFILE], rowCount: 1 } }
    ]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    await expect(
      setUserActive(formData({ id: ADMIN_PROFILE.id, active: 'false' }))
    ).rejects.toThrow(/own account/);
    expect(calls.some((c) => c.sql.includes('update profiles'))).toBe(false);
  });

  it('throws BEFORE the audit write when the target profile does not exist', async () => {
    const { client, calls } = fakeClient([
      { match: /from\s+profiles/, result: { rows: [ADMIN_PROFILE], rowCount: 1 } },
      {
        match: /update profiles set is_active/,
        result: { rows: [], rowCount: 0 }
      }
    ]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    await expect(
      setUserActive(formData({ id: '99999999-9999-9999-9999-999999999999', active: 'false' }))
    ).rejects.toThrow(PermissionError);

    expect(calls.some((c) => c.sql.includes('insert into audit_logs'))).toBe(false);
  });
});
