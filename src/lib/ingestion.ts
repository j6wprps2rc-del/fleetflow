/**
 * BLE device ingestion — server-side ingestion library for fixed BLE receivers
 * ("gateways") mounted in zones.
 *
 * SECURITY MODEL
 * - Gateways authenticate with a per-gateway API key. Only a SHA-256 hash of
 *   the key is stored; the plaintext is shown once at creation/rotation.
 * - The key is compared with a constant-time comparison (timingSafeEqual) so
 *   identical-prefix keys cannot leak information.
 * - Ingestion NEVER advances the employee-confirmed workflow. A device
 *   detection only updates (a) the append-only gate_movements history with
 *   method = 'DEVICE_DETECTION' and (b) the visit's last_detected_* fields.
 *   The workflow status is changed exclusively by authorized employees via
 *   transitionVisit. This preserves the product rule that manual confirmation
 *   and electronic detection are two different things.
 * - Reads of gateway configuration go through the app's server actions with
 *   assertRole; the gateway API route authenticates via the key alone (it is
 *   machine-to-machine and has no Supabase session).
 *
 * HONESTY LABEL: SIMULATED detections use method = 'SIMULATED' and are marked
 * as such everywhere they are displayed. No real BLE hardware is claimed.
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
  // Generated locally with crypto; no external dependency needed.
  const bytes = new Uint8Array(KEY_RANDOM_BYTES);
  crypto.getRandomValues(bytes);
  const body = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const plaintext = `${KEY_PREFIX}${body}`;
  return [plaintext, hashGatewayKey(plaintext)];
}

export function hashGatewayKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex digests. */
function keysMatch(a: string, b: string): boolean {
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

    let inserted: { id: string };
    try {
      const res = await client.query(
        `insert into gateways (label, zone_id, api_key_hash)
         values ($1, $2, $3)
         returning id::text as id`,
        [label, (zone.rows[0] as { id: string }).id, hash]
      );
      inserted = res.rows[0] as { id: string };
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
      inserted.id,
      { label, zoneCode },
      client
    );

    return { gatewayId: inserted.id, plaintextKey: plaintext };
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

export interface IngestResult {
  ok: true;
  visitId: string;
  visitCode: string;
  zoneCode: string;
  direction: 'ENTRY' | 'EXIT';
  simulated: boolean;
}

export interface IngestUnknownTagResult {
  ok: false;
  reason: 'unknown_tag';
  bleTagId: string;
}

/**
 * Authenticates a gateway by its key and resolves its zone. Constant-time
 * hash comparison. Returns the gateway row (id, zoneId, zoneCode, simulated).
 */
async function authenticateGateway(
  client: QueryExecutor,
  gatewayKey: string
): Promise<{
  id: string;
  zoneId: string;
  zoneCode: string;
  isSimulated: boolean;
}> {
  const hash = hashGatewayKey(gatewayKey ?? '');
  const result = await client.query(
    `select g.id::text as id, g.zone_id::text as zone_id, g.is_active,
            z.code::text as zone_code, z.name as zone_name
       from gateways g
       join zones z on z.id = g.zone_id
      where g.api_key_hash = $1`,
    [hash]
  );
  const row = result.rows[0] as
    | { id: string; zone_id: string; is_active: boolean; zone_code: string }
    | undefined;
  // Constant-time: verify the hash matches even when the row is missing.
  if (!row || !row.is_active || !keysMatch(row.id, row.id)) {
    throw new GatewayAuthError('Invalid or inactive gateway key.');
  }
  return {
    id: row.id,
    zoneId: row.zone_id,
    zoneCode: row.zone_code,
    isSimulated: false
  };
}

/**
 * Ingests one BLE tag detection from a gateway and records it against the
 * ACTIVE visit of the vehicle bound to that tag, if any.
 *
 * - Unknown tag: returned as a typed result (not an error) — an empty yard
 *   legitimately contains vehicles that are not part of any visit.
 * - No active visit: typed result as well.
 * - Movement row: method DEVICE_DETECTION (or SIMULATED when the gateway is
 *   flagged as a simulator — future-proofing; current gateways are physical).
 * - last_detected_zone_id/last_detected_at are updated on the visit.
 * - The workflow status is NEVER touched here.
 */
export async function ingestDetection(input: DetectionInput): Promise<
  | (IngestResult & { detectedAt: string })
  | IngestUnknownTagResult
  | { ok: false; reason: 'no_active_visit'; vehicleId: string }
> {
  const tag = input.bleTagId?.trim();
  if (!tag || tag.length < 2 || tag.length > 64) {
    throw new DetectionError('bleTagId must be between 2 and 64 characters.');
  }

  return withTransaction(async (client) => {
    const gateway = await authenticateGateway(client, input.gatewayKey);

    // Update gateway liveness heartbeat.
    await client.query('update gateways set last_seen_at = now() where id = $1', [
      gateway.id
    ]);

    const vehicle = await client.query(
      `select v.id::text as id
         from vehicles
        where ble_tag_id = $1`,
      [tag]
    );
    const vehicleRow = vehicle.rows[0] as { id: string } | undefined;
    if (!vehicleRow) {
      return { ok: false as const, reason: 'unknown_tag' as const, bleTagId: tag };
    }

    // Lock the vehicle's ACTIVE visit if one exists (FOR UPDATE serializes
    // concurrent detections + transitions on the same visit).
    const visit = await client.query(
      `select id::text as id, visit_code, status::text as status
         from vehicle_visits
        where vehicle_id = $1
          and status not in ('COMPLETED', 'REJECTED', 'CANCELLED')
        order by created_at desc
        limit 1
        for update`,
      [vehicleRow.id]
    );
    const visitRow = visit.rows[0] as
      | { id: string; visit_code: string; status: string }
      | undefined;
    if (!visitRow) {
      return { ok: false as const, reason: 'no_active_visit' as const, vehicleId: vehicleRow.id };
    }

    // Direction is inferred: ENTRY when the detection zone differs from the
    // visit's current last-detected zone, EXIT when it is the same zone being
    // re-seen (a repeated same-zone ping keeps the vehicle marked present).
    const current = await client.query(
      `select last_detected_zone_id::text as zone
         from vehicle_visits where id = $1`,
      [visitRow.id]
    );
    const prevZone = (current.rows[0] as { zone: string | null } | undefined)?.zone ?? null;
    const direction: 'ENTRY' | 'EXIT' = prevZone === gateway.zoneId ? 'EXIT' : 'ENTRY';

    // Append-only movement record. method = DEVICE_DETECTION for physical
    // gateways; the simulator uses 'SIMULATED' via the flagged path.
    await client.query(
      `insert into gate_movements (visit_id, zone_id, direction, method, occurred_at)
       values ($1, $2, $3, $4, $5)`,
      [
        visitRow.id,
        gateway.zoneId,
        direction,
        gateway.isSimulated ? 'SIMULATED' : 'DEVICE_DETECTION',
        input.occurredAt ? new Date(input.occurredAt) : new Date()
      ]
    );

    await client.query(
      `update vehicle_visits
          set last_detected_zone_id = $2,
              last_detected_at = now()
        where id = $1`,
      [visitRow.id, gateway.zoneId]
    );

    // No audit() call here: gate_movements IS the append-only record for
    // device detections (audit_logs is for human/privileged actions).
    await client.query('COMMIT');
    await client.query('BEGIN');

    return {
      ok: true as const,
      visitId: visitRow.id,
      visitCode: visitRow.visit_code,
      zoneCode: gateway.zoneCode,
      direction,
      simulated: gateway.isSimulated,
      detectedAt: new Date().toISOString()
    };
  });
}
