/**
 * Migration-runner safety regression tests (manual-workflow-only).
 *
 * The ordinary `npm run db:migrate` command must NEVER apply the removed
 * device-ingestion migration. The runner processes files in sorted order, so
 * without an explicit exclusion, running 0003 would drag 0004 along with it.
 *
 * These are characterization tests over the runner source (same technique as
 * tests/sql-security.test.ts uses for migration SQL): they fail if the
 * exclusion is removed, renamed, or moved after the apply loop.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const runnerSrc = readFileSync(join(process.cwd(), 'scripts', 'migrate.ts'), 'utf8');

const BLOCK_FILE = '0004_device_ingestion.sql';

// The blocked file must actually exist in the repo for this guard to be
// meaningful — if someone deletes the file, the block entry can be retired
// deliberately along with this assertion.
let drizzleDir: string[] = [];
try {
  drizzleDir = readdirSafe(join(process.cwd(), 'drizzle'));
} catch {
  drizzleDir = [];
}

function readdirSafe(dir: string): string[] {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs');
  return fs.readdirSync(dir);
}

describe('migration runner safety (device-ingestion exclusion)', () => {
  it('the blocked migration file exists in drizzle/ (guard is meaningful)', () => {
    expect(drizzleDir).toContain(BLOCK_FILE);
  });

  it('runner declares a BLOCKED_MIGRATIONS list containing the device migration', () => {
    expect(runnerSrc).toMatch(/BLOCKED_MIGRATIONS/);
    expect(runnerSrc).toMatch(/0004_device_ingestion\.sql/);
  });

  it('blocked files are filtered out BEFORE the apply loop (so 0003 can apply without 0004)', () => {
    const filterIdx = runnerSrc.indexOf('BLOCKED_MIGRATIONS.has(f)');
    const applyLoopIdx = runnerSrc.indexOf('for (const file of files)');
    expect(filterIdx).toBeGreaterThan(-1);
    expect(applyLoopIdx).toBeGreaterThan(filterIdx);
  });

  it('exclusion is announced, never silent', () => {
    expect(runnerSrc).toMatch(/! blocked/);
  });
});
