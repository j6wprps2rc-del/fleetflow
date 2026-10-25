# FLEETFLOW — Smart Vehicle Movement System

Industrial vehicle-entry, zone-tracking and gate-management platform built with
**Next.js 14 (App Router) + TypeScript strict + Tailwind CSS** and **Supabase PostgreSQL**.

> **Current status — Checkpoint 2 (Authentication, RBAC & App Shell).**
> Implemented: real Supabase Auth sign-in, cookie-session middleware protection for every
> route, server-side RBAC enforced in server actions (`assertRole`), profile auto-creation
> trigger, admin user management with audit logging, premium app shell (sidebar, topbar),
> operations dashboard with live DB counts, workflow state-machine logic with unit tests.
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
| Tests | Vitest unit tests |

## Security model (honest scope)

- **Server-side authorization is enforced in code**: every privileged server action calls
  `assertRole([...])` which verifies the Supabase Auth session server-side and the role
  from the `profiles` table. UI hiding is cosmetic only.
- **RLS** is enabled on every table with baseline read policies; `profiles` policies were
  rewritten in migration 0002 with `SECURITY DEFINER` helpers to avoid PostgreSQL policy
  recursion. Append-only tables (`gate_movements`, `audit_logs`) reject `UPDATE`/`DELETE`.
- The app server connects with `DATABASE_URL` (privileged). Because of this, **all data access
  goes through server components / server actions / route handlers that perform their own
  authorization checks** — the RLS policies additionally protect any direct Supabase-client
  (anon key) access. `SUPABASE_SERVICE_ROLE_KEY` is **not required** for the app to run.
- No credentials are hardcoded; `.env` is git-ignored; the DB client is `server-only`.

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

## 3 · Create the first administrator (secure bootstrap — no hardcoded passwords)

1. Supabase dashboard → **Authentication → Users → Add user**: create your own account
   (e.g. `admin@company.com`) with a strong password. Do **not** enable “auto-confirm” for
   anyone you don’t control.
2. The `on_auth_user_created` trigger (migration 0002) automatically creates a `profiles`
   row with the least-privileged role `SUPERVISOR`.
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
- `/api/health` — secret-free health endpoint (preserved from Checkpoint 1)

## 5 · Checks

```bash
npm run typecheck   # tsc --noEmit (strict)
npm run lint        # eslint (next/core-web-vitals)
npm run test        # vitest unit tests (plate, rbac, workflow)
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
- [ ] Checkpoint 3 — visit registration form, stage confirmations (gate movements),
      notifications, visit timeline
- [ ] Checkpoint 4 — device ingestion API (BLE receivers), gateway registry, labeled simulator
- [ ] Checkpoint 5 — live tracking board, history, reports, Arabic RTL
