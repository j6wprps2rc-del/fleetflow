/**
 * Egyptian-Arabic-first UI dictionary and server-message mapper.
 *
 * Server libraries keep throwing English errors (tests and logs stay stable);
 * THIS layer is the single place that maps known server messages to clear
 * Egyptian Arabic for the user, with a safe generic fallback. Never translate
 * identifiers, plate values, emails, URLs, or DB columns.
 */

/** Maps known English server messages → Egyptian Arabic. */
const MESSAGE_AR: Record<string, string> = {
  'Not authenticated.': 'لازم تسجّل الدخول الأول.',
  'Account is inactive.': 'الحساب ده موقوف — كلّم الأدمن.',
  'Invalid role.': 'الدور المختار غير صحيح.',
  'Missing user id.': 'بيانات المستخدم ناقصة.',
  'User not found.': 'المستخدم ده مش موجود.',
  'You cannot change your own role. Ask another super admin.':
    'مينفعش تغيّر دورك بنفسك — كلّم أدمن تاني.',
  'You cannot deactivate your own account. Ask another super admin.':
    'مينفعش توقّف حسابك بنفسك — كلّم أدمن تاني.',
  'A company name is required when creating a new company.':
    'لازم تكتب اسم الشركة الجديدة.',
  'Company not found or inactive.': 'الشركة دي مش موجودة أو موقوفة.',
  'A company name is required when creating a new company':
    'لازم تكتب اسم الشركة الجديدة.',
  'Plate must be between 2 and 20 characters.':
    'رقم اللوحة لازم يكون بين ٢ و٢٠ حرف.',
  'Plate contains invalid characters.':
    'رقم اللوحة فيه حروف غير مسموحة — استخدم أرقام وحروف بس.',
  'Plate cannot consist only of separators.':
    'رقم اللوحة مش ممكن يكون فاصلًا بس.',
  'Invalid plate.': 'رقم اللوحة غير صحيح.',
  'A reason of at least 3 characters is required for this action.':
    'لازم تكتب سبب (٣ حروف على الأقل).',
  'A reason is mandatory for this action.': 'السبب إجباري للفعل ده.',
  'A reason is mandatory for hold/reject/cancel actions.':
    'لازم تكتب سبب لتعليق أو رفض أو إلغاء الزيارة.',
  'Reason is too long (max 500 characters).': 'السبب طويل أوي (الحد ٥٠٠ حرف).',
  'Visit not found.': 'الزيارة دي مش موجودة.',
  'Transition is not valid for the current status':
    'النقلة دي مش متاحة للحالة الحالية — حدّث الصفحة وحاول تاني.',
  'Registration failed.': 'تعذّر حفظ البيانات، حاول مرة أخرى.',
  'Transition failed.': 'تعذّر تنفيذ العملية، حاول مرة أخرى.',
  'Failed to update user.': 'تعذّر حفظ البيانات، حاول مرة أخرى.'
};

/** Generic fallback shown for unmapped/unexpected errors. */
export const GENERIC_ERROR_AR = 'تعذّر حفظ البيانات، حاول مرة أخرى.';

/**
 * Maps a server error to Egyptian Arabic. Known messages map exactly;
 * unknown messages fall back to the generic sentence (never leaks raw
 * English stack text to the user).
 */
export function arMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (MESSAGE_AR[raw]) return MESSAGE_AR[raw];
  // PermissionError carries role-specific text: map the prefix.
  if (raw.startsWith('Forbidden for role')) {
    return 'مش مسموح لك بالفعل ده بدورك الحالي.';
  }
  if (raw.includes('already has an active visit')) {
    return 'العربية دي عندها زيارة شغّالة بالفعل.';
  }
  return GENERIC_ERROR_AR;
}

/** Static UI labels (Egyptian Arabic). */
export const AR = {
  appName: 'فليت فلو',
  dashboard: 'لوحة التحكم',
  visits: 'الزيارات',
  notifications: 'الإشعارات',
  reports: 'التقارير',
  users: 'المستخدمين',
  audit: 'سجل التغييرات',
  signOut: 'تسجيل الخروج',
  registerVisit: 'تسجيل زيارة جديدة',
  plate: 'رقم اللوحة',
  company: 'الشركة',
  addNewCompany: 'إضافة شركة جديدة',
  companyName: 'اسم الشركة',
  driverName: 'اسم السائق',
  driverPhone: 'تليفون السائق',
  notes: 'ملاحظات',
  save: 'حفظ',
  cancel: 'إلغاء',
  reset: 'تفريغ الفورم',
  saving: 'جارٍ الحفظ…',
  registering: 'جارٍ التسجيل…',
  visitStatus: 'حالة الزيارة',
  statusLabels: {
    REGISTERED: 'مسجّلة',
    WAITING_FOR_SECURITY: 'في انتظار الأمن',
    AT_SECURITY: 'عند الأمن',
    WAITING_FOR_LAB: 'في انتظار المعمل',
    AT_LAB: 'عند المعمل',
    COMPLETED: 'مكتملة',
    ON_HOLD: 'معلّقة',
    REJECTED: 'مرفوضة',
    CANCELLED: 'ملغاة'
  } as Record<string, string>,
  zoneLabels: {
    PARKING: 'الجراج',
    SECURITY: 'الأمن',
    LABORATORY: 'المعمل'
  } as Record<string, string>,
  roleLabels: {
    SUPER_ADMIN: 'أدمن رئيسي',
    PARKING_OPERATOR: 'موظف جراج',
    SECURITY_OPERATOR: 'موظف أمن',
    LAB_OPERATOR: 'موظف معمل',
    SUPERVISOR: 'مشرف / متابعة'
  } as Record<string, string>
} as const;
