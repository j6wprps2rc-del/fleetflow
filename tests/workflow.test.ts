import { describe, expect, it } from 'vitest';
import {
  canTransition,
  isTerminal,
  requiresReason,
  roleForTransition
} from '../src/lib/workflow';

describe('workflow state machine', () => {
  it('follows the correct pipeline', () => {
    expect(canTransition('REGISTERED', 'WAITING_FOR_SECURITY')).toBe(true);
    expect(canTransition('WAITING_FOR_SECURITY', 'AT_SECURITY')).toBe(true);
    expect(canTransition('AT_SECURITY', 'WAITING_FOR_LAB')).toBe(true);
    expect(canTransition('WAITING_FOR_LAB', 'AT_LAB')).toBe(true);
    expect(canTransition('AT_LAB', 'COMPLETED')).toBe(true);
  });

  it('rejects skipping stages (e.g. Parking straight to Completed)', () => {
    expect(canTransition('REGISTERED', 'COMPLETED')).toBe(false);
    expect(canTransition('WAITING_FOR_SECURITY', 'AT_LAB')).toBe(false);
    expect(canTransition('AT_SECURITY', 'COMPLETED')).toBe(false);
  });

  it('rejects self-transitions and backwards jumps', () => {
    expect(canTransition('AT_SECURITY', 'AT_SECURITY')).toBe(false);
    expect(canTransition('AT_SECURITY', 'WAITING_FOR_SECURITY')).toBe(false);
  });

  it('blocks transitions from terminal statuses', () => {
    expect(isTerminal('COMPLETED')).toBe(true);
    expect(isTerminal('REJECTED')).toBe(true);
    expect(isTerminal('CANCELLED')).toBe(true);
    expect(canTransition('COMPLETED', 'AT_LAB')).toBe(false);
  });

  it('allows exceptional targets from non-terminal statuses with a reason', () => {
    expect(canTransition('AT_SECURITY', 'ON_HOLD')).toBe(true);
    expect(canTransition('WAITING_FOR_LAB', 'REJECTED')).toBe(true);
    expect(canTransition('REGISTERED', 'CANCELLED')).toBe(true);
    expect(requiresReason('ON_HOLD')).toBe(true);
    expect(requiresReason('REJECTED')).toBe(true);
    expect(requiresReason('CANCELLED')).toBe(true);
    expect(requiresReason('AT_SECURITY')).toBe(false);
  });

  it('resumes from ON_HOLD only via admin action', () => {
    expect(canTransition('ON_HOLD', 'WAITING_FOR_LAB')).toBe(true);
    expect(roleForTransition('ON_HOLD', 'WAITING_FOR_LAB')).toBe('SUPER_ADMIN');
  });

  it('assigns the correct role per transition', () => {
    expect(roleForTransition('REGISTERED', 'WAITING_FOR_SECURITY')).toBe('PARKING_OPERATOR');
    expect(roleForTransition('WAITING_FOR_SECURITY', 'AT_SECURITY')).toBe('SECURITY_OPERATOR');
    expect(roleForTransition('WAITING_FOR_LAB', 'AT_LAB')).toBe('LAB_OPERATOR');
    expect(roleForTransition('AT_LAB', 'COMPLETED')).toBe('LAB_OPERATOR');
    expect(roleForTransition('AT_SECURITY', 'REJECTED')).toBe('SUPER_ADMIN');
  });
});
