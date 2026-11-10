# Savings

The Savings page (`/savings`, API `GET /v1/savings?from=&to=`) shows the money Kitchain recovered or avoided for an organisation. It's what a restaurant group weighs against the subscription, so it counts only what is on their own records. Nothing is projected or estimated from things that didn't happen.

Needs `price:read`.

## What counts

| Kind | Counted when | Amount |
|---|---|---|
| **Credit notes received** (`credit_note`) | A supplier credit note arrives against an invoice Kitchain disputed | The credit note, up to the disputed claim. A credit for returned goods on top of the claim isn't a saving and isn't counted |
| **Duplicate invoices stopped** (`duplicate`) | An invoice the matcher flagged as a duplicate is rejected | The whole invoice, which would otherwise have been paid twice |
| **Cheaper suppliers** (`supplier_switch`) | Goods are received from the supplier Price Watch switched to, within a year of the switch | What the same deliveries would have cost at the old supplier's price at the time of the switch: `spend × p / (1 − p)`, with `p` the saving % on the task |
| **Waiting for a credit note** (`claim_open`) | An invoice is disputed and the claim isn't fully credited yet | The claim less credits received. Shown separately and **not** added to the total; it moves to "Credit notes received" when the credit note arrives |

Each kind is dated when it happened (credit received, duplicate rejected, latest delivery), in the organisation's country time zone. A period filter picks rows by that date. Open claims are listed whatever the period, because they are current state.

Not counted (yet): price rises a supplier withdrew after a message, waste reductions, food cost gap improvements. These are real but need a baseline before a figure can be defended; they belong in reporting, not in the savings total.

## Against the cost of Kitchain

- **Cost:** subscription invoices paid that were issued in the period. "Saved N× what Kitchain cost" shows when savings exceed the cost.
- **During the trial:** savings since the trial started, against the monthly price of the current plan (sites and hired agents as they are now). Shown on the Savings page and on the Billing page, where the decision to pay is made.

Amounts include VAT where the source does (credit notes and invoices), and so does the subscription cost they are compared with.

## Monthly report on WhatsApp

On the 1st of each month, at each person's digest hour, Kitchain sends last month's savings to people who can see prices: the total, each kind with money in it, what is still being claimed, and the comparison with what Kitchain cost. Quiet months are skipped. The template (`boh_monthly_savings`), scheduling and opt-out are in `docs/whatsapp-templates.md`. The message links to the Savings page for that month (`/savings?from=…&to=…`).

## Code

- `packages/domain/src/savings.ts`: totals, the switch formula, open claims, multiples, months.
- `apps/api/src/modules/savings.ts`: queries per kind; `SavingsService.entries()` is reused for the trial figure.
- `apps/api/src/billing/billing.service.ts`: `monthlyEstimate`, `paidBetween`, `trialStartedAt`.
- `apps/api/src/modules/savings-monthly.ts`: the monthly WhatsApp report (worker `runDue`, preview); `savings.module.ts` wires the endpoints.
- `apps/web/src/app/(app)/savings/page.tsx` and the `TrialValue` card on the Billing page; the report's switch and preview are on the WhatsApp page.
- Tests: `apps/api/test/monthly-savings.e2e.test.ts` (sent once on the 1st, quiet months skipped, template outside the window, opt-out, preview) and `apps/api/test/savings.e2e.test.ts` creates each kind through the API (dispute and credit note, duplicate, open claim, Price Watch switch and a delivery).
