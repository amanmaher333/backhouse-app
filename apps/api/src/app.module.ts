import { Controller, Get, Global, Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import { sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from './config.js';
import { DbService } from './common/db.service.js';
import { JwtAuthGuard, PermissionsGuard, Public } from './common/auth.js';
import { ErrorFilter } from './common/errors.js';
import { AuthModule } from './modules/auth.js';
import { OrgStructureModule } from './modules/org-structure.js';
import { MembersModule } from './modules/members.js';
import { MatchingModule } from './modules/matching.js';
import { ItemsModule } from './modules/items.js';
import { SuppliersModule } from './modules/suppliers.js';
import { AgentsModule } from './agents/agents.module.js';
import { McpModule } from './mcp/mcp.module.js';
import { StockModule } from './modules/stock.js';
import { ProcurementModule } from './modules/procurement.js';
import { AccessTokenVerifier } from './common/access-tokens.js';
import { ChannelsModule } from './channels/channels.module.js';

@ApiTags('health')
@Controller('health')
class HealthController {
  constructor(private readonly db: DbService) {}

  @Public()
  @Get()
  async health() {
    await this.db.raw.execute(sql`select 1`);
    return { status: 'ok' };
  }
}

@Global()
@Module({})
class CoreModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: CoreModule,
      imports: [
        JwtModule.register({
          global: true,
          secret: config.JWT_ACCESS_SECRET,
          signOptions: { expiresIn: config.JWT_ACCESS_TTL as any },
        }),
      ],
      providers: [{ provide: APP_CONFIG, useValue: config }, DbService, AccessTokenVerifier],
      exports: [APP_CONFIG, DbService, AccessTokenVerifier],
    };
  }
}

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [CoreModule.forRoot(config), AuthModule, OrgStructureModule, MembersModule, MatchingModule, ItemsModule, SuppliersModule, StockModule, ProcurementModule, AgentsModule, ChannelsModule, McpModule],
      controllers: [HealthController],
      providers: [
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        { provide: APP_FILTER, useClass: ErrorFilter },
        // Order matters: authenticate first, then authorise.
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
      ],
    };
  }
}
