/**
 * BLE device ingestion — server-side ingestion library for fixed BLE receivers
 * ("gateways") mounted in zones.
 *
 * SECURITY MODEL
 * - Gateways authenticate with a per-gateway API key. Only a SHA-256 hash of
 *   the key is stored; the plaintext is shown once at creation/rotation.
 * - The submitted key is hashed, the stored hash is looked up, and the two
 *   hex digests are compared with timingSafeEqual — constant-time, so
 *   lookups cannot leak timing information.
 * - Ingestion NEVER advances the employee-confirmed workflow. A device
 *   detection only appends to gate_movements (method DEVICE_DETECTION) and
 *   updates the visit's last_detected_* fields. The workflow status is
 *   changed exclusively by authorized employees via transitionVisit.
 * - All writes run inside ONE withTransaction call; the transaction client
 *   is used for every query (pool-starvation discipline preserved).
 *
 * MOVEMENT RECORDING RULE (anti-spam):
 * - First detection or a zone CHANGE appends a gate_movements row
 *   (direction ENTRY into the detected zone — a single receiver ping cannot
 *   reliably infer a physical EXIT, so devices never record EXIT; exits are
 *   recorded by manual workflow transitions).
 * - Repeated same-zone pings only refresh last_detected_at (heartbeat),
 *   keeping the append-only history free of noise.
 *
 * HONESTY LABEL: simulator detections use method = 'SIMULATED' and are
 * labeled as simulated everywhere they are displayed. No real BLE hardware
 * is claimed by this repository.
 */
import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';
import { withTransaction, pool, type QueryExecutor } from '@/db';
import { audit } from '@/lib/audit';

export interface GatewayRow {
  id: string;
  label: string;
  zoneCode: string;
  zoneName: string;
  isActive: boolean;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface DetectionInput {
  gatewayKey: string;
  bleTagId: string;
  occurredAt?: string;
  /** Simulator flag: records method='SIMULATED' instead of DEVICE_DETECTION. */
  simulated?: boolean;
}

export class GatewayAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayAuthError';
  }
}

export class DetectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DetectionError';
  }
}

// ── key handling ──────────────────────────────────────────────

const KEY_PREFIX = 'ff_gw_';
const KEY_RANDOM_BYTES = 24;

/** Generates a new gateway key. Returns [plaintext (shown once), sha256 hash]. */
export function generateGatewayKey(): [string, string] {
  const bytes = new Uint8Array(KEY_RANDOM_BYTES);
  crypto.getRandomValues(bytes);
  const body = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const plaintext = `${KEY_PREFIX}${body}`;
  return [plaintext, hashGatewayKey(plaintext)];
}

export function hashGatewayKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/** Constant-time comparison of two equal-length strings. */
function digestsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

// ── gateway registry (server actions call these after assertRole) ──

export async function listGateways(): Promise<GatewayRow[]> {
  const result = await pool.query(
    `select g.id::text as id, g.label, z.code::text as zone_code, z.name as zone_name,
            g.is_active, g.last_seen_at, g.created_at
       from gateways g
       join zones z on z.id = g.zone_id
      order by z.display_order, g.label`
  );
  return result.rows as GatewayRow[];
}

export async function createGateway(
  actorId: string,
  input: { label: string; zoneCode: string }
): Promise<{ gatewayId: string; plaintextKey: string }> {
  const label = input.label?.trim();
  const zoneCode = input.zoneCode?.trim().toUpperCase();
  if (!label || label.length < 3 || label.length > 80) {
    throw new Error('Label must be between 3 and 80 characters.');
  }
  const validZones = ['PARKING', 'SECURITY', 'LABORATORY'];
  if (!validZones.includes(zoneCode)) {
    throw new Error('Zone must be PARKING, SECURITY, or LABORATORY.');
  }

  const [plaintext, hash] = generateGatewayKey();

  return withTransaction(async (client) => {
    const zone = await client.query(
      'select id::text as id from zones where code = $1::zone_kind',
      [zoneCode]
    );
    if (zone.rowCount === 0) throw new Error('Zone not found.');
    const zoneId = (zone.rows[0] as { id: string }).id;

    let gatewayId: string;
    try {
      const res = await client.query(
        `insert into gateways (label, zone_id, api_key_hash)
         values ($1, $2, $3)
         returning id::text as id`,
        [label, zoneId, hash]
      );
      gatewayId = (res.rows[0] as { id: string }).id;
    } catch (err) {
      const pgErr = err as { code?: string };
      if (pgErr?.code === '23505') {
        throw new Error('A gateway with this label already exists.');
      }
      throw err;
    }

    await audit(
      actorId,
      'CREATE_GATEWAY',
      'gateways',
      gatewayId,
      { label, zoneCode },
      client
    );

    return { gatewayId, plaintextKey: plaintext };
  });
}

export async function rotateGatewayKey(
  actorId: string,
  gatewayId: string
): Promise<{ plaintextKey: string }> {
  const [plaintext, hash] = generateGatewayKey();

  return withTransaction(async (client) => {
    const updated = await client.query(
      `update gateways set api_key_hash = $2 where id = $1
       returning id::text as id`,
      [gatewayId, hash]
    );
    if (updated.rowCount === 0) throw new Error('Gateway not found.');

    await audit(actorId, 'ROTATE_GATEWAY_KEY', 'gateways', gatewayId, {}, client);
    return { plaintextKey: plaintext };
  });
}

export async function setGatewayActive(
  actorId: string,
  gatewayId: string,
  isActive: boolean
): Promise<void> {
  return withTransaction(async (client) => {
    const updated = await client.query(
      'update gateways set is_active = $2 where id = $1 returning id::text as id',
      [gatewayId, isActive]
    );
    if (updated.rowCount === 0) throw new Error('Gateway not found.');

    await audit(
      actorId,
      isActive ? 'ACTIVATE_GATEWAY' : 'DEACTIVATE_GATEWAY',
      'gateways',
      gatewayId,
      {},
      client
    );
  });
}

// ── ingestion ─────────────────────────────────────────────────

interface AuthenticatedGateway {
  id: string;
  zoneId: string;
  zoneCode: string;
}

/**
 * Authenticates a gateway by its key on the given connection. Looks up the
 * SHA-256 hash row, then compares the stored hash with the computed hash in
 * constant time. Inactive or unknown keys are rejected identically.
 */
async function authenticateGateway(
  client: QueryExecutor,
  gatewayKey: string
): Promise<AuthenticatedGateway> {
  const computedHash = hashGatewayKey(gatewayKey ?? '');
  const result = await client.query(
    `select g.id::text as id, g.zone_id::text as zone_id, g.api_key_hash,
            g.is_active, z.code::text as zone_code
       from gateways g
       join zones z on z.id = g.zone_id
      where g.api_key_hash = $1`,
    [computedHash]
  );
  const row = result.rows[0] as
    | { id: string; zone_id: string; api_key_hash: string; is_active: boolean; zone_code: string }
    | undefined;
  if (!row || !row.is_active || !digestsMatch(computedHash, row.api_key_hash)) {
    throw new GatewayAuthError('Invalid or inactive gateway key.');
  }
  return { id: row.id, zoneId: row.zone_id, zoneCode: row.zone_code };
}

export type IngestResult =
  | {
      ok: true;
      visitId: string;
      visitCode: string;
      zoneCode: string;
      moved: boolean;
      simulated: boolean;
    }
  | { ok: false; reason: 'unknown_tag'; bleTagId: string }
  | { ok: false; reason: 'no_active_visit'; vehicleId: string };

/**
 * Ingests one BLE tag detection from a gateway, against the ACTIVE visit of
 * the vehicle bound to that tag (if any).
 *
 * - Unknown tag or no active visit: typed results, not errors — a yard
 *   legitimately contains unvisited vehicles.
 * - Zone change / first detection: appends a DEVICE_DETECTION (or SIMULATED)
 *   movement row + updates last_detected_*.
 * - Same-zone re-ping: refreshes last_detected_at only (heartbeat, no new
 *   history row).
 * - The workflow status is NEVER touched; audit_logs is not written for
 *   machine detections — gate_movements IS the append-only record for
 *   detections (audit_logs covers human/privileged actions).
 * - All work happens in ONE withTransaction; every query uses `client`.
 */
export async function ingestDetection(input: DetectionInput): Promise<IngestResult> {
  const tag = input.bleTagId?.trim();
  if (!tag || tag.length < 2 || tag.length > 64) {
    throw new DetectionError('bleTagId must be between 2 and 64 characters.');
  }

  return withTransaction(async (client) => {
    // 1 · Authenticate the gateway (constant-time hash comparison).
    const gateway = await authenticateGateway(client, input.gatewayKey);

    // 2 · Liveness heartbeat.
    await client.query('update gateways set last_seen_at = now() where id = $1', [
      gateway.id
    ]);

    // 3 · Resolve the tag to a vehicle.
    const vehicle = await client.query(
      'select id::text as id from vehicles where ble_tag_id = $1',
      [tag]
    );
    const vehicleRow = vehicle.rows[0] as { id: string } | undefined;
    if (!vehicleRow) {
      return { ok: false as const, reason: 'unknown_tag' as const, bleTagId: tag };
    }

    // 4 · Lock the vehicle's ACTIVE visit (FOR UPDATE serializes concurrent
    //    detections and transitions on the same visit row).
    const visit = await client.query(
      `select id::text as id, visit_code,
              last_detected_zone_id::text as last_zone
         from vehicle_visits
        where vehicle_id = $1
          and status not in ('COMPLETED', 'REJECTED', 'CANCELLED')
        order by created_at desc
        limit 1
        for update`,
      [vehicleRow.id]
    );
    const visitRow = visit.rows[0] as
      | { id: string; visit_code: string; last_zone: string | null }
      | undefined;
    if (!visitRow) {
      return {
        ok: false as const,
        reason: 'no_active_visit' as const,
        vehicleId: vehicleRow.id
      };
    }

    const zoneChanged = visitRow.last_zone !== gateway.zoneId;
    if (zoneChanged) {
      // First detection or zone change → append the movement row (ENTRY only;
      // a single receiver cannot infer a physical EXIT — exits come from the
      // manual workflow transitions).
      await client.query(
        `insert into gate_movements (visit_id, zone_id, direction, method, occurred_at)
         values ($1, $2, 'ENTRY', $3, $4)`,
        [
          visitRow.id,
          gateway.zoneId,
          input.simulated ? 'SIMULATED' : 'DEVICE_DETECTION',
          input.occurredAt ? new Date(input.occurredAt) : new Date()
        ]
      );
    }

    // 5 · Always refresh the last-detection fields (heartbeat on re-pings).
    await client.query(
      `update vehicle_visits
          set last_detected_zone_id = $2,
              last_detected_at = now()
        where id = $1`,
      [visitRow.id, gateway.zoneId]
    );

    return {
      ok: true as const,
      visitId: visitRow.id,
      visitCode: visitRow.visit_code,
      zoneCode: gateway.zoneCode,
      moved: zoneChanged,
      simulated: input.simulated === true
    };
  });
}
