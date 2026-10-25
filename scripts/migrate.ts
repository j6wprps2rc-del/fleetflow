/**
 * FLEETFLOW migration runner.
 * Usage: npm run db:migrate
 * Connection: prefers DATABASE_URL_MIGRATIONS (direct, port 5432), falls back to DATABASE_URL.
 * Each migration runs inside a transaction and is tracked in the __migrations table.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { loadEnvFile } from './lib/load-env';

loadEnvFile();

const url = process.env.DATABASE_URL_MIGRATIONS ?? process.env.DATABASE_URL;
if (!url) {
  console.error(
    'No database URL found. Set DATABASE_URL_MIGRATIONS (direct, port 5432 — recommended) or DATABASE_URL in .env.'
  );
  process.exit(1);
}
if (url.includes(':6543')) {
  console.warn(
    'WARNING: this URL looks like the transaction pooler (port 6543). Prefer the direct connection (port 5432) for migrations.'
  );
}

const isLocal = /localhost|127\.0\.0\.1/.test(url);
const migrationsDir = join(process.cwd(), 'drizzle');
const client = new Client({
  connectionString: url,
  ssl: isLocal ? undefined : { rejectUnauthorized: false }
});

async function main(): Promise<void> {
  await client.connect();

  await client.query(`
    create table if not exists __migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const applied = new Set(
    (await client.query('select filename from __migrations')).rows.map(
      (row: { filename: string }) => row.filename
    )
  );

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('No migration files found in drizzle/.');
  }

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`= skip    ${file} (already applied)`);
      continue;
    }
    console.log(`+ apply   ${file}`);
    await client.query('BEGIN');
    try {
      await client.query(readFileSync(join(migrationsDir, file), 'utf8'));
      await client.query('insert into __migrations (filename) values ($1)', [file]);
      await client.query('COMMIT');
      console.log(`  done    ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`FAILED: ${file}`);
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
  }
  console.log('Migrations complete.');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => client.end());
