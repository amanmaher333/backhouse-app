import { Body, Controller, Delete, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, ForbiddenException, BadRequestException } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { brands, costCentres, legalEntities, organizations, sites, storageLocations } from '@boh/db';
import { VerificationService } from '../verification/verification.js';
import { DbService } from '../common/db.service.js';
import { Access, Requires } from '../common/auth.js';
import type { AccessContext } from '../common/access.js';
import { audit } from '../common/audit.js';
import { ksaCr, ksaVat } from './auth.js';

const name = z.string().min(1).max(200);
const nameAr = z.string().max(200).nullish();
const address = z
  .object({
    buildingNumber: z.string().max(10).optional(),
    street: z.string().max(200).optional(),
    district: z.string().max(200).optional(),
    city: z.string().max(100).optional(),
    postalCode: z.string().max(10).optional(),
    additionalNumber: z.string().max(10).optional(),
    country: z.string().length(2).optional(),
  })
  .strict();

/* ---------------- Organization ---------------- */

const UpdateOrgSchema = z.object({ name, nameAr, defaultLocale: z.enum(['ar', 'en']) }).partial();
class UpdateOrgDto extends createZodDto(UpdateOrgSchema) {}

/* ---------------- Legal entities ---------------- */

const LegalEntitySchema = z
  .object({
    name,
    nameAr,
    country: z.string().length(2).default('SA'),
    currency: z.string().length(3).default('SAR'),
    vatNumber: z.string().max(20).nullish(),
    crNumber: z.string().max(20).nullish(),
    isVatRegistered: z.boolean().default(true),
    address: address.default({}),
  })
  .superRefine((v, ctx) => {
    if (v.country === 'SA') {
      if (v.vatNumber && !ksaVat.safeParse(v.vatNumber).success)
        ctx.addIssue({ code: 'custom', path: ['vatNumber'], message: 'KSA VAT number must be 15 digits starting and ending with 3' });
      if (v.crNumber && !ksaCr.safeParse(v.crNumber).success)
        ctx.addIssue({ code: 'custom', path: ['crNumber'], message: 'KSA CR number must be 10 digits' });
    }
  });
class CreateLegalEntityDto extends createZodDto(LegalEntitySchema) {}
const UpdateLegalEntitySchema = z
  .object({ name, nameAr, vatNumber: z.string().max(20).nullish(), crNumber: z.string().max(20).nullish(), isVatRegistered: z.boolean(), address })
  .partial();
class UpdateLegalEntityDto extends createZodDto(UpdateLegalEntitySchema) {}

/* ---------------- Brands ---------------- */

const BrandSchema = z.object({ name, nameAr });
class CreateBrandDto extends createZodDto(BrandSchema) {}
class UpdateBrandDto extends createZodDto(BrandSchema.partial()) {}

/* ---------------- Sites ---------------- */

const SiteSchema = z.object({
  legalEntityId: z.string().uuid(),
  brandId: z.string().uuid().nullish(),
  type: z.enum(['restaurant', 'central_kitchen', 'warehouse']).default('restaurant'),
  name,
  nameAr,
  code: z.string().max(30).nullish(),
  timezone: z.string().max(64).default('Asia/Riyadh'),
  address: address.default({}),
});
class CreateSiteDto extends createZodDto(SiteSchema) {}
const UpdateSiteSchema = SiteSchema.omit({ legalEntityId: true }).partial().extend({ isActive: z.boolean().optional() });
class UpdateSiteDto extends createZodDto(UpdateSiteSchema) {}

/* ---------------- Locations / cost centres ---------------- */

const LocationSchema = z.object({ name, nameAr, sortOrder: z.number().int().min(0).max(10_000).default(0) });
class CreateLocationDto extends createZodDto(LocationSchema) {}
class UpdateLocationDto extends createZodDto(LocationSchema.partial()) {}

const CostCentreSchema = z.object({ name, nameAr, code: z.string().max(30).nullish(), siteId: z.string().uuid().nullish() });
class CreateCostCentreDto extends createZodDto(CostCentreSchema) {}
class UpdateCostCentreDto extends createZodDto(CostCentreSchema.omit({ siteId: true }).partial()) {}

const uuid = new ParseUUIDPipe({ version: '4' });

@Injectable()
export class OrgStructureService {
  constructor(
    private readonly db: DbService,
    private readonly verification: VerificationService,
  ) {}

  getOrg(a: AccessContext) {
    return this.db.tenant(a.tenant, async (tx) => {
      const [org] = await tx.select().from(organizations).where(eq(organizations.id, a.orgId));
      return org;
    });
  }

  updateOrg(a: AccessContext, dto: UpdateOrgDto) {
    return this.db.tenant(a.tenant, async (tx) => {
      const [before] = await tx.select().from(organizations).where(eq(organizations.id, a.orgId));
      const [after] = await tx.update(organizations).set(dto).where(eq(organizations.id, a.orgId)).returning();
      await audit(tx, a, { action: 'org.updated', entityType: 'organization', entityId: a.orgId, before, after });
      return after;
    });
  }

  /** Generic create/update/delete with audit, for simple org-scoped tables. */
  private async create<T extends { id: string }>(a: AccessContext, entityType: string, insert: (tx: any) => Promise<T[]>) {
    return this.db.tenant(a.tenant, async (tx) => {
      const [row] = await insert(tx);
      await audit(tx, a, { action: `${entityType}.created`, entityType, entityId: row!.id, after: row });
      return row!;
    });
  }

  private async update<T>(a: AccessContext, entityType: string, id: string, table: any, values: object, extra?: any) {
    return this.db.tenant(a.tenant, async (tx) => {
      const where = extra ? and(eq(table.id, id), extra) : eq(table.id, id);
      const [before] = await tx.select().from(table).where(where);
      if (!before) throw new NotFoundException(`${entityType} not found`);
      if (Object.keys(values).length === 0) return before as T;
      const [after] = await tx.update(table).set(values).where(where).returning();
      await audit(tx, a, { action: `${entityType}.updated`, entityType, entityId: id, before, after });
      return after as T;
    });
  }

  private async remove(a: AccessContext, entityType: string, id: string, table: any, extra?: any) {
    return this.db.tenant(a.tenant, async (tx) => {
      const where = extra ? and(eq(table.id, id), extra) : eq(table.id, id);
      const [before] = (await tx.delete(table).where(where).returning()) as any[];
      if (!before) throw new NotFoundException(`${entityType} not found`);
      await audit(tx, a, { action: `${entityType}.deleted`, entityType, entityId: id, before });
    });
  }

  // Legal entities
  listLegalEntities(a: AccessContext) {
    return this.db.tenant(a.tenant, (tx) => tx.select().from(legalEntities).orderBy(asc(legalEntities.name)));
  }
  async createLegalEntity(a: AccessContext, dto: CreateLegalEntityDto) {
    const row = await this.create<typeof legalEntities.$inferSelect>(a, 'legal_entity', (tx) => tx.insert(legalEntities).values({ ...dto, orgId: a.orgId }).returning());
    return this.recheck(a, row);
  }

  /** A new or changed CR or name is checked against the commercial register straight away. */
  private async recheck(a: AccessContext, row: typeof legalEntities.$inferSelect) {
    if (!row.crNumber && row.verificationStatus === 'unverified') return row;
    await this.verification.verifyLegalEntity(a.orgId, row.id, a.userId);
    const [fresh] = await this.db.tenant(a.tenant, (tx) => tx.select().from(legalEntities).where(eq(legalEntities.id, row.id)));
    return fresh!;
  }
  async updateLegalEntity(a: AccessContext, id: string, dto: UpdateLegalEntityDto) {
    const current = await this.db.tenant(a.tenant, (tx) => tx.select().from(legalEntities).where(eq(legalEntities.id, id)));
    if (current[0]?.country === 'SA') {
      if (dto.vatNumber && !ksaVat.safeParse(dto.vatNumber).success) throw new BadRequestException('Invalid KSA VAT number');
      if (dto.crNumber && !ksaCr.safeParse(dto.crNumber).success) throw new BadRequestException('Invalid KSA CR number');
    }
    const after = await this.update<typeof legalEntities.$inferSelect>(a, 'legal_entity', id, legalEntities, dto);
    const changed = (['crNumber', 'name', 'nameAr'] as const).some((k) => k in dto && (dto as Record<string, unknown>)[k] !== current[0]?.[k]);
    return changed ? this.recheck(a, after) : after;
  }

  // Brands
  listBrands(a: AccessContext) {
    return this.db.tenant(a.tenant, (tx) => tx.select().from(brands).orderBy(asc(brands.name)));
  }
  createBrand(a: AccessContext, dto: CreateBrandDto) {
    return this.create(a, 'brand', (tx) => tx.insert(brands).values({ ...dto, orgId: a.orgId }).returning());
  }
  updateBrand(a: AccessContext, id: string, dto: UpdateBrandDto) {
    return this.update(a, 'brand', id, brands, dto);
  }
  deleteBrand(a: AccessContext, id: string) {
    return this.remove(a, 'brand', id, brands);
  }

  // Sites (filtered to the sites the user can read)
  listSites(a: AccessContext) {
    const scope = a.sitesFor('site:read');
    return this.db.tenant(a.tenant, (tx) => {
      const q = tx.select().from(sites);
      return (scope === 'all' ? q : q.where(inArray(sites.id, scope.length ? scope : ['00000000-0000-0000-0000-000000000000']))).orderBy(asc(sites.name));
    });
  }
  async getSite(a: AccessContext, id: string) {
    const [site] = await this.db.tenant(a.tenant, (tx) => tx.select().from(sites).where(eq(sites.id, id)));
    if (!site) throw new NotFoundException('site not found');
    return site;
  }
  createSite(a: AccessContext, dto: CreateSiteDto) {
    return this.create(a, 'site', (tx) => tx.insert(sites).values({ ...dto, orgId: a.orgId }).returning());
  }
  updateSite(a: AccessContext, id: string, dto: UpdateSiteDto) {
    return this.update(a, 'site', id, sites, dto);
  }

  // Storage locations
  listLocations(a: AccessContext, siteId: string) {
    return this.db.tenant(a.tenant, (tx) =>
      tx.select().from(storageLocations).where(eq(storageLocations.siteId, siteId)).orderBy(asc(storageLocations.sortOrder), asc(storageLocations.name)),
    );
  }
  createLocation(a: AccessContext, siteId: string, dto: CreateLocationDto) {
    return this.create(a, 'storage_location', (tx) => tx.insert(storageLocations).values({ ...dto, siteId, orgId: a.orgId }).returning());
  }
  updateLocation(a: AccessContext, siteId: string, id: string, dto: UpdateLocationDto) {
    return this.update(a, 'storage_location', id, storageLocations, dto, eq(storageLocations.siteId, siteId));
  }
  deleteLocation(a: AccessContext, siteId: string, id: string) {
    return this.remove(a, 'storage_location', id, storageLocations, eq(storageLocations.siteId, siteId));
  }

  // Cost centres
  listCostCentres(a: AccessContext) {
    return this.db.tenant(a.tenant, (tx) => tx.select().from(costCentres).orderBy(asc(costCentres.name)));
  }
  createCostCentre(a: AccessContext, dto: CreateCostCentreDto) {
    return this.create(a, 'cost_centre', (tx) => tx.insert(costCentres).values({ ...dto, orgId: a.orgId }).returning());
  }
  updateCostCentre(a: AccessContext, id: string, dto: UpdateCostCentreDto) {
    return this.update(a, 'cost_centre', id, costCentres, dto);
  }
  deleteCostCentre(a: AccessContext, id: string) {
    return this.remove(a, 'cost_centre', id, costCentres);
  }
}

@ApiTags('organization')
@ApiBearerAuth()
@Controller()
export class OrgStructureController {
  constructor(private readonly svc: OrgStructureService) {}

  @Get('org') @Requires('org:read')
  getOrg(@Access() a: AccessContext) { return this.svc.getOrg(a); }

  @Patch('org') @Requires('org:manage')
  updateOrg(@Access() a: AccessContext, @Body() dto: UpdateOrgDto) { return this.svc.updateOrg(a, dto); }

  @Get('legal-entities') @Requires('legal_entity:read')
  listLegalEntities(@Access() a: AccessContext) { return this.svc.listLegalEntities(a); }

  @Post('legal-entities') @Requires('legal_entity:manage')
  createLegalEntity(@Access() a: AccessContext, @Body() dto: CreateLegalEntityDto) { return this.svc.createLegalEntity(a, dto); }

  @Patch('legal-entities/:id') @Requires('legal_entity:manage')
  updateLegalEntity(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: UpdateLegalEntityDto) {
    return this.svc.updateLegalEntity(a, id, dto);
  }

  @Get('brands') @Requires('brand:read')
  listBrands(@Access() a: AccessContext) { return this.svc.listBrands(a); }

  @Post('brands') @Requires('brand:manage')
  createBrand(@Access() a: AccessContext, @Body() dto: CreateBrandDto) { return this.svc.createBrand(a, dto); }

  @Patch('brands/:id') @Requires('brand:manage')
  updateBrand(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: UpdateBrandDto) { return this.svc.updateBrand(a, id, dto); }

  @Delete('brands/:id') @Requires('brand:manage') @HttpCode(204)
  deleteBrand(@Access() a: AccessContext, @Param('id', uuid) id: string) { return this.svc.deleteBrand(a, id); }

  @Get('sites') @Requires('site:read')
  listSites(@Access() a: AccessContext) { return this.svc.listSites(a); }

  @Post('sites') @Requires('site:manage')
  createSite(@Access() a: AccessContext, @Body() dto: CreateSiteDto) {
    if (!a.holdsOrgWide('site:manage')) throw new ForbiddenException('Creating sites requires org-wide site:manage');
    return this.svc.createSite(a, dto);
  }

  @Get('sites/:siteId') @Requires('site:read', { siteParam: 'siteId' })
  getSite(@Access() a: AccessContext, @Param('siteId', uuid) siteId: string) { return this.svc.getSite(a, siteId); }

  @Patch('sites/:siteId') @Requires('site:manage', { siteParam: 'siteId' })
  updateSite(@Access() a: AccessContext, @Param('siteId', uuid) siteId: string, @Body() dto: UpdateSiteDto) {
    return this.svc.updateSite(a, siteId, dto);
  }

  @Get('sites/:siteId/locations') @Requires('location:read', { siteParam: 'siteId' })
  listLocations(@Access() a: AccessContext, @Param('siteId', uuid) siteId: string) { return this.svc.listLocations(a, siteId); }

  @Post('sites/:siteId/locations') @Requires('location:manage', { siteParam: 'siteId' })
  createLocation(@Access() a: AccessContext, @Param('siteId', uuid) siteId: string, @Body() dto: CreateLocationDto) {
    return this.svc.createLocation(a, siteId, dto);
  }

  @Patch('sites/:siteId/locations/:id') @Requires('location:manage', { siteParam: 'siteId' })
  updateLocation(@Access() a: AccessContext, @Param('siteId', uuid) siteId: string, @Param('id', uuid) id: string, @Body() dto: UpdateLocationDto) {
    return this.svc.updateLocation(a, siteId, id, dto);
  }

  @Delete('sites/:siteId/locations/:id') @Requires('location:manage', { siteParam: 'siteId' }) @HttpCode(204)
  deleteLocation(@Access() a: AccessContext, @Param('siteId', uuid) siteId: string, @Param('id', uuid) id: string) {
    return this.svc.deleteLocation(a, siteId, id);
  }

  @Get('cost-centres') @Requires('cost_centre:read')
  listCostCentres(@Access() a: AccessContext) { return this.svc.listCostCentres(a); }

  @Post('cost-centres') @Requires('cost_centre:manage')
  createCostCentre(@Access() a: AccessContext, @Body() dto: CreateCostCentreDto) { return this.svc.createCostCentre(a, dto); }

  @Patch('cost-centres/:id') @Requires('cost_centre:manage')
  updateCostCentre(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: UpdateCostCentreDto) {
    return this.svc.updateCostCentre(a, id, dto);
  }

  @Delete('cost-centres/:id') @Requires('cost_centre:manage') @HttpCode(204)
  deleteCostCentre(@Access() a: AccessContext, @Param('id', uuid) id: string) { return this.svc.deleteCostCentre(a, id); }
}

@Module({ controllers: [OrgStructureController], providers: [OrgStructureService] })
export class OrgStructureModule {}
