import {
  createParamDecorator,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { memberships, roles } from '@boh/db';
import type { Request } from 'express';
import { AccessContext, type Grant } from './access.js';
import { DbService } from './db.service.js';

export interface AccessTokenClaims {
  sub: string;
  org: string | null;
}

export interface AuthedRequest extends Request {
  requestId: string;
  auth?: { userId: string; orgId: string | null };
  access?: AccessContext;
}

const IS_PUBLIC = 'boh:public';
const REQUIRES = 'boh:requires';

/** Skip authentication for this route. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export interface RequireOptions {
  /** Route param holding a site id; the permission must apply to that site. */
  siteParam?: string;
}

/** Require a permission in the current org (optionally for the site in a route param). */
export const Requires = (permission: string, options: RequireOptions = {}) =>
  SetMetadata(REQUIRES, { permission, ...options });

/** Injects the AccessContext built by PermissionsGuard. */
export const Access = createParamDecorator((_: unknown, ctx: ExecutionContext): AccessContext => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.access) throw new ForbiddenException('No organisation context');
  return req.access;
});

/** Injects { userId, orgId } from the access token (no org required). */
export const CurrentAuth = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
});

export const RequestMeta = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  return { requestId: req.requestId, ip: req.ip };
});

/** Global guard 1: verify the bearer token. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    req.requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Missing bearer token');
    try {
      const claims = await this.jwt.verifyAsync<AccessTokenClaims>(header.slice(7));
      req.auth = { userId: claims.sub, orgId: claims.org ?? null };
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}

/** Global guard 2: load the user's grants in the current org and enforce @Requires. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: DbService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const rule = this.reflector.getAllAndOverride<({ permission: string } & RequireOptions) | undefined>(REQUIRES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!rule) return true;
    if (!req.auth) throw new UnauthorizedException();
    const { userId, orgId } = req.auth;
    if (!orgId) throw new ForbiddenException('Select an organisation first (POST /auth/switch-org)');

    const grants = await this.db.tenant({ orgId, userId }, async (tx) => {
      const rows = await tx
        .select({
          roleKey: roles.key,
          scope: roles.scope,
          permissions: roles.permissions,
          siteIds: memberships.siteIds,
          userId: memberships.userId,
          orgId: memberships.orgId,
        })
        .from(memberships)
        .innerJoin(roles, eq(roles.id, memberships.roleId))
        .where(eq(memberships.userId, userId));
      return rows.filter((r) => r.orgId === orgId).map<Grant>((r) => ({
        roleKey: r.roleKey,
        scope: r.scope,
        permissions: r.permissions,
        siteIds: r.siteIds,
      }));
    });
    if (grants.length === 0) throw new ForbiddenException('Not a member of this organisation');

    const access = new AccessContext(orgId, userId, grants, req.requestId, req.ip);
    req.access = access;

    const siteId = rule.siteParam ? (req.params[rule.siteParam] as string | undefined) : undefined;
    const sites = access.sitesFor(rule.permission);
    const allowed = siteId ? access.can(rule.permission, siteId) : sites === 'all' || sites.length > 0;
    if (!allowed) throw new ForbiddenException(`Missing permission ${rule.permission}`);
    return true;
  }
}
