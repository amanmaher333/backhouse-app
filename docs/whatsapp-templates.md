# WhatsApp setup and message templates

Backhouse sends approval cards on WhatsApp through Meta's WhatsApp Business Cloud API.

- **Inside the 24-hour window** (the person wrote to Backhouse in the last 24 hours, for example by linking or tapping a button): an interactive message with reply buttons. No template is needed, and Meta does not charge for it.
- **Outside the window:** one of the templates below. Templates must be approved by Meta before use, and are billed as **utility** messages.

## Environment

| Variable | Purpose |
|---|---|
| `WHATSAPP_MODE` | `cloud` to send through Meta. `simulated` (the default when there is no token) stores messages and lets the web app play the phone. |
| `WHATSAPP_TOKEN` | System-user access token with `whatsapp_business_messaging`. |
| `WHATSAPP_PHONE_NUMBER_ID` | The sending number's ID. Webhooks for other numbers are ignored. |
| `WHATSAPP_APP_SECRET` | Meta app secret. Every webhook's `X-Hub-Signature-256` is checked against it. |
| `WHATSAPP_VERIFY_TOKEN` | Any secret string; enter the same value when subscribing the webhook. |
| `WHATSAPP_GRAPH_VERSION` | Default `v25.0`. |
| `WHATSAPP_BUSINESS_NUMBER` | Backhouse's number in E.164, shown to people for linking. |
| `WHATSAPP_TEMPLATE_APPROVAL`, `WHATSAPP_TEMPLATE_NOTICE`, `WHATSAPP_TEMPLATE_DIGEST`, `WHATSAPP_TEMPLATE_SUPPLIER_ORDER`, `WHATSAPP_TEMPLATE_SUPPLIER_FOLLOWUP`, `WHATSAPP_TEMPLATE_SUPPLIER_UPDATE` | Template names, if yours differ. |
| `WHATSAPP_PROMPT_TTL_HOURS` | How long a card's buttons stay valid (default 72). |
| `PUBLIC_WEB_URL` | Base URL for "open in Backhouse" links. |

**Webhook:** `https://<api>/v1/webhooks/whatsapp`. Subscribe to the `messages` field. Backhouse uses incoming messages, button replies and delivery statuses.

## Templates

Create each template in **both Arabic (`ar`) and English (`en`)**, category **Utility**. The variables are the same in every language:

- `{{1}}` the agent's name
- `{{2}}` the headline
- `{{3}}` the details (one line)

### `boh_approval_request`

Arabic body:

```
{{1}} يحتاج قرارك:
{{2}}

{{3}}
```

English body:

```
{{1}} needs your decision:
{{2}}

{{3}}
```

Buttons, in this order:

| # | Type | Arabic | English | Value |
|---|---|---|---|---|
| 0 | Quick reply | اعتماد | Approve | payload set per message |
| 1 | Quick reply | رفض | Reject | payload set per message |
| 2 | URL (dynamic) | افتح في Backhouse | Open in Backhouse | `https://app.boh.sa/inbox?task={{1}}` |

### `boh_task_notice`

This one is used when the task is above the organisation's WhatsApp approval limit (Settings → WhatsApp). The person can reject from WhatsApp, but approving has to happen in Backhouse.

Arabic body:

```
{{1}} يحتاج قرارك:
{{2}}

{{3}}

هذا أعلى من حد الاعتماد عبر واتساب. اعتمده من Backhouse.
```

English body:

```
{{1}} needs your decision:
{{2}}

{{3}}

This is above the limit for approving on WhatsApp. Approve it in Backhouse.
```

Buttons, in this order:

| # | Type | Arabic | English | Value |
|---|---|---|---|---|
| 0 | Quick reply | رفض | Reject | payload set per message |
| 1 | URL (dynamic) | افتح في Backhouse | Open in Backhouse | `https://app.boh.sa/inbox?task={{1}}` |

### `boh_daily_digest`

The morning summary, sent outside the 24-hour window. Keep it factual and non-promotional; that keeps it in the **Utility** category. Variables:

- `{{1}}` the organisation
- `{{2}}` the date
- `{{3}}` a one-line summary, e.g. "3 decisions waiting · 2 deliveries today · 4 items low"

Arabic body:

```
☀️ {{1}} · {{2}}
{{3}}
```

English body: the same.

Buttons, in this order:

| # | Type | Arabic | English | Value |
|---|---|---|---|---|
| 0 | Quick reply | اعرض القرارات | Show decisions | payload set per message |
| 1 | URL (dynamic) | افتح في Backhouse | Open in Backhouse | `https://app.boh.sa/{{1}}` (suffix `inbox`) |

**Show decisions** is the key button. Tapping it opens the 24-hour window, so Backhouse then re-sends up to five waiting approval cards as interactive messages. Those don't need a template and aren't charged separately.

Inside the window, the digest goes out as a full message: the waiting decisions, what agents did on their own, orders (spend approval, due today, late), low stock by site and price rises.

### Digest scheduling

- **When:** each person picks an hour and time zone (default 08:00 Riyadh) and can turn the digest off.
- **One per person per organisation per local day:** a `digest_runs` row claims it first, so several workers or a restart never send twice.
- **Skipped when late:** if the worker was down, a missed digest is still sent up to 4 hours after the chosen hour; after that, that day's is skipped.
- **Quiet days:** nothing is sent; the empty run is still recorded.
- **What it covers:** only what the person's permissions allow (sites, prices, spend approval).

## Supplier templates

Backhouse writes to suppliers from the same number, on behalf of the restaurant. These templates are registered in **Arabic** (`ar`), the language Saudi suppliers use. The free-form versions sent inside the window are bilingual (Arabic first).

### `boh_purchase_order` (Utility)

Variables:

- `{{1}}` restaurant
- `{{2}}` order number
- `{{3}}` site
- `{{4}}` delivery date
- `{{5}}` summary, e.g. "2 أصناف · 605.76 ر.س شامل الضريبة" (just the item count when the supplier's prices are hidden)

Body:

```
طلب شراء جديد من {{1}}
رقم الطلب: {{2}}
التوصيل إلى: {{3}}
موعد التوصيل: {{4}}
{{5}}
```

Buttons, in this order:

| # | Type | Text | Value |
|---|---|---|---|
| 0 | Quick reply | تأكيد / Confirm | payload set per message |
| 1 | Quick reply | مشكلة / Problem | payload set per message |
| 2 | URL (dynamic) | عرض الطلب | `https://app.boh.sa/s/{{1}}` (suffix: the order's private token) |

### `boh_supplier_followup` (Utility)

Used for a late-delivery chaser or a price question, after a person approved it. Variables:

- `{{1}}` restaurant
- `{{2}}` subject (e.g. "الطلب PO-00012")
- `{{3}}` message

Body:

```
رسالة من {{1}} بخصوص {{2}}:
{{3}}

يمكنك الرد هنا وسنوصل ردك.
```

No buttons.

### `boh_supplier_update` (Utility, to restaurant staff; ar + en)

Sent when a supplier reports a problem or replies about an order. Variables:

- `{{1}}` supplier
- `{{2}}` order number
- `{{3}}` what they said

Body:

```
{{1}} ردّ بخصوص الطلب {{2}}:
{{3}}
```

Button: URL "افتح الطلب" / "Open order", `https://app.boh.sa/{{1}}` (suffix `orders/<id>`).

### How supplier replies work

- **Confirm** (WhatsApp button or the order link): recorded once on the order, with where it came from.
- **Problem:** Backhouse asks for one message describing it, and takes the supplier's next message within 2 hours as the description. (On the link, they type it straight away.) The problem is:
  - stored on the order;
  - sent as a WhatsApp notice to people who manage that site's orders and have notifications on;
  - added to the inbox as a high-priority Purchasing task.
- **Any other text** from a supplier's number is attached to their latest order from Backhouse (within 30 days), relayed the same way, and acknowledged.
- **Safety checks:**
  - buttons only work from the number the order was sent to;
  - order links are random 192-bit tokens, stored hashed, and expire after 45 days;
  - suppliers see only that one order (prices hidden if the supplier is set to "hide prices on PO").
- **Webhook URL:** point Meta at the **API** host (`/v1/webhooks/whatsapp`), not the web app; the web proxy does not forward signatures.

## Security model

- **Linking:** a person proves they hold a number by sending a one-time code (valid for 15 minutes) *from* that number. Only the code's hash is stored. A number can be linked to only one account.
- **Taps:** button payloads carry a random prompt id. Backhouse acts on a tap only if:
  - it comes from the number the card was sent to;
  - the card hasn't been used and hasn't expired;
  - the task is still open;
  - for Approve, the task is within the org's WhatsApp limit;
  - the person still has the permissions needed for that site at the moment of the tap.
- **Same path as the web:** a decision runs through the same runtime code as the web inbox (agent guardrails, spend limits, separation of duties). It's audited with request id `whatsapp:<message id>`, and the task records `decided_via = whatsapp`.
- **Webhooks:** each webhook is accepted only with a valid signature. Retries are deduplicated by message id, and delivery statuses never move backwards.
- **Opting out:** people can send `STOP` / `إيقاف` to pause cards, `START` / `تشغيل` to resume, or turn cards off in Settings.
