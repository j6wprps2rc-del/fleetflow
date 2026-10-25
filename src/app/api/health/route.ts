import { NextResponse } from 'next/server';
import { pool } from '@/db';

export const dynamic = 'force-dynamic';

const DB_TIMEOUT_MS = 3_000;

interface HealthBody {
  status: 'ok' | 'degraded';
  database: {
    configured: boolean;
    connected: boolean;
    tableCount: number | null;
    latencyMs: number | null;
  };
  issues: string[];
  generatedAt: string;
}

async function queryWithTimeout(sql: string) {
  return Promise.race([
    pool.query(sql),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('database query timeout')), DB_TIMEOUT_MS)
    )
  ]);
}

export async function GET() {
  const body: HealthBody = {
    status: 'ok',
    database: {
      configured: Boolean(process.env.DATABASE_URL),
      connected: false,
      tableCount: null,
      latencyMs: null
    },
    issues: [],
    generatedAt: new Date().toISOString()
  };

  if (!body.database.configured) {
    body.issues.push('DATABASE_URL is not set');
  } else {
    try {
      const startedAt = Date.now();
      const result = await queryWithTimeout(
        "select count(*)::int as c from information_schema.tables where table_schema = 'public'"
      );
      body.database.connected = true;
      body.database.tableCount = (result as { rows: { c: number }[] }).rows[0]!.c;
      body.database.latencyMs = Date.now() - startedAt;
    } catch (err) {
      body.issues.push(
        `Database unreachable: ${err instanceof Error ? err.message.split('\n')[0] : 'unknown error'}`
      );
    }
  }

  if (body.issues.length > 0) {
    body.status = 'degraded';
  }

  return NextResponse.json(body, { status: 200 });
}
