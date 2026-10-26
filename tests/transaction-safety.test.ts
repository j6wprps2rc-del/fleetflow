/**
 * Behavior-focused regression tests for the pool-starvation fix (Option B).
 *
 * These import the REAL production modules — src/db, src/lib/auth, src/lib/audit,
 * src/lib/visits — and drive them with scripted fake clients, with pool.connect
 * spied so no database connection is ever opened. This proves:
 *   1. withTransaction checks out exactly one connection (the Vercel max=1
 *      deadlock cannot recur) and ROLLBACK/release failures never mask the
 *      original error.
 *   2. assertRole/audit/registerVisit/transitionVisit use the transaction
 *      client for their DB work — never the global pool — inside transactions.
 *   3. transitionVisit writes a TRANSITION_VISIT audit entry in the same
 *      transaction, and everything (incl. the audit row) rolls back on failure.
 *   4. Non-transactional paths (acknowledgeNotification) still use the pool.
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

const { poolQuerySpy, poolConnectSpy } = vi.hoisted(() => ({
  poolQuerySpy: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  poolConnectSpy: vi.fn()
}));

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

/** Row shape returned by our scripted clients. */
interface FakeResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

interface FakeClient {
  query: (sql: string, params?: unknown[]) => Promise<FakeResult>;
  release: () => void;
}

function fakeClient(
  script: Array<(sql: string, params?: unknown[]) => FakeResult | Error>
) {
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

const asTx = (c: FakeClient) => c as unknown as PoolClient;
const asExec = (c: FakeClient) => c as unknown as QueryExecutor;

const UUID = '11111111-1111-1111-1111-111111111111';
const OK: FakeResult = { rows: [], rowCount: 0 };

const SECURITY_PROFILE = {
  id: 'user-uuid-1',
  full_name: 'Sec Op',
  email: 'sec@fleetflow.test',
  role: 'SECURITY_OPERATOR',
  is_active: true
};

beforeEach(() => {
  poolQuerySpy.mockClear();
  poolConnectSpy.mockClear();
  poolQuerySpy.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
});

// ── 1 · withTransaction ────────────────────────────────────────────

describe('withTransaction hardening', () => {
  it('runs the body on the checked-out client and never touches the global pool', async () => {
    const { client, queries } = fakeClient([() => OK]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    let sawClient = false;
    const result = await withTransaction(async (tx) => {
      sawClient = tx === asTx(client);
      await tx.query('select 1');
      return 'done';
    });

    expect(result).toBe('done');
    expect(sawClient).toBe(true);
    expect(queries).toEqual(['BEGIN', 'select 1', 'COMMIT']);
    expect(poolQuerySpy).not.toHaveBeenCalled();
    expect(poolConnectSpy).toHaveBeenCalledTimes(1);
  });

  it('propagates the ORIGINAL error when the body throws — even if ROLLBACK also fails', async () => {
    const original = new Error('original business error');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { client } = fakeClient([() => new Error('rollback also fails')]);
      poolConnectSpy.mockResolvedValueOnce(asTx(client));

      await expect(
        withTransaction(async () => {
          throw original;
        })
      ).rejects.toThrow('original business error');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('releases the client when the body succeeds', async () => {
    const { client } = fakeClient([() => OK]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    await withTransaction(async () => 'ok');

    expect(client.release).toHaveBeenCalled();
    expect(poolQuerySpy).not.toHaveBeenCalled();
  });

  it('releases the client even when the body throws', async () => {
    const { client } = fakeClient([() => OK, () => OK]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    await expect(
      withTransaction(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(client.release).toHaveBeenCalled();
  });
});

// ── 2 · transaction-client propagation (Option B) ─────────────────

describe('transaction-client propagation', () => {
  it('assertRole uses the provided client, not the global pool', async () => {
    const { client, queries } = fakeClient([
      () => ({ rows: [{ ...SECURITY_PROFILE, role: 'PARKING_OPERATOR' }], rowCount: 1 })
    ]);

    const { profile } = await assertRole(['PARKING_OPERATOR'], asExec(client));

    expect(profile.role).toBe('PARKING_OPERATOR');
    expect(poolQuerySpy).not.toHaveBeenCalled();
    expect(queries.length).toBe(1);
    expect(queries[0]).toContain('from profiles');
  });

  it('assertRole without a client still works via the pool (standalone calls)', async () => {
    poolQuerySpy.mockResolvedValueOnce({
      rows: [{ ...SECURITY_PROFILE, role: 'PARKING_OPERATOR' }],
      rowCount: 1
    } as FakeResult);

    const { profile } = await assertRole(['PARKING_OPERATOR']);
    expect(profile.role).toBe('PARKING_OPERATOR');
    expect(poolQuerySpy).toHaveBeenCalledTimes(1);
  });

  it('audit uses the provided client when given, pool otherwise', async () => {
    const { client, queries } = fakeClient([() => OK]);

    await audit('u1', 'TEST_ACT', 't', 'x', { a: 1 }, asExec(client));
    expect(queries.length).toBe(1);
    expect(queries[0]).toContain('insert into audit_logs');
    expect(poolQuerySpy).not.toHaveBeenCalled();

    await audit('u1', 'TEST_ACT', 't', 'x', { a: 1 });
    expect(poolQuerySpy).toHaveBeenCalledTimes(1);
  });

  it('audit failures are non-fatal (logged, not thrown) on both paths', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { client } = fakeClient([() => new Error('audit insert failed')]);
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

describe('registerVisit & transitionVisit connection behavior', () => {
  it('registerVisit performs ALL its DB work on the transaction client', async () => {
    const { client, queries } = fakeClient([
      () => OK, // company exists check
      () => OK, // vehicle upsert
      () => OK, // idempotency fast-path select (empty → proceed)
      () => ({ rows: [{ id: UUID, visit_code: 'V-20260101-ABCDEF' }], rowCount: 1 }), // visit insert
      () => OK // audit insert
    ]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    const result = await registerVisit(
      { plate: 'ABC 1234', companyId: UUID, idempotencyKey: 'key-12345678' },
      { userId: 'user-uuid-1', role: 'PARKING_OPERATOR' }
    );

    expect(result.ok).toBe(true);
    expect(poolQuerySpy).not.toHaveBeenCalled();
    expect(poolConnectSpy).toHaveBeenCalledTimes(1);
    // Audit row rode the same connection (before COMMIT).
    const auditIdx = queries.findIndex((q) => q.includes('insert into audit_logs'));
    expect(auditIdx).toBeGreaterThan(-1);
    expect(queries[queries.length - 1]).toBe('COMMIT');
  });

  it('registerVisit resolves a same-key retry to the original visit (idempotent)', async () => {
    const { client } = fakeClient([
      () => OK, // company
      () => OK, // vehicle
      () => ({
        rows: [{ id: UUID, visit_code: 'V-20260101-ABCDEF', company_id: UUID, vehicle_id: UUID }],
        rowCount: 1
      }) // idempotency fast-path finds the original
    ]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    const result = await registerVisit(
      { plate: 'ABC 1234', companyId: UUID, idempotencyKey: 'key-12345678' },
      { userId: 'user-uuid-1', role: 'PARKING_OPERATOR' }
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.visitId).toBe(UUID);
    expect(poolQuerySpy).not.toHaveBeenCalled();
  });

  it('transitionVisit authorizes on the tx client and writes TRANSITION_VISIT audit in-transaction', async () => {
    const { client, queries } = fakeClient([
      () => ({ rows: [{ id: UUID, status: 'WAITING_FOR_SECURITY', visit_code: 'V-20260101-ABCDEF' }], rowCount: 1 }), // lock
      () => ({ rows: [SECURITY_PROFILE], rowCount: 1 }), // assertRole profile read
      () => OK, // gate movement insert
      () => OK, // status update
      () => OK, // notification insert
      () => OK // audit insert
    ]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    const result = await transitionVisit({ visitId: UUID, target: 'AT_SECURITY' });

    expect(result.to).toBe('AT_SECURITY');
    expect(result.from).toBe('WAITING_FOR_SECURITY');
    expect(poolQuerySpy).not.toHaveBeenCalled();
    expect(poolConnectSpy).toHaveBeenCalledTimes(1);

    const auditIdx = queries.findIndex((q) => q.includes('insert into audit_logs'));
    expect(auditIdx).toBeGreaterThan(-1);
    expect(queries[auditIdx + 1]).toBe('COMMIT'); // audit committed WITH the txn
  });

  it('transitionVisit rolls back everything (incl. the audit row) when a step fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { client, queries } = fakeClient([
        () => ({ rows: [{ id: UUID, status: 'WAITING_FOR_SECURITY', visit_code: 'V-20260101-ABCDEF' }], rowCount: 1 }), // lock
        () => ({ rows: [SECURITY_PROFILE], rowCount: 1 }), // assertRole
        () => new Error('gate movement insert failed') // gate movement fails
      ]);
      poolConnectSpy.mockResolvedValueOnce(asTx(client));

      await expect(
        transitionVisit({ visitId: UUID, target: 'AT_SECURITY' })
      ).rejects.toThrow('gate movement insert failed');

      expect(queries.some((q) => q.includes('insert into audit_logs'))).toBe(false);
      expect(poolQuerySpy).not.toHaveBeenCalled();
      expect(queries[queries.length - 1]).toBe('ROLLBACK');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('transitionVisit rejects unauthorized roles (assertRole throws on the tx client)', async () => {
    const { client } = fakeClient([
      () => ({ rows: [{ id: UUID, status: 'WAITING_FOR_SECURITY', visit_code: 'V-20260101-ABCDEF' }], rowCount: 1 }), // lock
      () => ({
        rows: [{ ...SECURITY_PROFILE, role: 'LAB_OPERATOR' }],
        rowCount: 1
      }) // profile read: LAB_OPERATOR while SECURITY_OPERATOR required
    ]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    await expect(
      transitionVisit({ visitId: UUID, target: 'AT_SECURITY' })
    ).rejects.toThrow(/Forbidden for role LAB_OPERATOR/);
    expect(poolQuerySpy).not.toHaveBeenCalled();
  });
});

// ── 4 · non-transactional path unchanged ───────────────────────────

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
