import { Body, Controller, Delete, Get, HttpCode, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Access, Requires } from '../common/auth.js';
import type { AccessContext } from '../common/access.js';
import { LlmWriter } from './llm.js';
import { ProcurementModule } from '../modules/procurement.js';
import { StockModule } from '../modules/stock.js';
import { SupplierMessagingModule } from '../channels/supplier-messenger.js';
import { AgentRuntime } from './runtime.js';
import { InvoicesModule } from '../invoices/invoices.module.js';
import { FoodCostModule } from '../modules/food-cost.js';
import { RecipesModule } from '../modules/recipes.js';
import { StockCountsModule } from '../modules/stock-counts.js';

const uuid = new ParseUUIDPipe({ version: '4' });
const level = z.enum(['suggest', 'approve', 'auto']);

const InstallSchema = z.object({ kind: z.string().min(1).max(60) });
class InstallDto extends createZodDto(InstallSchema) {}
const UpdateSchema = z.object({
  status: z.enum(['active', 'paused']).optional(),
  autonomy: z.record(z.string(), level).optional(),
  settings: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).optional(),
});
class UpdateDto extends createZodDto(UpdateSchema) {}
const RunSchema = z.object({ scan: z.boolean().default(true) });
class RunDto extends createZodDto(RunSchema) {}
const TasksSchema = z.object({
  status: z.enum(['open', 'closed', 'all']).default('open'),
  agentId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
class TasksDto extends createZodDto(TasksSchema) {}
const ApproveSchema = z.object({ actionId: z.string().min(1).max(60) });
class ApproveDto extends createZodDto(ApproveSchema) {}
const NoteSchema = z.object({ reason: z.string().max(1000).nullish(), note: z.string().max(1000).nullish() });
class NoteDto extends createZodDto(NoteSchema) {}

@ApiTags('agents')
@ApiBearerAuth()
@Controller()
export class AgentsController {
  constructor(private readonly rt: AgentRuntime) {}

  @Get('agents') @Requires('agent:read')
  list(@Access() a: AccessContext) { return this.rt.list(a); }

  @Post('agents') @Requires('agent:manage')
  install(@Access() a: AccessContext, @Body() dto: InstallDto) { return this.rt.install(a, dto.kind); }

  @Patch('agents/:id') @Requires('agent:manage')
  update(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: UpdateDto) { return this.rt.update(a, id, dto); }

  @Delete('agents/:id') @Requires('agent:manage') @HttpCode(204)
  remove(@Access() a: AccessContext, @Param('id', uuid) id: string) { return this.rt.remove(a, id); }

  @Post('agents/:id/run') @Requires('agent:manage') @HttpCode(200)
  async run(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: RunDto) {
    const { installed } = await this.rt.list(a);
    if (!installed.some((x) => x.id === id)) throw new NotFoundException('agent not found');
    return this.rt.run(id, 'manual', { scan: dto.scan });
  }

  @Get('agents/:id/runs') @Requires('agent:read')
  runs(@Access() a: AccessContext, @Param('id', uuid) id: string) { return this.rt.runs(a, id); }

  @Get('agent-tasks') @Requires('agent:read')
  tasks(@Access() a: AccessContext, @Query() q: TasksDto) { return this.rt.listTasks(a, q); }

  @Get('agent-tasks/count') @Requires('agent:read')
  count(@Access() a: AccessContext) { return this.rt.countOpen(a); }

  @Get('agent-tasks/:id') @Requires('agent:read')
  task(@Access() a: AccessContext, @Param('id', uuid) id: string) { return this.rt.getTask(a, id); }

  @Post('agent-tasks/:id/approve') @Requires('task:decide') @HttpCode(200)
  approve(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: ApproveDto) { return this.rt.approve(a, id, dto.actionId); }

  @Post('agent-tasks/:id/reject') @Requires('task:decide') @HttpCode(200)
  reject(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: NoteDto) { return this.rt.reject(a, id, dto.reason ?? null); }

  @Post('agent-tasks/:id/dismiss') @Requires('task:decide') @HttpCode(200)
  dismiss(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: NoteDto) { return this.rt.dismiss(a, id, dto.note ?? null); }
}

@Module({ imports: [ProcurementModule, StockModule, SupplierMessagingModule, InvoicesModule, FoodCostModule, RecipesModule, StockCountsModule], controllers: [AgentsController], providers: [AgentRuntime, LlmWriter], exports: [AgentRuntime] })
export class AgentsModule {}
