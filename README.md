# BOH — Restaurant back-of-house platform

Multi-site procurement, inventory, costing and analytics for restaurant groups, with a supplier network, built Saudi-first.
Product spec: [`docs/SPEC.md`](docs/SPEC.md). Research: [`docs/research/`](docs/research/).

## Status

**Phase 0 (foundation) done:**

- pnpm monorepo (TypeScript, Node 22)
- `packages/domain`: units-of-measure engine (decimal-exact conversions, item-specific cross-dimension conversions, nested packs, cost per base unit), plus KSA VAT/CR validators
- `packages/db`: Postgres schema (Drizzle) for organisations (restaurant groups **and suppliers** as tenants), legal entities with KSA fields, brands, sites, storage locations, cost centres, users, roles, memberships, invitations, refresh tokens, audit events
  - **Row-level security** isolates tenants inside the database
  - Composite foreign keys stop a record from pointing at another tenant's data
  - **The audit log is append-only**: UPDATE, DELETE and TRUNCATE are rejected by trigger, even for the table owner
- `apps/api`: NestJS REST API
  - Auth: signup, login, refresh-token rotation that revokes the whole token family on reuse, switch org, invitations
  - Role-based permissions per site, with built-in Arabic/English roles and custom roles
  - Users can't grant permissions they don't hold themselves, and the last org admin can't be removed
  - Every write is audited in the same transaction, recording before and after values
  - OpenAPI docs at `/docs`
- `apps/web`: Next.js PWA built to the design spec in `docs/design/design-spec.md`. The back office uses the POS tokens; the "Ask BOH" agent screen uses the AI Insights tokens.
  - Arabic (RTL, the default) and English, light and dark themes
  - Phone bottom bar, tablet drawer, desktop sidebar that collapses
  - Sign-up with Saudi VAT/CR, login, invitation links, switching organisations
  - Screens: overview, sites and storage locations, members and invitations, roles (custom roles with a permission picker), audit log with before/after diffs, settings and legal entities
  - "Ask BOH" agent preview: the chat UI only, with clearly labelled sample data (the agent arrives in phase 8)
  - The refresh token is kept in an httpOnly cookie through a Next.js backend-for-frontend; API calls go through a same-origin proxy
  - Manifest, service worker for the app shell, install button, online/offline pill
- CI (GitHub Actions) with Postgres; 47 tests covering units maths, text normalisation, CSV, RLS isolation, audit immutability, auth flows, tenant isolation, permissions, matching and alias learning, packs, suppliers, prices and CSV import

**Phase 1 (catalogue and shared ingredient map) done:**

- **Shared ingredient map:** 134 common Saudi kitchen ingredients with English/Arabic names and supplier-style aliases. Item names are normalised (Arabic letter forms, diacritics, Arabic-Indic digits, pack sizes such as "6x1L" or "كرتون") and matched with Postgres trigram search. Confident matches link automatically; the rest are suggested for a person to pick.
- **Learning:** every time a person picks or changes a match, a correction is stored (training data). The name also becomes a new alias, which only takes effect once **two different organisations** confirm it, so one tenant can't poison the shared map.
- **Items:** auto codes, category, allergens and base unit (prefilled from the matched ingredient), duplicate warnings, nested packs (case → bottle → ml) with cross-unit conversion (density, piece weight), and par levels per site entered in any pack.
- **Suppliers:** a supplier profile is shared across BOH and deduplicated by VAT number, but each restaurant's relationship stays private. Each supplier has an ordering channel (email/WhatsApp/portal/manual), terms, and a delivery schedule per site (days, cut-off, lead time).
- **Prices:** supplier catalogue lines per pack, append-only price history, cost per kg / L / each, the preferred supplier per item, and a recent price changes feed (on the overview). Prices are hidden from roles without `price:read`.
- **CSV:** import and export for items and supplier price lists. Imports run as a dry run first, then commit all-or-nothing; empty cells mean "leave unchanged". Files include a BOM so Excel opens Arabic correctly.
- **Web:** items list with filters, item detail, suppliers list, supplier detail with inline price editing and history, the CSV import preview, and the overview price changes, all in Arabic and English.

## Layout

```
apps/api          NestJS API (REST, OpenAPI)
apps/web          Next.js PWA (back office + agent screen)
packages/db       schema, migrations (Drizzle + hand-written RLS SQL), tenant-scoped DB helpers
packages/domain   pure domain logic: units, conversions, KSA identifiers
infra/            docker-compose for Postgres, Redis, MinIO
docs/             product spec and research
```

## Getting started

Requirements: Node 22+, pnpm 10, and Postgres 16 (local, or via `docker compose -f infra/docker-compose.yml up -d`).

```bash
cp .env.example .env
```

```bash
pnpm install
```

```bash
pnpm -r build
```

```bash
pnpm db:migrate
```

```bash
pnpm --filter @boh/api start
```

The API listens on `http://localhost:3000`. Docs are at `http://localhost:3000/docs`; all routes except `/health` are under `/v1`.

Start the web app in a second terminal (it calls the API at `BOH_API_URL`, default `http://localhost:3000`):

```bash
pnpm --filter @boh/web start
```

Open `http://localhost:3001` and create an account. It's in Arabic by default; use the language button to switch.

Run all tests (needs the `boh_test` database from `.env`):

```bash
pnpm test
```

## How tenancy works

- Every tenant request runs in a transaction that does `SET LOCAL ROLE boh_app` and sets `app.org_id` / `app.user_id`. Postgres RLS policies then filter every table, so an application bug can't leak another tenant's rows.
- Only auth flows (signup, login, token refresh, accepting an invitation) use the privileged "system" connection, through `DbService.system()`.
- Permissions are `resource:action` strings. Org-scoped roles apply everywhere; site-scoped roles apply only to the sites on the membership.
- Schema changes: edit `packages/db/src/schema.ts`, then run `pnpm --filter @boh/db generate --name <change>`. New tenant tables need RLS policies; add a custom migration (see `0001_rls_audit_roles.sql`).

## Next: Phase 2 (procurement)

Requisitions, purchase orders, approval chains and spend limits, sending POs (email/WhatsApp/portal link), receiving (GRN) and the stock ledger. See `docs/SPEC.md` §8.
