# Operations

What keeps production healthy, and the dashboard steps that can't be done from the code.

## Go-live checklist

| | What | Where | Status |
|---|---|---|---|
| 1 | Automatic deploys from `main` after CI passes | Railway → each of `api`, `worker`, `web` → Settings → Source: connect `amanmaher333/backhouse-app`, branch `main`, turn on **Wait for CI** | Not set; deploys are manual today |
| 2 | Daily Postgres backups | Railway → `postgres` → Backups → schedule **Daily** (and Weekly) | Not set; no backup has been taken |
| 3 | Bigger database volume | Railway → `postgres` → Settings → Volume. 500 MB today (about 120 MB used) | Needs a plan with larger volumes |
| 4 | Plan | Railway → Workspace → Plan. Hobby today; Pro adds larger volumes, backups retention and team access | Decide before the first paying customer |
| 5 | Error reporting | Create a Sentry project (platform: Node.js), copy its DSN, set `SENTRY_DSN` on `api` and `worker` | Code ready; off until the DSN is set |
| 6 | Own domain | `kitchain.online`: `app.kitchain.online` → `web` (port 8080), `api.kitchain.online` → `api` (port 3000). CNAME and `_railway-verify` TXT records at the registrar. The bare domain and `www` are left for the marketing site | Done for `app`; `PUBLIC_WEB_URL` = `https://app.kitchain.online` on `api` and `worker` |

## Error reporting (Sentry)

Off unless `SENTRY_DSN` is set; with it unset every report is a no-op.

- **API:** unexpected errors only (the ones that answer 500). Validation errors, 404s, permission refusals and duplicate records are answers, not faults, and aren't sent.
- **Worker:** any error in a loop pass (agents, billing, ZATCA, Foodics, WhatsApp).
- **Browser:** uncaught errors, rejected promises, and pages that crash while rendering. The web app posts them to `POST /v1/client-errors`, which forwards them to Sentry, so the web build needs no Sentry key. Limited to 20 reports a minute per person and 120 overall per API instance; at most 10 distinct errors per page load; noise from browser extensions and `ResizeObserver` is dropped.
- A page that crashes shows "Something went wrong" with Try again / Back to the inbox, inside the normal app shell.

What an event contains: the error and stack, the route pattern (`/v1/purchase-orders/:id/send`, never the full URL), the page path without its query string, the request id, and the person's user and organisation ids. Never request bodies, headers, cookies, IP addresses, names, emails, phone numbers or what someone typed. No tracing or automatic instrumentation, so outgoing calls to Foodics, WhatsApp or Moyasar aren't recorded.

Each event is tagged with the service (`api`, `worker`, `web`), the environment (`SENTRY_ENVIRONMENT`, default `NODE_ENV`) and the release (the Railway commit, or `SENTRY_RELEASE`).

To find who was affected, look the user or organisation id up in the platform admin; the request id matches the audit log.

## Backups and restore

Once daily backups are on (checklist item 2), test a restore before relying on them:

1. Railway → `postgres` → Backups → pick the latest → **Restore**. Railway restores into the same service after confirmation, so do the first drill on a copy: duplicate the environment (Project → Environments → Duplicate) and restore there.
2. Point a local API at the restored database (`DATABASE_URL=...`) and check `/v1/health`, sign in, and open the inbox and food cost pages.
3. Write down how long it took. Repeat every quarter.

Until backups are on, a manual copy can be taken with `pg_dump "$DATABASE_URL" -Fc -f kitchain-$(date +%F).dump` using the database's public URL.
