-- FLEETFLOW — migration 0003: visit workflow & notifications (additive only)
-- No tables dropped, no data modified. Idempotent where possible.
-- Matches existing schema exactly: reuses app_role, zone_kind, movement_direction,
-- movement_method, workflow_status enums; FKs to vehicle_visits/zones/profiles.

-- ═══════════ 1 · notifications ═══════════
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  target_role public.app_role not null,
  visit_id uuid references public.vehicle_visits(id),
  title text not null check (length(title) between 3 and 160),
  body text not null check (length(body) between 3 and 500),
  severity text not null default 'info' check (severity in ('info', 'warning', 'critical')),
  acknowledged_at timestamptz,
  acknowledged_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists notifications_inbox_idx
  on public.notifications (target_role, created_at desc)
  where acknowledged_at is null;
create index if not exists notifications_visit_idx
  on public.notifications (visit_id, created_at desc);

alter table public.notifications enable row level security;

-- Read: active employees see only notifications targeted at their own role.
create policy "notifications_read_own_role" on public.notifications
  for select
  using (
    target_role = (
      select role from public.profiles where id = auth.uid() and is_active
    )
  );

-- Acknowledge: only a notification targeted at my role, only if not yet
-- acknowledged. The WITH CHECK requires myself as the acknowledger.
create policy "notifications_ack_own_role" on public.notifications
  for update
  using (
    target_role = (
      select role from public.profiles where id = auth.uid() and is_active
    )
    and acknowledged_at is null
  )
  with check (
    acknowledged_by = auth.uid()
    and acknowledged_at is not null
  );

-- Clients may never insert or delete notifications; the only client-visible
-- UPDATE is acknowledge — enforced by column-level grants below.
revoke insert, delete on public.notifications from anon, authenticated;
revoke update on public.notifications from anon, authenticated;
grant update (acknowledged_at, acknowledged_by) on public.notifications to authenticated;

-- ═══════════ 2 · one active visit per vehicle ═══════════
-- Prevents registering a new visit for a vehicle that already has one in
-- progress (concurrent duplicate protection at the DB level).
create unique index if not exists vehicle_visits_one_active_idx
  on public.vehicle_visits (vehicle_id)
  where status not in ('COMPLETED', 'REJECTED', 'CANCELLED');

-- ═══════════ 3 · idempotency for registration ═══════════
-- A client-supplied idempotency key makes double-click / retry registration safe.
alter table public.vehicle_visits
  add column if not exists idempotency_key text;
create unique index if not exists vehicle_visits_idempotency_idx
  on public.vehicle_visits (idempotency_key)
  where idempotency_key is not null;
