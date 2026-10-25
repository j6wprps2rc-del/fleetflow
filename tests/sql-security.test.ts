/**
 * Static security characterization tests for the FLEETFLOW migrations.
 * These parse the committed SQL files and assert the security properties
 * that the runtime review required. They run with the rest of the unit
 * suite (`npm run test`) and need no database connection.
 *
 * Note: these tests verify what the migrations DECLARE. Live-database
 * verification queries are documented in README.md (§ Security evidence).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const sql0001 = readFileSync(join(root, 'drizzle', '0001_init.sql'), 'utf8');
const sql0002 = readFileSync(join(root, 'drizzle', '0002_auth.sql'), 'utf8');

/** Strip `--` line comments so assertions check executable SQL, not prose. */
function code(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

const c1 = code(sql0001);
const c2 = code(sql0002);

describe('0002 — SECURITY DEFINER helpers', () => {
  it('pins search_path on both helper functions', () => {
    expect(c2.match(/set search_path = public/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('schema-qualifies profiles inside the helper function bodies', () => {
    expect(c2).toMatch(/create or replace function public\.is_admin\(\)[\s\S]*?from public\.profiles/);
    expect(c2).toMatch(
      /create or replace function public\.is_active_employee\(\)[\s\S]*?from public\.profiles/
    );
  });

  it('revokes EXECUTE from public/anon and grants it to authenticated only', () => {
    expect(c2).toMatch(/revoke execute on function public\.is_admin\(\) from public, anon/);
    expect(c2).toMatch(
      /revoke execute on function public\.is_active_employee\(\) from public, anon/
    );
    expect(c2).toMatch(/grant execute on function public\.is_admin\(\) to authenticated/);
    expect(c2).toMatch(
      /grant execute on function public\.is_active_employee\(\) to authenticated/
    );
  });
});

describe('0002 — profiles protection', () => {
  it('is idempotent: drop-if-exists precedes every create policy/trigger; alter uses if-not-exists', () => {
    expect(c2).toMatch(
      /drop policy if exists "profiles_select_self_or_admin"[\s\S]*?create policy "profiles_select_self_or_admin"/
    );
    expect(c2).toMatch(
      /drop policy if exists "profiles_update_admin"[\s\S]*?create policy "profiles_update_admin"/
    );
    expect(c2).toMatch(/add column if not exists email text/);
    expect(c2).toMatch(
      /drop trigger if exists on_auth_user_created[\s\S]*?create trigger on_auth_user_created/
    );
  });

  it('replaces the recursive profiles SELECT policy with the helper (no direct profiles subquery)', () => {
    const policy = c2.match(/create policy "profiles_select_self_or_admin"[\s\S]*?;/)?.[0] ?? '';
    expect(policy).toContain('id = auth.uid()');
    expect(policy).toContain('public.is_admin()');
    expect(policy).not.toMatch(/exists\s*\(\s*select[\s\S]*?from profiles\b/);
  });

  it('blocks admins from modifying their own profile row', () => {
    const policy = c2.match(/create policy "profiles_update_admin"[\s\S]*?;/)?.[0] ?? '';
    expect(policy).toContain('id <> auth.uid()');
    expect(policy).toContain('public.is_admin()');
  });

  it('restricts client UPDATE to (role, is_active) columns and blocks INSERT/DELETE', () => {
    expect(c2).toMatch(/revoke update on public\.profiles from anon, authenticated/);
    expect(c2).toMatch(/grant update \(role, is_active\) on public\.profiles to authenticated/);
    expect(c2).toMatch(/revoke insert, delete on public\.profiles from anon, authenticated/);
  });
});

describe('0002 — handle_new_user()', () => {
  const fn = c2.match(/create or replace function public\.handle_new_user\(\)[\s\S]*?\$\$;/)?.[0] ?? '';

  it('never reads role from user-controlled metadata', () => {
    expect(fn).not.toContain("->> 'role'");
    expect(fn).not.toContain('role =');
  });

  it('inserts only (id, email, full_name) so role defaults to SUPERVISOR', () => {
    expect(fn).toMatch(/insert into public\.profiles \(id, email, full_name\)/);
  });

  it('falls back safely for missing/short full_name and missing email', () => {
    expect(fn).toContain("btrim(coalesce(new.raw_user_meta_data ->> 'full_name', ''))");
    expect(fn).toContain("btrim(coalesce(new.email, ''))");
    expect(fn).toContain('length(v_name) < 2');
    expect(fn).toMatch(/'User ' \|\| left\(new\.id::text, 8\)/);
  });

  it('caps names at 120 characters to satisfy the check constraint', () => {
    expect((fn.match(/, 120\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('tolerates duplicate profiles without hiding unrelated errors', () => {
    expect(fn).toContain('on conflict (id) do nothing');
    expect(fn).not.toMatch(/\bexception\b/);
  });
});

describe('0002 — audit_logs policy hardening', () => {
  it('reuses the hardened is_admin() helper', () => {
    const policy = c2.match(/create policy "audit_read_admins"[\s\S]*?;/)?.[0] ?? '';
    expect(policy).toContain('public.is_admin()');
  });
});

describe('0001 — known legacy issues (documented, corrected by 0002)', () => {
  it('contains the original recursive profiles policy that 0002 replaces', () => {
    expect(c1).toMatch(/exists \(select 1 from profiles p\)/);
  });

  it('profiles is created with the least-privilege SUPERVISOR default', () => {
    expect(c1).toContain("role app_role not null default 'SUPERVISOR'");
    expect(c1).toContain('length(full_name) between 2 and 120');
  });
});
