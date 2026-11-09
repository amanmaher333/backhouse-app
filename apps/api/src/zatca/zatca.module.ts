import { Body, Controller, Delete, Get, HttpCode, Module, Param, ParseUUIDPipe, Post, Query, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Access, Requires } from '../common/auth.js';
import type { AccessContext } from '../common/access.js';
import { ZatcaService } from './zatca.service.js';

const uuid = new ParseUUIDPipe({ version: '4' });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const UnitSchema = z.object({
  legalEntityId: z.string().uuid(),
  name: z.string().trim().min(2).max(60),
  environment: z.enum(['sandbox', 'simulation', 'production']),
  invoiceTypes: z.enum(['1100', '1000', '0100']).default('1100'),
});
class UnitDto extends createZodDto(UnitSchema) {}
const OtpSchema = z.object({ otp: z.string().regex(/^\d{6}$/, 'The OTP is 6 digits') });
class OtpDto extends createZodDto(OtpSchema) {}

const Address = z.object({
  street: z.string().trim().min(1).max(120),
  building: z.string().trim().regex(/^\d{4}$/, 'Building number is 4 digits'),
  district: z.string().trim().min(1).max(120),
  city: z.string().trim().min(1).max(80),
  postalCode: z.string().trim().regex(/^\d{5}$/, 'Postal code is 5 digits'),
  additionalNumber: z.string().trim().max(10).nullish(),
  country: z.string().length(2).nullish(),
});
const SaleSchema = z.object({
  legalEntityId: z.string().uuid(),
  siteId: z.string().uuid().nullish(),
  kind: z.enum(['standard', 'simplified']),
  type: z.enum(['invoice', 'credit_note', 'debit_note']).default('invoice'),
  buyer: z
    .object({
      name: z.string().trim().min(1).max(200),
      vatNumber: z.string().trim().nullish(),
      idScheme: z.enum(['CRN', 'MOM', 'MLS', '700', 'SAG', 'NAT', 'GCC', 'IQA', 'PAS', 'OTH']).nullish(),
      idValue: z.string().trim().max(40).nullish(),
      address: Address.nullish(),
    })
    .nullish(),
  lines: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(300),
        qty: z.coerce.number().positive().max(1_000_000),
        unitPrice: z.coerce.number().min(0).max(100_000_000),
        discount: z.coerce.number().min(0).max(100_000_000).nullish(),
        vatCategory: z.enum(['S', 'Z', 'E', 'O']).default('S'),
        vatRate: z.coerce.number().min(0).max(100).default(15),
        exemptionCode: z.string().max(30).nullish(),
        exemptionReason: z.string().max(300).nullish(),
      }),
    )
    .min(1)
    .max(500),
  supplyDate: date.nullish(),
  paymentMeansCode: z.enum(['1', '10', '30', '42', '48']).default('10'),
  note: z.string().max(1000).nullish(),
  reason: z.string().max(1000).nullish(),
  originalInvoiceId: z.string().uuid().nullish(),
  /** Sign and send to ZATCA now (otherwise saved as a draft). */
  issue: z.boolean().default(false),
});
class SaleDto extends createZodDto(SaleSchema) {}
const ListSchema = z.object({
  status: z.enum(['all', 'pending', 'draft', 'issued', 'cleared', 'reported', 'rejected']).default('all'),
  legalEntityId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
class ListDto extends createZodDto(ListSchema) {}

@ApiTags('e-invoicing')
@ApiBearerAuth()
@Controller()
class ZatcaController {
  constructor(private readonly svc: ZatcaService) {}

  @Get('zatca/units') @Requires('sales_invoice:read')
  units(@Access() a: AccessContext) { return this.svc.listUnits(a); }

  @Post('zatca/units') @Requires('einvoice:manage')
  createUnit(@Access() a: AccessContext, @Body() dto: UnitDto) { return this.svc.createUnit(a, dto); }

  @Post('zatca/units/:id/onboard') @Requires('einvoice:manage') @HttpCode(200)
  onboard(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: OtpDto) { return this.svc.onboard(a, id, dto.otp); }

  @Post('zatca/units/:id/revoke') @Requires('einvoice:manage') @HttpCode(200)
  revoke(@Access() a: AccessContext, @Param('id', uuid) id: string) { return this.svc.revokeUnit(a, id); }

  @Get('sales-invoices') @Requires('sales_invoice:read')
  list(@Access() a: AccessContext, @Query() q: ListDto) { return this.svc.list(a, q); }

  @Post('sales-invoices') @Requires('sales_invoice:manage')
  create(@Access() a: AccessContext, @Body() dto: SaleDto) {
    const { issue, ...input } = dto;
    return this.svc.create(a, input, issue);
  }

  @Get('sales-invoices/:id') @Requires('sales_invoice:read')
  get(@Access() a: AccessContext, @Param('id', uuid) id: string) { return this.svc.detail(a, id); }

  @Get('sales-invoices/:id/xml') @Requires('sales_invoice:read')
  async xml(@Access() a: AccessContext, @Param('id', uuid) id: string) {
    const x = await this.svc.xml(a, id);
    return new StreamableFile(Buffer.from(x.xml), { type: 'application/xml', disposition: `attachment; filename="${x.filename}"` });
  }

  @Post('sales-invoices/:id/issue') @Requires('sales_invoice:manage') @HttpCode(200)
  issue(@Access() a: AccessContext, @Param('id', uuid) id: string) { return this.svc.issue(a, id); }

  @Post('sales-invoices/:id/submit') @Requires('sales_invoice:manage') @HttpCode(200)
  resubmit(@Access() a: AccessContext, @Param('id', uuid) id: string) { return this.svc.resubmit(a, id); }

  @Delete('sales-invoices/:id') @Requires('sales_invoice:manage') @HttpCode(204)
  remove(@Access() a: AccessContext, @Param('id', uuid) id: string) { return this.svc.deleteDraft(a, id); }
}

@Module({ controllers: [ZatcaController], providers: [ZatcaService], exports: [ZatcaService] })
export class ZatcaModule {}
