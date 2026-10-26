/**
 * Checkpoint 3 tests — authorization matrix, state validation, gate movement
 * mapping, duplicate handling, schema validation, and static characterization
 * of the 0003 migration's RLS policies, grants, and acknowledgement trigger.
 *
 * NOTE (honest scope): these are static/pure tests. The acknowledge query's
 * parameter binding and the trigger's runtime behavior need an isolated test
 * database (integration) — see README § Testing for the documented gap.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  authorizedRolesForTransition,
  gateEffectsForTransition,
  isRegisterableStatus,
  notificationTargetsForStatus
} from '../src/lib/visit-mapping';
import {
  registerVisitSchema,
  transitionVisitSchema,
  reasonSchema,
  plateSchema
} from '../src/lib/visit-schemas';
import { canTransition, requiresReason } from '../src/lib/workflow';

const sql0003 = readFileSync(join(process.cwd(), 'drizzle', '0003_visits.sql'), 'utf8');
const visitsSrc = readFileSync(
  join(process.cwd(), 'src', 'lib', 'visits.ts'),
  'utf8'
);

function code(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

const c3 = code(sql0003);

// ── authorization matrix ─────────────────────────────────────────────

describe('transition authorization matrix', () => {
  it('zone owners (and admins) perform the normal pipeline transitions', () => {
    expect(authorizedRolesForTransition('REGISTERED', 'WAITING_FOR_SECURITY')).toEqual(
      ['PARKING_OPERATOR', 'SUPER_ADMIN']
    );
    expect(authorizedRolesForTransition('WAITING_FOR_SECURITY', 'AT_SECURITY')).toEqual(
      ['SECURITY_OPERATOR', 'SUPER_ADMIN']
    );
    expect(authorizedRolesForTransition('AT_SECURITY', 'WAITING_FOR_LAB')).toEqual(
      ['SECURITY_OPERATOR', 'SUPER_ADMIN']
    );
    expect(authorizedRolesForTransition('WAITING_FOR_LAB', 'AT_LAB')).toEqual(
      ['LAB_OPERATOR', 'SUPER_ADMIN']
    );
    expect(authorizedRolesForTransition('AT_LAB', 'COMPLETED')).toEqual(
      ['LAB_OPERATOR', 'SUPER_ADMIN']
    );
  });

  it('hold/reject/cancel are SUPER_ADMIN only', () => {
    for (const from of ['REGISTERED', 'WAITING_FOR_SECURITY', 'AT_SECURITY', 'WAITING_FOR_LAB', 'AT_LAB'] as const) {
      for (const to of ['ON_HOLD', 'REJECTED', 'CANCELLED'] as const) {
        expect(authorizedRolesForTransition(from, to)).toEqual(['SUPER_ADMIN']);
      }
    }
  });

  it('resuming from ON_HOLD is SUPER_ADMIN only', () => {
    expect(authorizedRolesForTransition('ON_HOLD', 'WAITING_FOR_LAB')).toEqual(['SUPER_ADMIN']);
    expect(authorizedRolesForTransition('ON_HOLD', 'AT_LAB')).toEqual(['SUPER_ADMIN']);
  });

  it('a lab operator cannot confirm security and vice versa', () => {
    expect(authorizedRolesForTransition('WAITING_FOR_SECURITY', 'AT_SECURITY')).not.toContain('LAB_OPERATOR');
    expect(authorizedRolesForTransition('WAITING_FOR_LAB', 'AT_LAB')).not.toContain('SECURITY_OPERATOR');
  });
});

// ── state validation ────────────────────────────────────────────────

describe('transition state validation', () => {
  it('rejects invalid jumps', () => {
    expect(canTransition('REGISTERED', 'COMPLETED')).toBe(false);
    expect(canTransition('WAITING_FOR_SECURITY', 'AT_LAB')).toBe(false);
    expect(canTransition('AT_SECURITY', 'WAITING_FOR_SECURITY')).toBe(false);
  });

  it('requires a reason exactly for exceptional targets', () => {
    expect(requiresReason('ON_HOLD')).toBe(true);
    expect(requiresReason('REJECTED')).toBe(true);
    expect(requiresReason('CANCELLED')).toBe(true);
    expect(requiresReason('AT_LAB')).toBe(false);
  });

  it('terminal statuses allow no transitions', () => {
    expect(canTransition('COMPLETED', 'WAITING_FOR_SECURITY')).toBe(false);
    expect(canTransition('REJECTED', 'AT_SECURITY')).toBe(false);
  });
});

// ── gate movement mapping ─────────────────────────────────────────────

describe('gate movement mapping', () => {
  it('records EXIT from parking when dispatched to security', () => {
    expect(gateEffectsForTransition('REGISTERED', 'WAITING_FOR_SECURITY')).toEqual([
      { zone: 'PARKING', direction: 'EXIT' }
    ]);
  });

  it('records ENTRY at security and lab', () => {
    expect(gateEffectsForTransition('WAITING_FOR_SECURITY', 'AT_SECURITY')).toEqual([
      { zone: 'SECURITY', direction: 'ENTRY' }
    ]);
    expect(gateEffectsForTransition('WAITING_FOR_LAB', 'AT_LAB')).toEqual([
      { zone: 'LABORATORY', direction: 'ENTRY' }
    ]);
  });

  it('records security EXIT and lab ENTRY when inspection passes', () => {
    expect(gateEffectsForTransition('AT_SECURITY', 'WAITING_FOR_LAB')).toEqual([
      { zone: 'SECURITY', direction: 'EXIT' },
      { zone: 'LABORATORY', direction: 'ENTRY' }
    ]);
  });

  it('records EXIT from laboratory on completion', () => {
    expect(gateEffectsForTransition('AT_LAB', 'COMPLETED')).toEqual([
      { zone: 'LABORATORY', direction: 'EXIT' }
    ]);
  });

  it('administrative statuses record no gate movements', () => {
    expect(gateEffectsForTransition('AT_SECURITY', 'ON_HOLD')).toEqual([]);
    expect(gateEffectsForTransition('WAITING_FOR_LAB', 'REJECTED')).toEqual([]);
  });
});

// ── notifications ────────────────────────────────────────────────────

describe('notification targets', () => {
  it('notifies security when a vehicle is dispatched to them', () => {
    expect(notificationTargetsForStatus('WAITING_FOR_SECURITY')).toContain('SECURITY_OPERATOR');
  });
  it('notifies lab when a vehicle is sent to them', () => {
    expect(notificationTargetsForStatus('WAITING_FOR_LAB')).toContain('LAB_OPERATOR');
  });
  it('notifies parking on completion', () => {
    expect(notificationTargetsForStatus('COMPLETED')).toContain('PARKING_OPERATOR');
  });
  it('no notifications for registration itself', () => {
    expect(notificationTargetsForStatus('REGISTERED')).toEqual([]);
  });
});

// ── duplicates ────────────────────────────────────────────────────────

describe('duplicate registration handling', () => {
  it('treats all non-terminal statuses as blocking a new visit', () => {
    expect(isRegisterableStatus('REGISTERED')).toBe(true);
    expect(isRegisterableStatus('WAITING_FOR_SECURITY')).toBe(true);
    expect(isRegisterableStatus('ON_HOLD')).toBe(true);
    expect(isRegisterableStatus('COMPLETED')).toBe(false);
    expect(isRegisterableStatus('REJECTED')).toBe(false);
    expect(isRegisterableStatus('CANCELLED')).toBe(false);
  });

  it('resolves unique-violation races by constraint name', () => {
    // The race handlers must target exactly the two partial unique indexes.
    expect(visitsSrc).toContain("isUniqueViolation(err, 'vehicle_visits_idempotency_idx')");
    expect(visitsSrc).toContain("isUniqueViolation(err, 'vehicle_visits_one_active_idx')");
  });
});

// ── schema validation ─────────────────────────────────────────────────

describe('visit schemas', () => {
  it('accepts a valid registration', () => {
    const result = registerVisitSchema.safeParse({
      plate: 'ABC-1234',
      companyId: '11111111-1111-1111-1111-111111111111',
      idempotencyKey: 'key-12345678'
    });
    expect(result.success).toBe(true);
  });

  it('rejects short plates and invalid characters', () => {
    expect(plateSchema.safeParse('A').success).toBe(false);
    expect(plateSchema.safeParse('AB$%').success).toBe(false);
  });

  it('rejects a missing idempotency key', () => {
    const result = registerVisitSchema.safeParse({
      plate: 'ABC-1234',
      companyId: '11111111-1111-1111-1111-111111111111'
    });
    expect(result.success).toBe(false);
  });

  it('requires a reason for hold/reject/cancel in the transition schema', () => {
    expect(
      transitionVisitSchema.safeParse({
        visitId: '11111111-1111-1111-1111-111111111111',
        target: 'ON_HOLD'
      }).success
    ).toBe(false);
    expect(
      transitionVisitSchema.safeParse({
        visitId: '11111111-1111-1111-1111-111111111111',
        target: 'ON_HOLD',
        reason: 'Suspicious documents'
      }).success
    ).toBe(true);
  });

  it('does not require a reason for normal transitions', () => {
    expect(
      transitionVisitSchema.safeParse({
        visitId: '11111111-1111-1111-1111-111111111111',
        target: 'AT_LAB'
      }).success
    ).toBe(true);
  });

  it('validates reason length', () => {
    expect(reasonSchema.safeParse('ab').success).toBe(false);
    expect(reasonSchema.safeParse('a'.repeat(501)).success).toBe(false);
    expect(reasonSchema.safeParse('Valid reason here').success).toBe(true);
  });
});

// ── 0003 migration security characterization (v2 revision) ───────────

describe('0003 migration security characterization', () => {
  it('is fully rerunnable: drop-if-exists precedes every policy/trigger creation', () => {
    expect(c3).toMatch(
      /drop policy if exists "notifications_read_own_role"[\s\S]*?create policy "notifications_read_own_role"/
    );
    expect(c3).toMatch(
      /drop policy if exists "notifications_ack_own_role"[\s\S]*?create policy "notifications_ack_own_role"/
    );
    expect(c3).toMatch(
      /drop trigger if exists trg_notifications_ack[\s\S]*?create trigger trg_notifications_ack/
    );
    expect(c3).toMatch(/add column if not exists idempotency_key text/);
  });

  it('uses a hardened SECURITY DEFINER role helper (no dependency on profiles RLS)', () => {
    const fn = c3.match(/create or replace function public\.current_app_role\(\)[\s\S]*?\$\$;/)?.[0] ?? '';
    expect(fn).toContain('security definer');
    expect(fn).toContain('set search_path = public');
    expect(fn).toContain('is_active');
    expect(c3).toMatch(
      /revoke execute on function public\.current_app_role\(\) from public, anon/
    );
    expect(c3).toMatch(
      /grant execute on function public\.current_app_role\(\) to authenticated/
    );

    const readPolicy = c3.match(/create policy "notifications_read_own_role"[\s\S]*?;/)?.[0] ?? '';
    expect(readPolicy).toContain('target_role = public.current_app_role()');
  });

  it('clients cannot insert, delete, or update notifications at all', () => {
    expect(c3).toMatch(/revoke insert, delete on public\.notifications from anon, authenticated/);
    expect(c3).toMatch(/revoke update on public\.notifications from anon, authenticated/);
    // Crucially: no re-grant of update to client roles (timestamp forgery closed).
    expect(c3).not.toMatch(/grant update[^;]*on public\.notifications to authenticated/);
  });

  it('acknowledgement semantics are enforced by a DB trigger for every role', () => {
    const fn = c3.match(/create or replace function public\.enforce_notification_ack\(\)[\s\S]*?\$\$;/)?.[0] ?? '';
    expect(fn).toContain('only acknowledgement fields may change');
    expect(fn).toContain('already acknowledged');
    expect(fn).toContain('acknowledged_by is required');
    expect(fn).toContain('new.acknowledged_at := now()'); // arbitrary timestamps impossible
  });

  it('ack policy (defense in depth): own role, unacknowledged, self as acknowledger', () => {
    const ackPolicy = c3.match(/create policy "notifications_ack_own_role"[\s\S]*?;/)?.[0] ?? '';
    expect(ackPolicy).toContain('target_role = public.current_app_role()');
    expect(ackPolicy).toContain('acknowledged_at is null');
    expect(ackPolicy).toContain('acknowledged_by = auth.uid()');
  });

  it('enforces one active visit per vehicle via a partial unique index', () => {
    const idx = c3.match(/create unique index if not exists vehicle_visits_one_active_idx[\s\S]*?;/)?.[0] ?? '';
    expect(idx).toContain('where status not in');
  });

  it('makes registration idempotent via a unique idempotency key index', () => {
    expect(c3).toMatch(/create unique index if not exists vehicle_visits_idempotency_idx/);
  });

  it('reuses existing enums and FKs (no new status or zone types)', () => {
    expect(c3).toContain('target_role public.app_role not null');
    expect(c3).toContain('references public.vehicle_visits(id)');
    expect(c3).toContain('references public.profiles(id)');
    expect(c3).not.toMatch(/create type/i);
  });
});

// ── acknowledge query binding regression ─────────────────────────────

describe('acknowledgeNotification query binding (regression for swapped params)', () => {
  it('binds acknowledged_by=$1(profile), id=$2(notification), role=$3 in order', () => {
    const query =
      visitsSrc.match(
        /update notifications[\s\S]*?and acknowledged_at is null`/,
      )?.[0] ?? '';
    expect(query).toContain('set acknowledged_at = now()');
    expect(query).toContain('acknowledged_by = $1');
    expect(query).toContain('where id = $2');
    expect(query).toContain('target_role = $3');
    expect(query).toContain('and acknowledged_at is null');

    // The parameter array must follow exactly that order.
    const params = visitsSrc.match(
      /update notifications[\s\S]*?and acknowledged_at is null`,\s*\[([^\]]*)\]/,
    )?.[1] ?? '';
    expect(params.replace(/\s/g, '')).toBe('profile.id,notificationId,profile.role');
  });
});
