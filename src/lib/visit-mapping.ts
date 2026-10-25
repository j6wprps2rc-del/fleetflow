/**
 * Pure mapping layer between workflow transitions and their DB effects:
 * gate movements, zones, notification targets. No server-only imports —
 * fully unit-testable. The workflow.ts state machine stays the single source
 * of truth for which transitions are legal; this file answers WHAT a legal
 * transition must record and WHO is authorized to perform it.
 */
import type { AppRole } from '@/lib/rbac';
import type { WorkflowStatus } from '@/lib/workflow';

export type ZoneCode = 'PARKING' | 'SECURITY' | 'LABORATORY';

export type GateDirection = 'ENTRY' | 'EXIT';

export interface GateEffect {
  zone: ZoneCode;
  direction: GateDirection;
}

/**
 * Which gate movement(s) a transition records against the visit's zone chain.
 * ENTRY means the vehicle is entering the zone implied by the new status.
 */
export function gateEffectsForTransition(
  from: WorkflowStatus,
  to: WorkflowStatus
): GateEffect[] {
  switch (to) {
    case 'WAITING_FOR_SECURITY':
      // Vehicle leaves Parking and queues at Security (registered at gate).
      return [{ zone: 'PARKING', direction: 'EXIT' }];
    case 'AT_SECURITY':
      return [{ zone: 'SECURITY', direction: 'ENTRY' }];
    case 'WAITING_FOR_LAB':
      // Security inspection passed: exit Security, enter queue for Lab.
      return [
        { zone: 'SECURITY', direction: 'EXIT' },
        { zone: 'LABORATORY', direction: 'ENTRY' }
      ];
    case 'AT_LAB':
      return [{ zone: 'LABORATORY', direction: 'ENTRY' }];
    case 'COMPLETED':
      // Work finished: vehicle exits the Laboratory zone.
      return [{ zone: 'LABORATORY', direction: 'EXIT' }];
    default:
      // ON_HOLD / REJECTED / CANCELLED: no physical gate movement — these are
      // administrative statuses. (When from is ON_HOLD the resume target
      // determines its own effects through the normal branch above.)
      return [];
  }
}

/**
 * Roles authorized to perform a transition. Mirrors workflow.roleForTransition
 * but expressed against AppRole for direct use in assertRole. Exceptional
 * targets (ON_HOLD/REJECTED/CANCELLED) and resumes from ON_HOLD are SUPER_ADMIN
 * only. Normal transitions belong to the zone owner (or SUPER_ADMIN as
 * fallback override).
 */
export function authorizedRolesForTransition(
  from: WorkflowStatus,
  to: WorkflowStatus
): readonly AppRole[] {
  if (from === 'ON_HOLD') return ['SUPER_ADMIN'];
  switch (to) {
    case 'ON_HOLD':
    case 'REJECTED':
    case 'CANCELLED':
      return ['SUPER_ADMIN'];
    case 'WAITING_FOR_SECURITY':
      return ['PARKING_OPERATOR', 'SUPER_ADMIN'];
    case 'AT_SECURITY':
      return ['SECURITY_OPERATOR', 'SUPER_ADMIN'];
    case 'WAITING_FOR_LAB':
      return ['SECURITY_OPERATOR', 'SUPER_ADMIN'];
    case 'AT_LAB':
      return ['LAB_OPERATOR', 'SUPER_ADMIN'];
    case 'COMPLETED':
      return ['LAB_OPERATOR', 'SUPER_ADMIN'];
    default:
      return ['SUPER_ADMIN'];
  }
}

/**
 * Which roles get a notification when a visit reaches a given status.
 * Each department is alerted as its stage begins; parking is alerted on
 * completion so the gate can release the vehicle.
 */
export function notificationTargetsForStatus(
  status: WorkflowStatus
): readonly AppRole[] {
  switch (status) {
    case 'WAITING_FOR_SECURITY':
      return ['SECURITY_OPERATOR'];
    case 'AT_SECURITY':
      return ['SUPERVISOR'];
    case 'WAITING_FOR_LAB':
      return ['LAB_OPERATOR'];
    case 'AT_LAB':
      return ['SUPERVISOR'];
    case 'COMPLETED':
      return ['PARKING_OPERATOR', 'SUPERVISOR'];
    case 'ON_HOLD':
      return ['SUPERVISOR', 'PARKING_OPERATOR'];
    case 'REJECTED':
      return ['PARKING_OPERATOR'];
    case 'CANCELLED':
      return ['PARKING_OPERATOR'];
    default:
      return [];
  }
}

/**
 * Duplicate-visit resolution: a vehicle with an already-active visit cannot
 * start a second one. Returns the conflict for the UI to surface explicitly.
 */
export interface ActiveVisitConflict {
  activeVisitId: string;
  activeVisitCode: string;
  activeStatus: WorkflowStatus;
}

export function isRegisterableStatus(status: WorkflowStatus): boolean {
  return !['COMPLETED', 'REJECTED', 'CANCELLED'].includes(status);
}
