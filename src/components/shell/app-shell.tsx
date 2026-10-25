'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Bell, LayoutDashboard, LogOut, PanelLeft, Users, Truck } from 'lucide-react';
import { signOut } from '@/lib/auth-actions';

export interface NavItem {
  href: string;
  label: string;
  icon: 'dashboard' | 'users' | 'trucks' | 'notifications';
}

const ICONS = {
  dashboard: LayoutDashboard,
  users: Users,
  trucks: Truck,
  notifications: Bell
} as const;

export function AppShell({
  items,
  name,
  roleLabel,
  unreadNotifications = 0,
  children
}: {
  items: NavItem[];
  name: string;
  roleLabel: string;
  unreadNotifications?: number;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="flex min-h-screen">
      <aside
        className={`flex flex-col border-r border-ff-border bg-ff-surface transition-all duration-200 ${
          collapsed ? 'w-16' : 'w-60'
        }`}
      >
        <div className="flex h-14 items-center gap-2 border-b border-ff-border px-4">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-ff-cyan/30 bg-ff-cyan/10 text-xs font-bold text-ff-cyan">
            FF
          </span>
          {!collapsed ? <span className="text-sm font-bold tracking-widest text-white">FLEETFLOW</span> : null}
        </div>

        <nav className="flex flex-1 flex-col gap-1 p-3" aria-label="Main navigation">
          {items.map((item) => {
            const Icon = ICONS[item.icon];
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
                  active
                    ? 'bg-ff-petrol/20 text-white'
                    : 'text-slate-400 hover:bg-ff-bg hover:text-white'
                }`}
                title={item.label}
              >
                <Icon size={18} className="shrink-0" />
                {!collapsed ? <span className="truncate">{item.label}</span> : null}
                {item.icon === 'notifications' && unreadNotifications > 0 ? (
                  <span
                    aria-label={`${unreadNotifications} unread notifications`}
                    className="absolute right-2 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-ff-danger px-1 text-[10px] font-bold text-white"
                  >
                    {unreadNotifications > 99 ? '99+' : unreadNotifications}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between gap-4 border-b border-ff-border bg-ff-surface/60 px-4 backdrop-blur">
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="rounded-lg p-2 text-slate-400 transition hover:bg-ff-bg hover:text-white"
          >
            <PanelLeft size={18} />
          </button>

          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-sm font-medium leading-tight text-white">{name}</p>
              <p className="text-xs leading-tight text-slate-500">{roleLabel}</p>
            </div>
            <form action={signOut}>
              <button
                type="submit"
                className="flex items-center gap-2 rounded-lg border border-ff-border px-3 py-2 text-xs font-medium text-slate-400 transition hover:border-ff-danger/50 hover:text-ff-danger"
              >
                <LogOut size={14} />
                Sign out
              </button>
            </form>
          </div>
        </header>

        <main className="min-w-0 flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
