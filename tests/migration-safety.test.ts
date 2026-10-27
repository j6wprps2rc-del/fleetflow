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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const runnerSrc = readFileSync(join(process.cwd(), 'scripts', 'migrate.ts'), 'utf8');

const BLOCK_FILE = '0004_device_ingestion.sql';
const drizzleDir = join(process.cwd(), 'drizzle');

describe('migration runner safety (device-ingestion exclusion)', () => {
  it('the blocked migration file exists in drizzle/ (guard is meaningful)', () => {
    expect(existsSync(drizzleDir)).toBe(true);
    expect(readdirSync(drizzleDir)).toContain(BLOCK_FILE);
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

  it('runner would otherwise see the blocked file (sorted order places it after 0003)', () => {
    // If the blocked file were ever the ONLY sql file, the filtered list is
    // empty and the runner must not crash — covered by 'No applicable
    // migration files' path.
    expect(readdirSync(drizzleDir).filter((f) => f.endsWith('.sql')).length).toBeGreaterThanOrEqual(4);
  });
});
