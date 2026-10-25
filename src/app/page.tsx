import Link from 'next/link';
import { envStatus } from '@/lib/env';

const setupSteps = [
  {
    title: '1 · Create .env',
    body: 'Copy .env.example to .env and fill the placeholders with values from your Supabase dashboard (Project Settings → Database / API). Never commit .env.'
  },
  {
    title: '2 · Run migrations',
    body: 'npm run db:migrate — creates the FLEETFLOW schema (profiles, zones, companies, vehicles, drivers, vehicle_visits, gate_movements, audit_logs) in your Supabase PostgreSQL database.'
  },
  {
    title: '3 · Verify safely',
    body: 'npm run db:verify — prints the database name, server time and table count only. It never prints connection strings or passwords.'
  },
  {
    title: '4 · Start the app',
    body: 'npm run dev and open http://localhost:3000. The machine-readable health endpoint is /api/health.'
  }
];

export default function Home() {
  const env = envStatus();
  const allSet = Object.values(env).every(Boolean);

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-10 px-6 py-16">
      <header className="flex flex-col gap-3">
        <span className="w-fit rounded-full border border-ff-cyan/30 bg-ff-cyan/10 px-3 py-1 text-xs font-semibold tracking-widest text-ff-cyan">
          FLEETFLOW · CHECKPOINT 1 · FOUNDATION
        </span>
        <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
          Smart Vehicle Movement System
        </h1>
        <p className="max-w-2xl text-slate-400">
          Industrial vehicle entry, zone tracking and gate management. This page reports the
          current environment and database foundation status. No GPS tracking and no BLE
          hardware integration is claimed — a clearly labeled simulator is planned for
          development.
        </p>
      </header>

      <section className="rounded-2xl border border-ff-border bg-ff-surface/60 p-6 shadow-card">
        <h2 className="text-lg font-semibold text-white">
          Environment variables <span className="text-sm font-normal text-slate-500">(presence only — values are never displayed)</span>
        </h2>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {Object.entries(env).map(([key, set]) => (
            <li
              key={key}
              className="flex items-center justify-between rounded-lg border border-ff-border bg-ff-bg/60 px-4 py-3"
            >
              <code className="text-sm text-slate-300">{key}</code>
              <span className={`text-xs font-semibold ${set ? 'text-ff-success' : 'text-ff-warning'}`}>
                {set ? 'SET' : 'NOT SET'}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-sm text-slate-500">
          {allSet
            ? 'All environment variables are present.'
            : 'Some variables are missing — see README.md for exact, safe instructions.'}
        </p>
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        {setupSteps.map((step) => (
          <div key={step.title} className="rounded-2xl border border-ff-border bg-ff-surface/60 p-5 shadow-card">
            <h3 className="text-sm font-semibold text-ff-cyan">{step.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">{step.body}</p>
          </div>
        ))}
      </section>

      <section className="flex flex-wrap items-center gap-4 text-sm">
        <Link
          href="/api/health"
          className="rounded-lg border border-ff-petrol bg-ff-petrol/20 px-4 py-2 font-medium text-white transition hover:bg-ff-petrol/40"
        >
          Check /api/health
        </Link>
        <span className="text-slate-500">
          Next checkpoints: authentication &amp; RBAC → workflow engine → dashboard &amp; movement pages.
        </span>
      </section>
    </main>
  );
}
