import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { legalEntities, orgCounters, salesInvoiceLines, salesInvoices, sites, zatcaUnits, type Address as LeAddress, type Tx } from '@boh/db';
import { Decimal, country, isValidKsaVatNumber } from '@boh/domain';
import { DbService } from '../common/db.service.js';
import type { AccessContext } from '../common/access.js';
import { audit, auditRaw } from '../common/audit.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { buildCsr, certFromToken, generateKeys, readCert, type ZatcaEnvironment } from './crypto.js';
import { FatooraRejected, FatooraUnavailable, HttpFatoora, SimulatedFatoora, type Credentials, type Fatoora, type SubmitResponse } from './fatoora.js';
import { FIRST_PIH, computeTotals, signInvoice, type Address, type DocType, type InvoiceInput, type Kind, type Line, type Party, type VatCategory } from './ubl.js';

type Unit = typeof zatcaUnits.$inferSelect;
type Sale = typeof salesInvoices.$inferSelect;
type LegalEntity = typeof legalEntities.$inferSelect;

const NIL = '00000000-0000-0000-0000-000000000000';
/** Seconds to wait before retrying a submission ZATCA couldn't take: 1 min, 5 min, 15 min, then hourly. */
const BACKOFF = [60, 300, 900, 3600];
/** Simplified invoices must be reported within 24 hours. */
const REPORTING_DEADLINE_MS = 24 * 3600 * 1000;

export interface BuyerInput {
  name: string;
  vatNumber?: string | null;
  idScheme?: string | null;
  idValue?: string | null;
  address?: { street: string; building: string; district: string; city: string; postalCode: string; additionalNumber?: string | null; country?: string | null } | null;
}
export interface SaleLineInput {
  name: string;
  qty: number;
  unitPrice: number;
  discount?: number | null;
  vatCategory?: VatCategory;
  vatRate?: number;
  exemptionCode?: string | null;
  exemptionReason?: string | null;
}
export interface SaleInput {
  legalEntityId: string;
  siteId?: string | null;
  kind: Kind;
  type: DocType;
  buyer?: BuyerInput | null;
  lines: SaleLineInput[];
  supplyDate?: string | null;
  paymentMeansCode?: string;
  note?: string | null;
  reason?: string | null;
  originalInvoiceId?: string | null;
}

/** Riyadh local date and time (UTC+3, no daylight saving). */
function riyadhNow(now = new Date()) {
  const t = new Date(now.getTime() + 3 * 3600 * 1000).toISOString();
  return { date: t.slice(0, 10), time: t.slice(11, 19) };
}

@Injectable()
export class ZatcaService {
  private readonly logger = new Logger('Zatca');
  readonly fatoora: Fatoora;
  private readonly key: Buffer;

  constructor(
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.fatoora = config.ZATCA_MODE === 'live' ? new HttpFatoora() : new SimulatedFatoora();
    if (!config.ZATCA_SECRET_KEY && config.NODE_ENV === 'production') this.logger.warn('ZATCA_SECRET_KEY is not set: e-invoicing onboarding is disabled');
    // Dev and test fall back to a key derived from the JWT secret.
    this.key = createHash('sha256').update(config.ZATCA_SECRET_KEY ?? `zatca:${config.JWT_ACCESS_SECRET}`).digest();
  }

  get mode() {
    return this.fatoora.mode;
  }

  // ---------- secrets at rest ----------

  private seal(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
  }
  private open(sealed: string): string {
    const [, iv, tag, ct] = sealed.split(':');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv!, 'base64'));
    d.setAuthTag(Buffer.from(tag!, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct!, 'base64')), d.final()]).toString('utf8');
  }
  private creds(u: Unit, production: boolean): Credentials {
    const token = production ? u.productionToken : u.complianceToken;
    const secret = production ? u.productionSecretEnc : u.complianceSecretEnc;
    if (!token || !secret) throw new BadRequestException('This EGS unit has no ZATCA certificate yet');
    return { binarySecurityToken: token, secret: this.open(secret) };
  }

  // ---------- seller details ----------

  /** The legal entity as seller, with what's missing for ZATCA. */
  seller(le: LegalEntity): { party: Party; missing: string[] } {
    const a = (le.address ?? {}) as LeAddress;
    const missing: string[] = [];
    if (!le.vatNumber || !isValidKsaVatNumber(le.vatNumber)) missing.push('VAT number');
    if (!le.crNumber) missing.push('CR number');
    if (!a.street) missing.push('street');
    if (!a.buildingNumber || !/^\d{4}$/.test(a.buildingNumber)) missing.push('building number (4 digits)');
    if (!a.district) missing.push('district');
    if (!a.city) missing.push('city');
    if (!a.postalCode || !/^\d{5}$/.test(a.postalCode)) missing.push('postal code (5 digits)');
    return {
      party: {
        // ZATCA expects the seller's name in Arabic on the invoice.
        name: le.nameAr ?? le.registryName ?? le.name,
        vatNumber: le.vatNumber,
        id: le.crNumber ? { scheme: 'CRN', value: le.crNumber } : null,
        address: { street: a.street ?? '', building: a.buildingNumber ?? '', district: a.district ?? '', city: a.city ?? '', postalCode: a.postalCode ?? '', additionalNumber: a.additionalNumber ?? null, country: a.country ?? 'SA' },
      },
      missing,
    };
  }

  /** ZATCA applies to companies registered in Saudi Arabia only. */
  private requireZatcaCountry(le: LegalEntity) {
    if (country(le.country).eInvoicing !== 'zatca') throw new BadRequestException(`ZATCA e-invoicing is for companies registered in Saudi Arabia; ${le.name} is registered in ${country(le.country).name}`);
  }

  private requireSeller(le: LegalEntity) {
    this.requireZatcaCountry(le);
    const s = this.seller(le);
    if (s.missing.length) throw new BadRequestException(`Complete the company details first: ${s.missing.join(', ')}`);
    return s.party;
  }

  // ---------- EGS units ----------

  private publicUnit(u: Unit) {
    return {
      id: u.id,
      legalEntityId: u.legalEntityId,
      name: u.name,
      environment: u.environment,
      invoiceTypes: u.invoiceTypes,
      status: u.status,
      commonName: u.commonName,
      egsSerial: u.egsSerial,
      certSerial: u.certSerial,
      certExpiresAt: u.certExpiresAt,
      icv: u.icv,
      checks: u.checks,
      lastError: u.lastError,
      activatedAt: u.activatedAt,
      createdAt: u.createdAt,
    };
  }

  listUnits(a: AccessContext) {
    return this.db.tenant(a.tenant, async (tx) => {
      const rows = await tx.select().from(zatcaUnits).orderBy(asc(zatcaUnits.createdAt));
      return { mode: this.mode, units: rows.map((u) => this.publicUnit(u)) };
    });
  }

  /** Register an EGS unit: a new signing key and the certificate request for ZATCA. */
  createUnit(a: AccessContext, dto: { legalEntityId: string; name: string; environment: ZatcaEnvironment; invoiceTypes: string }) {
    if (!this.config.ZATCA_SECRET_KEY && this.config.NODE_ENV === 'production') throw new BadRequestException('E-invoicing is not configured on this server');
    return this.db.tenant(a.tenant, async (tx) => {
      const [le] = await tx.select().from(legalEntities).where(eq(legalEntities.id, dto.legalEntityId));
      if (!le) throw new NotFoundException('legal entity not found');
      const party = this.requireSeller(le);
      const keys = generateKeys();
      const serial = `1-Kitchain|2-1.0|3-${randomUUID()}`;
      const commonName = `BOH-${le.crNumber}-${randomBytes(3).toString('hex')}`;
      const csr = buildCsr({
        privateKeyPem: keys.privateKeyPem,
        environment: dto.environment,
        commonName,
        organizationName: (le.registryName ?? le.name).slice(0, 64),
        organizationUnit: dto.name.slice(0, 64),
        egsSerial: serial,
        vatNumber: le.vatNumber!,
        invoiceTypes: dto.invoiceTypes,
        location: `${party.address!.building} ${party.address!.street}, ${party.address!.city}`.slice(0, 120),
        industry: 'Food',
      });
      const [u] = await tx
        .insert(zatcaUnits)
        .values({ orgId: a.orgId, legalEntityId: le.id, name: dto.name, environment: dto.environment, invoiceTypes: dto.invoiceTypes, commonName, egsSerial: serial, privateKeyEnc: this.seal(keys.privateKeyPem), csrPem: csr.pem, createdBy: a.userId })
        .returning();
      await audit(tx, a, { action: 'zatca_unit.created', entityType: 'zatca_unit', entityId: u!.id, after: { name: dto.name, environment: dto.environment, legalEntityId: le.id } });
      return this.publicUnit(u!);
    });
  }

  /**
   * Onboard with the OTP from the Fatoora portal: compliance certificate, ZATCA's
   * compliance checks (a sample of each document type the unit issues), then the
   * production certificate. The unit is active when all three succeed.
   */
  async onboard(a: AccessContext, unitId: string, otp: string) {
    const { unit, le } = await this.db.tenant(a.tenant, async (tx) => {
      const [u] = await tx.select().from(zatcaUnits).where(eq(zatcaUnits.id, unitId)).for('update');
      if (!u) throw new NotFoundException('EGS unit not found');
      if (!['new', 'failed'].includes(u.status)) throw new BadRequestException(`This unit is ${u.status}`);
      const [le] = await tx.select().from(legalEntities).where(eq(legalEntities.id, u.legalEntityId));
      await tx.update(zatcaUnits).set({ status: 'onboarding', lastError: null }).where(eq(zatcaUnits.id, u.id));
      return { unit: u, le: le! };
    });
    const env = unit.environment as ZatcaEnvironment;
    const fail = async (message: string, checks?: Record<string, unknown>[]) => {
      await this.db.tenant(a.tenant, async (tx) => {
        await tx.update(zatcaUnits).set({ status: 'failed', lastError: message, ...(checks ? { checks } : {}) }).where(eq(zatcaUnits.id, unit.id));
        await audit(tx, a, { action: 'zatca_unit.onboarding_failed', entityType: 'zatca_unit', entityId: unit.id, after: { message } });
      });
      throw new BadRequestException(message);
    };
    try {
      const privateKeyPem = this.open(unit.privateKeyEnc);
      const compliance = await this.fatoora.compliance(env, Buffer.from(unit.csrPem).toString('base64'), otp);
      await this.db.tenant(a.tenant, (tx) =>
        tx.update(zatcaUnits).set({ complianceToken: compliance.binarySecurityToken, complianceSecretEnc: this.seal(compliance.secret), complianceRequestId: String(compliance.requestID) }).where(eq(zatcaUnits.id, unit.id)),
      );
      const cert = readCert(certFromToken(compliance.binarySecurityToken));
      const seller = this.requireSeller(le);
      const kinds: Kind[] = [...(unit.invoiceTypes[0] === '1' ? (['standard'] as const) : []), ...(unit.invoiceTypes[1] === '1' ? (['simplified'] as const) : [])];
      const checks: Record<string, unknown>[] = [];
      let pih = FIRST_PIH;
      let icv = 1;
      for (const kind of kinds) {
        for (const type of ['invoice', 'credit_note', 'debit_note'] as DocType[]) {
          const now = riyadhNow();
          const input: InvoiceInput = {
            kind,
            type,
            number: `COMPLIANCE-${icv}`,
            uuid: randomUUID(),
            issueDate: now.date,
            issueTime: now.time,
            supplyDate: now.date,
            icv,
            pih,
            seller,
            buyer: kind === 'standard' ? { name: 'Compliance Check Buyer', vatNumber: '399999999800003', address: { street: 'King Abdulaziz Road', building: '1111', district: 'Al Malqa', city: 'Riyadh', postalCode: '13521' } } : null,
            lines: [{ name: 'Compliance check item', qty: 1, unitPrice: '100.00', vatCategory: 'S', vatRate: 15 }],
            billingReference: type === 'invoice' ? null : 'COMPLIANCE-1',
            reason: type === 'invoice' ? null : 'Compliance check',
          };
          const signed = signInvoice(input, { privateKeyPem, cert });
          const res = await this.fatoora.complianceCheck(env, compliance, { invoiceHash: signed.hash, uuid: input.uuid, invoice: Buffer.from(signed.xml).toString('base64') });
          const status = res.validationResults?.status ?? `HTTP ${res.httpStatus}`;
          checks.push({ kind, type, status, errors: res.validationResults?.errorMessages ?? [], warnings: res.validationResults?.warningMessages ?? [] });
          pih = signed.hash;
          icv++;
        }
      }
      const failed = checks.filter((c) => !['PASS', 'WARNING'].includes(String(c.status)));
      if (failed.length) return await fail(`ZATCA's compliance checks failed for ${failed.map((c) => `${c.kind} ${c.type}`).join(', ')}`, checks);
      const production = await this.fatoora.productionCsid(env, compliance, String(compliance.requestID));
      const prodCert = readCert(certFromToken(production.binarySecurityToken));
      return await this.db.tenant(a.tenant, async (tx) => {
        const [u] = await tx
          .update(zatcaUnits)
          .set({ status: 'active', productionToken: production.binarySecurityToken, productionSecretEnc: this.seal(production.secret), certSerial: prodCert.serialNumber, certExpiresAt: prodCert.notAfter, checks, activatedAt: new Date(), lastError: null })
          .where(eq(zatcaUnits.id, unit.id))
          .returning();
        await audit(tx, a, { action: 'zatca_unit.activated', entityType: 'zatca_unit', entityId: unit.id, after: { environment: env, certSerial: prodCert.serialNumber, certExpiresAt: prodCert.notAfter } });
        return this.publicUnit(u!);
      });
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      if (e instanceof FatooraRejected || e instanceof FatooraUnavailable) return fail(e.message);
      await fail('Onboarding failed unexpectedly');
      throw e;
    }
  }

  revokeUnit(a: AccessContext, unitId: string) {
    return this.db.tenant(a.tenant, async (tx) => {
      const [u] = await tx.update(zatcaUnits).set({ status: 'revoked' }).where(eq(zatcaUnits.id, unitId)).returning();
      if (!u) throw new NotFoundException('EGS unit not found');
      await audit(tx, a, { action: 'zatca_unit.revoked', entityType: 'zatca_unit', entityId: u.id });
      return this.publicUnit(u);
    });
  }

  // ---------- sales invoices ----------

  private async nextNumber(tx: Tx, orgId: string, type: DocType) {
    const key = `sales:${type}`;
    const [row] = await tx
      .insert(orgCounters)
      .values({ orgId, key, value: 1 })
      .onConflictDoUpdate({ target: [orgCounters.orgId, orgCounters.key], set: { value: sql`${orgCounters.value} + 1` } })
      .returning();
    return `${type === 'invoice' ? 'INV' : type === 'credit_note' ? 'CN' : 'DN'}-${String(row!.value).padStart(5, '0')}`;
  }

  private lines(input: SaleLineInput[]): Line[] {
    return input.map((l) => ({
      name: l.name.trim(),
      qty: new Decimal(l.qty),
      unitPrice: new Decimal(l.unitPrice),
      discount: l.discount ? new Decimal(l.discount) : null,
      vatCategory: l.vatCategory ?? 'S',
      vatRate: l.vatCategory && l.vatCategory !== 'S' ? 0 : (l.vatRate ?? 15),
      exemptionCode: l.exemptionCode ?? null,
      exemptionReason: l.exemptionReason ?? null,
    }));
  }

  private validate(dto: SaleInput) {
    if (dto.kind === 'standard') {
      const b = dto.buyer;
      if (!b?.name) throw new BadRequestException('A tax invoice (B2B) needs the buyer’s name');
      if (!b.vatNumber && !b.idValue) throw new BadRequestException('A tax invoice (B2B) needs the buyer’s VAT number or another identifier');
      if (b.vatNumber && !isValidKsaVatNumber(b.vatNumber)) throw new BadRequestException('The buyer’s VAT number must be 15 digits starting and ending with 3');
      if (!b.address?.street || !b.address.building || !b.address.city || !b.address.postalCode || !b.address.district) throw new BadRequestException('A tax invoice (B2B) needs the buyer’s address');
    }
    for (const l of dto.lines) {
      if ((l.vatCategory ?? 'S') !== 'S' && !l.exemptionCode) throw new BadRequestException('Zero-rated, exempt and out-of-scope lines need an exemption reason code (VATEX-SA-…)');
    }
    if (dto.type !== 'invoice' && !dto.reason?.trim()) throw new BadRequestException('Credit and debit notes need a reason');
  }

  private buyerParty(b: BuyerInput | null | undefined): Party | null {
    if (!b?.name) return null;
    return {
      name: b.name,
      vatNumber: b.vatNumber ?? null,
      id: !b.vatNumber && b.idValue ? { scheme: b.idScheme ?? 'OTH', value: b.idValue } : null,
      address: b.address ? { street: b.address.street, building: b.address.building, district: b.address.district, city: b.address.city, postalCode: b.address.postalCode, additionalNumber: b.address.additionalNumber ?? null, country: b.address.country ?? 'SA' } : null,
    };
  }

  /** Create a draft (and optionally issue it straight away). */
  async create(a: AccessContext, dto: SaleInput, issue = false) {
    this.validate(dto);
    if (dto.siteId && !a.can('sales_invoice:manage', dto.siteId)) throw new ForbiddenException('You cannot issue invoices for this site');
    const id = await this.db.tenant(a.tenant, async (tx) => {
      const [le] = await tx.select().from(legalEntities).where(eq(legalEntities.id, dto.legalEntityId));
      if (!le) throw new NotFoundException('legal entity not found');
      this.requireZatcaCountry(le);
      let original: Sale | undefined;
      if (dto.type !== 'invoice') {
        if (!dto.originalInvoiceId) throw new BadRequestException('Choose the invoice this note corrects');
        [original] = await tx.select().from(salesInvoices).where(eq(salesInvoices.id, dto.originalInvoiceId));
        if (!original || original.type !== 'invoice' || !['cleared', 'reported'].includes(original.status)) throw new BadRequestException('A note must correct an invoice ZATCA has cleared or received');
        if (original.legalEntityId !== le.id) throw new BadRequestException('The note must come from the company that issued the invoice');
        if (original.kind !== dto.kind) throw new BadRequestException('A note must be of the same kind as the invoice (tax or simplified)');
      }
      const lines = this.lines(dto.lines);
      const t = computeTotals(lines);
      const [row] = await tx
        .insert(salesInvoices)
        .values({
          orgId: a.orgId,
          legalEntityId: le.id,
          siteId: dto.siteId ?? null,
          number: await this.nextNumber(tx, a.orgId, dto.type),
          type: dto.type,
          kind: dto.kind,
          supplyDate: dto.supplyDate ?? null,
          buyer: (dto.buyer ?? null) as Record<string, unknown> | null,
          paymentMeansCode: dto.paymentMeansCode ?? '10',
          note: dto.note ?? null,
          reason: dto.reason ?? null,
          originalInvoiceId: original?.id ?? null,
          billingReference: original?.number ?? null,
          subtotal: t.taxExclusive,
          taxTotal: t.tax,
          total: t.taxInclusive,
          createdBy: a.userId,
        })
        .returning();
      await tx.insert(salesInvoiceLines).values(
        lines.map((l, i) => ({
          orgId: a.orgId,
          invoiceId: row!.id,
          lineNo: i + 1,
          name: l.name,
          qty: new Decimal(l.qty).toFixed(3),
          unitPrice: new Decimal(l.unitPrice).toFixed(4),
          discount: new Decimal(l.discount ?? 0).toFixed(2),
          vatCategory: l.vatCategory,
          vatRate: new Decimal(l.vatRate).toFixed(2),
          exemptionCode: l.exemptionCode ?? null,
          exemptionReason: l.exemptionReason ?? null,
          net: t.lines[i]!.net,
          vat: t.lines[i]!.vat,
        })),
      );
      await audit(tx, a, { action: 'sales_invoice.created', entityType: 'sales_invoice', entityId: row!.id, after: { number: row!.number, kind: row!.kind, type: row!.type, total: row!.total } });
      return row!.id;
    });
    return issue ? this.issue(a, id) : this.detail(a, id);
  }

  deleteDraft(a: AccessContext, id: string) {
    return this.db.tenant(a.tenant, async (tx) => {
      const [inv] = await tx.select().from(salesInvoices).where(eq(salesInvoices.id, id));
      if (!inv) throw new NotFoundException('invoice not found');
      if (inv.status !== 'draft') throw new BadRequestException('Only drafts can be deleted; correct an issued invoice with a credit note');
      await tx.delete(salesInvoices).where(eq(salesInvoices.id, id));
      await audit(tx, a, { action: 'sales_invoice.deleted', entityType: 'sales_invoice', entityId: id, before: { number: inv.number } });
    });
  }

  /**
   * Sign the document into the unit's chain (next ICV, previous hash), then send it
   * to ZATCA: clearance for tax invoices, reporting for simplified ones. If ZATCA
   * can't be reached, the signed invoice waits and the worker retries.
   */
  async issue(a: AccessContext, id: string) {
    await this.db.tenant(a.tenant, async (tx) => {
      const [inv] = await tx.select().from(salesInvoices).where(eq(salesInvoices.id, id)).for('update');
      if (!inv) throw new NotFoundException('invoice not found');
      if (inv.status !== 'draft') throw new BadRequestException(`Invoice is already ${inv.status}`);
      if (inv.siteId && !a.can('sales_invoice:manage', inv.siteId)) throw new ForbiddenException('You cannot issue invoices for this site');
      const [le] = await tx.select().from(legalEntities).where(eq(legalEntities.id, inv.legalEntityId));
      const seller = this.requireSeller(le!);
      const flag = inv.kind === 'standard' ? 0 : 1;
      // One signer at a time per unit keeps the chain strictly sequential.
      const units = await tx.select().from(zatcaUnits).where(and(eq(zatcaUnits.legalEntityId, inv.legalEntityId), eq(zatcaUnits.status, 'active'))).orderBy(asc(zatcaUnits.createdAt)).for('update');
      const unit = units.find((u) => u.invoiceTypes[flag] === '1');
      if (!unit) throw new ConflictException(`No EGS unit is registered with ZATCA for ${inv.kind === 'standard' ? 'tax' : 'simplified'} invoices for this company. Set one up under E-invoicing.`);
      const lines = await tx.select().from(salesInvoiceLines).where(eq(salesInvoiceLines.invoiceId, inv.id)).orderBy(asc(salesInvoiceLines.lineNo));
      const now = riyadhNow();
      const icv = unit.icv + 1;
      const pih = unit.lastHash ?? FIRST_PIH;
      const signed = signInvoice(
        {
          kind: inv.kind as Kind,
          type: inv.type as DocType,
          number: inv.number,
          uuid: inv.uuid,
          issueDate: now.date,
          issueTime: now.time,
          supplyDate: inv.supplyDate ?? (inv.kind === 'standard' ? now.date : null),
          currency: inv.currency,
          icv,
          pih,
          seller,
          buyer: this.buyerParty(inv.buyer as BuyerInput | null),
          lines: lines.map((l) => ({ name: l.name, qty: l.qty, unitPrice: l.unitPrice, discount: l.discount, vatCategory: l.vatCategory as VatCategory, vatRate: l.vatRate, exemptionCode: l.exemptionCode, exemptionReason: l.exemptionReason })),
          paymentMeansCode: inv.paymentMeansCode,
          billingReference: inv.billingReference,
          reason: inv.reason,
          note: inv.note,
        },
        { privateKeyPem: this.open(unit.privateKeyEnc), cert: readCert(certFromToken(unit.productionToken!)) },
      );
      await tx.update(zatcaUnits).set({ icv, lastHash: signed.hash }).where(eq(zatcaUnits.id, unit.id));
      await tx
        .update(salesInvoices)
        .set({ status: 'issued', unitId: unit.id, issueDate: now.date, issueTime: now.time, icv, pih, hash: signed.hash, qr: signed.qr, signedXml: signed.xml, subtotal: signed.totals.taxExclusive, taxTotal: signed.totals.tax, total: signed.totals.taxInclusive, issuedBy: a.userId, issuedAt: new Date(), nextSubmitAt: new Date() })
        .where(eq(salesInvoices.id, inv.id));
      await audit(tx, a, { action: 'sales_invoice.signed', entityType: 'sales_invoice', entityId: inv.id, after: { number: inv.number, unitId: unit.id, icv, hash: signed.hash } });
    });
    await this.submit(a.orgId, id);
    return this.detail(a, id);
  }

  /** Send one signed invoice to ZATCA and record the outcome. Never throws for ZATCA problems. */
  async submit(orgId: string, id: string): Promise<string> {
    const ctx = { orgId, userId: NIL };
    const prep = await this.db.tenant(ctx, async (tx) => {
      const [inv] = await tx.select().from(salesInvoices).where(eq(salesInvoices.id, id)).for('update');
      if (!inv || inv.status !== 'issued') return null;
      const [unit] = await tx.select().from(zatcaUnits).where(eq(zatcaUnits.id, inv.unitId!));
      return { inv, unit: unit! };
    });
    if (!prep) return 'skipped';
    const { inv, unit } = prep;
    const body = { invoiceHash: inv.hash!, uuid: inv.uuid, invoice: Buffer.from(inv.signedXml!).toString('base64') };
    const env = unit.environment as ZatcaEnvironment;
    let res: SubmitResponse | null = null;
    let problem: string | null = null;
    let retry = false;
    try {
      const creds = this.creds(unit, true);
      res = inv.kind === 'standard' ? await this.fatoora.clearance(env, creds, body) : await this.fatoora.reporting(env, creds, body);
    } catch (e) {
      problem = (e as Error).message;
      retry = e instanceof FatooraUnavailable || (e instanceof FatooraRejected && e.httpStatus === 401);
      if (!(e instanceof FatooraUnavailable || e instanceof FatooraRejected)) retry = true;
    }
    return this.db.tenant(ctx, async (tx) => {
      const attempts = inv.submitAttempts + 1;
      const actor = { orgId, userId: null, requestId: `zatca:${inv.number}` };
      if (!res) {
        const wait = BACKOFF[Math.min(attempts - 1, BACKOFF.length - 1)]!;
        await tx
          .update(salesInvoices)
          .set({ submitAttempts: attempts, lastError: problem, nextSubmitAt: retry ? new Date(Date.now() + wait * 1000) : null })
          .where(eq(salesInvoices.id, inv.id));
        await auditRaw(tx, { ...actor, action: 'sales_invoice.submit_failed', entityType: 'sales_invoice', entityId: inv.id, after: { problem, attempts } });
        return 'waiting';
      }
      const v = res.validationResults;
      const accepted = res.clearanceStatus === 'CLEARED' || res.reportingStatus === 'REPORTED';
      const status = accepted ? (inv.kind === 'standard' ? 'cleared' : 'reported') : 'rejected';
      await tx
        .update(salesInvoices)
        .set({
          status,
          zatcaStatus: res.clearanceStatus ?? res.reportingStatus ?? `HTTP ${res.httpStatus}`,
          validation: (v ?? null) as Record<string, unknown> | null,
          clearedXml: res.clearedInvoice ? Buffer.from(res.clearedInvoice, 'base64').toString('utf8') : null,
          submitAttempts: attempts,
          submittedAt: new Date(),
          nextSubmitAt: null,
          lastError: accepted ? null : (v?.errorMessages ?? []).map((m) => `${m.code}: ${m.message}`).join('; ') || `HTTP ${res.httpStatus}`,
        })
        .where(eq(salesInvoices.id, inv.id));
      await auditRaw(tx, { ...actor, action: `sales_invoice.${status}`, entityType: 'sales_invoice', entityId: inv.id, after: { zatcaStatus: res.clearanceStatus ?? res.reportingStatus, warnings: v?.warningMessages?.length ?? 0, errors: v?.errorMessages?.length ?? 0 } });
      return status;
    });
  }

  /** Worker: retry submissions that are due, across organisations. */
  async submitDue(limit = 50) {
    const due = await this.db.system((tx) =>
      tx
        .select({ id: salesInvoices.id, orgId: salesInvoices.orgId })
        .from(salesInvoices)
        .where(and(eq(salesInvoices.status, 'issued'), lte(salesInvoices.nextSubmitAt, new Date())))
        .orderBy(asc(salesInvoices.nextSubmitAt))
        .limit(limit),
    );
    const out: Record<string, number> = {};
    for (const d of due) {
      const r = await this.submit(d.orgId, d.id);
      out[r] = (out[r] ?? 0) + 1;
    }
    return out;
  }

  /** Retry now (a person asked). */
  async resubmit(a: AccessContext, id: string) {
    await this.db.tenant(a.tenant, async (tx) => {
      const [inv] = await tx.select().from(salesInvoices).where(eq(salesInvoices.id, id));
      if (!inv) throw new NotFoundException('invoice not found');
      if (inv.status !== 'issued') throw new BadRequestException(`Invoice is ${inv.status}`);
    });
    await this.submit(a.orgId, id);
    return this.detail(a, id);
  }

  list(a: AccessContext, q: { status?: string; legalEntityId?: string; limit: number }) {
    return this.db.tenant(a.tenant, (tx) =>
      tx
        .select({
          id: salesInvoices.id,
          number: salesInvoices.number,
          type: salesInvoices.type,
          kind: salesInvoices.kind,
          status: salesInvoices.status,
          issueDate: salesInvoices.issueDate,
          buyer: salesInvoices.buyer,
          total: salesInvoices.total,
          zatcaStatus: salesInvoices.zatcaStatus,
          lastError: salesInvoices.lastError,
          legalEntityId: salesInvoices.legalEntityId,
          legalEntityName: legalEntities.name,
          legalEntityNameAr: legalEntities.nameAr,
          createdAt: salesInvoices.createdAt,
          issuedAt: salesInvoices.issuedAt,
        })
        .from(salesInvoices)
        .innerJoin(legalEntities, eq(legalEntities.id, salesInvoices.legalEntityId))
        .where(
          and(
            q.status === 'pending' ? inArray(salesInvoices.status, ['draft', 'issued', 'rejected']) : q.status && q.status !== 'all' ? eq(salesInvoices.status, q.status) : undefined,
            q.legalEntityId ? eq(salesInvoices.legalEntityId, q.legalEntityId) : undefined,
          ),
        )
        .orderBy(desc(salesInvoices.createdAt))
        .limit(q.limit),
    );
  }

  async detail(a: AccessContext, id: string) {
    return this.db.tenant(a.tenant, async (tx) => {
      const [inv] = await tx.select().from(salesInvoices).where(eq(salesInvoices.id, id));
      if (!inv) throw new NotFoundException('invoice not found');
      if (inv.siteId && !a.can('sales_invoice:read', inv.siteId)) throw new NotFoundException('invoice not found');
      const lines = await tx.select().from(salesInvoiceLines).where(eq(salesInvoiceLines.invoiceId, inv.id)).orderBy(asc(salesInvoiceLines.lineNo));
      const [le] = await tx.select().from(legalEntities).where(eq(legalEntities.id, inv.legalEntityId));
      const [site] = inv.siteId ? await tx.select({ id: sites.id, name: sites.name, nameAr: sites.nameAr }).from(sites).where(eq(sites.id, inv.siteId)) : [];
      const [unit] = inv.unitId ? await tx.select().from(zatcaUnits).where(eq(zatcaUnits.id, inv.unitId)) : [];
      const notes = await tx.select({ id: salesInvoices.id, number: salesInvoices.number, type: salesInvoices.type, status: salesInvoices.status, total: salesInvoices.total }).from(salesInvoices).where(eq(salesInvoices.originalInvoiceId, inv.id));
      const { signedXml, clearedXml, ...rest } = inv;
      const overdue = inv.kind === 'simplified' && inv.status === 'issued' && inv.issuedAt && Date.now() - inv.issuedAt.getTime() > REPORTING_DEADLINE_MS;
      // For cleared tax invoices, ZATCA's cleared version carries the QR code to print.
      const clearedQr = clearedXml?.match(/<cbc:ID>QR<\/cbc:ID>\s*<cac:Attachment>\s*<cbc:EmbeddedDocumentBinaryObject[^>]*>([^<]+)</)?.[1];
      return {
        ...rest,
        qr: clearedQr ?? rest.qr,
        hasXml: Boolean(signedXml),
        hasClearedXml: Boolean(clearedXml),
        reportingOverdue: Boolean(overdue),
        lines,
        seller: le ? { ...this.seller(le).party, legalEntityId: le.id, nameEn: le.name } : null,
        site: site ?? null,
        unit: unit ? { id: unit.id, name: unit.name, environment: unit.environment } : null,
        notes,
      };
    });
  }

  /** The document to share: ZATCA's cleared version for tax invoices, else the signed one. */
  async xml(a: AccessContext, id: string) {
    return this.db.tenant(a.tenant, async (tx) => {
      const [inv] = await tx.select().from(salesInvoices).where(eq(salesInvoices.id, id));
      if (!inv?.signedXml) throw new NotFoundException('invoice not found');
      return { filename: `${inv.number}.xml`, xml: inv.clearedXml ?? inv.signedXml };
    });
  }
}
