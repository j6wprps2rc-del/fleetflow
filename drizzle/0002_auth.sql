-- FLEETFLOW — migration 0002: authentication integration & security hardening (v2)
-- Additive and fully idempotent: every statement is re-runnable. No tables dropped,
-- no data modified. Run via `npm run db:migrate` as the project's migration role
-- (postgres) on the DIRECT connection (port 5432).
--
-- Revisions in v2 (security review):
--   1. Schema-qualified (public.profiles) references inside all SECURITY DEFINER
--      function bodies; search_path pinned to `public`.
--   2. EXECUTE privileges on helper functions revoked from public/anon and granted
--      ONLY to `authenticated` (the role RLS policies are evaluated as).
--   3. profiles UPDATE restricted by column-level grants to (role, is_active),
--      admins only, and never the admin's own row — an ordinary user cannot change
--      their own role/is_active even via direct Supabase API requests.
--   4. profiles INSERT/DELETE revoked from client roles: profiles are created only
--      by the on_auth_user_created trigger.
--   5. handle_new_user(): safe fallbacks for missing/short full_name and missing
--      email (phone-auth users), 120-char cap, duplicate-profile tolerance via
--      ON CONFLICT DO NOTHING (unrelated errors still surface).
--   6. audit_logs read policy now reuses the hardened is_admin() helper
--      (covers the previously missed inactive-admin case).
--   7. profiles_update_admin made re-runnable (drop-if-exists first).
--
-- Note: migration 0001 remains untouched in history; its legacy recursive profiles
-- SELECT policy and its unqualified helper body are corrected HERE (create or
-- replace / drop policy), which is the safe evolution path for applied migrations.

-- ═══════════ 1 · Hardened SECURITY DEFINER helpers ═══════════
-- These helpers take no arguments and inspect only auth.uid() of the caller, so
-- they cannot be abused to probe other users' rows: they return a single boolean
-- and bypass profiles RLS only far enough to answer that boolean. Owned by the
-- migration role (postgres). EXECUTE is granted only to `authenticated`.

create or replace function public.is_admin() returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.profiles
     where id = auth.uid()
       and role = 'SUPER_ADMIN'
       and is_active
  )
$$;

create or replace function public.is_active_employee() returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.profiles
     where id = auth.uid()
       and is_active
  )
$$;

revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.is_active_employee() from public, anon;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_active_employee() to authenticated;

-- ═══════════ 2 · profiles RLS ═══════════

-- Replaces the legacy 0001 policy (which queried profiles inside its own
-- definition — PostgreSQL infinite-recursion error) with the helper-based one.
drop policy if exists "profiles_select_self_or_admin" on public.profiles;
create policy "profiles_select_self_or_admin" on public.profiles
  for select
  using (id = auth.uid() or public.is_admin());

-- Admins may update OTHER users' profiles only — never their own row. This
-- prevents self-promotion / self-deactivation through the client API. The
-- server app (DATABASE_URL + assertRole) performs its own checks and is not
-- affected by RLS.
drop policy if exists "profiles_update_admin" on public.profiles;
create policy "profiles_update_admin" on public.profiles
  for update
  using (public.is_admin() and id <> auth.uid())
  with check (public.is_admin() and id <> auth.uid());

-- Column-level defense in depth: even a super-admin session using a Supabase
-- client can touch only `role` and `is_active`. Every other profile column is
-- server-managed.
revoke update on public.profiles from anon, authenticated;
grant update (role, is_active) on public.profiles to authenticated;

-- Profiles are created exclusively by the on_auth_user_created trigger and
-- managed server-side; client roles may never insert or delete profiles.
revoke insert, delete on public.profiles from anon, authenticated;

-- ═══════════ 3 · display email for the user-management page ═══════════
alter table public.profiles add column if not exists email text;

-- ═══════════ 4 · handle_new_user() ═══════════
-- Auto-creates a least-privilege profile (SUPERVISOR) for every new Supabase
-- Auth user.
--   * SECURITY DEFINER is required because the trigger fires on auth.users
--     inserts performed by supabase_auth_admin, which cannot insert into
--     public.profiles itself. The function is owned by the migration role.
--   * Trigger functions (returns trigger) cannot be invoked directly by any
--     client, so no EXECUTE abuse surface exists.
--   * The role column is NEVER taken from user-controlled metadata.
create or replace function public.handle_new_user() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  -- Prefer a metadata full_name when present; trim and cap it for the
  -- length(full_name) between 2 and 120 check constraint.
  v_name := left(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), 120);

  -- Email local part fallback (email may be missing for phone-auth users).
  if length(v_name) < 2 then
    v_name := left(btrim(coalesce(new.email, '')), 120);
  end if;

  -- Stable placeholder derived from the user id — always satisfies the check.
  if length(v_name) < 2 then
    v_name := 'User ' || left(new.id::text, 8);
  end if;

  -- `role` intentionally omitted: it always defaults to SUPERVISOR.
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    v_name
  )
  -- Tolerate a pre-existing profile row (e.g. re-created auth user) without
  -- hiding any other error — only the unique conflict is swallowed.
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ═══════════ 5 · audit_logs read policy hardening ═══════════
-- The 0001 policy queried profiles directly and ignored is_active. Reuse the
-- hardened helper for consistency: only ACTIVE super admins read audit logs.
drop policy if exists "audit_read_admins" on public.audit_logs;
create policy "audit_read_admins" on public.audit_logs
  for select
  using (public.is_admin());
