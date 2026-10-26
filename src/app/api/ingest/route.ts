import { NextRequest, NextResponse } from 'next/server';
import { ingestDetection, GatewayAuthError, DetectionError } from '@/lib/ingestion';

/**
 * POST /api/ingest — BLE gateway detection ingestion.
 *
 * Machine-to-machine endpoint: gateways authenticate with their API key
 * (x-api-key header), NOT with a Supabase session. Responses are
 * deliberately uniform on auth failures so the endpoint leaks nothing.
 *
 * Body: { bleTagId: string, occurredAt?: string, simulated?: boolean }
 * `simulated: true` is ONLY honored for gateway keys flagged as simulators
 * (enforced in the library by the gateway's `is_simulated` flag — currently
 * all keys record DEVICE_DETECTION; the simulator UI path sets the flag).
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const data = body as { bleTagId?: unknown; occurredAt?: unknown };
  if (typeof data.bleTagId !== 'string') {
    return NextResponse.json({ error: 'bleTagId is required.' }, { status: 400 });
  }

  const gatewayKey = req.headers.get('x-api-key') ?? '';
  if (!gatewayKey) {
    return NextResponse.json({ error: 'Missing gateway key.' }, { status: 401 });
  }

  try {
    const result = await ingestDetection({
      gatewayKey,
      bleTagId: data.bleTagId,
      occurredAt: typeof data.occurredAt === 'string' ? data.occurredAt : undefined,
      simulated: (body as { simulated?: unknown }).simulated === true
    });

    if (result.ok) {
      return NextResponse.json(result, { status: 200 });
    }

    // Typed non-error outcomes.
    if (result.reason === 'unknown_tag') {
      return NextResponse.json(result, { status: 200 });
    }
    if (result.reason === 'no_active_visit') {
      return NextResponse.json(result, { status: 200 });
    }

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof GatewayAuthError) {
      return NextResponse.json({ error: 'Invalid or inactive gateway key.' }, { status: 401 });
    }
    if (err instanceof DetectionError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    console.error('[api/ingest] ingestion failed:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Ingestion failed.' }, { status: 500 });
  }
}
