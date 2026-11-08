import { Body, Controller, Delete, Get, Headers, HttpCode, Module, Patch, Post, Query, Req, type RawBodyRequest } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { Request } from 'express';
import { Access, CurrentAuth, MEMBER, Public, Requires } from '../common/auth.js';
import type { AccessContext } from '../common/access.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { AgentsModule } from '../agents/agents.module.js';
import { ChannelsService } from './channels.service.js';
import { DigestService } from './digest.js';
import { createTransport, WHATSAPP_TRANSPORT } from './transport.js';

const TIME_ZONES = ['Asia/Riyadh', 'Asia/Dubai', 'Asia/Qatar', 'Asia/Bahrain', 'Asia/Kuwait', 'Asia/Muscat'] as const;
const PrefsSchema = z
  .object({
    approvalsEnabled: z.boolean().optional(),
    digestEnabled: z.boolean().optional(),
    digestHour: z.number().int().min(0).max(23).optional(),
    timeZone: z.enum(TIME_ZONES).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
class PrefsDto extends createZodDto(PrefsSchema) {}
const OrgSettingsSchema = z.object({ whatsappApprovalMax: z.number().min(0).max(10_000_000) });
class OrgSettingsDto extends createZodDto(OrgSettingsSchema) {}
const LogSchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
class LogDto extends createZodDto(LogSchema) {}
const SimSendSchema = z
  .object({ from: z.string().max(30).optional(), text: z.string().max(1000).optional(), payload: z.string().max(256).optional(), title: z.string().max(40).optional() })
  .refine((v) => v.text || v.payload, 'text or payload is required');
class SimSendDto extends createZodDto(SimSendSchema) {}
const SimThreadSchema = z.object({ from: z.string().max(30).optional() });
class SimThreadDto extends createZodDto(SimThreadSchema) {}
const DigestSchema = z.object({ send: z.boolean().default(false) });
class DigestDto extends createZodDto(DigestSchema) {}

/** Meta calls these; they are authenticated by the verify token and the payload signature. */
@ApiTags('webhooks')
@Controller('webhooks/whatsapp')
class WhatsAppWebhookController {
  constructor(private readonly svc: ChannelsService) {}

  @Public() @Get()
  verify(@Query('hub.mode') mode?: string, @Query('hub.verify_token') token?: string, @Query('hub.challenge') challenge?: string) {
    return this.svc.verifySubscription(mode, token, challenge);
  }

  @Public() @Post() @HttpCode(200)
  async receive(@Req() req: RawBodyRequest<Request>, @Headers('x-hub-signature-256') signature?: string) {
    this.svc.verifySignature(req.rawBody, signature);
    return this.svc.handleWebhook(req.body);
  }
}

@ApiTags('whatsapp')
@ApiBearerAuth()
@Controller()
class ChannelsController {
  constructor(
    private readonly svc: ChannelsService,
    private readonly digest: DigestService,
  ) {}

  // The signed-in person's own WhatsApp link (works in any org).
  @Get('me/whatsapp')
  mine(@CurrentAuth() auth: { userId: string }) { return this.svc.myChannel(auth.userId); }

  @Post('me/whatsapp/link')
  link(@CurrentAuth() auth: { userId: string }) { return this.svc.startLink(auth.userId); }

  @Patch('me/whatsapp')
  prefs(@CurrentAuth() auth: { userId: string }, @Body() dto: PrefsDto) { return this.svc.updateMine(auth.userId, dto); }

  @Delete('me/whatsapp')
  unlink(@CurrentAuth() auth: { userId: string }) { return this.svc.unlink(auth.userId); }

  @Get('me/whatsapp/simulator') @ApiExcludeEndpoint()
  thread(@CurrentAuth() auth: { userId: string }, @Query() q: SimThreadDto) { return this.svc.simulatorThread(auth.userId, q.from); }

  @Post('me/whatsapp/simulator') @ApiExcludeEndpoint() @HttpCode(200)
  simulate(@CurrentAuth() auth: { userId: string }, @Body() dto: SimSendDto) { return this.svc.simulatorSend(auth.userId, dto); }

  /** Today's digest for me in the current org: preview, or send it now. */
  @Post('me/whatsapp/digest') @Requires(MEMBER) @HttpCode(200)
  digestNow(@Access() a: AccessContext, @Body() dto: DigestDto) { return this.digest.preview(a, dto.send); }

  // Org-wide WhatsApp settings and message log.
  @Get('channels/settings') @Requires('org:read')
  settings(@Access() a: AccessContext) { return this.svc.orgSettings(a); }

  @Patch('channels/settings') @Requires('org:manage')
  updateSettings(@Access() a: AccessContext, @Body() dto: OrgSettingsDto) { return this.svc.updateOrgSettings(a, dto); }

  @Get('channels/messages') @Requires('audit:read')
  messages(@Access() a: AccessContext, @Query() q: LogDto) { return this.svc.messages(a, q.limit); }
}

@Module({
  imports: [AgentsModule],
  controllers: [WhatsAppWebhookController, ChannelsController],
  providers: [ChannelsService, DigestService, { provide: WHATSAPP_TRANSPORT, inject: [APP_CONFIG], useFactory: (config: AppConfig) => createTransport(config) }],
  exports: [ChannelsService, DigestService, WHATSAPP_TRANSPORT],
})
export class ChannelsModule {}
