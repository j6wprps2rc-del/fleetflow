# FLEETFLOW — Smart Vehicle Movement System

Industrial vehicle-entry, zone-tracking and gate-management platform built with
**Next.js 14 (App Router) + TypeScript strict + Tailwind CSS** and **Supabase PostgreSQL**.

> **Current status — Checkpoint 2 (Authentication, RBAC & App Shell) + security hardening
> review of migrations 0001/0002.** Implemented: real Supabase Auth sign-in, cookie-session
> middleware protection, server-side RBAC enforced in server actions (`assertRole`),
> hardened profile auto-creation trigger, admin user management with audit logging,
> premium app shell, operations dashboard with live DB counts, workflow state-machine
> logic, and static security tests for the migration files.
> **Not yet implemented:** visit registration UI, gate movement confirmations, notifications,
> BLE ingestion + simulator, history/reports pages. No GPS or BLE hardware tracking is claimed.

## Tech stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js 14 App Router, TypeScript strict mode |
| UI | Tailwind CSS (dark navy/graphite design tokens), lucide-react icons |
| Auth | Supabase Auth (`@supabase/ssr`) — cookie sessions, middleware-refreshed |
| Database | Supabase PostgreSQL (`pg` server-only; Drizzle available) |
| Runtime connection | Supabase Transaction Pooler — port **6543** |
| Migration connection | Supabase direct — port **5432** |
| Tests | Vitest unit tests + static migration security tests |

## Security model (honest scope)

- **Server-side authorization is enforced in code**: every privileged server action calls
  `assertRole([...])`, which verifies the Supabase Auth session server-side and the role
  from the `profiles` table. UI hiding is cosmetic only.
- **RLS** is enabled on every table. `profiles` SELECT uses the `is_admin()` helper — the
  legacy recursive policy from migration 0001 is replaced in 0002. Append-only tables
  (`gate_movements`, `audit_logs`) reject `UPDATE`/`DELETE`.
- **Profiles protection** (migration 0002 v2):
  - Client roles cannot `INSERT`/`DELETE` profiles at all; profiles are created only by
    the `on_auth_user_created` trigger.
  - Client `UPDATE` is restricted by column-level grants to `role` and `is_active` — an
    ordinary authenticated user **cannot** change their own role or `is_active` through
    direct Supabase API requests, and even an admin cannot modify their **own** profile
    row through the client API (policy requires `id <> auth.uid()`).
  - `handle_new_user()` never reads `role` from user-controlled metadata; new users always
    default to `SUPERVISOR` (least privilege). Missing/short names and missing emails fall
    back safely; duplicate profile rows are tolerated via `ON CONFLICT DO NOTHING` without
    hiding unrelated errors.
- **SECURITY DEFINER helpers** (`is_admin()`, `is_active_employee()`): schema-qualified
  references, pinned `search_path = public`, owned by the migration role, `EXECUTE` granted
  only to `authenticated`. They take no arguments and answer a single boolean about the
  caller — no bypass surface beyond that boolean.
- The app server connects with `DATABASE_URL` (privileged role). Because of this, **all data
  access goes through server components / server actions / route handlers that perform
  their own authorization checks**; RLS additionally protects any direct Supabase-client
  (anon key) access. `SUPABASE_SERVICE_ROLE_KEY` is **not required**.
- No credentials are hardcoded; `.env` is git-ignored; the DB client is `server-only`.

### Security evidence — verify on your live database (read-only queries)

Run these in the Supabase **SQL Editor** after applying migration 0002. They are pure reads:

```sql
-- 1. Profiles policies (expect: select self-or-admin, update admin-and-not-self)
select policyname, polcmd, pg_get_expr(polqual, polrelid) as using_expr
from pg_policies where schemaname = 'public' and tablename = 'profiles';

-- 2. Column-level update grant (expect authenticated: UPDATE with column list role,is_active)
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'profiles';

-- 3. Privilege spot-checks (expect false, false, false)
select has_table_privilege('authenticated', 'public.profiles', 'DELETE') as can_delete,
       has_table_privilege('authenticated', 'public.profiles', 'INSERT') as can_insert,
       has_table_privilege('anon', 'public.profiles', 'UPDATE') as anon_can_update;

-- 4. Helper function EXECUTE grants
select proname, proconfig from pg_proc
where pronamespace = 'public'::regnamespace and proname in ('is_admin', 'is_active_employee');
```

### About migration 0001

Migration 0001 is **already applied** and stays untouched in history. Its known issues —
the recursive `profiles` SELECT policy, the unqualified `is_active_employee()` body, and
the `audit_logs` policy that ignored `is_active` — are corrected **inside migration 0002**
(`create or replace` / `drop policy`), which is the safe evolution path: never edit an
already-applied migration file.

## Prerequisites

- Node.js ≥ 20
- A Supabase project with the FLEETFLOW schema applied (migrations 0001 + 0002)

## 1 · Environment variables

Local: copy `.env.example` → `.env` and fill from the Supabase dashboard
(Project Settings → Database / API):

- `DATABASE_URL` — **transaction pooler (port 6543)** — app runtime
- `DATABASE_URL_MIGRATIONS` — **direct (port 5432)** — migrations only
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`

`SUPABASE_SERVICE_ROLE_KEY` is optional and currently unused.

## 2 · Install, migrate, verify

```bash
npm install
npm run db:migrate   # applies drizzle/*.sql in order (0001, 0002, …)
npm run db:verify    # prints database name, server time, table count — never secrets
```

**If you already applied the earlier revision of 0002** (commit `375c4fc`): the runner will
skip it because `__migrations` already contains `0002_auth.sql`. The corrected file is
fully idempotent, so simply run its content once in the Supabase **SQL Editor** — every
statement re-applies safely. Check with `select * from __migrations;` first.

## 3 · Create the first administrator (secure bootstrap — no hardcoded passwords)

1. Supabase dashboard → **Authentication → Users → Add user**: create your own account
   (e.g. `admin@company.com`) with a strong password.
2. The `on_auth_user_created` trigger automatically creates a `profiles` row with the
   least-privileged role `SUPERVISOR` (never from user metadata).
3. Promote yourself exactly once, in Supabase → **SQL Editor**:

   ```sql
   update public.profiles set role = 'SUPER_ADMIN' where email = 'admin@company.com';
   ```

4. Sign in at `/login`. From **Users** (super admin only) you manage roles and activation
   for everyone else; every change is written to the append-only `audit_logs` table.

## 4 · Run locally

```bash
npm run dev          # http://localhost:3000 → redirects to /login or /dashboard
```

- `/login` — real Supabase Auth sign-in
- `/dashboard` — operations dashboard (live DB counts)
- `/users` — super-admin user management (role + activation, audit-logged)
- `/api/health` — secret-free health endpoint

## 5 · Checks

```bash
npm run typecheck   # tsc --noEmit (strict)
npm run lint        # eslint (next/core-web-vitals)
npm run test        # vitest: plate + rbac + workflow + migration security tests
```

## 6 · Deployment (Vercel)

1. Import the repo into Vercel.
2. **Settings → Environment Variables**: add `DATABASE_URL` (6543 pooler),
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` for Production/Preview/Development.
   Add `DATABASE_URL_MIGRATIONS` only if you run migrations from CI.
3. Run `npm run db:migrate` from your machine before the first deploy that needs the schema.
4. Note: middleware-protected routes require the Supabase env vars at build time too.

## Roadmap

- [x] Checkpoint 1 — scaffold, schema, migrations, health check, test harness
- [x] Checkpoint 2 — Supabase Auth, middleware route protection, RBAC, user management,
      audit logging, app shell, dashboard, workflow state machine + tests
- [x] Security review — migrations 0001/0002 hardened (idempotent 0002, hardened helpers,
      profiles column grants, trigger safety) + static SQL security tests
- [ ] Checkpoint 3 — visit registration form, stage confirmations (gate movements),
      notifications, visit timeline
- [ ] Checkpoint 4 — device ingestion API (BLE receivers), gateway registry, labeled simulator
- [ ] Checkpoint 5 — live tracking board, history, reports, Arabic RTL
