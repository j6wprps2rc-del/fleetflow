/**
 * Vehicle plate normalization and validation.
 * The original display value is never lost — normalization is used only for
 * search, uniqueness and duplicate detection.
 */
export interface PlateValidation {
  ok: boolean;
  reason?: string;
  normalized?: string;
}

/** Uppercase and strip separators for storage/search comparison. */
export function normalizePlate(raw: string): string {
  return raw.toUpperCase().replace(/[\s\-_.]/g, '');
}

/** Accepts Latin and Arabic letters, digits, and common separators. */
export function validatePlate(raw: string): PlateValidation {
  const trimmed = raw.trim();
  if (trimmed.length < 2 || trimmed.length > 20) {
    return { ok: false, reason: 'Plate must be between 2 and 20 characters.' };
  }
  if (!/^[0-9A-Za-z\u0600-\u06FF\s\-_.]+$/.test(trimmed)) {
    return { ok: false, reason: 'Plate contains invalid characters.' };
  }
  const normalized = normalizePlate(trimmed);
  if (normalized.length === 0) {
    return { ok: false, reason: 'Plate cannot consist only of separators.' };
  }
  return { ok: true, normalized };
}
