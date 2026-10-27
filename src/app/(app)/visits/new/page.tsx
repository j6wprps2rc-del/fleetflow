import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth';
import { canRegisterVisit } from '@/lib/rbac';
import { pool } from '@/db';
import { AR } from '@/lib/i18n';
import { NewVisitForm } from './new-visit-form';

export const dynamic = 'force-dynamic';

export default async function NewVisitPage() {
  const { profile } = await requireUser();
  if (!canRegisterVisit(profile.role)) {
    redirect('/visits');
  }

  const companies = await pool.query(
    'select id::text as id, name from companies where is_active order by name'
  );

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <header>
        <h1 className="text-xl font-bold tracking-tight text-white">{AR.registerVisit}</h1>
        <p className="mt-1 text-sm text-slate-400">
          بيتسجّل من الجراج، وبعدين الزيارة تمشي: الأمن ← المعمل.
        </p>
      </header>
      <NewVisitForm companies={companies.rows as { id: string; name: string }[]} />
    </div>
  );
}
