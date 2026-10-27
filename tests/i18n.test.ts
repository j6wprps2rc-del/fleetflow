/**
 * اختبارات arMessage — تُنفّذ كود التحقق الحقيقي وتستخرج الرسائل الفعلية،
 * فتفشل تلقائيًا إذا غيّر الكود نص أي رسالة (لا فحص نصوص مصدر هش).
 * التغطية: رسائل معروفة، غير معروفة (لا تسرّب إنجليزي خام)، Forbidden،
 * تضارب الزيارة النشطة، ورسائل zod/اللوحات الحقيقية.
 */
import { describe, expect, it } from 'vitest';
import { arMessage, GENERIC_ERROR_AR } from '../src/lib/i18n';
import { registerVisitSchema } from '../src/lib/visit-schemas';
import { validatePlate } from '../src/lib/plate';

const UUID = '11111111-1111-1111-1111-111111111111';

describe('arMessage — رسائل الخادم المعروفة', () => {
  it('يطابق الرسائل المعروفة حرفيًا', () => {
    expect(arMessage(new Error('User not found.'))).toBe('المستخدم ده مش موجود.');
    expect(arMessage(new Error('Invalid role.'))).toBe('الدور المختار غير صحيح.');
    expect(arMessage(new Error('Account is inactive.'))).toBe(
      'الحساب ده موقوف — كلّم الأدمن.'
    );
  });

  it('يطابق بادئة Forbidden لأي دور', () => {
    expect(arMessage(new Error('Forbidden for role SUPERVISOR.'))).toBe(
      'مش مسموح لك بالفعل ده بدورك الحالي.'
    );
  });

  it('يطابق نص تضارب الزيارة النشطة', () => {
    expect(
      arMessage(new Error('This vehicle already has an active visit (V-1, registered).'))
    ).toBe('العربية دي عندها زيارة شغّالة بالفعل.');
  });

  it('الرسائل غير المعروفة → الجملة العامة، ولا يظهر أي إنجليزي خام', () => {
    const out = arMessage(new Error('something brand new'));
    expect(out).toBe(GENERIC_ERROR_AR);
    expect(out).toMatch(/تعذّر/);
  });
});

describe('arMessage — رسائل حقيقية من تنفيذ كود التحقق نفسه', () => {
  it('رسالة رفض اسم الشركة (superRefine) بتتنفذ فعليًا ثم تُترجم', () => {
    const r = registerVisitSchema.safeParse({
      plate: 'ABC1234',
      companyId: 'new',
      idempotencyKey: 'key-12345678'
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const raw = r.error.issues[0]?.message ?? '';
      expect(arMessage(new Error(raw))).toBe('لازم تكتب اسم الشركة الجديدة.');
    }
  });

  it('رسالة قِصر اللوحة من zod تُترجم (كانت مفقودة من القاموس)', () => {
    const r = registerVisitSchema.safeParse({
      plate: 'A',
      companyId: UUID,
      idempotencyKey: 'key-12345678'
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const raw = r.error.issues[0]?.message ?? '';
      expect(arMessage(new Error(raw))).toBe(
        'رقم اللوحة قصير — الحد الأدنى ٢ حرف.'
      );
    }
  });

  it('رسالة validatePlate للرموز غير المسموحة تُترجم لا تسقط للعامة', () => {
    const bad = validatePlate('!!@@');
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(arMessage(new Error(bad.reason ?? ''))).toBe(
        'رقم اللوحة فيه حروف غير مسموحة — استخدم أرقام وحروف بس.'
      );
    }
  });

  it('اللوحات العربية-الهندية مقبولة فعلًا من validatePlate (توثيق صادق)', () => {
    const ok = validatePlate('أ ب ج ١٢٣٤');
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.normalized).toBe('أبج١٢٣٤');
  });
});
