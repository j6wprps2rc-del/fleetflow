import { requireUser } from '@/lib/auth';
import { canUseSimulator, canViewReports, ROLE_LABEL } from '@/lib/rbac';
import { pool } from '@/db';
import { redirect } from 'next/navigation';
import { AppShell, type NavItem } from '@/components/shell/app-shell';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { profile } = await requireUser();

  const items: NavItem[] = [
    { href: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
    { href: '/visits', label: 'Visits', icon: 'trucks' },
    { href: '/notifications', label: ' Notifications', icon: 'notifications' }
  ];
  if (canViewReports(profile.role)) {
    items.push({ href: '/reports', label: 'Reports', icon: 'reports' });
  }
  if (canUseSimulator(profile.role)) {
    items.push({ href: '/simulator', label: 'Simulator', icon: 'simulator' });
  }
  if (canManageUsersSafe(profile.role)) {
    items.push({ href: '/users', label: 'Users', icon: 'users' });
  }
  if (canViewAuditSafe(profile.role)) {
    items.push({ href: '/audit', label: 'Audit Trail', icon: 'audit' });
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
      mapRoleLabel={ROLE_LABEL[profile.role]}
      unreadNotifications={unreadCount}
    >
      {children}
    </AppShell>
  );
}

function canManageUsersSafe(role: string): boolean {
  return role === 'SUPER_ADMIN';
}

function canViewAuditSafe(role: string): boolean {
  return role === 'Super Admin'.toUpperCase() ? true : role === 'SUPER_ADMIN';
}
