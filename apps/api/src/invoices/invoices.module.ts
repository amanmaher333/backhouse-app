import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  StreamableFile,
  UnauthorizedException,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { inboundEmails, invoiceDocuments, invoiceInboxes } from '@boh/db';
import { createHash } from 'node:crypto';
import { Access, Public, Requires } from '../common/auth.js';
import type { AccessContext } from '../common/access.js';
import { DbService } from '../common/db.service.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { SupplierMessagingModule } from '../channels/supplier-messenger.js';
import { ACCEPTED_TYPES, IMAGE_TYPES, InvoiceExtractor } from './extractor.js';
import { InvoicesService } from './invoices.service.js';

const uuid = new ParseUUIDPipe({ version: '4' });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const docType = z.enum(['invoice', 'credit_note', 'debit_note']);

const LineSchema = z.object({
  description: z.string().trim().min(1).max(500),
  sku: z.string().max(80).nullish(),
  qty: z.coerce.number().min(0).max(1_000_000),
  unit: z.string().max(30).nullish(),
  unitPrice: z.coerce.number().min(0).max(10_000_000),
  lineTotal: z.coerce.number().min(-10_000_000).max(100_000_000).nullish(),
  taxRate: z.coerce.number().min(0).max(1).nullish(),
  poLineId: z.string().uuid().nullish(),
});
const money = z.coerce.number().min(-100_000_000).max(100_000_000).nullish();

const ManualSchema = z.object({
  type: docType.default('invoice'),
  relationshipId: z.string().uuid(),
  siteId: z.string().uuid().nullish(),
  poId: z.string().uuid().nullish(),
  number: z.string().trim().min(1).max(60),
  issueDate: date,
  dueDate: date.nullish(),
  subtotal: money,
  taxTotal: money,
  total: money,
  lines: z.array(LineSchema).min(1).max(300),
});
class ManualDto extends createZodDto(ManualSchema) {}

const UploadSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  contentType: z.string().min(3).max(100),
  /** The file, base64-encoded (10 MB at most). */
  data: z.string().min(1).max(14_000_000),
  relationshipId: z.string().uuid().nullish(),
  siteId: z.string().uuid().nullish(),
  poId: z.string().uuid().nullish(),
});
class UploadDto extends createZodDto(UploadSchema) {}

const UpdateSchema = z.object({
  relationshipId: z.string().uuid().nullish(),
  poId: z.string().uuid().nullish(),
  siteId: z.string().uuid().nullish(),
  type: docType.optional(),
  number: z.string().trim().min(1).max(60).nullish(),
  issueDate: date.nullish(),
  dueDate: date.nullish(),
  subtotal: money,
  taxTotal: money,
  total: money,
  lines: z.array(LineSchema).max(300).optional(),
  /** The person checked the warnings (unknown sender, buyer VAT, unreadable). */
  acknowledge: z.boolean().optional(),
});
class UpdateDto extends createZodDto(UpdateSchema) {}

const ListSchema = z.object({
  status: z.enum(['review', 'open', 'to_pay', 'all', 'needs_review', 'matched', 'mismatch', 'approved', 'disputed', 'paid', 'rejected']).default('open'),
  siteId: z.string().uuid().optional(),
  relationshipId: z.string().uuid().optional(),
  poId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
class ListDto extends createZodDto(ListSchema) {}

const ApproveSchema = z.object({ reason: z.string().max(500).nullish() });
class ApproveDto extends createZodDto(ApproveSchema) {}
const DisputeSchema = z.object({ message: z.string().max(4000).nullish(), messageAr: z.string().max(4000).nullish(), send: z.boolean().default(false) });
class DisputeDto extends createZodDto(DisputeSchema) {}
const RejectSchema = z.object({ reason: z.string().trim().min(2).max(500) });
class RejectDto extends createZodDto(RejectSchema) {}
const PaidSchema = z.object({ paidOn: date.nullish(), reference: z.string().max(120).nullish() });
class PaidDto extends createZodDto(PaidSchema) {}

/** Provider-neutral inbound email (Postmark, SendGrid and Mailgun all map to this in a few lines). */
const EmailSchema = z.object({
  messageId: z.string().min(1).max(300),
  from: z.string().min(3).max(320),
  to: z.union([z.string(), z.array(z.string())]),
  subject: z.string().max(1000).nullish(),
  attachments: z
    .array(z.object({ filename: z.string().max(200).default('attachment'), contentType: z.string().max(100), content: z.string().max(14_000_000) }))
    .max(10)
    .default([]),
});
type EmailInput = z.infer<typeof EmailSchema>;
class EmailDto extends createZodDto(EmailSchema) {}

/** Small images in emails are logos and signatures, not invoices. */
const MIN_IMAGE_BYTES = 20 * 1024;

@Injectable()
export class InvoiceEmailService {
  constructor(
    private readonly db: DbService,
    private readonly invoices: InvoicesService,
    private readonly extractor: InvoiceExtractor,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  verifySignature(raw: Buffer | undefined, signature: string | undefined) {
    const secret = this.config.INBOUND_EMAIL_SECRET;
    if (!secret) throw new ServiceUnavailableException('Email intake is not configured');
    const expected = `sha256=${createHmac('sha256', secret).update(raw ?? Buffer.alloc(0)).digest('hex')}`;
    const given = Buffer.from(signature ?? '');
    if (given.length !== expected.length || !timingSafeEqual(given, Buffer.from(expected))) throw new UnauthorizedException('Bad signature');
  }

  /** Route by the token in the address; read each invoice attachment; never twice for the same message. */
  async receive(mail: EmailInput) {
    const to = (Array.isArray(mail.to) ? mail.to : mail.to.split(',')).map((s) => s.trim().toLowerCase());
    const token = to.map((t) => t.match(/invoices\+([a-z0-9]+)@/)?.[1]).find(Boolean);
    const inbox = token ? (await this.db.system((tx) => tx.select().from(invoiceInboxes).where(eq(invoiceInboxes.token, token))))[0] : undefined;
    const log = await this.db.system(async (tx) =>
      tx
        .insert(inboundEmails)
        .values({ orgId: inbox?.orgId ?? null, messageId: mail.messageId, fromAddress: mail.from.slice(0, 320), toAddress: to.join(', ').slice(0, 500), subject: mail.subject?.slice(0, 300) ?? null, attachments: mail.attachments.length, outcome: inbox ? 'received' : 'unknown_address' })
        .onConflictDoNothing()
        .returning({ id: inboundEmails.id }),
    );
    if (!log.length) return { outcome: 'duplicate', invoices: [] as string[] };
    if (!inbox) return { outcome: 'unknown_address', invoices: [] as string[] };

    const files = mail.attachments
      .map((f) => ({ ...f, contentType: f.contentType.toLowerCase().split(';')[0]!.trim(), data: Buffer.from(f.content, 'base64') }))
      .map((f) => (f.contentType === 'application/octet-stream' && /\.xml$/i.test(f.filename) ? { ...f, contentType: 'application/xml' } : f))
      .filter((f) => (ACCEPTED_TYPES as readonly string[]).includes(f.contentType) && f.data.length > 0 && f.data.length <= 10 * 1024 * 1024)
      .filter((f) => !(IMAGE_TYPES as readonly string[]).includes(f.contentType) || f.data.length >= MIN_IMAGE_BYTES);
    // A ZATCA email often carries the same invoice as PDF and XML: the XML is exact, so prefer it.
    const xml = files.filter((f) => f.contentType.endsWith('/xml'));
    const chosen = xml.length ? xml : files;

    const actor = { orgId: inbox.orgId, userId: null, actorType: 'integration' as const, requestId: `email:${mail.messageId.slice(0, 80)}` };
    const ids: string[] = [];
    for (const f of chosen) {
      const read = await this.extractor.extract({ contentType: f.contentType, data: f.data });
      const id = await this.db.tenant({ orgId: inbox.orgId, userId: '00000000-0000-0000-0000-000000000000' }, async (tx) => {
        const sha256 = createHash('sha256').update(f.data).digest('hex');
        const [doc] = await tx
          .insert(invoiceDocuments)
          .values({ orgId: inbox.orgId, filename: f.filename, contentType: f.contentType, size: f.data.length, sha256, data: f.data.toString('base64') })
          .returning({ id: invoiceDocuments.id });
        const inv = await this.invoices.intakeInTx(tx, actor, { ...this.invoices.fromExtraction(read), source: 'email', documentId: doc!.id, emailFrom: mail.from, emailSubject: mail.subject ?? null });
        return inv.id;
      });
      ids.push(id);
    }
    await this.db.system((tx) => tx.update(inboundEmails).set({ invoices: ids.length, outcome: ids.length ? 'invoices_created' : 'no_invoice_attachments' }).where(eq(inboundEmails.id, log[0]!.id)));
    return { outcome: ids.length ? 'invoices_created' : 'no_invoice_attachments', invoices: ids };
  }
}

@ApiTags('invoices')
@Controller('webhooks/invoice-email')
class InvoiceEmailWebhookController {
  constructor(private readonly svc: InvoiceEmailService) {}

  @Public() @Post() @HttpCode(200)
  receive(@Req() req: RawBodyRequest<Request>, @Body() dto: EmailDto, @Headers('x-kitchain-signature') signature?: string, @Headers('x-backhouse-signature') legacySignature?: string) {
    // X-Backhouse-Signature is the header's name before the rename; still accepted so existing mail adapters keep working.
    this.svc.verifySignature(req.rawBody, signature ?? legacySignature);
    return this.svc.receive(dto);
  }
}

@ApiTags('invoices')
@ApiBearerAuth()
@Controller('supplier-invoices')
class InvoicesController {
  constructor(private readonly svc: InvoicesService) {}

  @Get() @Requires('invoice:read')
  list(@Access() a: AccessContext, @Query() q: ListDto) { return this.svc.list(a, q); }

  @Get('counts') @Requires('invoice:read')
  counts(@Access() a: AccessContext) { return this.svc.counts(a); }

  @Get('inbox') @Requires('invoice:manage')
  inbox(@Access() a: AccessContext) { return this.svc.inbox(a); }

  @Post() @Requires('invoice:manage')
  create(@Access() a: AccessContext, @Body() dto: ManualDto) { return this.svc.createManual(a, dto); }

  @Post('upload') @Requires('invoice:manage')
  upload(@Access() a: AccessContext, @Body() dto: UploadDto) { return this.svc.upload(a, dto); }

  @Get(':id') @Requires('invoice:read')
  get(@Access() a: AccessContext, @Param('id', uuid) id: string) { return this.svc.detail(a, id); }

  @Get(':id/document') @Requires('invoice:read')
  async document(@Access() a: AccessContext, @Param('id', uuid) id: string) {
    const doc = await this.svc.document(a, id);
    return new StreamableFile(doc.data, { type: doc.contentType, disposition: `inline; filename*=UTF-8''${encodeURIComponent(doc.filename)}`, length: doc.data.length });
  }

  @Patch(':id') @Requires('invoice:manage')
  update(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: UpdateDto) { return this.svc.update(a, id, dto); }

  @Post(':id/match') @Requires('invoice:manage') @HttpCode(200)
  match(@Access() a: AccessContext, @Param('id', uuid) id: string) { return this.svc.rematch(a, id); }

  @Post(':id/approve') @Requires('invoice:approve') @HttpCode(200)
  approve(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: ApproveDto) { return this.svc.approve(a, id, dto.reason ?? null); }

  @Post(':id/dispute') @Requires('invoice:approve') @HttpCode(200)
  dispute(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: DisputeDto) { return this.svc.dispute(a, id, dto); }

  @Post(':id/reject') @Requires('invoice:approve') @HttpCode(200)
  reject(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: RejectDto) { return this.svc.reject(a, id, dto.reason); }

  @Post(':id/paid') @Requires('invoice:approve') @HttpCode(200)
  paid(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: PaidDto) { return this.svc.markPaid(a, id, dto); }
}

@Module({
  imports: [SupplierMessagingModule],
  controllers: [InvoicesController, InvoiceEmailWebhookController],
  providers: [InvoicesService, InvoiceExtractor, InvoiceEmailService],
  exports: [InvoicesService],
})
export class InvoicesModule {}
