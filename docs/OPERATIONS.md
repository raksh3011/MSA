# ORVMS — Operations guide

How the platform is run: environments, scheduled processing, monitoring, backup and restore. (NFR-11)

## Environments

| Environment | How | Database | Purpose |
|---|---|---|---|
| local | `npm run live` | local D1 under `.wrangler/state` (git-ignored) | development, demo |
| staging | `npx wrangler deploy --env staging` or the *Deploy* workflow with `environment = staging` | `orvms-staging` D1 | rehearse releases and migrations |
| production | `npx wrangler deploy` or the workflow with `environment = production` | `orvms` D1 | customers |

Each environment has its own secrets: `wrangler secret put JWT_SECRET [--env staging]`, `SEED_PASSWORD`, `AISSTREAM_API_KEY`. The `ENVIRONMENT` variable is shown on the operations console.

**Release procedure:** CI green (lint, strict types, tests, audit, build, CodeQL) → deploy to staging → check *Operations* (schema version, background errors = 0) and walk through the demo → deploy to production. Database migrations are applied by the Worker itself on boot and are additive, so a rollback of the code is safe.

## Scheduled processing

A single Durable Object tick (every few seconds, only while someone is connected, to stay within the free tier) runs idempotent sweepers:

| Job | Frequency | What it does |
|---|---|---|
| Voyage monitor | every tick | deviation and unplanned risk-area alerts for active voyages |
| SLA sweeper | every tick | escalates overdue cases (L1 desk lead, L2 regional controller) |
| Shipment sweeper | every tick | keeps shipment status in step with voyages; raises `shipment.at_risk` |
| Month-end billing | ≤ every 10 min | invoices the previous month for every active customer (unique per organisation and period, so re-runs are safe) |
| Scheduled reports | ≤ every 10 min | produces last month's report pack for customers on a monthly schedule |
| Retention purge | ≤ hourly | deletes stored reports and webhook delivery logs older than each customer's retention setting |

Because the tick only runs while a user is connected, a deployment with no traffic over a month-end catches up at the next visit. For guaranteed timing add a Cloudflare Cron Trigger that calls the same background function.

## Monitoring

*Operations* (platform admin) shows version and environment, uptime, storage engine and schema version, live-feed health (source, last message, errors), scheduled-job status, webhook delivery success over 24 h, record counts and the latest 80 structured log events. Every event is also written as one JSON line to the console (`wrangler tail` / Workers Logs):

```json
{"t":"2026-10-31T15:52:17.000Z","level":"info","event":"invoice.issued","org":"org-boc","number":"INV-202609-BOC","totalInr":75520}
```

Alert thresholds to configure in Cloudflare: Worker error rate, D1 errors, and the log event `background.failed`.

## Backup and restore

* **Platform backup:** *Operations → Download platform backup* (or `GET /api/admin/backup` as admin) returns every tenant's data as JSON (`orvms.platform-backup/1`). API-key hashes and webhook secrets are excluded. Store it off-platform; schedule it weekly.
* **Tenant export:** *Billing → Export all my data* (or `GET /api/org/export`) gives a customer its own records (`orvms.tenant-export/1`): data portability and exit.
* **D1 point-in-time recovery:** D1 keeps 30 days of history on the paid plan and a shorter window on the free plan: `wrangler d1 time-travel restore orvms --timestamp=<ISO time>`.
* **Restore drill:** restore into the *staging* database (`wrangler d1 time-travel restore orvms-staging …` or import the SQL export), deploy staging, and check the record counts on *Operations* against the backup's `tenants` array. Do this once per quarter.
* **Identity data** (users, password hashes, audit trail) and live vessel state live in the Durable Object's storage, not D1; they are rebuilt from the feed or re-seeded, and users are re-created by the platform admin if the object is lost.

## Data retention

Per customer (`Billing → settings`): 6, 12, 24, 36 or 60 months for stored reports and webhook delivery logs. Invoices and contracts are kept for the contract life (statutory record-keeping). The audit trail is capped in memory and exported with the platform backup.

## Runbook (common incidents)

| Symptom | Check | Action |
|---|---|---|
| No live vessels | *Operations → Live data feed* | verify `AISSTREAM_API_KEY`; the feed reconnects with back-off |
| Invoices missing at month start | *Operations → Scheduled processing* | open the app once (tick) or *Revenue → Run month-end billing* |
| Webhook failures | *Operations → Webhook delivery*; *Organisation → Deliveries* | customer endpoint down; deliveries retry 3 times, then stay `failed` in the log |
| Customer locked out | *Customers* | check the account is not suspended; reset by creating a new user |
