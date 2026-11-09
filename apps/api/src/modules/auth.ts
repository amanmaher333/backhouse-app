import { Body, Controller, Get, HttpCode, Inject, Injectable, Module, Post, UnauthorizedException, BadRequestException, ForbiddenException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import {
  invitations,
  legalEntities,
  memberships,
  subscriptions,
  organizations,
  refreshTokens,
  roles,
  users,
  type Tx,
} from '@boh/db';
import { isValidKsaCrNumber, isValidKsaVatNumber } from '@boh/domain';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { BillingService } from '../billing/billing.service.js';
import { VerificationService } from '../verification/verification.js';
import { DbService } from '../common/db.service.js';
import { CurrentAuth, Public, RequestMeta, type AccessTokenClaims } from '../common/auth.js';
import { auditRaw } from '../common/audit.js';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

const password = z.string().min(10, 'Password must be at least 10 characters').max(200);
const email = z.string().email().max(254).transform((e) => e.trim().toLowerCase());

export const ksaVat = z.string().refine(isValidKsaVatNumber, 'KSA VAT number must be 15 digits starting and ending with 3');
export const ksaCr = z.string().refine(isValidKsaCrNumber, 'KSA CR number must be 10 digits');

const SignupSchema = z.object({
  email,
  password,
  fullName: z.string().min(1).max(200),
  phone: z.string().regex(/^\+[1-9]\d{6,14}$/, 'Phone must be E.164, e.g. +9665XXXXXXXX').optional(),
  locale: z.enum(['ar', 'en']).default('ar'),
  organization: z.object({
    name: z.string().min(1).max(200),
    nameAr: z.string().max(200).optional(),
    type: z.enum(['restaurant_group', 'supplier']).default('restaurant_group'),
  }),
  legalEntity: z
    .object({
      name: z.string().min(1).max(200),
      nameAr: z.string().max(200).optional(),
      vatNumber: ksaVat.optional(),
      crNumber: ksaCr.optional(),
    })
    .optional(),
});
class SignupDto extends createZodDto(SignupSchema) {}

const LoginSchema = z.object({ email, password: z.string().min(1) });
class LoginDto extends createZodDto(LoginSchema) {}

const RefreshSchema = z.object({ refreshToken: z.string().min(10), orgId: z.string().uuid().optional() });
class RefreshDto extends createZodDto(RefreshSchema) {}

const SwitchOrgSchema = z.object({ orgId: z.string().uuid() });
class SwitchOrgDto extends createZodDto(SwitchOrgSchema) {}

const AcceptInviteSchema = z.object({
  token: z.string().min(10),
  password,
  fullName: z.string().min(1).max(200).optional(),
});
class AcceptInviteDto extends createZodDto(AcceptInviteSchema) {}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  orgId: string | null;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DbService,
    private readonly jwt: JwtService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly verification: VerificationService,
  ) {}

  private async issue(tx: Tx, userId: string, orgId: string | null, familyId: string = randomUUID()): Promise<TokenPair> {
    const claims: AccessTokenClaims = { sub: userId, org: orgId };
    const accessToken = await this.jwt.signAsync(claims);
    const refreshToken = newToken();
    await tx.insert(refreshTokens).values({
      userId,
      tokenHash: sha256(refreshToken),
      familyId,
      expiresAt: new Date(Date.now() + this.config.JWT_REFRESH_TTL_DAYS * 86_400_000),
    });
    return { accessToken, refreshToken, orgId };
  }

  private async orgsFor(tx: Tx, userId: string) {
    return tx
      .selectDistinct({ id: organizations.id, name: organizations.name, nameAr: organizations.nameAr, type: organizations.type })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.orgId))
      .where(and(eq(memberships.userId, userId), eq(organizations.isActive, true)));
  }

  private async isMember(tx: Tx, userId: string, orgId: string): Promise<boolean> {
    const rows = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId)))
      .limit(1);
    return rows.length > 0;
  }

  async signup(dto: SignupDto, meta: { requestId: string; ip?: string }) {
    const result = await this.signupTx(dto, meta);
    // Check the CR with the commercial register right away (after the account exists, so a slow register never blocks sign-up).
    if (result.legalEntity?.crNumber) {
      const v = await this.verification.verifyLegalEntity(result.organization!.id, result.legalEntity.id, result.user.id).catch(() => null);
      if (v) result.legalEntity = { ...result.legalEntity, verificationStatus: v.status };
    }
    return result;
  }

  private async signupTx(dto: SignupDto, meta: { requestId: string; ip?: string }) {
    const passwordHash = await hash(dto.password);
    return this.db.system(async (tx) => {
      const existing = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${dto.email}`);
      if (existing.length) throw new ConflictException('An account with this email already exists');

      const [user] = await tx
        .insert(users)
        .values({ email: dto.email, passwordHash, fullName: dto.fullName, phone: dto.phone, locale: dto.locale })
        .returning();
      const [org] = await tx
        .insert(organizations)
        .values({ type: dto.organization.type, name: dto.organization.name, nameAr: dto.organization.nameAr, defaultLocale: dto.locale })
        .returning();
      const le = dto.legalEntity ?? { name: dto.organization.name, nameAr: dto.organization.nameAr };
      const [entity] = await tx
        .insert(legalEntities)
        .values({ orgId: org!.id, ...le, isVatRegistered: Boolean(dto.legalEntity?.vatNumber) })
        .returning();
      const [admin] = await tx.select().from(roles).where(and(isNull(roles.orgId), eq(roles.key, 'org_admin')));
      if (!admin) throw new Error('System roles not seeded; run migrations');
      await tx.insert(memberships).values({ orgId: org!.id, userId: user!.id, roleId: admin.id });
      // Restaurants start a free trial; suppliers are free. No one at Backhouse has to set anything up.
      await tx.insert(subscriptions).values(BillingService.initialSubscription(org!.id, dto.organization.type));

      const base = { orgId: org!.id, userId: user!.id, requestId: meta.requestId, ip: meta.ip };
      await auditRaw(tx, { ...base, action: 'org.created', entityType: 'organization', entityId: org!.id, after: org });
      await auditRaw(tx, { ...base, action: 'legal_entity.created', entityType: 'legal_entity', entityId: entity!.id, after: entity });

      const tokens = await this.issue(tx, user!.id, org!.id);
      return { user: publicUser(user!), organization: org, legalEntity: entity, ...tokens };
    });
  }

  async login(dto: LoginDto) {
    return this.db.system(async (tx) => {
      const [user] = await tx.select().from(users).where(sql`lower(${users.email}) = ${dto.email}`);
      // Verify against a dummy hash when the user is unknown, to keep timing similar.
      const ok = user?.passwordHash ? await verify(user.passwordHash, dto.password) : (await hash(dto.password), false);
      if (!user || !ok || !user.isActive) throw new UnauthorizedException('Invalid email or password');
      const orgs = await this.orgsFor(tx, user.id);
      const orgId = orgs.length === 1 ? orgs[0]!.id : null;
      const tokens = await this.issue(tx, user.id, orgId);
      return { user: publicUser(user), organizations: orgs, ...tokens };
    });
  }

  /** Rotate a refresh token. Reusing a revoked token revokes its whole family. */
  async refresh(dto: RefreshDto) {
    const result = await this.db.system(async (tx) => {
      const [row] = await tx.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, sha256(dto.refreshToken))).for('update');
      if (!row) throw new UnauthorizedException('Invalid refresh token');
      if (row.revokedAt) {
        // Revoke the whole family, and commit that before rejecting (throwing here would roll it back).
        await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)));
        return { reuse: true as const };
      }
      if (row.expiresAt <= new Date()) throw new UnauthorizedException('Refresh token expired');
      const [user] = await tx.select().from(users).where(eq(users.id, row.userId));
      if (!user?.isActive) throw new UnauthorizedException('Account disabled');

      await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, row.id));
      let orgId: string | null = null;
      if (dto.orgId) {
        if (!(await this.isMember(tx, user.id, dto.orgId))) throw new ForbiddenException('Not a member of this organisation');
        orgId = dto.orgId;
      } else {
        // Same rule as login: with exactly one organisation, select it.
        const orgs = await this.orgsFor(tx, user.id);
        if (orgs.length === 1) orgId = orgs[0]!.id;
      }
      return { reuse: false as const, tokens: await this.issue(tx, user.id, orgId, row.familyId) };
    });
    if (result.reuse) throw new UnauthorizedException('Refresh token reuse detected; please sign in again');
    return result.tokens;
  }

  async logout(refreshToken: string) {
    await this.db.system(async (tx) => {
      const [row] = await tx.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, sha256(refreshToken)));
      if (row) {
        await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)));
      }
    });
  }

  async switchOrg(userId: string, orgId: string) {
    return this.db.system(async (tx) => {
      if (!(await this.isMember(tx, userId, orgId))) throw new ForbiddenException('Not a member of this organisation');
      return this.issue(tx, userId, orgId);
    });
  }

  async me(userId: string, orgId: string | null) {
    const run = <T>(fn: (tx: Tx) => Promise<T>) => (orgId ? this.db.tenant({ orgId, userId }, fn) : this.db.user(userId, fn));
    return run(async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, userId));
      if (!user) throw new UnauthorizedException();
      const orgs = await this.orgsFor(tx, userId);
      const current = orgId
        ? await tx
            .select({ roleKey: roles.key, roleName: roles.name, scope: roles.scope, permissions: roles.permissions, siteIds: memberships.siteIds })
            .from(memberships)
            .innerJoin(roles, eq(roles.id, memberships.roleId))
            .where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId)))
        : [];
      return { user: publicUser(user), organizations: orgs, currentOrgId: orgId, memberships: current };
    });
  }

  async acceptInvitation(dto: AcceptInviteDto, meta: { requestId: string; ip?: string }) {
    return this.db.system(async (tx) => {
      const [inv] = await tx
        .select()
        .from(invitations)
        .where(and(eq(invitations.tokenHash, sha256(dto.token)), isNull(invitations.acceptedAt), gt(invitations.expiresAt, new Date())))
        .for('update');
      if (!inv) throw new BadRequestException('Invitation is invalid or has expired');

      let [user] = await tx.select().from(users).where(sql`lower(${users.email}) = ${inv.email.toLowerCase()}`);
      if (user) {
        // Existing account: prove ownership with its password.
        if (!user.passwordHash || !(await verify(user.passwordHash, dto.password))) {
          throw new UnauthorizedException('This email already has an account; enter its password to accept');
        }
      } else {
        if (!dto.fullName) throw new BadRequestException('fullName is required for new accounts');
        [user] = await tx.insert(users).values({ email: inv.email, fullName: dto.fullName, passwordHash: await hash(dto.password) }).returning();
      }
      const [m] = await tx
        .insert(memberships)
        .values({ orgId: inv.orgId, userId: user!.id, roleId: inv.roleId, siteIds: inv.siteIds })
        .onConflictDoUpdate({ target: [memberships.orgId, memberships.userId, memberships.roleId], set: { siteIds: inv.siteIds } })
        .returning();
      await tx.update(invitations).set({ acceptedAt: new Date() }).where(eq(invitations.id, inv.id));
      await auditRaw(tx, {
        orgId: inv.orgId, userId: user!.id, requestId: meta.requestId, ip: meta.ip,
        action: 'invitation.accepted', entityType: 'membership', entityId: m!.id, after: m,
      });
      const tokens = await this.issue(tx, user!.id, inv.orgId);
      return { user: publicUser(user!), ...tokens };
    });
  }
}

export function publicUser(u: typeof users.$inferSelect) {
  const { passwordHash: _ph, ...rest } = u;
  return rest;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('signup')
  signup(@Body() dto: SignupDto, @RequestMeta() meta: { requestId: string; ip?: string }) {
    return this.auth.signup(dto, meta);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Body() dto: RefreshDto) {
    await this.auth.logout(dto.refreshToken);
  }

  @Public()
  @Post('accept-invitation')
  acceptInvitation(@Body() dto: AcceptInviteDto, @RequestMeta() meta: { requestId: string; ip?: string }) {
    return this.auth.acceptInvitation(dto, meta);
  }

  @ApiBearerAuth()
  @Post('switch-org')
  @HttpCode(200)
  switchOrg(@CurrentAuth() auth: { userId: string }, @Body() dto: SwitchOrgDto) {
    return this.auth.switchOrg(auth.userId, dto.orgId);
  }

  @ApiBearerAuth()
  @Get('me')
  me(@CurrentAuth() auth: { userId: string; orgId: string | null }) {
    return this.auth.me(auth.userId, auth.orgId);
  }
}

@Module({ controllers: [AuthController], providers: [AuthService] })
export class AuthModule {}
