import { requireUser } from '@/lib/auth';
import { canManageUsers, canViewAudit, canViewReports, ROLE_LABEL } from '@/lib/rbac';
import { pool } from '@/db';
import { AppShell, type NavItem } from '@/components/shell/app-shell';
import { AR } from '@/lib/i18n';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { profile } = await requireUser();

  const items: NavItem[] = [
    { href: '/dashboard', label: AR.dashboard, icon: 'dashboard' },
    { href: '/visits', label: AR.visits, icon: 'trucks' },
    { href: '/notifications', label: AR.notifications, icon: 'notifications' }
  ];
  if (canViewReports(profile.role)) {
    items.push({ href: '/reports', label: AR.reports, icon: 'reports' });
  }
  if (canManageUsers(profile.role)) {
    items.push({ href: '/users', label: AR.users, icon: 'users' });
  }
  if (canViewAudit(profile.role)) {
    items.push({ href: '/audit', label: AR.audit, icon: 'audit' });
  }

  const unread = await pool.query(
    'select count(*)::int as c from notifications where target_role = $1::app_role and acknowledged_at is null',
    [profile.role]
  );
  const unreadCount = (unread.rows[0] as { c: number }).c;

  return (
    <AppShell
      items={items}
      name={profile.full_name}
      roleLabel={AR.roleLabels[profile.role] ?? ROLE_LABEL[profile.role]}
      unreadNotifications={unreadCount}
    >
      {children}
    </AppShell>
  );
}
