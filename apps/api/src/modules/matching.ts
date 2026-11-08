import { Body, Controller, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { aliasConfirmations, canonicalAliases, canonicalIngredients, corrections, type Tx } from '@boh/db';
import { MATCH_AUTO_MARGIN, MATCH_AUTO_SCORE, MATCH_SUGGEST_SCORE, normalizeName } from '@boh/domain';
import { DbService } from '../common/db.service.js';
import { Access, Requires } from '../common/auth.js';
import type { AccessContext } from '../common/access.js';

export interface Candidate {
  canonicalId: string;
  slug: string;
  nameEn: string;
  nameAr: string;
  category: string;
  baseUnit: string;
  allergens: string[];
  score: number;
}

export interface MatchResult {
  input: string;
  normalized: string;
  candidates: Candidate[];
  /** Set when the top candidate is confident enough to link without asking. */
  auto: Candidate | null;
}

/**
 * Score = average of trigram similarity and word similarity between the
 * normalised name and each alias. Seed aliases always count; learned aliases
 * count once at least 2 organisations have confirmed them.
 */
const SCORE = (q: string) =>
  sql<number>`max((similarity(${canonicalAliases.aliasNorm}, ${q}) + word_similarity(${canonicalAliases.aliasNorm}, ${q})) / 2)`;

@Injectable()
export class MatchingService {
  constructor(private readonly db: DbService) {}

  async match(tx: Tx, input: string, limit = 5): Promise<MatchResult> {
    const normalized = normalizeName(input);
    if (!normalized) return { input, normalized, candidates: [], auto: null };
    const rows = await tx
      .select({
        canonicalId: canonicalIngredients.id,
        slug: canonicalIngredients.slug,
        nameEn: canonicalIngredients.nameEn,
        nameAr: canonicalIngredients.nameAr,
        category: canonicalIngredients.category,
        baseUnit: canonicalIngredients.baseUnit,
        allergens: canonicalIngredients.allergens,
        score: SCORE(normalized).as('score'),
      })
      .from(canonicalAliases)
      .innerJoin(canonicalIngredients, eq(canonicalIngredients.id, canonicalAliases.canonicalId))
      .where(
        sql`(${canonicalAliases.source} = 'seed' or ${canonicalAliases.orgConfirmations} >= 2)
            and (${canonicalAliases.aliasNorm} % ${normalized} or ${canonicalAliases.aliasNorm} <% ${normalized} or ${normalized} <% ${canonicalAliases.aliasNorm})`,
      )
      .groupBy(canonicalIngredients.id)
      .orderBy(sql`score desc`)
      .limit(limit);
    const candidates = rows
      .map((r) => ({ ...r, score: Math.round(Number(r.score) * 1000) / 1000 }))
      .filter((c) => c.score >= MATCH_SUGGEST_SCORE);
    const [top, second] = candidates;
    const auto = top && top.score >= MATCH_AUTO_SCORE && top.score - (second?.score ?? 0) >= MATCH_AUTO_MARGIN ? top : null;
    return { input, normalized, candidates, auto };
  }

  async matchMany(access: AccessContext, names: string[]): Promise<MatchResult[]> {
    return this.db.tenant(access.tenant, async (tx) => {
      const out: MatchResult[] = [];
      for (const n of names) out.push(await this.match(tx, n));
      return out;
    });
  }

  search(access: AccessContext, q: string, limit = 20) {
    return this.db.tenant(access.tenant, async (tx) => {
      if (!q.trim()) {
        return tx.select().from(canonicalIngredients).orderBy(canonicalIngredients.category, canonicalIngredients.nameEn).limit(limit);
      }
      const r = await this.match(tx, q, limit);
      return r.candidates;
    });
  }

  /**
   * Record a person's decision about a match (training data), and teach the
   * shared map the item's name as an alias. The alias only takes effect once a
   * second organisation confirms the same name → ingredient pairing.
   */
  async recordHumanMatch(
    tx: Tx,
    access: AccessContext,
    subject: { type: string; id: string; name: string },
    modelOutput: unknown,
    canonicalId: string | null,
  ): Promise<void> {
    await tx.insert(corrections).values({
      orgId: access.orgId,
      kind: 'ingredient_match',
      subjectType: subject.type,
      subjectId: subject.id,
      input: { name: subject.name, normalized: normalizeName(subject.name) },
      modelOutput: modelOutput ?? null,
      humanOutput: { canonicalId },
      userId: access.userId,
    });
  }

  /** Runs on the owner connection after the tenant transaction commits. */
  async learnAlias(orgId: string, name: string, canonicalId: string): Promise<void> {
    const aliasNorm = normalizeName(name);
    if (!aliasNorm || aliasNorm.length < 2) return;
    await this.db.system(async (tx) => {
      const [alias] = await tx
        .insert(canonicalAliases)
        .values({ canonicalId, aliasNorm, source: 'learned' })
        .onConflictDoUpdate({ target: [canonicalAliases.canonicalId, canonicalAliases.aliasNorm], set: { aliasNorm } })
        .returning();
      if (alias!.source !== 'learned') return;
      const inserted = await tx.insert(aliasConfirmations).values({ aliasId: alias!.id, orgId }).onConflictDoNothing().returning();
      if (inserted.length) {
        await tx
          .update(canonicalAliases)
          .set({ orgConfirmations: sql`${canonicalAliases.orgConfirmations} + 1` })
          .where(and(eq(canonicalAliases.id, alias!.id)));
      }
    });
  }
}

const MatchSchema = z.object({ names: z.array(z.string().min(1).max(300)).min(1).max(200) });
class MatchDto extends createZodDto(MatchSchema) {}
const SearchSchema = z.object({ q: z.string().max(200).default(''), limit: z.coerce.number().int().min(1).max(100).default(20) });
class SearchDto extends createZodDto(SearchSchema) {}

@ApiTags('catalog')
@ApiBearerAuth()
@Controller()
export class MatchingController {
  constructor(
    private readonly svc: MatchingService,
    private readonly db: DbService,
  ) {}

  @Get('canonical-ingredients') @Requires('item:read')
  search(@Access() a: AccessContext, @Query() q: SearchDto) {
    return this.svc.search(a, q.q, q.limit);
  }

  @Get('canonical-ingredients/:id') @Requires('item:read')
  async get(@Access() a: AccessContext, @Param('id', new ParseUUIDPipe()) id: string) {
    const [row] = await this.db.tenant(a.tenant, (tx) => tx.select().from(canonicalIngredients).where(eq(canonicalIngredients.id, id)));
    if (!row) throw new NotFoundException('ingredient not found');
    return row;
  }

  @Post('catalog/match') @Requires('item:read') @HttpCode(200)
  match(@Access() a: AccessContext, @Body() dto: MatchDto) {
    return this.svc.matchMany(a, dto.names);
  }
}

@Module({ controllers: [MatchingController], providers: [MatchingService], exports: [MatchingService] })
export class MatchingModule {}
