-- FLEETFLOW — initial schema (migration 0001)
-- Target: Supabase PostgreSQL. Depends on the auth.users table provided by Supabase Auth.
-- Conventions: timestamptz everywhere; append-only history tables; RLS enabled on all tables.

create extension if not exists "pgcrypto";

-- ═══════════════════ enums ═══════════════════
create type app_role as enum (
  'SUPER_ADMIN', 'PARKING_OPERATOR', 'SECURITY_OPERATOR', 'LAB_OPERATOR', 'SUPERVISOR'
);

create type zone_kind as enum ('PARKING', 'SECURITY', 'LABORATORY');

create type workflow_status as enum (
  'REGISTERED', 'WAITING_FOR_SECURITY', 'AT_SECURITY', 'WAITING_FOR_LAB',
  'AT_LAB', 'COMPLETED', 'ON_HOLD', 'REJECTED', 'CANCELLED'
);

create type movement_direction as enum ('ENTRY', 'EXIT');

create type movement_method as enum ('MANUAL_CONFIRMATION', 'DEVICE_DETECTION', 'SIMULATED');

-- ═══════════════ helper functions ═══════════════
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- SECURITY DEFINER avoids infinite recursion when RLS policies on `profiles` query `profiles`.
create or replace function is_active_employee() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and is_active)
$$;

-- ═══════════════ users / roles ═══════════════
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null check (length(full_name) between 2 and 120),
  role app_role not null default 'SUPERVISOR',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trg_profiles_updated_at before update on profiles
  for each row execute function set_updated_at();

-- ═══════════════ zones ═══════════════
create table zones (
  id uuid primary key default gen_random_uuid(),
  code zone_kind not null unique,
  name text not null,
  display_order smallint not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into zones (code, name, display_order) values
  ('PARKING', 'Parking', 1),
  ('SECURITY', 'Security', 2),
  ('LABORATORY', 'Laboratory', 3);

-- ═══════════════ companies ═══════════════
create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(name) between 2 and 160),
  contact_name text,
  contact_phone text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ═══════════════ vehicles ═══════════════
create table vehicles (
  id uuid primary key default gen_random_uuid(),
  plate_normalized text not null unique,
  plate_display text not null,
  vehicle_type text,
  created_at timestamptz not null default now(),
  check (plate_normalized = upper(plate_normalized) and length(plate_normalized) between 2 and 20)
);

create index on vehicles (plate_normalized);

-- ═══════════════ drivers ═══════════════
create table drivers (
  id uuid primary key default gen_random_uuid(),
  full_name text not null check (length(full_name) between 2 and 120),
  phone text,
  license_number text,
  company_id uuid references companies(id),
  created_at timestamptz not null default now()
);

create index on drivers (company_id);

-- ═══════════════ vehicle visits ═══════════════
create table vehicle_visits (
  id uuid primary key default gen_random_uuid(),
  visit_code text not null unique
    default ('V-' || to_char(now(), 'YYYYMMDD') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)),
  vehicle_id uuid not null references vehicles(id),
  company_id uuid not null references companies(id),
  driver_id uuid references drivers(id),
  registered_by uuid not null references profiles(id),
  status workflow_status not null default 'REGISTERED',
  notes text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trg_visits_updated_at before update on vehicle_visits
  for each row execute function set_updated_at();

create index on vehicle_visits (status) where status <> 'COMPLETED';
create index on vehicle_visits (created_at desc);
create index on vehicle_visits (company_id, created_at desc);

-- ═══════════════ gate entry/exit movements (APPEND-ONLY) ═══════════════
create table gate_movements (
  id bigint generated always as identity primary key,
  visit_id uuid not null references vehicle_visits(id),
  zone_id uuid not null references zones(id),
  direction movement_direction not null,
  method movement_method not null default 'MANUAL_CONFIRMATION',
  confirmed_by uuid references profiles(id),
  reason text,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index on gate_movements (visit_id, occurred_at);
create index on gate_movements (zone_id, direction, occurred_at desc);

-- ═══════════════ audit logs (APPEND-ONLY) ═══════════════
create table audit_logs (
  id bigint generated always as identity primary key,
  actor uuid references profiles(id),
  action text not null,
  target_table text not null,
  target_id text,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index on audit_logs (created_at desc);
create index on audit_logs (actor, created_at desc);

-- ═══════════════ application settings ═══════════════
create table application_settings (
  key text primary key,
  value jsonb not null,
  updated_by uuid references profiles(id),
  updated_at timestamptz not null default now()
);

-- ═══════════════ history protection ═══════════════
-- Ordinary users must never rewrite or delete history.
revoke update, delete on gate_movements from anon, authenticated;
revoke update, delete on audit_logs from anon, authenticated;
revoke delete on vehicle_visits from anon, authenticated;
revoke delete on vehicles, drivers from anon, authenticated;

-- ═══════════════ Row Level Security baseline ═══════════════
alter table profiles enable row level security;
alter table zones enable row level security;
alter table companies enable row level security;
alter table vehicles enable row level security;
alter table drivers enable row level security;
alter table vehicle_visits enable row level security;
alter table gate_movements enable row level security;
alter table audit_logs enable row level security;
alter table application_settings enable row level security;

create policy "profiles_select_self_or_admin" on profiles
  for select using (
    id = auth.uid()
    or exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'SUPER_ADMIN')
  );

create policy "zones_read_employees" on zones
  for select using (is_active_employee());

create policy "companies_read_employees" on companies
  for select using (is_active_employee());

create policy "vehicles_read_employees" on vehicles
  for select using (is_active_employee());

create policy "drivers_read_employees" on drivers
  for select using (is_active_employee());

create policy "visits_read_employees" on vehicle_visits
  for select using (is_active_employee());

create policy "movements_read_employees" on gate_movements
  for select using (is_active_employee());

create policy "audit_read_admins" on audit_logs
  for select using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'SUPER_ADMIN')
  );

create policy "settings_read_employees" on application_settings
  for select using (is_active_employee());
