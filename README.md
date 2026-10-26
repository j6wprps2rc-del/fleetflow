# FLEETFLOW — Smart Vehicle Movement System

Industrial vehicle-entry, zone-tracking and gate-management platform built with
**Next.js 14 (App Router) + TypeScript strict + Tailwind CSS** and **Supabase PostgreSQL**.

> **Status — Checkpoints 1–5 implemented on `fix/transaction-pool-starvation`** (not yet
> merged to `main`; review pending). Implemented: Supabase Auth + middleware route
> protection, server-side RBAC, dashboard, user management, audit trail viewer, visit
> registration (duplicate- and idempotency-safe), transactional workflow transitions with
> row locks + post-lock state re-validation, append-only gate movements, role-targeted
> notifications with trigger-enforced acknowledgement, visits list/search/pagination,
> visit details + timeline, **BLE gateway registry + ingestion API** (`POST /api/ingest`),
> **clearly-labeled simulator** (SIMULATED method, SUPER_ADMIN only), and **reports &
> analytics**. **Honest scope:** no real BLE hardware is connected; the simulator exists
> for development/demo and every simulated row is labeled SIMULATED. No GPS tracking is
> claimed anywhere.

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
  UI hiding is cosmetic. Every gateway mutation also runs `assertRole(['SUPER_ADMIN'])`.
- **The app server connects as the privileged DB role** (schema owner, bypasses RLS).
  Authorization decisions are made in the app layer before the privileged query runs;
  RLS is the enforced second boundary for anon-key client access.
- **Transactions** — `SELECT … FOR UPDATE` + post-lock re-validation; gate movements,
  status update, audit entries, and notifications are written in one transaction.
  **Mandatory transactional audit:** a failed audit insert rolls back the whole operation;
  standalone audit failures remain logged-and-non-fatal by design.
- **Transaction-client discipline** — all queries inside `withTransaction` (including
  `assertRole` and `audit`) run on the checked-out client; nothing inside a transaction
  ever goes through the global pool (Vercel pool max 1 would otherwise deadlock).
- **Gateway keys** — SHA-256 hashed at rest, constant-time comparison, plaintext shown
  exactly once at creation/rotation, never stored client-side. Ingestion cannot advance
  the workflow; it only records device evidence.
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
npm run db:migrate   # applies drizzle/*.sql in order (0001 → 0004) via DIRECT connection
npm run db:verify    # read-only connection check
```

**Migration status (honest):** as of this commit, **0001 and 0002 are applied** to your
Supabase project (verified earlier via db:verify). **0003 and 0004 are NOT applied yet**
(0004 was authored in this session: gateways table, BLE tag binding, last-detection
columns). Both are additive-only and rerunnable. Apply with `npm run db:migrate` after
your review and explicit approval — nothing has been run against your database by the
agent.

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

## BLE ingestion — how it works

1. **SUPER_ADMIN** registers a gateway in **/simulator** (choose label + zone). The API
   key is displayed once — save it immediately.
2. Physical receivers POST to `POST /api/ingest` with header `x-api-key: <gateway key>`:
   ```json
   { "bleTagId": "TAG-001" }
   ```
   Responses: `200` with a typed result, `401` for a bad/inactive key (uniform),
   `400` for malformed input.
3. Vehicles are bound to tags via `vehicles.ble_tag_id` (set in SQL for now; a UI for tag
   binding is a small follow-up).
4. A detection appends `gate_movements` (method `DEVICE_DETECTION`) **only on first
   detection or zone change**; repeated same-zone pings only refresh
   `last_detected_at`. The workflow status is NEVER changed by a device — employees
   confirm stages manually.
5. The simulator (bottom of /simulator) sends detections through the exact same
   pipeline with `method = 'SIMULATED'` — labeled everywhere, never mixed with device data.

## Deployment (Vercel)

Same env vars for Production/Preview/Development; middleware needs them at build time.
Run `npm run db:migrate` (after approval) before the first deploy that includes 0003/0004.
A passing build is code readiness only — production readiness additionally needs:
migrations applied, admin bootstrap, live RLS verification (queries in README §Verify),
and user acceptance testing of the full workflow + a real gateway key round-trip.

## Roadmap

- [x] Checkpoint 1 — scaffold, schema, migrations, health check, test harness
- [x] Checkpoint 2 — Auth, RBAC, app shell, dashboard, user management, audit
- [x] Security review — hardened migrations 0001/0002 + SQL security tests
- [x] Checkpoint 3 — visit registration, transitions, gate movements, notifications,
      audit viewer, visits UI
- [x] Pool/transaction hardening — tx-client propagation, mandatory transactional audit
- [x] Checkpoint 4 — gateway registry, BLE ingestion API, clearly-labeled simulator
- [x] Checkpoint 5 — reports & analytics page
- [ ] Your review → apply 0003/0004 → merge to `main` (explicit approval required)
- [ ] Physical BLE hardware integration (external — needs real receivers on site)
