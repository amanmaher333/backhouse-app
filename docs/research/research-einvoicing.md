# GCC E-Invoicing: What It Means for Us (checked 2026-11-08)

> Sources are mostly vendor and advisory blogs; several dates conflict. **Verify against the UAE Ministry of Finance / FTA and ZATCA before committing.**

## UAE
- **Model:** decentralised Peppol "5-corner" model. Each business must appoint an **Accredited Service Provider (ASP)**. The format is **PINT AE** (Peppol PINT / UBL with UAE extensions). The ASP also reports the tax data to the FTA.
- **Timeline (sources vary):**
  - Voluntary phase / pilot: about July–August 2026.
  - Large businesses (revenue ≥ AED 50M): **mandatory 1 Jan 2027**. ASP appointment deadline reported as 31 Jul 2026, later extended to **30 Oct 2026** by a Cabinet amendment (unconfirmed against the official gazette).
  - Businesses under AED 50M: **mandatory 1 Jul 2027**. ASP deadline reported as 31 Mar 2027.
  - B2G: about 1 Oct 2027.
  - **B2C (restaurant → diner) is excluded** for now.
- **Becoming an ASP:** you must already be a Peppol-certified service provider, and the solution must have been running for a minimum period (reported as about **2 years**). **We can't be an ASP in years 1–2. We have to partner with one.**

## Saudi Arabia (ZATCA "Fatoora" Phase 2: integration)
- Invoices are signed XML (UBL) with a cryptographic stamp and QR code. **B2B invoices are cleared in real time** by ZATCA. B2C (simplified) invoices are reported within 24 hours.
- Waves: Wave 23 (> SAR 750k) deadline 31 Mar 2026; Wave 24 (> SAR 375k) deadline 30 Jun 2026; **Wave 25 (> SAR 187.5k, covering even voluntarily VAT-registered small businesses) integration 1 Feb 2027**.
- So by early 2027, almost every VAT-registered supplier in KSA issues structured XML invoices.
- Restaurant B2C invoices are normally handled by the POS (Foodics etc.), not by us.

## What this means for the product
1. **Structured invoices replace AI scanning.** From 2027, most supplier invoices in the UAE and KSA exist as structured XML. If we receive them (as the buyer's endpoint via an ASP partner in the UAE; by XML/PDF-A3 ingestion in KSA), we get exact line data with no scanning step. AI extraction remains for non-compliant, small or cross-border suppliers and for delivery notes.
2. **Supplier acquisition hook (the big one).** Hundreds of thousands of small food suppliers (under AED 50M / SAR 187.5k+) must comply in Feb–Jul 2027 and many have no system. **We offer a free, compliant invoicing and ordering portal for suppliers** (issuing through our ASP partner in the UAE, and our own ZATCA-compliant issuing module in KSA). They join the network to meet a legal requirement and start receiving orders from our restaurants. The deadline is a one-off opportunity: time-limited and starting now.
3. **Central kitchens and B2B sellers** among our customers must issue compliant e-invoices for their sales → build it into central kitchen / B2B invoicing.
4. **How strong is this as a moat?** Moderate on its own (plenty of ASPs and compliance vendors exist). It's strong as a **way to win suppliers** into the network, and as a source of clean, structured price data for the benchmark.

## Recommended path
- **Now:** partner with one UAE ASP (receiving + issuing APIs) and use a ZATCA SDK for KSA. Store PINT AE / UBL in the data model from day one.
- **Year 2:** become a Peppol-certified service provider (OpenPeppol membership plus an access point). Start the clock toward UAE ASP accreditation.
- **Year 3+:** apply for ASP accreditation, if it still makes sense.

## Sources
- [EDICOM: UAE B2B e-invoicing](https://edicomgroup.com/blog/united-arab-emirates-electronic-invoicing-project)
- [Banqup: UAE phased mandate rollout](https://www.banqup.com/resources/blog/uae-confirms-phased-e-invoicing-mandate-rollout)
- [Hawksford: UAE e-invoicing timeline](https://www.hawksford.com/insights-and-guides/uae-e-invoicing)
- [Infinite IT: Peppol in the UAE 2026–2027](https://infinite-it.com/en/blog/peppol-e-invoicing-uae-guide)
- [vatcalc: UAE e-invoicing guidelines](https://www.vatcalc.com/uae/uae-e-invoice-plans-2022/)
- [Taxilla: UAE mandate & Peppol model](https://www.taxilla.com/uae-e-invoicing-mandate-peppol-compliance-guide)
- [Henry Club: UAE Peppol timeline](https://www.henryclub.ae/tax-compliance/einvoicing-uae/)
- [KPMG: UAE mandatory e-invoicing fields](https://kpmg.com/us/en/taxnewsflash/news/2026/02/uae-technical-guidance-mandatory-e-invoicing-fields.html)
- [Deixtra: ZATCA Wave 25](https://deixtra.com/blog/zatca-e-invoicing-phase-2-wave-25-integration-guide)
- [Kaidolab: ZATCA waves 2026](https://kaidolab.com/blog/zatca-phase-2-waves-2026/)
- [RTC Suite: KSA e-invoicing 2026](https://rtcsuite.com/e-invoicing-saudi-arabia/)
- [Out2Sol: ZATCA Phase 2 explained](https://out2sol.global/blog/zatca-e-invoicing-phase-2-integration-explained/)
