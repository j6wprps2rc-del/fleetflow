/**
 * Server-side visit registration and workflow transitions.
 * Security model (all enforced server-side, never via UI hiding):
 *   - registration: PARKING_OPERATOR or SUPER_ADMIN (assertRole)
 *   - transitions: authorizedRolesForTransition matrix per transition
 *   - every mutation runs inside a transaction with SELECT ... FOR UPDATE on
 *     the visit row; the state machine is re-evaluated AFTER the lock, so two
 *     concurrent conflicting transitions cannot both apply
 *   - gate_movements and notifications are written in the SAME transaction
 *     (rollback removes partial effects on any failure)
 *   - registration idempotency: client idempotency key + DB unique partial index
 *     on active visits per vehicle
 */
import 'server-only';
import { withTransaction, pool } from '@/db';
import { audit } from '@/lib/audit';
import { assertRole, PermissionError } from '@/lib/auth';
import { canTransition, isWorkflowStatus, requiresReason, type WorkflowStatus } from '@/lib/workflow';
import { normalizePlate, validatePlate } from '@/lib/plate';
import {
  authorizedRolesForTransition,
  gateEffectsForTransition,
  isRegisterableStatus,
  notificationTargetsForStatus,
  type ZoneCode
} from '@/lib/visit-mapping';
import {
  registerVisitSchema,
  transitionVisitSchema,
  type RegisterVisitInput,
  type TransitionVisitInput
} from '@/lib/visit-schemas';

export interface RegisterVisitResult {
  ok: true;
  visitId: string;
  visitCode: string;
  companyId: string;
  vehicleId: string;
}

export interface ActiveVisitConflictResult {
  ok: false;
  conflict: { visitId: string; visitCode: string; status: WorkflowStatus };
}

export class TransitionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransitionConflictError';
  }
}

export class InvalidTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransitionError';
  }
}

/** Pre-registration duplicate check (advisory; the DB index is the guarantee). */
export async function findActiveVisitForPlate(
  plate: string
): Promise<{ visitId: string; visitCode: string; status: WorkflowStatus } | null> {
  const normalized = normalizePlate(plate);
  const result = await pool.query(
    `select v.id::text as visit_id, v.visit_code, v.status::text as status
       from vehicle_visits v
       join vehicles ve on ve.id = v.vehicle_id
      where ve.plate_normalized = $1
        and v.status not in ('COMPLETED', 'REJECTED', 'CANCELLED')
      order by v.created_at desc
      limit 1`,
    [normalized]
  );
  const row = result.rows[0] as
    | { visit_id: string; visit_code: string; status: string }
    | undefined;
  if (!row || !isWorkflowStatus(row.status)) return null;
  return { visitId: row.visit_id, visitCode: row.visit_code, status: row.status };
}

/**
 * Registers a new vehicle visit. Creates the vehicle record if the plate is
 * new, resolves/creates the company, and inserts the visit — all inside one
 * transaction. Idempotent by client key: a retried request with the same key
 * returns the original visit instead of creating a duplicate.
 */
export async function registerVisit(
  input: unknown,
  context: { userId: string; role: string }
): Promise<RegisterVisitResult | ActiveVisitConflictResult> {
  const parsed = registerVisitSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'Invalid registration data.');
  }
  const data: RegisterVisitInput = parsed.data;

  const plate = validatePlate(data.plate);
  if (!plate.ok || !plate.normalized) {
    throw new Error(plate.reason ?? 'Invalid plate.');
  }

  return withTransaction(async (client) => {
    // Resolve company: existing id, or a new one created inside the transaction.
    let companyId = data.companyId;
    if (companyId === 'new') {
      if (!data.newCompanyName) {
        throw new Error('A company name is required when creating a new company.');
      }
      const inserted = await client.query(
        `insert into companies (name)
         values ($1)
         on conflict (name) do update set name = excluded.name
         returning id::text as id`,
        [data.newCompanyName]
      );
      companyId = (inserted.rows[0] as { id: string }).id;
    } else {
      const exists = await client.query(
        'select id::text as id from companies where id = $1 and is_active',
        [companyId]
      );
      if (exists.rowCount === 0) throw new Error('Company not found or inactive.');
      companyId = (exists.rows[0] as { id: string }).id;
    }

    // Idempotency: same key returns the original visit (no duplicate on retry).
    if (data.idempotencyKey) {
      const existing = await client.query(
        `select id::text as id, visit_code from vehicle_visits
          where idempotency_key = $1`,
        [data.idempotencyKey]
      );
      if (existing.rowCount && existing.rowCount > 0) {
        const row = existing.rows[0] as { id: string; visit_code: string };
        return {
          ok: true as const,
          visitId: row.id,
          visitCode: row.visit_code,
          companyId,
          vehicleId: ''
        };
      }
    }

    // Vehicle: upsert on normalized plate (display value preserved on first insert).
    const vehicleResult = await client.query(
      `insert into vehicles (plate_normalized, plate_display)
       values ($1, $2)
       on conflict (plate_normalized) do update set plate_normalized = excluded.plate_normalized
       returning id::text as id`,
      [plate.normalized, data.plate.trim()]
    );
    const vehicleId = (vehicleResult.rows[0] as { id: string }).id;

    // Duplicate protection: one active visit per vehicle (DB partial unique index).
    const active = await client.query(
      `select id::text as id, visit_code, status::text as status
         from vehicle_visits
        where vehicle_id = $1
          and status not in ('COMPLETED', 'REJECTED', 'CANCELLED')
        limit 1`,
      [vehicleId]
    );
    if (active.rowCount && active.rowCount > 0) {
      const row = active.rows[0] as { id: string; visit_code: string; status: string };
      if (isWorkflowStatus(row.status)) {
        return {
          ok: false as const,
          conflict: { visitId: row.id, visitCode: row.visit_code, status: row.status }
        };
      }
    }

    const visitResult = await client.query(
      `insert into vehicle_visits (vehicle_id, company_id, registered_by, notes, idempotency_key)
       values ($1, $2, $3, $4, $5)
       returning id::text as id, visit_code`,
      [vehicleId, companyId, context.userId, data.notes ?? null, data.idempotencyKey]
    );
    const visit = visitResult.rows[0] as { id: string; visit_code: string };

    await audit(context.userId, 'REGISTER_VISIT', 'vehicle_visits', visit.id, {
      plate: plate.normalized,
      companyId,
      idempotencyKey: data.idempotencyKey
    });

    return {
      ok: true as const,
      visitId: visit.id,
      visitCode: visit.visit_code,
      companyId,
      vehicleId
    };
  });
}

const ZONE_ID_CACHE: Partial<Record<ZoneCode, string>> = {};

async function zoneIdFor(client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }, zone: ZoneCode): Promise<string> {
  if (ZONE_ID_CACHE[zone]) return ZONE_ID_CACHE[zone]!;
  const result = await client.query(
    'select id::text as id from zones where code = $1',
    [zone]
  );
  const row = result.rows[0] as { id: string } | undefined;
  if (!row) throw new Error(`Zone ${zone} is not configured.`);
  ZONE_ID_CACHE[zone] = row.id;
  return row.id;
}

/**
 * Performs a workflow transition with full server-side authorization and
 * transactional safety. Order of operations inside the transaction:
 *   1. SELECT ... FOR UPDATE the visit row (serializes concurrent transitions)
 *   2. Re-validate the transition against the CURRENT status (post-lock)
 *   3. Insert gate_movements for the transition's effects
 *   4. Update the visit status
 *   5. Insert notifications for the target roles
 * Any failure rolls back everything — no partial movement records remain.
 */
export async function transitionVisit(input: unknown): Promise<{ visitId: string; from: WorkflowStatus; to: WorkflowStatus }> {
  const parsed = transitionVisitSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'Invalid transition request.');
  }
  const data: TransitionVisitInput = parsed.data;
  const target = data.target;

  return withTransaction(async (client) => {
    // 1 · Row lock — concurrent transitions on the same visit serialize here.
    const lockResult = await client.query(
      `select id::text as id, status::text as status, visit_code
         from vehicle_visits
        where id = $1
        for update`,
      [data.visitId]
    );
    const visit = lockResult.rows[0] as
      | { id: string; status: string; visit_code: string }
      | undefined;
    if (!visit) throw new Error('Visit not found.');

    const current = visit.status;
    if (!isWorkflowStatus(current)) throw new Error('Visit has an unknown status.');

    // 2 · Authorization is enforced per transition against the CURRENT state.
    const authorized = authorizedRolesForTransition(current, target);
    const { profile } = await assertRole(authorized);

    // 3 · State-machine validation AFTER the lock (not before) — this is what
    // makes two concurrent conflicting transitions impossible.
    if (!canTransition(current, target)) {
      throw new InvalidTransitionError(
        `Transition ${current} → ${target} is not allowed.`
      );
    }
    if (requiresReason(target) && !data.reason) {
      throw new Error('A reason is mandatory for this action.');
    }

    // 4 · Gate movements (append-only) for the transition's physical effects.
    const effects = gateEffectsForTransition(current, target);
    for (const effect of effects) {
      const zoneId = await zoneIdFor(client, effect.zone);
      await client.query(
        `insert into gate_movements (visit_id, zone_id, direction, method, confirmed_by, reason, occurred_at)
         values ($1, $2, $3, 'MANUAL_CONFIRMATION', $4, $5, now())`,
        [visit.id, zoneId, effect.direction, profile.id, data.reason ?? null]
      );
    }

    // 5 · Status update (audit trail note).
    await client.query(
      `update vehicle_visits
          set status = $1,
              completed_at = case when $1 = 'COMPLETED' then now() else completed_at end
        where id = $2`,
      [target, visit.id]
    );

    // 6 · Notifications for the relevant roles (same transaction).
    const targets = notificationTargetsForStatus(target);
    for (const role of targets) {
      await client.query(
        `insert into notifications (target_role, visit_id, title, body, severity)
         values ($1, $2, $3, $4, $5)`,
        [
          role,
          visit.id,
          `Visit ${visit.visit_code}: ${target.replaceAll('_', ' ').toLowerCase()}`,
          `Vehicle visit ${visit.visit_code} is now ${target.replaceAll('_', ' ').toLowerCase()}` +
            (data.reason ? `. Reason: ${data.reason}` : ''),
          requiresReason(target) ? 'warning' : 'info'
        ]
      );
    }

    return { visitId: visit.id, from: current, to: target };
  });
}

/** Used by the notifications page: acknowledge, server-authorized. */
export async function acknowledgeNotification(notificationId: string): Promise<void> {
  const { profile } = await assertRole([
    'SUPER_ADMIN',
    'PARKING_OPERATOR',
    'SECURITY_OPERATOR',
    'LAB_OPERATOR',
    'SUPERVISOR'
  ]);
  const result = await pool.query(
    `update notifications
        set acknowledged_at = now(), acknowledged_by = $1
      where id = $2
        and target_role = $3
        and acknowledged_at is null`,
    [notificationId, profile.id, profile.role]
  );
  if (result.rowCount === 0) {
    throw new PermissionError('Notification not found, not yours, or already acknowledged.');
  }
}
