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
   blocked (DB partial unique index + idempotency keys).
2. The visit moves through zones as authorized employees confirm each stage:
   Parking → Security → Laboratory → Completed.
3. Each stage transition is performed by the role that owns that zone, validated
   server-side **under a row lock** so concurrent or repeated submissions cannot
   create invalid states.
4. Every transition atomically records: the movement between zones
   (`gate_movements`, append-only), the new status, notifications for the next
   responsible role, and a **mandatory audit entry** — all in one transaction; a
   failed audit insert rolls the whole transition back.
5. **Super Admin** can additionally hold / reject / cancel a visit (reason mandatory)
   and manage users. Admin user-management actions are atomic too: authorization,
   profile update, and audit entry share one transaction, and an update matching
   zero rows throws before any audit record is written.
6. Reports and dashboards summarize only the actually recorded manual data.

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
  UI hiding is cosmetic. Every mutation is authorized on the server, including
  admin actions and workflow transitions (re-checked under the row lock).
- **The app server connects as the privileged DB role** (schema owner, bypasses RLS).
  Authorization decisions are made in the app layer before the privileged query runs;
  RLS is the enforced second boundary for anon-key client access.
- **Transactions** — `SELECT … FOR UPDATE` + post-lock re-validation; all writes in
  one transaction. Mandatory transactional audit: failed audit inserts roll back
  the operation; standalone audit failures remain logged-and-non-fatal by design.
- **Transaction-client discipline** — all queries inside `withTransaction` (including
  `assertRole` and `audit`) run on the checked-out client; nothing inside a
  transaction ever goes through the global pool (Vercel pool max 1 would deadlock).
- **Identity** — audit records and movement confirmations always carry the
  session-derived profile id, never a client-supplied user id.
- **Self-protection** — users cannot change their own role or deactivate their own
  account; unknown targets throw before any audit record is written.

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
npm run db:migrate   # applies drizzle/*.sql in order, EXCLUDING blocked files (see below)
npm run db:verify    # read-only connection check
```

**Migration status (honest):** **0001 and 0002 are applied** (verified earlier via
`__migrations`). **0003 (visit workflow + notifications) is NOT applied yet** — it is
additive-only and fully rerunnable, but must be applied deliberately after review;
until then, visit registration/transitions fail with relation-not-found errors.

**Blocked migration — `drizzle/0004_device_ingestion.sql`:** this file belongs to
the **removed** device-tracking design. It is intentionally **kept in the repository
for review history** and is **hard-excluded by the migration runner** —
`scripts/migrate.ts` filters it out via `BLOCKED_MIGRATIONS` BEFORE the apply loop and
announces the exclusion loudly. It can therefore **never be applied** by the ordinary
migration command, and `0003` can be applied alone safely. This rule is locked by
`tests/migration-safety.test.ts`. If you later delete the file from the repo, retire
the block entry together with that test deliberately.

## قواعد إدخال لوحات العربيات المصرية

بيسجّل النظام اللوحة زي ما الموظف كتبها (`plate_display` — للعرض والتدقيق) ويحفظ
نسخة معيارية (`plate_normalized` — للمطابقة والبحث ومنع التكرار). القواعد
المطبقة فعليًا في `src/lib/plate.ts` و`src/lib/visit-schemas.ts`:

- **الطول:** من ٢ إلى ٢٠ حرفًا بعد إزالة الفراغات من الأطراف.
- **المسموح:** أرقام لاتينية (0-9) · حروف لاتينية (تتحول تلقائيًا لكبيرة) ·
  أرقام عربية-هندية (٠-٩) · الحروف العربية · الفواصل (مسافة، `-`، `_`، `.`).
- **التطبيع:** حروف كبيرة + إزالة الفواصل والمسافات فقط — لا شيء آخر.
- **قرار موثّق:** لا يوجد تحويل بين الأرقام العربية-الهندية واللاتينية؛
  «١٢٣» و«123» مفتاحان مختلفان للمطابقة ومنع التكرار.
- **التحقق محافظ عن قصد:** يُرفض فقط ما لا يمكن أن يكون لوحة (رموز غير
  حروف/أرقام، نص فارغ، فواصل فقط). لا تُفرض صيغة بعدد محدد من الحروف/الأرقام
  لأن صيغ اللوحات المصرية تختلف حسب فئة المركبة (خصوصي/نقل/دراجة/حكومي)
  ولا يوجد مرجع رسمي واحد موثوق نتحقق منه. أي قاعدة أدق لفئة معينة
  تُضاف كقاعدة موثقة بعد التحقق منها على بيانات حقيقية.

### 3 · First administrator

1. Supabase → Authentication → Users → Add user (public self-registration is NOT
   required by this internal tool; provisioning via the dashboard keeps the least
   privilege, and the `handle_new_user()` trigger grants only SUPERVISOR).
2. Promote once in the SQL editor:
   `update public.profiles set role = 'SUPER_ADMIN' where email = 'you@company.com';`

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
binding regression, migration-runner safety, and atomic admin user-management
actions.

**Not covered by automated tests:** runtime RLS/trigger behavior against a live
database, and full browser user journeys (needs a running app + seeded data).

## Deployment (Vercel)

Same env vars for Production/Preview/Development; middleware needs them at build
time. Run `npm run db:migrate` (after review) before the first deploy that includes
0003. A passing build is code readiness only — production readiness additionally
needs: 0003 applied, admin bootstrap, live RLS verification, and user acceptance
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
- [x] Migration-runner safety — 0004 hard-excluded, regression-tested
- [x] Atomic admin actions — auth + update + audit in one transaction
- [ ] Owner review → apply 0003 → merge to `main` (explicit approval required)
