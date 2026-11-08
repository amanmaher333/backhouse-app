# WhatsApp setup and message templates

BOH sends approval cards on WhatsApp through Meta's WhatsApp Business Cloud API.

- **Inside the 24-hour window** (the person wrote to BOH in the last 24 hours, for example by linking or tapping a button): an interactive message with reply buttons. No template is needed, and Meta does not charge for it.
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
| `WHATSAPP_BUSINESS_NUMBER` | BOH's number in E.164, shown to people for linking. |
| `WHATSAPP_TEMPLATE_APPROVAL`, `WHATSAPP_TEMPLATE_NOTICE` | Template names, if yours differ. |
| `WHATSAPP_PROMPT_TTL_HOURS` | How long a card's buttons stay valid (default 72). |
| `PUBLIC_WEB_URL` | Base URL for "open in BOH" links. |

**Webhook:** `https://<api>/v1/webhooks/whatsapp`. Subscribe to the `messages` field. BOH uses incoming messages, button replies and delivery statuses.

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
| 2 | URL (dynamic) | افتح في BOH | Open in BOH | `https://app.boh.sa/inbox?task={{1}}` |

### `boh_task_notice`

This one is used when the task is above the organisation's WhatsApp approval limit (Settings → WhatsApp). The person can reject from WhatsApp, but approving has to happen in BOH.

Arabic body:

```
{{1}} يحتاج قرارك:
{{2}}

{{3}}

هذا أعلى من حد الاعتماد عبر واتساب. اعتمده من BOH.
```

English body:

```
{{1}} needs your decision:
{{2}}

{{3}}

This is above the limit for approving on WhatsApp. Approve it in BOH.
```

Buttons, in this order:

| # | Type | Arabic | English | Value |
|---|---|---|---|---|
| 0 | Quick reply | رفض | Reject | payload set per message |
| 1 | URL (dynamic) | افتح في BOH | Open in BOH | `https://app.boh.sa/inbox?task={{1}}` |

## Security model

- **Linking:** a person proves they hold a number by sending a one-time code (valid for 15 minutes) *from* that number. Only the code's hash is stored. A number can be linked to only one account.
- **Taps:** button payloads carry a random prompt id. BOH acts on a tap only if:
  - it comes from the number the card was sent to;
  - the card hasn't been used and hasn't expired;
  - the task is still open;
  - for Approve, the task is within the org's WhatsApp limit;
  - the person still has the permissions needed for that site at the moment of the tap.
- **Same path as the web:** a decision runs through the same runtime code as the web inbox (agent guardrails, spend limits, separation of duties). It's audited with request id `whatsapp:<message id>`, and the task records `decided_via = whatsapp`.
- **Webhooks:** each webhook is accepted only with a valid signature. Retries are deduplicated by message id, and delivery statuses never move backwards.
- **Opting out:** people can send `STOP` / `إيقاف` to pause cards, `START` / `تشغيل` to resume, or turn cards off in Settings.
