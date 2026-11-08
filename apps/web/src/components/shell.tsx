'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useI18n, type TKey } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import {
  IconBuilding,
  IconChevron,
  IconHome,
  IconList,
  IconLogout,
  IconMenu,
  IconSettings,
  IconShield,
  IconSidebar,
  IconSpark,
  IconStore,
  IconUsers,
} from './icons';
import { InstallButton, LangButton, SyncPill, ThemeButton } from './toolbar';
import { initials } from './ui';

interface NavItem {
  href: string;
  label: TKey;
  icon: (p: any) => ReactNode;
  perm?: string;
}

const MAIN: NavItem[] = [
  { href: '/overview', label: 'overview', icon: IconHome },
  { href: '/sites', label: 'sites', icon: IconStore, perm: 'site:read' },
  { href: '/insights', label: 'insights', icon: IconSpark },
];
const ADMIN: NavItem[] = [
  { href: '/members', label: 'members', icon: IconUsers, perm: 'member:read' },
  { href: '/roles', label: 'roles', icon: IconShield, perm: 'role:read' },
  { href: '/audit', label: 'audit', icon: IconList, perm: 'audit:read' },
  { href: '/settings', label: 'settings', icon: IconSettings, perm: 'org:read' },
];

function isActive(path: string, href: string) {
  return path === href || path.startsWith(`${href}/`);
}

export function AppShell({ children }: { children: ReactNode }) {
  const { t, pick } = useI18n();
  const { status, me, can, switchOrg, signOut } = useSession();
  const path = usePathname();
  const router = useRouter();
  const [drawer, setDrawer] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (status === 'anonymous') router.replace(`/login?next=${encodeURIComponent(path)}`);
  }, [status, router, path]);
  useEffect(() => setDrawer(false), [path]);
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem('boh.collapsed') === '1');
    } catch {}
  }, []);

  if (status !== 'authenticated' || !me) {
    return (
      <div className="empty" style={{ minHeight: '100dvh', alignContent: 'center' }}>
        {t('loading')}
      </div>
    );
  }

  if (!me.currentOrgId) {
    return (
      <div className="auth-panel" style={{ minHeight: '100dvh', maxWidth: 520, margin: '0 auto' }}>
        <h2>{t('pickOrg')}</h2>
        <div className="nav">
          {me.organizations.map((o) => (
            <button key={o.id} className="btn btn-quiet btn-block" onClick={() => switchOrg(o.id)}>
              {pick(o)}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const org = me.organizations.find((o) => o.id === me.currentOrgId);
  const visible = (items: NavItem[]) => items.filter((i) => !i.perm || can(i.perm));
  const all = [...visible(MAIN), ...visible(ADMIN)];
  const current = all.find((i) => isActive(path, i.href));
  const bottom = [...visible(MAIN), ...visible(ADMIN)].slice(0, 4);

  const navRows = (items: NavItem[]) =>
    visible(items).map((i) => (
      <Link key={i.href} href={i.href} className="nav-row" aria-current={isActive(path, i.href) ? 'page' : undefined} title={t(i.label)}>
        <i.icon />
        <span className="hide-collapsed">{t(i.label)}</span>
      </Link>
    ));

  return (
    <div className="shell" data-drawer={drawer ? 'open' : 'closed'} data-collapsed={collapsed}>
      <aside className="sidebar" aria-label={t('menu')}>
        <div className="brand">
          <div className="brand-logo">B</div>
          <div className="hide-collapsed">
            <div className="brand-name">{t('appName')}</div>
            <div className="brand-sub">{t('appSub')}</div>
          </div>
        </div>

        <label className="picker hide-collapsed">
          <span className="picker-icon">
            <IconBuilding width={18} height={18} />
          </span>
          <span style={{ minWidth: 0, flex: 1 }}>
            <span className="picker-label">{t('organization')}</span>
            <select value={me.currentOrgId} onChange={(e) => switchOrg(e.target.value)} aria-label={t('organization')}>
              {me.organizations.map((o) => (
                <option key={o.id} value={o.id}>
                  {pick(o)}
                </option>
              ))}
            </select>
          </span>
        </label>

        <nav className="nav">
          <div className="nav-label hide-collapsed">{t('navMain')}</div>
          {navRows(MAIN)}
          {visible(ADMIN).length > 0 && <div className="nav-label hide-collapsed">{t('navAdmin')}</div>}
          {navRows(ADMIN)}
        </nav>

        <div className="sidebar-foot">
          <span className="avatar">{initials(me.user.fullName)}</span>
          <div className="who hide-collapsed">
            <div style={{ fontWeight: 600 }}>{me.user.fullName}</div>
            <div className="faint" style={{ fontSize: 12 }}>
              {me.memberships.map((m) => m.roleName).join(', ')}
            </div>
          </div>
          <button className="icon-btn hide-collapsed" onClick={signOut} aria-label={t('signOut')} title={t('signOut')}>
            <IconLogout />
          </button>
        </div>
      </aside>
      {drawer && <div className="drawer-scrim" onClick={() => setDrawer(false)} />}

      <div className="main">
        <div className="topbar-sticky">
          <header className="topbar">
            <button className="icon-btn menu-btn" onClick={() => setDrawer(true)} aria-label={t('menu')}>
              <IconMenu />
            </button>
            <button
              className="icon-btn collapse-btn"
              aria-label={t('collapse')}
              title={t('collapse')}
              onClick={() => {
                setCollapsed(!collapsed);
                try {
                  localStorage.setItem('boh.collapsed', collapsed ? '0' : '1');
                } catch {}
              }}
            >
              <IconSidebar />
            </button>
            <span className="crumb">
              <span className="hide-phone">{org ? pick(org) : ''}</span>
              <IconChevron width={14} height={14} className="hide-phone flip-rtl" />
              <strong>{current ? t(current.label) : ''}</strong>
            </span>
            <div className="topbar-actions">
              <span className="hide-phone">
                <SyncPill />
              </span>
              <InstallButton />
              <LangButton />
              <ThemeButton />
            </div>
          </header>
        </div>

        <main className="content">{children}</main>
      </div>

      <nav className="bottombar" aria-label={t('menu')}>
        {bottom.map((i) => (
          <Link key={i.href} href={i.href} aria-current={isActive(path, i.href) ? 'page' : undefined}>
            <i.icon />
            {t(i.label)}
          </Link>
        ))}
        <button onClick={() => setDrawer(true)}>
          <IconMenu />
          {t('more')}
        </button>
      </nav>
    </div>
  );
}
