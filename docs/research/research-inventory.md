# Supy (supy.io): Inventory and Costing Functional Teardown

Research date: 2026-11-08. Public sources only: supy.io feature pages, solution pages, platform-comparison pages, the supy.io blog, and search-engine snippets of the help center and G2. No logins.

**Reliability legend** (used throughout)
- **[C] Concrete:** a specific mechanic, field, state, toggle or limit stated on a Supy page.
- **[M] Marketing:** a generic or outcome claim with no mechanism given.
- **[B] Blog-only:** stated as a Supy behaviour, but only in a long-form SEO "learn-*" blog post. These are usually more detailed than the feature pages, and some look like they were written from internal or help-center knowledge. They are still vendor content.
- **[I] Inferred:** my own data-model inference, not stated by Supy.

**Access limits during research.** The following hosts could not be reached from this environment, so their content comes only from search-engine snippets:
- help.supy.io (the public Intercom help center)
- intercom.help/supy-inc (release notes)
- g2.com
- restoke.ai
- foodics.helpjuice.com

Help-center article titles seen in search results:
- "How to create items" (/en/articles/11122512)
- "Creating duplicate items for the same ingredient / different base item names" (/11643141)
- "Mastering stock counts" (/11122725)
- "How to build recipes" (/8600509)
- the "Recipes" collection (/collections/7067301), which covers building recipes, **modifier recipes**, and **scheduling**

Fetching those articles directly would sharpen several sections. Allowlist help.supy.io to do that.

---

## 0. Platform shape and cross-cutting concepts

- **Modules [C]:** Supy describes "six interconnected modules": Procurement, Inventory, Business Intelligence, Integrations, Central Kitchen, and Supy Connect (B2B customer ordering). It has no POS and no accounting module of its own and relies on 75+ integrations (POS, accounting, ERP, aggregators).
- **Tenant hierarchy [C/B]:** Retailer (group) > Brand > Branch/Location > Inventory/Cost centre > Storage location.
  - "Separate inventories within a single location (bar, kitchen, chemicals)" [C, platform intro blog].
  - Bar and kitchen run "as separate cost centers with their own recipes, reports, and P&Ls" with consolidated reporting [C, bars page].
  - Outlets can be grouped into "regions" [B].
- **Clients [C]:** a web app (retailer.supy.io) and iOS/Android apps. The mobile app covers counts, wastage, POs, requisition approval and transfers. The Supy Connect app is a separate app for external B2B customers.
- **Roles [C]:**
  - FAQ roles: **Manager** (full rights), **Staff** (limited), **Drafter** ("can only draft orders and receiving, and need the approval of a Manager"). Roles apply "across all Supy products; from procurement to inventory."
  - "200+ customisable user permissions."
  - A blog post names default roles "Branch Manager", "Purchasing Clerk", "Inventory Auditor", "Accountant" [B].
  - Recurring pattern: a lower role **drafts** (orders, receiving, waste logs, requisitions) and a manager **submits/approves** [C/B].
- **Approvals and limits [C], from the permissions page:**
  - Up to 5 sequential approvers. Approvers can be individuals or user groups.
  - Approval is triggered by requesting branch and order value. Approvers can approve from email.
  - Limits can be set by supplier, branch, item category, user, or par level, over a period of day, week, month or quarter.
  - Price and quantity variance thresholds are set in %.
  - A breach creates a draft and sends an email alert.
- **Alerts [M/C]:** "real-time alerts set by user and by user role."
- **Regulatory and other [C]:** allergens are aligned to UK FSA, US FDA, and SFDA (Saudi). Multi-currency POs and invoices. Multi-language recipes. Bulk CSV/Excel import "with mapping and validation."

---

## 1. Item / ingredient master data

### What it does
- One master record per ingredient, called a **Base Item**. Supplier-specific SKUs and pack formats hang beneath it as **Package Items** (also called "packaging" or "supplier items").
- Changes sync live to all outlets.
- Recipes, counts, orders and reports all point at the base item, so the base item is the unit of stock and cost tracking.

### Concrete details
- [C] "Create one Base Item per ingredient (e.g. Mayonnaise). Link every supplier-specific SKU and packaging format to the same base item. Compare supplier prices or switch vendors from the base item."
- [C, help snippet] "A base item serves as the 'master item'; multiple package items can be created under a base item." Fields seen:
  - **Base Item Name (En) [mandatory]**, which implies multilingual name fields (an Arabic name, etc.)
  - **Item code**, which defaults to a system-generated value
  - **Category**
- [C, help snippet] Duplicate warning: "Each Inventory Item is unique and tracking happens per base item". Duplicates cause stock counts and COGS to disagree.
- [C] "Multiple packaging types per item with custom unit conversions." "Assign barcodes per pack for mobile scanning during counts."
- [B] "Each item has a default counting unit, with optional secondary units for counting convenience." Pack sizes and units are defined per item.
- [B] "Assign a unique storage location to every item you create." Stock is viewable "by location, category, and storage unit" [C].
- [B] Inventory categories map to **accounting categories** (GL accounts) in settings.
- [C] Multiple suppliers per item, with "supplier-specific names and codes."
- [C] Changes to item name, UOM, or allergen tag sync to all locations, and connected reports, menus and counts update to match.
- [C] Audit log on edits: "Track all edits with user, timestamp, and reason. Restore previous versions." This is the only page that mentions a reason field and version restore.
- [B] Archive is used for discontinued items.
- [B, costing blog] A per-item **costing method** is set on the base item: **Purchase Order** (rolling weighted average from POs/receipts) or **Fixed** (a manually set cost per unit). "This is not one global switch."
- [B] Generic advice: one base item per distinct usage, and no more than 7-8 parent categories (advice, not a system limit).

### Inferred data model [I]
- `BaseItem`
  - Fields: id, retailer_id, code (auto), name{locale}, category_id, base_uom (g / ml / each), default_count_uom, storage_location_ids[], costing_method {PO_WAVG | FIXED}, fixed_cost, allergen_ids[], par/min per location (see section 7), accounting_category_id, archived_at, stockable flag
  - Also: item type (raw / semi-finished / recipe-as-item)
- `PackageItem` (packaging): base_item_id, name, supplier_id?, supplier_item_name/code, pack_qty, pack_uom, conversion_to_base, barcode(s), is_countable, is_orderable
  - Possibly nested packaging (case > pack > unit). The phrase "custom unit conversions" suggests a conversion chain.
- `Category` (hierarchical) mapped to `AccountingCategory`
- `StorageLocation` per location/inventory
- `ItemVersion` / audit record holding user, timestamp, reason, and a diff

---

## 2. Ingredient and allergen management

- [C] Allergens are tagged at ingredient (base item) level and "carry automatically into any recipe that uses the item." The comparison page says "Auto-mapped from ingredients to every recipe."
- [C] Aligned to UK FSA, US FDA, and SFDA allergen lists. The exact allergen list is not published. UK FSA has 14 allergens; the FDA has 9.
- [C] The where-used view shows every recipe using a base item.
- [C] **Bulk replace:** "Replace ingredients across recipes in bulk, without editing each recipe separately." "Backdate changes to keep historical costing correct."
- [B] Limitation: one blog case study says a central-kitchen certification needed "allergen and batch-traceability depth" that the vendor's CK module lacked. The vendor is unnamed and possibly Supy.
- Data model [I]: `Allergen` (code, regulatory_scheme), `BaseItemAllergen`, and a recipe allergen set derived recursively through sub-recipes. There may also be "may contain" flags, which Supy does not state.

---

## 3. Recipes, sub-recipes / prep, batch production, variants

### Recipe types [C/B]
- **Plated dish (finished)** "links to its point-of-sale item, so a sale deducts ingredients, including modifiers."
- **Semi-finished / prep, stockable** (sauces, dough, marinades, stocks, par-cooked bases): becomes a "tracked inventory item."
  - Its "production [is restricted] to the locations you have enabled."
  - Production adds it to stock; consumption depletes it.
- **Non-stockable**: "a build that is costed but not held". Its cost is applied at recipe rate and no production variance is captured.
- **Revenue-only recipe** [B]: for modifiers that change no ingredients, "so the sale is tracked without touching stock."
- **Breakdown recipes** [B]: one raw ingredient splits into components, with "each component carry[ing] its share of the raw cost by yield" (e.g. butchery).
- **Modifier recipes**: a help-center collection topic [snippet].

### Recipe fields and behaviour
- [C] Lines reference base items or sub-recipes. "Sub-recipe costing cascades through all parent dishes" [B].
- [C] "Cooking yields, shrinkage, and prep wastage are factored in." Recipes store "yield percentages, portion weights, and prep wastage allowances" [B]. "Prep wastage accounted for on every ingredient" (so it is a per-line wastage %) [B].
- [B] Inventory reflects net usable quantity after trim. An "actual yield" can override expected yield on a production.
- [C, help snippet] "How to build recipes" starts by creating a **base packaging for the recipe**, with name, quantity, and storage location. This means a stockable recipe gets its own packaging and UOM like a base item, and recipes are modelled as items.
- [C] Recipes are assigned to specific **brands, menus, or sites** (visibility scoping). They can be viewed on mobile and printed or downloaded "with formatting intact." Multi-language recipes are supported [C].
- [C] Target recipe cost per recipe, with an alert when it goes over threshold or "when margins are at risk."
- [C] **Recipe cost simulator**: "Simulate food cost % based on any selling price."
- [C] **Backdating and scheduling**: "Apply recipe changes to past or future dates"; "Past & future food costs recalculate automatically."
  - [B] "Historical inventory transactions are automatically reprocessed" when an ingredient, portion, or cost centre changes.
  - [B] Corrections reach back only to the last stock count or **period lock**. This implies a period-lock concept.
- [C/B] Bulk tools: bulk ingredient replace, "batch yield updates apply across the full library in a single action," and bulk price import. Example caption: "47 repriced ingredients updating 312 recipes."
- [B] Recipe library sorted by food cost %, showing live cost per portion and flagging high-cost items.
- [M] "Recipe engineering ... granular portioning, accurate depletion models."

### Batch production [C/B]
- "For batch or prep recipes, track exact quantities produced; ingredients deducted automatically."
- "Logging a production batch then deducts the raw ingredients from live stock" and adds the component to stock at the producing location.
- Batch cost is "spread across the actual yield, grossed up for prep wastage" and carried into parent recipes.
- Reports show "production events showing ingredient usage and batch outputs" [C reports page].
- **No lot or expiry tracking** [B, explicit]: "Supy ... does not track discrete batches or expiry dates" and "has no built-in way to tell staff which physical lot to issue first." The blog says Supy confirmed this "directly on operator calls."

### Variants
- Not a named feature. The closest mechanisms are:
  - Recipe scoping per brand, menu or site
  - **Sales-type recipe linking**: "Separate food cost per dine-in, delivery, etc." [C, comparison page]
  - **Parent-child POS bundle tracking**: "Cost meal combos at the bundle level, including modifiers" [C]
  - Per-location recipe cost from location-specific prices [B]
- Bars page says "multiple price lists" (homepage teaser). This likely refers to selling price lists for central kitchen / B2B.

### Inferred data model [I]
- `Recipe`: id, type {PLATED, SEMI_FINISHED_STOCKABLE, NON_STOCKABLE, REVENUE_ONLY, BREAKDOWN, MODIFIER}, name{locale}, category, yield_qty + uom, base_packaging (for stockable), storage_location, target_cost / target_food_cost%, selling_price(s), brand/menu/site scope, production_enabled_location_ids[], instructions, image
- `RecipeVersion`: effective_from (past or future), lines[], created_by. Versions drive reprocessing of history.
- `RecipeLine`: component_type {BASE_ITEM, RECIPE}, component_id, qty, uom, prep_wastage_pct, yield_pct
- `ProductionEvent`: location, recipe, planned_qty, actual_qty (actual yield), date, user. It generates stock movements: consume ingredients, produce output.
- `PosMenuItem` <-> `Recipe` mapping per sales type and revenue centre, with modifiers as separate mapped entities (see section 4).

---

## 4. Menu items linked to POS (depletion)

- [C] Recipes link to POS menu items **including modifiers** (example: "extra bacon"). "Every sale takes its ingredients out of stock." "Modifier return-to-stock: unused ingredients return to stock automatically." This probably means "no X" modifiers subtract from the parent recipe.
- [C, Foodics help snippet] The setup flow: "sync with POS" pulls the menu, then the user links each POS item to a Supy recipe.
- [B] "Let the integration pull live branch lists, sales types and codes from the POS on setup."
- [B] Several **revenue centres** in one branch can map to one inventory location.
- [B] Multiple POS connections on one instance.
- [B] **Unmapped items**: revenue is still recorded but no stock is depleted. The Integrations screen shows incoming sales imports and can filter unmapped items. Archived POS items can be excluded from the mapping surface. You can trigger a manual re-sync and view import history.
- [C] "Live integration health monitoring: Unmapped items & sync issues flagged instantly."
- [B] Limits:
  - "No one-click bulk tool for [modifier mapping] yet, it is item-by-item."
  - "Unmapping applies either to all history or to future sales only; it is not date-range scoped."
  - Corrections reach back only as far as the last stock count or period lock.
  - Depletion "starts flowing the moment a ticket arrives."
- Regional POS systems without a native connector use a scheduled managed import (file).
- Data model [I]: `PosConnection` (provider, branch map, revenue_centre -> location map), `PosItem` (external_id, name, sales_type, archived), `PosModifier`, `PosItemMapping` (pos_item/modifier -> recipe, sales_type, effective scope), `SalesImport` (ticket lines, status mapped / unmapped / part-processed).

---

## 5. Live stock visibility

- [C] Stock "auto-update[s] from goods received and recipe usage". It is integrated with POs, GRNs, production and wastage workflows ("no double entry").
- [C] View by **location, category, and storage unit**. Each item is classed as **over par / under minimum / "just right"**. The stock page has filters "Above Par" and "Below Minimum" [B].
- [C] **Par and minimum levels per item, per site**, with alerts on breach. These feed par-level ordering ("Top every item back up to par in one click").
- [C] "See item price history in one click."
- [C] Transfers are monitored "from request to receipt."
- [C] "Real-time stock values for financial reporting."
- [B] Slow-moving items are reported by site or menu category.
- [M] Rival Restoke (via search snippet) claims Supy "focuses more on periodic counts than live POS-driven depletion." This is a competitor claim and is unverified.
- Data model [I]: `StockLevel` is derived (a running sum of `StockMovement`s since the last count) per location / inventory / base item. `ParSetting` (location, item, par, min). `StockMovement` types: GRN_RECEIPT, SALE_DEPLETION, PRODUCTION_CONSUME, PRODUCTION_OUTPUT, WASTE, TRANSFER_OUT, TRANSFER_IN, COUNT_ADJUST, credit-note / return.

---

## 6. Stock counting

### Workflow and states [C/B]
1. **Schedule or template.** Templates "match your storage layout." You choose the items, order them in shelf sequence, and save and reuse them across sites.
   - [B] Templates can hold items **and prep recipes** and can be cloned across the group.
   - [B] **Count schedules** set a frequency and branch and "trigger each count automatically." A consolidated view shows "Last count / Next scheduled / status" per location. Schedules can be paused, resumed or removed in bulk (example status: "Paused, refurbishment").
2. **Start the count.** Inventory > Stock Count > "Stock Count" button (help snippet).
   - Structure [B]: "one parent count per location per business date, with a locked sub-count beneath it for each section or counter."
   - Options [B]:
     - **"Set uncounted items to zero"** toggle (for full counts only)
     - **"Initial count"** toggle (opening baseline for a new location)
     - **count split across two dates**
3. **Count** on mobile, in packaging units (cases, packs, bottles, kg, g), with automatic conversion to the base unit. Tap entry and barcode scanning are supported [C].
   - **Parallel counting**: different storage areas or item groups go to different staff; results "merge automatically" with attribution kept [C].
   - One item counted in several storage areas aggregates to one figure, while each area is still tracked [B].
   - **Offline** [B]: each entry is written to the device straight away, with no Save button. Entries sync per device on reconnect. If background save keeps failing, it "pauses further background saves" and warns ("fails loud").
4. **Lock sub-counts.** Each sub-count is "locked from mobile as that counter finishes" [B].
5. **Pre-submit check** [B]: a **pending-order check** warns about items on orders not yet received.
6. **Submit.** "Stock counts can be locked on submission" [B]. While the count is processing it shows a **"calculating"** state, and the variance report is locked meanwhile [B].
7. **Variance report** [C]: counted vs system (expected) quantity, with overages, shortages and "unusual discrepancies" highlighted. You can drill into causes (missed delivery, unrecorded waste).
   - "Variance against system is available instantly during the count, not after it" [B].
   - Variance date pickers only allow dates with a posted count [B].
8. **Post-submission correction window** ("short") [B]. The FAQ workaround for duplicate counts is export and re-import.

- **Count types and frequency [C]:** specialised counts for **high-value items** (example: matcha counted daily in grams), by storage area, or for events. Daily, weekly and end-of-month cadences. Blog advice: weekly partial counts of high-value or fast-moving items and a monthly full count.
- **Expected quantity [B]:** "Every stock count in Supy runs against a calculated expected quantity built from opening stock, purchase orders received, and theoretical usage from your recipe and sales data." Variance is "expressed as a percentage of weekly food spend by category" and segmented by location, category and ingredient.
- **Moving-average note [B]:** Supy's blog warns of a "moving-average trap" (cost resetting on items that stop being counted). This hints that count / receipt events interact with average cost.
- **Data model [I]:**
  - `CountSchedule` (location, frequency, template, status ACTIVE / PAUSED)
  - `CountTemplate` (items / recipes ordered, storage area groups, scope)
  - `StockCount` (location, inventory, business_date(s), type FULL / PARTIAL / INITIAL, options {zero_uncounted}, status DRAFT / IN_PROGRESS / CALCULATING / SUBMITTED / LOCKED, submitted_by/at)
  - `SubCount` (count_id, assignee, storage area, status OPEN / LOCKED, device)
  - `CountLine` (sub_count, item, package_item, qty_in_pack_uom, base_qty, counted_by, timestamp)
  - `CountVarianceLine` (expected_qty, counted_qty, variance_qty, variance_value)

---

## 7. Par levels and ordering hooks (inventory side)

- [C] Par and min per item per site. "PAR-level suggestions based on usage, demand, and stock." Order templates per supplier and location. PO limits can key off par level (for example, ordering 200% of par triggers a block or an approval request) [B].
- [C] AI predictive ordering and AI sales forecasting exist on the procurement and BI side.
- [C] Free "par level calculator" tool (usage, delivery days, lead times). This is a free tool, not the core platform.

---

## 8. Wastage recording

- **What [C]:** log waste per item with quantity and reason, "in seconds," on mobile or desktop. It "automatically deducts from stock on hand." Cost impact is shown by branch, period, category, item, type, location or event.
- **Reasons and types [C]:**
  - Built-in: **spoilage, overproduction, mistakes / prep errors, other**
  - Custom types: "staff meals, expired items, orders sent back"
  - Blog lists "expired, damaged, prep waste" [B]
  - Loaded comparison page: "Record wastage by type, reason, and location", which suggests **type and reason are separate fields** [C]
- **Item vs recipe waste [B]:** "Supy records wastage cost for both individual items and full recipes" (so you can waste a prepared dish or batch).
- **Workflow and states [B]:** "A dedicated page displays drafted and submitted events." Staff draft and managers review and submit. Lower roles can draft "a waste log."
- **Variance link [B]:** recorded waste feeds the variance calculation, so explained loss is separated from unexplained shrinkage.
- **Not stated:** photo attachment, per-reason approval rules, a waste-entry UOM rule beyond packaging units.
- **Data model [I]:** `WasteEvent` (location, inventory, date, status DRAFT / SUBMITTED, created_by, submitted_by), `WasteLine` (item_or_recipe, package/uom, qty, base_qty, reason_id, type_id, unit_cost_snapshot, value), `WasteReason` / `WasteType` (system + custom).

---

## 9. Inventory transfers between branches

- **Workflow [C]:**
  1. **Request**: multi-SKU, raised by a branch.
  2. **Approval / sign-off**: "Nothing moves without sign-off from both sides." Approval from mobile or desktop.
  3. **Dispatch**: logged in the audit trail. No separate UI step is described.
  4. **In transit**: expected arrival dates are monitored.
  5. **Received / accepted**: the receiver may accept partially or reject (quantity mismatch, poor condition).
- **States [C]:** pending, in transit, received.
- **Stock update [C/B]:**
  - Stock updates at both ends only on the receiver's confirmation: "the destination has to confirm receipt before stock updates at either end" [B].
  - "Any quantity discrepancy between dispatched and received is flagged for investigation" [B].
  - Transfers appear in variance reports, usage tracking and live stock.
- **Audit [C]:** who requested, approved, dispatched and received, with timestamps.
- **Transfer costing:** not stated. Central kitchen pricing is "Sell at cost, with markup, or fixed price," with price lists per customer group, pro forma and tax invoices, and statements of account. These apply to internal branches as well as external clients [C, central kitchen page].
  - Central kitchen transfers are described as "an internal movement between legal entities or cost centres" [B].
  - Generic blog advice says to exclude inter-site transfers from COGS.
- **Data model [I]:** `Transfer` (from_location, to_location, status DRAFT / PENDING / APPROVED / IN_TRANSIT / RECEIVED / PARTIALLY_RECEIVED / REJECTED, expected_date, requested_by, approved_by, dispatched_by, received_by), `TransferLine` (item, package, qty_requested, qty_dispatched, qty_received, unit_cost, reject_reason). Central kitchen flow: `InternalOrder` -> `DeliveryNote` -> `Invoice`, using a `PriceList` (cost / markup% / fixed).

---

## 10. Multi-brand, cost centre, and multi-inventory

- [C] "Separate inventories within a single location (bar, kitchen, chemicals)." Bar and kitchen run as separate cost centres "with their own recipes, reports, and P&Ls," with consolidated reporting.
- [C] Cloud kitchens: "shared ingredient management across multiple brands while tracking consumption, costing." "Create separate recipes for each brand" with independent cost tracking. Dashboards show "COGS, variance, wastage, and profitability by brand, kitchen, or dish."
- [B] Commissary: receive purchases against a facility, record production runs per brand, and produce a per-concept cost-to-serve report.
- Allocation of shared ingredient usage across brands is not explained. The likely mechanism is that brand-mapped POS sales drive the depletion, so allocation equals theoretical usage per brand [I].
- Data model [I]: `Location` 1..n `Inventory` (cost centre), with each movement carrying inventory_id. `Brand` is linked to recipes, menus and POS revenue centres. Reporting dimensions: retailer / region / location / inventory / brand / category / item.

---

## 11. Audit logs

- [C] "Every action, tracked and timestamped." Coverage includes PO creation and approval, wastage entries, recipe edits, stock counts and transfers, "and more."
- [C] Fields: user, timestamp, action, and **before/after values "where applicable"**. Item edits also record a **reason** and allow **version restore** (ingredient page).
- [C] Filters: user, branch, action type, date range. Export is available for audits (format not stated).
- [C] "Logs cannot be edited or deleted by users." Approvals, edits and overrides are logged.
- [C] Full stock-movement audit trail: "Every purchase, transfer, and adjustment logged."
- Not stated: retention, IP or device, which roles can view.
- Data model [I]: `AuditEvent` (id, retailer, location, user, entity_type, entity_id, action, before_json, after_json, reason, ts). It is append-only and stored separately from transactional tables.

---

## 12. Anomaly detection

- [C] Listed as **"Anomaly detection AI (coming soon)"**. The feature page has no substantive content. Treat it as unshipped as of this research.
- Adjacent shipped behaviour:
  - [B] "The system flags unusual count movements" before they reach the P&L.
  - [C] "Unusual discrepancies" are highlighted in count variance.
  - [C] Integration health flags.
  - [C] AI invoice checks detect "price, quantity, unit, and pack-size discrepancies." Vendor claim: "over 80% of overcharges caught by AI were completely missed manually."
  - [B] Generic blog advice treats values off by a factor of hundreds as UOM errors.

---

## 13. Costing method

- **Weighted average is the default and core method [B, explicit].** "Supy costs every purchase on a weighted average." Worked example: purchases at $6.80, $7.20 and $7.60/kg blend to "about $7.14 per kg."
- **Per-item costing method [B]:** **Purchase Order** ("prices the ingredient from your actual purchase orders on a rolling weighted-average") or **Fixed** (a manual cost per unit). The choice is per base item.
- **Recipe cost basis [C/B]:** recipes page says cost can be based on "last purchase price, average purchase price, or supplier-specific pricing." Recipe listings are "costed from the latest purchase prices" and there are "average recipe costs across the group or for selected locations" [C reports page]. Supy "calculates recipe cost per location and per date, using average or last purchase cost" [B].
  - So inventory valuation uses weighted average, while recipe cost views can switch between average and last price, and supplier-specific pricing is possible.
- **No FIFO or lot costing.** There is no batch or expiry tracking (see section 3).
- **Price source:** GRNs "capture the real received quantity and price against each order" and feed live stock and variance. AI-processed invoices update cost. "Recipe costs update dynamically as new invoices are processed."
- [C] Supy says it "can be customised to your costing methods."
- **Roadmap [B]:** scheduled future supplier prices, with a margin-impact preview before they take effect, are "on the roadmap rather than shipped today."
- Data model [I]: `ItemCostLedger` per location and item (date, qty_in, unit_cost, running_wavg). `LastPurchasePrice` per item / location / supplier. Recipe cost is computed for a (location, date, basis) and stored as `RecipeCostSnapshot` for history.

---

## 14. Live recipe cost and recipe cost history

- [C] "Live recipe cost visibility"; "Live cost per dish and sub-recipe."
- [B] "Supy keeps this history per recipe, showing how the total cost has moved," "attributing each shift to the ingredient behind it."
- [C] Target cost thresholds and margin alerts per recipe. The simulator shows food cost % at any selling price.
- [C] Menu engineering reports ("which dishes earn profit and which underperform"). Dish-level margins.

---

## 15. COGS and theoretical vs actual

- [C] "Real-time COGS, daily, per site" (spreadsheets comparison page). COGS dashboards by group, site and menu category, and by location, item and category in reports.
- [B] "A live view of COGS that reconciles theoretical cost from recipes against actual cost from invoices and stocktakes." "Stocktake data feeds directly into the COGS calculation."
- **Theoretical [B]:** POS sales x mapped recipe (yield-adjusted, with modifiers), using current recipe costs.
- **Actual [B]:** derived from stock movements and counts. The exact formula is not published. Blog defines variance = actual food cost % minus theoretical food cost %. The generic formula opening + purchases - closing is explained but not stated as Supy's formula.
- **Variance outputs:**
  - [C] "Stock movement between two counts, by site or item"
  - [C] "Variance analysis to identify shrinkage, errors, or waste"
  - [B] Variance "by type: spoilage, over-portioning, theft" by site and item
  - [B] Drill-down: group > site > menu category > item
  - [C] Weekly automated reports (COGS %, sales, theoretical vs actual per venue), configurable by enterprise customers as custom templates (e.g. "Ops Pack")
- [B] Benchmark Supy cites: variance under 2% of theoretical for well-run groups.
- Customer claims [M]: Shaka Cafes food cost 39% -> 33% and variance 15% -> 9%; Tashas variance 1,000-1,500 L/month -> 500 L; "80% variance reduction"; "55% / 50% / 25% food cost reduction."

---

## 16. Price change tracking and supplier price alerts

- [C] "See item price history in one click." Reports track "price changes over time and compare suppliers, showing which suppliers raised prices and by how much." The FAQ says Supy "showcases the price fluctuations per ingredient."
- [C] "Supplier price alerts" is listed on the fine dining page. Bars page: "Price changes, shortages, and overcharges are flagged automatically."
- **Mechanism [C/B]:**
  - Permissions include **price and quantity variance thresholds in %**.
  - On receiving or invoice processing, if the invoice price exceeds the PO or expected price beyond the threshold, the line is flagged the same day, before posting to accounts.
  - **Received Items page** [B]: one row per received item, "filtered to price discrepancies by default." Actions: **update expected price**, **email supplier**, or **open GRN to raise a credit note**.
  - Accepted changes are written to price history and "cascade ... into recipe costs and food cost reporting across every location" [B].
  - Supy reconciles invoices "against contracted rates automatically" [B].
- [B] Limitation: order integration with suppliers is one-way. Pricing is derived from invoice data after the fact rather than from a live two-way catalogue.
- Data model [I]: `SupplierItemPrice` (supplier, package_item, location?, contracted_price, valid_from), `ExpectedPrice` on the PO line, `ReceivedLine` (received_price, price_variance_pct, flag_status OPEN / ACCEPTED / CREDIT_REQUESTED), `PriceHistory` (item, supplier, location, price, date, source_doc).

---

## 17. Reports and dashboards (inventory and costing related)

- **Dashboards [C]:** "COGS & food cost", "Variance & wastage insights", "Usage & stock movement analytics" (with slow movers), "Profitability by site & category", drill-down and export.
- **Reports [C]:**
  - Procurement: price changes, supplier comparison, statements of account
  - Sales & COGS: by location, item and category; menu engineering
  - Inventory & stock movement between two counts; variance; real-time stock value
  - Wastage & production
  - Recipe listings by site or group (latest price and average cost)
  - Custom enterprise templates
  - Export to Excel or CSV
  - Shared filter: "site, supplier, category, date range, or item"
- **Data out [C]:** Open API, Delta Sharing (Databricks) to a data lake or BI tool.

---

## 18. Reviews and third-party signals

- G2: about 4.8/5 from about 77 reviews (snippets). Waste tracking and food costing feature scores are about 9.8. Pros: ease of use, real-time data, inventory management. Cons are sparse: "speed and stability," 1x data inaccuracy, 1x missing features, a wish for more AI.
- Directory listing: "stock counting, receiving, transfers & wastage tracking"; unlimited users; iOS and Android.
- Competitor (Restoke) landing page claims Supy is strong on counts but weaker on live POS depletion. Seen via snippet only and unverified.
- Could not retrieve App Store or Google Play listings for the operator app via search. Only Supy Connect is referenced as a store app.

---

## 19. Gaps and unknowns worth validating
- Exact UOM model: whether nested packaging is supported; whether there is a recipe UOM separate from the count UOM.
- Whether negative stock is allowed or blocked.
- How voids, refunds and comps from POS affect depletion.
- The actual-usage formula, and whether transfers and production are in or out of COGS.
- Transfer valuation (cost at sender's weighted average?).
- Period lock and closing mechanics: referenced, never described.
- Full allergen list and "may contain" handling.
- Whether wastage needs approval beyond the draft/submit split.
- Anomaly detection: unshipped.
- Lot, expiry and FIFO: explicitly absent, which is a differentiation opportunity.

---

## Sources

Supy feature, platform and solution pages
- https://supy.io/
- https://supy.io/platform/restaurant-inventory-management-software
- https://supy.io/product-features/ingredient-allergen-management
- https://supy.io/product-features/live-stock-visibility
- https://supy.io/product-features/recipes-prep-recipes
- https://supy.io/product-features/stock-counting
- https://supy.io/product-features/wastage-recording
- https://supy.io/product-features/inventory-transfers
- https://supy.io/product-features/audit-logs
- https://supy.io/product-features/anomaly-detection-ai-coming-soon
- https://supy.io/product-features/central-kitchen-operations
- https://supy.io/product-features/permissions-limits
- https://supy.io/product-features/reports
- https://supy.io/product-features/dashboards
- https://supy.io/solutions/restaurant-types/bars-pubs
- https://supy.io/solutions/restaurant-types/cloud-kitchens
- https://supy.io/solutions/restaurant-types/fine-dining

Platform comparison pages
- https://supy.io/platform-comparison/supy-vs-marketman
- https://supy.io/platform-comparison/supy-vs-apic-base
- https://supy.io/platform-comparison/supy-vs-restoke
- https://supy.io/platform-comparison/supy-vs-nory
- https://supy.io/platform-comparison/supy-vs-spreadsheets
- https://supy.io/platform-comparison/supy-vs-restaurant365
- https://supy.io/platform-comparison/supy-vs-loaded-reports

Supy blog
- https://supy.io/blog/introducing-supy-platform
- https://supy.io/blog/how-to-manage-items-list-in-restaurant-inventory-software
- https://supy.io/blog/learn-restaurant-stock-count-software
- https://supy.io/blog/learn-restaurant-stock-count-offline
- https://supy.io/blog/learn-central-kitchen-semi-finished-vs-finished-recipes
- https://supy.io/blog/learn-central-kitchen-expiry-lot-tracking-fifo
- https://supy.io/blog/learn-restaurant-yield-costing
- https://supy.io/blog/learn-restaurant-cost-of-goods-sold
- https://supy.io/blog/learn-theoretical-vs-actual-food-cost-variance
- https://supy.io/blog/learn-track-recipe-cost-changes-over-time
- https://supy.io/blog/learn-supplier-price-management-restaurants
- https://supy.io/blog/learn-restaurant-inventory-variance-analysis
- https://supy.io/blog/learn-restaurant-group-cogs-reporting
- https://supy.io/blog/learn-ingredient-costing-method-live-price-vs-fixed
- https://supy.io/blog/how-ai-detects-supplier-price-spikes-automates-procurement-decisions-in-restaurants
- https://supy.io/blog/restaurant-inventory-settings-cost-control
- https://supy.io/en-au/blog/step-by-step-ai-procurement-food-waste
- https://supy.io/blog/clean-restaurant-data-with-supy-ensuring-accuracy-across-multiple-branches
- https://supy.io/blog/learn-recipe-management-software
- https://supy.io/blog/learn-restaurant-stock-management-software
- https://supy.io/blog/learn-reconcile-pos-sales-inventory-mismatch
- https://supy.io/blog/learn-pos-item-ingredient-mapping-standardization
- https://supy.io/blog/learn-variable-price-supplier-ordering-restaurants (snippet only)
- https://supy.io/blog/learn-restaurant-invoice-scanning-software-multi-location (snippet only)

Seen via search snippets only (host blocked from this environment)
- https://help.supy.io/en/articles/11122512-how-to-create-items
- https://help.supy.io/en/articles/11643141-creating-duplicate-items-for-the-same-ingredient-different-base-item-names
- https://help.supy.io/en/articles/11122725-mastering-stock-counts
- https://help.supy.io/en/articles/8600509-how-to-build-recipes
- https://help.supy.io/en/collections/7067301-recipes
- https://intercom.help/supy-inc/en (release notes)
- https://help.foodics.com/hc/en-us/articles/7487351748764-Supy
- https://www.g2.com/products/supy/reviews
- https://www.g2.com/products/supy/features
- https://www.restoke.ai/lp/supy
- https://restaurantinventorymanagementsoftware.com/solutions/supy
