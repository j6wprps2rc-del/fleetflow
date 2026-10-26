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
 *     on active visits per vehicle. Unique-violation races (two concurrent
 *     inserts) are caught and resolved to the original/conflict result instead
 *     of surfacing a raw DB error.
 *
 * Connection policy (pool-starvation fix): ALL queries inside withTransaction
 * bodies — including assertRole (authorization against the post-lock state) and
 * audit writes — run on the transaction client passed to those helpers, never
 * through the global pool. On Vercel (pool max 1) mixing the two deadlocks.
 */
import 'server-only';
import { withTransaction, pool, type QueryExecutor } from '@/db';
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

interface PgError {
  code?: string;
  constraint?: string;
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  const e = err as PgError;
  return e?.code === '23505' && e?.constraint === constraint;
}

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
 *
 * Concurrency: two racing requests cannot both create an active visit — the
 * DB partial unique indexes are the source of truth, and 23505 races are
 * resolved to the typed results below rather than surfacing raw errors.
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
    let companyId: string = data.companyId;
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

    // Vehicle: upsert on normalized plate (display value preserved on first insert).
    const vehicleResult = await client.query(
      `insert into vehicles (plate_normalized, plate_display)
       values ($1, $2)
       on conflict (plate_normalized) do update set plate_normalized = excluded.plate_normalized
       returning id::text as id`,
      [plate.normalized, data.plate.trim()]
    );
    const vehicleId = (vehicleResult.rows[0] as { id: string }).id;

    // Fast path: same idempotency key retried — return the original visit.
    if (data.idempotencyKey) {
      const existing = await client.query(
        `select id::text as id, visit_code, company_id::text as company_id,
                vehicle_id::text as vehicle_id
           from vehicle_visits
          where idempotency_key = $1`,
        [data.idempotencyKey]
      );
      if (existing.rowCount && existing.rowCount > 0) {
        const row = existing.rows[0] as {
          id: string; visit_code: string; company_id: string; vehicle_id: string;
        };
        return {
          ok: true as const,
          visitId: row.id,
          visitCode: row.visit_code,
          companyId: row.company_id,
          vehicleId: row.vehicle_id
        };
      }
    }
    // Insert the visit; use a savepoint so unique violations do not abort
    // the surrounding transaction before we resolve the conflict.
    await client.query('SAVEPOINT visit_insert');

    let visit: { id: string; visit_code: string };

    try {
      const visitResult = await client.query(
        `insert into vehicle_visits (vehicle_id, company_id, registered_by, notes, idempotency_key)
         values ($1, $2, $3, $4, $5)
         returning id::text as id, visit_code`,
        [vehicleId, companyId, context.userId, data.notes ?? null, data.idempotencyKey]
      );

      visit = visitResult.rows[0] as { id: string; visit_code: string };
      await client.query('RELEASE SAVEPOINT visit_insert');
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT visit_insert');
      await client.query('RELEASE SAVEPOINT visit_insert');

      if (isUniqueViolation(err, 'vehicle_visits_idempotency_idx')) {
        const existing = await client.query(
          `select id::text as id, visit_code, company_id::text as company_id,
                  vehicle_id::text as vehicle_id
             from vehicle_visits
            where idempotency_key = $1`,
          [data.idempotencyKey]
        );

        const row = existing.rows[0] as {
          id: string;
          visit_code: string;
          company_id: string;
          vehicle_id: string;
        } | undefined;

        if (row) {
          return {
            ok: true as const,
            visitId: row.id,
            visitCode: row.visit_code,
            companyId: row.company_id,
            vehicleId: row.vehicle_id
          };
        }
      }

      if (isUniqueViolation(err, 'vehicle_visits_one_active_idx')) {
        const active = await client.query(
          `select id::text as id, visit_code, status::text as status
             from vehicle_visits
            where vehicle_id = $1
              and status not in ('COMPLETED', 'REJECTED', 'CANCELLED')
            limit 1`,
          [vehicleId]
        );

        const row = active.rows[0] as
          | { id: string; visit_code: string; status: string }
          | undefined;

        if (row && isWorkflowStatus(row.status)) {
          return {
            ok: false as const,
            conflict: {
              visitId: row.id,
              visitCode: row.visit_code,
              status: row.status
            }
          };
        }
      }

      throw err;
    }

    await audit(
      context.userId,
      'REGISTER_VISIT',
      'vehicle_visits',
      visit.id,
      {
        plate: plate.normalized,
        companyId,
        idempotencyKey: data.idempotencyKey
      },
      client
    );

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

async function zoneIdFor(client: QueryExecutor, zone: ZoneCode): Promise<string> {
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
 *   2. Authorization against the CURRENT (post-lock) state via assertRole,
 *      running on the transaction connection (no second pool checkout)
 *   3. State-machine validation AFTER the lock
 *   4. Insert gate_movements for the transition's effects
 *   5. Update the visit status
 *   6. Insert notifications for the target roles
 *   7. Append-only TRANSITION_VISIT audit entry (same transaction)
 * Any failure rolls back everything — no partial movement records remain.
 *
 * Note on the assertRole connection: assertRole now receives the transaction
 * client, so the profile read runs on the SAME connection that holds the visit
 * row lock. The authorization decision still depends only on request-scoped
 * data (session + profile), never on the locked row — no deadlock risk, and
 * each transaction locks exactly one row before any other query.
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

    // 2 · Authorization is enforced per transition against the CURRENT state,
    // on the transaction connection (Vercel pool max 1 — no second checkout).
    const authorized = authorizedRolesForTransition(current, target);
    const { profile } = await assertRole(authorized, client);

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

    // 5 · Status update (completed_at when finishing).
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

    // 7 · Append-only audit entry for the transition (same transaction).
    await audit(
      profile.id,
      'TRANSITION_VISIT',
      'vehicle_visits',
      visit.id,
      {
        from: current,
        to: target,
        reason: data.reason ?? null
      },
      client
    );

    return { visitId: visit.id, from: current, to: target };
  });
}

/**
 * Acknowledges a notification on behalf of the signed-in user.
 * Server-side authorization: the caller must be an active employee, and the
 * update is restricted to notifications targeted at the caller's own role that
 * are not yet acknowledged. acknowledged_at is set by the SERVER (now()),
 * never taken from client input. The trg_notifications_ack trigger enforces
 * the same semantics at the DB layer for every role.
 *
 * (v2 fix: the previous version had swapped $1/$2 parameters — acknowledged_by
 * received the notification id and the WHERE matched the profile id, so the
 * update always affected zero rows.)
 */
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
        set acknowledged_at = now(),
            acknowledged_by = $1
      where id = $2
        and target_role = $3
        and acknowledged_at is null`,
    [profile.id, notificationId, profile.role]
  );
  if (result.rowCount === 0) {
    throw new PermissionError(
      'Notification not found, not targeted at your role, or already acknowledged.'
    );
  }
}
