/** Periodic business processing: voyage monitoring, SLA escalation and alert → webhook publishing. */
import { sweepCases } from './cases';
import { emit, type Services } from './context';
import { runBilling } from './billing';
import { fleetMmsis } from './org';
import { runRetention, runScheduledReports } from './reports';
import { sweepShipments } from './shipments';
import { monitorVoyages } from './voyages';

const HOUSEKEEPING_MS = 10 * 60_000;
const published = new WeakMap<Services, Set<string>>();

/** Publish `alert.created` for alerts about vessels in an organisation's fleet that has a subscribed webhook. */
export async function publishNewAlerts(s: Services): Promise<number> {
  const seen = published.get(s) ?? new Set<string>();
  published.set(s, seen);
  const fresh = s.hub.alerts.filter((a) => !seen.has(a.id));
  if (seen.size === 0) {
    // first run: do not replay history
    for (const a of s.hub.alerts) seen.add(a.id);
    return 0;
  }
  if (fresh.length === 0) return 0;
  for (const a of fresh) seen.add(a.id);
  if (seen.size > 5000) [...seen].slice(0, 2500).forEach((id) => seen.delete(id));
  let n = 0;
  for (const org of await s.repo.orgs.list()) {
    if (org.kind !== 'shipping_company') continue;
    const hooks = (await s.repo.webhooks.list(org.id)).filter((w) => w.active && w.events.includes('alert.created'));
    if (hooks.length === 0) continue;
    const fleet = await fleetMmsis(s, org.id);
    for (const a of fresh.filter((x) => fleet.has(x.mmsi))) {
      emit(s, org.id, 'alert.created', { alertId: a.id, rule: a.ruleId, severity: a.severity, mmsi: a.mmsi, vessel: a.vesselName, message: a.message, lat: a.lat, lon: a.lon });
      n++;
    }
  }
  return n;
}

/** One pass of all background business processes. Safe to call every few seconds. */
export async function runBackground(s: Services): Promise<{ voyageAlerts: number; escalations: number; shipmentAlerts: number; published: number; invoices: number; reports: number }> {
  const t0 = Date.now();
  const st = s.state;
  st.backgroundRuns++;
  try {
    const voyageAlerts = await monitorVoyages(s);
    const escalations = await sweepCases(s);
    const shipmentAlerts = await sweepShipments(s);
    const published = await publishNewAlerts(s);
    // slower housekeeping: month-end billing, scheduled report packs and retention run at most every 10 minutes
    let invoices = 0;
    let reports = 0;
    const now = s.now();
    if (now - st.lastBilling >= HOUSEKEEPING_MS) {
      st.lastBilling = now;
      invoices = await runBilling(s);
    }
    if (now - st.lastReports >= HOUSEKEEPING_MS) {
      st.lastReports = now;
      reports = await runScheduledReports(s);
    }
    if (now - st.lastRetention >= HOUSEKEEPING_MS * 6) {
      st.lastRetention = now;
      await runRetention(s);
    }
    const result = { voyageAlerts, escalations, shipmentAlerts, published, invoices, reports };
    st.lastBackground = { at: now, ms: Date.now() - t0, result };
    if (escalations > 0) s.log('warn', 'case.escalations', { count: escalations });
    return result;
  } catch (e) {
    st.backgroundErrors++;
    s.log('error', 'background.failed', { message: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}
