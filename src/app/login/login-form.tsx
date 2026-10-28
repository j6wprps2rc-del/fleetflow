'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { createClient } from '@/lib/supabase/client';

/**
 * تصنيف أخطاء المصادقة — سلسلة ثلاثية:
 *   1) authError.code (معرّف خادم ثابت — الأساس الأوثق في auth-js 2.64+)
 *   2) authError.message (احتياط للأخطاء غير المحمّلة بكود)
 *   3) رسالة عربية عامة (شبكة أمان — لا تسريب خام أبدًا)
 * السجلات تستقبل الكود التصنيفي + رقم حالة HTTP فقط — لا نص خام ولا بيانات حساسة.
 */
type AuthDiagnostic =
  | 'AUTH_INVALID_CREDENTIALS'
  | 'AUTH_EMAIL_NOT_CONFIRMED'
  | 'AUTH_USER_BANNED'
  | 'AUTH_RATE_LIMITED'
  | 'AUTH_UNKNOWN';

const AUTH_CODES_AR: Record<string, { ar: string; code: AuthDiagnostic }> = {
  invalid_credentials: {
    ar: 'البيانات غير صحيحة — راجع الإيميل وكلمة السر.',
    code: 'AUTH_INVALID_CREDENTIALS'
  },
  email_not_confirmed: {
    ar: 'الإيميل لسه متأكدش — افتح بريدك واعمل التأكيد الأول.',
    code: 'AUTH_EMAIL_NOT_CONFIRMED'
  },
  user_banned: {
    ar: 'الحساب ده موقوف — كلّم الأدمن.',
    code: 'AUTH_USER_BANNED'
  },
  too_many_requests: {
    ar: 'محاولات كتير — استنى شوية وحاول تاني.',
    code: 'AUTH_RATE_LIMITED'
  },
  over_request_rate_limit: {
    ar: 'محاولات كتير — استنى شوية وحاول تاني.',
    code: 'AUTH_RATE_LIMITED'
  }
};

// احتياط نصي: للأخطاء التي لا تحمل كودًا ثابتًا (نسخ قديمة/أخطاء بلا error_code)
const KNOWN_AUTH_MESSAGES: Record<string, { ar: string; code: AuthDiagnostic }> = {
  'Invalid login credentials': AUTH_CODES_AR.invalid_credentials,
  'Email not confirmed': AUTH_CODES_AR.email_not_confirmed,
  'Too many requests. Please try again later.': AUTH_CODES_AR.too_many_requests
};

function mapAuthError(
  rawCode: unknown,
  rawMessage: string
): { message: string; code: AuthDiagnostic } {
  // 1) الكود الثابت من الخادم — بشرط أنه سلسلة فعلًا (قد تكون undefined)
  if (typeof rawCode === 'string' && AUTH_CODES_AR[rawCode]) {
    return AUTH_CODES_AR[rawCode];
  }
  // 2) احتياط النص المعروف
  const byMessage = KNOWN_AUTH_MESSAGES[rawMessage];
  if (byMessage) return byMessage;
  // 3) شبكة الأمان العامة — لا يصل أي نص خام للمستخدم أبدًا
  return { message: 'تعذّر تسجيل الدخول، حاول مرة أخرى.', code: 'AUTH_UNKNOWN' };
}

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return; // prevent double submission
    setLoading(true);
    setError(null);

    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password });

    if (authError) {
      // code قد لا تكون معلنة في أنواع النسخة المثبتة — قراءة محايدة بلا أي افتراض
      const { message, code } = mapAuthError(
        (authError as { code?: unknown }).code,
        authError.message
      );
      // تشخيص منقّح: كود تصنيفي + رقم حالة HTTP فقط — لا نص خام ولا كائن ولا stack
      console.warn('[login] auth failed:', code, 'http_status:', authError.status);
      setError(message);
      setLoading(false);
      return;
    }

    router.replace(next);
    router.refresh();
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-4 rounded-2xl border border-ff-border bg-ff-surface/70 p-6 shadow-card"
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold tracking-wider text-slate-400">البريد الإلكتروني</span>
        <input
          type="email"
          required
          autoComplete="email"
          dir="ltr"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-lg border border-ff-border bg-ff-bg px-3 py-2 text-sm text-white outline-none focus:border-ff-cyan"
          placeholder="you@company.com"
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold tracking-wider text-slate-400">كلمة السر</span>
        <input
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-lg border border-ff-border bg-ff-bg px-3 py-2 text-sm text-white outline-none focus:border-ff-cyan"
          placeholder="••••••••"
        />
      </label>

      {error ? (
        <p role="alert" className="rounded-lg border border-ff-danger/40 bg-ff-danger/10 px-3 py-2 text-xs text-ff-danger">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={loading}
        className="rounded-lg bg-ff-petrol px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-ff-petrol/80 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? 'جارٍ الدخول…' : 'دخول'}
      </button>
    </form>
  );
}
