/**
 * Permission catalogue and built-in roles.
 *
 * A permission is "resource:action". Roles hold lists of permissions and may
 * use "resource:*" or "*" wildcards. Site-scoped roles apply only to the sites
 * on the membership (or all sites when site_ids is NULL).
 */

export const PERMISSIONS = [
  'org:read',
  'org:manage',
  'legal_entity:read',
  'legal_entity:manage',
  'brand:read',
  'brand:manage',
  'site:read',
  'site:manage',
  'location:read',
  'location:manage',
  'cost_centre:read',
  'cost_centre:manage',
  'member:read',
  'member:manage',
  'role:read',
  'role:manage',
  'audit:read',
  'item:read',
  'item:manage',
  'par:manage',
  'supplier:read',
  'supplier:manage',
  'price:read',
  'price:manage',
  'agent:read',
  'agent:manage',
  'task:decide',
  'token:manage',
  'stock:read',
  'stock:manage',
  'po:read',
  'po:manage',
  'po:approve',
  'spend_limit:manage',
  'billing:read',
  'billing:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export interface SystemRoleDef {
  key: string;
  name: string;
  nameAr: string;
  scope: 'org' | 'site';
  permissions: string[];
}

// Billing is not part of "read everything": only admins and finance see the subscription.
const READ_ALL = PERMISSIONS.filter((p) => p.endsWith(':read') && p !== 'billing:read');

export const SYSTEM_ROLES: SystemRoleDef[] = [
  { key: 'org_admin', name: 'Org Admin', nameAr: 'مدير المؤسسة', scope: 'org', permissions: ['*'] },
  {
    key: 'data_manager',
    name: 'Data Manager',
    nameAr: 'مدير البيانات',
    scope: 'org',
    permissions: [...READ_ALL, 'location:manage', 'cost_centre:manage', 'brand:manage', 'item:manage', 'par:manage', 'supplier:manage', 'price:manage', 'task:decide', 'token:manage', 'stock:manage', 'po:manage'],
  },
  {
    key: 'ops_manager',
    name: 'Operations Manager',
    nameAr: 'مدير العمليات',
    scope: 'org',
    permissions: [...READ_ALL, 'site:manage', 'location:manage', 'member:manage', 'par:manage', 'supplier:manage', 'task:decide', 'token:manage', 'stock:manage', 'po:manage', 'po:approve', 'spend_limit:manage'],
  },
  {
    key: 'site_manager',
    name: 'Site Manager',
    nameAr: 'مدير الفرع',
    scope: 'site',
    permissions: ['site:read', 'location:read', 'location:manage', 'cost_centre:read', 'item:read', 'par:manage', 'supplier:read', 'price:read', 'stock:read', 'stock:manage', 'po:read', 'po:manage', 'agent:read', 'task:decide'],
  },
  { key: 'staff', name: 'Staff', nameAr: 'موظف', scope: 'site', permissions: ['site:read', 'location:read', 'item:read', 'stock:read', 'stock:manage', 'po:read'] },
  { key: 'drafter', name: 'Drafter', nameAr: 'محرر مسودات', scope: 'site', permissions: ['site:read', 'location:read', 'item:read', 'supplier:read', 'stock:read', 'po:read', 'po:manage'] },
  {
    key: 'accountant',
    name: 'Accountant',
    nameAr: 'محاسب',
    scope: 'org',
    permissions: ['org:read', 'legal_entity:read', 'site:read', 'cost_centre:read', 'audit:read', 'item:read', 'supplier:read', 'price:read', 'agent:read', 'stock:read', 'po:read', 'billing:read'],
  },
  // Agent roles: assigned only to agent identities, never to people.
  {
    key: 'agent_price_watch',
    name: 'Price Watch agent',
    nameAr: 'وكيل مراقبة الأسعار',
    scope: 'org',
    permissions: ['item:read', 'supplier:read', 'price:read', 'price:manage'],
  },
  {
    key: 'agent_purchasing',
    name: 'Purchasing agent',
    nameAr: 'وكيل المشتريات',
    scope: 'org',
    permissions: ['item:read', 'supplier:read', 'price:read', 'stock:read', 'site:read', 'po:read', 'po:manage'],
  },
];

export const isAgentRoleKey = (key: string) => key.startsWith('agent_');

export function permissionMatches(granted: string, required: string): boolean {
  if (granted === '*' || granted === required) return true;
  if (granted.endsWith(':*')) return required.startsWith(granted.slice(0, -1));
  return false;
}

export function isKnownPermission(p: string): boolean {
  if (p === '*') return true;
  if (p.endsWith(':*')) return PERMISSIONS.some((k) => k.startsWith(p.slice(0, -1)));
  return (PERMISSIONS as readonly string[]).includes(p);
}
