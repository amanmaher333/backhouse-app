# Kitchain — Restaurant back-of-house platform

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
- `apps/web`: Next.js PWA built to the design spec in `docs/design/design-spec.md`. The back office uses the POS tokens; the "Ask Kitchain" agent screen uses the AI Insights tokens.
  - Arabic (RTL, the default) and English, light and dark themes
  - Phone bottom bar, tablet drawer, desktop sidebar that collapses
  - Sign-up with Saudi VAT/CR, login, invitation links, switching organisations
  - Screens: overview, sites and storage locations, members and invitations, roles (custom roles with a permission picker), audit log with before/after diffs, settings and legal entities
  - "Ask Kitchain" agent preview: the chat UI only, with clearly labelled sample data (the agent arrives in phase 8)
  - The refresh token is kept in an httpOnly cookie through a Next.js backend-for-frontend; API calls go through a same-origin proxy
  - Manifest, service worker for the app shell, install button, online/offline pill
- CI (GitHub Actions) with Postgres; 126 tests covering units maths, text normalisation, CSV, RLS isolation, audit immutability, auth flows, tenant isolation, permissions, matching and alias learning, packs, suppliers, prices, CSV import, the agent runtime (autonomy, guardrails, pause, dedup, permissions), access tokens, MCP, delivery dates, stock costing, the PO lifecycle, spend limits, the Purchasing agent, and WhatsApp linking, routing, signed webhooks, button decisions, the daily digest and supplier messaging (orders, confirmations, problems, the order link, direct chasers), billing (trial, renewals, retries, read-only mode, 3-D Secure, webhooks) and company verification

**Phase 1 (catalogue and shared ingredient map) done:**

- **Shared ingredient map:** 134 common Saudi kitchen ingredients with English/Arabic names and supplier-style aliases. Item names are normalised (Arabic letter forms, diacritics, Arabic-Indic digits, pack sizes such as "6x1L" or "كرتون") and matched with Postgres trigram search. Confident matches link automatically; the rest are suggested for a person to pick.
- **Learning:** every time a person picks or changes a match, a correction is stored (training data). The name also becomes a new alias, which only takes effect once **two different organisations** confirm it, so one tenant can't poison the shared map.
- **Items:** auto codes, category, allergens and base unit (prefilled from the matched ingredient), duplicate warnings, nested packs (case → bottle → ml) with cross-unit conversion (density, piece weight), and par levels per site entered in any pack.
- **Suppliers:** a supplier profile is shared across Kitchain and deduplicated by VAT number, but each restaurant's relationship stays private. Each supplier has an ordering channel (email/WhatsApp/portal/manual), terms, and a delivery schedule per site (days, cut-off, lead time).
- **Prices:** supplier catalogue lines per pack, append-only price history, cost per kg / L / each, the preferred supplier per item, and a recent price changes feed (on the overview). Prices are hidden from roles without `price:read`.
- **CSV:** import and export for items and supplier price lists. Imports run as a dry run first, then commit all-or-nothing; empty cells mean "leave unchanged". Files include a BOM so Excel opens Arabic correctly.
- **Web:** items list with filters, item detail, suppliers list, supplier detail with inline price editing and history, the CSV import preview, and the overview price changes, all in Arabic and English.

**Phase A (agent platform) done:**

- **Agents as members:** hiring an agent creates an agent identity (a user that cannot log in) with its own agent role. Agents appear in Members, act under the same row-level security and permissions, and their changes are audited as `actor_type = agent`.
- **Events:** domain changes emit append-only events in the same transaction (`price.changed` today).
- **Runtime:** a worker (`pnpm --filter @boh/api worker`) runs agents on new events, a daily scan and "run now". Postgres is the queue (per-agent advisory locks). Every run records events processed, tasks created and updated, actions executed, model, tokens and cost.
- **Tasks and autonomy:** agents propose tasks with evidence and typed actions, one open task per subject. Autonomy is set per action type (suggest, ask me, do it), with guardrails enforced in code and a pause switch. Approve, reject and dismiss each check permissions, and every decision is stored as a correction for evaluation and tuning.
- **Price Watch agent:** flags supplier price rises above a threshold, computes cost per kg / L / each, finds cheaper suppliers for the same item or shared ingredient, and drafts a bilingual message to the supplier. It scans existing history when first hired.
- **Language model:** Claude (`claude-opus-5-5`, structured JSON output, low effort, refusal fallback) writes titles, summaries and messages from evidence the code computes. Without `ANTHROPIC_API_KEY`, agents use bilingual templates.
- **Open access:** personal access tokens (`boh_pat_…`) and an **MCP server** at `/mcp` (stateless Streamable HTTP; tools filtered by permission: items, ingredient matching, suppliers, price changes, set price, agent inbox, approve and reject).
- **Web:** the Inbox is home (approve, reject or dismiss, with evidence, cheaper options and the supplier message), plus an Agents page (hire, pause, autonomy, limits, runs and AI cost) and an API & MCP page (tokens and client config).

**Phase 2 (procurement) with the Purchasing agent done:**

- **Stock ledger:** append-only stock movements (opening count, adjustment, receipt) and a balance per site and item, costed at weighted average. The first count of an item is costed at its cheapest supplier price. Stock shows low / OK / no par against each site's reorder point and par level.
- **Purchase orders:** draft → waiting for approval → approved → sent → partly received → received → closed (or cancelled). Spend limits per order and per month, for the whole org, a site or a supplier. Orders over a limit need someone with `po:approve`, who can't be the person who created them.
- **Delivery dates:** worked out in Riyadh time from each supplier's delivery days, cut-off and lead time.
- **Sending:** builds a bilingual order message with WhatsApp and email links, and marks the order as sent. Kitchain doesn't send it directly yet.
- **Receiving:** quantities and prices from the delivery note, partial deliveries, and an immutable goods receipt. Stock is posted at the delivered price. Changed prices update the supplier catalogue (source `invoice`), which feeds Price Watch.
- **Purchasing agent:** watches stock, order and receipt events, plus a daily scan. For items at or below their reorder point it drafts one order per supplier per site, topped up to par in whole packs net of what's already on order, using the preferred supplier (otherwise the cheapest). Evidence covers on hand, par, quantities, totals, delivery date and the supplier minimum. Items never counted are skipped by default. It also flags late deliveries and drafts a chaser. On "do it" autonomy it creates orders by itself only up to a SAR cap (default 1,500), and spend limits still apply.
- **Web:** Orders (list, new order from a supplier's catalogue, order detail with approve / send / receive / close / cancel), Stock (per site, low filter, set count in any pack), and inbox cards for reorder drafts and late deliveries, in Arabic and English.

**Phase B (channels): WhatsApp approvals, daily digest and supplier messaging done:**

- **Linking:** a person links their number by sending a one-time code (15 minutes, stored hashed) from WhatsApp. Sending from the number proves they hold it. One number per account, and it works across all their organisations.
- **Approval cards:** when an agent proposes something that needs a decision, the worker sends a card to everyone who could approve it at that site and has cards turned on. Inside WhatsApp's 24-hour window it's an interactive message with Approve / Reject buttons. Outside it, an approved template is used (see [`docs/whatsapp-templates.md`](docs/whatsapp-templates.md)). Cards show the order lines, total incl. VAT, delivery date, what Approve will do, and a link to the task. They're in the person's language.
- **Decisions:** a tap is honoured only if all of these hold:
  - it comes from the number the card went to;
  - the card hasn't been used and hasn't expired;
  - the task is still open;
  - for Approve, the task is within the org's WhatsApp limit (default SAR 5,000);
  - the person still has the permissions at that moment.

  It runs through the same runtime as the web inbox (guardrails, spend limits, separation of duties). It's audited as `whatsapp:<message id>`, the task records "decided on WhatsApp", and the person gets a reply such as "order PO-00012 created".
- **Webhook:** signature-checked (`X-Hub-Signature-256`), with retries deduplicated by message id. Delivery statuses are tracked (sent → delivered → read, never backwards), and failed sends are retried with backoff. `STOP` / `START` (and إيقاف / تشغيل) pause and resume cards.
- **Daily digest:** one WhatsApp message per person per organisation, at their chosen local hour (default 08:00 Riyadh).
  - It covers decisions waiting for them, what agents did on their own in the last 24 hours, orders (spend approval, due today, late), low stock by site and price rises, limited to what their permissions allow.
  - Quiet days send nothing, and a digest is never sent twice.
  - Outside the 24-hour window it's a compact template. Its **Show decisions** button reopens the window, and the waiting approval cards follow as interactive messages.
  - The WhatsApp page has a preview and a "send it now" button.
- **Direct supplier messaging:** for suppliers who take orders on WhatsApp, "Send on WhatsApp from Kitchain" sends the order from Kitchain's number (Arabic and English).
  - The message has **Confirm / Problem** buttons and a private link to the order. The link is a public page that needs no account, where the supplier can confirm or describe a problem.
  - A confirmation is recorded on the order.
  - A problem or any other reply is stored on the order, sent as a WhatsApp notice to the people who manage that site's orders, and added to the inbox as a Purchasing task.
  - The order page shows the whole conversation and the supplier's answer.
  - Once a person approves them, the Purchasing agent's late-delivery chasers and Price Watch's supplier messages are also sent directly. Suppliers on email still get the prepared message and links.
- **Simulated mode** (default without Meta credentials): nothing leaves the machine, and the WhatsApp page includes a phone simulator for trying the whole flow.
- **Web:** the WhatsApp page (link your number, approvals on/off, org approval limit, message log, simulator). The inbox shows "on WhatsApp" on decisions made there, and opens the right task from card links.

**Billing and company verification done** (see [`docs/billing-and-verification.md`](docs/billing-and-verification.md)):

- **Self-serve subscriptions:**
  - restaurants get a 30-day trial at sign-up, then a monthly or annual plan in SAR (platform fee plus each agent per active site, plus 15% VAT), charged to a saved card;
  - suppliers are free.
- **Renewals:** handled by the worker, with retries after 1 and 3 days. An organisation that doesn't pay becomes read-only (`402`), its agents and WhatsApp pause, and paying restores it at once.
- **Payments:** simulated by default; Moyasar adapter for mada, Visa, Mastercard and Apple Pay.
- **Invoices:** every charge issues a tax invoice with ZATCA's phase-1 QR code.
- **Company checks:** the CR is checked against the Ministry of Commerce register (Wathq adapter, simulated by default) at sign-up and on changes.
  - An active CR with a matching name is verified automatically; a missing or expired CR is rejected with the reason.
  - Only a name mismatch reaches Kitchain's review queue.
  - A verified company is required before Kitchain messages suppliers for it.
- **Web:** Billing page (trial, plan choice with live estimate, card, cancel/resume, pay now, invoices), printable invoice with QR, trial and read-only banner, verification badges and "Check now" in Settings.

**Phase 3 started: supplier invoices and the Invoice agent** (see [`docs/invoices.md`](docs/invoices.md)):

- **Intake:**
  - upload a PDF, photo or ZATCA e-invoice XML;
  - type in paper invoices;
  - or have suppliers email them to the organisation's private address (signed webhook, deduplicated, sender checked).
- **Reading:**
  - e-invoices are read exactly, including the XML inside ZATCA PDFs;
  - other documents are read by Claude into a fixed structure and checked by code, or kept for a person when no model is configured.
- **Three-way match** against the order and what was received:
  - prices, quantities net of earlier invoices, and lines not ordered;
  - arithmetic, VAT, duplicates and the supplier's VAT number;
  - the amount to claim back.
- **Decisions:**
  - approve (mismatches need a reason; someone else approves invoices you typed in);
  - ask for a credit note (sent on WhatsApp or prepared as email);
  - reject, or mark as paid.
  - Credit notes link to the invoice they fix.
- **Invoice agent:** proposes approvals, credit-note requests with a drafted message, checks, and approval once a credit note arrives. It can approve clean matches under a limit on its own.
- **Web:** Invoices list with tabs, upload, invoice page with every difference highlighted, entry by hand, invoices on the order page, invoice tasks in the inbox. MCP tools `list_supplier_invoices` and `get_supplier_invoice`.

**Phase 3: ZATCA phase 2 e-invoicing (issuing)** (see [`docs/zatca.md`](docs/zatca.md)):

- **Validated by ZATCA:** `pnpm --filter @boh/api zatca:check` gets **PASS** from ZATCA's own validator (Developer Portal) on all six document types.
- **EGS units per legal entity:**
  - onboarding with the Fatoora OTP: compliance certificate, ZATCA's compliance checks, production certificate;
  - keys and secrets encrypted at rest.
- **Tax invoices (B2B) cleared, simplified invoices (B2C) reported, credit and debit notes:**
  - UBL 2.1 XML with the ICV and PIH chain, XAdES signature and phase-2 QR;
  - signed documents can't be changed;
  - the worker retries when ZATCA is unreachable.
- **Web:**
  - E-invoicing page: register, onboard with the OTP, compliance check results;
  - Sales invoices: list, new invoice or note, printable bilingual invoice with QR, XML download.
- **Modes:** simulated by default (`ZATCA_MODE=simulated`); `live` calls ZATCA.

**Countries:** Saudi Arabia first, but no Saudi assumptions outside ZATCA and Wathq (see [`docs/countries.md`](docs/countries.md)):

- **Supported:** Saudi Arabia, the UAE, Bahrain, Kuwait, Oman, Qatar, Egypt and Jordan.
- **Set by the organisation's country at sign-up:** currency, VAT rate, time zone, phone format, and tax and company number rules.
- **Documents and messages** use the document's own currency.
- **Company checks:** automatic in Saudi Arabia (Wathq); elsewhere Kitchain reviews the company.
- **ZATCA** is offered only to Saudi companies.

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

## Running the agents locally

```bash
pnpm --filter @boh/api worker
```

The worker also sends WhatsApp approval cards. To use real WhatsApp, set the `WHATSAPP_*` variables in [`docs/whatsapp-templates.md`](docs/whatsapp-templates.md).

Set `ANTHROPIC_API_KEY` in `.env` for Claude-written text (optional; `AGENTS_LLM=template` forces templates, `AGENTS_MODEL` overrides the model).

## Next

- **Phase B (rest):** push notifications; supplier messages by email.
- **Phase 3 (rest):** posting approved invoices to accounting systems; documents in object storage; PDF/A-3 and email delivery of issued invoices; Kitchain's own billing on phase 2; supplier accounts so suppliers can issue on Kitchain.

See `docs/SPEC.md` §10.
