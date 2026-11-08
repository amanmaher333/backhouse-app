import type { AppConfig } from '../config.js';

export type CrStatus = 'active' | 'expired' | 'cancelled' | 'suspended' | 'unknown';
export type CrRecord =
  | { found: true; name: string; nameAr: string | null; status: CrStatus; issueDate?: string | null; expiryDate?: string | null; city?: string | null }
  | { found: false };

/** The register could not be asked (network, quota, auth): try again later. */
export class RegistryUnavailableError extends Error {}

export interface RegistryProvider {
  readonly name: 'simulated' | 'wathq';
  /** `hint` is the name the customer entered; only the simulator uses it. */
  lookupCr(cr: string, hint?: string): Promise<CrRecord>;
}

/**
 * Development and tests. CR numbers ending in 0000: not found; 9999: expired;
 * 8888: active under a different name; 7777: register unavailable. Anything else is
 * active under the name the customer entered.
 */
export class SimulatedRegistry implements RegistryProvider {
  readonly name = 'simulated' as const;

  async lookupCr(cr: string, hint?: string): Promise<CrRecord> {
    if (cr.endsWith('7777')) throw new RegistryUnavailableError('Simulated outage');
    if (cr.endsWith('0000')) return { found: false };
    if (cr.endsWith('9999')) return { found: true, name: hint ?? 'Company', nameAr: null, status: 'expired', expiryDate: '2025-01-01' };
    if (cr.endsWith('8888')) return { found: true, name: 'Riyadh Bakery Trading Est.', nameAr: 'مؤسسة مخابز الرياض التجارية', status: 'active', city: 'Riyadh' };
    return { found: true, name: hint ?? 'Company', nameAr: null, status: 'active', city: 'Riyadh' };
  }
}

const has = (v: unknown, ...words: string[]) => typeof v === 'string' && words.some((w) => v.toLowerCase().includes(w));

/** Maps a register status label (Arabic or English) to ours. */
export function mapCrStatus(label: unknown): CrStatus {
  if (has(label, 'active', 'نشط', 'قائم', 'ساري')) return 'active';
  if (has(label, 'expired', 'منتهي')) return 'expired';
  if (has(label, 'cancel', 'شطب', 'ملغ', 'deleted')) return 'cancelled';
  if (has(label, 'suspend', 'موقوف', 'معلق')) return 'suspended';
  return 'unknown';
}

/**
 * Ministry of Commerce commercial register through Wathq (api.wathq.sa).
 * The parser accepts several field spellings because the official response schema could
 * not be checked from this environment: confirm field names against the Wathq developer
 * portal before going live, and adjust WATHQ_BASE_URL to the subscribed API version.
 */
export class WathqRegistry implements RegistryProvider {
  readonly name = 'wathq' as const;

  constructor(private readonly config: AppConfig) {}

  async lookupCr(cr: string): Promise<CrRecord> {
    let r: Response;
    try {
      r = await fetch(`${this.config.WATHQ_BASE_URL.replace(/\/$/, '')}/info/${encodeURIComponent(cr)}`, {
        headers: { apiKey: this.config.WATHQ_API_KEY ?? '', accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new RegistryUnavailableError(`Wathq unreachable: ${(err as Error).message}`);
    }
    if (r.status === 404) return { found: false };
    if (!r.ok) throw new RegistryUnavailableError(`Wathq returned ${r.status}`);
    const b = (await r.json().catch(() => ({}))) as Record<string, any>;
    const name = b.crName ?? b.name ?? b.crEntityName ?? b.entityName ?? b.tradeName;
    if (!name) return { found: false };
    return {
      found: true,
      name: String(name),
      nameAr: b.crNameAr ?? b.nameAr ?? null,
      status: mapCrStatus(b.status?.nameEn ?? b.status?.name ?? b.status),
      issueDate: b.issueDate ?? b.issueDateGregorian ?? null,
      expiryDate: b.expiryDate ?? b.expiryDateGregorian ?? null,
      city: b.location?.name ?? b.address?.general?.city ?? null,
    };
  }
}

export const REGISTRY_PROVIDER = Symbol('REGISTRY_PROVIDER');

export function createRegistry(config: AppConfig): RegistryProvider {
  if (config.REGISTRY_PROVIDER === 'wathq') {
    if (!config.WATHQ_API_KEY) throw new Error('REGISTRY_PROVIDER=wathq needs WATHQ_API_KEY');
    return new WathqRegistry(config);
  }
  return new SimulatedRegistry();
}
