'use server';

import { revalidatePath } from 'next/cache';
import { assertRole } from '@/lib/auth';
import {
  createGateway,
  rotateGatewayKey,
  setGatewayActive
} from '@/lib/ingestion';

export interface GatewayActionResult {
  ok: boolean;
  message: string;
  plaintextKey?: string;
}

/** Creates a gateway. SUPER_ADMIN only; the key is shown exactly once. */
export async function createGatewayAction(input: {
  label: string;
  zoneCode: string;
}): Promise<GatewayActionResult> {
  try {
    const { profile } = await assertRole(['SUPER_ADMIN']);
    const result = await createGateway(profile.id, input);
    revalidatePath('/simulator');
    return {
      ok: true,
      message: `Gateway "${input.label}" created. Copy the key now — it will not be shown again.`,
      plaintextKey: result.plaintextKey
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Failed to create gateway.' };
  }
}

/** Rotates a gateway key. SUPER_ADMIN only; shown exactly once. */
export async function rotateGatewayKeyAction(gatewayId: string): Promise<GatewayActionResult> {
  try {
    const { profile } = await assertRole(['SUPER_ADMIN']);
    const result = await rotateGatewayKey(profile.id, gatewayId);
    revalidatePath('/simulator');
    return {
      ok: true,
      message: 'Key rotated. Copy the new key now — it will not be shown again.',
      plaintextKey: result.plaintextKey
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Failed to rotate key.' };
  }
}

/** Activates/deactivates a gateway. SUPER_ADMIN only. */
export async function setGatewayActiveAction(
  gatewayId: string,
  isActive: boolean
): Promise<GatewayActionResult> {
  try {
    const { profile } = await assertRole(['SUPER_ADMIN']);
    await setGatewayActive(profile.id, gatewayId, isActive);
    revalidatePath('/simulator');
    return { ok: true, message: isActive ? 'Gateway activated.' : 'Gateway deactivated.' };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Failed to update gateway.' };
  }
}

/**
 * Sends a SIMULATED detection through the real ingestion pipeline.
 * SUPER_ADMIN only. The simulated flag travels with the request so the
 * movement row is recorded with method='SIMULATED' — clearly labeled as
 * simulated data, never mixed with real device telemetry.
 */
export async function simulateDetectionAction(input: {
  gatewayKey: string;
  bleTagId: string;
}): Promise<GatewayActionResult & { result?: unknown }> {
  try {
    const { profile } = await assertRole(['SUPER_ADMIN']);
    void profile;
    const { ingestDetection } = await import('@/lib/ingestion');
    const result = await ingestDetection({
      gatewayKey: input.gatewayKey,
      bleTagId: input.bleTagId,
      simulated: true
    });

    revalidatePath('/visits');
    revalidatePath('/reports');

    if (result.ok) {
      return {
        ok: true,
        message: result.moved
          ? `SIMULATED detection recorded for ${result.visitCode} (zone ${result.zoneCode}).`
          : `SIMULATED heartbeat refreshed for ${result.visitCode} (no new movement row).`,
        result
      };
    }
    if (result.reason === 'unknown_tag') {
      return { ok: false, message: `Unknown tag: no vehicle is bound to "${input.bleTagId}".` };
    }
    return { ok: false, message: 'That vehicle has no active visit to record against.' };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Simulation failed.' };
  }
}
