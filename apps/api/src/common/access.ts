import { permissionMatches } from '@boh/db';

export interface Grant {
  roleKey: string;
  scope: 'org' | 'site';
  permissions: string[];
  /** For site-scoped roles: NULL = all sites. Ignored for org-scoped roles. */
  siteIds: string[] | null;
}

/** What the current user may do in the current org. Built per request. */
export class AccessContext {
  constructor(
    readonly orgId: string,
    readonly userId: string,
    readonly grants: Grant[],
    readonly requestId: string,
    readonly ip: string | undefined,
  ) {}

  get tenant() {
    return { orgId: this.orgId, userId: this.userId };
  }

  /** True if any grant gives `perm` (for `siteId`, when given). */
  can(perm: string, siteId?: string): boolean {
    return this.grants.some((g) => {
      if (!g.permissions.some((p) => permissionMatches(p, perm))) return false;
      if (siteId === undefined || g.scope === 'org' || g.siteIds === null) return true;
      return g.siteIds.includes(siteId);
    });
  }

  /** Sites where `perm` applies: 'all', or an explicit list (possibly empty). */
  sitesFor(perm: string): 'all' | string[] {
    const ids = new Set<string>();
    for (const g of this.grants) {
      if (!g.permissions.some((p) => permissionMatches(p, perm))) continue;
      if (g.scope === 'org' || g.siteIds === null) return 'all';
      g.siteIds.forEach((s) => ids.add(s));
    }
    return [...ids];
  }

  /** Org-wide permissions only (used to stop privilege escalation). */
  holdsOrgWide(perm: string): boolean {
    return this.grants.some(
      (g) => (g.scope === 'org' || g.siteIds === null) && g.permissions.some((p) => permissionMatches(p, perm)),
    );
  }

  /** True if the user could themselves exercise every permission in `perms` org-wide. */
  covers(perms: string[]): boolean {
    return perms.every((p) => {
      // Wildcards can only be handed out by someone who holds the same wildcard org-wide.
      if (p === '*' || p.endsWith(':*')) {
        return this.grants.some(
          (g) => g.scope === 'org' && (g.permissions.includes('*') || g.permissions.includes(p)),
        );
      }
      return this.holdsOrgWide(p);
    });
  }
}
