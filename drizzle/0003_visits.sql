-- FLEETFLOW — migration 0003: visit workflow & notifications (additive only)
-- Reviewed revision (v2). This file has NEVER been applied to any database
-- (branch-only), so revising it in a normal commit is safe — no applied-migration
-- history is rewritten.
-- Fully rerunnable: every policy is preceded by drop-if-exists, indexes use
-- if-not-exists, functions use create-or-replace, columns use add-if-not-exists.
-- No tables dropped, no data modified.

-- ═══════════ 0 · hardened role helper ═══════════
-- SECURITY DEFINER so notification policies do not depend on the profiles RLS
-- policies (which could otherwise make reads fail if profiles policies change).
-- Returns NULL for anonymous, missing-profile, or inactive users — all three
-- correctly fail the equality checks below. search_path pinned; EXECUTE granted
-- only to authenticated.
create or replace function public.current_app_role() returns public.app_role
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid() and is_active
$$;

revoke execute on function public.current_app_role() from public, anon;
grant execute on function public.current_app_role() to authenticated;

-- ═══════════ 1 · notifications table ═══════════
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
drop policy if exists "notifications_read_own_role" on public.notifications;
create policy "notifications_read_own_role" on public.notifications
  for select
  using (target_role = public.current_app_role());

-- Acknowledge (defense in depth — clients have NO update privilege after the
-- revoke below; this policy still guards any future re-grant): own role only,
-- unacknowledged rows only, and the acknowledger must be the caller.
drop policy if exists "notifications_ack_own_role" on public.notifications;
create policy "notifications_ack_own_role" on public.notifications
  for update
  using (
    target_role = public.current_app_role()
    and acknowledged_at is null
  )
  with check (
    target_role = public.current_app_role()
    and acknowledged_by = auth.uid()
  );

-- Clients may never insert, delete, or update notifications. Acknowledgement
-- happens exclusively through the server action (privileged DB role), which
-- sets acknowledged_at = now() itself — a client cannot forge a timestamp.
revoke insert, delete on public.notifications from anon, authenticated;
revoke update on public.notifications from anon, authenticated;

-- ═══════════ 2 · acknowledgement semantics trigger ═══════════
-- DB-level enforcement of acknowledgement semantics for ALL roles (including
-- the server role): only the two acknowledgement columns may change, only a
-- still-unacknowledged row may be acknowledged, and acknowledged_at is forced
-- to now() — arbitrary timestamps are impossible even for a buggy caller.
create or replace function public.enforce_notification_ack() returns trigger
language plpgsql
as $$
begin
  if new.target_role <> old.target_role
     or new.title <> old.title
     or new.body <> old.body
     or new.severity <> old.severity
     or new.visit_id is distinct from old.visit_id
     or new.created_at <> old.created_at then
    raise exception 'notifications: only acknowledgement fields may change';
  end if;

  if old.acknowledged_at is not null then
    raise exception 'notifications: already acknowledged';
  end if;

  if new.acknowledged_by is null then
    raise exception 'notifications: acknowledged_by is required';
  end if;

  -- Force the server timestamp: a caller cannot choose it.
  new.acknowledged_at := now();
  return new;
end;
$$;

drop trigger if exists trg_notifications_ack on public.notifications;
create trigger trg_notifications_ack
  before update on public.notifications
  for each row execute function public.enforce_notification_ack();

-- ═══════════ 3 · one active visit per vehicle ═══════════
-- Hard DB guarantee against concurrent duplicate registration: exactly one
-- non-terminal (active) visit per vehicle. Terminal statuses free the vehicle.
create unique index if not exists vehicle_visits_one_active_idx
  on public.vehicle_visits (vehicle_id)
  where status not in ('COMPLETED', 'REJECTED', 'CANCELLED');

-- ═══════════ 4 · registration idempotency ═══════════
-- A client-supplied key makes double-click / network-retry registration safe:
-- the application returns the original visit instead of creating a duplicate.
alter table public.vehicle_visits
  add column if not exists idempotency_key text;
create unique index if not exists vehicle_visits_idempotency_idx
  on public.vehicle_visits (idempotency_key)
  where idempotency_key is not null;
