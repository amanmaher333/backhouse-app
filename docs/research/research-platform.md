# Supy (supy.io): Platform, Analytics and Integrations Teardown

*Public sources only. Researched 2026-11-08. No logins, no gated content.*

**Legend:** **[C]** = concrete, specific detail (numbers, named objects, named mechanics). **[M]** = marketing claim with no method, baseline or spec behind it. **[I]** = my inference.

**Access note:** In this research environment only `supy.io` and web search were reachable. `help.supy.io`, `apps.apple.com`, `apps.xero.com`, `g2.com`, `foodics.helpjuice.com`, `support.eats365pos.com`, `apitracker.io` and `retailer.supy.io` were blocked by the session network policy. Anything about those pages comes from search-engine snippets, not from reading the full page. Re-checking them directly is worthwhile, especially the help center and the Xero App Store listing.

---

## 1. Company snapshot

| Item | Detail | Type |
|---|---|---|
| HQ / origin | UAE (Dubai). Founded Feb 2021 by Dani El-Zein, Ibrahim Bou Ncoula and Yazeed bin Busayyis | C |
| Funding | $1.5M pre-seed (Sep 2021; COTU Ventures, Valia Ventures). $8M seed (Jul 2022; led by BECO Capital, with Global Ventures and AMK). About $9.5M total. No later round found in public press | C |
| Origin story | Started as a restaurant-to-supplier ordering/procurement product (press in 2022 called it a "B2B food marketplace"). Relaunched as a back-of-house "platform" on 10 Jul 2023, after "2,000+ customers" asked for it | C |
| Scale claims | "3,000+" and "3,500+" restaurants (both figures appear), "30+ countries" | M |
| Named customers | Tashas (49 sites), MAMA'ESH (22), Shaka Cafes (10), Namo (8), Ringland Group, Food Quest (Al Baik UAE, Denny's ME, TATEL, TOTÓ), Joe & the Juice, Cold Stone, St Ali, Thredbo, etc. | C |
| Markets | GCC (UAE, KSA) first, then Australia (en-AU site, AU POS partners such as Redcat, Oolio, Ideal POS, Tanda, MYOB), UK/EU (Tevalis, Squirrel, Wenodo; "EU e-invoicing" mention), Asia (Xilnex, AutoCount, Eats365) | C/I |
| Hiring | Careers page: "No open positions". Remote-friendly, "global team", recruitment@supy.io. No public job posts found, so no job-ad tech-stack evidence | C |

---

## 2. Product map (as shown in site navigation)

- **Procurement:** AI predictive ordering, orders and requisitions, supplier management, central kitchen operations, Supy Connect (B2B ordering app), permissions and limits, AI invoices and credit notes, AI invoice receiving.
- **Inventory:** ingredient and allergen management, live stock visibility, recipes and prep, wastage recording, stock counting, inventory transfers.
- **Business intelligence:** AI sales forecasting, interactive dashboards, spreadsheet reports, Open API, Delta Sharing, audit logs, "Anomaly detection AI (coming soon)".
- **Integrations hub:** about 75 partner pages under `/integrations/{slug}`. Marketing copy says "75+" integrations; the pricing page says "50+ live POS".

---

## 3. BI dashboards and reports

### 3.1 Interactive dashboards ([C] names, [M] for "real-time")
From `/product-features/dashboards`:
1. Real-time performance: costs, margins and wastage without waiting for month-end.
2. Location comparisons: best and worst sites.
3. Root-cause analysis: drill into category, then dish, then ingredient.
4. COGS and food-cost dashboards: COGS and food cost % at group, site or menu-category level, with flags on sudden cost spikes.
5. Variance and wastage insights: theoretical vs actual usage; wastage by type, site and item.
6. Usage and stock-movement analytics: slow movers by site or category, trends.
7. Profitability by site and category: dish-level margins, with filters for period, brand and region.
8. Drill-down navigation, plus export of filtered views to spreadsheets.

The pricing page names these dashboards: **menu engineering**, **theoretical vs actual COGS**, **wastage and transfers**. The R365 comparison page claims "free customisable dashboards" [M].

### 3.2 Spreadsheet reports ([C] categories; exports are Excel/CSV)
From `/product-features/reports` and the pricing page:
- **Procurement:** purchase value, orders, invoices, supplier performance, **item price changes / price-change analysis**, supplier comparison, **supplier Statements of Account**.
- **Sales and COGS:** COGS by location, item and category; **menu engineering** report (stars/dogs style); sales vs cost.
- **Inventory:** **stock movement between two counts** (by site or item), variance analysis, **stock value** (real-time).
- **Wastage and production:** waste by item, type, location or event with cost impact; production events with ingredient usage and batch output.
- **Recipe listings** by site or group, costed at the latest purchase price; average recipe cost across the group.
- **Custom enterprise reports** built by Supy (example name: "Ops Pack"). This is a paid add-on.
- Filters: site, supplier, category, date range, item. **No scheduled or emailed reports are mentioned.**

### 3.3 Alerts, audit and anomaly detection
- Real-time stock-level alerts, configurable per user and per role [C, thin].
- Limit breaches (PO value, receiving, price/quantity variance %) create a draft plus an email alert [C].
- **Audit logs:** every action, with before/after values "where applicable"; named user and timestamp; filter by user, branch, action type and date; users cannot edit or delete entries; exportable. Retention period not stated [C]. "Tamper-proof" [M].
- **Anomaly detection AI:** "coming soon". No detail.

### 3.4 Outcome claims (all [M])
"80% variance reduction", "55%" or "50% food cost reduction", "up to 25%" food cost cut, "up to 10 hours/week saved counting", "96%+ invoice scanning accuracy, ~5 seconds per invoice". One named testimonial: food cost 39% to 33%, variance 15% to 9%.

---

## 4. AI sales forecasting and AI predictive ordering

### 4.1 AI sales forecasting ([C], unusually specific)
- **Input:** full POS sales history, pulled automatically each day. Learns weekday/weekend patterns, seasonality and location behaviour. **Weather, holidays and events are not stated as inputs**; they are handled by manual override.
- **Output:** today plus the **next 14 days**, **per branch**, daily totals in local currency, each day expanding to **forecast quantity per menu item**.
- **Mapping:** menu items are matched to POS sales **by name, with no recipe mapping required**.
- **Overrides:** adjust a day by % (+10%) or a flat value (+$500); override individual item quantities (promotions, events). The original forecast stays visible next to the adjusted one. **Overrides do not retrain the model.** A chart shows actual vs AI forecast vs adjusted forecast.
- **Accuracy:** no metric. "Very accurate from day one" and "more accurate in month six than month one" [M]. One third-party page described forecasting and predictive ordering as **beta**.
- **Pricing:** paid add-on.
- Model type is not disclosed. [I] The 14-day daily per-item horizon with name-matched items suggests a per-SKU time-series model (Prophet/LightGBM style), not anything exotic.

### 4.2 AI predictive ordering ([C])
- Order setup: branch, supplier, delivery date and **coverage days**.
- Item-level forecast (the page says 15 days) is exploded through **recipes** into ingredient demand. Current on-hand stock is subtracted and **projected stock at the delivery date** is shown. Only items needed within the coverage window appear. One order is created per supplier.
- For comparison it shows **last order quantity** and **4-week average** per item.
- On-hand stock can be overridden for that order only.
- **Human in the loop:** nothing is sent automatically. Orders go to the supplier by **email, WhatsApp or direct supplier integration**.
- Not described: par/safety stock, supplier lead times or cut-off times, delivery calendars. The MarketMan comparison separately claims "PAR-based ordering suggestions".

---

## 5. Open API

| Aspect | What's public | Type |
|---|---|---|
| Style | "Robust, documented REST API" | M/C |
| Domains | procurement, inventory, production, recipes, wastage, sales, COGS | C |
| Scope | Query at **branch, brand or group** level "with precise filters" | C |
| Write capability | External systems can **create supplier POs and central-kitchen orders for any branch**; received quantities flow back | C |
| Order-line payload | ordered / confirmed / received / returned / remaining qty, unit price, tax, net total, supplier item code, status history (who, when) | C |
| Tax logic | Fallback order: product tax rate, then item tax code, then receiving default; rounded to 2 dp before leaving the API | C |
| Auth | Not documented publicly. FAQ: "credentials cannot cross account boundaries"; **branch-scoped keys** limit an integration to entitled sites [I: API keys scoped to tenant + branch set] | C (partial) |
| Docs / portal | **No public developer portal, reference, sandbox, SDK, webhooks, rate limits or versioning info.** Docs are shared with partners ("technical support and documentation for API use" is a partner benefit). The "Watch overview" link is a dead `#` | C |
| Sync modes | "Real-time sync" or scheduled/batched | M |
| Destinations | push to AWS S3, Azure Data Lake, GCS; consumed in Databricks, Snowflake, BigQuery, Power BI, Tableau, Looker | C (claimed) |
| Pricing | "Open API endpoint access", "BI integration API" and a "Power BI and Tableau plugin" are **paid add-ons** | C |
| Known gap | Search snippet: an integrator building a GL connector found some **supplier fields not exposed** by the API | C (snippet) |

**Internal API convention (from Supy's public GitHub, see §13):** the open-source Dart package `filterator` includes a `SupyConverter` example that serialises an `ApiQuery` into a JSON request body with `filtering` (nested AND/OR groups, three or more levels), `ordering`, `paging` and `selection` (include/exclude fields). An `ODataConverter` sits alongside it. [I] Supy's internal REST list endpoints probably take POST query bodies in this shape, and the public API may reuse it.

---

## 6. Delta Sharing / Databricks

- "Supy streams live operational and financial data into **Databricks** and shares it securely via **Delta Sharing**" [C].
- Recipients can be non-Databricks: "Snowflake, AWS, Python, or Excel" [C]. Cites "40% of shares go to non-Databricks users" (a Databricks stat).
- Data areas: food cost and margin trends, variance by category, CK transfers and yields, procurement price and supplier performance, multi-location benchmarks. **No table list or schema is published.** Refresh is "continuously updated" [M].
- The MarketMan comparison lists "Databricks data warehouse with Delta Share" as a technology advantage.
- [I] Supy runs a Databricks lakehouse internally, probably fed by CDC from its operational DB, and exposes curated gold tables per tenant through Delta Sharing. That warehouse is likely also the source for the dashboards and custom reports.

---

## 7. POS integrations

### 7.1 Partners listed (about 53 POS)
Addictive, AI Menu, Aloha/NCR Voyix, AutoCount, Castle IT (Easy Resto), Clover, Compucash, Dinlr, Dual Link, Eats365, Fascano, Flex Catering, Foodics, Fork POS, Geidea, GoTab, Ideal POS, LINGA, Lightspeed (K, O, X series), Loyverse, LS Retail, Marn, Mobi POS, Ninja, Omega, Oolio, Oracle Micros/Simphony, Papaya, Poster, Prologic/Touché, Qu, Quadranet, Quantic, Redcat, Revel, Roller, Shopify, SNAPOS, Spare, Spice POS, Square, Squirrel, Syspos, Task, Tevalis, Thiqah, TISSL, Toast, Tray, Vita Mojo, Xilnex, Zeoniq, Zid POS. The heavy weighting toward GCC and AU POS systems is a regional moat.

### 7.2 What flows ([C] where stated)
- **POS to Supy (one-way):** sales and **menu items** ("fetch sales and menu items data... across branches", Foodics). Sales deplete inventory through recipes.
- **Modifiers:** recipes link to POS menu items **including modifiers**. The MarketMan comparison claims **"parent-child POS bundle tracking"**, **"modifier return-to-stock"** and **"sales-type recipe linking"** (different recipe per dine-in/delivery/takeaway sales type) [C, claimed].
- **Multi-POS:** multiple POS connections map to different Supy inventories or branches.
- **Integration health:** "live integration health monitoring" [C, claimed].
- **Mechanics:** Eats365 snippet: the merchant grants Supy permission in the **Eats365 Merchant Portal under Developer Portal / Application**, i.e. an OAuth-style app authorisation on the POS side. A Foodics help-center article also exists (blocked here).
- **Frequency:** "real-time" inventory and "near real-time" reporting [M]. The forecasting page says history is pulled daily.
- **Commercial:** "New POS integrations built at no charge before implementation is complete" (pricing page) [C]. POS mapping is listed as joint operator and vendor work in migration.

### 7.3 Aggregators / online
Grubtech, Urban Piper (Talabat, Deliveroo, HungerStation), Shopify. Sales from web and aggregators update stock. Detail is thin.

---

## 8. Accounting and ERP integrations

**Accounting partners:** Xero, QuickBooks, Zoho Books, Wafeq (GCC), MYOB AccountRight (AU), AutoCount (MY), Microsoft Dynamics NAV ("Nivision"), Oracle NetSuite, Wenodo. **ERP:** SAP, Odoo, NetSuite, Dynamics NAV.

### 8.1 What syncs

| Object | Evidence | Type |
|---|---|---|
| Supplier invoices to Xero **draft bills** | Xero App Store listing snippet: "created as draft bills in Xero" | C |
| Purchase invoices to QuickBooks | Integration page ("in clicks") | C (thin) |
| **Journal entries** for stock value, food cost, wastage and transfer value | Xero and QuickBooks pages | C |
| **Credit notes to Xero** | MarketMan comparison claims MarketMan has "No support for credit notes to Xero", which implies Supy does. Supy's own Xero page doesn't say so | C (implied) |
| Supplier returns, CK B2B orders | Multi-entity blog: "purchase invoices, supplier returns, and central kitchen B2B orders post to the correct file" | C |
| GRN posting | "Post GRNs to your accounting system" | C |
| From Xero into Supy | **Chart of accounts**, **contacts** (supplier-to-vendor mapping), **tracking categories** (mapped to Supy branches/cost centers), **tax rates** (optional mapping) | C (snippet) |
| Line granularity | Post as **consolidated per-category lines** or **itemised lines**; mapping by item category, supplier and transaction type to GL and tax code | C |
| Multi-entity | **One Xero org per legal entity**; each location maps to its owning entity; CK production posts to the kitchen entity; warehouses can be their own entity | C |
| Inter-entity transfers | Described as a draft **sales invoice** in the CK org plus a draft **bill** in the store org. Supy's own blog admits these are still **hand-keyed** in the typical setup (a GL-code limitation: one item has one GL code) | C |
| Posting control | **Manual, deliberate post step after GRN confirmation**; missing mapping (supplier, tax code, due date) means the post is **held** with the reason in sync status; re-post after fixing; failed syncs are un-posted and flagged for retry | C |
| Tax quirk | Xero listing: the account code's default tax rate is used; "no option found to override" when creating bills | C (snippet) |

Pricing: "Accounting integration" and "ERP integration" are listed as **add-ons**, yet the plan text says "accounting integration pushes invoices with ingredient-level category mapping". This is inconsistent.

### 8.2 Labour and BI partners
Labour: **Tanda**, **Opsyte** (workforce, payroll and financial reporting combined with Supy data). BI: **Tenzo**, **NDUX**. Industry partners: Squizify, Preshift, Done.fyi, Feedelity, Ops Lab, Tech Pantry, Williams Stanley & Co, Alpha Pro Partners, App It, FoodandBalance. Supy has **no labour scheduling of its own**; it relies on partners.

### 8.3 Partner program
Benefits: API docs and technical support, directory listing, priority listing in category, co-marketing and co-selling, partner success contact. Open to POS, finance, ERP and delivery vendors.

---

## 9. Multi-site, multi-brand and org hierarchy

- Levels named across pages: **group > brand > branch (location)**, plus **multiple inventories per location** (e.g. bar, kitchen, chemicals), **cost centers** ("additional cost centers" is an add-on), **legal entities** (for accounting), **regions** (dashboard filter), **central kitchen / CPU / warehouse** as special locations [C]. Exact nesting is not documented.
- Central repository of items, vendors, recipes and sub-recipes shared across brands and branches [C].
- **"Brand segregation for cloud kitchens"** is a paid add-on [C].
- Single login for multiple branches (contrasted with MarketMan's separate HQ and branch logins) [C, claimed].
- Central kitchen: branches send POs to the CK; HQ can order on behalf of any branch; CK invoices own branches and external clients (Pro Forma, Tax Invoice, Statement of Account); price at cost, cost + markup, or fixed; price lists per customer group; **Supy Connect** app for external B2B buyers [C].
- API queries scoped to branch, brand or group [C].

## 10. Roles, permissions and controls

- **Base roles:** Manager (full), Staff (limited), **Drafter** (drafts orders and receiving; needs Manager approval) [C].
- **"200+ customisable user permissions"** repeated across pages, but not enumerated [M/C].
- **Approval chains:** sequential, **up to 5 levels**, triggered by **requesting branch and order value**; approvers can be individuals or **user groups**; approve from email, mobile or desktop; requisition converts to PO only after final approval [C].
- **Limits:** PO value by supplier, branch, item category, user or par level; receiving limits; price and quantity **variance thresholds in %**; periods of day, week, month or quarter; a breach produces a draft plus an email [C].
- Invoice variances reportedly **cannot be edited after about 4 days** (G2 reviewer complaint), which points to a period/lock policy [C, snippet].
- [I] Authorization engine: Supy publishes a **`cerbos_http_client`** Dart package, which strongly suggests **Cerbos** (policy-as-code ABAC/RBAC) sits behind the "200+ permissions".

## 11. Mobile apps

- **Supy** (iOS App Store id1544652630, seller "Supy Inc. (Apps)", free, Business category, iOS 15.6+). Described as a "Back of House system with an emphasis on inventory management" for large hospitality businesses. About 5.0 rating from a handful of ratings in small storefronts. Android is claimed on the pricing page ("iOS and Android"), but no Play listing surfaced in search [C].
- Mobile capabilities claimed: ordering and requisitions, approvals ("approve with a tap"), receiving, **invoice scanning by camera**, **parallel stock counting** on several devices, wastage, transfers, **phone-number / OTP login**, in-app support chat [C/M].
- **Supy Connect:** separate iOS/Android B2B app. Invited by email, logs in by phone number, sees the live CK catalog and prices, orders, downloads invoice PDFs. **Not white-label** [C].
- Built in **Flutter** [I, strong: public `supy-flutter-packages` monorepo; one package file path shows a developer working in a `supy-projects` folder].

## 12. Languages / RTL

- Marketing site: EN, AR, EN-AU, FR, ZH-CN, DE [C].
- Product: "multi-language support and interface" and "multi-language support for recipes and other system elements" (R365 and Oracle comparisons) [M]. **No list of product UI languages and no explicit RTL statement.** [I] Arabic UI and RTL are very likely given the GCC base, Flutter's native RTL support, and code hits for "rtl"/"arb" (Flutter l10n files) in their public repo, but this is unverified.

## 13. Likely tech stack

| Layer | Evidence | Confidence |
|---|---|---|
| Marketing site | **Webflow** (webflow.*.js, Webflow.push), **HubSpot** forms (hubspotonwebflow), **Google Tag Manager / gtag**, **Cloudflare** (cf-ray, _cfuvid), Lottie/bodymovin | High (observed in HTML) |
| Web app | `retailer.supy.io` (login: `/auth/login/email`). Framework not observable from here. [I] Flutter Web or Angular | Low |
| Mobile | **Flutter / Dart**. Public GitHub org `supy-io`, repo `supy-flutter-packages` with packages `flexi_cart`, `filterator` (API query builder with SupyConverter/OData), `batch_fetcher(_flutter)`, `currency_kit`, `unsaved_changes(_forms)`, `cerbos_http_client`, `unleash_client`, `opentelemetry_dart`; uses `very_good_analysis` and Codecov | High |
| Authorization | **Cerbos** | Medium-high |
| Feature flags | **Unleash** | Medium-high |
| Observability | **OpenTelemetry** | Medium-high |
| Data platform | **Databricks + Delta Sharing**; exports to S3/ADLS/GCS | High (vendor-stated) |
| Backend | Not public. REST, with JSON query bodies (filter groups, paging, selection). [I] Node/TypeScript or .NET; OData converter hints at a .NET heritage but is inconclusive | Low |
| Help center | `help.supy.io/en` (categories: inventory, integration guides, orders incl. CK orders, accounting, best practices / common mistakes). Platform unconfirmed [I: Intercom-style URL] | Medium |
| AI invoice OCR | Not disclosed. "96%+ accuracy, ~5 s" [M] | n/a |

---

## 14. Pricing model

- **One plan**, quote-based, **"Start from $250/month"** (unit unclear; third-party listings say $200 or $250/month). Priced by **number of locations** and payment terms; **unlimited users per location**; "no hidden costs" [C].
- **Included:** procurement (requisitions, POs, approvals, suppliers, invoices and credit notes), inventory (recipes, receiving, counts, wastage, transfers, production, menu engineering), dashboards (menu engineering, theoretical vs actual COGS, wastage and transfers), reports (stock movement, stock value, item price changes, supplier statements), 50+ POS integrations, iOS/Android/web, OTP login, unlimited training, 24/7 support.
- **Paid add-ons (price on request):** AI ordering, AI sales forecasting, AI invoice scanning, additional cost centers, custom reports, ERP integration, accounting integration, dedicated CSM, CK internal and B2B ordering, brand segregation for cloud kitchens, Open API endpoint access, Power BI/Tableau plugin, BI integration API.
- No free trial, no published contract terms. A third-party site says no free tier [C].
- [I] The model is a cheap entry point plus heavy add-on upsell. All the "platform" features (AI, API, BI, CK, accounting) are add-ons.

## 15. Onboarding / implementation

- Claimed timelines vary: "2–4 weeks" (pricing), "about 2 weeks" (Foodics page), "3–7 days" (a blog), "weeks not months" [M, inconsistent].
- "Six-phase" programme (phases not named), role-specific training, ops-experienced team, unlimited training sessions, 24/7 support, "guided onboarding" vs MarketMan's self-serve [M].
- **Migration responsibilities** (from Supy's own blog) [C]: the operator fills items/units, suppliers/pricing and **recipe upload templates** (customer responsibility); POS mapping is joint; users/permissions are set by the operator; opening stock count at go-live; Supy configures **auto-production rules**; training happens in go-live week; a validation gate compares counts migrated vs source. Supplier mapping and GL reconciliation can add **3–6 weeks**.
- Comparison pages show copy-paste errors (the R365 and Nory pages mention "your current Apic Base setup"). This is a sign of templated SEO pages.

## 16. Customer voice

**Praised:** ease of use and simple UI (G2 ranked it "easiest to use" in restaurant BI); inventory and stock-take simplicity; useful reports; responsive support; POS and accounting integrations "work smoothly"; time savings. G2 rating about 4.8/5 from about 75–77 reviews (mid-market heavy); App Store about 5.0 from very few ratings.

**Complaints (sparse but specific):**
- Implementation falls largely on the customer: "you have to do most implementation steps by yourself and good luck getting clear communication".
- **Speed and stability** need improvement.
- Invoice variances can't be edited after about 4 days.
- Support escalates simple questions to trainers (App Store, Dec 2025, 1 star).
- Missing features; data inaccuracy (one mention each); wants stronger AI to reduce human error.
- G2 comparison: some see **Restaurant365 as more robust for complex operations** (R365 has a full GL and accounting, which Supy lacks).
- Overkill and pricey for a single small site; no free tier.

## 17. Takeaways for an original competitor

1. **Supy's weak spots to beat:** no public developer portal (docs only for partners); API, BI and accounting sold as add-ons; inter-entity CK transfers still hand-keyed in Xero; no scheduled report delivery mentioned; forecasting ignores weather and events; anomaly detection not shipped; implementation burden on the customer (recipe templates); speed and stability complaints.
2. **Table stakes they set:** per-item 14-day forecast with overrides that don't retrain; forecast to recipe explosion to per-supplier PO with coverage days; up to 5-level approval chains by branch and value; % variance thresholds; immutable audit log with before/after; draft-bill posting with held-on-missing-mapping semantics; per-entity accounting orgs; modifier and bundle depletion with sales-type recipes; Delta Sharing / warehouse export; Supy Connect-style B2B ordering app for central kitchens; OTP phone login; unlimited users.
3. **Regional moat:** deep GCC POS coverage (Foodics, Marn, Geidea, Zid, Thiqah, Fascano) plus Wafeq; AU coverage (Redcat, Oolio, Ideal, Tanda, MYOB). Any GCC entrant needs Foodics, Arabic/RTL and ZATCA-compliant tax invoices on day one.

---

## Sources

**supy.io (fetched directly)**
- https://supy.io/
- https://supy.io/platform/restaurant-analytics-software
- https://supy.io/product-features/dashboards
- https://supy.io/product-features/reports
- https://supy.io/product-features/ai-sales-forecasting
- https://supy.io/product-features/ai-predictive-ordering
- https://supy.io/product-features/open-api-integrations
- https://supy.io/product-features/delta-sharing
- https://supy.io/product-features/permissions-limits
- https://supy.io/product-features/audit-logs
- https://supy.io/product-features/central-kitchen-operations
- https://supy.io/product-features/invoices-credit-notes
- https://supy.io/product-features/supy-connect
- https://supy.io/integrations
- https://supy.io/integrations/xero
- https://supy.io/integrations/quickbooks
- https://supy.io/integrations/foodics
- https://supy.io/supy-pricing
- https://supy.io/implementation
- https://supy.io/careers
- https://supy.io/sitemap.xml
- https://supy.io/blog/introducing-supy-platform
- https://supy.io/blog/what-is-supy-and-where-does-it-fit-in-a-restaurant-tech-stack
- https://supy.io/blog/learn-restaurant-procurement-api-erp-integration
- https://supy.io/blog/learn-posting-invoices-xero-multiple-entities-restaurant
- https://supy.io/blog/learn-multi-entity-xero-central-kitchen-transfers
- https://supy.io/blog/learn-inventory-data-migration-old-platform
- https://supy.io/blog/food-quest-chooses-supy-one-back-of-house-platform-for-albaik-dennys-toto-and-tatel
- https://supy.io/blog/supy-x-revel-the-partnership-helping-multi-site-businesses-cut-costs
- https://supy.io/platform-comparison/supy-vs-marketman
- https://supy.io/platform-comparison/supy-vs-restaurant365
- https://supy.io/platform-comparison/supy-vs-nory
- https://supy.io/platform-comparison/supy-vs-oracle-simphony

**Third-party (search snippets; direct fetch blocked in this environment unless noted)**
- https://apps.xero.com/us/app/supy-accounting-integration
- https://apps.apple.com/us/app/supy/id1544652630
- https://www.g2.com/products/supy/reviews
- https://www.g2.com/compare/restaurant365-vs-supy
- https://www.g2.com/compare/restroworks-inventory-management-vs-supy
- https://help.supy.io/en
- https://support.eats365pos.com/supy/integrate-supy-with-the-eats365-pos
- https://foodics.helpjuice.com/1669765-supy
- https://www.foodics.com/portfolio/supy/
- https://restaurantinventorymanagementsoftware.com/solutions/supy
- https://sourceforge.net/software/product/Supy/
- https://www.thenationalnews.com/business/start-ups/2022/07/06/uae-tech-start-up-supy-raises-8m-amid-expansion-push
- https://www.wamda.com/2021/09/supy-raises-15-million-pre-seed-round
- https://www.wamda.com/2022/07/supy-raises-8-million-seed-round
- https://app.dealroom.co/companies/supy
- https://github.com/supy-io/supy-flutter-packages (public repo; inspected via GitHub code search)
