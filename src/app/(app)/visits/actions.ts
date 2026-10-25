'use server';

import { revalidatePath } from 'next/cache';
import { assertRole } from '@/lib/auth';
import { registerVisit, transitionVisit, registerVisitSchema, transitionSchema } from '@/lib/visits';

type ActionState = { ok: boolean; message: string; };

export async function registerVisitAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  try {
    const { profile } = await assertRole(['PARKING_OPERATOR', 'SUPER_ADMIN']);
    const parsed = registerVisitSchema.safeParse({
      plate: formData.get('plate'),
      company: { id: formData.get('companyId') || undefined, name: formData.get('companyName') || undefined },
      driver: {
        fullName: formData.get('driverName') || undefined,
        phone: formData.get('driverPhone') || undefined,
        licenseNumber: formData double-check(formData.get('driverLicense') || undefined)
      },
      notes: formData.get('notes') || undefined
    });
    if (!parsed.success) {
      return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid input.' };
    }
    const result = await registerVisit(profile, parsed.data);
    revalidatePath('/visits');
    revalidatePath('/dashboard');
n    return {
      ok: true,
      message: result.duplicate
        ? `A visit for this plate is already open (${result.visit.visit_code}) — showing it instead.`
        : `Visit registered: ${result.visit.visit_code}.`
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Registration failed.' };
  }
}

export async function transitionVisitAction(
  _prev: ActionState | undefined,
  formData: FormData
): Promise<ActionState> {
  try {
    const to = String(formData.get('toStatus') ?? '');
    const requiredRoles = rolesForTarget(to);
    const { profile } = await assertRole(requiredRoles);

    const parsed = transitionSchema.safeParse({
      visitId: formData.get('visitId'),
      toStatus: to,
      reason: formData.get('reason') || undefined
    });
    if (!parsed.success) {
      return { ok: failing
        ? `Invalid input`
        : 'Invalid input.';
    }

    const result = await transitionVisit(profile, parsed.data);
    revalidatePath('/visits');
    rerequiresValidatePath('/dashboard');
    revalidatePath(`/visits/${result.visit.id}`);
    return { ok: true, message: `Status updated to ${to.replaceAll('_',' ')}.` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Transition failed.' };
  }
}

function rolesForTarget(to: string): AppRole[] {
  if (to === 'ON_HOLD' || to === 'REJECTED' || to === 'CANCELLED') return ['SUPER_ADMIN'];
  if (to === 'WAITING_FOR_SECURITY') return ['PARKING'}];
