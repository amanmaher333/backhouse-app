import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { normalizeName } from '@boh/domain';
import { canonicalAliases, canonicalIngredients } from './schema.js';
import { CANONICAL_SEED } from './canonical-seed.js';

/**
 * Upsert the shared ingredient map from the seed. Idempotent; never removes
 * learned aliases. Must run with owner (non-RLS) privileges.
 */
export async function syncCanonicalIngredients(db: NodePgDatabase<any>): Promise<number> {
  for (const s of CANONICAL_SEED) {
    const values = {
      nameEn: s.en,
      nameAr: s.ar,
      category: s.category,
      baseUnit: s.unit,
      densityGPerMl: s.density !== undefined ? String(s.density) : null,
      eachWeightG: s.eachG !== undefined ? String(s.eachG) : null,
      allergens: s.allergens ?? [],
    };
    const [row] = await db
      .insert(canonicalIngredients)
      .values({ slug: s.slug, ...values })
      .onConflictDoUpdate({ target: canonicalIngredients.slug, set: values })
      .returning({ id: canonicalIngredients.id });

    const names = new Set([s.en, s.ar, ...(s.aliases ?? [])].map(normalizeName).filter(Boolean));
    for (const aliasNorm of names) {
      await db
        .insert(canonicalAliases)
        .values({ canonicalId: row!.id, aliasNorm, source: 'seed' })
        .onConflictDoUpdate({
          target: [canonicalAliases.canonicalId, canonicalAliases.aliasNorm],
          set: { source: sql`case when ${canonicalAliases.source} = 'learned' then 'seed' else ${canonicalAliases.source} end` },
        });
    }
  }
  const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(canonicalIngredients)) as [{ n: number }];
  return n;
}

