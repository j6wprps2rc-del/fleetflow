/**
 * Regression tests for BLE ingestion (Checkpoint 4).
 *
 * Behavioral tests against the REAL ingestion library with pg mocked the same
 * way as tests/transaction-safety.test.ts — pool.connect spied so no database
 * connection is ever opened. Covers:
 *   - gateway key generation: shape, uniqueness, hash relation
 *   - gateway auth: wrong key and inactive gateway both raise GatewayAuthError
 *   - unknown tag / no active visit are typed results, not errors
 *   - zone-change detection appends exactly one DEVICE_DETECTION movement row
 *     and refreshes last_detected_*
 *   - same-zone re-ping appends NO movement row (heartbeat only)
 *   - the simulated flag records SIMULATED method
 *   - malformed tag ids raise DetectionError before opening a transaction
 *   - ingestion never writes audit_logs and never updates visit status
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PoolClient } from 'pg';
import {
  ingestDetection,
  generateGatewayKey,
  hashGatewayKey,
  GatewayAuthError,
  DetectionError
} from '@/lib/ingestion';

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
  const poolConnectSpy = vi.fn(async (): Promise<PoolClient> => {
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

interface Step {
  match: RegExp;
  result: QueryResult | Error;
}

interface CapturedCall {
  sql: string;
  params: unknown[];
}

/**
 * Content-matched fake transaction client (same pattern as the
 * transaction-safety suite): responses keyed by SQL text, unmatched SQL
 * returns an empty OK.
 */
function fakeClient(steps: Step[]) {
  const calls: CapturedCall[] = [];
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

const UUID = '11111111-1111-1111-1111-111111111111';
const UUID2 = '22222222-2222-2222-2222-222222222222';

const GATEWAY_KEY = 'ff_gw_test_key_0123456789abcdef';
const GATEWAY_HASH = hashGatewayKey(GATEWAY_KEY);

const GATEWAY_ROW = {
  id: UUID,
  zone_id: UUID2,
  api_key_hash: GATEWAY_HASH,
  is_active: true,
  zone_code: 'SECURITY'
};

const ACTIVE_VISIT = {
  id: UUID,
  visit_code: 'V-20260101-ABCDEF',
  last_zone: null as string | null
};

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

// ── key generation ────────────────────────────────────────────

describe('gateway key generation', () => {
  it('produces a prefixed plaintext and its sha256 hash', () => {
    const [plaintext, hash] = generateGatewayKey();
    expect(plaintext).toMatch(/^ff_gw_[0-9a-f]{48}$/);
    expect(hash).toBe(hashGatewayKey(plaintext));
    expect(hash).toHaveLength(64);
  });

  it('produces unique keys across calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const [plaintext] = generateGatewayKey();
      seen.add(plaintext);
    }
    expect(seen.size).toBe(50);
  });

  it('stores a hash distinct from the plaintext', () => {
    const [plaintext, hash] = generateGatewayKey();
    expect(hash).not.toBe(plaintext);
  });
});

// ── gateway authentication ─────────────────────────────────────

describe('ingestDetection gateway authentication', () => {
  it('rejects an unknown key (GatewayAuthError) before any visit queries, rolls back', async () => {
    const { client, calls } = fakeClient([
      { match: /from gateways/, result: { rows: [], rowCount: 0 } }
    ]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    await expect(
      ingestDetection({ gatewayKey: 'ff_gw_wrong_key', bleTagId: 'TAG-001' })
    ).rejects.toThrow(GatewayAuthError);

    const sqls = calls.map((c) => c.sql);
    expect(sqls.some((s) => s.includes('from vehicles'))).toBe(false);
    expect(sqls.some((s) => s.includes('from vehicle_visits'))).toBe(false);
    expect(sqls.some((s) => s.includes('insert into gate_movements'))).toBe(false);
    expect(sqls[sqls.length - 1]).toBe('ROLLBACK');
  });

  it('rejects an inactive gateway even when the key hash matches', async () => {
    const { client, calls } = fakeClient([
      {
        match: /from gateways/,
        result: { rows: [{ ...GATEWAY_ROW, is_active: false }], rowCount: 1 }
      }
    ]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    await expect(
      ingestDetection({ gatewayKey: GATEWAY_KEY, bleTagId: 'TAG-001' })
    ).rejects.toThrow(GatewayAuthError);
    expect(calls.some((c) => c.sql.includes('insert into gate_movements'))).toBe(false);
  });

  it('rejects malformed tag ids before opening a transaction (DetectionError)', async () => {
    await expect(
      ingestDetection({ gatewayKey: GATEWAY_KEY, bleTagId: 'x' })
    ).rejects.toThrow(DetectionError);
    await expect(
      ingestDetection({ gatewayKey: GATEWAY_KEY, bleTagId: 'a'.repeat(65) })
    ).rejects.toThrow(DetectionError);
    // Validation happens before withTransaction — no checkout at all.
    expect(poolConnectSpy).not.toHaveBeenCalled();
  });
});

// ── typed outcomes ────────────────────────────────────────────

describe('ingestDetection typed outcomes', () => {
  it('returns unknown_tag without erroring', async () => {
    const { client, calls } = fakeClient([
      { match: /from gateways/, result: { rows: [GATEWAY_ROW], rowCount: 1 } },
      { match: /from vehicles/, result: { rows: [], rowCount: 0 } }
    ]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    const result = await ingestDetection({ gatewayKey: GATEWAY_KEY, bleTagId: 'TAG-404' });
    expect(result).toEqual({ ok: false, reason: 'unknown_tag', bleTagId: 'TAG-404' });
    expect(calls.some((c) => c.sql.includes('from vehicle_visits'))).toBe(false);
  });

  it('returns no_active_visit without erroring', async () => {
    const { client } = fakeClient([
      { match: /from gateways/, result: { rows: [GATEWAY_ROW], rowCount: 1 } },
      { match: /from vehicles/, result: { rows: [{ id: UUID }], rowCount: 1 } },
      { match: /from vehicle_visits/, result: { rows: [], rowCount: 0 } }
    ]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    const result = await ingestDetection({ gatewayKey: GATEWAY_KEY, bleTagId: 'TAG-001' });
    expect(result).toEqual({ ok: false, reason: 'no_active_visit', vehicleId: UUID });
  });
});

// ── movement recording ────────────────────────────────────────

describe('ingestDetection movement recording', () => {
  it('zone change appends exactly one DEVICE_DETECTION movement and refreshes last_detected', async () => {
    const { client, calls } = fakeClient([
      { match: /from gateways/, result: { rows: [GATEWAY_ROW], rowCount: 1 } },
      { match: /from vehicles/, result: { rows: [{ id: UUID }], rowCount: 1 } },
      {
        match: /from vehicle_visits/,
        result: { rows: [ACTIVE_VISIT], rowCount: 1 }
      }
    ]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    const result = await ingestDetection({ gatewayKey: GATEWAY_KEY, bleTagId: 'TAG-001' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.moved).toBe(true);
      expect(result.zoneCode).toBe('SECURITY');
      expect(result.simulated).toBe(false);
      expect(result.visitCode).toBe('V-20260101-ABCDEF');
    }

    const sqls = calls.map((c) => c.sql);
    expect(sqls.filter((s) => s.includes('insert into gate_movements')).length).toBe(1);

    const movement = calls.find((c) => c.sql.includes('insert into gate_movements'));
    expect(movement?.params[2]).toBe('DEVICE_DETECTION');

    // last_detected_ fields are refreshed; status and audit_logs are never touched.
    expect(sqls.some((s) => s.includes('last_detected_zone_id = $2'))).toBe(true);
    expect(sqls.some((s) => s.includes('insert into audit_logs'))).toBe(false);
    const statusUpdate = calls.find(
      (c) => c.sql.includes('update vehicle_visits') && c.sql.includes('status')
    );
    expect(statusUpdate).toBeUndefined();
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
  });

  it('same-zone re-ping appends NO movement row (heartbeat only)', async () => {
    const { client, calls } = fakeClient([
      { match: /from gateways/, result: { rows: [GATEWAY_ROW], rowCount: 1 } },
      { match: /from vehicles/, result: { rows: [{ id: UUID }], rowCount: 1 } },
      {
        match: /from vehicle_visits/,
        result: {
          rows: [{ ...ACTIVE_VISIT, last_zone: UUID2 }], // same zone as the gateway
          rowCount: 1
        }
      }
    ]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    const result = await ingestDetection({ gatewayKey: GATEWAY_KEY, bleTagId: 'TAG-001' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.moved).toBe(false);

    const sqls = calls.map((c) => c.sql);
    expect(sqls.some((s) => s.includes('insert into gate_movements'))).toBe(false);
    expect(sqls.some((s) => s.includes('last_detected_zone_id = $2'))).toBe(true);
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
  });

  it('records SIMULATED method when the simulated flag is set', async () => {
    const { client, calls } = fakeClient([
      { match: /from gateways/, result: { rows: [GATEWAY_ROW], rowCount: 1 } },
      { match: /from vehicles/, result: { rows: [{ id: UUID }], rowCount: 1 } },
      {
        match: /from vehicle_visits/,
        result: { rows: [ACTIVE_VISIT], rowCount: 1 }
      }
    ]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    const result = await ingestDetection({
      gatewayKey: GATEWAY_KEY,
      bleTagId: 'TAG-001',
      simulated: true
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.simulated).toBe(true);

    const movement = calls.find((c) => c.sql.includes('insert into gate_movements'));
    expect(movement?.params[2]).toBe('SIMULATED');
  });
});
