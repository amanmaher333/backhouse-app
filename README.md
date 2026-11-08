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
- CI (GitHub Actions) with Postgres; 29 tests covering units maths, RLS isolation, audit immutability, auth flows, tenant isolation over HTTP, and permissions

## Layout

```
apps/api          NestJS API (REST, OpenAPI)
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

Run all tests (needs the `boh_test` database from `.env`):

```bash
pnpm test
```

## How tenancy works

- Every tenant request runs in a transaction that does `SET LOCAL ROLE boh_app` and sets `app.org_id` / `app.user_id`. Postgres RLS policies then filter every table, so an application bug can't leak another tenant's rows.
- Only auth flows (signup, login, token refresh, accepting an invitation) use the privileged "system" connection, through `DbService.system()`.
- Permissions are `resource:action` strings. Org-scoped roles apply everywhere; site-scoped roles apply only to the sites on the membership.
- Schema changes: edit `packages/db/src/schema.ts`, then run `pnpm --filter @boh/db generate --name <change>`. New tenant tables need RLS policies; add a custom migration (see `0001_rls_audit_roles.sql`).

## Next: Phase 1 (catalogue and shared ingredient map)

Items, packs, supplier relationships and unclaimed supplier profiles, supplier items with price history, the canonical ingredient taxonomy and matching, CSV import/export. See `docs/SPEC.md` §8.
