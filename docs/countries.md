# Countries

Backhouse sells in Saudi Arabia first, but the product runs wherever restaurants buy from suppliers. Everything that differs by country comes from a **country profile** (`packages/domain/src/countries.ts`). Only the country's own integrations, such as ZATCA and Wathq in Saudi Arabia, are specific to it.

## Supported countries

| | Currency | VAT | Time zone | Tax number checked | E-invoicing | Register check |
|---|---|---|---|---|---|---|
| Saudi Arabia (default) | SAR | 15% | Asia/Riyadh | 15 digits, starts and ends with 3; CR 10 digits | ZATCA phase 2 | Wathq (automatic) |
| United Arab Emirates | AED | 5% | Asia/Dubai | TRN: 15 digits, starts with 100 | – | Backhouse review |
| Bahrain | BHD | 10% | Asia/Bahrain | 15 digits | – | Backhouse review |
| Kuwait | KWD | none | Asia/Kuwait | – | – | Backhouse review |
| Oman | OMR | 5% | Asia/Muscat | OM + 10 digits | – | Backhouse review |
| Qatar | QAR | none | Asia/Qatar | – | – | Backhouse review |
| Egypt | EGP | 14% | Africa/Cairo | 9 digits | – | Backhouse review |
| Jordan | JOD | 16% | Asia/Amman | 6–12 digits | – | Backhouse review |

## How it's used

- **Sign-up:** the person picks the country where the business is registered. It sets:
  - the organisation's currency, and the language default;
  - the first legal entity's country and currency;
  - the rules for its VAT and CR numbers.
- **Legal entities, sites and suppliers** default to the organisation's country:
  - sites take the country's time zone (any valid IANA zone can be set);
  - suppliers take its currency and VAT rate;
  - a supplier registered in another country defaults to its own currency and 0% VAT, since you're importing.
- **Amounts in messages** (agent tasks, WhatsApp cards, order messages, spend limits, credit-note requests and three-way match differences) use the document's currency: "AED 105.00" / "105.00 د.إ".
- **Time:** late deliveries and monthly spend limits are judged in each site's time zone. The WhatsApp digest takes any time zone, starting from the country of the person's number.
- **Phone numbers** are read in the organisation's country format (05… in Saudi Arabia and the UAE, 8 digits in Bahrain, Kuwait, Oman and Qatar, 01… in Egypt, 07… in Jordan).
- **Company checks:** only Saudi CRs are checked automatically. Elsewhere, companies go to Backhouse's review queue, and once approved they can message suppliers through Backhouse.
- **E-invoicing:** ZATCA units and sales invoices are for Saudi companies only, and the pages are hidden for other organisations.
- **The web app** formats amounts in the organisation's currency, or the document's own currency on order, invoice and sales pages. VAT previews use the organisation's rate.
- **Backhouse's own billing** is in SAR with Saudi VAT, wherever the customer is.

## Not yet

- **Three-decimal currencies:** BHD, KWD, OMR and JOD have three decimal places, but amounts are stored and shown to two.
- **E-invoicing outside Saudi Arabia:** the UAE (Peppol-based, being introduced in phases), Egypt (ETA) and Jordan (JoFotara) would each be a new integration next to ZATCA.
- **Automatic company checks** outside Saudi Arabia.
- **Billing:** billing in other currencies, and payment providers other than Moyasar (e.g. Stripe, Checkout.com, Tap) for customers outside Saudi Arabia.
- **Hosting in the customer's region** for customers who require local data residency.

## Adding a country

1. Add its profile to `COUNTRIES` in `packages/domain/src/countries.ts` (and to `apps/web/src/lib/countries.ts` for the sign-up form).
2. Add its Arabic currency abbreviation to `CURRENCY_AR` in `apps/web/src/lib/i18n.tsx`.
3. If it has mandatory e-invoicing or a register Backhouse should check, add an integration next to ZATCA or Wathq and set `eInvoicing` / `registry` on the profile.
