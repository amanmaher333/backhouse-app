import { Body, Controller, forwardRef, Get, HttpCode, Module, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Access, Requires } from '../common/auth.js';
import type { AccessContext } from '../common/access.js';
import { BillingModule } from '../billing/billing.module.js';
import { ChannelsModule } from '../channels/channels.module.js';
import { SavingsSchema, SavingsService } from './savings.js';
import { MonthlySavingsService } from './savings-monthly.js';

class SavingsDto extends createZodDto(SavingsSchema) {}
class MonthlyPreviewDto extends createZodDto(z.object({ send: z.boolean().default(false) })) {}

@ApiTags('savings')
@ApiBearerAuth()
@Controller('savings')
export class SavingsController {
  constructor(
    private readonly svc: SavingsService,
    private readonly monthly: MonthlySavingsService,
  ) {}

  @Get() @Requires('price:read')
  report(@Access() a: AccessContext, @Query() q: SavingsDto) { return this.svc.report(a, q); }

  /** Last month's WhatsApp report for me: preview, or send it to my WhatsApp now. */
  @Post('monthly-message') @HttpCode(200) @Requires('price:read')
  monthlyMessage(@Access() a: AccessContext, @Body() dto: MonthlyPreviewDto) { return this.monthly.preview(a, dto.send); }
}

@Module({ imports: [BillingModule, forwardRef(() => ChannelsModule)], controllers: [SavingsController], providers: [SavingsService, MonthlySavingsService], exports: [SavingsService, MonthlySavingsService] })
export class SavingsModule {}
