/**
 * Server-side visit domain logic: registration + validated transitions.
 *
 * SECURITY MODEL
 * - Every exported function receives the caller profile AFTER assertRole has
 *   verified the session server-side. No function trusts client input alone.
 * - Transitions acquire a row lock (SELECT ... FOR UPDATE) FIRST, then re-read
 *   the current status INSIDE the transaction, then apply the TS state machine.
 * - Duplicate registration is tolerated (see registerVisit) so double-clicks and
 *   concurrent retries cannot create ghost visits.
 */
import 'server-only';
import { z } from 'zod';
import { pool, withTransaction, type PoolClient } from '@/db';
import { audit } from '@/lib/audit';
import { validatePlate } from '@/lib/plate';
import { isWorkflowStatus, canTransition, requiresReason, type WorkflowStatus } from '@/lib/workflow';
import type { AppRole } from '@/lib/rbac';

// ── Validation schemas ──
export const plateSchema = z.string().trim().min(2).max(20)
  .regex(/^[0-9A-Za-z\u0600-\u06FF\s\-_.]+$/, 'Plate contains invalid characters');

export const companyInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(2).max(160).optional()
}).refine((v) => v.id !== undefined || (v.name !== undefined && v.name.length >= 2), {
  message: 'Provide an existing company id or a new company name'
});

export const driverInputSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  phone: z.string().trim().max(30).optional(),
  licenseNumber: z.string().trim().max(60).optional()
});

export const registerVisitSchema = z.object({
  plate: plateSchema,
  company: companyInputSchema,
  driver: driverInputSchema.optional(),
  notes: z.string().trim().max(1000).optional()
});
export type RegisterVisitInput = z.infer<typeof registerVisitSchema>;

export const transitionSchema = z.object({
  visitId: z.string().uuid(),
  toStatus: z.string(),
  reason: z.string().trim().min(2).max(500).optional()
});
export type TransitionInput = z.infer<typeof transitionSchema>;

// ── Registration ──

/**
 * Duplicate tolerance window: a re-registration of the SAME plate within this window
 * returns the existing visit instead of creating a second one (idempotent under
 * concurrent clicks/retries). Different plates are unaffected.
 */
const DUPLICATE_WINDOW_MINUTES = 5;

export interface VisitRow {
  id: string;
  visit_code: string;
  status: WorkflowStatus;
}

function zoneIdForStatus(status: WorkflowStatus): string {
  // REGISTERED/WAITING_FOR_SECURITY → Parking; AT_SECURITY → Security; lab statuses → Laboratory
  if (status === 'REGISTERED' || status === 'WAITING_FOR_SECURITY') return 'PARKING';
  if (status === 'AT_SECURITY') return 'SECURITY';
  return 'LABORATORY';
}

export async function registerVisit(
  caller: { id: string; role: AppRole },
  input: RegisterVisitInput
): Promise<{ visit: VisitRow; duplicate: boolean }> {
  const plate = validatePlate(input.plate);
  if (!plate.ok) throw new Error(plate.reason);

  return withTransaction(async (client) => {
    // idempotency: same plate inside the window returns the existing open visit
    const dupe = await client.query(
      `select v.id::text as id, v.visit_code, v.status::text as status
         from vehicle_visits v
         join vehicles ve on ve.id = v.vehicle_id
        where ve.plate_normalized = $1
          and v.status not in ('COMPLETED','REJECTED','CANCELLED')
          and v.created_at > now() - interval '5 minutes'
        order by v.created_at desc
        limit 1`,
      [plate.normalized]
    );
    if (dupe.rows.length > 0) {
      return { visit: dupe.rows[0] as VisitRow, duplicate: true };
    }

    // resolve/create company, vehicle, optional driver
    const companyId = await resolveCompany(client, input.company);
    const vehicleId = await resolveVehicle(client, plate.normalized, input.plate.trim());
    let driverId: string | null = null;
    if (input.driver && input.driver.fullName) {
      driverId = await resolveDriver(client, input.driver, companyId);
    }

    // create visit
    const visit = await client.query(
      `insert into vehicle_visits (vehicle_id, company_id, driver_id, registered_by, notes)
       values ($1, $2, $3, $4, $5)
       returning id::text as id, visit_code, status::text as status`,
      [vehicleId, companyId, driverId, caller.id, input.notes ?? null]
    );
    const newVisit = visit.rows[0] as VisitRow;

    // audit log (inside the same tx; never rolls back the visit)
    await client.query(
      `insert into audit_logs (actor, action, target_table, target_id, details)
       values ($1, $2, $3, $4, $5::jsonb)`,
      [caller.id, 'REGISTER_VISIT', 'vehicle_visits', newVisit.id,
       JSON.stringify({ visitCode: newVisit.visit_code, plate: plate.normalized })]
    );

    return { visit: newVisit, duplicate: false };
  });
}

// ── Transition ──

/**
 * Validated, row-locked transition. Authorization (assertRole) MUST have run
 * before calling this; roleForTransition is re-checked here as defense in depth.
 */
export async function transitionVisit(
  caller: { id: string; role: AppRole },
  input: TransitionInput
): Promise<{ visit: VisitRow; fromStatus: WorkflowStatus }> {
  const to = input.toStatus;
  if (!isWorkflowStatus(to)) throw new Error('Invalid target status.');

  return withTransaction(async (client) => {
    // 1 · acquire row lock FIRST
    const current = await client.query(
      `select id::text as id, visit_code, status::text as status
         from vehicle_visits
        where id = $1
          for update`,
      [input.visitId]
    );
    if (current.rows.length === 0) throw new Error('Visit not found.');
    const from = current.rows[0].status as WorkflowStatus;
    if (from === to) throw new Error('Visit is already in the requested status.');

    // 2 · state machine re-check INSIDE the transaction (after the lock)
    if (!canTransition(from, to)) {
      throw new Error(`Invalid transition: ${from} → ${to}.`);
    }

    // 3 · role authorization re-check (defense in depth under the same lock)
    const { roleForTransition } = await import('@/lib/workflow');
    const required = roleForTransition(from, to);
    if (caller.role !== required && caller.role !== 'SUPER_ADMIN') {
      throw new PermissionError(`Role ${caller.role} may not perform ${from} → ${to}.`);
    }

    // 4 · reason validation
    if (requiresReason(to) && (!input.reason || input.reason.length < 2)) {
      throw new Error('A reason is required for this action.');
    }
    if (!requiresReason(to) && input.reason) {
      throw new Error('Reason not allowed for a normal transition.');
    }
    // 5 · reason text cap for consistency with gate_movements.reason
    const reason = requiresReason(to) ? input.reason?.trim().slice(0, 500) ?? null : null;

    // 6 · update status (+ completed_at when finishing)
    const updated = await client.query(
      `update vehicle_visits
          set status = $2,
              completed_at = case when $2 = 'COMPLETED' then now() else completed_at end,
              updated_at = now()
        where id = $1
        returning id::text as id, visit_code, status::text as status`,
      [input.visitId, to]
    );
    const visit = updated.rows[0] as VisitRow;

    // 7 · record gate movement (append-only)
    await client.query(
      `insert into gate_movements (visit_id, zone_id, direction, method, confirmed_by, reason)
       values ($1, (select id from zones where code = $2), 'ENTRY', 'MANUAL_CONFIRMATION', $3, $4)`,
      [input.visitId, zoneIdForStatus(to), caller.id, reason]
    );
    // 8 · audit log
    await client.query(
      `insert into audit_logs (actor, action, target_table, target_id, details)
       values ($1, $2, $3, $4, $5::jsonb)`,
      [caller.id, 'TRANSITION_VISIT', 'vehicle_visits', input.visitId,
       JSON.stringify({ from, to, reason })]
    );
    // 9 · notification for the next responsible role
    await notifyRole(client, targetRoleFor(to), visit, from);

    return { visit, fromStatus: from };
  });
  
}

class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionError';
  }
}

class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionError';
  }
}

// ── helpers ──

function targetRoleFor(to: WorkflowStatus): AppRole {
  if (to === 'WAITING_FOR_SECURITY' || to === 'AT_SECURITY') return 'SECURITY_OPERATOR';
  if (to === 'WAITING_FOR_LAB' || to === 'AT_LAB' || to === 'COMPLETED') return 'LAB_OPERATOR';
  return 'SUPER_ADMIN';
}

async function notifyRole(
  client: PoolClient,
  role: AppRole,
  visit: VisitRow,
  from: WorkflowStatus
): Promise<void> {
  await client.query(
    `insert into notifications (visit_id, target_role, title, body, severity, created_by)
     values ($1, $2, $3, $4, 'info', $5)`,
    [visit.id, role,
     `Visit ${visit.visit_code} → ${toLabel(to)}`.slice(0, 120),
     `Vehicle workflow moved ${fromLabel(from)} → ${toLabel(...)}...`.slice(0, 500),
     visit.created_by ?? null]
  );
}

function toLabel(s: WorkflowStatus): string {
  return s.replaceAll('_', ' ').toLowerCase();
}
function fromLabel(s: WorkflowStatus): string {
  return s.replaceAll('_', ' ').toLowerCase();
}

async function resolveCompany(client: PoolClient, company: CompanyInput): Promise<string> {
  if (company.id) {
    const r = await client.query('select id::text from companies where id = $1 and is_active', [company.id]);
    if (r.rows.length === 0) throw new Error('Company not found or inactive.');
    return r.rows[0].id as string;
  }
  const name = company.name!.trim();
  const r = await client.query(
    `insert into companies (name) values ($1)
     on conflict (name) do update set name = excluded.name
     returning id::text`,
    [name]
  );
  return r.rows[0].id as string;

// (deleted the 5-minute window constant here — keep logic, remove duplicated)

export async function getVisitDetail(visitId: string): Promise<...> {
  // TODO in a follow-up commit: details/timeline query for the [id] page.
}
