/**
 * انحدار اختيار الشركة في تسجيل الزيارة — ضد registerVisitSchema الحقيقي.
 * يغطي: 'new' بلا اسم، اسم فراغات، trim، اسم صالح، شركة موجودة، مرجع غير صالح.
 */
import { describe, expect, it } from 'vitest';
import { registerVisitSchema } from '../src/lib/visit-schemas';

const UUID = '11111111-1111-1111-1111-111111111111';

const base = {
  plate: 'ABC1234',
  companyId: UUID as string,
  idempotencyKey: 'key-12345678'
};

const parse = (input: unknown) => registerVisitSchema.safeParse(input);

describe('اختيار شركة جديدة — registerVisitSchema الحقيقي', () => {
  it("يرفض companyId='new' بدون اسم شركة (superRefine بمسار newCompanyName)", () => {
    const r = parse({ ...base, companyId: 'new' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toContain('newCompanyName');
  });

  it('يرفض اسمًا من فراغات فقط (trim ثم min(2))', () => {
    const r = parse({ ...base, companyId: 'new', newCompanyName: '   ' });
    expect(r.success).toBe(false);
  });

  it('يقبل اسمًا صالحًا مع إزالة الفراغات من الأطراف', () => {
    const r = parse({ ...base, companyId: 'new', newCompanyName: '  شركة النقل الجديدة ' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.newCompanyName).toBe('شركة النقل الجديدة');
  });

  it('يقبل شركة موجودة (UUID) بدون طلب اسم', () => {
    const r = parse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.newCompanyName).toBeUndefined();
  });

  it('يرفض مرجع شركة غير صالح (لا UUID ولا new)', () => {
    const r = parse({ ...base, companyId: 'not-a-uuid' });
    expect(r.success).toBe(false);
  });

  it('يرفض اسم شركة أقصر من حرفين', () => {
    const r = parse({ ...base, companyId: 'new', newCompanyName: 'ش' });
    expect(r.success).toBe(false);
  });
});
