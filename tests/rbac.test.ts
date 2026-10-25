import { describe, expect, it } from 'vitest';
import {
  canConfirmLab,
  canConfirmSecurity,
  canManageUsers,
  canRegisterVisit,
  canUseSimulator,
  canViewAudit,
  isAppRole
} from '../src/lib/rbac';

describe('role permission map', () => {
  it('allows only SUPER_ADMIN to manage users and view audit logs', () => {
    expect(canManageUsers('SUPER_ADMIN')).toBe(true);
    expect(canViewAudit('SUPER_ADMIN')).toBe(true);
    expect(canManageUsers('SECURITY_OPERATOR')).toBe(false);
    expect(canViewAudit('SUPERVISOR')).toBe(false);
  });

  it('allows parking operators (and admins) to register visits', () => {
    expect(canRegisterVisit('PARKING_OPERATOR')).toBe(true);
    expect(canRegisterVisit('SUPER_ADMIN')).toBe(true);
    expect(canRegisterVisit('SECURITY_OPERATOR')).toBe(false);
    expect(canRegisterVisit('LAB_OPERATOR')).toBe(false);
    expect(canRegisterVisit('SUPERVISOR')).toBe(false);
  });

  it('allows only security operators (and admins) to confirm security', () => {
    expect(canConfirmSecurity('SECURITY_OPERATOR')).toBe(true);
    expect(canConfirmSecurity('SUPER_ADMIN')).toBe(true);
    expect(canConfirmSecurity('PARKING_OPERATOR')).toBe(false);
  });

  it('allows only lab operators (and admins) to confirm the laboratory stage', () => {
    expect(canConfirmLab('LAB_OPERATOR')).toBe(true);
    expect(canConfirmLab('SUPER_ADMIN')).toBe(true);
    expect(canConfirmLab('SECURITY_OPERATOR')).toBe(false);
  });

  it('restricts the simulator to super admins', () => {
    expect(canUseSimulator('SUPER_ADMIN')).toBe(true);
    expect(canUseSimulator('SUPERVISOR')).toBe(false);
  });

  it('validates role strings', () => {
    expect(isAppRole('SUPER_ADMIN')).toBe(true);
    expect(isAppRole('HACKER')).toBe(false);
  });
});
