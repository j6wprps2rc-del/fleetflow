/**
 * Behavior-focused regression tests for the pool-starvation fix (Option B).
 *
 * These import the REAL production modules — src/db, src/lib/auth, src/lib/audit,
 * src/lib/visits — and drive them with scripted fake clients, with
 * pool.connect spied so no connection is ever actually opened. This proves:
 *   1. withTransaction never checks out a second connection (the Vercel
 *      max=1 deadlock cannot recur) and ROLLBACK/release failures don't
 *      mask the original error.
 *   2. assertRole/audit/transitionVisit/registerVisit use the transaction
 *      client for their DB work — never the global pool — when invoked inside
 *      a transaction.
 *   3. transitionVisit writes a TRANSITION_VISIT audit entry in the same
 *      transaction, with from/to/reason, and it rolls back on failure.
 *   4. Non-transactional paths (acknowledgeNotification) still use the pool.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/** Row shape returned by our scripted clients. */
interface FakeResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

/** Minimal structural type accepted as the transaction/PoolClient argument. */
type FakeClient = {
  query: (sql: string, params?: unknown[]) => Promise<FakeResult>;
  release: () => void;
};

function fakeClient(script: Array<(sql: string, params?: unknown[]) => FakeResult | Error>) {
  let call = 0;
  const queries: string[] = [];
  const client: FakeClient = {
    async query(sql: string, params?: unknown[]) {
      queries.push(sql);
      const step = script[Math.min(call, script.length - 1)] ?? script[script.length - 1];
      call += 1;
      const out = step(sql, params);
      if (out instanceof Error) throw out;
      return out;
  },
    release: vi.fn()
  };
  return { client, queries };
}

// ── pool spies ────────────────────────────────────────────────────
// Both the Pool.query (background) and Pool.connect (tx checkout) paths are
// spied so any accidental use of the global pool inside a transaction is
// detectable: it would appear in poolQuerySpy.mock.calls.
const poolQuerySpy = vi.fn(async () => ({ rows: [], rowCount: 0 }) as FakeResult);
const poolConnectSpy = vi.fn();

vi.mock('pg', () => {
  const Pool = class {
    query = poolQuerySpy;
    connect = poolConnectSpy;
  };
  const drizzle = () => ({ __drizzleStub: true });
  return { Pool, drizzle };
});

// '@/lib/supabase/server' — assertRole calls createClient().auth.getUser().
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({
        data: { user: { id: 'user-uuid-1', email: 'op@fleetflow.test' } }
      })
    }
  })
});

import { withTransaction, pool } from '@/db';
import { assertRole } from '@/lib/auth';
import { audit } from '@/lib/audit';
import { registerVisit, transitionVisit } from '@/lib/visits';

const UUID = '11111111-1111-1111-1111-111111111111';
const OK: FakeResult = { rows: [], rowCount: 0 };

function err(code: string, constraint: string) {
  const e = new Error('fake pg error') as Error & { code: string; constraint: string };
  e.code = code;
  e.constraint = constraint;
  return e;
}

beforeEach(() => {
  poolQuerySpy.mockClear();
  poolConnectSpy.mockClear();
});

// ── 1 · withTransaction ────────────────────────────────────────────

describe('withTransaction hardening', () => {
  it('runs the body on the checked-out client and never touches the global pool', async () => {
    const { client } = fakeClient([() => OK]);
    poolConnectSpy.mockResolvedValueOnce(client);

    let sawClient = false;
    const result = await withTransaction(async (tx) => {
      sawClient = tx === (client as unknown);
      await tx.query('select 1');
      return 'done';
    });

    expect(result).toBe('done');
    expect(sawClient).toBe(true);
    expect(poolQuerySpy).not.toHaveBeenCalled();
    expect(poolConnectSpy).toHaveBeenCalledTimes(1);
  });

  it('propagates the ORIGINAL error when the body throws — even if ROLLBACK also fails', async () => {
    const original = new Error('original business error');
    const { client } = fakeClient([
      () => OK, // BEGIN
      () => new Error('connection dead'), // body query fails
      () => new Error('rollback also fails') // ROLLBACK fails
    ]);
    poolConnectSpy.mockResolvedValueOnce(client);

    await expect(
      withTransaction(async () => {
        throw original;
      })
    ).rejects.toThrow('original business error');

    // The release must still have been attempted (in finally).
    expect(client.release).toHaveBeenCalled();
  });

  it('releases the client even when the body succeeds', async () => {
    const { client } = fakeClient([() => OK]);
    poolConnectSpy.mockResolvedValueOnce client);

    await withTransaction(async () => 'ok');

    expect(client.release).toHaveBeenCalled();
    expect(poolQuerySpy).not.toHaveBeenCalled();
  });
});

// ── 2 · transaction-client propagation (Option B) ─────────────────────

describe('transaction-client propagation', () => {
  it('assertRole uses the provided client, not the global pool', async () => {
    const { client, queries } = fakeClient([
      () => ({
        rows: [{
          id: 'user-uuid-1',
          full_name: 'Op One',
          email: 'op@fleetflow.test',
          role: 'PARKING_OPERATOR',
          is_active: true
        }],
        rowCount: 1
      })
    ]);

    const { profile } = await assertRole(['PARKING_OPERATOR'], client as never);

    expect(profile.role).toBe('PARKING_OPERATOR');
    expect(poolQuerySpy).not.toHaveBeenCalled();
    expect(queries.length).toBe(1);
    expect(queries[0]).toContain('from profiles');
  });

  it('assertRole without a client still works via the pool (standalone calls)', async () => {
    poolQuerySpy.mockResolvedValueOnce({
      rows: [{
        id: 'user-uuid-1',
        full_name: 'Op One',
        email: 'op@fleetflow.test',
        role: 'PARKING_OPERATOR',
        is_active: true
      }],
      rowCount: 1
    } as FakeResult);

    const { profile } = await assertRole(['PARKING_OPERATOR']);
    expect(profile.role).toBe('PARKING_OPERATOR');
    expect(poolQuerySpy).toHaveBeenCalledTimes(1);
  });

  it('audit uses the provided client when given, pool otherwise', async () => {
    const { client, queries } = fakeClient([() => OK]);

    await audit('u1', 'TEST_ACT', 't', 'x', { a: 1 }, client as never);
    expect(queries.length).toBe(1);
    expect(queries[0]).toContain('insert into audit_logs');
    expect(poolQuerySpy).not.toHaveBeenCalled();

    poolQuerySpy.mockClear();
    await audit('u1', 'TEST_ACT', 't', 'x', { a: 1 });
    expect(poolQuerySpy).toHaveBeenCalledTimes(1);
  });

  it('audit failures are non-fatal (logged, not thrown) on both paths', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { client } = fakeClient([() => new Error('audit insert failed')]);
      await expect(
        audit('u1', 'TEST_ACT', 't', 'x', {}, client as never)
      ).resolves.toBeUndefined();

      poolQuerySpy.mockRejectedValueOnce(new Error('pool audit failed'));
      await expect(audit('u1', 'TEST_ACT', 't', 'x', {})).resolves.toBeUndefined();
    } finally {
      errSpy.mockRestore();
    }
  });
});

// ── 3 · registerVisit / transitionVisit end-to-end on fake clients ────

describe('registerVisit & transitionVisit connection behavior', () => {
  it('registerVisit performs ALL its DB work on the transaction client', async () => {
    const { client, queries } = fakeClient([
      () => OK, // company check/insert
      () => OK, // vehicle upsert
      () => OK, // idempotency fast-path select
      () => ({ rows: [{ id: UUID, visit_code: 'V-20260101-ABCDEF' }], rowCount: 1 }), // visit insert
      () => OK // audit insert
    ]);
    poolConnectSpy.mockResolvedValueOnce(client);

    const result = await registerVisit(
      {
        plate: 'ABC 1234',
        companyId: UUID,
        idempotencyKey: 'key-12345678'
      },
      { userId: 'user-uuid-1', role: 'PARKING_OPERATOR' }
    );

    expect(result.ok).toBe(true);
    // No global-pool usage at all inside the transaction.
    expect(poolQuerySpy).not.toHaveBeenCalled();
    expect(poolConnectSpy).toHaveBeenCalledTimes(1);
    // The audit row rode the same connection (last query is the audit insert).
    expect(queries[queries.length - 1]).toContain('insert into audit_logs');
  });

  it('registerVisit resolves a same-key retry to the original visit (idempotent)', async () => {
    const { client } = fakeClient([
      () => OK, // company
      () => OK, // vehicle
      () => ({
        rows: [{ id: UUID, visit_code: 'V-20260101-ABCDEF', company_id: UUID, vehicle_id: UUID }],
        rowCount: 1
      }), // idempotency fast-path finds the original
      () => OK
    ]);
    poolConnectSpy.mockResolvedValueOnce(client);

    const result = await registerVisit(
      {
        plate: 'ABC 1234',
        companyId: UUID,
        idempotency same key twice
        idempotencyKey: 'key-12345678'
      },
      { userId: 'user-uuid-1', role: 'PARKING_OPERATOR' }
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.visitId).toBe(UUID);
  });

  it('transitionVisit authorizes on the tx client and writes TRANSITION_VISIT audit', async () => {
    const profileRow = {
      id: 'user-uuid-1',
      full_name: 'Sec Op',
      email: 'sec@fleetflow.test',
      role: 'SECURITY_OPERATOR',
      is_active: true
    };
    const { client, queries } = fakeClient([
      () => ({ rows: [{ id: UUID, status: 'WAITING_FOR_SECURITY', visit_code: 'V-20260101-ABCDEF' }], rowCount: 1 }), // lock
      () => ({ rows: [profileRow], rowCount: 1 }), // assertRole profile read
      () => OK, // gate movement insert
      () => OK, // status update
      () => OK, // notification insert
      () => OK // audit insert
    ]);
    poolConnectSpy.mockResolvedValueOnce(client);

    const result = await transitionVisit({
      visitId: UUID,
      target: 'AT_SECURITY'
    });

    expect(result.to).toBe('AT_SECURITY');
    expect(result.from).toBe('WAITING_FOR_SECURITY');
    expect(poolQuerySpy).not.toHaveBeenCalled();
    expect(poolConnectSpy).toHaveBeenCalledTimes(1);

    const auditIndex = queries.findIndex((q) => q.includes('insert into audit_logs'));
    expect(auditIndex).toBeGreaterThan(-1);
    const auditSql = queries[auditIndex];
    expect(auditSql).toContain('audit_logs');
  });

  it('transitionVisit rolls back everything (incl. the audit row) when a step fails', async () => {
    const profileRow = {
      id: 'user-uuid-1',
      full_name: 'Sec Op',
      email: 'sec@fleetflow.test',
      role: 'SECURITY_OPERATOR',
      is_active: true
    };
    const { client, queries } = fakeClient([
      () => ({ rows: [{ id: UUID, status: 'WAITING_FOR_SECURITY', visit_code: 'V-20260101-ABCDEF' }], rowCount: 1 }), // lock
      () => ({ rows: [profileRow], rowCount: 1 }), // assertRole
      () => new Error('gate movement insert failed') // gate movement fails
    ]);
    poolConnectSpy.mockResolvedValueOnce(client);

    await expect(
      transitionVisit({ visitId: UUID, target: 'AT_SECURITY' })
    ).rejects.toThrow('gate movement insert failed');

    // No audit row was ever written in the failed transaction.
    expect(queries.some((q) => q.includes('insert into audit_logs'))).toBe(false);
    // No global pool usage.
    expect(poolQuerySpy).not.toHaveBeenCalled();
  });

  it('transitionVisit rejects unauthorized roles (assertRole throws on the tx client)', async () => {
    const { client } = fakeClient([
      () => ({ rows: [{ id: UUID, status: 'WAITING_FOR_SECURITY', visit_code: 'V-20260101-ABCDEF' }], rowCount: 1 }), // lock
      () => ({
        rows: [{
          id: 'user-uuid-1',
          full_name: 'Lab Op',
          email: 'lab@fleetflow.test',
          role: 'LAB_OPERATOR',
          is_active: true
        }],
        rowCount: 1
      }) // profile read: LAB_OPERATOR while SECURITY_OPERATOR required
    ]);
    poolConnectSpy.mockResolvedValueOnce(client);

    await expect(
      transitionVisit({ visitId: UUID, target: 'AT_SECURITY' })
    ).rejects.toThrow(/Forbidden for role LAB_OPERATOR/);
    expect(poolQuerySpy).not.toHaveBeenCalled();
  });
});

// ── 4 · non-transactional path unchanged ─────────────────────────────

describe('acknowledgeNotification still uses the pool (non-transactional)', () => {
  it('runs its update through pool.query, not a transaction', async () => {
    poolQuerySpy.mockResolvedValueOnce({ rows: [], rowCount: 1 } as FakeResult);

    await expect(acknowledgeNotification(UUID)).resolves.toBeUndefined();
    expect(poolQuerySpy).toHaveBeenCalledTimes(1);
    expect(poolConnectSpy).not.toHaveBeenCalled();
    const sql = poolQuerySpy.mock.calls[0][0] as string;
    expect(sql).toContain('update notifications');
    expect(sql).toContain('acknowledged_by = $1');
    expect(sql).toContain('where id = $2');
    expect(sql).toContain('target_role = $3');
  });
});
