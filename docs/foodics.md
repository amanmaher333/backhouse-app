# Foodics integration

Kitchain connects to [Foodics](https://www.foodics.com) to import sales and menus, and to record Kitchain deliveries as purchases in Foodics inventory. This follows Foodics' "Inventory Suppliers Integration" guide at developers.foodics.com.

## Getting access from Foodics

Foodics creates developer apps on request. Email **support@foodics.com** with the following details.

- **App:** Kitchain, an AI back office for restaurant groups covering procurement, supplier invoices, stock, recipes and food cost.
- **Scopes:**

  | Scope | Why |
  |---|---|
  | `general.read` | branches, warehouses, settings |
  | `inventory.settings.read` | inventory items |
  | `inventory.settings.write` | create the "Kitchain" supplier |
  | `inventory.transactions.read` | read purchases |
  | `inventory.transactions.write` | record purchases |
  | `users.write` | create the "Kitchain" user that purchases are recorded under |
  | `orders.list` | sales |
  | `menu.ingredients.read` | menu items and their Foodics recipes |
  | `tokens.limited.revoke` | revoke our token on disconnect |

- **Redirect URL:** `<web>/integrations/foodics/callback`
- **Install URL:** `<web>/integrations/foodics/install`
- **Webhook URL:** `<api>/v1/integrations/foodics/webhook`
- **Webhook events:** `order.created`, `order.updated`, `menu.updated`

Foodics replies with a client ID and secret and a sandbox account (console-sandbox.foodics.com). The sandbox cashier app needs an iPad. Production links must be live HTTPS URLs, so give Kitchain its own domain before asking for the production app.

## Settings

| Variable | Value |
|---|---|
| `FOODICS_MODE` | `simulated` (default), `sandbox` or `production` |
| `FOODICS_CLIENT_ID`, `FOODICS_CLIENT_SECRET` | from Foodics |
| `FOODICS_REDIRECT_URI` | optional; defaults to `PUBLIC_WEB_URL/integrations/foodics/callback` |
| `INTEGRATIONS_SECRET_KEY` | 32+ characters; encrypts Foodics tokens at rest (falls back to `ZATCA_SECRET_KEY`) |

In **simulated** mode, "Connect Foodics" connects to a built-in demo business with:
- 2 branches and a warehouse;
- 6 inventory items and 3 menu items with recipes;
- 24 orders a day for the last 10 days.

Everything works end to end in this mode, so you can try it and run the tests without a Foodics account.

## How it works

**Connecting**
- Integrations → Connect Foodics opens Foodics' authorisation page, where the Foodics **account owner** approves Kitchain.
- Foodics sends them back with a code. Kitchain checks the one-time state against the signed-in person (Foodics requires the business to be signed in before the token is created). It then exchanges the code for a token and stores the token encrypted.
- Foodics tokens don't expire. Disconnecting revokes the token at Foodics and forgets it; imported data stays.
- A Foodics account can be connected to only one Kitchain organisation at a time.

**Catalogue** (branches, warehouses, inventory items, menu products)
- Synced on connect, every 12 hours, and when Foodics sends `menu.updated`.
- New branches are matched to our sites by name.
- New inventory items are matched to our items by SKU (our item code), or else by a confident name match.
- Anything that wasn't matched can be linked by hand on the Integrations page.

**Units**
- Foodics items have a storage unit (e.g. KG, Tray), an ingredient unit (e.g. Gram, Piece) and a factor between them. When the ingredient unit is our item's base unit (g, ml or each), quantities convert automatically.
- When the units don't line up (e.g. a "Box" of saffron), someone enters how much one Foodics unit is (e.g. 10 g). Until then, purchases with that item wait.

**Sales**
- Orders are imported in reference order, 50 at a time, as Foodics recommends. That covers the last 35 days on first connect, then every 10 minutes and whenever a webhook arrives.
- Orders changed since the last import (e.g. returns after closing) are pulled too.
- Only closed orders count. Void and declined lines are skipped, and returned quantities are subtracted.
- Sales are kept per branch, product and business day, net of VAT.

**Webhooks**
- Foodics needs a reply within 5 seconds and doesn't sign webhooks. So a webhook only tells Kitchain which business changed; the data itself is always fetched from the Foodics API.

**Purchases**
- Each goods receipt at a linked site, received after connecting, is recorded in Foodics as a **closed purchasing transaction** (type 1, status 4). It is recorded:
  - under the supplier and user named "Kitchain" (created once per business);
  - with item quantities in Foodics storage units and costs before VAT;
  - with the VAT as `paid_tax`;
  - with the delivery-note number as the invoice number.
- Receipts with unlinked items wait under Purchases → "Needs item links" and go through once the items are linked.
- This can be switched off on the Integrations page.

**Rate limit**
- Foodics allows 30 requests a minute per token. The client spaces requests 2 seconds apart and waits once on a 429.

## Not yet

- Recipes and theoretical vs actual food cost: the next part of Phase 5. Foodics' own recipes are already imported with each menu item.
- Recording transfers and returns to suppliers in Foodics.
- Reading Foodics stock levels.
- Listing in the Foodics Marketplace: needs the production app and Foodics' review.
