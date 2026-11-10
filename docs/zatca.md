# ZATCA phase 2 e-invoicing (issuing)

Kitchain issues ZATCA phase 2 ("integration phase") e-invoices for an organisation's legal entities: for example a central kitchen selling to franchisees, or catering and event sales. This covers:
- tax invoices (B2B), which ZATCA **clears** before they are shared;
- simplified tax invoices (B2C), which are **reported** within 24 hours;
- credit and debit notes for both.

## Verified against ZATCA

`pnpm --filter @boh/api zatca:check` onboards a throwaway unit on ZATCA's **Developer Portal** with the sandbox OTP. It then submits a standard invoice, credit note and debit note, and a simplified invoice, credit note and debit note, chained with ICV and PIH. ZATCA returns **PASS** for all six (cleared / reported). The check needs network access to `gw-fatoora.zatca.gov.sa`.

The Developer Portal's *production* certificate is a fixed placeholder that does not carry your key. Documents signed with your key therefore can't be verified against it there, so the script only reports those results as information.

**Before go-live:** run a full production cycle in ZATCA's **Simulation** environment, using an OTP from the taxpayer's Fatoora simulation portal.

## Setting up (E-invoicing page)

1. **Company details (Settings):**
   - VAT number and CR number;
   - national address: street, 4-digit building number, district, city, 5-digit postal code.
2. **Register a unit:** name it after the branch or kitchen, then choose:
   - the environment: Simulation to rehearse, Production for real invoices;
   - which invoice kinds it issues.

   Kitchain generates a secp256k1 signing key and ZATCA's certificate signing request.
3. **Onboard:** in the Fatoora portal (fatoora.zatca.gov.sa), choose *Onboard new solution unit/device*, generate a one-time code and enter it. Kitchain then:
   - gets the compliance certificate;
   - submits ZATCA's compliance checks (a sample of each document type the unit issues);
   - gets the production certificate.

   The unit is active when all three succeed. If a step fails, the error is shown and you can retry with a new code.

Only organisation admins (`einvoice:manage`) register and onboard units. Accountants and operations managers issue invoices (`sales_invoice:manage`).

## Issuing (Sales invoices page)

- **Drafting:** a draft can be edited and deleted. Totals are computed per line in halalas, with VAT per category:
  - S: 15%;
  - Z: zero-rated;
  - E: exempt;
  - O: out of scope.

  Z, E and O lines need a `VATEX-SA-…` exemption code.
- **Signing:** issuing signs the document into the unit's chain under a row lock: the next invoice counter (ICV), and the previous document's hash (PIH). It writes:
  - UBL 2.1 XML;
  - the invoice hash (SHA-256 of the canonical document without the signature parts);
  - a XAdES signature with the unit's certificate;
  - the QR code: tags 1–9 for simplified invoices, 1–8 for tax invoices, which ZATCA stamps when clearing.
- **Submission:** tax invoices go to ZATCA's clearance API straight away. Simplified invoices go to the reporting API.
  - If ZATCA can't be reached, the signed invoice waits ("Waiting for ZATCA"), and the worker retries after 1, 5 and 15 minutes, then hourly.
  - A simplified invoice not reported within 24 hours is flagged.
  - A document ZATCA rejects stays in the record and the chain; issue a corrected one.
- **Immutability:** signed documents can't be changed or deleted (a database trigger enforces it). Corrections are credit or debit notes against a cleared or reported invoice.
- **Sharing:** tax invoices should only be shared once cleared. The page shows ZATCA's cleared QR code; **Download XML** gives ZATCA's cleared version for tax invoices and the signed one otherwise, and the page prints.

## Configuration

| Variable | Purpose |
|---|---|
| `ZATCA_MODE` | `simulated` (default): a local stand-in with a test CA; any 6-digit OTP works and nothing leaves the server. `live`: ZATCA's Fatoora API. |
| `ZATCA_SECRET_KEY` | 32+ characters. Encrypts signing keys and ZATCA secrets at rest (AES-256-GCM). **Required in production**; dev and test fall back to a key derived from the JWT secret. |

Behind an HTTP proxy, run Node with `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21) so `fetch` uses it.

## Implementation notes

- **Certificate request:** ZATCA's CSR is built with a small DER encoder (`apps/api/src/zatca/der.ts`, `crypto.ts`), because Node has no CSR builder. It carries:
  - the template name per environment (`TSTZATCA-` for the sandbox, `PREZATCA-` for simulation, `ZATCA-Code-Signing` for production);
  - the EGS serial `1-Kitchain|2-1.0|3-<uuid>`;
  - the VAT number, invoice types, location and industry, in the subject alternative name.
- **Canonical XML:** documents are built as trees and written in canonical form (`xml.ts`).
  - The invoice hash is inclusive C14N 1.1 of the document without `ext:UBLExtensions`, `cac:Signature` and the QR reference. The unit tests check this against libxml2 (`xmllint --c14n11`).
  - The signed-properties digest is exclusive C14N, as ZATCA's validator computes it.
- **ZATCA's encoding conventions:**
  - the first PIH is base64 of the hex SHA-256 of "0";
  - certificate and signed-properties digests are base64 of hex digests;
  - the invoice hash is base64 of the raw digest.

## Not yet

- **PDF/A-3:** a PDF/A-3 with the XML embedded, for sending to buyers. For now, print the page and send the XML alongside.
- **Delivery:** emailing invoices to buyers, and delivering them straight into a buyer's Kitchain invoice inbox when the buyer is on Kitchain.
- **Billing:** Kitchain's own billing invoices through the same engine (they still carry the phase-1 QR).
- **Renewal:** certificate renewal before expiry (`PATCH /production/csids`). The expiry date is shown on the unit.
- **Suppliers:** supplier accounts, so suppliers on Kitchain can issue to restaurants.
