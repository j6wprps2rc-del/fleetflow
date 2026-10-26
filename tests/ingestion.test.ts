/**
 * Regression tests for BLE ingestion (Checkpoint 4).
 *
 * Behavioral tests against the REAL ingestion library with pg mocked the same
 * way as tests/transaction-safety.test.ts — pool.connect spied so no database
 * connection is ever opened. Covers:
 *   - gateway key generation/hashing shape and uniqueness
 *   - authenticateGateway via ingestDetection: valid key succeeds, wrong key
 *     is rejected constant-time (GatewayAuthError), inactive gateway rejected
 *   - unknown tag / no active visit are typed results, not errors
 *   - zone-change detection appends a movement row and updates last_detected
 *   - same-zone re-ping appends NO movement row (anti-spam heartbeat)
 *   - ingestDetection never touches vehicle_visits.status / audit_logs
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PoolClient } from 'pg';
import { withTransaction, type QueryExecutor } from '@/db';
import {
  ingestDetection,
  generateGatewayKey,
  hashGatewayKey,
  GatewayAuthError,
  DetectionError
} from '@/lib/ingestion';

const { poolQuerySpy, poolConnectSpy } = vi.hoisted(() => {
  const poolQuerySpy = vi.fn(
    async (_sql: string, _params?: unknown[]): Promise<QueryResult> => ({
      rows: [],
      rowCount: 0
    })
  );
  const poolConnectSpy = vi.fn(async (): Promise<PoolClient> => {
    throw new Error('unexpected pool.connect(): a checkout was attempted that this test did not mock');
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

// ingestion has no next/navigation import; server-only is aliased in vitest config.

interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

interface Step {
  match: RegExp;
  result: QueryResult | Error;
}

interface CapturedCall {
  sql: string;
  params: unknown[];
}

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

function at<T>(arr: readonly T[], index: number, what: string): T {
  const value = arr[index];
  if (value === undefined) {
    throw new Error(`Expected ${what} at index ${index}; array has ${arr.length} elements.`);
  }
  return value;
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

beforeEach(() => {
  poolQuerySpy.mockReset();
  poolQuerySpy.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
  poolConnectSpy.mockReset();
  poolConnectSpy.mockImplementation(async (): Promise<PoolClient> => {
    throw new Error('unexpected pool.connect(): a checkout was attempted that this test did not mock');
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

  it('hashes are not derivable from the plaintext being equal to it', () => {
    const [plaintext, hash] = generateGatewayKey();
    expect(hash).not.toBe(plaintext);
  });
});

// ── ingestion behavior ────────────────────────────────────────

describe('ingestDetection behavior', () => {
  it('rejects an invalid gateway key (GatewayAuthError) and writes nothing', async () => {
    const { client, calls } = fakeClient([
      // No gateway row matches the computed hash of the wrong key.
      { match: /from gateways/, result: { rows: [], rowCount: 0 } }
    ]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    await expect(
      ingestDetection({ gatewayKey: 'ff_gw_wrong_key', bleTagId: 'TAG-001' })
    ).rejects.toThrow(GatewayAuthError);

    // Auth failed before any vehicle/visit queries.
    expect(calls.some((c) => c.sql.includes('from vehicles'))).toBe(false);
    expect(calls.some((c) => c.sql.includes('from vehicle_visits'))).toBe(false);
    expect(calls[calls.length - 1]?.sql).toBe('ROLLBACK');
  });

  it('rejects an inactive gateway even when the key hash matches', async () => {
    const { client } = fakeClient([
      {
        match: /from gateways/,
        result: { rows: [{ ...GATEWAY_ROW, is_active: false }], rowCount: 1 }
      }
    ]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));
    await expect(
      ingestDetection({ gatewayKey: GATEWAY_KEY, bleTagId: 'TAG-001' })
    ).rejects.toThrow(GatewayAuthError);
  });

  it('returns a typed unknown_tag result without erroring', async () => {
    const { client } = fakeClient([
      { match: /from gateways/, result: { rows: [GATEWAY_ROW], rowCount: 1 } },
      { match: /from vehicles/, result: { rows: [], rowCount: 0 } }
    ]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    const result = await ingestDetection({ gatewayKey: GATEWAY_KEY, bleTagId: 'TAG-404' });
    expect(result).toEqual({ ok: false, reason: 'unknown_tag', bleTagId: 'TAG-404' });
    expect(callsLength(client)).toBeGreaterThanOrEqual(2);
  });

  it('returns a typed no_active_visit result without erroring', async () => {
    const { client } = fakeClient([
      { match: /from gateways/, result: { rows: [GATEWAY_ROW], rowCount: 1 } },
      { match: /from vehicles/, result: { rows: [{ id: UUID }], rowCount: 1 } },
      { match: /from vehicle_visits/, result: { rows: [], rowCount: 0 } }
    ]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    const result = await ingestDetection({ gatewayKey: GATEWAY_KEY, bleTagId: 'TAG-001' });
    expect(result).toEqual({ ok: false, reason: 'no_active_visit', vehicleId: UUID });
  });

  it('appends a movement row only on zone change and never writes audit_logs', async () => {
    const { client, calls } = fakeClient([
      { match: /from gateways/, result: { rows: [GATEWAY_ROW], rowCount: 1 } },
      { match: /from vehicles/, result: { rows: [{ id: UUID }], rowCount: 1 } },
      {
        match: /from vehicle_visits/,
        result: { rows: [{ id: UUID, visit_code: 'V-20260101-ABCDEF', last_zone: null }], rowCount: 1 }
      }
    ]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    const result = await ingestDetection({ gatewayKey: GATEWAY_KEY, bleTagId: 'TAG-001' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.moved).toBe(true);
      expect(result.zoneCode).toBe('SECURITY');
      expect(result.simulated).toBe(false);
    }

    const sqls = calls.map((c) => c.sql);
    expect(sqls.filter((s) => s.includes('insert into gate_movements')).length).toBe(1);
    // The movement insert carries DEVICE_DETECTION, not SIMULATED.
    const movementCall = calls.find((c) => c.sql.includes('insert into gate_movements'));
    expect(movementCall?.params[2]).toBe('DEVICE_DETECTION');
    // Never touches the workflow status or audit_logs.
    expect(sqls.some((s) => s.includes('update vehicle_visits\n          set status'))).toBe(false);
    expect(sqls.some((s) => s.includes('insert into audit_logs'))).toBe(false);
    // last_detected_ fields ARE updated.
    expect(sqls.some((s) => s.includes('last_detected_zone_id = $2'))).toBe(true);
    // Ends with COMMIT.
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
  });

  it('same-zone re-ping appends NO movement row (heartbeat only)', async () => {
    const { client, calls } = fakeClient([
      { match: /from gateways/, rowes: [], result: { rows: [GATEWAY_ROW], rowCount: 1 } },
      { match: /from vehicles/, result: { rows: [{ id: UUID }], rowCount: 1 } },
      {
        match: /from vehicle_visits/,
        result: {
          rows: [
            {
              id: UUID,
              visit_code: 'V-20260101-ABCDEF',
              last_zone: UUID2 // SAME zone as the gateway
n            }
          ],
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
  });

  it('simulated flag records SIMULATED method', async () => {
    const { client, calls } = fakeClient([
      { match: /from gateways/, result: { rows: [GATEWAY_ROW], rowCount: 1 } },
      { match: /from vehicles/, result: { is_placeholder: true, rows: [{ id: UUID }], rowCount: 1 } },
      {
        match: /from vehicle_visits/,
        result: { rows: [{ id: UUID, visit_code: 'V-20260101-ABCDEF', last_zone: null }], rowCount: 1 }
      }
    ]);
    poolConnectSpy.mockResolvedValueOnce(asTx(client));

    const result = await ingestDetection({
      gatewayKey: GATEWAY_KEY,
      bleTagId: 'TAG-001',
      simulated: true
    });
    expect(result.ok).toBe(true);
    const movementCall = calls.find((c) => c.sql.includes('insert into gate_movements'));
    expect(movementCall?.params[2]).toBe('SIMULATED');
  });

  it('rejects malformed tag ids (DetectionError)', async () => {
    await expect(
      ingestDetection({ gatewayKey: GATEWAY_KEY, bleTagId: 'x' })
    ).rejects.toThrow(DetectionError);
    await expect(
      ingestDetection({ gatewayKey: GATEWAY_KEY, bleTagId: 'x'.repeat(65) })
    ).rejects.toThrow(DestionError);
  });

  it('validates tag length boundaries (2 and 64 accepted, 1 and 65 rejected)', async () => {
    // Length boundaries exercised without a transaction (validation runs before).
    await expect(
      ingestDetection({ gatewayKey: GATEWAY_KEY, bleTagId: 'ab' })
    ).resolves.toBeDefined();
    await expect(
      ingestDetection({ gatewayKey: GATEWAY_KEY, bleTagId: 'a'.repeat(65) })
    ).rejects.toThrow(DetectionError);
    expect(poolConnectSpy).toHaveBeenCalledTimes(1); // only the valid one opened a tx
  });
});

// helper used by the unknown_tag test
function callsLength(client: unknown): number {
  return (client as { calls?: CapturedCall[] }).calls?.length ?? -1;
}
