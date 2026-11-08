# BOH — Product Spec v0.4 (Agents as a Service, moat-first, KSA-first)

Working codename **BOH**; rename before launch. Launch market: **Saudi Arabia first**, UAE second.
- v0.1 was feature parity.
- v0.2–0.3 added defensibility and Saudi-first.
- **v0.4 changes what customers buy: agents that do back-office jobs, not software they operate.**

Research: `research/` (Supy teardown from public sources; GCC e-invoicing). Design: `design/design-spec.md`.
This is an original product. No Supy code, branding, copy or UI is used.

**Status:**
- Phase 0 (foundation) ✅
- Phase 1 (catalogue and shared ingredient map) ✅
- Phase A (agent platform and Price Watch) ✅; see §10.

---

## 1. Thesis

> **Restaurant groups don't want more software. They want the back-office work done. BOH gives them agents that do purchasing, invoice checking, stock control and cost control. People approve and correct, mostly over WhatsApp, and every correction makes the agents and the shared network better.**

| | SaaS (what incumbents sell) | BOH: Agents as a Service |
|---|---|---|
| Customer buys | Seats, modules, locations | **Agents hired per site** to do specific jobs |
| Home screen | Lists and forms | **The inbox:** work the agents did or propose, waiting for a decision |
| Staff do | Data entry | Approve, correct, give context (web, WhatsApp, voice) |
| Value measured by | Logins | **Jobs done, hours saved, riyals saved** |
| Gets better by | New features | **Every approval and correction**, plus the network's data |

What still holds from v0.3: the moat stack (§3). Agents are how customers experience the product. The moats are why agents on BOH beat agents built anywhere else.

---

## 2. The agents

Each agent is a product: a clear job, the tools it may use, the actions it may propose, how much it may do on its own, and a measured outcome.

| Agent | Job | Triggers | Proposes / does | Outcome metric | Depends on |
|---|---|---|---|---|---|
| **Price Watch** | Catch supplier price rises and respond | `price.changed` events, daily scan | Switch to a cheaper supplier for the same ingredient; ask the supplier to explain or revert (drafted EN/AR message); accept the new price | SAR avoided per month; response time to price rises | Phase 1 ✅ |
| **Onboarding** | Get a customer live in 48 h | New org, uploaded files | Build items, packs, suppliers and price lists from invoices, price lists and menus, for review | Time to first value; % of lines accepted without edits | Phase 1 ✅ + document AI |
| **Purchasing** | Keep every site stocked at the lowest cost | Par/stock levels, delivery schedules, cut-offs | Draft orders per supplier and delivery date; send after approval; chase late confirmations | Stock-outs avoided; on-time ordering; savings vs. last price | Phase 2 |
| **Invoice** | Never pay for what didn't arrive | Invoice received (email/e-invoice), delivery received | Match invoice to PO and delivery; flag differences; draft credit-note requests; post to accounting | SAR recovered; minutes per invoice | Phase 2, e-invoicing |
| **Stock** | Accurate stock with minimal effort | Count schedules, WhatsApp/voice messages | Run counts and waste logging by voice; explain variances | Count completion; variance explained | Phase 3 |
| **Cost Controller** | Protect food-cost % | Weekly schedule, questions | "Why did food cost rise?"; weekly profit-leak report; menu price suggestions | Food cost % vs. target | Recipes + POS |

**Rules for every agent:**
1. **Evidence first.** Every proposal shows the data behind it (prices, history, alternatives, calculation) so a person can decide in seconds.
2. **Typed actions only.** An agent can only *propose* actions from a fixed list. Executing one goes through the same domain commands, permissions and audit log as a person's click. No free-form database or API access.
3. **Bilingual.** Summaries and messages are written in Arabic and English.
4. **Deterministic core, AI on the edges.** Calculations (cost per kg, savings, matching thresholds) are code. The language model writes summaries and messages and handles messy input. If the model is unavailable, the agent still works with templates.

---

## 3. Moats (unchanged from v0.3, now feeding the agents)

| # | Moat | What builds up over time | How it makes agents better |
|---|---|---|---|
| 1 | **Supplier network** (two-sided, deduplicated by VAT number) | Suppliers transacting on BOH | Agents can message, compare and switch suppliers; suppliers confirm orders on the platform |
| 2 | **Data flywheel** | Shared ingredient map, price index, benchmarks | Agents know whether a price is fair across the market, not just versus last week |
| 3 | **Corrections → training data** | Every approval, rejection and edit, stored | Agents tuned and evaluated on real decisions; rejected suggestions teach the agent |
| 4 | **Regulatory depth** | ZATCA e-invoicing, VAT, in-Kingdom hosting | The Invoice agent reads structured e-invoices exactly |
| 5 | **Kitchen-floor know-how** | WhatsApp and voice workflows in staff languages | Agents talk to kitchen staff where they already are |
| 6 | **Agent track record** *(new)* | Per-customer history of autonomy granted and outcomes | Customers raise autonomy as trust builds, so switching means starting from "suggest only" again |

---

## 4. Agent platform architecture

### 4.1 Agents are first-class actors
- Installing an agent in an org creates an **agent identity**: a user record of kind `agent`, with no password and no ability to log in. It gets a membership with a dedicated **agent role** (e.g. `agent_price_watch`: read items, suppliers and prices; propose; on approval, set the preferred supplier).
- Agents appear in **Members** next to people and can be paused or removed like staff. Every agent action is audited with `actor_type = agent` and the approving person recorded on the task.
- Database row-level security, permissions and audit apply unchanged: an agent cannot see another tenant's data, and cannot do anything its role doesn't allow.

### 4.2 Events
- Domain changes emit **events** in the same transaction as the change (`price.changed`, `supplier_item.created`, later `stock.below_par`, `invoice.received`, `po.overdue`…).
- Events are append-only rows in Postgres. Each agent keeps a **cursor** (last event processed), so nothing is missed or processed twice.

### 4.3 Runtime
- A **worker** process runs agents:
  - on new events
  - on schedules (e.g. daily 06:00 Riyadh time)
  - on demand ("run now")
- Phase A uses a **Postgres-backed queue** (per-agent advisory locks, no extra infrastructure). Redis/BullMQ is added only if volume needs it.
- Each run records an **agent run**: trigger, events processed, tasks created, model, input/output tokens, cost (USD), duration, errors. This drives usage-based pricing and the cost-per-job metric.

### 4.4 Tasks, actions and autonomy
- An agent's output is an **agent task**: title and summary (EN/AR), evidence, a list of **proposed actions** (typed, with parameters), status, and decision record.
- Task states: `proposed → approved → executed | failed`, or `rejected` / `dismissed` / `expired`.
- **Autonomy is set per agent and per action type:**
  - `suggest`: show it; a person carries it out themselves
  - `approve` (the default): one tap runs it
  - `auto`: the agent runs it immediately and notifies
- **Guardrails** are hard limits checked in code at execution time, whatever the autonomy level. Examples:
  - switch suppliers automatically only if the saving is at least X%
  - never auto-switch to a supplier with no order history *(Phase 2)*
  - order value caps *(Phase 2)*
- **Kill switch:** pausing an agent stops runs and blocks execution of its pending tasks immediately.
- **Deduplication:** one open task per subject (e.g. per supplier item price rise), and a newer rise updates the open task rather than creating another.
- **Corrections:** a rejection (with optional reason) or an edited parameter is stored as a correction for evaluation and tuning.

### 4.5 Language models
- **Claude** (Anthropic API, default `claude-opus-5-5`, low effort for short writing tasks) writes summaries and supplier messages in Arabic and English, using structured JSON output.
  - Refusal fallbacks are enabled.
  - Token usage and cost are recorded per run.
- **Template fallback:** if no API key is configured, or the call fails, agents use bilingual templates, so they never stop working because of the model.
- Prompts and outputs are logged with the task (not the API key), for review and evaluation.
- Later: a cheaper model for high-volume extraction (invoices, voice), measured against the same evals.

### 4.6 Open access: API, tokens and MCP
- **Personal access tokens** (`boh_pat_…`): created by a user for one org, inheriting that user's permissions there, hashed at rest, with expiry and revocation.
- **MCP server** at `/mcp` (Streamable HTTP, stateless) exposes BOH's actions as tools: search items, item details, suppliers, recent price changes, ingredient matching, the agent inbox, approving and rejecting tasks.
  - The same permissions apply.
  - This lets a customer's own AI assistant work with BOH, and lets BOH agents be offered inside other agent platforms.
- **Public REST API** with OpenAPI (existing).

### 4.7 Channels
- **Phase A:** web inbox.
- **Phase B:** WhatsApp approval cards (approve/reject from WhatsApp), push notifications, and a daily digest.
- Supplier messages from Price Watch are prepared as email/WhatsApp drafts with one-tap send links. Direct sending through the WhatsApp Business Platform comes in Phase B.

---

## 5. Pricing (to validate with design partners)

| Plan part | Price (indicative) | Notes |
|---|---|---|
| Platform | SAR 400 / org / month | Catalogue, suppliers, members, inbox, API and MCP access, unlimited users |
| Agent per site | SAR 150–450 / agent / site / month | Price Watch at the low end; Purchasing and Invoice at the high end |
| Usage beyond allowance | Per job (e.g. SAR 1 per invoice processed beyond 300/month) | Covers AI cost; tracked by agent runs |
| Optional performance plan | 15–20% of measured savings | Price Watch and Invoice savings are directly measurable |

**Principles:**
- No charge for API or MCP access; agents are the product.
- The Price Watch agent is free for the first 60 days to prove value.
- Unit economics are tracked from day one: AI cost per job and per site, versus price.

---

## 6. Day-one architecture decisions (from v0.3, still binding)

These are cheap now and very expensive to add later.

1. **Suppliers are tenants.** A supplier is an `Organization` of `type=supplier` with its own users, catalogue and documents. A restaurant's "supplier" record is a **relationship** (`TradingRelationship`) between two orgs, with a fallback to an *unclaimed* supplier profile that the supplier can later claim.
2. **Shared ingredient map.** A global, BOH-curated `CanonicalIngredient` taxonomy (multilingual names, density, typical packs, allergens). Every tenant `Item` and every `SupplierItem` gets a `canonical_id` with a confidence score. This mapping is the backbone of benchmarks, onboarding and AI.
3. **Correction capture.** Every place a person fixes the AI (extraction field, item match, voice parse, recipe draft) writes a `Correction` event (input, model output, human output, user, context). This is the training data that keeps improving the AI.
4. **Consent and anonymisation.** Terms allow anonymised, pooled aggregation; per-org opt-out (with reduced benchmark access in return: *give to get*). Aggregates are built in a separate **analytics store**, never by querying tenant data live; k-anonymity is enforced at build time.
5. **Structured document input.** Invoices can arrive as **UBL / PINT AE / ZATCA XML**, PDF/A-3 with embedded XML, PDF, photo, or email. The XML path skips AI entirely.
6. **Append-only ledgers.** One ledger for stock movements and one for **payables** (invoices, credits, payments), so payments and financing plug in later without schema surgery.
7. **Channel-agnostic actions.** All writes go through domain commands. Web, mobile, WhatsApp, voice, API, MCP and **agents** are all callers, with the same permissions and audit trail.
8. **Data residency ready.** Per-region deployment (KSA in-Kingdom first, UAE later). No cross-region joins in the request path; the analytics store receives only anonymised aggregates.

---


## 7. Domain model (core)

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
Agent · AgentTask (proposed → approved → executed) · AgentRun (usage/cost) · Event (append-only) · AccessToken
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


## 8. Core modules (the ground the agents stand on)

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


## 8b. Integrations

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


## 9. Technical architecture

```
apps/
  api/        NestJS: REST/OpenAPI, auth (JWT + access tokens), permissions, domain commands,
              agent task API, MCP endpoint (/mcp)
              worker.ts: agent runtime (Postgres queue, schedules, event cursors)
  web/        Next.js PWA: inbox (home), back office, agent settings
packages/
  db/         schema + migrations (RLS on every tenant table)
  domain/     units, costing, text normalisation, CSV (pure, tested)
infra/        docker-compose (postgres, redis, minio), CI
```

- **Agents live in `apps/api/src/agents/`:** a registry of agent definitions (kind, role permissions, triggers, action types and handlers, default autonomy, guardrails), the runner, and the LLM provider (Claude or templates).
- **Database:** Postgres (decided).
- **Hosting:** in-Kingdom KSA region at launch. Confirm data-residency requirements with counsel.

---

## 10. Roadmap

| Phase | Scope | Status |
|---|---|---|
| 0 Foundation | Monorepo, auth, tenancy/RLS, roles, audit, units engine, CI, web shell | ✅ |
| 1 Catalogue | Shared ingredient map and matching, items, packs, par levels, suppliers, prices, CSV | ✅ |
| A Agent platform | Agent identities, events, runtime, tasks/actions/autonomy/guardrails, usage tracking, inbox, access tokens, MCP server, **Price Watch agent** | ✅ |
| B Channels | **WhatsApp approval cards** ✅ (linking by code, cards routed by permission and site, approve/reject from buttons, value cap, templates outside the 24-hour window, delivery tracking, simulator) and **daily digest** ✅ (per person and org, local hour, permission-scoped, "Show decisions" reopens the window). and **direct supplier messaging** ✅ (orders with Confirm/Problem buttons and a private order link, replies onto the order and the inbox, direct chasers). Still to do: push; supplier email | in progress |
| 2 Procurement + **Purchasing agent** | POs, approvals and spend limits, sending, receiving (GRN), stock ledger with weighted average cost, Purchasing agent (reorder drafts, late-delivery chasing). Built agent-first (core actions and review screens, few hand-entry forms). Requisitions and multi-level approval deferred | ✅ |
| 3 Invoices + **Invoice agent** | Email/e-invoice intake, AI extraction, three-way matching, credit notes, ZATCA | |
| 4 Stock + **Stock agent** | Counts by voice/WhatsApp, waste, transfers, variance | |
| 5 Recipes, POS + **Cost Controller** | Recipes and costing, Foodics integration, theoretical vs actual, weekly report | |
| Onboarding agent | Runs alongside phases 2–3 as document AI matures | |

---

## 11. Metrics
- **Agents:**
  - tasks proposed per site per week
  - **approval rate** (target > 70%)
  - time to decision
  - % of actions running on `auto`
  - corrections per 100 tasks (should fall)
- **Value:**
  - SAR saved or avoided per site per month (Price Watch, Invoice)
  - hours saved
  - time to first value
- **Unit economics:**
  - AI cost per job and per site per month
  - gross margin per agent
- **Moats:**
  - claimed suppliers
  - % of lines matched to the shared map
  - learned aliases confirmed by 2 or more orgs
  - % of invoices arriving as structured e-invoices

---

## 12. Risks
| Risk | How we handle it |
|---|---|
| Customers don't trust agents with money | Default `approve`; raise autonomy gradually; hard guardrails; full audit; kill switch; a person backing the agents with design partners |
| Wrong suggestions erode trust | Evidence on every task; deterministic calculations; replay past corrections before shipping changes; per-agent approval-rate alerts |
| AI cost eats margin | Short structured prompts, low effort, a cheaper model for bulk jobs, cost tracked per run; templates as fallback |
| Model outage or refusal | Template fallback; refusal fallbacks; agents degrade gracefully, they don't stop |
| Prompt injection through supplier content (emails, invoices) | Supplier text is treated as data; agents can only propose typed actions that pass permission and guardrail checks; no free-form tools |
| Two-sided network is hard to start | Agents give a single restaurant value on their own; suppliers get free e-invoicing and order inbox |
| Regulation (PDPL, data residency) | In-Kingdom hosting; data processing agreements; no customer data used to train third-party models |

---

## 13. Open decisions
1. Product name and brand.
2. Pricing validation with 3–5 design partners (agent-per-site vs. performance share).
3. Anthropic data-residency and processing terms for KSA customers. Prompts and outputs that include customer data need a data processing agreement.
4. WhatsApp Business provider for Phase B: built on Meta's Cloud API directly (no BSP). Revisit if we need a BSP for onboarding many sender numbers.
5. ZATCA solution approach (build vs. specialist SDK).
