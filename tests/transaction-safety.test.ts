/**
 * Behavior-focused regression tests for the pool-starvation fix (Option B).
 *
 * These import the REAL production modules — src/db, src/lib/auth, src/lib/audit,
 * src/lib/visits — and drive them with content-matched fake clients (responses
 * keyed by SQL text, not call order), with pool.connect spied so no database
 * connection is ever opened. This proves:
 *   1. withTransaction checks out exactly one connection (the Vercel max=1
 *      deadlock cannot recur) and ROLLBACK/release failures never mask the
 *      original error.
 *   2. assertRole/audit/registerVisit/transitionVisit use the transaction
 *      client for their DB work — never the global pool — inside transactions.
 *   3. transitionVisit writes a TRANSITION_VISIT audit entry (from/to/reason)
 *      in the same transaction, and everything (incl. the audit row) rolls
 *      back on failure.
 *   4. Non-transactional paths (acknowledgeNotification) still use the pool.
 *
 * Typing notes (root-cause fixes for the 14 tsc errors under
 * strict + noUncheckedIndexedAccess):
 *   - Both pool spies carry EXPLICIT signatures. Without them, vi.fn infers
 *     `rows: never[]` from the default response and an empty parameters tuple
 *     (making mock.calls[0][0] a type error). With them, fixtures are checked
 *     against QueryResult and call arguments are typed.
 *   - The `at()` helper performs guarded indexed access: it THROWS with a
 *     descriptive message when an element is missing, so a broken expectation
 *     fails loudly instead of being silenced by a non-null assertion.
 *   - beforeEach resets each spy and re-establishes its default:
 *     poolQuerySpy answers empty OK; poolConnectSpy THROWS on any checkout
 *     that a test did not explicitly mock — an unmocked connect is exactly
 *     the 'second connection' regression these tests exist to catch.
 *
 * NOTE: spies used inside vi.mock factories MUST be created with vi.hoisted —
 * vi.mock is hoisted above ordinary const declarations (TDZ crash otherwise).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PoolClient } from 'pg';
import { withTransaction, type QueryExecutor } from '@/db';
import { assertRole } from '@/lib/auth';
import { audit } from '@/lib/audit';
import { registerVisit, transitionVisit, acknowledgeNotification } from '@/lib/visits';

/**
 * Shape returned by every scripted query. Declared once and used for BOTH the
 * fake clients and the pool spy so fixtures are checked at compile time.
 */
interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

const EMPTY_RESULT: QueryResult = { rows: [], rowCount: 0 };

const { poolQuerySpy, poolConnectSpy } = vi.hoisted(() => {
  const poolQuerySpy = vi.fn(
    async (_sql: string, _params?: unknown[]): Promise<QueryResult> => ({
      rows: [],
      rowCount: 0
    })
  );
  const poolConnectSpy = vi.fn(async (): Promise<PoolClient> => {
    throw new Error(
      'unexpected pool.connect(): a connection checkout was attempted that this test did not mock'
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
        data: { user: { id: 'user-uuid-1', email: 'op@fleetflow.test' } }
      })
    }
  })
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

/**
 * Content-matched fake transaction client: each step's response is chosen by
 * matching the SQL text (first match wins). Unmatched SQL returns an empty OK.
 * Robust against statement ordering (BEGIN/COMMIT included) and future
 * statement additions.
 */
function fakeClient(steps: Step[]) {
  const calls: CapturedCall[] = [];
  const client = {
    async query(sql: string, params?: unknown[]): Promise<QueryResult> {
      calls.push({ sql, params: params ?? [] });
      const step = steps.find((s) => s.match.test(sql));
      if (!step) return EMPTY_RESULT;
      if (step.result instanceof Error) throw step.result;
      return step.result;
    },
    release: vi.fn()
  };
  return { client, calls };
}

/**
 * Guarded indexed access for noUncheckedIndexedAccess: throws a descriptive
 * error when the element is absent, so a violated expectation surfaces as a
 * test failure — never silently undefined, and without `as any` or ! hacks.
 */
function at<T>(arr: readonly T[], index: number, what: string): T {
  const value = arr[index];
  if (value === undefined) {
    throw new Error(`Expected ${what} at index ${index}, but the array has ${arr.length} element(s).`);
  }
  return value;
}

const asTx = (c: unknown) => c as PoolClient;
const asExec = (c: unknown) => c as QueryExecutor;

const UUID = '11111111-1111-1111-1111-111111111111';

const ZONE_ROW: QueryResult = { rows: [{ id: UUID }], rowCount: 1 };

const SECURITY_PROFILE = {
  id: 'user-uuid-1',
  full_name: 'Sec Op',
  email: 'sec@fleetflow.test',
  role: 'SECURITY_OPERATOR',
  is_active: true
};

const LOCKED_VISIT = {
  id: UUID,
  status: 'WAITING_FOR_SECURITY',
  visit_code: 'V-20260101-ABCDEF'
};

beforeEach(() => {
  poolQuerySpy.mockReset();
  poolQuerySpy.mockImplementation(async (_sql: string, _params?: unknown[]): Promise<QueryResult> => ({
    rows: [],
    rowCount: 0
  }));
  poolConnectSpy.mockReset();
  poolConnectSpy.mockImplementation(async (): Promise<PoolClient> => {
    throw new Error(
      'unexpected pool.connect(): a connection checkout was attempted that this test did not mock'
    );
  });
});

// ── 1 · withTransaction ────────────────────────────────────────────

describe('withTransaction hardening', () => {
  it('runs the body on the checked-out client and never touches the global pool', async () => {
    const { client, calls } = fakeClient([]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    let sawClient = false;
    const result = await withTransaction(async (tx) => {
      sawClient = tx === asTx(client);
      await tx.query('select 1');
      return 'done';
    });

    expect(result).toBe('done');
    expect(sawClient).toBe(true);
    expect(calls.map((c) => c.sql)).toEqual(['BEGIN', 'select 1', 'COMMIT']);
    expect(poolQuerySpy).not.toHaveBeenCalled();
    expect(poolConnectSpy).toHaveBeenCalledTimes(1);
  });

  it('propagates the ORIGINAL error when the body throws — even if ROLLBACK also fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { client } = fakeClient([
        { match: /ROLLBACK/, result: new Error('rollback also fails') }
      ]);
      poolConnectSpy.mockResolvedValueOnce(asTx(client));

      const original = new Error('original business error');
      await expect(
        withTransaction(async () => {
          throw original;
        })
      ).rejects.toThrow('original business error');

      // The release must still have been attempted (in finally).
      expect(client.release).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('releases the client when the body succeeds', async () => {
    const { client } = fakeClient([]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    await withTransaction(async () => 'ok');

    expect(client.release).toHaveBeenCalled();
    expect(poolQuerySpy).not.toHaveBeenCalled();
  });

  it('releases the client even when the body throws', async () => {
    const { client } = fakeClient([]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    await expect(
      withTransaction(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(client.release).toHaveBeenCalled();
    expect(poolQuerySpy).not.toHaveBeenCalled();
  });
});

// ── 2 · transaction-client propagation (Option B) ─────────────────

describe('transaction-client propagation', () => {
  it('assertRole uses the provided client, not the global pool', async () => {
    const { client, calls } = fakeClient([
      {
        match: /from\s+profiles/,
        result: { rows: [{ ...SECURITY_PROFILE, role: 'PARKING_OPERATOR' }], rowCount: 1 }
      }
    ]);

    const { profile } = await assertRole(['PARKING_OPERATOR'], asExec(client));

    expect(profile.role).toBe('PARKING_OPERATOR');
    expect(poolQuerySpy).not.toHaveBeenCalled();
    expect(calls.length).toBe(1);
    expect(at(calls, 0, 'profile query call').sql).toContain('from profiles');
  });

  it('assertRole without a client still works via the pool (standalone calls)', async () => {
    poolQuerySpy.mockResolvedValueOnce({
      rows: [{ ...SECURITY_PROFILE, role: 'PARKING_OPERATOR' }],
      rowCount: 1
    });

    const { profile } = await assertRole(['PARKING_OPERATOR']);
    expect(profile.role).toBe('PARKING_OPERATOR');
    expect(poolQuerySpy).toHaveBeenCalledTimes(1);
  });

  it('assertRole rejects roles not in the allowed list, on the provided client', async () => {
    const { client } = fakeClient([
      { match: /from\s+profiles/, result: { rows: [SECURITY_PROFILE], rowCount: 1 } }
    ]);

    await expect(
      assertRole(['PARKING_OPERATOR'], asExec(client))
    ).rejects.toThrow(/Forbidden for role SECURITY_OPERATOR/);
    expect(poolQuerySpy).not.toHaveBeenCalled();
  });

  it('audit uses the provided client when given, pool otherwise', async () => {
    const { client, calls } = fakeClient([]);

    await audit('u1', 'TEST_ACT', 't', 'x', { a: 1 }, asExec(client));
    expect(calls.length).toBe(1);
    expect(at(calls, 0, 'audit insert call').sql).toContain('insert into audit_logs');
    expect(poolQuerySpy).not.toHaveBeenCalled();

    await audit('u1', 'TEST_ACT', 't', 'x', { a: 1 });
    expect(poolQuerySpy).toHaveBeenCalledTimes(1);
  });

  it('audit failures are non-fatal (logged, not thrown) on both paths', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { client } = fakeClient([
        { match: /insert into audit_logs/, result: new Error('audit insert failed') }
      ]);
      await expect(
        audit('u1', 'TEST_ACT', 't', 'x', {}, asExec(client))
      ).resolves.toBeUndefined();

      poolQuerySpy.mockRejectedValueOnce(new Error('pool audit failed'));
      await expect(audit('u1', 'TEST_ACT', 't', 'x', {})).resolves.toBeUndefined();
    } finally {
      errSpy.mockRestore();
    }
  });
});

// ── 3 · registerVisit / transitionVisit on fake clients ────────────

describe('registerVisit connection behavior', () => {
  it('performs ALL its DB work on the transaction client, audit included', async () => {
    const { client, calls } = fakeClient([
      { match: /from companies/, result: { rows: [{ id: UUID }], rowCount: 1 } },
      { match: /insert into vehicles/, result: { rows: [{ id: UUID }], rowCount: 1 } },
      { match: /where idempotency_key = /, result: EMPTY_RESULT }, // fast path: not found
      {
        match: /insert into vehicle_visits/,
        result: { rows: [{ id: UUID, visit_code: 'V-20260101-ABCDEF' }], rowCount: 1 }
      }
    ]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    const result = await registerVisit(
      { plate: 'ABC 1234', companyId: UUID, idempotencyKey: 'key-12345678' },
      { userId: 'user-uuid-1', role: 'PARKING_OPERATOR' }
    );

    expect(result.ok).toBe(true);
    expect(poolQuerySpy).not.toHaveBeenCalled();
    expect(poolConnectSpy).toHaveBeenCalledTimes(1);

    const sqls = calls.map((c) => c.sql);
    const auditIdx = sqls.findIndex((s) => s.includes('insert into audit_logs'));
    expect(auditIdx).toBeGreaterThan(-1);
    expect(at(sqls, sqls.length - 1, 'last transaction statement')).toBe('COMMIT'); // audit committed with the txn
    // REGISTER_VISIT audit params: actor, action, table, targetId, json
    expect(at(at(calls, auditIdx, 'audit insert call').params, 1, 'audit action param')).toBe(
      'REGISTER_VISIT'
    );
  });

  it('resolves a same-key retry to the original visit (idempotent)', async () => {
    const { client } = fakeClient([
      { match: /from companies/, result: { rows: [{ id: UUID }], rowCount: 1 } },
      { match: /insert into vehicles/, result: { rows: [{ id: UUID }], rowCount: 1 } },
      {
        match: /where idempotency_key = /,
        result: {
          rows: [
            {
              id: UUID,
              visit_code: 'V-20260101-ABCDEF',
              company_id: UUID,
              vehicle_id: UUID
            }
          ],
          rowCount: 1
        }
      }
    ]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    const result = await registerVisit(
      { plate: 'ABC 1234', companyId: UUID, idempotencyKey: 'key-12345678' },
      { userId: 'user-uuid-1', role: 'PARKING_OPERATOR' }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.visitId).toBe(UUID);
      expect(result.visitCode).toBe('V-20260101-ABCDEF');
    }
    expect(poolQuerySpy).not.toHaveBeenCalled();
  });
});

describe('transitionVisit connection behavior', () => {
  it('authorizes on the tx client against post-lock state and writes TRANSITION_VISIT audit in-transaction', async () => {
    const { client, calls } = fakeClient([
      { match: /for update/, result: { rows: [LOCKED_VISIT], rowCount: 1 } },
      { match: /from\s+profiles/, result: { rows: [SECURITY_PROFILE], rowCount: 1 } },
      { match: /from\s+zones/, result: ZONE_ROW }
    ]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    const result = await transitionVisit({ visitId: UUID, target: 'AT_SECURITY' });

    expect(result.from).toBe('WAITING_FOR_SECURITY');
    expect(result.to).toBe('AT_SECURITY');
    expect(poolQuerySpy).not.toHaveBeenCalled();
    expect(poolConnectSpy).toHaveBeenCalledTimes(1);

    const sqls = calls.map((c) => c.sql);
    // 1 movement for WAITING_FOR_SECURITY → AT_SECURITY (SECURITY ENTRY)
    expect(sqls.filter((s) => s.includes('insert into gate_movements')).length).toBe(1);
    expect(sqls.some((s) => s.includes("values ($1, $2, 'ENTRY'"))).toBe(false); // direction is a param
    expect(sqls.some((s) => s.includes('update vehicle_visits'))).toBe(true);
    expect(sqls.some((s) => s.includes('insert into notifications'))).toBe(true);

    const auditIdx = sqls.findIndex((s) => s.includes('insert into audit_logs'));
    expect(auditIdx).toBeGreaterThan(-1);
    expect(at(sqls, auditIdx + 1, 'statement after the audit insert')).toBe('COMMIT'); // audit committed WITH the txn
    // TRANSITION_VISIT audit params: actor, action, table, targetId, details-json
    const auditCall = at(calls, auditIdx, 'audit insert call');
    expect(at(auditCall.params, 1, 'audit action param')).toBe('TRANSITION_VISIT');
    const details = JSON.parse(
      String(at(auditCall.params, 4, 'audit details json param'))
    ) as Record<string, unknown>;
    expect(details.from).toBe('WAITING_FOR_SECURITY');
    expect(details.to).toBe('AT_SECURITY');
    expect(details.reason).toBeNull();
  });

  it('rolls back everything (incl. the audit row) when a step fails', async () => {
    const { client, calls } = fakeClient([
      { match: /for update/, result: { rows: [LOCKED_VISIT], rowCount: 1 } },
      { match: /from\s+profiles/, result: { rows: [SECURITY_PROFILE], rowCount: 1 } },
      { match: /from\s+zones/, result: ZONE_ROW },
      { match: /insert into gate_movements/, result: new Error('gate movement insert failed') }
    ]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    await expect(
      transitionVisit({ visitId: UUID, target: 'AT_SECURITY' })
    ).rejects.toThrow('gate movement insert failed');

    const sqls = calls.map((c) => c.sql);
    expect(sqls.some((s) => s.includes('insert into audit_logs'))).toBe(false);
    expect(sqls.some((s) => s.includes('insert into notifications'))).toBe(false);
    expect(at(sqls, sqls.length - 1, 'last transaction statement')).toBe('ROLLBACK');
    expect(poolQuerySpy).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalled();
  });

  it('rejects unauthorized roles (assertRole throws on the tx client)', async () => {
    const { client } = fakeClient([
      { match: /for update/, result: { rows: [LOCKED_VISIT], rowCount: 1 } },
      {
        match: /from\s+profiles/,
        result: { rows: [{ ...SECURITY_PROFILE, role: 'LAB_OPERATOR' }], rowCount: 1 }
      }
    ]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    await expect(
      transitionVisit({ visitId: UUID, target: 'AT_SECURITY' })
    ).rejects.toThrow(/Forbidden for role LAB_OPERATOR/);
    expect(poolQuerySpy).not.toHaveBeenCalled();
  });

  it('rejects invalid transitions after the lock (state machine)', async () => {
    const { client } = fakeClient([
      {
        match: /for update/,
        result: { rows: [{ ...LOCKED_VISIT, status: 'REGISTERED' }], rowCount: 1 }
      },
      { match: /from\s+profiles/, result: { rows: [SECURITY_PROFILE], rowCount: 1 } }
    ]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    // SECURITY_OPERATOR is authorized for AT_SECURITY transitions generally,
    // but REGISTERED → AT_SECURITY is not a legal edge.
    await expect(
      transitionVisit({ visitId: UUID, target: 'AT_SECURITY' })
    ).rejects.toThrow(/not allowed/);
    expect(poolQuerySpy).not.toHaveBeenCalled();
  });
});

// ── 4 · non-transactional path unchanged ───────────────────────────

describe('acknowledgeNotification still uses the pool (non-transactional)', () => {
  it('runs its update through pool.query, not a transaction', async () => {
    // TWO pool calls happen in order: (1) assertRole profile read, then
    // (2) the notification update. Queue both responses — typed literals,
    // checked against QueryResult at compile time (no casts needed).
    poolQuerySpy
      .mockResolvedValueOnce({ rows: [SECURITY_PROFILE], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await expect(acknowledgeNotification(UUID)).resolves.toBeUndefined();
    expect(poolQuerySpy).toHaveBeenCalledTimes(2);
    expect(poolConnectSpy).not.toHaveBeenCalled();

    const firstSql = at(poolQuerySpy.mock.calls, 0, 'first pool call')[0];
    const secondSql = at(poolQuerySpy.mock.calls, 1, 'second pool call')[0];
    expect(firstSql).toContain('from profiles');
    expect(secondSql).toContain('update notifications');
    expect(secondSql).toContain('acknowledged_at = now()');
    expect(secondSql).toContain('acknowledged_by = $1');
    expect(secondSql).toContain('where id = $2');
    expect(secondSql).toContain('target_role = $3');
  });
});
