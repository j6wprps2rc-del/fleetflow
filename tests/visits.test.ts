/**
 * Checkpoint 3 tests — authorization matrix, state validation, gate movement
 * mapping, duplicate handling, schema validation, and static characterization
 * of the 0003 migration's RLS policies and grants.
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
import type { AppRole } from '../src/lib/rbac';

const sql0003 = readFileSync(join(process.cwd(), 'drizzle', '0003_visits.sql'), 'utf8');

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

// ── 0003 migration characterization ──────────────────────────────────

describe('0003 migration security characterization', () => {
  it('notifications RLS: read and acknowledge are restricted to the own role', () => {
    const readPolicy = c3.match(/create policy "notifications_read_own_role"[\s\S]*?;/)?.[0] ?? '';
    expect(readPolicy).toContain('target_role =');
    expect(readPolicy).toContain('is_active');

    const ackPolicy = c3.match(/create policy "notifications_ack_own_role"[\s\S]*?;/)?.[0] ?? '';
    expect(ackPolicy).toContain('target_role =');
    expect(ackPolicy).toContain('acknowledged_at is null');
    expect(ackPolicy).toContain('acknowledged_by = auth.uid()');
  });

  it('clients cannot insert, delete, or broadly update notifications', () => {
    expect(c3).toMatch(/revoke insert, delete on public\.notifications from anon, authenticated/);
    expect(c3).toMatch(/revoke update on public\.notifications from anon, authenticated/);
    expect(c3).toMatch(
      /grant update \(acknowledged_at, acknowledged_by\) on public\.notifications to authenticated/
    );
  });

  it('enforces one active visit per vehicle via a partial unique index', () => {
    const idx = c3.match(/create unique index if not exists vehicle_visits_one_active_idx[\s\S]*?;/)?.[0] ?? '';
    expect(idx).toContain('where status not in');
  });

  it('makes registration idempotent via a unique idempotency key index', () => {
    expect(c3).toMatch(/add column if not exists idempotency_key text/);
    expect(c3).toMatch(/create unique index if not exists vehicle_visits_idempotency_idx/);
  });

  it('reuses existing enums and FKs (no new status or zone types)', () => {
    expect(c3).toContain('target_role public.app_role not null');
    expect(c3).toContain('references public.vehicle_visits(id)');
    expect(c3).toContain('references public.profiles(id)');
    expect(c3).not.toMatch(/create type/i);
  });
});
