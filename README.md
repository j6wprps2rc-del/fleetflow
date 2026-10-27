# FLEETFLOW — Smart Vehicle Movement System

Industrial vehicle-entry, zone-tracking and gate-management platform built with
**Next.js 14 (App Router) + TypeScript strict + Tailwind CSS** and **Supabase PostgreSQL**.

> **Operating model — MANUAL WORKFLOW ONLY.** Authorized employees record every
> vehicle arrival, every movement between company zones, and every workflow
> transition by hand. FleetFlow records **who** performed each action and **when**.
> There is **no device tracking, no BLE receivers, no vehicle tags, no gateway keys,
> no automatic detections, and no simulator**. Nothing in this system depends on
> tracking hardware, and no GPS or other hardware-based tracking is used.

## How the manual workflow operates

1. A **Parking Operator** (or Super Admin) registers a vehicle's arrival — the visit
   is created with a unique visit code, and duplicate active visits per vehicle are
   blocked.
2. The visit moves through zones as authorized employees confirm each stage:
   Parking → Security → Laboratory → Completed.
3. Each stage transition is performed by the role that owns that zone
   (Security Operator for security, Lab Operator for the laboratory), validated
   server-side under a row lock so concurrent or repeated submissions cannot create
   invalid states.
4. Every transition atomically records: the movement between zones
   (`gate_movements`, append-only), the new status, notifications for the next
   responsible role, and an audit entry — all in one transaction.
5. **Super Admin** can additionally hold / reject / cancel a visit with a mandatory
>  reason.
6. Reports and dashboards summarize the actually recorded manual data only.

## Tech stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js 14 App Router, TypeScript strict mode |
| UI | Tailwind CSS (dark navy/graphite design tokens), lucide-react icons |
| Auth | Supabase Auth (`@supabase/ssr`) — cookie sessions, middleware-refreshed |
| Database | Supabase PostgreSQL via `pg` (server-only; Drizzle available) |
| Runtime connection | Supabase Transaction Pooler — port **6543** (SSL) |
| Migration connection | Supabase direct — port **5432** |
| Tests | Vitest (unit + behavioral fake-client + static SQL characterization) |

## Security model

- **Server-side authorization everywhere** — `requireUser` (pages) and `assertRole`
  (server actions) verify the session server-side and read the role from `profiles`.
  UI hiding is cosmetic.
- **The app server connects as the privileged DB role** (schema owner, bypasses RLS).
  Authorization decisions are made in the app layer before the privileged query runs;
  RLS is the enforced second boundary for anon-key client access.
- **Transactions** — `SELECT … FOR UPDATE` + post-lock re-validation; gate movements,
  status update, audit entries, and notifications are written in one transaction.
  **Mandatory transactional audit:** a failed audit insert rolls back the whole
  operation; standalone audit failures remain logged-and-non-fatal by design.
- **Transaction-client discipline** — all queries inside `withTransaction` (including
  `assertRole` and `audit`) run on the checked-out client; nothing inside a
  transaction ever goes through the global pool (Vercel pool max 1 would deadlock).
- **Identity** — audit records and movement confirmations always carry the
  session-derived profile id, never a client-supplied user id.
- **Idempotency/duplicates** — DB partial unique indexes are the source of truth;
  23505 races resolve to typed results.

## Setup

### 1 · Environment variables

Copy `.env.example` → `.env` (Supabase dashboard → Project Settings → Database / API):

- `DATABASE_URL` — transaction pooler (**6543**) — app runtime
- `DATABASE_URL_MIGRATIONS` — direct (**5432**) — migrations only
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- Optional: `FLEETFLOW_DEFAULT_TZ`

Never commit real credentials. `SUPABASE_SERVICE_ROLE_KEY` is NOT used by this app.

### 2 · Install, migrate, verify

```bash
npm install
npm run db:migrate   # applies drizzle/*.sql in order (0001 → 0003) via DIRECT connection
npm run db:verify    # read-only connection check
```

**Migration status (honest):** **0001 and 0002 are applied** to the Supabase project
(verified earlier via db:verify). **0003 is NOT applied yet** (visit workflow +
notifications). It is additive-only and fully rerunnable.

**About `drizzle/0004_device_ingestion.sql`:** this file is a leftover from a
**removed** device-tracking design and is intentionally **kept in the repository
** but **not applied and not referenced by any application code**. Reason: the
agent environment has no connected database tool to verify that the file was
never applied to any environment, so per the database-safety rules it is preserved
until you confirm its status (check `select filename from __migrations` — if
`0004_device_ingestion.sql` is absent, it is safe to delete the file; if present,
leave the schema objects in place — they are inert — and do not run any drops).

### 3 · First administrator

1. Supabase → Authentication → Users → Add user.
2. The `on_auth_user_created` trigger creates a least-privilege SUPERVISOR profile.
3. Promote once: `update public.profiles set role = 'SUPER_ADMIN' where email = 'you@company.com';`

### 4 · Run & check

```bash
npm run dev        # http://localhost:3000
npm run typecheck
npm run lint
npm run test
npm run build
```

### Testing scope (honest)

`npm run test` runs unit + behavioral + static characterization tests (no database
needed): plate normalization, RBAC map (including behavioral absence checks for
removed device permissions), workflow state machine, SQL security properties of
migrations 0002/0003, visit schemas, transition authorization matrix, gate-movement
mapping, transaction-client propagation, mandatory-audit rollback, acknowledge
binding regression.

**Not covered by automated tests:** runtime RLS/trigger behavior against a live
database (needs an isolated integration DB — documented gap).

## Deployment (Vercel)

Same env vars for Production/Preview/Development; middleware needs them at build
time. Run `npm run db:migrate` (after approval) before the first deploy that includes
0003. A passing build is code readiness only — production readiness additionally
needs: migrations applied, admin bootstrap, live RLS verification, and user acceptance
testing of the full manual workflow.

## Roadmap

- [x] Checkpoint 1 — scaffold, schema, migrations, health check, test harness
- [x] Checkpoint 2 — Auth, RBAC, app shell, dashboard, user management, audit
- [x] Security review — hardened migrations 0001/0002 + SQL security tests
- [x] Checkpoint 3 — visit registration, transitions, gate movements, notifications,
      audit viewer, visits UI
- [x] Pool/transaction hardening — tx-client propagation, mandatory transactional audit
- [x] Checkpoint 4/5 — reports & analytics over manual data
- [x] Manual-workflow-only conversion — device ingestion and simulator removed
- [ ] Your review → apply 0003 → merge to `main` (explicit approval required)
