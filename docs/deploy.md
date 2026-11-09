# Deploying Backhouse (Railway)

Four services in one Railway project, built from this repository's Dockerfiles:

| Service | Build | Start | Notes |
|---|---|---|---|
| `postgres` | Railway Postgres | – | |
| `api` | `Dockerfile.api` | migrations, then the API | Public domain, for webhooks (WhatsApp, Moyasar, invoice email) |
| `worker` | `Dockerfile.api` | `node dist/worker.js` | No domain. Runs agents, billing, WhatsApp delivery and ZATCA submissions |
| `web` | `Dockerfile.web` | `next start` | Public domain; this is the app people open |

Build and start settings are in the repo:
- `railway.json` (repo root) is the **api** service: the default for any service from this repo.
- `railway/worker.json` is the **worker**: in that service's Settings, set *Config-as-code → Railway config file* to `/railway/worker.json`.
- `railway/web.json` is the **web** app: set that service's config file to `/railway/web.json`.

Pushes to `main` redeploy automatically.

## Variables

**api and worker:**

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{postgres.DATABASE_URL}}` |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | long random strings |
| `ZATCA_SECRET_KEY` | 32+ random characters (encrypts e-invoicing keys) |
| `PUBLIC_WEB_URL` | the web service's URL |
| `NODE_ENV` | `production` |
| `AGENTS_LLM` / `ANTHROPIC_API_KEY` | optional: AI-written task text and invoice reading |
| `WHATSAPP_*`, `MOYASAR_*`, `WATHQ_API_KEY`, `INBOUND_EMAIL_SECRET`, `ZATCA_MODE=live` | when those integrations go live; until then everything runs in simulated mode |

**web:**

| Variable | Value |
|---|---|
| `BOH_API_URL` | `http://api.railway.internal:3000` (private network) or the API's public URL |
| `PORT` | set by Railway |

## Data location

Railway runs in the US and EU. That's fine for a pilot under a data processing agreement. Saudi customers who require in-Kingdom hosting can run the same images on a Saudi cloud (e.g. Google Cloud Dammam) with Postgres there.
