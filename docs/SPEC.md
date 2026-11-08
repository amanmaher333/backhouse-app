# BOH — Product Spec v0.3 (moat-first, KSA-first)

Working codename **BOH**; rename before launch. Launch market: **Saudi Arabia first**, UAE second (decided 2026-11-08).
v0.1 was a feature-parity spec; this version is built around **defensibility**.
Research: `research/` (procurement, inventory, platform teardown of Supy from public sources; GCC e-invoicing).
This is an original product. No Supy code, branding, copy or UI is used.

---

## 1. Thesis

> **Incumbents sell software that restaurant teams have to operate. BOH is an AI back-of-house manager that does the work. Staff talk to it on WhatsApp in their own language. And every supplier and every invoice makes the network smarter for everyone on it.**

Features can be copied in months. BOH is designed so that its value builds up in things a competitor **cannot** copy by rebuilding the app:

| # | Moat | What builds up over time | Why a copycat can't shortcut it |
|---|---|---|---|
| 1 | **Supplier network** (two-sided) | Suppliers transacting on BOH | A competitor can clone the portal but not the suppliers on it |
| 2 | **Data flywheel** | Shared ingredient map, price index, benchmarks, AI corrections | Needs years of real invoices and human corrections |
| 3 | **Money flows** | Supplier payments, then financing | Switching means rewiring payables; financing needs our data |
| 4 | **Regulatory depth** | E-invoicing (KSA ZATCA first, UAE Peppol later), VAT, in-Kingdom data residency | Accreditation takes time; deadlines in 2027 favour whoever is ready first |
| 5 | **Kitchen-floor know-how** | Multilingual voice and WhatsApp workflows, dialect data | Behaviour change is sticky; speech data accumulates |

**Not moats** (fine for winning customers, but don't rely on them): UI polish, individual AI features, low price.

**Rule:** every feature must either (a) give a single restaurant value on its own, or (b) feed a moat. Ideally both.

---

## 2. Product pillars

### Pillar A — "Talk to your kitchen" (WhatsApp + voice, multilingual)
For kitchen staff who live on WhatsApp and speak Hindi, Urdu, Malayalam, Tagalog, Nepali, Arabic or English.
- **Voice counts:** "chicken breast three and a half boxes, cream six litres" → counted lines in the right pack sizes and units, with a confirmation message.
- **Waste:** photo + voice note → waste record (item, qty, reason, cost).
- **Receiving:** photo of the delivery note or invoice → matched against the PO, discrepancies flagged, GRN drafted.
- **Requests:** "need 10 kg onions tomorrow" → requisition.
- **Approvals:** the manager replies `approve` / `reject` to a WhatsApp card.
- Everything also works in the web app and offline mobile app; WhatsApp is a front end on the same API.

### Pillar B — AI operations agent
- **Explains:** "Why is food cost up 2.8% at Marina?" → a breakdown by cause (price, waste, variance, sales mix) with ingredient-level detail.
- **Weekly profit-leak report** per site: the top 5 leaks in AED/SAR with a recommended action.
- **Acts:** drafts orders from forecast and par levels, chases missing credit notes from suppliers, reconciles invoices, prepares the accounting push.
- **Autonomy levels** set per org and per action: `suggest` → `act with approval` → `act and notify`. Money-moving and supplier-facing actions default to approval.
- Anomaly detection: price spikes, count variance, waste patterns, suspected theft, duplicate invoices.

### Pillar C — Live in 48 hours (AI onboarding)
Upload 3 months of invoices (PDF, photo or e-invoice XML) + menu + any recipe sheets → BOH builds items, packs, suppliers, price lists and draft recipes, matched to the shared ingredient map. A person reviews in a guided queue. *(The incumbent's most common complaint is that customers do the setup themselves.)*

### Pillar D — Supplier network (free supplier portal)
- Suppliers get a free account: receive orders, **confirm/amend/substitute**, publish catalogues and price changes, issue **compliant e-invoices**, see their restaurant customers' demand outlook, track payments.
- **E-invoicing hook:** KSA Wave 25 (VAT-able revenue > SAR 187.5k, including voluntarily registered small suppliers) must integrate with ZATCA Fatoora by **1 Feb 2027**. That's too soon for BOH to be the compliance tool for most of them, but many small suppliers will be late, non-compliant or stuck on clunky tools, and every new VAT registrant joins later waves. BOH gives suppliers ZATCA-compliant invoicing for free → they join the network. UAE follows (businesses under AED 50M: 1 Jul 2027). See `research/research-einvoicing.md`.
- **Viral loop:** a restaurant invites its suppliers; a supplier invites its other restaurant customers ("order from me on BOH").

### Pillar E — Market intelligence (switched on once there's enough data)
- **Price benchmark:** "Your tomato price is 18% above the Dubai median this month; 3 cheaper suppliers deliver to you."
- **Market price index** by city × canonical ingredient × month.
- **Operational benchmarks:** waste %, food cost %, yield, count variance by concept (burger, café, fine dining…).
- Shown only when **k-anonymity** holds (≥ N distinct buyers and ≥ M suppliers per data point).

### Pillar F — Money (Year 3)
- Pay suppliers through BOH (bank transfer, card, local payment rails) → BOH becomes the record of what's owed.
- Early payment to suppliers / invoice financing with a licensed partner, underwritten on BOH data.

---

## 3. Moat-critical architecture decisions (must be in place from day one)

These are cheap now and very expensive to add later.

1. **Suppliers are tenants.** A supplier is an `Organization` of `type=supplier` with its own users, catalogue and documents. A restaurant's "supplier" record is a **relationship** (`TradingRelationship`) between two orgs, with a fallback to an *unclaimed* supplier profile that the supplier can later claim.
2. **Shared ingredient map.** A global, BOH-curated `CanonicalIngredient` taxonomy (multilingual names, density, typical packs, allergens). Every tenant `Item` and every `SupplierItem` gets a `canonical_id` with a confidence score. This mapping is the backbone of benchmarks, onboarding and AI.
3. **Correction capture.** Every place a person fixes the AI (extraction field, item match, voice parse, recipe draft) writes a `Correction` event (input, model output, human output, user, context). This is the training data that keeps improving the AI.
4. **Consent and anonymisation.** Terms allow anonymised, pooled aggregation; per-org opt-out (with reduced benchmark access in return: *give to get*). Aggregates are built in a separate **analytics store**, never by querying tenant data live; k-anonymity is enforced at build time.
5. **Structured document input.** Invoices can arrive as **UBL / PINT AE / ZATCA XML**, PDF/A-3 with embedded XML, PDF, photo, or email. The XML path skips AI entirely.
6. **Append-only ledgers.** One ledger for stock movements and one for **payables** (invoices, credits, payments), so payments and financing plug in later without schema surgery.
7. **Channel-agnostic actions.** All writes go through domain commands (`RecordCount`, `PostGRN`, `ApproveDocument`). Web, mobile, WhatsApp, voice, API and the AI agent are all just *callers*, with the same permissions and audit trail.
8. **Data residency ready.** Per-region deployment (KSA in-Kingdom first, UAE later). No cross-region joins in the request path; the analytics store receives only anonymised aggregates.

---

## 4. Domain model (core)

```
Organization (type: restaurant_group | supplier | platform)
 ├─ LegalEntity (tax reg no., country, currency, e-invoicing profile, accounting connection)
 │   ├─ Brand
 │   └─ Site (type: restaurant | central_kitchen | warehouse)
 │       ├─ StorageLocation
 │       └─ CostCentre
 ├─ User ─ Membership(role, site scope)
 └─ TradingRelationship (buyer_org ⇄ supplier_org | unclaimed SupplierProfile)

CanonicalIngredient (global)  ◄── Item (tenant) ── Pack
                              ◄── SupplierItem (supplier catalogue: sku, pack, price history)

Requisition → PurchaseOrder → SupplierConfirmation → GRN → SupplierInvoice / CreditNote → Payment
Recipe (+ sub-recipes, effective-dated) ◄── PosItem mapping
StockCount (+ sub-counts) · Waste · Transfer · ProductionBatch
StockMovement (append-only ledger) · PayableEntry (append-only ledger)
Correction (AI training events) · AuditEvent · Document (raw file / XML)
AgentTask (proposed/approved/executed actions)
```

### Key states
- **Requisition:** `draft → submitted → pending_approval → approved → processed | rejected | discarded`. Processed lines are combined into one PO per supplier per delivery date.
- **PurchaseOrder:** `draft → pending_approval → approved → sent → confirmed | amended → partially_received → received → closed | cancelled`.
- **GRN:** `draft → posted` (immutable). Price mismatch → `request_credit | accept_price | discount`.
- **SupplierInvoice:** `received → extracted | parsed_xml → needs_review | matched → approved → posted → paid`.
- **CreditNote:** `open → allocated → closed`.
- **Transfer:** `draft → in_transit → received | partially_received | rejected`.
- **StockCount:** `open → sub_counts_submitted → finalised` (writes adjustments).
- **AgentTask:** `proposed → approved | rejected → executed | failed`.

---

## 5. Core modules (single-restaurant value)

Detail carried over from v0.1, condensed. See `research/` for the incumbent's behaviour this is informed by.

- **Catalogue:** items (base unit g/ml/each, count units, item-specific conversions, allergens, storage, par per site, duplicate detection); nested packs; supplier items with versioned prices and site overrides; CSV/Excel bulk edit.
- **Procurement:** requisitions, POs via portal, email or WhatsApp, approval chains (N steps) and spend limits (supplier/site/category/user × day/week/month/quarter; the most specific limit wins); par-based and forecast-based suggestions; receiving with ordered/invoiced/received quantities; GRN without PO by permission.
- **Invoices:** XML path (exact) and AI path (Claude vision → header + lines); matching invoice→PO (PO no., then supplier + date) and line→SupplierItem (SKU → learned mapping → fuzzy); 3-way check with tolerances; duplicate detection.
- **Inventory ledger:** weighted average cost by default, **optional lot/expiry with FIFO** per item ("use first" alerts); period locks per entity; recalculation back to the last lock; negative stock allowed but flagged.
- **Counts:** per site per date, sub-counts per counter with attribution; templates (full / partial / high-value / by location); scheduling; zero-or-skip uncounted; warning about unreceived POs; variance report; offline + barcode + voice.
- **Waste, transfers, production:** waste with type and reason and approval threshold; transfers valued at the sender's average cost, with in-transit stock and intercompany journals; production batches consuming ingredients and outputting prep stock.
- **Recipes and costing:** recipe types (menu / stockable prep / non-stockable / revenue-only), nested sub-recipes with cycle detection, yield and prep loss, effective dating (backdated or scheduled), bulk ingredient swap, allergen roll-up, target cost alerts; cost view at average / last / chosen supplier price; POS mapping with modifiers, sales types and combos, plus an **unmapped-items queue**.
- **Analytics:** COGS / food cost %, theoretical vs actual (`actual = open + in − out − close`; `theoretical = Σ sales × recipe + recorded waste`), waste, purchase analysis, price changes and their impact on recipes and margins, stock value, menu engineering; **scheduled reports** (email, WhatsApp, Slack).

---

## 6. Integrations

- **Adapter framework** with idempotency, retries, sync logs and a health page.
- **POS:** Foodics first (GCC market leader), then Square / Lightspeed / others on demand. Menu pull and sales pull or webhook → depletion.
- **Accounting:** Xero, Zoho Books (popular in the GCC), QuickBooks. Bills, credit notes, period-end journals (COGS, waste, stock value change, intercompany). GL mapping per category and entity.
- **E-invoicing:**
  - **KSA (first):** ZATCA Phase 2 issuing module for suppliers and central kitchens on BOH (UBL 2.1 XML, cryptographic stamp, QR, device/EGS onboarding per supplier, B2B clearance and B2C reporting); ingestion of received XML / PDF-A3 from suppliers' own systems. *To check: ZATCA's current rules on solution providers / qualified vendor lists, and whether a third-party specialist (SDK or middleware) is faster to build on than doing it ourselves.*
  - **UAE (Year 2):** partner with an Accredited Service Provider (receive as buyer endpoint; issue for suppliers), PINT AE format. Path to becoming a Peppol service provider (UAE ASP accreditation reportedly needs about 2 years of operating history).
- **WhatsApp:** WhatsApp Business Platform (Cloud API) via a business solution provider; message templates for POs, approvals and reports.
- **Speech:** a multilingual speech-to-text provider (evaluate Hindi, Urdu, Malayalam, Tagalog, Gulf Arabic accuracy), then Claude to parse into structured commands against the tenant's catalogue.
- **Public API + webhooks:** OpenAPI 3, included in every plan (the incumbent sells it as an add-on).
- **Data export:** nightly Parquet/CSV to the customer's own warehouse.

---

## 7. Technical architecture

```
apps/
  api/        NestJS — REST/OpenAPI, auth, permissions, domain commands
  worker/     BullMQ — POS sync, AI extraction, e-invoicing, accounting, agent runs, reports
  web/        Next.js — restaurant dashboard + supplier portal (role-based)
  mobile/     offline-first PWA (counts, receiving, waste, approvals)
  messaging/  WhatsApp + voice gateway → domain commands
  agent/      AI ops agent: tools = domain commands; autonomy policy; AgentTask log
  analytics/  pipeline to anonymised aggregate store (benchmarks, price index)
packages/
  db/         schema + migrations
  domain/     units, conversions, costing, ledger maths (pure, heavily tested)
  canonical/  shared ingredient map + matching (embeddings + rules)
  einvoice/   UBL / PINT AE / ZATCA parsers and generators
  shared/     types, zod schemas, generated API client
infra/        docker-compose (postgres, redis, minio), IaC per region, CI
```

- **Database:** **Postgres (decided)**: relational data, ledger transactions, SQL reporting, row-level security for tenancy, JSONB for raw payloads, pgvector for ingredient matching.
- **AI:** Claude for extraction, voice-command parsing, recipe drafting and the operations agent. Structured outputs validated with schemas. Confidence thresholds route to human review → `Correction` events.
- **Hosting:** in-Kingdom KSA region at launch (e.g. a cloud provider with a Saudi region, to meet data-residency expectations of KSA enterprise customers and the PDPL; confirm the exact requirements with counsel). UAE region before UAE customers.

---

## 8. Roadmap

### Year 1 — Single-restaurant value + start building moats (KSA)
| Phase | Scope | Size |
|---|---|---|
| 0 Foundation ✅ | Monorepo, auth, orgs (incl. supplier type), entities/sites, roles, audit, units engine, CI — **done** | 2 wks |
| 1 Catalogue + shared map ✅ | Items, packs, supplier relationships/profiles, supplier items + price history, canonical ingredient seed + matching, CSV — **done** | 2–3 wks |
| 2 Procurement | Requisitions, POs, approvals/limits, sending POs (email/WhatsApp/portal link), GRN, stock ledger | 3 wks |
| 3 Invoices | AI extraction + XML parsing, matching, review queue, credit notes, payables ledger, `Correction` capture | 2–3 wks |
| 4 Inventory + recipes | Counts/sub-counts, waste, transfers, recipes/costing, effective dating | 3 wks |
| 5 WhatsApp + voice | Messaging gateway, voice counts, waste, receiving photos, approvals | 3 wks |
| 6 AI onboarding | Bulk invoice/menu/recipe import → guided review | 2 wks |
| 7 Integrations | Foodics (sales → depletion), Xero/Zoho, theoretical vs actual | 3 wks |
| 8 Agent v1 + reports | Food-cost explainer, weekly profit-leak report, scheduled reports | 2–3 wks |
| 9 Supplier portal v1 | Supplier claims profile, receives/confirms POs, publishes prices | 2 wks |

**MVP for design partners = phases 0–5 (about 15–18 weeks).** Full Year-1 scope is about 6–7 months for a small team.

**Pull ZATCA forward:** supplier e-invoice issuing (ZATCA) moves into Year 1 alongside the supplier portal (phase 9), because it's the main supplier-acquisition hook in KSA. Foodics is the first POS integration; Zoho Books / Qoyod / Xero for accounting (check which have the most share among Saudi restaurant groups).

### Year 2 — Network (KSA scale-up + UAE launch)
UAE launch (ASP partner, PINT AE, UAE region), supplier-to-restaurant invites, launch of the price benchmark and price index, operational benchmarks, central kitchen + B2B ordering, forecasting + suggested orders, Peppol service provider certification.

### Year 3 — Money
Supplier payments, early payment and invoice financing with a licensed partner, agent autonomy upgrades, regional expansion.

---

## 9. Metrics that prove the moat is building
- **Network:** % of POs sent to *claimed* suppliers; supplier → restaurant invites per month; suppliers with ≥ 2 BOH buyers.
- **Data:** % of invoice lines arriving as XML; ingredient-matching accuracy without human edits; corrections per 1,000 lines (should fall).
- **Engagement:** % of counts / waste / receiving done via WhatsApp or voice; weekly active kitchen staff per site.
- **Value:** food cost % reduction vs baseline at 90 days; time to go live (target ≤ 48 h to first value).
- **Stickiness:** net revenue retention; % of payables flowing through BOH (Year 3).

---

## 10. Risks and how we handle them
| Risk | How we handle it |
|---|---|
| Two-sided network is hard to start | Each side gets value on its own: restaurants without suppliers on BOH; suppliers from a single restaurant + free e-invoicing compliance |
| Voice accuracy in mixed languages / noisy kitchens | Constrain parsing to the tenant's catalogue; always confirm back; test with design partners before building in full |
| Benchmark privacy / trust | k-anonymity, opt-out, a separate analytics store, a clear data policy; never show supplier-specific prices tied to a named buyer |
| E-invoicing dates and rules shift | Partner with an ASP rather than building one in Year 1; check official FTA/ZATCA sources; keep the e-invoicing package modular |
| Incumbent copies the AI features | Expected. Defensibility comes from moats 1–4, not the features |
| WhatsApp platform policy / costs | Keep WhatsApp as one front end on channel-agnostic commands; web/PWA always works |

---

## 11. Open decisions
1. ~~Database~~ — **decided: Postgres.**
2. ~~Launch market~~ — **decided: Saudi Arabia first**, UAE second. Arabic/RTL is required from the first release, not Year 2.
3. **First customer profile:** multi-site groups (recommended for supplier density) or single cafés?
4. **Design partners:** can we line up 3–5 kitchens to test WhatsApp/voice counts before phase 5?
5. **ASP partner shortlist:** start conversations now for the 2027 window.
6. **Product name** and brand.
