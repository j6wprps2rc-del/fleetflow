'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { acknowledgeAction } from './actions';
import { arMessage } from '@/lib/i18n';

/**
 * غلاف عميل لزر تأكيد قراءة الإشعار (نفس نمط user-row-actions).
 *
 * جذر العيب: الإجراء الخادمي يرمي أخطاء صحيحة، لكن ربطه المباشر
 * بـ <form action={...}> يبتلعها صامتة — يظهر للمستخدم «الزر ميت».
 * هنا: التقاط → رسالة عربية عبر arMessage → عرض inline،
 * مع تحديث الصفحة عند النجاح فقط.
 *
 * منع الطلبات المتزامنة ثلاثي الطبقات:
 *   1) inflightRef (useRef) — حارس متزامن حقيقي يُفحص ويُضبط قبل أي await،
 *      فيغلق نافذة النقر المزدوج قبل أن يعيد React الرسم ويحدّث pending.
 *   2) disabled={pending} — منع النقر على مستوى DOM.
 *   3) حارس if (pending || done) — صمام أمان منطقي.
 * الحارس يُصفَّر في finally — الفشل لا يقفل الزر أبدًا (إعادة المحاولة ممكنة).
 *
 * الصلاحيات ومنطق التأكيد بلا أي تغيير: نفس acknowledgeAction الخادمي،
 * نفس assertRole وRLS وزناد قاعدة البيانات trg_notifications_ack.
 */
export function AcknowledgeButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflightRef = useRef(false);

  function acknowledge() {
    // الحارس المتزامن: يُفحص ويُضبط ذريًا قبل أي await
    if (inflightRef.current || pending || done) return;
    inflightRef.current = true;
    setError(null);

    startTransition(async () => {
      try {
        const fd = new FormData();
        fd.append('id', id);
        await acknowledgeAction(fd);
        setDone(true);
        router.refresh();
      } catch (err) {
        setError(arMessage(err));
      } finally {
        inflightRef.current = false;
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      {done ? (
        <span className="text-xs font-medium text-ff-success">تم الاطّلاع ✓</span>
      ) : (
        <button
          type="button"
          onClick={acknowledge}
          disabled={pending}
          className="rounded-lg border border-ff-border px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:border-ff-success/50 hover:text-ff-success disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? 'جارٍ الحفظ…' : 'تم الاطّلاع'}
        </button>
      )}
      {error ? (
        <p role="alert" className="text-xs text-ff-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
