/** Operations: health snapshot for the platform console, tenant data export and full backup. */
import { MIGRATIONS } from '../data/migrations';
import { periodOf } from '../domain/plans';
import type { Organization } from '../domain/types';
import type { Services } from './context';

export const APP_VERSION = '3.1.0';

export async function opsSnapshot(s: Services) {
  const now = s.now();
  const period = periodOf(now);
  const orgs = await s.repo.orgs.list();
  const companies = orgs.filter((o) => o.kind === 'shipping_company');
  const perOrg = await Promise.all(
    orgs.map(async (o) => {
      const [voyages, shipments, deliveries, apiCalls] = await Promise.all([s.repo.voyages.list(o.id), s.repo.shipments.list(o.id), s.repo.deliveries.list(o.id, 500), s.repo.usage.get(o.id, period, 'api_calls')]);
      return { voyages: voyages.length, shipments: shipments.length, deliveries, apiCalls };
    }),
  );
  const dayAgo = now - 86_400_000;
  const recent = perOrg.flatMap((p) => p.deliveries).filter((d) => d.createdAt >= dayAgo);
  const delivered = recent.filter((d) => d.status === 'delivered').length;
  const [cases, invoices, contracts] = await Promise.all([s.repo.cases.list(), s.repo.invoices.listAll(), s.repo.contracts.list()]);
  const st = s.state;
  const lastRun = st.lastBackground;
  return {
    version: APP_VERSION,
    now,
    uptimeSec: Math.max(0, Math.round((now - st.bootedAt) / 1000)),
    storage: { engine: s.repo.constructor.name === 'SqlRepo' ? 'Cloudflare D1 (SQLite)' : 'In-memory', schemaVersion: MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0, migrations: MIGRATIONS.length },
    feed: { source: s.hub.source, connected: s.hub.feed.connected, synthetic: s.hub.feed.synthetic ?? false, region: s.hub.feed.region ?? null, messages: s.hub.feed.messages ?? 0, lastMessageAt: s.hub.feed.lastMessageAt ?? null, error: s.hub.feed.error ?? null },
    live: { vessels: s.hub.vessels.size, alerts: s.hub.alerts.length, openAlerts: s.hub.alerts.filter((a) => a.status === 'open').length },
    records: {
      organisations: orgs.length,
      customers: companies.length,
      users: s.hub.users.size,
      voyages: perOrg.reduce((a, p) => a + p.voyages, 0),
      shipments: perOrg.reduce((a, p) => a + p.shipments, 0),
      cases: cases.length,
      invoices: invoices.length,
      contracts: contracts.length,
    },
    background: {
      runs: st.backgroundRuns,
      errors: st.backgroundErrors,
      lastRunAt: lastRun?.at ?? null,
      lastRunMs: lastRun?.ms ?? null,
      lastResult: lastRun?.result ?? null,
      lastBilling: st.lastBilling || null,
      lastReports: st.lastReports || null,
      lastRetention: st.lastRetention || null,
    },
    integrations: {
      apiCallsThisMonth: perOrg.reduce((a, p) => a + p.apiCalls, 0),
      webhooks24h: recent.length,
      webhookSuccessPct: recent.length ? Math.round((delivered / recent.length) * 1000) / 10 : null,
      webhookFailed24h: recent.filter((d) => d.status === 'failed').length,
    },
    environment: { name: st.environment },
    logs: st.logs.slice(-80).reverse(),
  };
}

/** Everything one tenant owns, as portable JSON (data-portability / exit). Secrets (API key hashes, webhook secrets) are excluded. */
export async function exportOrganization(s: Services, org: Organization) {
  const [registry, voyages, shipments, cases, contract, invoices, reports, keys, hooks] = await Promise.all([
    s.repo.registry.list(org.id), s.repo.voyages.list(org.id), s.repo.shipments.list(org.id), s.repo.cases.list({ orgId: org.id }), s.repo.contracts.get(org.id),
    s.repo.invoices.list(org.id), s.repo.reports.list(org.id), s.repo.apiKeys.list(org.id), s.repo.webhooks.list(org.id),
  ]);
  return {
    exportedAt: s.now(),
    schema: 'orvms.tenant-export/1',
    organisation: org,
    contract,
    registry, voyages, shipments, cases, invoices, reports,
    apiKeys: keys.map(({ hash: _h, ...k }) => k),
    webhooks: hooks.map(({ secret: _s, ...w }) => w),
  };
}

/** Platform backup: every tenant's export in one document (run on a schedule and store off-platform). */
export async function backupAll(s: Services) {
  const orgs = await s.repo.orgs.list();
  return {
    exportedAt: s.now(),
    schema: 'orvms.platform-backup/1',
    schemaVersion: MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0,
    tenants: await Promise.all(orgs.map((o) => exportOrganization(s, o))),
  };
}
