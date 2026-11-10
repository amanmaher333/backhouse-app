# Billing and company verification

Both run without anyone at Kitchain in the normal case. People are needed only for a short review queue (company names that don't match the register) and for disputes.

## Plans (launch prices, SAR, before 15% VAT)

| Part | Price |
|---|---|
| Kitchain platform, per organisation | 400 / month |
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
| `free` | Suppliers, and Kitchain's own organisation. | yes |

**Read-only** means:
- every write returns `402 subscription_inactive`;
- agents, WhatsApp approval cards and digests pause;
- everything stays readable.

Paying (Billing, then **Pay now**, or choosing a plan) restores full use straight away.

**How renewals run:** the worker (`BillingService.runDue`) handles trials, renewals and retries. Each subscription is processed under a row lock, so two workers never charge twice.

### Agreed pricing (design partners, pilots)

Kitchain staff can agree prices with one organisation on the **Platform** page (or `PUT /v1/platform/organizations/:id/pricing`):
- **What can change:** a label the customer sees (e.g. "Design partner"), the monthly platform fee, the price per site of each agent, a % discount on the whole bill, an end date, and an internal note.
- **What stays at list price:** anything left empty.
- **On the bill:** the estimate on the Billing page and every invoice use the agreed prices; a discount is its own line ("Design partner discount (20%)"). The Billing page shows "Design partner pricing · until …".
- **When it ends:** from the day after the end date, bills go back to list prices automatically.
- **Free plans:** a 100% discount (or zero prices) makes the plan free. It then starts without a card, and each period's invoice is issued at zero and marked paid without charging anything.
- **Trials:** staff can move a trial's end date, or restart an expired trial, from the same page (`POST /v1/platform/organizations/:id/trial`).
- **Audit:** every change is in the organisation's audit log (`billing.pricing_set`, `billing.pricing_cleared`, `billing.trial_changed`).

**Who is staff:** members of Kitchain's own organisation (type `platform`). To add someone, they sign up first, then run `pnpm --filter @boh/api platform:admin their@email` against production; the Platform item then appears in their menu (choose the Kitchain organisation after signing in).

### Bank transfer (agreed per organisation)

For pilots who can't or won't pay by card, Kitchain staff switch the organisation to **bank transfer** on the Platform page (`PUT /v1/platform/organizations/:id/payment-mode`):
- **No card needed:** the customer chooses monthly or annual on Billing and starts the plan without a card. The Billing page shows "You pay by bank transfer" with Kitchain's bank details.
- **Each period:** at the end of the trial and at each renewal, the invoice is issued as **Awaiting transfer**, due `BANK_TRANSFER_DUE_DAYS` (default 14) days later. It shows the bank, account name, IBAN and the invoice number as the reference to quote. The service continues meanwhile.
- **Unpaid after the due date:** the account becomes past due (still usable) for the same number of days again, then suspended (read-only), as with a failed card.
- **When the money arrives:** staff open Platform, find the invoice under "Unpaid invoices", click **Mark paid** and enter the bank reference (`POST /v1/platform/organizations/invoices/:invoiceId/paid`). A past-due or suspended account becomes active again.
- **Bank details:** `BOH_BANK_NAME`, `BOH_BANK_ACCOUNT_NAME` and `BOH_BANK_IBAN` on the API and worker. Until the IBAN is set, invoices say Kitchain will send the bank details.
- **Audit:** `billing.payment_mode_set`, `billing.awaiting_transfer`, `billing.transfer_overdue`, `billing.transfer_received`.

### Trial ending reminder

Three days before the trial ends, at their digest hour (any hour on the last day), people who can manage billing and see prices get a WhatsApp message, once:
- **No plan chosen yet:** what Kitchain saved during the trial, line by line, with what is still being claimed shown separately; the monthly price, and how many times the savings already cover it; days left and a link to Billing.
- **Plan and card already set:** that the plan starts by itself on that date, and that there is nothing to do.

`trial_notices` records each one (person, organisation, kind) with the figures it showed. Template `boh_trial_ending` (see `docs/whatsapp-templates.md`). Code: `apps/api/src/modules/trial-ending.ts`.

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
- **Seller:** Kitchain's name, VAT and CR numbers, from the `BOH_SELLER_*` settings.
- **Buyer:** the customer's legal entity, with VAT and CR numbers and the registered name when verified.
- **Contents:** lines, VAT and total.
- **QR code:** ZATCA's phase-1 QR (TLV: seller name, VAT number, time, total, VAT).

Invoices can't be deleted. **ZATCA phase 2** (signed XML, clearance and reporting through ZATCA's platform) is not done yet; it comes with the Phase 3 e-invoicing work.

## Company verification

**When it runs:** at sign-up, and whenever a legal entity's CR number or name changes. Kitchain looks up the CR in the Ministry of Commerce commercial register:

| Result | Status |
|---|---|
| Active CR, name matches (similarity ≥ 0.6; legal forms such as شركة/LLC/Est. and the Arabic article ignored) | `verified` |
| Not found, expired, cancelled or suspended | `rejected`, with the reason |
| Active, but the name doesn't match | `needs_review`, which goes to Kitchain's review queue |
| Register unreachable | `pending`, retried by the worker |

**What verification unlocks:** only verified companies can have Kitchain send orders and messages to suppliers from Kitchain's WhatsApp number. This protects the number from spam and keeps its quality rating with Meta. Unverified companies still get prepared messages and links.

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
- **Who reviews:** Kitchain staff are members of Kitchain's own organisation (type `platform`). To add one: `pnpm --filter @boh/api platform:admin someone@boh.sa`.
- **Endpoints:** `GET /v1/platform/verifications` lists the queue, and `POST /v1/platform/verifications/:id/decide` with `{ decision: approve|deny }` decides one.
