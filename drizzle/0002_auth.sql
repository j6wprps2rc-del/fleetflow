-- FLEETFLOW — migration 0002: authentication integration & admin management
-- Additive only: no tables dropped, no data removed. Safe to re-run guarded parts.

-- Security-definer admin helper. Avoids the infinite-recursion error caused by
-- a policy on `profiles` that queries `profiles` inside its own definition.
create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and role = 'SUPER_ADMIN' and is_active
  )
$$;

-- Replace the recursion-prone profiles select policy with the helper-based one.
drop policy if exists "profiles_select_self_or_admin" on profiles;
create policy "profiles_select_self_or_admin" on profiles
  for select using (id = auth.uid() or is_admin());

-- Super admins may manage roles / activation (for any Supabase-client access).
create policy "profiles_update_admin" on profiles
  for update using (is_admin()) with check (is_admin());

-- Email for display in the user management page.
alter table profiles add column if not exists email text;

-- Auto-create a profile row for every new Supabase Auth user.
-- Default role is SUPERVISOR (least privilege); an admin promotes users later.
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
