'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useI18n, type TKey } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import {
  IconBot,
  IconBox,
  IconCart,
  IconLayers,
  IconInbox,
  IconPlug,
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
  IconTruck,
  IconUsers,
  IconChat,
  IconCard,
  IconReceipt,
  IconStamp,
  IconShieldCheck,
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
  { href: '/inbox', label: 'inbox', icon: IconInbox, perm: 'agent:read' },
  { href: '/overview', label: 'overview', icon: IconHome },
  { href: '/orders', label: 'orders', icon: IconCart, perm: 'po:read' },
  { href: '/invoices', label: 'invoices', icon: IconReceipt, perm: 'invoice:read' },
  { href: '/sales', label: 'salesInvoices', icon: IconStamp, perm: 'sales_invoice:read' },
  { href: '/stock', label: 'stock', icon: IconLayers, perm: 'stock:read' },
  { href: '/items', label: 'items', icon: IconBox, perm: 'item:read' },
  { href: '/suppliers', label: 'suppliers', icon: IconTruck, perm: 'supplier:read' },
  { href: '/sites', label: 'sites', icon: IconStore, perm: 'site:read' },
  { href: '/insights', label: 'insights', icon: IconSpark },
  { href: '/whatsapp', label: 'whatsapp', icon: IconChat },
];
const ADMIN: NavItem[] = [
  { href: '/agents', label: 'agents', icon: IconBot, perm: 'agent:read' },
  { href: '/members', label: 'members', icon: IconUsers, perm: 'member:read' },
  { href: '/roles', label: 'roles', icon: IconShield, perm: 'role:read' },
  { href: '/audit', label: 'audit', icon: IconList, perm: 'audit:read' },
  { href: '/settings', label: 'settings', icon: IconSettings, perm: 'org:read' },
  { href: '/billing', label: 'billing', icon: IconCard, perm: 'billing:read' },
  { href: '/einvoicing', label: 'einvoicing', icon: IconShieldCheck, perm: 'sales_invoice:read' },
  { href: '/developers', label: 'developers', icon: IconPlug, perm: 'token:manage' },
];

function isActive(path: string, href: string) {
  return path === href || path.startsWith(`${href}/`);
}

export function AppShell({ children }: { children: ReactNode }) {
  const { t, pick } = useI18n();
  const { status, me, can, switchOrg, signOut, api } = useSession();
  const path = usePathname();
  const [inboxCount, setInboxCount] = useState(0);
  const canInbox = status === 'authenticated' && can('agent:read');
  // Inbox badge: refresh on navigation and every minute.
  useEffect(() => {
    if (!canInbox) return;
    const load = () => api<{ open: number }>('/agent-tasks/count').then((r) => setInboxCount(r.open)).catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    window.addEventListener('boh:inbox-changed', load);
    return () => {
      clearInterval(id);
      window.removeEventListener('boh:inbox-changed', load);
    };
  }, [api, canInbox, path]);
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
  // ZATCA e-invoicing pages only for organisations in a country that uses it.
  const zatcaPages = ['/sales', '/einvoicing'];
  const visible = (items: NavItem[]) => items.filter((i) => (!i.perm || can(i.perm)) && (!zatcaPages.includes(i.href) || org?.eInvoicing === 'zatca'));
  const all = [...visible(MAIN), ...visible(ADMIN)];
  const current = all.find((i) => isActive(path, i.href));
  const bottom = [...visible(MAIN), ...visible(ADMIN)].slice(0, 4);

  const navRows = (items: NavItem[]) =>
    visible(items).map((i) => (
      <Link key={i.href} href={i.href} className="nav-row" aria-current={isActive(path, i.href) ? 'page' : undefined} title={t(i.label)}>
        <i.icon />
        <span className="hide-collapsed">{t(i.label)}</span>
        {i.href === '/inbox' && inboxCount > 0 && <span className="nav-badge num hide-collapsed">{inboxCount}</span>}
      </Link>
    ));

  return (
    <div className="shell" data-drawer={drawer ? 'open' : 'closed'} data-collapsed={collapsed}>
      <aside className="sidebar" aria-label={t('menu')}>
        <div className="brand">
          <img className="brand-logo" src="/icons/icon.svg" alt="" width={36} height={36} />
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

        <main className="content">
          <TrialBanner />
          {children}
        </main>
      </div>

      <nav className="bottombar" aria-label={t('menu')}>
        {bottom.map((i) => (
          <Link key={i.href} href={i.href} aria-current={isActive(path, i.href) ? 'page' : undefined} style={{ position: 'relative' }}>
            <i.icon />
            {t(i.label)}
            {i.href === '/inbox' && inboxCount > 0 && <span className="bottom-badge num">{inboxCount}</span>}
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

/** Trial ending soon, failed payment, or read-only: one line under the top bar for every member. */
/** "5 days" / "5 أيام" (Arabic counts take different noun forms). */
export function daysLabel(n: number, lang: string) {
  if (lang !== 'ar') return `${n} ${n === 1 ? 'day' : 'days'}`;
  if (n === 1) return 'يوم واحد';
  if (n === 2) return 'يومين';
  return `${n} ${n <= 10 ? 'أيام' : 'يومًا'}`;
}

function TrialBanner() {
  const { t, fmtDate, lang } = useI18n();
  const { api, can, me } = useSession();
  const [st, setSt] = useState<{ status: string; entitled: boolean; trialEndsAt: string | null; interval?: string | null } | null>(null);
  const path = usePathname();
  useEffect(() => {
    if (!me?.currentOrgId) return;
    api<typeof st>('/billing/status').then(setSt).catch(() => setSt(null));
  }, [api, me?.currentOrgId, path]);
  if (!st) return null;
  const link = can('billing:read') ? <Link href="/billing">{t('billing')} →</Link> : null;
  if (!st.entitled) {
    return (
      <div className="trial-banner is-blocked" role="status">
        <span>{t('readOnlyNotice')}</span>
        {link}
      </div>
    );
  }
  if (st.status === 'past_due') {
    return (
      <div className="trial-banner is-blocked" role="status">
        <span>{t('sub_past_due')}</span>
        {link}
      </div>
    );
  }
  if (st.status === 'trialing' && st.trialEndsAt && !st.interval) {
    const days = Math.max(0, Math.ceil((new Date(st.trialEndsAt).getTime() - Date.now()) / 86400_000));
    if (days > 7) return null;
    return (
      <div className="trial-banner" role="status">
        <span>
          {days === 0 ? t('trialEndsToday') : t('trialEndsIn').replace('{n}', daysLabel(days, lang))} · {fmtDate(st.trialEndsAt)}
        </span>
        {link}
      </div>
    );
  }
  return null;
}
