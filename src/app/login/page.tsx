import { LoginForm } from './login-form';

export const dynamic = 'force-dynamic';

const ERROR_MESSAGES: Record<string, string> = {
  inactive: 'Your account is inactive. Contact a system administrator.'
};

export default async function LoginPage({
  searchParams
}: {
  searchParams: { [key: string]: string | string[] | undefined };
}) {
  const errorKey = typeof searchParams.error === 'string' ? searchParams.error : '';
  const next = typeof searchParams.next === 'string' ? searchParams.next : '/dashboard';
  const safeNext = next.startsWith('/') ? next : '/dashboard';

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-2">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-ff-cyan/30 bg-ff-cyan/10 text-lg font-bold text-ff-cyan">
            FF
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">FLEETFLOW</h1>
          <p className="text-sm text-slate-400">Smart Vehicle Movement System</p>
        </div>

        {errorKey ? (
          <p
            role="alert"
            className="mb-4 rounded-lg border border-ff-danger/40 bg-ff-danger/10 px-4 py-3 text-sm text-ff-danger"
          >
            {ERROR_MESSAGES[errorKey] ?? 'Sign-in failed. Check your credentials and try again.'}
          </p>
        ) : null}

        <LoginForm next={safeNext} />

        <p className="mt-6 text-center text-xs leading-relaxed text-slate-500">
          Accounts are provisioned by your administrator via the Supabase dashboard
          (Authentication → Users → Add user). Roles are assigned after sign-in.
        </p>
      </div>
    </main>
  );
}
