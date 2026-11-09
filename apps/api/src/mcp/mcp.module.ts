import { Body, Controller, Delete, Get, HttpCode, Logger, Module, NotFoundException, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import type { Response } from 'express';
import type { IncomingMessage } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { accessTokens } from '@boh/db';
import { DbService } from '../common/db.service.js';
import { Access, MEMBER, Requires, type AuthedRequest } from '../common/auth.js';
import type { AccessContext } from '../common/access.js';
import { audit } from '../common/audit.js';
import { newAccessToken } from '../common/access-tokens.js';
import { ItemsModule, ItemsService } from '../modules/items.js';
import { SuppliersModule, SuppliersService } from '../modules/suppliers.js';
import { MatchingModule, MatchingService } from '../modules/matching.js';
import { AgentsModule } from '../agents/agents.module.js';
import { AgentRuntime } from '../agents/runtime.js';

const uuid = new ParseUUIDPipe({ version: '4' });

/* ---------------- Personal access tokens ---------------- */

const CreateTokenSchema = z.object({
  name: z.string().trim().min(1).max(100),
  expiresInDays: z.coerce.number().int().min(1).max(365).nullish(),
});
class CreateTokenDto extends createZodDto(CreateTokenSchema) {}

@ApiTags('access-tokens')
@ApiBearerAuth()
@Controller('access-tokens')
export class AccessTokensController {
  constructor(private readonly db: DbService) {}

  /** Your own tokens in the current organisation. */
  @Get() @Requires('token:manage')
  list(@Access() a: AccessContext) {
    return this.db.tenant(a.tenant, (tx) =>
      tx
        .select({ id: accessTokens.id, name: accessTokens.name, tokenPrefix: accessTokens.tokenPrefix, lastUsedAt: accessTokens.lastUsedAt, expiresAt: accessTokens.expiresAt, revokedAt: accessTokens.revokedAt, createdAt: accessTokens.createdAt })
        .from(accessTokens)
        .where(eq(accessTokens.userId, a.userId))
        .orderBy(desc(accessTokens.createdAt)),
    );
  }

  /** The token is returned once and never stored in plain text. */
  @Post() @Requires('token:manage')
  create(@Access() a: AccessContext, @Body() dto: CreateTokenDto) {
    if (a.actorType !== 'user') throw new NotFoundException();
    const t = newAccessToken();
    return this.db.tenant(a.tenant, async (tx) => {
      const [row] = await tx
        .insert(accessTokens)
        .values({ orgId: a.orgId, userId: a.userId, name: dto.name, tokenPrefix: t.prefix, tokenHash: t.hash, expiresAt: dto.expiresInDays ? new Date(Date.now() + dto.expiresInDays * 86_400_000) : null })
        .returning();
      await audit(tx, a, { action: 'access_token.created', entityType: 'access_token', entityId: row!.id, after: { name: row!.name, prefix: row!.tokenPrefix, expiresAt: row!.expiresAt } });
      return { id: row!.id, name: row!.name, tokenPrefix: row!.tokenPrefix, expiresAt: row!.expiresAt, token: t.token };
    });
  }

  @Delete(':id') @Requires('token:manage') @HttpCode(204)
  async revoke(@Access() a: AccessContext, @Param('id', uuid) id: string) {
    await this.db.tenant(a.tenant, async (tx) => {
      const [row] = await tx
        .update(accessTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(accessTokens.id, id), eq(accessTokens.userId, a.userId)))
        .returning();
      if (!row) throw new NotFoundException('token not found');
      await audit(tx, a, { action: 'access_token.revoked', entityType: 'access_token', entityId: id });
    });
  }
}

/* ---------------- MCP server ---------------- */

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

/**
 * Backhouse as an MCP server (Streamable HTTP, stateless). Each request builds a
 * server whose tools are limited to what the caller may do, and every tool
 * call goes through the same services, row-level security and audit log as
 * the REST API.
 */
@ApiTags('mcp')
@Controller('mcp')
export class McpController {
  private readonly logger = new Logger('MCP');

  constructor(
    private readonly items: ItemsService,
    private readonly suppliers: SuppliersService,
    private readonly matching: MatchingService,
    private readonly agents: AgentRuntime,
  ) {}

  private buildServer(a: AccessContext): McpServer {
    const server = new McpServer(
      { name: 'boh', version: '0.1.0' },
      { instructions: 'Backhouse restaurant back office: items, suppliers, prices, the shared ingredient map, and the agent inbox. Prices are in SAR.' },
    );
    const guard = async <T>(fn: () => Promise<T>) => {
      try {
        return json(await fn());
      } catch (err) {
        return fail((err as Error).message);
      }
    };

    if (a.can('item:read')) {
      server.registerTool(
        'search_items',
        {
          title: 'Search items',
          description: 'Search the catalogue by name or code (English or Arabic). Returns items with category, base unit, linked ingredient and best cost per base unit.',
          inputSchema: { query: z.string().max(200).optional(), category: z.string().optional(), limit: z.number().int().min(1).max(100).default(25) },
          annotations: { readOnlyHint: true },
        },
        ({ query, category, limit }) => guard(() => this.items.list(a, { q: query, category: category as any, active: 'true', limit, offset: 0 })),
      );
      server.registerTool(
        'get_item',
        { title: 'Get item', description: 'Full details for one item: packs, supplier prices, par levels, linked ingredient.', inputSchema: { item_id: z.string().uuid() }, annotations: { readOnlyHint: true } },
        ({ item_id }) => guard(() => this.items.get(a, item_id)),
      );
      server.registerTool(
        'match_ingredients',
        {
          title: 'Match ingredient names',
          description: 'Match messy item names (e.g. from an invoice, in English or Arabic) to the shared ingredient map. Returns candidates with scores and an automatic match when confident.',
          inputSchema: { names: z.array(z.string().min(1).max(300)).min(1).max(50) },
          annotations: { readOnlyHint: true },
        },
        ({ names }) => guard(() => this.matching.matchMany(a, names)),
      );
    }
    if (a.can('supplier:read')) {
      server.registerTool(
        'list_suppliers',
        { title: 'List suppliers', description: 'Suppliers with ordering channel, contact and number of items.', inputSchema: {}, annotations: { readOnlyHint: true } },
        () => guard(() => this.suppliers.list(a)),
      );
      server.registerTool(
        'get_supplier',
        { title: 'Get supplier', description: 'One supplier with delivery schedule and catalogue lines (prices if permitted).', inputSchema: { supplier_id: z.string().uuid() }, annotations: { readOnlyHint: true } },
        ({ supplier_id }) => guard(() => this.suppliers.get(a, supplier_id)),
      );
    }
    if (a.can('price:read')) {
      server.registerTool(
        'recent_price_changes',
        {
          title: 'Recent price changes',
          description: 'Supplier price changes in the last N days, newest first, with percentage change.',
          inputSchema: { days: z.number().int().min(1).max(365).default(30), limit: z.number().int().min(1).max(200).default(50) },
          annotations: { readOnlyHint: true },
        },
        ({ days, limit }) => guard(() => this.suppliers.priceChanges(a, { days, limit })),
      );
    }
    if (a.can('price:manage')) {
      server.registerTool(
        'set_supplier_price',
        {
          title: 'Set supplier price',
          description: 'Record a new price for a supplier catalogue line (SAR, per pack). Creates price history and notifies agents.',
          inputSchema: { supplier_item_id: z.string().uuid(), price: z.number().min(0).max(10_000_000) },
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        },
        ({ supplier_item_id, price }) => guard(() => this.suppliers.setPrice(a, supplier_item_id, { price: price.toFixed(4) } as any)),
      );
    }
    if (a.can('agent:read')) {
      server.registerTool(
        'list_agent_tasks',
        {
          title: 'List agent tasks',
          description: 'The agent inbox: work agents propose or have done, with evidence and the actions you can approve.',
          inputSchema: { status: z.enum(['open', 'closed', 'all']).default('open'), limit: z.number().int().min(1).max(100).default(20) },
          annotations: { readOnlyHint: true },
        },
        ({ status, limit }) => guard(() => this.agents.listTasks(a, { status, limit })),
      );
    }
    if (a.can('task:decide')) {
      server.registerTool(
        'approve_agent_task',
        {
          title: 'Approve an agent action',
          description: 'Approve one of the actions proposed on an agent task; the agent carries it out. Use list_agent_tasks first to see action ids.',
          inputSchema: { task_id: z.string().uuid(), action_id: z.string().min(1).max(60) },
          annotations: { readOnlyHint: false, destructiveHint: true },
        },
        ({ task_id, action_id }) => guard(() => this.agents.approve(a, task_id, action_id, 'api')),
      );
      server.registerTool(
        'reject_agent_task',
        {
          title: 'Reject an agent task',
          description: 'Reject an agent proposal, optionally with a reason (used to improve the agent).',
          inputSchema: { task_id: z.string().uuid(), reason: z.string().max(1000).optional() },
          annotations: { readOnlyHint: false, destructiveHint: false },
        },
        ({ task_id, reason }) => guard(() => this.agents.reject(a, task_id, reason ?? null, 'api')),
      );
    }
    return server;
  }

  @Post() @Requires(MEMBER)
  async handle(@Access() a: AccessContext, @Req() req: AuthedRequest, @Res() res: Response) {
    const server = this.buildServer(a);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      // Our req.auth (user/org) differs from MCP's AuthInfo shape; tools use the AccessContext instead.
      await transport.handleRequest(req as unknown as IncomingMessage, res, req.body);
    } catch (err) {
      this.logger.error((err as Error).message);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  }

  /** Stateless server: no SSE stream or sessions to resume or end. */
  @Get() @Requires(MEMBER)
  get(@Res() res: Response) {
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  }

  @Delete() @Requires(MEMBER)
  del(@Res() res: Response) {
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  }
}

@Module({ imports: [ItemsModule, SuppliersModule, MatchingModule, AgentsModule], controllers: [AccessTokensController, McpController] })
export class McpModule {}
