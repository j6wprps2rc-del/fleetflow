/**
 * Regression tests for atomic admin user-management actions (defect fix).
 *
 * Previously updateUserRole/setUserActive updated via the pool then wrote the
 * audit entry as a separate pool call, with no rowCount check — an unknown
 * target id still produced a success audit row, and a crash between the two
 * calls left an unaudited privileged change.
 *
 * Drives the REAL server actions with pg mocked (pool.connect spied):
 *   - one transaction, every statement on the tx client (no pool usage)
 *   - BEGIN ... auth read ... update ... audit ... COMMIT ordering
 *   - rowCount 0 throws BEFORE the audit insert (no phantom audit rows)
 *   - audit failure rolls back the update (mandatory transactional audit)
 *   - self-role-change and self-deactivation rejected before any update
 *   - invalid role rejected before any transaction opens
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
    async (_sql: string, _params?: unknown[]): Promise<QueryResult> => ({ rows: [], rowCount: 0 })
  );
  const poolConnectSpy = vi.fn(async (): Promise<PoolClient> => {
    throw new Error('unexpected pool.connect(): a checkout was not mocked');
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

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/navigation', () => ({ redirect: (url: string) => url }));

interface Step {
  match: RegExp;
  result: QueryResult | Error;
}

interface Call {
  sql: string;
  params: unknown[];
}

function fakeClient(steps: Step[]) {
  const calls: Call[] = [];
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

const ADMIN = {
  id: 'admin-uuid-1',
  full_name: 'Root Admin',
  email: 'admin@fleetflow.test',
  role: 'SUPER_ADMIN',
  is_active: true
};
const TARGET = '22222222-2222-2222-2222-222222222222';
const GHOST = '99999999-9999-9999-9999-999999999999';

const ADMIN_ROW: Step = { match: /from\s+profiles/, result: { rows: [ADMIN], rowCount: 1 } };
const UPDATE_HIT_ROLE: Step = {
  match: /update profiles set role/,
  result: { rows: [{ id: TARGET }], rowCount: 1 }
};
const UPDATE_HIT_ACTIVE: Step = {
  match: /update profiles set is_active/,
  result: { rows: [{ id: TARGET }], rowCount: 1 }
};

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
}

beforeEach(() => {
  poolQuerySpy.mockReset();
  poolQuerySpy.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
  poolConnectSpy.mockReset();
  poolConnectSpy.mockImplementation(async (): Promise<PoolClient> => {
    throw new Error('unexpected pool.connect(): a checkout was not mocked');
  });
});

describe('updateUserRole atomicity', () => {
  it('auth, update, and audit in one transaction on the tx client', async () => {
    const { client, calls } = fakeClient([ADMIN_ROW, UPDATE_HIT_ROLE]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    await updateUserRole(fd({ id: TARGET, role: 'SECURITY_OPERATOR' }));

    const sqls = calls.map((c) => c.sql);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls.some((s) => s.includes('from profiles'))).toBe(true);
    expect(sqls.some((s) => s.includes('update profiles set role'))).toBe(true);
    const i = sqls.findIndex((s) => s.includes('insert into audit_logs'));
    expect(i).toBeGreaterThan(-1);
    expect(sqls[i + 1]).toBe('COMMIT');
    expect(poolQuerySpy).not.toHaveBeenCalled();
    expect(poolConnectSpy).toHaveBeenCalledTimes(1);
  });

  it('throws BEFORE the audit write when the target is unknown', async () => {
    const { client, calls } = fakeClient([
      ADMIN_ROW,
      { match: /update profiles set role/, result: { rows: [], rowCount: 0 } }
    ]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    await expect(
      updateUserRole(fd({ id: GHOST, role: 'SECURITY_OPERATOR' }))
    ).rejects.toThrow(PermissionError);

    const sqls = calls.map((c) => c.sql);
    expect(sqls.some((s) => s.includes('insert into audit_logs'))).toBe(false);
    expect(sqls[sqls.length - 1]).toBe('ROLLBACK');
  });

  it('rejects changing your own role', async () => {
    const { client, calls } = fakeClient([ADMIN_ROW]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    await expect(
      updateUserRole(fd({ id: ADMIN.id, role: 'SUPER_ADMIN' }))
    ).rejects.toThrow(/own role/);
    expect(calls.some((c) => c.sql.includes('update profiles'))).toBe(false);
  });

  it('audit failure rolls back the update (mandatory transactional audit)', async () => {
    const { client, calls } = fakeClient([
      ADMIN_ROW,
      UPDATE_HIT_ROLE,
      { match: /insert into audit_logs/, result: new Error('audit insert failed') }
    ]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    await expect(
      updateUserRole(fd({ id: TARGET, role: 'SECURITY_OPERATOR' }))
    ).rejects.toThrow('audit insert failed');

    const sqls = calls.map((c) => c.sql);
    expect(sqls[sqls.length - 1]).toBe('ROLLBACK');
    expect(sqls.some((s) => s === 'COMMIT')).toBe(false);
  });

  it('rejects invalid role strings before any transaction opens', async () => {
    await expect(updateUserRole(fd({ id: TARGET, role: 'HACKER' }))).rejects.toThrow(
      /Invalid role/
    );
    expect(poolConnectSpy).not.toHaveBeenCalled();
  });
});

describe('setUserActive atomicity', () => {
  it('auth, update, and audit in one transaction', async () => {
    const { client, calls } = fakeClient([ADMIN_ROW, UPDATE_HIT_ACTIVE]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    await setUserActive(fd({ id: TARGET, active: 'false' }));

    const sqls = calls.map((c) => c.sql);
    expect(sqls[0]).toBe('BEGIN');
    const i = sqls.findIndex((s) => s.includes('insert into audit_logs'));
    expect(i).toBeGreaterThan(-1);
    expect(sqls[i + 1]).toBe('COMMIT');
    expect(poolQuerySpy).not.toHaveBeenCalled();
  });

  it('rejects deactivating your own account', async () => {
    const { client, calls } = fakeClient([ADMIN_ROW]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    await expect(setUserActive(fd({ id: ADMIN.id, active: 'false' }))).rejects.toThrow(
      /own account/
    );
    expect(calls.some((c) => c.sql.includes('update profiles'))).toBe(false);
  });

  it('throws BEFORE the audit write when the target is unknown', async () => {
    const { client, calls } = fakeClient([
      ADMIN_ROW,
      { match: /update profiles set is_active/, result: { rows: [], rowCount: 0 } }
    ]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    await expect(setUserActive(fd({ id: GHOST, active: 'false' }))).rejects.toThrow(
      PermissionError
    );
    expect(calls.some((c) => c.sql.includes('insert into audit_logs'))).toBe(false);
  });
});
