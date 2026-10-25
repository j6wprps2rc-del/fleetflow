/**
 * FLEETFLOW workflow state machine — pure logic, unit-testable.
 * PARKING → SECURITY → LABORATORY with explicit, validated transitions.
 * Invalid paths (e.g. REGISTERED → COMPLETED) must be rejected server-side.
 */
export type WorkflowStatus =
  | 'REGISTERED'
  | 'WAITING_FOR_SECURITY'
  | 'AT_SECURITY'
  | 'WAITING_FOR_LAB'
  | 'AT_LAB'
  | 'COMPLETED'
  | 'ON_HOLD'
  | 'REJECTED'
  | 'CANCELLED';

export const WORKFLOW_STATUSES: readonly WorkflowStatus[] = [
  'REGISTERED',
  'WAITING_FOR_SECURITY',
  'AT_SECURITY',
  'WAITING_FOR_LAB',
  'AT_LAB',
  'COMPLETED',
  'ON_HOLD',
  'REJECTED',
  'CANCELLED'
] as const;

/** Terminal statuses — no further transitions allowed. */
export const TERMINAL_STATUSES: readonly WorkflowStatus[] = [
  'COMPLETED',
  'REJECTED',
  'CANCELLED'
] as const;

/** Exceptional targets require SUPER_ADMIN and a mandatory reason. */
export const EXCEPTIONAL_STATUSES: readonly WorkflowStatus[] = [
  'ON_HOLD',
  'REJECTED',
  'CANCELLED'
] as const;

/** The normal, sequential pipeline. */
export const TRANSITIONS: Record<WorkflowStatus, readonly WorkflowStatus[]> = {
  REGISTERED: ['WAITING_FOR_SECURITY'],
  WAITING_FOR_SECURITY: ['AT_SECURITY'],
  AT_SECURITY: ['WAITING_FOR_LAB'],
  WAITING_FOR_LAB: ['AT_LAB'],
  AT_LAB: ['COMPLETED'],
  COMPLETED: [],
  ON_HOLD: ['WAITING_FOR_SECURITY', 'AT_SECURITY', 'WAITING_FOR_LAB', 'AT_LAB'],
  REJECTED: [],
  CANCELLED: []
};

export function isWorkflowStatus(value: string): value is WorkflowStatus {
  return (WORKFLOW_STATUSES as readonly string[]).includes(value);
}

export function isTerminal(status: WorkflowStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * Validates a transition. Exceptional targets (ON_HOLD / REJECTED / CANCELLED)
 * are allowed from any non-terminal status; normal moves must follow TRANSITIONS.
 */
export function canTransition(from: WorkflowStatus, to: WorkflowStatus): boolean {
  if (from === to) return false;
  if (isTerminal(from)) return false;
  if ((EXCEPTIONAL_STATUSES as readonly WorkflowStatus[]).includes(to)) return true;
  return (TRANSITIONS[from] ?? []).includes(to);
}

/** Exceptional targets always require a recorded reason. */
export function requiresReason(to: WorkflowStatus): boolean {
  return (EXCEPTIONAL_STATUSES as readonly WorkflowStatus[]).includes(to);
}

/** Role authorized to perform a given transition (checked server-side). */
export type TransitionRole =
  | 'PARKING_OPERATOR'
  | 'SECURITY_OPERATOR'
  | 'LAB_OPERATOR'
  | 'SUPER_ADMIN';

export function roleForTransition(from: WorkflowStatus, to: WorkflowStatus): TransitionRole {
  if (requiresReason(to)) return 'SUPER_ADMIN';
  if (from === 'ON_HOLD') return 'SUPER_ADMIN'; // resuming a hold is an admin action
  if (from === 'WAITING_FOR_SECURITY') return 'SECURITY_OPERATOR';
  if (from === 'WAITING_FOR_LAB' || from === 'AT_LAB') return 'LAB_OPERATOR';
  return 'PARKING_OPERATOR';
}
