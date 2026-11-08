import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { createDb, withTenant, withUser, type Db, type DbHandle, type TenantContext, type Tx } from '@boh/db';
import { APP_CONFIG, type AppConfig } from '../config.js';

/**
 * Database access. Three explicit modes:
 * - tenant(): RLS-restricted to one org. Use for every tenant request.
 * - user():   RLS-restricted to one user, no org (e.g. "my orgs").
 * - system(): owner privileges, bypasses RLS. Only for auth flows (signup, login,
 *             token refresh, invitation acceptance) where no tenant context exists yet.
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly handle: DbHandle;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.handle = createDb(config.DATABASE_URL);
  }

  get raw(): Db {
    return this.handle.db;
  }

  tenant<T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(this.handle.db, ctx, fn);
  }

  user<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withUser(this.handle.db, userId, fn);
  }

  system<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.handle.db.transaction(fn);
  }

  async onModuleDestroy(): Promise<void> {
    await this.handle.pool.end();
  }
}
