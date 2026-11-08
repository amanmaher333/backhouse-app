# Supy (supy.io) Procurement: Functional Teardown from Public Sources

Researched on 2026-11-08 from public sources only. I did not log in to anything.

**Evidence labels used throughout**
- **[HC]**: Supy help center (help.supy.io). This is the most concrete source. help.supy.io could not be fetched directly from this sandbox (the host is not on the network allowlist), so HC content comes from search-engine snippets of the articles. Article URLs are listed in the Sources section.
- **[FP]**: supy.io product feature page. These are marketing pages, but they often contain concrete details.
- **[BLOG]**: supy.io "learn-" blog posts. These are SEO pieces but often describe real product behaviour, including screens, field names and examples.
- **[CMP]**: Supy's own competitor comparison pages. These are biased.
- **[MKT]**: a pure marketing claim with no supporting detail.
- **[INF]**: my own inference about the data model.

Sources I could not reach directly: help.supy.io, apps.apple.com and intercom.help (Supy release notes at intercom.help/supy-inc). Allowing these hosts would let someone verify the HC details and app-store text in full.

---

## 0. Product shape and navigation (useful for IA)

- **Portal:** the web "retailer portal" lives at retailer.supy.io. Left-nav modules visible in HC articles:
  - **Procurement:** Requisitions, Supplier Orders / Orders, Place Order
  - **Accounting:** GRNs (with an *Incoming* tab), Receive Without Order, Credit Notes, Supplier Returns, AI Invoice Inbox
  - **Repository:** Suppliers, Items. The Repository is the master-data area.
  - **Settings:** Users, Roles and Policies
  - **Administration:** Permission Policy
- **Mobile apps:**
  - **Supy:** the operator app (iOS and Android). It handles requisitions, ordering, receiving/GRN and invoice scanning; a "+" button creates a Requisition, Order and so on.
  - **Supy Supplier** (App Store id1670674126): described as a free app that "digitizes the process of ordering goods for retailers by centralizing all their existing suppliers onto one app." This is an older supplier-side app.
  - **Supy Connect:** a B2B customer ordering app for customers of central kitchens, CPUs and roasteries. See section 8.
- **Pricing:** one plan "from $250/month", quoted per number of locations and payment terms. **[FP pricing]**
  - Base plan includes: Requisitions & PO, Permissions & approvals, Supplier management, Invoices & credit notes.
  - Paid add-ons: AI Ordering, AI Invoice scanning, Central kitchen internal ordering, Central kitchen B2B ordering, additional cost centers, ERP and accounting integration, brand segregation for cloud kitchens, open API, and AI sales forecasting.
  - **Implication:** AI and central kitchen are modular add-ons.
- **Org hierarchy [INF from HC/FP]:** Account/Group (operator) → Brand (brand segregation add-on; credit notes are "scoped to a single operator account") → Branch/Location → **Cost Center** (also "Inventory/Location"; there can be multiple inventories per location, such as kitchen, bar and equipment). GRNs and invoices are assigned to a cost center. Branches are created by Supy support during onboarding, then mapped to POS branches (Foodics help).
- **Languages:** EN, AR, FR, DE, ZH-CN, EN-AU. Strong GCC/MENA footprint (Foodics, Wafeq, "LPO" terminology, malls, tax invoices).
- **Integrations:** "75+" integrations. Named examples:
  - POS: Foodics, Revel, Micros (Oracle Simphony)
  - Accounting: QuickBooks, Xero, Zoho Books, Wafeq
  - Plus an Open API and Delta Sharing.
- **Supy is not a POS or an accounting system.** It focuses on back of house and posts into accounting systems.

---

## 1. Item master, packaging and units (the foundation of the procurement data model)

**Three-level item model [HC "How to create items"; HC "Incorrect packaging setup"]**

1. **Base Item:** the master ingredient, for example "Chicken Breast". It has a **Base Unit** (kg, L, or piece/unit) in which it is stored and consumed. All packages of a base item share the same base unit.
2. **Package Item (Packaging):** a specific purchasable and storable pack, for example "Chicken Breast 1.5 kg box".
   - Required fields: base unit and quantity-in-package.
   - Optional fields: package name, a "preferred package" flag.
   - Packs can be nested: "Add Packaging" on a base packaging creates a pack of packs, such as case → box → base unit.
   - The help center stresses "create supplier packages based on reality, use fewest possible conversions." Wrong base units or quantities cause inventory mismatches.
3. **Supplier Item:** "the item as sold by the supplier".
   - Linked to **exactly one** package item.
   - Has a **supplier-specific price** and a **supplier item name**, which is what prints on the LPO/PO so the supplier understands what is ordered.
   - Also carries a **supplier item code**, which is used for AI invoice line matching and on EDI files. **[HC AI SOP, BLOG]**
   - One package item can be sold by several suppliers.

**Other item details**
- Each item carries a **preferred supplier** per item, used for requisition routing and consolidation. Cleanup logic keeps a default supplier when a link is removed. **[FP, BLOG]**
- Per-supplier "buying unit, packaging unit and conversion factor" must be defined before automated matching works. **[BLOG PO mgmt]**
- **Tax:** a tax rate is set per item in line with preset **tax categories**, and each supplier has a default tax rate. **[FP]**
- **Inline item creation:** items missing from the catalog can be created inline on the GRN page during receiving. **[BLOG GRN]**
- **Location availability:** before a GRN is saved, Supy checks that every item is available at the receiving location, so items are activated per location. **[BLOG 3-way]**

**Data model sketch [INF]**
- `BaseItem(id, name, category, base_uom, tax_category, allergens…)`
- `PackageItem(id, base_item_id, parent_package_id?, qty_in_parent, qty_in_base_uom, name, is_preferred)`
- `SupplierItem(id, supplier_id, package_item_id, supplier_item_name, supplier_item_code, price, currency, tax_rate, active)`
- `SupplierItemLocationPrice(supplier_item_id, location_id, price)`: location-specific override
- `SupplierItemPriceHistory(supplier_item_id, old_price, new_price, pct_change, effective_at, changed_by, source[GRN|manual|import])`
- `ItemLocation(item_id, location_id/cost_center_id, active, par_level?)`

---

## 2. Suppliers and supplier catalogs / price lists

**What it does:** central supplier records with per-branch configuration of ordering channel, contacts, delivery schedule, terms and prices. **[HC "How to add suppliers", "Supplier configuration"; FP supplier-management]**

**Creating a supplier [HC]**
- Path: Portal → Repository → Suppliers (the list of active suppliers) → "Add New Supplier".
- The form has these sections:
  - **Supplier Details:** name and a general description.
  - **Contact Details:** one or more **email addresses** and **WhatsApp numbers** (press Enter to add each). These are what enable order messages.
  - **Preferences**
  - **Active Branches:** which branches can use the supplier.
  - **Supplier Items:** the catalog.
- "Save Details" saves the supplier; "View Details" edits it later.
- Supy recommends creating supplier records even for supermarkets and online purchases, so those spends are tracked.
- Supy manages existing supplier relationships. It is not a marketplace for discovering suppliers.

**Supplier attributes [FP unless noted]**
- **Contacts:** multiple email contacts per supplier, customizable **per branch**.
- **Supplier Customer ID** (the account number per location), included automatically on that location's orders.
- **Ordering channel per supplier per branch:** email, WhatsApp or direct integration. A file/EDI/SFTP feed is mentioned in the blog.
- **Delivery schedule per supplier per branch:** delivery days and **cut-off times**. POs are auto-aligned to the supplier's delivery days. Location-specific delivery restrictions are supported (example: mall delivery windows).
- **Commercial terms:** credit terms (payment terms), **minimum order** and **fees** (delivery fees and per-delivery surcharges).
- **Default tax rate** and visibility settings.
- **Custom T&Cs** per supplier or branch. PO terms can be set globally or per branch.
- **"Hide prices on PO"** option.
- **Contracts and compliance documents** attached to the supplier record.
- **Secondary currency** support for international suppliers.
- **AI Incoming Invoice Settings:** sender-email **whitelisting**, found under Repository → Suppliers → Supplier Details. **[HC AI SOP]**

**Price lists / catalogs**
- **Shared supplier channel:** one shared catalog per supplier, with **location-specific price overrides**. **[BLOG bulk price updates]**
- **Bulk price edit in-app**, plus an **export to Excel → edit → re-import** round-trip. Only changed lines are applied and local overrides are preserved.
- **Price change history** per supplier item: old price, new price, % change and date applied. **[BLOG]**
- **Approved price enforcement:** "approved prices enforced on orders; every supplier price change recorded" **[FP procurement]**. Enforcement mechanics are not documented. Most likely staff cannot edit the PO price unless permitted. **[INF]**
- **Downstream effect:** a confirmed price change recalculates recipe costs for every recipe using that ingredient, and dish food-cost alerts fire when the target food cost % is exceeded. **[BLOG, FP]**

**Roles involved:** Group Data Manager or Admin (master data); Branch Manager (branch-specific settings) [INF from role names].

---

## 3. Requisitions (internal request → approval → PO)

**What it does:** branch staff request items; approvers review them; approved lines are consolidated and converted into supplier orders or central kitchen orders. **[HC "Requisitions", "Requisitions on the mobile app"; FP orders-requisitions; BLOG consolidate]**

**Creating a requisition, web [HC]**
- Path: Procurement → Requisitions → "Place Requisition".
- Browse **by category** (dairy, meat and so on) or use search.
- Enter quantities.
- Set the **expected delivery date**, which groups requisitions together.
- Add notes, including notes for the supplier.
- Submit.

**Creating a requisition, mobile [HC]**
- Tap "+" → Requisition → add items → set delivery date → add notes → "Place Requisition".
- Images can be attached. **[FP]**
- Approvers on mobile see requests under Menu → Review Requisitions, marked "Pending".

**Requisition tabs/statuses [HC]**

| Tab / State | Meaning |
|---|---|
| **Pending** | Awaiting review and approval |
| **Approved** | Approved but not yet converted to a supplier order |
| **Processed** | Converted into supplier order(s), either as an editable draft or already sent |
| **Discarded** | Rejected; not processed further |

Inferred additional sub-state from the policy approvals article: "Limit Reached – Awaiting Approval", raised when a policy limit is breached. See section 5.

**Approver actions [HC]**
- Open a request, then modify the delivery date or adjust items or quantities.
- **"Approve"** moves it to the Approved tab for later processing.
- **"Approve and Process"** offers two options:
  - **Draft as supplier order:** creates an editable draft PO.
  - **Submit as supplier order:** sends it to the supplier immediately.
- **Reject**, which sends it to Discarded.
- **Batch process:** a single screen filters pending demand by location, category, status and date, with bulk approve or reject. **[BLOG]**

**Review before POs [FP]**
- Change the supplier on a line inside the requisition.
- **Preview the POs that will be generated.**
- Consolidate across outlets.
- **Reroute to the Central Kitchen** instead of an external supplier.

**Consolidation logic [BLOG consolidate]**
- Approved lines are grouped **by supplier and delivery date**: **one consolidated PO per supplier per delivery date**. Different suppliers are never mixed, and one supplier is not split.
- Bulk conversion. Example: 48 requisition lines from 6 branches become 5 supplier orders.
- A multi-outlet demand matrix shows items as rows, branches as columns and a total (example: "Whole Milk 2L: City Centre 24, Harbour View 18, total 42 units").
- Prerequisites: each item mapped to a preferred supplier, plus branch requisition permissions and thresholds.
- Not documented: lines without a preferred supplier, and conflicting delivery dates.

**Data model [INF]**
- `Requisition(id, branch_id, cost_center_id, requested_by, expected_delivery_date, notes, status[pending|approved|processed|discarded|awaiting_policy_approval], created_at)`
- `RequisitionLine(id, requisition_id, item/package_id, qty, preferred_supplier_id, notes, image)`
- `RequisitionLine → PurchaseOrderLine` link (many-to-one after consolidation)

---

## 4. Purchase orders / supplier orders (LPO)

**Terminology:** "Supplier Orders" (HC), "Purchase Orders", and "LPO" (Local Purchase Order, a GCC term) used for the printed document.

**Ways to create a PO [HC/FP/BLOG]**
1. **Direct "Place Order"** to a supplier: ordering "by supplier". The blog mentions two ordering methods; the second is likely by category or by template. **[INF]**
2. From approved **requisitions** (Approve & Process).
3. From an **order template**. Any order or requisition can be saved as a template with preset items and quantities. Templates can be assigned to multiple locations with automatic item matching and optional default quantities, and loaded on web or mobile. **[FP]**
4. **Order to par level** (FP lists it but gives no detail). The comparison page claims "PAR-level based ordering recommendations", and the G2 demo video title also mentions them.
5. **AI Predictive Ordering** (section 10).
6. **Standing orders:** "use the same schedule logic to send recurring replenishment automatically" **[BLOG sending POs]**. This is the only place automatic sending is mentioned; predictive orders are never auto-sent.

**PO lifecycle / statuses**
- Supy never publishes an explicit PO status enum. Evidence pieced together:
  - **Draft:** created from "Draft as supplier order", or saved as a draft because a policy limit was hit ("Limit Reached – Awaiting Approval"). **[HC]**
  - **Submitted / Sent / Open:** sent to the supplier on the configured channel. **[HC]**
  - **Partially received:** "partially received POs show pending balances"; a PO can have multiple GRNs. **[FP, BLOG]**
  - **Closed:** via "Save & Close Order" on the GRN; can be reopened. "Closing before a GRN exists stops the invoice from attaching." **[HC, BLOG]**
  - The blog explicitly mentions managing "draft POs, open POs, partially received and closed POs". **[BLOG search snippet]**
  - Rejected / Discarded (via approvals). Cancellation is not documented.

**Proposed state machine [INF]:** Draft → (PendingApproval) → Submitted/Open → PartiallyReceived → Closed (with a Reopen path); also Rejected and Cancelled.

**PO content/fields [FP/BLOG/HC]**
- PO number. PO numbers are enforced and required for invoice matching.
- Supplier, branch/cost center, **delivery date**, the location's **supplier customer/account ID**, and supplier comment/notes.
- Lines: supplier item name, **supplier item code**, package/unit, quantity, **unit price** (can be hidden on the sent PO) and tax.
- T&Cs (global, per supplier or per branch).
- A record of every send: supplier, items, quantities, prices and timestamp. **[BLOG]**

**Ordering channels to suppliers [FP/BLOG/HC]**
- **Email:** formatted order email, sent to multiple contacts.
- **WhatsApp:** to configured WhatsApp numbers. The HC says suppliers get "an automated email and/or WhatsApp message with the order details". It is unclear whether this goes through the WhatsApp Business API or a deeplink, though "automated" suggests the API.
- **Direct integration / EDI-SFTP file:** a structured file with PO number, delivery date, quantities and supplier item codes, dropped on the supplier's file server.
- **Supplier app ("Supy Supplier")**, a legacy app. **Supy Connect** is for the reverse direction (section 8).
- Supplier confirmation or acknowledgment: **not documented** (no evidence of supplier accept/modify flows for external suppliers).

**Multi-site**
- HQ staff can order on behalf of a branch.
- Single login across multiple branches; the comparison page claims MarketMan needs separate HQ and branch logins.

---

## 5. Approval workflows, permissions, spend limits and ordering policies

**Roles [HC "How to manage users and permissions"; FP permissions-limits]**
- Configured under Settings → Users, Roles and Policies.
- Each user has a **Role** (a permission set) and **Active Locations** (location scoping).
- Default roles:
  - **Group roles:** Group Admin, Group Data Manager, Group Operations Manager.
  - **Branch roles:** Branch Staff, Branch Manager, Branch Drafter, Accounting User.
- Custom roles: "Create Role" in the Roles tab.
- The comparison page claims **200+ granular permissions**, scoped per outlet.
- The older FP FAQ uses a simpler model: **Manager** (full rights), **Staff** (limited), and **Drafter** (can only draft orders and receiving; a Manager must approve).
- Suggested split: clerks post GRNs and edit prices; managers or admins **unpost** and issue credits. Unposting is permission-gated. **[BLOG GRN]**
- Some actions are special permissions, for example **force-processing a suspected duplicate invoice**. **[BLOG inbox]**
- Submit rights can be scoped per user, globally or per cost centre. **Approver deputies** are supported. **[BLOG PO mgmt]**

**Approval workflows [FP, HC "Policy approvals"]**
- **Sequential, up to 5 levels** (an "approval ladder").
- **Separate flows for requisitions and POs.** They also apply to central kitchen orders and invoices.
- **Triggers:** requesting branch/outlet, order value (spend threshold) and user role.
- **Approvers:** individual users or **user groups**.
- **Notifications:** email (with an in-app link, so approval can happen from the inbox on mobile or desktop) and mobile app alerts.
- **Conversion rule:** requisitions convert to POs only after **final** approval.
- **Audit:** who drafted, approved (and at which ladder level), rejected or submitted, with timestamps and the triggering policy.

**Purchasing limits / policies [FP, HC]**
- Configured under Administration → Permission Policy.
- **Dimensions:** supplier, branch, item category, user and par level. The orders page also lists outlet.
- **Periods:** day, week, month or quarter (the orders page lists daily, weekly or monthly caps). Each policy has a **reset period**.
- **On breach:**
  - The document is saved as a **Draft** with the status "**Limit Reached – Awaiting Approval**", and approvers are emailed.
  - **Rejection blocks** the order.
- A **side panel** on the Place Order, GRN and Process Requisition screens shows each applicable policy's **budget used, budget remaining and reset period** before submit.
- **Conflict resolution:** with several policies of the **same type**, the one with the **highest limit** applies (with its approvers). Policies of **different types** all apply.

**Receiving limits [FP]**
- Invoice receiving limits by supplier, branch, item category or user.
- **Price and quantity variance thresholds as %** (no defaults published; one blog example uses 2%). These govern GRN and invoice acceptance.

**Data model [INF]**
- `Role(id, name, scope[group|branch], permissions[])`
- `User(id, role_id, active_location_ids[])`
- `Policy(id, type[po_value|requisition|receiving|price_variance|qty_variance], dimension[supplier|branch|category|user|par], dimension_ref, limit_amount|limit_pct, period[day|week|month|quarter], approval_ladder_id, restricted_role_ids)`
- `ApprovalLadder(id, steps[{order, approver_user_id|group_id}])` with at most 5 steps
- `ApprovalEvent(document_type, document_id, step, actor, action[draft|approve|reject|submit], policy_id, at)`
- `PolicyUsage(policy_id, period_start, used_amount)`

---

## 6. Receiving (GRN), partial deliveries and discrepancies

**Concept [HC]:** "Items are received into inventory by creating a Goods Received Note (GRN), which can be considered a digital copy of the supplier's invoice." Stock moves only when the GRN is **posted**.

**Receive against an order [HC "How to receive from suppliers"]**
1. Procurement → Orders → select the order → **"Receive Order"**.
2. Choose the **document type**: **Invoice** (carries prices) or **Delivery Note** (no prices; invoiced later).
3. Ordered items pre-populate. For each line enter:
   - **Document Quantity:** what the invoice says.
   - **Received Quantity:** what actually arrived.
4. For an invoice GRN, enter the **invoice price** per line. If it differs from the expected price, choose one of:
   - **Credit:** raise a credit note.
   - **Update Price:** accept it as the new supplier price, written to price history.
   - **Discount**
5. Header fields: **invoice number** (unique document number; duplicates are rejected), **invoice date**, **due date**, an attachment (invoice PDF or photo), and an **invoice-level discount field** for absorbing rounding. **[FP, BLOG]**
6. Save options:
   - **Draft:** keep for later.
   - **Save:** save the GRN but keep the PO open, for partial deliveries.
   - **Save & Close Order:** finish.

**Receive without order [HC]**
- Path: Accounting → GRNs → Receive Without Order.
- Pick the cost center and supplier, attach the invoice PDF, review and submit.
- Example use: a supermarket purchase.
- Can be turned off. If it is left on everywhere, the approval rules become advisory. **[BLOG]**

**Partial deliveries / split deliveries [FP, BLOG]**
- **Multiple GRNs per PO.** Partially received POs show **pending balances**. Partially received items stay open until the rest is received.
- Received quantity and price on each GRN update the PO's **fulfilment data**.
- Multiple invoices per PO are also allowed. A per-delivery surcharge multiplies when an order is split across invoices.

**Other receiving features [FP/BLOG]**
- **Free-of-charge (FOC) items** and **item-level discounts**.
- **Delivery Note → GRN or purchase invoice** conversion.
- **Consolidation:** many GRNs or delivery notes become **one invoice**, with each item keeping its originating cost centre. This is tied to EU e-invoicing in the comparison page.
- **One GRN across multiple locations/cost centres:** a consolidated delivery split back to branches; GRN lines carry location and cost centre.
- **Stock / finance separation:**
  - A **Draft GRN** requires approval before it affects stock or finance.
  - A **Posted/Finalised** GRN is locked: it cannot be deleted, and only an admin can unlock or "unpost" it.
  - Records can be locked after accounting posting.
  - **Posting** pushes to accounting.

**GRN status [INF]:** Incoming (AI-created) → Draft → Saved/Submitted (pending approval) → Posted (locked) → Unposted (admin). Also **Needs More Info** and **Skipped** in the AI inbox.

**Received-item line status [BLOG GRN]**
- **Needs review | Price updated | Credit issued | Ignored**.
- The "Received Items" view defaults to a **price-discrepancy filter**.
- Actions from that view: update the expected price, **email the supplier**, or open the GRN to raise a credit note.
- A configurable **auto-dispute threshold** lets small variances pass.

**Discrepancy taxonomy and handling [BLOG credit-note-vs-GRN]**

| Discrepancy | When caught | Correct action in Supy |
|---|---|---|
| Short or no-show delivery | At delivery | Set the line's **received and invoiced qty to 0** on the GRN (zeroing), or reorder |
| Over-delivery | At delivery | Flagged by AI receiving (orange) |
| Overcharge (price) | At receiving or after invoice confirmation | Update the price if genuine; otherwise raise a **credit note** |
| Return of goods | After receipt | **Supplier Return**, which auto-generates a credit note |
| Financial-only credit (deposit, rebate) | Any time | **Standalone credit note** (no stock impact) |
| Tax issues | Invoice | Flagged by AI receiving |
| Rounding | Invoice | Absorb via the invoice discount field |

- A negative GRN is discouraged: it does not post as a vendor credit.
- Once an invoice is confirmed, GRN edits close. Once posted, credit notes are the only route.

**Data model [INF]**
- `GRN(id, po_id?, supplier_id, location_id, cost_center_id, doc_type[invoice|delivery_note], doc_number UNIQUE per supplier, doc_date, due_date, status, source[manual|ai_email|ai_scan|portal_upload], attachment_ids, invoice_discount, surcharge, total_ex_tax, tax_total, total, currency, posted_at, posted_by, accounting_ref)`
- `GRNLine(id, grn_id, po_line_id?, supplier_item_id, package_id, document_qty, received_qty, invoiced_qty, expected_price, invoice_price, discount, is_foc, tax_rate, cost_center_id, line_status[needs_review|price_updated|credit_issued|ignored])`
- `POLine.fulfilled_qty` is derived from the sum of GRNLine.received_qty.

---

## 7. AI invoice and credit note processing; invoice matching

**Intake channels [HC AI SOP, FP invoice-receiving]**
- **Email:** suppliers send to a designated inbox. The feature page says "each restaurant's designated inbox"; the blog describes one group address with a location field.
- **Mobile app scan** of paper invoices.
- **Portal upload.**
- All channels use the same AI logic and staging rules.
- Attachments can be PDFs or images, viewable in the inbox.

**Pipeline [HC AI SOP]**
1. An email arrives in **Accounting → AI Invoice Inbox**.
2. **Whitelisting gate:**
   - Whitelisted sender, recognised → **Processed**
   - Whitelisted sender, not recognised → **Needs More Info**
   - Sender not whitelisted → **Skipped**
   - Adding the supplier later can re-process held invoices. **[BLOG]**
3. **AI extraction** (claimed to run on Gemini and Claude, about 5 s per invoice, "96%+ accuracy" **[CMP]**):
   - Header: supplier name, invoice number, invoice date, due date.
   - Lines: items, quantities, prices, taxes and totals.
4. **Matching:**
   - If a **PO number** is on the invoice, the AI looks up the order to set the supplier and cost center.
   - If it cannot confidently match the supplier or cost center → Needs More Info.
5. **Line matching:** against the **Supplier Item List by supplier item code**. Unconfident lines are skipped and marked **unmatched**, and they **block finalisation and posting** until a user resolves them.
6. An **Incoming GRN** is created for the location and supplier under Accounting → GRNs → **Incoming**, ready for review and posting.
7. **Exceptions:**
   - Price mismatch, over-delivery and tax issues; price and quantity conflicts are highlighted **orange**.
   - **Suspected duplicate**, by invoice number, held for review. A user with permission can **force-process** it.
   - **Missing PO**, held for approval.
8. **Approval** before stock or accounts update. Then **Post** to accounting (as a bill) and inventory values update.
9. **Editable before posting:** document number, location/cost center and supplier.

**Matching (2-way / 3-way) [BLOG three-way, 2-way vs 3-way]**
- **3-way:** PO (intent) vs GRN (delivery) vs invoice (claim), **per line on quantity and price**.
- The **variance threshold is set per group** (example: >2% held for review). Trivial rounding clears automatically. Price gaps are flagged. A **quantity gap** is flagged when invoiced qty exceeds received qty.
- A **discrepant invoice is held**, not paid.
- **Auto-GRN:** "Matches every invoice line to an open PO, and where prices match within tolerance, the GRN is created automatically." **[BLOG snippet]**
- **2-way:** for receive-without-order, GRN vs invoice only.
- **Caveat:** the product pages themselves never use the terms "2-way" or "3-way". The concept comes from blog content. In practice the model is: one **GRN document = receipt + invoice** (document qty vs received qty vs PO qty, invoice price vs expected price). This is a **merged GRN/invoice object**, not three separate documents, unless delivery notes are later consolidated into an invoice.

**Credit notes [HC "How to handle credit notes"; FP; BLOG]**
- **Created from:** a GRN line (the price-discrepancy "Credit" action), a Supplier Return (auto), or standalone (financial only).
- **Statuses [HC]:**
  - **Open:** not linked to any GRN.
  - **Allocated:** linked to a saved but **unposted** GRN; still editable, and edits on the origin GRN item propagate.
  - **Closed:** linked to a **posted** GRN.
  - **Archived**
- **Settlement:** select one or more credit notes from the **same location and supplier** → Actions → **Create GRN**. This produces a new GRN that acts as a **negative invoice** (it carries invoice qty but **no received qty**).
- List columns: Branch (from the origin GRN), Supplier, plus amount, reference and so on.
- **Multi-line credit notes** are supported. Credits must reference the GRN they correct (no "orphan credits"). Disputes, adjustments and refunds are tracked, with an audit trail. Credits post to accounting as **vendor credits** (Xero, QuickBooks, Zoho Books, Wafeq).
- Example from the blog: CN-118 for $70.00, covering 20 tins of olive oil received at $35.50 against a $32.00 contract.

**Supplier returns [HC]**
- Path: Accounting → Supplier Returns → New Supplier Return.
- Reduces stock and auto-generates a credit note.

**Data model [INF]**
- `InboundDocument(id, received_via[email|scan|upload], sender_email, attachment, status[processed|needs_more_info|skipped|duplicate_hold], extracted_json, matched_supplier_id, matched_cost_center_id, matched_po_id, grn_id)`
- `SupplierEmailWhitelist(supplier_id, email)`
- `CreditNote(id, supplier_id, location_id, origin_grn_id?, origin_return_id?, number, date, status[open|allocated|closed|archived], allocated_grn_id?, lines[], total, posted)`
- `SupplierReturn(id, supplier_id, location_id, lines[], credit_note_id)`

---

## 8. Central kitchen / internal ordering and Supy Connect (B2B)

**Central kitchen as supplier [FP central-kitchen; BLOG CK transfer pricing, B2B catalogs]**
- **Ordering:**
  - Branches send POs (or rerouted requisitions) to the central kitchen.
  - The central kitchen sees all outlets' orders on one screen, with **demand aggregated per item/SKU**: how much, from which branches, and for which delivery date.
  - HQ can create orders on behalf of any branch.
- **Fulfilment actions:**
  - Edit quantities based on availability, then **Confirm → Ship → Mark Delivered**.
  - A **Delivery Note** is generated per fulfilled request.
- **Billing:**
  - **Pro forma invoices** and **tax invoices**.
  - **Statements of account** per customer or branch, with outstanding balances.
  - B2B orders can be **posted and unposted** for accounting, separately from fulfilment.
- **Pricing:**
  - **Price lists per customer group**, using **cost**, **cost + markup %** or a **fixed price**.
  - Example: own branches at cost +12%, franchise partners at +18%, wholesale on a fixed list. A sourdough loaf is $2.10, $2.21 or $2.85 by group, and a $2.10 production cost becomes a $2.95 internal price.
- **Customers:**
  - Customer accounts (display name, internal code, legal name) and bulk import.
  - **Catalog visibility per customer** (example: a 210-item master catalog with customers seeing 140, 45 or 32 items).
  - **Soft deactivation** that keeps history.
- **Approvals and policies:** the same sequential approvals (up to 5) and spending policies apply to central kitchen orders and invoices.
- **Alternative model: Inventory Transfers.**
  - The receiver must **accept**; they can **partially accept or reject**.
  - Stock updates at both ends on acceptance, with an audit trail.
  - Transfers have no invoicing.

**Supy Connect [FP supy-connect]**
- **Who uses it:** central kitchens, CPUs (central production units) and roasteries selling to **external** B2B customers (restaurants, hotels, cafés, retail). **Not for internal branch ordering.**
- **App:** a Supy-branded iOS and Android app (not white-label). Customers log in with a **phone number** and can browse the catalog (live, the same as the portal), order, **reorder**, and view and download invoice PDFs.
- **Onboarding:**
  - The supplier adds **contacts** (name, email, phone) under a customer account. Each contact belongs to **one** customer account.
  - The contact gets an email invite with app download links.
  - The supplier controls who can order and tracks **invite accepted / active / needs reminder**, with a bulk re-invite for those not yet accepted.
- **Orders:** land in the same portal dashboard and fulfilment flow as portal-created orders.
- **Not documented:** payments, credit limits, cutoffs, MOQ and order status notifications.
- The pricing page does not list Supy Connect; it likely belongs to the "Central kitchen – B2B ordering" add-on. **[INF]**

**Data model [INF]**
- `Customer(id, display_name, legal_name, internal_code, group_id, active)`
- `CustomerGroup(id, price_list_id)`
- `PriceList(id, method[cost|markup|fixed], markup_pct, lines[item_id, price])`
- `CustomerCatalogVisibility(customer_id, item_id, visible)`
- `CustomerContact(id, customer_id, name, email, phone, invite_status)`
- `SalesOrder(id, customer_id|branch_id, delivery_date, status[submitted|confirmed|shipped|delivered], posted)`
- `DeliveryNote`
- `SalesInvoice(type[proforma|tax])`
- `Statement`

---

## 9. Price variance controls (cross-cutting)

- **Expected price:** taken from the supplier item price or location override, and shown on the PO and GRN.
- **At receiving:** invoice price vs expected price triggers **Credit / Update Price / Discount**, with % thresholds by policy (receiving limits) and an **auto-dispute threshold**.
- **AI receiving** flags price mismatches (orange). Example: $42 expected vs $48 invoiced, held for approval.
- A **Received Items** view filtered on price discrepancies supports supplier email follow-up.
- **Price history** per supplier item. An accepted change recalculates recipe costs and triggers **food-cost target alerts** per dish.
- "Approved prices enforced on orders" **[FP]**. The mechanism is unspecified.
- Reporting: an items-by-supplier report (short deliveries), plus procurement reports across more than 8 categories: purchase value, orders, invoices and supplier performance. **[BLOG]**

---

## 10. AI Predictive Ordering

**[FP ai-predictive-ordering]** This page is fairly concrete.

- **Inputs:**
  - Chosen by the user: **branch, supplier, delivery date, coverage period (days)**.
  - **AI sales forecast:** item-level per branch and menu item, a **15-day horizon**, manager-adjustable for events and promotions. This needs the AI Sales Forecasting add-on.
  - **Recipes:** to explode menu sales into ingredient usage.
  - **Current on-hand stock:** can be overridden at order time for that order only, without changing the stock record. The page recommends this for high-value items.
  - **Order history:** last order quantity and **4-week average** per item.
- **Calculation:** forecast consumption over the coverage window, minus current stock (projected to the delivery date), gives the suggested quantity. Only items needed within the coverage window are included.
- **Output:**
  - **One PO per supplier.**
  - Each line shows item name, unit price, supplier code, suggested qty, current stock, **projected stock at delivery**, last order qty and 4-week average.
- **User steps:** select parameters → review → optionally update stock (recalculates) → edit quantities, add or remove items, add a supplier comment → **Submit** (by email, WhatsApp or integration).
- **Never auto-sent.**
- Standard (non-AI) ordering remains available. The **par-level** ordering ("order to par") is a separate, simpler mechanism.
- **Marketing claims:** "never overstock", "10-second check", and "spots anomalies before any order leaves". Note that anomaly detection AI is marked "coming soon".

**Data model [INF]**
- `ForecastDaily(branch_id, menu_item_id, date, qty, adjusted_qty)`
- `SuggestedOrderRun(id, branch, supplier, delivery_date, coverage_days, lines[item, suggested_qty, on_hand, on_hand_override, projected_at_delivery, last_qty, avg4w])`

---

## 11. Audit, reporting and accounting hooks (procurement-relevant)

- **Audit logs:** every approval, edit, override, GRN action and price change is logged with user and timestamp, filterable by user, branch, action and date.
- **Accounting posting:**
  - Finalised GRNs post as bills; credit notes post as vendor credits.
  - Central kitchen invoices post as sales.
  - Post and unpost are permission-gated, and posting locks the record.
- **Exports:** Excel round-trips for supplier items; exports carry currency and time formatting.

---

## 12. Marketing claims vs concrete detail (quick reference)

**Pure or mostly marketing [MKT]**
- "Up to 25% food cost reduction", "60%" vs "80%+" waste reduction (the two figures are inconsistent across pages), "22 hours/month saved" and "65 working days per location per year".
- "3500+ operators", "5.0 rating", "75+ integrations" and "live in 2 weeks".
- AI "trained on thousands of F&B invoices", "recognizes context", "continuously learns", "96%+ accuracy, ~5 s, Gemini + Claude".
- "200+ granular permissions" (only role names are confirmed).

**Third-party view:** G2 shows about 77 reviews at 4.8–4.9, praising ease of use and support. The few cons mention data inaccuracy and missing features (one review each). No Capterra data was found.

**Concrete and verifiable (HC-backed)**
- Requisition tabs (Pending, Approved, Processed, Discarded) and the Approve vs Approve-and-Process (draft or submit) actions.
- GRN Draft / Save / Save & Close Order; Document vs Received Quantity; the invoice vs delivery-note type; the Credit / Update Price / Discount choice.
- Receive Without Order.
- The AI inbox states Processed / Needs More Info / Skipped; sender whitelisting; PO-number-based matching; supplier-item-code line matching with unmatched lines blocking posting; the Incoming GRN tab.
- Credit note states Open / Allocated / Closed / Archived; credit notes converted into a negative GRN.
- Policy breaches saved as drafts with "Limit Reached – Awaiting Approval"; the budget side panel; the highest-limit rule for same-type policies.
- Default role names.
- The Base Item → Package Item → Supplier Item model.

**Concrete (FP/BLOG-backed but not HC-verified)**
- 5-level sequential approvals.
- Policy dimensions and periods.
- Multiple GRNs per PO.
- FOC items and discounts.
- Delivery-note consolidation.
- Multi-location GRN.
- Location price overrides and price history fields.
- Central kitchen price-list methods and statements.
- Supy Connect onboarding.
- Predictive ordering inputs.

**Gaps (not publicly documented)**
- An explicit PO status enum and cancellation/amend flows.
- Supplier acknowledgment.
- How WhatsApp sending works mechanically.
- Currency conversion rules beyond "secondary currency".
- Tax engine details (inclusive vs exclusive, multiple taxes).
- Default tolerance values.
- How par levels are defined.
- Payment/AP status tracking (Supy appears to stop at posting to accounting and does not track payments).

---

## Sources

**supy.io feature, platform and pricing pages**
- https://supy.io/
- https://supy.io/platform/restaurant-procurement-software
- https://supy.io/product-features/orders-requisitions
- https://supy.io/product-features/supplier-management
- https://supy.io/product-features/permissions-limits
- https://supy.io/product-features/supy-connect
- https://supy.io/product-features/invoices-credit-notes
- https://supy.io/product-features/invoice-receiving
- https://supy.io/product-features/ai-predictive-ordering
- https://supy.io/product-features/central-kitchen-operations
- https://supy.io/supy-pricing
- https://supy.io/platform-comparison/supy-vs-marketman

**supy.io blog**
- https://supy.io/blog/learn-credit-note-vs-grn-supplier-discrepancy-guide
- https://supy.io/blog/learn-supplier-credit-notes-receiving-discrepancies
- https://supy.io/blog/learn-central-kitchen-transfer-pricing-internal-invoicing
- https://supy.io/blog/learn-consolidate-restaurant-branch-orders-single-supplier-order
- https://supy.io/blog/learn-central-kitchen-b2b-ordering-customer-catalogs
- https://supy.io/blog/learn-sending-purchase-orders-to-suppliers
- https://supy.io/blog/learn-bulk-supplier-cost-price-updates-multi-site
- https://supy.io/blog/learn-three-way-matching-restaurant-invoices
- https://supy.io/blog/2-way-vs-3-way-invoice-matching-what-restaurants-need-to-know
- https://supy.io/blog/learn-goods-received-note-management-multi-site
- https://supy.io/blog/learn-purchase-order-management-system
- https://supy.io/blog/learn-restaurant-invoice-inbox-email-processing

**Help center (help.supy.io).** Content comes from search snippets because the host was blocked in this sandbox.
- https://help.supy.io/en/articles/8596863-how-to-receive-from-suppliers
- https://help.supy.io/en/articles/11121486-receive-without-order
- https://help.supy.io/en/articles/11643153-supy-ai-invoice-receiving-sop
- https://help.supy.io/en/articles/11121915-resolving-disputes-in-grn
- https://help.supy.io/en/articles/8596999-how-to-handle-credit-notes
- https://help.supy.io/en/articles/11121908-requisitions
- https://help.supy.io/en/articles/11643135-requisitions-on-the-mobile-app
- https://help.supy.io/en/articles/11643138-policy-approvals
- https://help.supy.io/en/articles/11121956-how-to-manage-users-and-permissions
- https://help.supy.io/en/articles/8600693-how-to-add-suppliers
- https://help.supy.io/en/articles/11122702-supplier-configuration
- https://help.supy.io/en/collections/7067314-suppliers
- https://help.supy.io/en/articles/11122512-how-to-create-items
- https://help.supy.io/en/articles/11643142-incorrect-packaging-setup-wrong-base-unit-or-wrong-conversion

**Third-party**
- https://foodics.helpjuice.com/1669765-supy (Foodics–Supy integration; branches created by Supy support)
- https://apps.apple.com/ph/app/supy-supplier/id1670674126 (Supy Supplier app; search snippet only)
- https://apps.apple.com/in/app/supy/id1544652630 (Supy operator app; not fetched)
- https://www.g2.com/products/supy/reviews
- https://www.g2.com/products/supy/features
