import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Global,
  HttpCode,
  Inject,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { companyVerifications, legalEntities, memberships, organizations, type Tx } from '@boh/db';
import { companyNameSimilarity, country } from '@boh/domain';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DbService } from '../common/db.service.js';
import { Access, CurrentAuth, Requires } from '../common/auth.js';
import type { AccessContext } from '../common/access.js';
import { auditRaw } from '../common/audit.js';
import { createRegistry, REGISTRY_PROVIDER, RegistryUnavailableError, type RegistryProvider } from './registry.js';

/** Names this similar (0–1) to the register count as the same company. Below it, a person looks. */
export const NAME_MATCH_THRESHOLD = 0.6;
const MAX_PENDING_ATTEMPTS = 10;

/**
 * Company checks against the commercial register, with no one at Backhouse involved in the
 * normal case: an active CR whose name matches is verified on the spot; a missing or
 * expired CR is rejected with the reason; a name mismatch goes to a short review queue.
 */
@Injectable()
export class VerificationService {
  private readonly logger = new Logger('Verification');

  constructor(
    private readonly db: DbService,
    @Inject(REGISTRY_PROVIDER) private readonly registry: RegistryProvider,
  ) {}

  /** Check one legal entity's CR now. Safe to call any time; records every attempt. */
  async verifyLegalEntity(orgId: string, legalEntityId: string, actorUserId: string | null) {
    const [le] = await this.db.system((tx) => tx.select().from(legalEntities).where(and(eq(legalEntities.id, legalEntityId), eq(legalEntities.orgId, orgId))));
    if (!le) throw new NotFoundException('legal entity not found');
    if (!le.crNumber) {
      await this.db.system((tx) => tx.update(legalEntities).set({ verificationStatus: 'unverified', verifiedAt: null, registryName: null }).where(eq(legalEntities.id, le.id)));
      return { status: 'unverified' as const, reason: 'No CR number' };
    }
    let decision: { status: 'verified' | 'needs_review' | 'rejected' | 'pending'; reason: string | null; registry: Record<string, unknown> | null; score: number | null };
    const profile = country(le.country);
    let provider: string = this.registry.name;
    // Only Saudi CRs can be checked automatically (Wathq); elsewhere Backhouse reviews the licence.
    if (profile.registry !== 'wathq') {
      provider = 'manual';
      decision = { status: 'needs_review', reason: `No automatic register check for ${profile.name}; Backhouse reviews the commercial registration`, registry: null, score: null };
    } else try {
      const rec = await this.registry.lookupCr(le.crNumber, le.name);
      if (!rec.found) decision = { status: 'rejected', reason: 'CR number not found in the commercial register', registry: null, score: null };
      else if (rec.status !== 'active') decision = { status: 'rejected', reason: `The CR is ${rec.status}`, registry: rec, score: null };
      else {
        const score = Math.max(
          ...[le.name, le.nameAr].filter((n): n is string => !!n).flatMap((n) => [rec.name, rec.nameAr].filter((r): r is string => !!r).map((r) => companyNameSimilarity(n, r))),
        );
        decision =
          score >= NAME_MATCH_THRESHOLD
            ? { status: 'verified', reason: null, registry: rec, score }
            : { status: 'needs_review', reason: `The name does not match the register ("${rec.nameAr ?? rec.name}")`, registry: rec, score };
      }
    } catch (err) {
      if (!(err instanceof RegistryUnavailableError)) throw err;
      decision = { status: 'pending', reason: err.message, registry: null, score: null };
    }
    await this.db.system(async (tx) => {
      await tx.insert(companyVerifications).values({
        orgId,
        legalEntityId: le.id,
        number: le.crNumber!,
        status: decision.status,
        reason: decision.reason,
        provider,
        registry: decision.registry,
        nameScore: decision.score === null ? null : decision.score.toFixed(3),
      });
      const reg = decision.registry as { name?: string; nameAr?: string | null } | null;
      await tx
        .update(legalEntities)
        .set({
          verificationStatus: decision.status,
          verifiedAt: decision.status === 'verified' ? new Date() : null,
          registryName: reg ? (reg.nameAr ?? reg.name ?? null) : null,
        })
        .where(eq(legalEntities.id, le.id));
      await auditRaw(tx, { orgId, userId: actorUserId, requestId: 'verification', action: `legal_entity.verification_${decision.status}`, entityType: 'legal_entity', entityId: le.id, after: { cr: le.crNumber, reason: decision.reason, score: decision.score } });
    });
    return { status: decision.status, reason: decision.reason };
  }

  /** Whether the organisation has at least one verified legal entity. */
  async isVerified(tx: Tx, orgId: string) {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(legalEntities)
      .where(and(eq(legalEntities.orgId, orgId), eq(legalEntities.verificationStatus, 'verified')));
    return (row?.n ?? 0) > 0;
  }

  /** Worker: retry checks that could not reach the register. */
  async retryPending() {
    const pending = await this.db.system((tx) =>
      tx
        .select({ orgId: legalEntities.orgId, id: legalEntities.id })
        .from(legalEntities)
        .where(eq(legalEntities.verificationStatus, 'pending'))
        .limit(20),
    );
    let done = 0;
    for (const p of pending) {
      const [row] = await this.db.system((tx) =>
        tx.select({ n: sql<number>`count(*)::int` }).from(companyVerifications).where(and(eq(companyVerifications.legalEntityId, p.id), eq(companyVerifications.status, 'pending'))),
      );
      if ((row?.n ?? 0) >= MAX_PENDING_ATTEMPTS) continue; // stays pending; shows in the review queue
      try {
        await this.verifyLegalEntity(p.orgId, p.id, null);
        done++;
      } catch (err) {
        this.logger.error(`retry ${p.id}: ${(err as Error).message}`);
      }
    }
    return done;
  }

  // ---------- Backhouse review queue (the only manual step) ----------

  /** Platform admins are members of Backhouse's own organisation (type "platform"). */
  async assertPlatformAdmin(userId: string) {
    const [row] = await this.db.system((tx) =>
      tx
        .select({ id: memberships.id })
        .from(memberships)
        .innerJoin(organizations, eq(organizations.id, memberships.orgId))
        .where(and(eq(memberships.userId, userId), eq(organizations.type, 'platform'))),
    );
    if (!row) throw new ForbiddenException('Backhouse staff only');
  }

  async reviewQueue(userId: string, status: string) {
    await this.assertPlatformAdmin(userId);
    return this.db.system((tx) =>
      tx
        .select({ v: companyVerifications, legalName: legalEntities.name, legalNameAr: legalEntities.nameAr, orgName: organizations.name, entityStatus: legalEntities.verificationStatus })
        .from(companyVerifications)
        .innerJoin(legalEntities, eq(legalEntities.id, companyVerifications.legalEntityId))
        .innerJoin(organizations, eq(organizations.id, companyVerifications.orgId))
        // Only the latest check per entity, and only entities still in that state.
        .where(
          and(
            eq(companyVerifications.status, status),
            eq(legalEntities.verificationStatus, status),
            sql`${companyVerifications.id} = (select c2.id from company_verifications c2 where c2.legal_entity_id = ${companyVerifications.legalEntityId} order by c2.created_at desc limit 1)`,
          ),
        )
        .orderBy(desc(companyVerifications.createdAt))
        .limit(100),
    );
  }

  async decide(userId: string, verificationId: string, decision: 'approve' | 'deny', note: string | null) {
    await this.assertPlatformAdmin(userId);
    return this.db.system(async (tx) => {
      const [v] = await tx.select().from(companyVerifications).where(eq(companyVerifications.id, verificationId)).for('update');
      if (!v) throw new NotFoundException();
      if (v.status !== 'needs_review' || v.decidedAt) throw new BadRequestException('Already decided');
      const status = decision === 'approve' ? 'approved' : 'denied';
      await tx.update(companyVerifications).set({ status, decidedBy: userId, decidedAt: new Date(), decisionNote: note }).where(eq(companyVerifications.id, v.id));
      await tx
        .update(legalEntities)
        .set({ verificationStatus: decision === 'approve' ? 'verified' : 'rejected', verifiedAt: decision === 'approve' ? new Date() : null })
        .where(eq(legalEntities.id, v.legalEntityId));
      await auditRaw(tx, { orgId: v.orgId, userId, requestId: 'verification-review', action: `legal_entity.verification_${status}`, entityType: 'legal_entity', entityId: v.legalEntityId, after: { note } });
      return { id: v.id, status };
    });
  }

  history(a: AccessContext, legalEntityId: string) {
    return this.db.tenant(a.tenant, (tx) =>
      tx.select().from(companyVerifications).where(eq(companyVerifications.legalEntityId, legalEntityId)).orderBy(desc(companyVerifications.createdAt)).limit(20),
    );
  }
}

const DecideSchema = z.object({ decision: z.enum(['approve', 'deny']), note: z.string().max(500).nullish() });
class DecideDto extends createZodDto(DecideSchema) {}
const QueueSchema = z.object({ status: z.enum(['needs_review', 'pending', 'rejected']).default('needs_review') });
class QueueDto extends createZodDto(QueueSchema) {}

@ApiTags('verification')
@ApiBearerAuth()
@Controller()
class VerificationController {
  constructor(private readonly svc: VerificationService) {}

  /** Re-run the check (e.g. after fixing the CR or name). */
  @Post('legal-entities/:id/verify') @Requires('legal_entity:manage') @HttpCode(200)
  verify(@Access() a: AccessContext, @Param('id', new ParseUUIDPipe()) id: string) { return this.svc.verifyLegalEntity(a.orgId, id, a.userId); }

  @Get('legal-entities/:id/verifications') @Requires('legal_entity:read')
  history(@Access() a: AccessContext, @Param('id', new ParseUUIDPipe()) id: string) { return this.svc.history(a, id); }

  @Get('platform/verifications')
  queue(@CurrentAuth() auth: { userId: string }, @Query() q: QueueDto) { return this.svc.reviewQueue(auth.userId, q.status); }

  @Post('platform/verifications/:id/decide') @HttpCode(200)
  decide(@CurrentAuth() auth: { userId: string }, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: DecideDto) {
    return this.svc.decide(auth.userId, id, dto.decision, dto.note ?? null);
  }
}

@Global()
@Module({
  controllers: [VerificationController],
  providers: [VerificationService, { provide: REGISTRY_PROVIDER, inject: [APP_CONFIG], useFactory: (c: AppConfig) => createRegistry(c) }],
  exports: [VerificationService],
})
export class VerificationModule {}

