# FLEETFLOW — Smart Vehicle Movement System

Industrial vehicle-entry, zone-tracking and gate-management platform built with
**Next.js 14 (App Router) + TypeScript strict + Tailwind CSS** and **Supabase PostgreSQL**.

> **Current status — Checkpoint 1 (Foundation).** Implemented: project scaffold, database
> schema (migration 0001), server-only DB client, migration runner, secret-free health and
> verification endpoints, unit-test harness. **Not yet implemented:** authentication, RBAC,
> workflow engine, dashboards, BLE/device ingestion (a clearly labeled simulator is planned).
> Nothing here claims real GPS or BLE hardware tracking.

## Tech stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js 14 App Router, TypeScript strict mode |
| UI | Tailwind CSS (dark navy/graphite design tokens) |
| Database | Supabase PostgreSQL (`pg` + Drizzle, server-only) |
| Runtime connection | Supabase Transaction Pooler — port **6543** (serverless-friendly) |
| Migration connection | Supabase direct — port **5432** (DDL should not go through pgbouncer) |
| Tests | Vitest (unit) — integration/E2E planned in later checkpoints |

## Prerequisites

- Node.js ≥ 20
- A Supabase project (you create it; the app never needs your password pasted anywhere except your own `.env` / dashboard)

## 1 · Configure environment variables (never commit them)

1. In the Supabase dashboard open **Project Settings → Database** and, if you have not already, set a database password under **Database password**.
2. Copy the two connection URIs shown under **Connection string → URI**:
   - **Transaction pooler** (port `6543`) → use as `DATABASE_URL` (app runtime)
   - **Direct** (port `5432`) → use as `DATABASE_URL_MIGRATIONS` (migrations)
3. In **Project Settings → API** copy the project URL, the `anon` key, and the `service_role` key.
4. Create your local `.env` from the template and fill it in:

   ```powershell
   # Windows PowerShell
   Copy-Item .env.example .env
   notepad .env
   ```

   ```bash
   # macOS / Linux
   cp .env.example .env && nano .env
   ```

Rules:

- `.env` is **git-ignored** (see `.gitignore`). Only `.env.example` with placeholders is committed.
- `DATABASE_URL` has **no** `NEXT_PUBLIC_` prefix and the DB client imports `server-only`, so it can never reach browser bundles.
- Never paste real credentials into chat, tickets, or code.

## 2 · Install and run migrations

```bash
npm install
npm run db:migrate   # applies drizzle/*.sql in order, tracked in __migrations
```

Migration `0001` creates: `profiles` (users/roles linked to Supabase Auth), `zones`,
`companies`, `vehicles`, `drivers`, `vehicle_visits`, `gate_movements` (append-only),
`audit_logs` (append-only), `application_settings` — with enums, FK constraints, indexes,
updated-at triggers, history-protection revokes, and an RLS baseline.

Note: the schema references `auth.users`, which exists automatically in Supabase projects.

## 3 · Verify the connection safely

```bash
npm run db:verify    # prints database name, server time, table count — never secrets
```

Or check the HTTP health endpoint once the app runs:

```bash
npm run dev
# then open http://localhost:3000/api/health
```

`/api/health` returns JSON with `status` (`ok` | `degraded`), database connectivity,
latency and public table count — and no secret material of any kind.

## 4 · Tests and checks

```bash
npm run typecheck   # tsc --noEmit (strict)
npm run lint        # eslint (next/core-web-vitals)
npm run test        # vitest unit tests
```

## 5 · Deployment (Vercel)

1. Import the repository into Vercel.
2. **Settings → Environment Variables** — add for Production/Preview/Development:
   - `DATABASE_URL` — the **transaction pooler (6543)** URI
   - `DATABASE_URL_MIGRATIONS` — the direct (5432) URI (only if running migrations from CI)
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
     `SUPABASE_SERVICE_ROLE_KEY` (server-only; never expose it to the client)
3. Deploy. Migrations are not run automatically — run `npm run db:migrate` from your
   machine (or a CI step) before the first deploy that needs the schema.

## Security notes (current state — honest scope)

- RLS is enabled on every table with baseline read policies; privileged writes will go
  through protected server functions in a later checkpoint.
- `gate_movements` and `audit_logs` are append-only: `UPDATE`/`DELETE` revoked from
  `anon`/`authenticated`; visits cannot be deleted by app users.
- Server-only DB client; security headers set in `next.config.mjs`; no credentials in code.
- **Authentication and full RBAC are not implemented yet** — do not treat the current UI as
  access-controlled until Checkpoint 2 lands.

## Roadmap

- [x] Checkpoint 1 — scaffold, schema, migrations, health checks, test harness
- [ ] Checkpoint 2 — Supabase Auth, protected routes, RBAC (server + DB enforced)
- [ ] Checkpoint 3 — visit registration, workflow state machine, append-only events, audit
- [ ] Checkpoint 4 — device ingestion API (BLE receivers), gateway registry, labeled simulator
- [ ] Checkpoint 5 — dashboards, movement pages, history, reports
