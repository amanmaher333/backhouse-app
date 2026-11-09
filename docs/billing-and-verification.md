# Billing and company verification

Both run without anyone at Backhouse in the normal case. People are needed only for a short review queue (company names that don't match the register) and for disputes.

## Plans (launch prices, SAR, before 15% VAT)

| Part | Price |
|---|---|
| Backhouse platform, per organisation | 400 / month |
| Purchasing agent, per active site | 350 / month |
| Price Watch agent, per active site | 150 / month |
| Any other agent, per active site | 250 / month |
| Annual billing | 10 months' price for 12 |
| Suppliers | Free |

Prices live in `packages/domain/src/billing.ts` (`computeBill`). Each bill is worked out when it is issued, from the active sites and hired agents at that time.

## Lifecycle

| Status | Meaning | Full use? |
|---|---|---|
| `trialing` | 30 days from sign-up. Choosing a plan during the trial charges nothing until it ends. | yes |
| `active` | Paid for the current period; renews automatically at the period end. | yes |
| `past_due` | A renewal failed. Retried after 1 day, then after 3 more days. | yes (grace period) |
| `suspended` | The third attempt failed. | read-only |
| `canceled` | Cancelled, and the paid period has ended. | read-only |
| `expired` | The trial ended without a plan. | read-only |
| `free` | Suppliers, and Backhouse's own organisation. | yes |

**Read-only** means:
- every write returns `402 subscription_inactive`;
- agents, WhatsApp approval cards and digests pause;
- everything stays readable.

Paying (Billing, then **Pay now**, or choosing a plan) restores full use straight away.

**How renewals run:** the worker (`BillingService.runDue`) handles trials, renewals and retries. Each subscription is processed under a row lock, so two workers never charge twice.

## Payments

`BILLING_PROVIDER=simulated` is the default, and no money moves. Test cards on the Billing page:

| Card number | Result |
|---|---|
| 4242 4242 4242 4242 | Paid |
| Ending in 0002 | Declined |
| Ending in 3220 | Asks for bank verification (3-D Secure), which a dialog simulates |

`BILLING_PROVIDER=moyasar` uses [Moyasar](https://moyasar.com), a Saudi payment gateway supporting mada, Visa, Mastercard and Apple Pay. It needs these settings:
- `MOYASAR_SECRET_KEY`
- `MOYASAR_PUBLISHABLE_KEY`
- `MOYASAR_WEBHOOK_SECRET`
- webhook URL: `https://<api>/v1/webhooks/payments`

**Before going live:**
- **Check the adapter against Moyasar's API documentation.** The field names in `apps/api/src/billing/payments.ts` come from Moyasar's public API as we know it; their docs could not be reached from the development environment.
- **Connect Moyasar's card form.** The Billing page still uses the test card form; the hosted Moyasar form (which turns a card into a token) still needs connecting.
- **Plan for renewals that need 3-D Secure.** A renewal where the bank asks for verification, with nobody present to answer, is treated as a failed payment.

## Invoices

Each charge issues a tax invoice (`BOH-YYYY-NNNNNN`). It records:
- **Seller:** Backhouse's name, VAT and CR numbers, from the `BOH_SELLER_*` settings.
- **Buyer:** the customer's legal entity, with VAT and CR numbers and the registered name when verified.
- **Contents:** lines, VAT and total.
- **QR code:** ZATCA's phase-1 QR (TLV: seller name, VAT number, time, total, VAT).

Invoices can't be deleted. **ZATCA phase 2** (signed XML, clearance and reporting through ZATCA's platform) is not done yet; it comes with the Phase 3 e-invoicing work.

## Company verification

**When it runs:** at sign-up, and whenever a legal entity's CR number or name changes. Backhouse looks up the CR in the Ministry of Commerce commercial register:

| Result | Status |
|---|---|
| Active CR, name matches (similarity ≥ 0.6; legal forms such as شركة/LLC/Est. and the Arabic article ignored) | `verified` |
| Not found, expired, cancelled or suspended | `rejected`, with the reason |
| Active, but the name doesn't match | `needs_review`, which goes to Backhouse's review queue |
| Register unreachable | `pending`, retried by the worker |

**What verification unlocks:** only verified companies can have Backhouse send orders and messages to suppliers from Backhouse's WhatsApp number. This protects the number from spam and keeps its quality rating with Meta. Unverified companies still get prepared messages and links.

**The registry provider:**
- `REGISTRY_PROVIDER=simulated` (default) uses these test rules, by how the CR number ends:

| CR ends in | Result |
|---|---|
| `0000` | Not found |
| `9999` | Expired |
| `8888` | Different name (goes to review) |
| `7777` | Register unreachable |
| Anything else | Matches |

- `REGISTRY_PROVIDER=wathq` uses [Wathq](https://developer.wathq.sa), the Ministry of Commerce's API service. It needs `WATHQ_API_KEY` and, if your subscribed version differs, `WATHQ_BASE_URL`. The response parser in `apps/api/src/verification/registry.ts` accepts several field spellings; confirm them against the Wathq developer portal.

**VAT numbers:** checked for format only (15 digits, starting and ending with 3). ZATCA offers no public API for checking a VAT number against a CR.

**Review queue:**
- **Who reviews:** Backhouse staff are members of Backhouse's own organisation (type `platform`). To add one: `pnpm --filter @boh/api platform:admin someone@boh.sa`.
- **Endpoints:** `GET /v1/platform/verifications` lists the queue, and `POST /v1/platform/verifications/:id/decide` with `{ decision: approve|deny }` decides one.
