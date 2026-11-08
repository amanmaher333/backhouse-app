'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { PageHead } from '@/components/ui';
import { useI18n, type TKey } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import type { LegalEntity, Member, Site } from '@/lib/types';

interface Counts {
  sites: number;
  entities: number;
  entitiesWithVat: number;
  members: number | null;
  locations: number;
  sitesWithLocations: number;
}

export default function OverviewPage() {
  const { t, pick } = useI18n();
  const { api, me, can } = useSession();
  const [c, setC] = useState<Counts | null>(null);

  useEffect(() => {
    (async () => {
      const [sites, entities, members] = await Promise.all([
        can('site:read') ? api<Site[]>('/sites') : Promise.resolve([] as Site[]),
        can('legal_entity:read') ? api<LegalEntity[]>('/legal-entities') : Promise.resolve([] as LegalEntity[]),
        can('member:read') ? api<Member[]>('/members') : Promise.resolve(null),
      ]);
      const locs = can('location:read') ? await Promise.all(sites.map((s) => api<unknown[]>(`/sites/${s.id}/locations`).catch(() => []))) : [];
      setC({
        sites: sites.length,
        entities: entities.length,
        entitiesWithVat: entities.filter((e) => e.vatNumber && e.crNumber).length,
        members: members?.length ?? null,
        locations: locs.reduce((n, l) => n + l.length, 0),
        sitesWithLocations: locs.filter((l) => l.length > 0).length,
      });
    })().catch(() => setC(null));
  }, [api, can]);

  const org = me?.organizations.find((o) => o.id === me.currentOrgId);
  const steps: { label: TKey; done: boolean; href: string }[] = c
    ? [
        { label: 'stepEntity', done: c.entitiesWithVat > 0, href: '/settings' },
        { label: 'stepSite', done: c.sites > 0, href: '/sites' },
        { label: 'stepLocations', done: c.sites > 0 && c.sitesWithLocations === c.sites, href: '/sites' },
        { label: 'stepTeam', done: (c.members ?? 0) > 1, href: '/members' },
      ]
    : [];

  return (
    <div className="page">
      <PageHead title={org ? pick(org) : t('overview')} sub={t('overviewSub')} />

      <div className="stats">
        {can('site:read') && <Stat label={t('sites')} value={c?.sites} />}
        {can('location:read') && <Stat label={t('storageLocations')} value={c?.locations} />}
        {can('legal_entity:read') && <Stat label={t('legalEntities')} value={c?.entities} />}
        {can('member:read') && <Stat label={t('members')} value={c?.members ?? undefined} />}
      </div>

      <div className="grid-cards" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        {can('site:manage') && (
        <section className="card">
          <h2 className="card-title">{t('gettingStarted')}</h2>
          <div style={{ display: 'grid', gap: 4 }}>
            {steps.map((s) => (
              <Link key={s.label} href={s.href} className="nav-row" style={{ justifyContent: 'space-between', color: 'var(--t1)' }}>
                <span>{t(s.label)}</span>
                <span className={`tag ${s.done ? 'tag-accent' : ''}`}>
                  <span className="dot" />
                  {s.done ? t('done') : t('todo')}
                </span>
              </Link>
            ))}
          </div>
        </section>
        )}
        <section className="card">
          <h2 className="card-title">{t('comingNext')}</h2>
          <p className="muted" style={{ margin: 0 }}>
            {t('comingNextBody')}
          </p>
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value?: number }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value ?? '–'}</div>
    </div>
  );
}
