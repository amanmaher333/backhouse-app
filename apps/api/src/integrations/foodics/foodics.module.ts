import { Body, Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../../config.js';
import { Access, Public, Requires } from '../../common/auth.js';
import type { AccessContext } from '../../common/access.js';
import { FOODICS_API, foodicsApi } from './client.js';
import { FoodicsService } from './foodics.service.js';

const uuid = new ParseUUIDPipe({ version: '4' });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

class CallbackDto extends createZodDto(z.object({ code: z.string().min(1).max(500), state: z.string().min(10).max(200) })) {}
class UpdateDto extends createZodDto(z.object({ pushPurchases: z.boolean().optional(), importFrom: date.nullish() })) {}
class MapLocationDto extends createZodDto(z.object({ siteId: z.string().uuid().nullable() })) {}
class MapItemDto extends createZodDto(z.object({ itemId: z.string().uuid().nullable(), manualFactor: z.coerce.number().positive().max(1e9).nullish() })) {}
class ItemsQuery extends createZodDto(z.object({ filter: z.enum(['all', 'unmapped']).default('all') })) {}
class ProductsQuery extends createZodDto(z.object({ days: z.coerce.number().int().min(1).max(90).default(7) })) {}
class SalesQuery extends createZodDto(z.object({ from: date, to: date, siteId: z.string().uuid().optional() })) {}

@ApiTags('integrations')
@ApiBearerAuth()
@Controller('integrations/foodics')
export class FoodicsController {
  constructor(private readonly svc: FoodicsService) {}

  @Get() @Requires('pos:read')
  status(@Access() a: AccessContext) { return this.svc.status(a); }

  @Patch() @Requires('pos:manage')
  update(@Access() a: AccessContext, @Body() dto: UpdateDto) { return this.svc.update(a, dto); }

  @Post('connect') @Requires('pos:manage') @HttpCode(200)
  connect(@Access() a: AccessContext) { return this.svc.connect(a); }

  @Post('callback') @Requires('pos:manage') @HttpCode(200)
  callback(@Access() a: AccessContext, @Body() dto: CallbackDto) { return this.svc.callback(a, dto.code, dto.state); }

  @Post('disconnect') @Requires('pos:manage') @HttpCode(200)
  disconnect(@Access() a: AccessContext) { return this.svc.disconnect(a); }

  @Post('sync') @Requires('pos:manage') @HttpCode(200)
  sync(@Access() a: AccessContext) { return this.svc.syncNow(a); }

  @Get('locations') @Requires('pos:read')
  locations(@Access() a: AccessContext) { return this.svc.locations(a); }

  @Put('locations/:id') @Requires('pos:manage')
  mapLocation(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: MapLocationDto) { return this.svc.mapLocation(a, id, dto.siteId); }

  @Get('items') @Requires('pos:read')
  items(@Access() a: AccessContext, @Query() q: ItemsQuery) { return this.svc.posItemsList(a, q.filter); }

  @Put('items/:id') @Requires('pos:manage')
  mapItem(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: MapItemDto) { return this.svc.mapItem(a, id, dto); }

  @Get('products') @Requires('pos:read')
  products(@Access() a: AccessContext, @Query() q: ProductsQuery) { return this.svc.productsList(a, q.days); }

  @Get('sales') @Requires('pos:read')
  sales(@Access() a: AccessContext, @Query() q: SalesQuery) { return this.svc.sales(a, q); }

  @Get('pushes') @Requires('pos:read')
  pushes(@Access() a: AccessContext) { return this.svc.pushes(a); }

  @Post('pushes/:id/retry') @Requires('pos:manage') @HttpCode(200)
  retry(@Access() a: AccessContext, @Param('id', uuid) id: string) { return this.svc.retryPush(a, id); }

  /** Foodics webhooks (order.*, menu.updated). Public: Foodics doesn't sign them, so we only take a hint from them. */
  @Public() @Post('webhook') @HttpCode(200)
  webhook(@Body() body: unknown) { return this.svc.receiveWebhook(body); }
}

@Module({
  controllers: [FoodicsController],
  providers: [{ provide: FOODICS_API, inject: [APP_CONFIG], useFactory: (config: AppConfig) => foodicsApi(config) }, FoodicsService],
  exports: [FoodicsService],
})
export class FoodicsModule {}
