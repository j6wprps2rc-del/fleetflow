import { requireUser } from '@/lib/auth';
import { canManageUsers, ROLE_LABEL } from '@/lib/rbac';
import { pool } from '@/db';
import { AppShell, type NavItem } from '@/components/shell/app-shell';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { profile } = await requireUser();

  const items: NavItem[] = [
    { href: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
    { href: '/visits', label: 'Visits', icon: 'trucks' },
    { href: '/notifications', label: 'Notifications', icon: 'notifications' }
  ];
  if (canManageUsers(profile.role)) {
    items.push({ href: '/users', label: 'Users', icon: 'users' });
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
      roleLabel={ROLE_LABEL[profile.role]}
      unreadNotifications={unreadCount}
    >
      {children}
    </AppShell>
  );
}
