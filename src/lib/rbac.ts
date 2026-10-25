/**
 * Pure RBAC rules — no server-only imports so this module is unit-testable
 * and usable anywhere. The single source of truth for what each role may do.
 * UI hiding is cosmetic; server actions and route handlers MUST call these.
 */
export type AppRole =
  | 'SUPER_ADMIN'
  | 'PARKING_OPERATOR'
  | 'SECURITY_OPERATOR'
  | 'LAB_OPERATOR'
  | 'SUPERVISOR';

export const APP_ROLES: readonly AppRole[] = [
  'SUPER_ADMIN',
  'PARKING_OPERATOR',
  'SECURITY_OPERATOR',
  'LAB_OPERATOR',
  'SUPERVISOR'
] as const;

export interface ProfileRow {
  id: string;
  full_name: string;
  email: string;
  role: AppRole;
  is_active: boolean;
}

export const ROLE_LABEL: Record<AppRole, string> = {
  SUPER_ADMIN: 'Super Admin',
  PARKING_OPERATOR: 'Parking Operator',
  SECURITY_OPERATOR: 'Security Operator',
  LAB_OPERATOR: 'Laboratory Operator',
  SUPERVISOR: 'Supervisor / Viewer'
};

export function isAppRole(value: string): value is AppRole {
  return (APP_ROLES as readonly string[]).includes(value);
}

export const canManageUsers = (role: AppRole): boolean => role === 'SUPER_ADMIN';
export const canViewAudit = (role: AppRole): boolean => role === 'SUPER_ADMIN';
export const canRegisterVisit = (role: AppRole): boolean =>
  role === 'PARKING_OPERATOR' || role === 'SUPER_ADMIN';
export const canConfirmSecurity = (role: AppRole): boolean =>
  role === 'SECURITY_OPERATOR' || role === 'SUPER_ADMIN';
export const canConfirmLab = (role: AppRole): boolean =>
  role === 'LAB_OPERATOR' || role === 'SUPER_ADMIN';
export const canUseSimulator = (role: AppRole): boolean => role === 'SUPER_ADMIN';
export const canViewReports = (_role: AppRole): boolean => true; // read-only for all active employees
