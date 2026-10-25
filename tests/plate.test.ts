import { describe, expect, it } from 'vitest';
import { normalizePlate, validatePlate } from '../src/lib/plate';

describe('normalizePlate', () => {
  it('uppercases Latin plates', () => {
    expect(normalizePlate('abc-1234')).toBe('ABC1234');
  });

  it('strips spaces, dashes, dots and underscores', () => {
    expect(normalizePlate(' a b c 1 2 3 ')).toBe('ABC123');
    expect(normalizePlate('a.b_c-d')).toBe('ABCD');
  });

  it('preserves Arabic letters and digits', () => {
    expect(normalizePlate('أ ب ج 123')).toBe('أبج123');
  });
});

describe('validatePlate', () => {
  it('accepts a normal plate and returns the normalized form', () => {
    const result = validatePlate('abc-1234');
    expect(result.ok).toBe(true);
    expect(result.normalized).toBe('ABC1234');
  });

  it('rejects plates that are too short', () => {
    expect(validatePlate('A').ok).toBe(false);
  });

  it('rejects plates that are too long', () => {
    expect(validatePlate('A'.repeat(21)).ok).toBe(false);
  });

  it('rejects invalid characters', () => {
    expect(validatePlate('ABC$123').ok).toBe(false);
  });

  it('rejects separator-only plates', () => {
    expect(validatePlate('---').ok).toBe(false);
  });
});
