import {
  Body,
  Controller,
  Get,
  Global,
  HttpCode,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Access, MEMBER, Public, Requires, type AuthedRequest } from '../common/auth.js';
import type { AccessContext } from '../common/access.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { BillingService } from './billing.service.js';
import { PlatformBillingController, PlatformBillingService } from './platform-billing.js';
import { createPaymentProvider, PAYMENT_PROVIDER } from './payments.js';

const BILLING_EXEMPT = 'boh:billing-exempt';
/** Writes on this route stay allowed when the subscription is inactive (billing itself, sign-in flows). */
export const BillingExempt = () => SetMetadata(BILLING_EXEMPT, true);

/**
 * Global guard 3: an organisation without an active subscription is read-only.
 * Reads always work (it is their data); writes get 402 until someone pays.
 */
@Injectable()
export class EntitlementGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly billing: BillingService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (!req.access || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
    if (this.reflector.getAllAndOverride<boolean>(BILLING_EXEMPT, [context.getHandler(), context.getClass()])) return true;
    await this.billing.assertEntitled(req.access.orgId);
    return true;
  }
}

const TokenSchema = z.object({ token: z.string().min(4).max(200) });
class TokenDto extends createZodDto(TokenSchema) {}
const SubscribeSchema = z.object({ interval: z.enum(['month', 'year']) });
class SubscribeDto extends createZodDto(SubscribeSchema) {}
const SimSchema = z.object({ outcome: z.enum(['paid', 'failed']).default('paid') });
class SimDto extends createZodDto(SimSchema) {}

@ApiTags('billing')
@ApiBearerAuth()
@BillingExempt()
@Controller('billing')
class BillingController {
  constructor(private readonly svc: BillingService) {}

  /** Any member: drives the trial banner and read-only mode in the app. */
  @Get('status') @Requires(MEMBER)
  status(@Access() a: AccessContext) { return this.svc.status(a.orgId); }

  @Get() @Requires('billing:read')
  overview(@Access() a: AccessContext) { return this.svc.overview(a); }

  @Get('invoices/:id') @Requires('billing:read')
  invoice(@Access() a: AccessContext, @Param('id', new ParseUUIDPipe()) id: string) { return this.svc.invoice(a, id); }

  @Post('payment-method') @Requires('billing:manage') @HttpCode(200)
  card(@Access() a: AccessContext, @Body() dto: TokenDto) { return this.svc.setPaymentMethod(a, dto.token); }

  @Post('subscribe') @Requires('billing:manage') @HttpCode(200)
  subscribe(@Access() a: AccessContext, @Body() dto: SubscribeDto) { return this.svc.subscribe(a, dto.interval); }

  @Post('cancel') @Requires('billing:manage') @HttpCode(200)
  cancel(@Access() a: AccessContext) { return this.svc.cancel(a); }

  @Post('resume') @Requires('billing:manage') @HttpCode(200)
  resume(@Access() a: AccessContext) { return this.svc.resume(a); }

  @Post('pay-now') @Requires('billing:manage') @HttpCode(200)
  payNow(@Access() a: AccessContext) { return this.svc.payNow(a); }

  /** Development only: finish a simulated card verification (3-D Secure). */
  @Post('simulate/:paymentId') @Requires('billing:manage') @ApiExcludeEndpoint() @HttpCode(200)
  simulate(@Param('paymentId') paymentId: string, @Body() dto: SimDto) { return this.svc.simulateConfirm(paymentId, dto.outcome); }
}

/** The payment provider calls this; authenticated by the shared webhook secret in the body. */
@ApiTags('webhooks')
@Controller('webhooks/payments')
class PaymentsWebhookController {
  constructor(private readonly svc: BillingService) {}

  @Public() @Post() @HttpCode(200)
  receive(@Body() body: unknown) { return this.svc.handleWebhook(body); }
}

@Global()
@Module({
  controllers: [BillingController, PaymentsWebhookController, PlatformBillingController],
  providers: [BillingService, PlatformBillingService, EntitlementGuard, { provide: PAYMENT_PROVIDER, inject: [APP_CONFIG], useFactory: (c: AppConfig) => createPaymentProvider(c) }],
  exports: [BillingService, EntitlementGuard, PAYMENT_PROVIDER],
})
export class BillingModule {}
