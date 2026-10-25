# FLEETFLOW — Smart Vehicle Movement System

Industrial vehicle-entry, zone-tracking and gate-management platform built with
**Next.js 14 (App Router) + TypeScript strict + Tailwind CSS** and **Supabase PostgreSQL**.

> **Status — Checkpoint 3 complete on `feature/visit-workflow`** (not yet merged to main).
> Implemented: Supabase Auth + middleware route protection, server-side RBAC, dashboard,
> user management, audit trail viewer, visit registration (duplicate- and idempotency-safe),
> transactional workflow transitions with row locks and post-lock state re-validation,
> append-only gate movements, role-targeted notifications with trigger-enforced
> acknowledgement semantics, notifications inbox, visits list/search/pagination,
> visit details + timeline. **Not implemented:** BLE/device ingestion, gateway registry,
> device simulator, reports/analytics pages. **No real GPS or BLE hardware tracking is
> claimed anywhere in this system.**

## Tech stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js 14 App Router, TypeScript strict mode |
| UI | Tailwind CSS (dark navy/graphite design tokens), lucide-react icons |
| Auth | Supabase Auth (`@supabase/ssr`) — cookie sessions, middleware-refreshed |
| Database | Supabase PostgreSQL via `pg` (server-only; Drizzle available) |
| Runtime connection | Supabase Transaction Pooler — port **6543** (SSL) |
| Migration connection | Supabase direct — port **5432** |
| Tests | Vitest (unit + static SQL characterization) |

## Security model

- **Server-side authorization is enforced in code** for every mutation: `requireUser`
  (pages) and `assertRole` (server actions) verify the Supabase Auth session server-side
  and read the role from the `profiles` table. UI hiding is cosmetic only.
- **The app server connects as the privileged database role** (`DATABASE_URL`). That
  role owns the schema and therefore **bypasses RLS**. This is intentional: all
  authorization decisions are made in the app layer *before* the privileged query runs.
  RLS policies exist as a second boundary for any direct Supabase-client (anon-key)
  access, where they are fully enforced.
- **Transitions**: `SELECT … FOR UPDATE` on the visit row, then role check against the
  post-lock state, then state-machine re-validation — two concurrent conflicting
  transitions cannot both apply. `gate_movements`, status update, audit entry, and
  notifications are written in the same transaction (rollback removes all partial writes).
- **Duplicate/idempotency**: DB partial unique indexes (one active visit per vehicle;
  unique idempotency key) are the source of truth; application code resolves 23505
  races to the typed results rather than surfacing raw errors.
- **Notifications**: clients have **no** insert/update/delete privileges. Acknowledgement
  runs through a server action that sets `acknowledged_at = now()` itself; a BEFORE UPDATE
  trigger (`enforce_notification_ack`) enforces the same semantics at the DB layer for
  every role, including forcing `now()` — a client cannot forge timestamps or alter
  title/body/severity/target/visit/created fields.
- **Append-only history**: `gate_movements` and `audit_logs` reject UPDATE/DELETE from
  client roles; profiles are created exclusively by the auth trigger.

### Verify on your live database (read-only)

After applying migration 0003, run in the Supabase SQL Editor:

```sql
-- Expect policies: notifications_read_own_role (select), notifications_ack_own_role (update)
select policyname, polcmd from pg_policies
where schemaname='public' and tablename='notifications';

-- Expect: no INSERT/UPDATE/DELETE granted to anon or authenticated
select grantee, privilege_type from information_schema.role_table_grants
where table_schema='public' and table_name='notifications' and grantee in ('anon','authenticated');

-- Expect: index definitions present (one-active-visit + idempotency)
select indexname, indexdef from pg_indexes
where schemaname='public' and tablename in ('notifications','vehicle_visits')
order by tablename, indexname;
```

## Setup

### 1 · Environment variables

Copy `.env.example` → `.env` and fill from the Supabase dashboard
(Project Settings → Database / API). Names (never commit real values):

- `DATABASE_URL` — **transaction pooler (port 6543)** — app runtime
- `DATABASE_URL_MIGRATIONS` — **direct (port 5432)** — migrations only
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- Optional: `SUPABASE_SERVICE_ROLE_KEY` (unused by the app), `FLEETFLOW_DEFAULT_TZ`

### 2 · Install, migrate, verify

```bash
npm install
npm run db:migrate   # applies drizzle/*.sql in order via the DIRECT connection
npm run db:verify    # read-only connection check (never prints secrets)
```

Migration 0003 has **not been applied yet**. It is additive-only, fully rerunnable
(every policy/trigger uses drop-if-exists), and creates: the `notifications` table
with role-targeted RLS + the acknowledgement-semantics trigger, the one-active-visit
partial unique index, and the idempotency-key column + index.

**Rollback strategy** (if ever needed, after approval only): 0003 adds no data
transformations, so rollback is limited to `drop trigger/policies/indexes/table`
in the reverse order of the file — no data is lost because no existing rows are touched.

### 3 · First administrator

1. Supabase dashboard → **Authentication → Users → Add user** (strong password).
2. The `on_auth_user_created` trigger creates a `profiles` row with the least-privileged
   `SUPERVISOR` role automatically.
3. Promote yourself once in the SQL Editor:

```sql
update public.profiles set role = 'SUPER_ADMIN' where email = 'you@company.com';
```

### 4 · Run & check

```bash
npm run dev        # http://localhost:3000 → redirects to /login or /dashboard
npm run typecheck
npm run lint
npm run test
npm run build
```

### Testing scope (honest)

`npm run test` runs unit + static characterization tests (no database needed):
plate normalization, RBAC map, workflow state machine, SQL security properties
of migrations 0002/0003, visit schemas, transition authorization matrix, gate
movement mapping, acknowledge binding regression.

**Not covered by automated tests:** runtime behavior of the acknowledgement
trigger and RLS policies against a live database. These require an isolated
integration test database; the postgres read-only connector is not connected
in this environment, so this remains a documented gap.

## Deployment (Vercel)

1. Import the repo; add `DATABASE_URL` (6543), `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY` for Production/Preview/Development.
   Add `DATABASE_URL_MIGRATIONS` only if running migrations from CI.
2. Run `npm run db:migrate` from your machine once before the first deploy
   that includes migration 0003 (with your approval first).
3. Middleware-protected routes need the Supabase env vars at **build time** too.

**Operational readiness disclaimer:** a passing `npm run build` is *code*
readiness only. Production readiness additionally requires: migration 0003
applied, admin bootstrap performed, live RLS verification queries run, and
real user acceptance testing of the full workflow.

## Troubleshooting

- **Sign-in loops / redirect to /login**: `NEXT_PUBLIC_SUPABASE_URL`/`ANON_KEY`
  missing at build time, or the middleware matcher excludes your route.
- **`notifications` does not exist**: migration 0003 has not been applied —
  run `npm run db:migrate` (transitions will fail with relation-not-found otherwise).
- **Transition fails with "not allowed"**: another operator just moved the visit —
  the UI shows the post-lock state; refresh.
- **Duplicate registration conflict**: intended — a vehicle with an active visit
  cannot start a second one; open the active visit from the error message link.
- **Admin user management empty**: you must first promote yourself via SQL (step 3).

## Roadmap

- [x] Checkpoint 1 — scaffold, schema, migrations, health check, test harness
- [x] Checkpoint 2 — Auth, RBAC, app shell, dashboard, user management, audit
- [x] Security review — hardened migrations 0001/0002 + SQL security tests
- [x] Checkpoint 3 (branch) — visit registration, transitions, gate movements,
      notifications, audit viewer, visits UI — **review pending, merge to main
      requires explicit approval**
- [ ] Checkpoint 4 — device ingestion API (BLE receivers), gateway registry,
      clearly-labeled simulator
- [ ] Checkpoint 5 — reports/analytics, history pages
