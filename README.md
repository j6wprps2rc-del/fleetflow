# FLEETFLOW — Smart Vehicle Movement System

Industrial vehicle-entry, zone-tracking and gate-management platform built with
**Next.js 14 (App Router) + TypeScript strict + Tailwind CSS** and **Supabase PostgreSQL**.

> **Current status — Checkpoint 3 (Vehicle Visit Management & Gate Workflow)** —
> implemented on branch `feature/visit-workflow`, **not yet merged to main**.
> Implemented: full visit registration (with duplicate protection + idempotency),
> server-authorized workflow transitions with row-lock concurrency safety, append-only
gate movement recording, role-targeted notifications with a restricted acknowledge
> flow, visits list/search/filter/pagination, visit details with timeline, and
> comprehensive tests. Earlier: Supabase Auth, RBAC, dashboard, user management,
> hardened migrations. **Not yet:** BLE/device ingestion + simulator (Checkpoint 4),
> reports/history pages (Checkpoint 5). No GPS or BLE hardware tracking is claimed.

## Tech stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js 14 App Router, TypeScript strict mode |
| UI | Tailwind CSS (dark navy/graphite design tokens), lucide-react icons |
| Auth | Supabase Auth (`@supabase/ssr`) — cookie sessions, middleware-refreshed |
| Database | Supabase PostgreSQL (`pg` server-only) |
| Runtime connection | Supabase Transaction Pooler — port **6543** |
| Migration connection | Supabase direct — port **5432** |
| Tests | Vitest unit tests + static migration security tests |

## Security model (honest scope)

- **Server-side authorization everywhere**: registration requires
  `PARKING_OPERATOR`/`SUPER_ADMIN`; every transition re-checks the per-transition
  authorization matrix (`assertRole`) **inside the transaction, after the row lock**;
  hold/reject/cancel are `SUPER_ADMIN` only with a mandatory reason. UI button
  visibility is cosmetic only.
- **Concurrency safety**: transitions take `SELECT … FOR UPDATE` on the visit row and
  re-validate the state machine **after** the lock — two concurrent conflicting
  transitions cannot both apply. `gate_movements` + `notifications` are written in
  the same transaction (rollback removes partial effects).
- **Duplicate & idempotency protection**: registration uses a client idempotency key
  (retries return the original visit) plus a DB **partial unique index** enforcing
  one active visit per vehicle at the database level.
- **Notification RLS**: users read and acknowledge only notifications targeted at
  their own (active) role; acknowledge is restricted via `WITH CHECK` to themselves,
  clients cannot insert/delete/broadly-update — only the two acknowledge columns via
  a column-level grant.
- **RLS on all tables**; `gate_movements`/`audit_logs` append-only; profiles protected
  (see migration 0002 v2 notes).
- The app never uses `SUPABASE_SERVICE_ROLE_KEY`.

## Prerequisites

- Node.js ≥ 20
- Supabase project with migrations 0001–0002 applied (0003 on this branch)

## 1 · Environment variables

Copy `.env.example` → `.env`: `DATABASE_URL` (pooler 6543), `DATABASE_URL_MIGRATIONS`
(direct 5432), `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

## 2 · Install, migrate, verify

```bash
npm install
npm run db:migrate   # on this branch, also applies 0003_visits.sql (additive)
npm run db:verify
```

## 3 · First administrator

Supabase → Authentication → Users → Add user; then in SQL Editor (once):

```sql
update public.profiles set role = 'SUPER_ADMIN' where email = 'you@company.com';
```

## 4 · Run & check

```bash
npm run dev        # http://localhost:3000
npm run typecheck
npm run test       # plate, rbac, workflow, sql-security, visits
npm run build
```

## 5 · Deployment (Vercel)

Same env vars as before; run `npm run db:migrate` once before deploying a build
that includes this branch.

## Roadmap

- [x] Checkpoint 1 — scaffold, schema, migrations, health check, test harness
- [x] Checkpoint 2 — Supabase Auth, middleware route protection, RBAC, user management,
      audit logging, app shell, dashboard, workflow state machine + tests
- [x] Security review — migrations 0001/0002 hardened + static SQL security tests
- [x] Checkpoint 3 (branch) — visit registration (duplicate/idempotency-safe),
      transactional stage transitions with row locks + re-validation, gate movement
      timeline, role-targeted notifications with restricted acknowledge, list/search
      UI, tests
- [ ] Merge Checkpoint 3 to main after review
- [ ] Checkpoint 4 — device ingestion API (BLE receivers), gateway registry, labeled simulator
- [ ] Checkpoint 5 — live tracking board, history, reports, Arabic RTL
