'use server';

import { revalidatePath } from 'next/cache';
import {
  registerVisit,
  transitionVisit,
  InvalidTransitionError
} from '@/lib/visits';
import { assertRole } from '@/lib/auth';

export interface VisitActionResult {
  ok: boolean;
  message: string;
  visitId?: string;
  conflict?: { visitId: string; visitCode: string; status: string };
}

/**
 * Registers a visit. Authorization: PARKING_OPERATOR or SUPER_ADMIN — checked
 * server-side before any DB work. Duplicate conflicts are returned to the form
 * for explicit user confirmation rather than silently failing.
 */
export async function registerVisitAction(
  input: unknown
): Promise<VisitActionResult> {
  try {
    const { profile } = await assertRole(['PARKING_OPERATOR', 'SUPER_ADMIN']);
    const { registerVisit: register } = await import('@/lib/visits');
    const result = await register(input, { userId: profile.id, role: profile.role });

    if (result.ok) {
      revalidatePath('/visits');
      revalidatePath('/dashboard');
      return {
        ok: true,
        message: `Visit ${result.visitCode} registered.`,
        visitId: result.visitId
      };
    }

    return {
      ok: false,
      message:
        `This vehicle already has an active visit (${result.conflict.visitCode}, ` +
        `status ${result.conflict.status.replaceAll('_', ' ').toLowerCase()}).`,
      conflict: {
        visitId: result.conflict.visitId,
        visitCode: result.conflict.visitCode,
        status: result.conflict.status
      }
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Registration failed.'
    };
  }
}

/**
 * Performs a workflow transition. Authorization is enforced inside
 * transitionVisit against the current row state (after the row lock).
 */
export async function transitionVisitAction(
  input: unknown
): Promise<VisitActionResult> {
  try {
    const result = await transitionVisit(input);
    revalidatePath('/visits');
    revalidatePath(`/visits/${result.visitId}`);
    revalidatePath('/dashboard');
    revalidatePath('/notifications');
    return {
      ok: true,
      message: `Status updated to ${result.to.replaceAll('_', ' ').toLowerCase()}.`,
      visitId: result.visitId
    };
  } catch (err) {
    if (err instanceof InvalidTransitionError) {
      return {
        ok: false,
        message:
          'This transition is not valid for the current status (it may have just changed). Refresh and try again.'
      };
    }
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Transition failed.'
    };
  }
}
