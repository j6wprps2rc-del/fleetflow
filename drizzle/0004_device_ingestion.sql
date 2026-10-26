-- FLEETFLOW — migration 0004: BLE gateway registry & device ingestion (additive only)
-- Depends on: 0001 (zones, vehicles, vehicle_visits, gate_movements, is_active_employee)
--              0003 (public.current_app_role() helper)
-- Rerunnable: if-not-exists everywhere; every policy drop-if-exists first.
-- NOT APPLIED to any database yet. Apply with `npm run db:migrate` (after approval).
-- Rollback: reverse-order drops only — no existing rows are modified by this file.

-- ═══════════ 1 · gateways (BLE receiver registry) ═══════════
-- Fixed BLE receivers mounted in zones. Devices authenticate with an API key
-- that is stored ONLY as a SHA-256 hash; the plaintext key is shown once at
-- creation/rotation and never persisted.
create table if not exists public.gateways (
  id uuid primary key default gen_random_uuid(),
  label text not null unique check (length(label) between 3 and 80),
  zone_id uuid not null references public.zones(id),
  api_key_hash text not null unique,
  is_active boolean not null default true,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists gateways_zone_idx on public.gateways (zone_id);

alter table public.gateways enable row level security;

-- Clients may never create, modify, or delete gateways — server actions only.
revoke insert, update, delete on public.gateways from anon, authenticated;

-- Read: any active employee (uses the hardened SECURITY DEFINER helper from 0003,
-- so the policy cannot recurse into profiles RLS).
drop policy if exists "gateways_read_employees" on public.gateways;
create policy "gateways_read_employees" on public.gateways
  for select
  using (public.current_app_role() is not null);

-- ═══════════ 2 · vehicle BLE tag binding ═══════════
-- Optional binding of a physical BLE tag id to a vehicle. Unique when present.
alter table public.vehicles add column if not exists ble_tag_id text;

create unique index if not exists vehicles_ble_tag_idx
  on public.vehicles (ble_tag_id)
  where ble_tag_id is not null;

-- ═══════════ 3 · last electronic detection on the visit ═══════════
-- Deliberately SEPARATE from the employee-confirmed workflow stage: the visit
-- keeps both the confirmed status and the last device-detected zone + time.
alter table public.vehicle_visits add column if not exists last_detected_zone_id uuid
  references public.zones(id);
alter table public.vehicle_visits add column if not exists last_detected_at timestamptz;

create index if not exists vehicle_visits_last_detected_idx
  on public.vehicle_visits (last_detected_at desc)
  where last_detected_at is not null;
