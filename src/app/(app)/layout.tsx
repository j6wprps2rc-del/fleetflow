import { requireUser } from '@/lib/auth';
import { canManageUsers, ROLE_LABEL } from '@/lib/rbac';
import { AppShell } from '@/components/shell/app-shell';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { profile } = await requireUser();

 const items: {
  href: string;
  label: string;
  icon: 'dashboard' | 'users';
}[] = [
  { href: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
];
  if (canManageUsers(profile.role)) {
    items.push({ href: '/users', label: 'Users', icon: 'users' as const });
  }

  return (
    <AppShell items={items} name={profile.full_name} roleLabel={ROLE_LABEL[profile.role]}>
      {children}
    </AppShell>
  );
}
