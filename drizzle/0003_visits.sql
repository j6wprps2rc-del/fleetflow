-- FLEETFLOW — migration 0003: notifications for the visit workflow
-- Additive ONLY. No tables dropped, no data modified. Idempotent where possible.
-- Verified against the applied schema (0001 + 0002):
--   * app_role enum exists with values SUPER_ADMIN, PARKING_OPERATOR, SECURITY_OPERATOR, LAB_OPERATOR, SUPERVISOR
--   * vehicle_visits.id uuid, gate_movements is append-only (UPDATE/DELETE revoked from anon/authenticated)
--   * profiles RLS uses hardened is_admin() / is_active_employee() helpers (migration 0002)
--
-- Design note: transition validation itself lives in the application layer inside a
-- transaction with SELECT ... FOR UPDATE (src/lib/visits.ts). This migration only adds
-- the notifications table and its protections.

-- ═══════════ 1 · notifications table ═══════════
-- role-targeted notifications: e.g. "Vehicle X is now AT_SECURITY" targeted at
-- SECURITY_OPERATOR. Created by server actions (DB role bypasses RLS);
-- readable only by active employees whose role is the target_role.
create table if not exists public.notifications (
  id bigint generated always as identity primary key,
  visit_id uuid references public.vehicle_visits(id),
  target_role public.app_role not null,
  title text not null check (length(title) between 3 and 120),
  body text not null check (length(body) between 3 and 500),
  severity text not null default 'info'
    check (severity in ('info', 'warning', 'critical')),
  acknowledged_at timestamptz,
  acknowledged_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id)
);

create index if not exists idx_notifications_unread_by_role
  on public.notifications (target_role, created_at desc)
  where acknowledged_at is null;

-- ═══════════ 2 · client permissions ═══════════
-- Notifications are never created/destroyed/rewritten from the client API.
revoke insert, update, delete on public.notifications from anon, authenticated;

-- ═══════════ 3 · RLS ═══════════
alter table public.notifications enable row level security;

-- Read: only active employees, and only rows targeted at their own role.
drop policy if exists "notifications_read_role" on public.notifications;
create policy "notifications_read_role" on public.notifications
  for select
  using (
    public.is_active_employee()
    and target_role = (
      select p.role from public.profiles p where p.id = auth.uid()
    )
  );

-- Acknowledge: the acknowledge action updates ONLY (acknowledged_at, acknowledged_by).
-- The column-level grant below restricts updates to those two columns; the policy
-- requires the target-role match and an unacknowledged row. All other fields
-- (title, body, severity, target_role, visit_id, created_*) are not updatable by clients.
revoke update on public.notifications from anon, authenticated;
grant update (acknowledged_at, acknowledged_by) on public.notifications to authenticated;

drop policy if exists "notifications_ack_role" on public.notifications;
create policy "notifications_ack_role" on public.notifications
  for update
  using (
    public.is_active_employee()
    and target_role = (
      select p.role from public.profiles p where p.id = auth.
uid()
    )
    and acknowledged_at is null
  )
  with check (
    public.is_active_employee()
    and target_role = (
      select p.role from public.profiles p where p.id = auth.uid()
    )
  );

-- ═══════════ 4 · server helper: acknowledge (role-checked inside the app) ═══════════
-- Kept simple and safe: the app server (privileged DB role) acknowledges on behalf of
-- the user after verifying their session and role in code (assertRole). This function
-- exists for potential future use and documents intent; it is NOT executable by clients.
create or replace function public.acknowledge_notification(p_notification_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.notifications
     set acknowledged_at = now(),
         acknowledged_by = (
           select p.id from public.profiles p where p.id = auth.uid()
         )
     where id = p_notification_id
       and acknowledged_at is null;
end;
$$;

revoke execute on function public.acknowledge_notification(bigint) from public, anon, authenticated;
-- intentionally NOT granted to authenticated: invoked only by the privileged server role.
