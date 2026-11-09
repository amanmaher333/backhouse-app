# Supplier invoices and the Invoice agent

Backhouse checks every supplier invoice against the purchase order and what was actually received before anyone pays it. The Invoice agent turns the result into decisions in the inbox.

## How invoices come in

| Way | What happens |
|---|---|
| **Upload** (Invoices → Add invoice) | PDF, photo (JPEG, PNG, WebP) or ZATCA e-invoice XML, up to 10 MB. The same file twice opens the invoice already made from it. |
| **Email** | Each organisation has a private address, `invoices+<token>@<INBOUND_EMAIL_DOMAIN>`, shown on the Invoices page. Suppliers send invoices there. |
| **Typed in** (Invoices → Enter by hand) | For paper invoices. Choosing the order fills the lines from what was received. Someone else must approve an invoice you typed in. |

## How invoices are read

1. **E-invoices (UBL 2.1 XML, as issued under ZATCA phase 2)** are read exactly, with no AI. That includes the XML embedded in ZATCA PDF/A-3 invoices.
2. **Other PDFs and photos** are read by Claude into a fixed structure: number, dates, supplier and buyer VAT, PO number, lines and totals. Claude only reads the document. Every number is then checked by code. The original reading is kept, and corrections a person makes are stored as training data.
3. **Without a model configured** (`AGENTS_LLM=template` or no `ANTHROPIC_API_KEY`), the document is kept and the invoice waits for a person to type it in.

## Finding the supplier and the order

- **Supplier:** found, in this order, from:
  - the VAT number on the invoice;
  - the email sender (the supplier's contact email or invoice sender list);
  - the supplier's name, when exactly one supplier matches.
- **Order:** found, in this order, from:
  - the PO number printed on the invoice (`PO-00012`, `po 12` and `12` all work);
  - otherwise, the supplier's only delivery still waiting to be billed (or the only one whose unbilled value is within 2% of the invoice).
- **Credit notes:** linked to the invoice they correct, through the invoice number they refer to.

## The three-way match

Every invoice line is paired with an order line, by:
1. a person's choice;
2. the supplier's item code (SKU);
3. the name, in Arabic or English.

Then the match checks the following:

| Check | Blocks approval | What's claimed |
|---|---|---|
| Price above the price recorded on receipt (or the order price), beyond 1% or SAR 0.05 per unit | yes | difference × received units |
| Quantity billed above what was received and not already billed on another invoice | yes | extra units × invoice price |
| Line not on the order (fees, substitutions) | yes | the line |
| Line arithmetic (qty × price ≠ line total) | yes | the overcharge |
| Lines don't add up to the subtotal; subtotal + VAT ≠ total | yes | the overcharge |
| VAT not 15% of the subtotal, or a line at another rate | yes | VAT overcharged |
| Same supplier and invoice number as an earlier invoice | yes | nothing (reject it) |
| VAT number on the invoice isn't the supplier's | yes | nothing |
| Price below the agreed price | no | |
| Received but not on this invoice | no (a later invoice may bill it) | |

The **claim** is the overcharge plus VAT on it: the amount a credit note should cover.

**Statuses:**
- **To check:** the supplier or order wasn't found, the document couldn't be read, it came from an unknown sender, or it's addressed to someone else's VAT number.
- **Matched**, **Differences**, **Approved**, **Credit note asked**, **Paid** and **Rejected**.

## Decisions

- **Approve for payment:** for a match. A mismatch can be approved anyway, with a reason that is kept on the invoice.
- **Ask for a credit note:** lists the differences and the amount, in Arabic and English.
  - Suppliers who take orders on WhatsApp get it from Backhouse's number.
  - Otherwise it's prepared as an email or WhatsApp message.
- **Reject** (with a reason) and **Mark as paid** (date and payment reference).
- **Who can do what:**
  - Site managers and data managers can add and correct invoices.
  - Accountants and operations managers can also approve, dispute and record payment.
  - Invoices are visible per site.

## The Invoice agent

Hire it on the Agents page. It proposes:

| Task | When | Action |
|---|---|---|
| Approve invoice | it matches | approve for payment (can be set to run automatically) |
| Overcharge | it differs | ask for a credit note (drafted message), or approve as billed |
| Check invoice | it needs a person | none (opens the invoice) |
| Credit note received | a credit note arrived for a disputed invoice | approve the invoice with the credit note |

Automatic approval, when switched on, only applies when all of the following hold:
- the invoice matches;
- it has nothing to check;
- it's an invoice, not a credit note;
- it's under the limit set on the agent (default SAR 5,000).

A mismatch is never approved automatically.

## Email intake setup

| Variable | Purpose |
|---|---|
| `INBOUND_EMAIL_DOMAIN` | The domain of invoice addresses (default `in.backhouse.sa`). Point its MX records at your inbound email provider. |
| `INBOUND_EMAIL_SECRET` | Shared secret. Email intake is off until it's set. |

Configure the provider (Postmark, SendGrid Inbound Parse, Mailgun routes) to post each email to `https://<api>/v1/webhooks/invoice-email` as JSON:

```json
{ "messageId": "<…>", "from": "billing@supplier.sa", "to": ["invoices+3f9a…@in.backhouse.sa"], "subject": "…",
  "attachments": [{ "filename": "INV-1.pdf", "contentType": "application/pdf", "content": "<base64>" }] }
```

with the header `X-Backhouse-Signature: sha256=<hex HMAC-SHA256 of the raw body with INBOUND_EMAIL_SECRET>`. A small adapter maps each provider's own format to this.

- **Retries:** deduplicated by `messageId`.
- **Ignored attachments:** images under 20 KB (logos, signatures).
- **PDF and XML together:** when an email carries both copies of a ZATCA invoice, only the XML is used.
- **Unknown senders:** invoices from addresses not on the supplier's list are kept for a person to check, even when the supplier is recognised.

## Not yet

- **Storage:** documents are stored in Postgres, and move to object storage when volume needs it.
- **ZATCA phase 2 issuing** (for suppliers and central kitchens on Backhouse) and posting to accounting systems.
