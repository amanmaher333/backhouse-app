import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { and, asc, desc, eq, gt, inArray, isNull, lt } from 'drizzle-orm';
import { auditEvents, invitations, isKnownPermission, memberships, PERMISSIONS, roles, sites, users, type Tx } from '@boh/db';
import { DbService } from '../common/db.service.js';
import { Access, Public, Requires } from '../common/auth.js';
import type { AccessContext } from '../common/access.js';
import { audit } from '../common/audit.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { newToken, sha256 } from './auth.js';

const uuid = new ParseUUIDPipe({ version: '4' });
const siteIds = z.array(z.string().uuid()).max(500).nullish();

const InviteSchema = z.object({
  email: z.string().email().transform((e) => e.trim().toLowerCase()),
  roleId: z.string().uuid(),
  siteIds,
});
class InviteDto extends createZodDto(InviteSchema) {}

const UpdateMembershipSchema = z.object({ roleId: z.string().uuid().optional(), siteIds });
class UpdateMembershipDto extends createZodDto(UpdateMembershipSchema) {}

const permissionList = z
  .array(z.string().refine(isKnownPermission, (p) => ({ message: `Unknown permission "${p}"` })))
  .min(1)
  .max(200);
const RoleSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, 'key must be snake_case'),
  name: z.string().min(1).max(100),
  nameAr: z.string().max(100).nullish(),
  scope: z.enum(['org', 'site']),
  permissions: permissionList,
});
class CreateRoleDto extends createZodDto(RoleSchema) {}
class UpdateRoleDto extends createZodDto(RoleSchema.omit({ key: true, scope: true }).partial()) {}

const AuditQuerySchema = z.object({
  entityType: z.string().max(50).optional(),
  entityId: z.string().max(100).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
class AuditQueryDto extends createZodDto(AuditQuerySchema) {}

@Injectable()
export class MembersService {
  constructor(
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Role must be visible to the org; grantor must already hold its permissions; site list must fit the scope. */
  private async checkAssignable(tx: Tx, a: AccessContext, roleId: string, siteIdList: string[] | null | undefined) {
    const [role] = await tx.select().from(roles).where(eq(roles.id, roleId));
    if (!role) throw new NotFoundException('role not found');
    if (!a.covers(role.permissions)) {
      throw new ForbiddenException('You cannot assign a role with permissions you do not hold');
    }
    if (role.scope === 'org' && siteIdList?.length) throw new BadRequestException('Org-scoped roles cannot be limited to sites');
    if (siteIdList?.length) {
      const found = await tx.select({ id: sites.id }).from(sites).where(inArray(sites.id, siteIdList));
      if (found.length !== new Set(siteIdList).size) throw new BadRequestException('One or more sites not found');
    }
    return role;
  }

  private async assertNotLastAdmin(tx: Tx, orgId: string, membershipId: string) {
    const admins = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .innerJoin(roles, eq(roles.id, memberships.roleId))
      .where(and(eq(memberships.orgId, orgId), eq(roles.key, 'org_admin'), isNull(roles.orgId)));
    if (admins.length === 1 && admins[0]!.id === membershipId) {
      throw new BadRequestException('Cannot remove or downgrade the last org admin');
    }
  }

  listMembers(a: AccessContext) {
    return this.db.tenant(a.tenant, (tx) =>
      tx
        .select({
          membershipId: memberships.id,
          userId: users.id,
          email: users.email,
          fullName: users.fullName,
          roleId: roles.id,
          roleKey: roles.key,
          roleName: roles.name,
          scope: roles.scope,
          siteIds: memberships.siteIds,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .innerJoin(roles, eq(roles.id, memberships.roleId))
        .where(eq(memberships.orgId, a.orgId))
        .orderBy(asc(users.fullName)),
    );
  }

  invite(a: AccessContext, dto: InviteDto) {
    return this.db.tenant(a.tenant, async (tx) => {
      await this.checkAssignable(tx, a, dto.roleId, dto.siteIds);
      const token = newToken();
      const [inv] = await tx
        .insert(invitations)
        .values({
          orgId: a.orgId,
          email: dto.email,
          roleId: dto.roleId,
          siteIds: dto.siteIds?.length ? dto.siteIds : null,
          tokenHash: sha256(token),
          invitedBy: a.userId,
          expiresAt: new Date(Date.now() + this.config.INVITE_TTL_DAYS * 86_400_000),
        })
        .returning();
      await audit(tx, a, { action: 'invitation.created', entityType: 'invitation', entityId: inv!.id, after: inv });
      // Email/WhatsApp delivery arrives in a later phase; the token is returned to the inviter for now.
      const { tokenHash: _t, ...rest } = inv!;
      return { ...rest, token };
    });
  }

  listInvitations(a: AccessContext) {
    return this.db.tenant(a.tenant, (tx) =>
      tx
        .select({ id: invitations.id, email: invitations.email, roleId: invitations.roleId, siteIds: invitations.siteIds, expiresAt: invitations.expiresAt, createdAt: invitations.createdAt })
        .from(invitations)
        .where(and(isNull(invitations.acceptedAt), gt(invitations.expiresAt, new Date())))
        .orderBy(desc(invitations.createdAt)),
    );
  }

  revokeInvitation(a: AccessContext, id: string) {
    return this.db.tenant(a.tenant, async (tx) => {
      const [before] = await tx.delete(invitations).where(and(eq(invitations.id, id), isNull(invitations.acceptedAt))).returning();
      if (!before) throw new NotFoundException('invitation not found');
      await audit(tx, a, { action: 'invitation.revoked', entityType: 'invitation', entityId: id, before });
    });
  }

  updateMembership(a: AccessContext, id: string, dto: UpdateMembershipDto) {
    return this.db.tenant(a.tenant, async (tx) => {
      const [before] = await tx.select().from(memberships).where(and(eq(memberships.id, id), eq(memberships.orgId, a.orgId)));
      if (!before) throw new NotFoundException('membership not found');
      const [currentRole] = await tx.select().from(roles).where(eq(roles.id, before.roleId));
      // You may only change memberships whose current role you could have granted yourself.
      if (currentRole && !a.covers(currentRole.permissions)) throw new ForbiddenException('You cannot modify this membership');
      const roleId = dto.roleId ?? before.roleId;
      const nextSites = dto.siteIds === undefined ? before.siteIds : dto.siteIds;
      await this.checkAssignable(tx, a, roleId, nextSites);
      if (roleId !== before.roleId) await this.assertNotLastAdmin(tx, a.orgId, id);
      const [after] = await tx
        .update(memberships)
        .set({ roleId, siteIds: nextSites?.length ? nextSites : null })
        .where(and(eq(memberships.id, id), eq(memberships.orgId, a.orgId)))
        .returning();
      await audit(tx, a, { action: 'membership.updated', entityType: 'membership', entityId: id, before, after });
      return after;
    });
  }

  removeMembership(a: AccessContext, id: string) {
    return this.db.tenant(a.tenant, async (tx) => {
      const [before] = await tx.select().from(memberships).where(and(eq(memberships.id, id), eq(memberships.orgId, a.orgId)));
      if (!before) throw new NotFoundException('membership not found');
      const [role] = await tx.select().from(roles).where(eq(roles.id, before.roleId));
      if (role && !a.covers(role.permissions)) throw new ForbiddenException('You cannot remove this membership');
      await this.assertNotLastAdmin(tx, a.orgId, id);
      await tx.delete(memberships).where(and(eq(memberships.id, id), eq(memberships.orgId, a.orgId)));
      await audit(tx, a, { action: 'membership.removed', entityType: 'membership', entityId: id, before });
    });
  }

  // Roles
  listRoles(a: AccessContext) {
    return this.db.tenant(a.tenant, (tx) => tx.select().from(roles).orderBy(desc(roles.isSystem), asc(roles.name)));
  }

  createRole(a: AccessContext, dto: CreateRoleDto) {
    if (!a.covers(dto.permissions)) throw new ForbiddenException('You cannot create a role with permissions you do not hold');
    return this.db.tenant(a.tenant, async (tx) => {
      const [role] = await tx.insert(roles).values({ ...dto, orgId: a.orgId, isSystem: false }).returning();
      await audit(tx, a, { action: 'role.created', entityType: 'role', entityId: role!.id, after: role });
      return role;
    });
  }

  updateRole(a: AccessContext, id: string, dto: UpdateRoleDto) {
    if (dto.permissions && !a.covers(dto.permissions)) throw new ForbiddenException('You cannot grant permissions you do not hold');
    return this.db.tenant(a.tenant, async (tx) => {
      const [before] = await tx.select().from(roles).where(and(eq(roles.id, id), eq(roles.orgId, a.orgId)));
      if (!before) throw new NotFoundException('role not found (system roles cannot be edited)');
      const [after] = await tx.update(roles).set(dto).where(eq(roles.id, id)).returning();
      await audit(tx, a, { action: 'role.updated', entityType: 'role', entityId: id, before, after });
      return after;
    });
  }

  deleteRole(a: AccessContext, id: string) {
    return this.db.tenant(a.tenant, async (tx) => {
      const inUse = await tx.select({ id: memberships.id }).from(memberships).where(eq(memberships.roleId, id)).limit(1);
      if (inUse.length) throw new BadRequestException('Role is assigned to members; reassign them first');
      const [before] = await tx.delete(roles).where(and(eq(roles.id, id), eq(roles.orgId, a.orgId))).returning();
      if (!before) throw new NotFoundException('role not found (system roles cannot be deleted)');
      await audit(tx, a, { action: 'role.deleted', entityType: 'role', entityId: id, before });
    });
  }

  // Audit
  listAudit(a: AccessContext, q: AuditQueryDto) {
    return this.db.tenant(a.tenant, (tx) => {
      const conds = [eq(auditEvents.orgId, a.orgId)];
      if (q.entityType) conds.push(eq(auditEvents.entityType, q.entityType));
      if (q.entityId) conds.push(eq(auditEvents.entityId, q.entityId));
      if (q.before) conds.push(lt(auditEvents.id, q.before));
      return tx.select().from(auditEvents).where(and(...conds)).orderBy(desc(auditEvents.id)).limit(q.limit);
    });
  }
}

@ApiTags('members')
@ApiBearerAuth()
@Controller()
export class MembersController {
  constructor(private readonly svc: MembersService) {}

  @Get('members') @Requires('member:read')
  list(@Access() a: AccessContext) { return this.svc.listMembers(a); }

  @Patch('members/:id') @Requires('member:manage')
  update(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: UpdateMembershipDto) { return this.svc.updateMembership(a, id, dto); }

  @Delete('members/:id') @Requires('member:manage') @HttpCode(204)
  remove(@Access() a: AccessContext, @Param('id', uuid) id: string) { return this.svc.removeMembership(a, id); }

  @Get('invitations') @Requires('member:manage')
  listInvitations(@Access() a: AccessContext) { return this.svc.listInvitations(a); }

  @Post('invitations') @Requires('member:manage')
  invite(@Access() a: AccessContext, @Body() dto: InviteDto) { return this.svc.invite(a, dto); }

  @Delete('invitations/:id') @Requires('member:manage') @HttpCode(204)
  revokeInvitation(@Access() a: AccessContext, @Param('id', uuid) id: string) { return this.svc.revokeInvitation(a, id); }

  @Get('roles') @Requires('role:read')
  listRoles(@Access() a: AccessContext) { return this.svc.listRoles(a); }

  @Public() @Get('permissions')
  listPermissions() { return PERMISSIONS; }

  @Post('roles') @Requires('role:manage')
  createRole(@Access() a: AccessContext, @Body() dto: CreateRoleDto) { return this.svc.createRole(a, dto); }

  @Patch('roles/:id') @Requires('role:manage')
  updateRole(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: UpdateRoleDto) { return this.svc.updateRole(a, id, dto); }

  @Delete('roles/:id') @Requires('role:manage') @HttpCode(204)
  deleteRole(@Access() a: AccessContext, @Param('id', uuid) id: string) { return this.svc.deleteRole(a, id); }

  @Get('audit-events') @Requires('audit:read')
  audit(@Access() a: AccessContext, @Query() q: AuditQueryDto) { return this.svc.listAudit(a, q); }
}

@Module({ controllers: [MembersController], providers: [MembersService] })
export class MembersModule {}
