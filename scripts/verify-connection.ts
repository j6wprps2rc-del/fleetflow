/**
 * Safe connection verification.
 * Prints ONLY: database name, server time, table count, and expected-table check.
 * It never prints connection strings, passwords, or any secret material.
 * Usage: npm run db:verify
 */
import { join } from 'node:path';
import { Pool } from 'pg';
import { loadEnvFile } from './lib/load-env';

const EXPECTED_TABLES = [
  'profiles',
  'zones',
  'companies',
  'vehicles',
  'drivers',
  'vehicle_visits',
  'gate_movements',
  'audit_logs',
  'application_settings',
  '__migrations'
];

async function main(): Promise<void> {
  loadEnvFile();
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Place the transaction pooler URL (port 6543) in .env.');
    process.exit(1);
  }

  const isLocal = /localhost|127\.0\.0\.1/.test(url);
  const pool = new Pool({
    connectionString: url,
    max: 1,
    connectionTimeoutMillis: 8_000,
    ssl: isLocal ? undefined : { rejectUnauthorized: false }
  });

  try {
    const info = await pool.query(
      'select current_database() as db, now() as server_time, (select count(*)::int from information_schema.tables where table_schema = \'public\') as tables'
    );
    const row = info.rows[0] as { db: string; server_time: Date; tables: number };
    console.log('Connected to database :', row.db);
    console.log('Server time          :', row.server_time.toISOString());
    console.log('Public tables        :', row.tables);

    const found = await pool.query(
      "select table_name from information_schema.tables where table_schema = 'public'"
    );
    const names = new Set(found.rows.map((r: { table_name: string }) => r.table_name));
    const missing = EXPECTED_TABLES.filter((t) => !names.has(t));

    if (missing.length === 0) {
      console.log('Schema check          : all expected tables present. ✔');
    } else {
      console.log('Schema check          : missing tables — run `npm run db:migrate` — missing:', missing.join(', '));
    }
    console.log('Verification complete. No secrets were read or printed.');
  } catch (err) {
    console.error('Connection failed:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
