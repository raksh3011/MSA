/** Enterprise screens: supply-chain control tower, voyages, fleet registry, case desk, organisation admin, platform admin. */
import type { LatLon } from '../core/geo';
import { highRiskZoneOf } from '../core/engine';
import { nearestStation } from '../core/stations';
import type { RiskAssessment, Voyage } from '../domain/types';
import type { ShipmentView, SupplyChainSummary } from '../domain/supplychain';
import type { CaseRecord, Organization, Plan, RegistryVessel, Shipment } from '../domain/types';
import { slaRemainingMinutes } from '../domain/cases';
import type { Ctx } from './ctx';
import { clear, fmtDateTime, h } from './dom';
import { CATEGORY_TEXT } from './report';

// ── helpers ──────────────────────────────────────────────────────────────────
export const inr = (n: number): string => (n >= 1e7 ? `₹${(n / 1e7).toFixed(2)} Cr` : n >= 1e5 ? `₹${(n / 1e5).toFixed(2)} L` : `₹${Math.round(n).toLocaleString('en-IN')}`);
const place = (ctx: Ctx, id: string): string => ctx.catalog()?.ports.find((p) => p.id === id)?.name ?? id;
const dt = (ts: number): string => fmtDateTime(ts);
const toLocalInput = (ts: number): string => new Date(ts).toISOString().slice(0, 16);
const fromLocalInput = (v: string): number => Date.parse(`${v}:00Z`);
const field = (label: string, input: HTMLElement): HTMLElement => h('div', { class: 'fld' }, h('label', {}, label), input);
const loading = (): HTMLElement => h('p', { class: 'empty' }, 'Loading…');
const money = (n: number): string => inr(n);

const RISK_CLASS: Record<string, string> = { on_track: 'ok', at_risk: 'warn', late: 'bad', unplanned: 'muted', low: 'ok', medium: 'warn', high: 'bad', critical: 'crit' };
const RISK_TEXT: Record<string, string> = { on_track: 'On track', at_risk: 'At risk', late: 'Late', unplanned: 'No vessel', low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' };
const riskBadge = (r: string, extra = ''): HTMLElement => h('span', { class: `rbadge ${RISK_CLASS[r] ?? 'muted'}` }, `${RISK_TEXT[r] ?? r}${extra}`);

const select = (options: Array<[string, string]>, value?: string): HTMLSelectElement => {
  const s = h('select', {}, ...options.map(([v, label]) => h('option', { value: v }, label))) as HTMLSelectElement;
  if (value !== undefined) s.value = value;
  return s;
};

function showError(box: HTMLElement, message: string): void {
  box.textContent = message;
}

// ── supply chain control tower ───────────────────────────────────────────────
export function supplyChainPage(ctx: Ctx): HTMLElement {
  const root = h('div', { class: 'page-inner wide' });
  const body = h('div', {}, loading());
  root.append(h('div', { class: 'page-head' }, h('h2', {}, 'Supply-chain control tower')), h('p', { class: 'muted' }, 'Customer shipments carried by your voyages: live ETA from the vessel position, delivery risk against the committed date, and cargo value exposed to risk areas.'), body);

  const load = async (): Promise<void> => {
    const r = await ctx.api<{ summary: SupplyChainSummary; shipments: ShipmentView[] }>('GET', '/api/supply-chain/overview');
    const voyages = await ctx.api<{ voyages: Voyage[] }>('GET', '/api/voyages');
    clear(body);
    if (r.status !== 200) return void body.append(h('p', { class: 'error' }, 'Could not load shipments'));
    const { summary, shipments } = r.data;
    const open = shipments.filter((s) => s.status === 'booked' || s.status === 'in_transit');
    const kpi = (v: string, label: string, cls = ''): HTMLElement => h('div', { class: `stat ${cls}` }, h('strong', {}, v), label);
    body.append(
      h('div', { class: 'stats' }, kpi(String(summary.inTransit), 'shipments in transit'), kpi(money(summary.valueInTransitInr), 'cargo value in transit'), kpi(money(summary.valueAtRiskInr), 'value through risk areas', summary.valueAtRiskInr > 0 ? 'warnstat' : ''), kpi(String(summary.atRisk + summary.late), 'deliveries at risk / late', summary.atRisk + summary.late > 0 ? 'badstat' : ''), kpi(String(summary.unplanned), 'awaiting a vessel')),
    );

    // new shipment form
    const f = {
      reference: h('input', { placeholder: 'PO-2026-1300', maxlength: '40' }) as HTMLInputElement,
      customer: h('input', { placeholder: 'Customer', maxlength: '80' }) as HTMLInputElement,
      commodity: h('input', { placeholder: 'Commodity', maxlength: '80' }) as HTMLInputElement,
      cargo: select((ctx.catalog()?.cargoTypes ?? []).map((c) => [c, c.replace(/_/g, ' ')]), 'general'),
      quantity: h('input', { type: 'number', value: '1000', min: '1' }) as HTMLInputElement,
      unit: h('input', { value: 'MT', maxlength: '12' }) as HTMLInputElement,
      value: h('input', { type: 'number', value: '50000000', min: '0' }) as HTMLInputElement,
      incoterm: select((ctx.catalog()?.incoterms ?? []).map((c) => [c, c]), 'FOB'),
      origin: select((ctx.catalog()?.ports ?? []).map((p) => [p.id, p.name]), 'INBOM'),
      dest: select((ctx.catalog()?.ports ?? []).map((p) => [p.id, p.name]), 'INCOK'),
      by: h('input', { type: 'datetime-local', value: toLocalInput(ctx.nowMs() + 10 * 86_400_000) }) as HTMLInputElement,
      voyage: select([['', '— allocate later —'], ...voyages.data.voyages.filter((v) => !['completed', 'cancelled', 'rejected'].includes(v.status)).map((v): [string, string] => [v.id, `${v.reference} · ${v.vesselName}`])], ''),
    };
    const err = h('p', { class: 'error', role: 'alert' });
    const form = h(
      'details',
      { class: 'card' },
      h('summary', { class: 'card-sum' }, '＋ New shipment'),
      h(
        'form',
        {
          class: 'grid-form',
          onsubmit: async (e: Event) => {
            e.preventDefault();
            const res = await ctx.api<{ error?: string }>('POST', '/api/shipments', {
              reference: f.reference.value, customer: f.customer.value, commodity: f.commodity.value, cargo: f.cargo.value, quantity: Number(f.quantity.value), unit: f.unit.value,
              valueInr: Number(f.value.value), incoterm: f.incoterm.value, originPort: f.origin.value, destinationPort: f.dest.value, requiredBy: fromLocalInput(f.by.value), voyageId: f.voyage.value || undefined,
            });
            if (res.status === 201) {
              ctx.toast('Shipment created', 'ok');
              await load();
            } else showError(err, res.data.error ?? 'Could not create the shipment');
          },
        },
        field('Reference (PO / booking)', f.reference), field('Customer', f.customer), field('Commodity', f.commodity), field('Cargo type', f.cargo), field('Quantity', f.quantity), field('Unit', f.unit),
        field('Value (INR)', f.value), field('Incoterm', f.incoterm), field('From', f.origin), field('To', f.dest), field('Must arrive by (UTC)', f.by), field('Carrying voyage', f.voyage),
        h('div', { class: 'full' }, err, h('button', { class: 'btn primary', type: 'submit' }, 'Create shipment')),
      ),
    );
    body.append(form);

    if (shipments.length === 0) return void body.append(h('p', { class: 'empty' }, 'No shipments yet.'));
    const eligible = voyages.data.voyages.filter((v) => !['completed', 'cancelled', 'rejected'].includes(v.status));
    const rows = shipments.map((s) => {
      const detail = h('tr', { class: 'detail-row', hidden: true }, h('td', { colspan: '9' }, s.advisories.length ? h('ul', { class: 'advice' }, ...s.advisories.map((a) => h('li', {}, a))) : h('span', { class: 'muted' }, 'No action needed.'), h('div', { class: 'muted small' }, `History: ${s.history.map((e) => `${e.action}`).join(' → ')}`)));
      const slack = s.slackHours;
      const allocate = ((): HTMLElement | null => {
        if (s.status === 'delivered' || s.status === 'cancelled') return null;
        const sel = select([['', s.voyageId ? 'Re-allocate…' : 'Allocate to voyage…'], ...eligible.map((v): [string, string] => [v.id, `${v.reference} · ${v.vesselName}`])], '');
        sel.addEventListener('change', async () => {
          if (!sel.value) return;
          const res = await ctx.api<{ error?: string }>('PUT', `/api/shipments/${s.id}`, { voyageId: sel.value });
          ctx.toast(res.status === 200 ? 'Shipment allocated' : (res.data.error ?? 'Failed'), res.status === 200 ? 'ok' : 'warn');
          await load();
        });
        return sel;
      })();
      return [
        h(
          'tr',
          { class: 'clickable', onclick: () => { detail.hidden = !detail.hidden; } },
          h('td', {}, h('strong', {}, s.reference), h('div', { class: 'muted small' }, s.customer)),
          h('td', {}, s.commodity, h('div', { class: 'muted small' }, `${s.quantity.toLocaleString()} ${s.unit} · ${s.incoterm}`)),
          h('td', {}, `${place(ctx, s.originPort)} → ${place(ctx, s.destinationPort)}`),
          h('td', {}, money(s.valueInr), s.valueAtRiskInr > 0 ? h('div', { class: 'warn-text' }, 'via risk area') : null),
          h('td', {}, s.voyageReference ? h('button', { class: 'link', onclick: (e: Event) => { e.stopPropagation(); ctx.openOnMap(eligible.find((v) => v.reference === s.voyageReference)?.mmsi ?? ''); } }, `${s.voyageReference}`) : '—', s.vesselName ? h('div', { class: 'muted small' }, s.vesselName) : null),
          h('td', {}, s.projectedEta ? dt(s.projectedEta) : '—', s.etaBasis === 'live' ? h('div', { class: 'muted small' }, 'live ETA') : null),
          h('td', {}, dt(s.requiredBy), slack !== undefined ? h('div', { class: slack < 0 ? 'bad-text small' : slack < 24 ? 'warn-text small' : 'muted small' }, `${slack >= 0 ? '+' : ''}${slack.toFixed(0)} h buffer`) : null),
          h('td', {}, s.status === 'delivered' ? h('span', { class: 'rbadge ok' }, 'Delivered') : s.status === 'cancelled' ? h('span', { class: 'rbadge muted' }, 'Cancelled') : riskBadge(s.deliveryRisk)),
          h(
            'td',
            { onclick: (e: Event) => e.stopPropagation() },
            allocate,
            s.status === 'in_transit' || s.status === 'booked'
              ? h('button', { class: 'btn small', onclick: async () => { await ctx.api('POST', `/api/shipments/${s.id}/actions`, { action: 'deliver', note: 'Delivered' }); ctx.toast('Marked delivered', 'ok'); await load(); } }, 'Delivered')
              : null,
          ),
        ),
        detail,
      ];
    });
    body.append(
      h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ...['Shipment', 'Cargo', 'Route', 'Value', 'Voyage / vessel', 'Projected ETA', 'Required by', 'Delivery', ''].map((c) => h('th', {}, c)))), h('tbody', {}, ...rows.flat())),
      h('p', { class: 'muted small' }, `${open.length} open shipment(s). Click a row for advisories. ETAs use the vessel's live position and speed once a voyage is under way.`),
    );
  };
  void load();
  return root;
}

// ── voyages ──────────────────────────────────────────────────────────────────
const STATUS_TEXT: Record<string, string> = { draft: 'Draft', submitted: 'Awaiting approval', changes_requested: 'Changes requested', approved: 'Approved', rejected: 'Rejected', active: 'Under way', completed: 'Completed', cancelled: 'Cancelled' };
const statusBadge = (s: string): HTMLElement => h('span', { class: `rbadge st-${s}` }, STATUS_TEXT[s] ?? s);

export function voyagesPage(ctx: Ctx): HTMLElement {
  const root = h('div', { class: 'page-inner wide' });
  const body = h('div', {}, loading());
  root.append(h('div', { class: 'page-head' }, h('h2', {}, 'Voyage risk management'), h('span', { class: 'muted small' }, `Signed in as ${ctx.session.user.role.replace('_', ' ')}`)), h('p', { class: 'muted' }, 'Plan a voyage, get an automatic route risk assessment, and send it for approval. Higher-risk voyages need a different person to approve (four-eyes); critical ones need two. Approved voyages are monitored live against their route.'), body);
  let openId: string | null = null;

  const load = async (): Promise<void> => {
    const [vr, fleet] = await Promise.all([ctx.api<{ voyages: Voyage[] }>('GET', '/api/voyages'), ctx.api<{ vessels: RegistryVessel[] }>('GET', '/api/registry/vessels')]);
    clear(body);
    const voyages = vr.data.voyages ?? [];
    body.append(newVoyageCard(ctx, fleet.data.vessels?.filter((v) => v.status === 'active') ?? [], load));
    if (voyages.length === 0) return void body.append(h('p', { class: 'empty' }, 'No voyages yet. Create one above.'));
    const list = h('tbody', {});
    for (const v of voyages) {
      const row = h(
        'tr',
        { class: `clickable ${openId === v.id ? 'selrow' : ''}`, onclick: () => { openId = openId === v.id ? null : v.id; void load(); } },
        h('td', {}, h('strong', {}, v.reference)),
        h('td', {}, v.vesselName),
        h('td', {}, `${place(ctx, v.originPort)} → ${place(ctx, v.destinationPort)}`),
        h('td', {}, `${dt(v.etd).slice(0, 10)} → ${dt(v.eta).slice(0, 10)}`),
        h('td', {}, v.cargo.replace(/_/g, ' ')),
        h('td', {}, v.assessment ? riskBadge(v.assessment.level, ` ${v.assessment.score}`) : h('span', { class: 'muted' }, 'not assessed')),
        h('td', {}, statusBadge(v.status)),
      );
      list.append(row);
      if (openId === v.id) list.append(h('tr', { class: 'detail-row' }, h('td', { colspan: '7' }, voyageDetail(ctx, v, load))));
    }
    body.append(h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ...['Reference', 'Vessel', 'Route', 'ETD → ETA', 'Cargo', 'Risk', 'Status'].map((c) => h('th', {}, c)))), list));
  };
  void load();
  return root;
}

function newVoyageCard(ctx: Ctx, fleet: RegistryVessel[], reload: () => Promise<void>): HTMLElement {
  const cat = ctx.catalog();
  const routes = cat?.routes ?? [];
  const f = {
    vessel: select(fleet.map((v): [string, string] => [v.mmsi, `${v.name} (${v.mmsi})`])),
    route: select(routes.map((r): [string, string] => [r.id, r.name])),
    cargo: select((cat?.cargoTypes ?? []).map((c): [string, string] => [c, c.replace(/_/g, ' ')]), 'general'),
    etd: h('input', { type: 'datetime-local', value: toLocalInput(ctx.nowMs() + 86_400_000) }) as HTMLInputElement,
    eta: h('input', { type: 'datetime-local', value: toLocalInput(ctx.nowMs() + 6 * 86_400_000) }) as HTMLInputElement,
  };
  const preview = h('div', { class: 'preview' });
  const err = h('p', { class: 'error', role: 'alert' });
  const payload = (): Record<string, unknown> => {
    const t = routes.find((r) => r.id === f.route.value);
    return { mmsi: f.vessel.value, routeId: f.route.value, originPort: t?.from, destinationPort: t?.to, cargo: f.cargo.value, etd: fromLocalInput(f.etd.value), eta: fromLocalInput(f.eta.value) };
  };
  const assess = async (): Promise<void> => {
    err.textContent = '';
    const r = await ctx.api<RiskAssessment & { error?: string }>('POST', '/api/voyages/assess', payload());
    clear(preview);
    if (r.status !== 200) return showError(err, r.data.error ?? 'Could not assess');
    preview.append(assessmentView(r.data));
    ctx.showRoute(routes.find((x) => x.id === f.route.value)?.waypoints ?? null);
  };
  return h(
    'details',
    { class: 'card', open: false },
    h('summary', { class: 'card-sum' }, '＋ Plan a new voyage'),
    fleet.length === 0 ? h('p', { class: 'empty' }, 'Add vessels to your fleet registry first.') : null,
    h(
      'form',
      {
        class: 'grid-form',
        onsubmit: async (e: Event) => {
          e.preventDefault();
          const r = await ctx.api<{ error?: string }>('POST', '/api/voyages', payload());
          if (r.status === 201) {
            ctx.toast('Voyage saved as draft', 'ok');
            ctx.showRoute(null);
            await reload();
          } else showError(err, r.data.error ?? 'Could not save');
        },
      },
      field('Vessel (from your fleet)', f.vessel), field('Route', f.route), field('Cargo', f.cargo), field('ETD (UTC)', f.etd), field('ETA (UTC)', f.eta),
      h('div', { class: 'full' }, err, h('div', { class: 'row-gap' }, h('button', { class: 'btn', type: 'button', onclick: () => void assess() }, 'Assess risk'), h('button', { class: 'btn primary', type: 'submit' }, 'Save as draft')), preview),
    ),
  );
}

function assessmentView(a: RiskAssessment): HTMLElement {
  return h(
    'div',
    { class: 'assess' },
    h('div', { class: 'assess-head' }, riskBadge(a.level, ` · score ${a.score}/100`), h('span', { class: 'muted' }, `${a.exposure.totalNm} nm · ${a.exposure.highRiskNm} nm high-risk · ${a.exposure.elevatedRiskNm} nm elevated${a.exposure.zones.length ? ` · ${a.exposure.zones.join(', ')}` : ''}`)),
    a.factors.length ? h('ul', { class: 'factors' }, ...a.factors.map((x) => h('li', {}, h('span', { class: 'pts' }, `+${x.points}`), h('strong', {}, ` ${x.label}`), h('span', { class: 'muted' }, ` — ${x.detail}`)))) : null,
    h('h4', {}, 'Recommended controls'),
    h('ul', { class: 'advice' }, ...a.controls.map((c) => h('li', {}, c))),
    h('p', { class: 'muted small' }, 'Advisory text — verify against current guidance. Not a substitute for the master’s judgement.'),
  );
}

function voyageDetail(ctx: Ctx, v: Voyage, reload: () => Promise<void>): HTMLElement {
  const role = ctx.session.user.role;
  const me = ctx.session.user.username;
  const act = async (action: string, note: string): Promise<void> => {
    const r = await ctx.api<{ error?: string }>('POST', `/api/voyages/${v.id}/actions`, { action, note });
    ctx.toast(r.status === 200 ? `Voyage ${action.replace('_', ' ')}` : (r.data.error ?? 'Not allowed'), r.status === 200 ? 'ok' : 'warn');
    await reload();
  };
  const ask = (action: string, prompt_: string, required: boolean) => async (): Promise<void> => {
    const note = prompt(prompt_) ?? '';
    if (required && !note.trim()) return;
    await act(action, note);
  };
  const buttons: HTMLElement[] = [];
  const canDecide = (role === 'risk_officer' || role === 'org_admin') && v.createdBy !== me;
  if (v.status === 'draft' || v.status === 'changes_requested') buttons.push(h('button', { class: 'btn primary', onclick: () => void act('submit', '') }, 'Submit for approval'));
  if (v.status === 'submitted' && canDecide) {
    buttons.push(h('button', { class: 'btn primary', onclick: ask('approve', 'Approval conditions / justification (required for high-risk voyages):', false) }, 'Approve'));
    buttons.push(h('button', { class: 'btn', onclick: ask('request_changes', 'What must change?', true) }, 'Request changes'));
    buttons.push(h('button', { class: 'btn danger', onclick: ask('reject', 'Reason for rejection:', true) }, 'Reject'));
  }
  if (v.status === 'submitted' && !canDecide) buttons.push(h('span', { class: 'muted' }, v.createdBy === me ? 'Waiting for another person (four-eyes rule).' : 'Waiting for a risk officer.'));
  if (v.status === 'approved') buttons.push(h('button', { class: 'btn primary', onclick: () => void act('start', 'Departed') }, 'Start voyage'));
  if (v.status === 'active') buttons.push(h('button', { class: 'btn', onclick: () => void act('complete', 'Arrived') }, 'Complete voyage'));
  if (['draft', 'submitted', 'changes_requested', 'approved'].includes(v.status)) buttons.push(h('button', { class: 'btn small danger', onclick: ask('cancel', 'Cancel this voyage? Reason:', false) }, 'Cancel'));
  buttons.push(h('button', { class: 'btn small', onclick: () => { ctx.showRoute(v.waypoints as LatLon[]); ctx.openOnMap(v.mmsi); } }, '🗺 Show route on map'));

  return h(
    'div',
    { class: 'vdetail' },
    v.assessment ? assessmentView(v.assessment) : h('p', { class: 'muted' }, 'Not yet assessed. The risk assessment runs when you submit.'),
    v.conditions ? h('p', {}, h('strong', {}, 'Approval conditions: '), v.conditions) : null,
    v.approvalsRequired.length ? h('p', { class: 'muted' }, `Approvals required: ${v.approvalsRequired.map((r) => r.replace('_', ' ')).join(' + ')} · received: ${v.approvals.filter((a) => a.decision === 'approved').length}`) : null,
    h('div', { class: 'row-gap' }, ...buttons),
    h('ul', { class: 'timeline' }, ...v.history.map((e) => h('li', {}, h('span', { class: 'muted' }, `${dt(e.ts)} `), `${e.actor}: ${e.action.replace(/_/g, ' ')}${e.note ? ` — ${e.note}` : ''}`))),
  );
}

// ── fleet registry ───────────────────────────────────────────────────────────
export function registryPage(ctx: Ctx): HTMLElement {
  const root = h('div', { class: 'page-inner wide' });
  const body = h('div', {}, loading());
  const canEdit = ctx.session.user.role === 'operator' || ctx.session.user.role === 'org_admin';
  const isAdmin = ctx.session.user.role === 'org_admin';
  root.append(h('div', { class: 'page-head' }, h('h2', {}, `${ctx.session.user.fleetName ?? 'Fleet'} — registry`), h('button', { class: 'btn', onclick: () => void downloadCsv(ctx) }, '⬇ Export alerts (CSV)')), h('p', { class: 'muted' }, 'Master data for your vessels. Alerts and voyages are scoped to these vessels only.'), body);

  const load = async (): Promise<void> => {
    const r = await ctx.api<{ vessels: RegistryVessel[] }>('GET', '/api/registry/vessels');
    const org = await ctx.api<{ usage: { vessels: number }; plan: Plan }>('GET', '/api/org');
    clear(body);
    const live = new Map((ctx.data()?.vessels ?? []).map((v) => [v.mmsi, v]));
    const sev = ctx.alertSeverity();
    body.append(h('div', { class: 'stats' }, h('div', { class: 'stat' }, h('strong', {}, `${org.data.usage?.vessels ?? 0} / ${org.data.plan?.limits.vessels ?? '—'}`), 'vessels used (plan quota)'), h('div', { class: 'stat' }, h('strong', {}, String([...live.keys()].filter((m) => r.data.vessels.some((x) => x.mmsi === m)).length)), 'reporting AIS now')));
    if (canEdit) body.append(addVesselCard(ctx, load, isAdmin));
    const rows = r.data.vessels.map((v) => {
      const l = live.get(v.mmsi);
      const risk = l ? highRiskZoneOf(l) : null;
      return h(
        'tr',
        { class: v.status === 'retired' ? 'retired' : '' },
        h('td', {}, l ? h('button', { class: 'link', onclick: () => ctx.openOnMap(v.mmsi) }, v.name) : v.name),
        h('td', {}, v.mmsi), h('td', {}, v.imo ?? '—'), h('td', {}, v.vesselType), h('td', {}, v.flag), h('td', {}, v.grossTonnage ? v.grossTonnage.toLocaleString() : '—'),
        h('td', {}, l ? `${l.sog.toFixed(1)} kn${risk ? ` · ${risk.name}` : ''}` : h('span', { class: 'muted' }, 'no AIS')),
        h('td', {}, sev.get(v.mmsi) ? h('span', { class: `badge sev-${sev.get(v.mmsi)}` }, sev.get(v.mmsi)) : h('span', { class: 'muted' }, v.status === 'retired' ? 'retired' : 'normal')),
        h('td', {}, isAdmin && v.status === 'active' ? h('button', { class: 'btn small danger', onclick: async () => { if (confirm(`Retire ${v.name}?`)) { await ctx.api('DELETE', `/api/registry/vessels/${v.mmsi}`); await load(); } } }, 'Retire') : null),
      );
    });
    body.append(h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ...['Vessel', 'MMSI', 'IMO', 'Type', 'Flag', 'GT', 'Live', 'Status', ''].map((c) => h('th', {}, c)))), h('tbody', {}, ...rows)));
  };
  void load();
  return root;
}

function addVesselCard(ctx: Ctx, reload: () => Promise<void>, canImport: boolean): HTMLElement {
  const f = {
    mmsi: h('input', { placeholder: '9 digits', maxlength: '9', inputmode: 'numeric' }) as HTMLInputElement,
    imo: h('input', { placeholder: '7 digits (optional)', maxlength: '7' }) as HTMLInputElement,
    name: h('input', { placeholder: 'Vessel name', maxlength: '80' }) as HTMLInputElement,
    type: select([['cargo', 'Cargo'], ['container', 'Container'], ['bulk', 'Bulk'], ['tanker', 'Tanker'], ['passenger', 'Passenger'], ['other', 'Other']], 'cargo'),
    flag: h('input', { value: 'India', maxlength: '40' }) as HTMLInputElement,
    gt: h('input', { type: 'number', placeholder: 'Gross tonnage' }) as HTMLInputElement,
  };
  const err = h('p', { class: 'error', role: 'alert' });
  const csv = h('textarea', { rows: '4', placeholder: 'mmsi,imo,name,type,flag,grossTonnage\n419700001,9123456,MV EXAMPLE,cargo,India,32000' }) as HTMLTextAreaElement;
  const csvOut = h('p', { class: 'muted small' });
  return h(
    'details',
    { class: 'card' },
    h('summary', { class: 'card-sum' }, '＋ Add a vessel'),
    h(
      'form',
      {
        class: 'grid-form',
        onsubmit: async (e: Event) => {
          e.preventDefault();
          const r = await ctx.api<{ error?: string }>('POST', '/api/registry/vessels', { mmsi: f.mmsi.value, imo: f.imo.value || undefined, name: f.name.value, vesselType: f.type.value, flag: f.flag.value, grossTonnage: f.gt.value ? Number(f.gt.value) : undefined });
          if (r.status === 201) {
            ctx.toast('Vessel saved', 'ok');
            await reload();
          } else showError(err, r.data.error ?? 'Could not save');
        },
      },
      field('MMSI', f.mmsi), field('IMO', f.imo), field('Name', f.name), field('Type', f.type), field('Flag', f.flag), field('Gross tonnage', f.gt),
      h('div', { class: 'full' }, err, h('button', { class: 'btn primary', type: 'submit' }, 'Save vessel')),
    ),
    canImport
      ? h(
          'div',
          { class: 'import' },
          h('h4', {}, 'Bulk import (CSV)'),
          csv,
          h('button', { class: 'btn', onclick: async () => {
            const r = await ctx.api<{ imported?: number; errors?: Array<{ row: number; error: string }>; error?: string }>('POST', '/api/registry/import', { csv: csv.value });
            csvOut.textContent = r.status === 200 ? `${r.data.imported} imported${r.data.errors?.length ? `; rejected: ${r.data.errors.map((x) => `row ${x.row} (${x.error})`).join(', ')}` : ''}` : (r.data.error ?? 'Import failed');
            if (r.status === 200) await reload();
          } }, 'Import'),
          csvOut,
        )
      : null,
  );
}

async function downloadCsv(ctx: Ctx): Promise<void> {
  const res = await ctx.api<string>('GET', '/api/reports/alerts.csv');
  const url = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
  const a = h('a', { href: url, download: 'orvms-alerts.csv' });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  ctx.toast('Alerts exported', 'ok');
}

// ── case desk ────────────────────────────────────────────────────────────────
function slaChip(c: CaseRecord, now: number): HTMLElement {
  const m = slaRemainingMinutes(c, now);
  if (m === null) return h('span', { class: 'rbadge muted' }, c.slaBreached ? 'SLA breached' : 'SLA met');
  const label = c.status === 'open' ? 'acknowledge' : 'resolve';
  const txt = m < 0 ? `${label} overdue ${Math.abs(m)} min` : m >= 120 ? `${label} in ${Math.round(m / 60)} h` : `${label} in ${m} min`;
  return h('span', { class: `rbadge ${m < 0 ? 'bad' : m < 15 ? 'warn' : 'ok'}` }, txt);
}

export function casesPage(ctx: Ctx, myDesk: string | undefined): HTMLElement {
  const isReporter = ctx.isOperator;
  const root = h('div', { class: 'page-inner wide' });
  const body = h('div', {});
  let onlyMine = false;
  let controllers: Array<{ username: string; displayName: string; desk?: string }> = [];
  root.append(
    h('div', { class: 'page-head' }, h('h2', {}, isReporter ? 'My reports' : 'Case desk'), !isReporter && myDesk ? h('label', { class: 'chk', style: 'margin:0' }, h('input', { type: 'checkbox', onchange: (e: Event) => { onlyMine = (e.target as HTMLInputElement).checked; render(); } }), 'only my desk') : null),
    h('p', { class: 'muted' }, isReporter ? 'Reports your organisation filed and how the Coast Guard is responding.' : 'Suspicious-vessel reports routed to the nearest station. Each case has a priority and an SLA: acknowledge on time or it escalates automatically.'),
    body,
  );

  const render = (): void => {
    clear(body);
    const now = ctx.nowMs();
    const all = [...(ctx.incidents() as CaseRecord[])];
    const list = (onlyMine && myDesk ? all.filter((c) => c.station.desk === myDesk) : all).sort((a, b) => Number(a.status === 'closed') - Number(b.status === 'closed') || a.priority.localeCompare(b.priority) || b.createdAt - a.createdAt);
    const open = all.filter((c) => c.status !== 'closed');
    body.append(h('div', { class: 'stats' }, h('div', { class: 'stat' }, h('strong', {}, String(open.length)), 'open cases'), h('div', { class: 'stat badstat' }, h('strong', {}, String(open.filter((c) => c.escalationLevel > 0).length)), 'escalated'), h('div', { class: 'stat' }, h('strong', {}, String(all.filter((c) => c.slaBreached).length)), 'SLA breached (all time)'), h('div', { class: 'stat' }, h('strong', {}, String(all.filter((c) => c.status === 'closed').length)), 'closed')));
    if (list.length === 0) return void body.append(h('p', { class: 'empty' }, isReporter ? 'You have not reported anything yet. Select a vessel on the map and press "Report suspicious vessel", or use "Report unidentified boat".' : 'No cases.'));
    for (const c of list) {
      const near = nearestStation(c.lat, c.lon);
      body.append(
        h(
          'article',
          { class: `incident st-${c.status}` },
          h('div', { class: 'inc-head' }, h('span', { class: `prio ${c.priority}` }, c.priority), h('span', { class: `badge st-${c.status}` }, c.status), h('button', { class: 'link', onclick: () => ctx.openOnMap(c.mmsi) }, c.vesselName), slaChip(c, now), c.escalationLevel > 0 ? h('span', { class: 'rbadge crit' }, `ESCALATED L${c.escalationLevel}`) : null, h('span', { class: 'muted' }, `${dt(c.createdAt)} · by ${c.reporter}`)),
          h('div', { class: 'inc-route' }, '⚑ ', h('strong', {}, c.station.name), h('span', { class: 'muted' }, ` · ${c.station.distanceNm} nm · desk ${c.station.desk}${c.assignee ? ` · assigned to ${c.assignee}` : ' · unassigned'}${near.station.id !== c.station.id ? '' : ''}`)),
          h('p', { class: 'inc-note' }, h('strong', {}, `${CATEGORY_TEXT[c.category]}. `), c.note || ''),
          h('ul', { class: 'timeline' }, ...c.history.map((e) => h('li', {}, h('span', { class: 'muted' }, `${dt(e.ts)} `), `${e.actor}: ${e.action.replace(/_/g, ' ')}${e.note ? ` — ${e.note}` : ''}`))),
          c.closureCode ? h('p', { class: 'muted' }, `Closed as: ${c.closureCode.replace(/_/g, ' ')}`) : null,
          isReporter || c.status === 'closed' ? null : controllerActions(ctx, c, controllers, load),
        ),
      );
    }
  };

  const load = async (): Promise<void> => {
    await ctx.refreshIncidents();
    render();
  };
  if (!isReporter) void ctx.api<{ controllers: typeof controllers }>('GET', '/api/controllers').then((r) => { controllers = r.data.controllers ?? []; render(); });
  render();
  return root;
}

function controllerActions(ctx: Ctx, c: CaseRecord, controllers: Array<{ username: string; displayName: string; desk?: string }>, reload: () => Promise<void>): HTMLElement {
  const assignee = select([['', 'Assign to…'], ...controllers.map((u): [string, string] => [u.username, `${u.displayName}`])], '');
  assignee.addEventListener('change', async () => {
    if (!assignee.value) return;
    const r = await ctx.api<{ error?: string }>('POST', `/api/cases/${c.id}/assign`, { assignee: assignee.value });
    ctx.toast(r.status === 200 ? 'Case assigned' : (r.data.error ?? 'Failed'), r.status === 200 ? 'ok' : 'warn');
    await reload();
  });
  const go = (status: string, askNote: boolean) => async (): Promise<void> => {
    const note = askNote ? (prompt('Note (optional):') ?? '') : '';
    const r = await ctx.api<{ error?: string }>('POST', `/api/cases/${c.id}/status`, { status, note });
    ctx.toast(r.status === 200 ? `Case ${status}` : (r.data.error ?? 'Failed'), r.status === 200 ? 'ok' : 'warn');
    await reload();
  };
  const codes = ctx.catalog()?.closureCodes ?? [];
  const closure = select(codes.map((x): [string, string] => [x, x.replace(/_/g, ' ')]), 'resolved');
  return h(
    'div',
    { class: 'inc-actions' },
    assignee,
    c.status === 'open' ? h('button', { class: 'btn small primary', onclick: go('acknowledged', true) }, 'Acknowledge') : null,
    c.status !== 'investigating' ? h('button', { class: 'btn small', onclick: go('investigating', true) }, 'Investigating') : null,
    closure,
    h('button', { class: 'btn small', onclick: async () => {
      const note = prompt('Closing note (optional):') ?? '';
      const r = await ctx.api<{ error?: string }>('POST', `/api/cases/${c.id}/status`, { status: 'closed', closureCode: closure.value, note });
      ctx.toast(r.status === 200 ? 'Case closed' : (r.data.error ?? 'Failed'), r.status === 200 ? 'ok' : 'warn');
      await reload();
    } }, 'Close case'),
  );
}

// ── organisation (tenant admin) ──────────────────────────────────────────────
interface OrgSummary {
  org: Organization;
  plan: Plan;
  period: string;
  usage: { vessels: number; users: number; voyages: number; apiCalls: number };
  invoiceEstimate: { subscriptionInr: number; overageVoyages: number; overageInr: number; totalInr: number };
  users?: Array<{ username: string; displayName: string; role: string }>;
}

const meter = (label: string, used: number, limit: number): HTMLElement => {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : used > 0 ? 100 : 0;
  return h('div', { class: 'meter' }, h('div', { class: 'meter-top' }, h('span', {}, label), h('strong', {}, `${used.toLocaleString()} / ${limit.toLocaleString()}`)), h('div', { class: 'bar' }, h('span', { class: `bar-fill ${pct >= 90 ? 'hot' : ''}`, style: `width:${pct}%` })));
};

export function orgPage(ctx: Ctx): HTMLElement {
  const root = h('div', { class: 'page-inner wide' });
  const body = h('div', {}, loading());
  const isAdmin = ctx.session.user.role === 'org_admin';
  root.append(h('div', { class: 'page-head' }, h('h2', {}, 'Organisation, plan & integrations')), body);

  const load = async (): Promise<void> => {
    const r = await ctx.api<OrgSummary>('GET', '/api/org');
    clear(body);
    if (r.status !== 200) return void body.append(h('p', { class: 'error' }, 'Could not load organisation'));
    const o = r.data;
    const inv = o.invoiceEstimate;
    body.append(
      h('section', { class: 'card' }, h('h3', {}, `${o.org.name} — ${o.plan.name} plan`),
        h('div', { class: 'grid2' },
          h('div', {}, meter('Vessels', o.usage.vessels, o.plan.limits.vessels), meter('Users', o.usage.users, o.plan.limits.users), meter(`Voyages (${o.period})`, o.usage.voyages, o.plan.limits.voyagesPerMonth), meter(`API calls (${o.period})`, o.usage.apiCalls, o.plan.limits.apiCallsPerMonth)),
          h('div', {}, h('h4', {}, `Invoice estimate — ${o.period}`), h('table', { class: 'tbl compact' }, h('tbody', {}, h('tr', {}, h('td', {}, `${o.plan.name} subscription`), h('td', { class: 'num' }, inr(inv.subscriptionInr))), h('tr', {}, h('td', {}, `Extra voyages (${inv.overageVoyages} × ${inr(o.plan.overagePerVoyageInr)})`), h('td', { class: 'num' }, inr(inv.overageInr))), h('tr', { class: 'total' }, h('td', {}, 'Estimated total'), h('td', { class: 'num' }, inr(inv.totalInr))))), h('p', { class: 'muted small' }, 'Illustrative pricing. ORVMS does not process payments; to change plan contact your account manager.'))),
      ),
    );
    if (!isAdmin) return void body.append(h('p', { class: 'muted' }, 'Users, API keys and webhooks are managed by your organisation administrator.'));
    body.append(await usersCard(ctx, o, load), await integrationsCard(ctx, o, load));
  };
  void load();
  return root;
}

async function usersCard(ctx: Ctx, o: OrgSummary, reload: () => Promise<void>): Promise<HTMLElement> {
  const f = {
    username: h('input', { placeholder: 'username', maxlength: '32' }) as HTMLInputElement,
    name: h('input', { placeholder: 'Full name' }) as HTMLInputElement,
    role: select([['operator', 'Operator'], ['risk_officer', 'Risk officer'], ['org_admin', 'Organisation admin']], 'operator'),
    pw: h('input', { type: 'password', placeholder: 'min 10 characters', autocomplete: 'new-password' }) as HTMLInputElement,
  };
  const err = h('p', { class: 'error', role: 'alert' });
  return h(
    'section',
    { class: 'card' },
    h('h3', {}, `Users (${o.usage.users} of ${o.plan.limits.users})`),
    h('table', { class: 'tbl compact' }, h('thead', {}, h('tr', {}, ...['Username', 'Name', 'Role'].map((c) => h('th', {}, c)))), h('tbody', {}, ...(o.users ?? []).map((u) => h('tr', {}, h('td', {}, u.username), h('td', {}, u.displayName), h('td', {}, u.role.replace('_', ' ')))))),
    h('form', { class: 'grid-form', onsubmit: async (e: Event) => {
      e.preventDefault();
      const r = await ctx.api<{ error?: string }>('POST', '/api/org/users', { username: f.username.value, displayName: f.name.value, role: f.role.value, password: f.pw.value });
      if (r.status === 201) {
        ctx.toast('User created', 'ok');
        await reload();
      } else showError(err, r.data.error ?? 'Could not create the user');
    } }, field('Username', f.username), field('Name', f.name), field('Role', f.role), field('Initial password', f.pw), h('div', { class: 'full' }, err, h('button', { class: 'btn primary', type: 'submit' }, 'Add user'))),
  );
}

async function integrationsCard(ctx: Ctx, o: OrgSummary, reload: () => Promise<void>): Promise<HTMLElement> {
  const entitled = o.plan.limits.apiKeysAndWebhooks;
  const card = h('section', { class: 'card' }, h('h3', {}, 'Integrations — API keys & webhooks'));
  if (!entitled) return (card.append(h('p', { class: 'muted' }, `Your ${o.plan.name} plan does not include API keys or webhooks. Upgrade to Professional or Enterprise to connect your ERP / TMS.`)), card);
  const [keys, hooks, dels] = await Promise.all([
    ctx.api<{ keys: Array<{ id: string; name: string; prefix: string; scopes: string[]; createdAt: number; lastUsedAt?: number; revokedAt?: number }> }>('GET', '/api/org/api-keys'),
    ctx.api<{ webhooks: Array<{ id: string; url: string; secret: string; events: string[]; active: boolean }> }>('GET', '/api/org/webhooks'),
    ctx.api<{ deliveries: Array<{ id: string; event: string; status: string; attempts: number; responseStatus?: number; createdAt: number; error?: string }> }>('GET', '/api/org/deliveries'),
  ]);
  const secretBox = h('div', { class: 'secret-box', hidden: true });
  const kname = h('input', { placeholder: 'Key name, e.g. ERP sync', maxlength: '60' }) as HTMLInputElement;
  const kerr = h('p', { class: 'error', role: 'alert' });
  const url = h('input', { placeholder: 'https://erp.example.com/orvms-events' }) as HTMLInputElement;
  const werr = h('p', { class: 'error', role: 'alert' });
  card.append(
    h('h4', {}, 'API keys'),
    h('p', { class: 'muted small' }, 'Authenticate with the X-API-Key header. Endpoints: /api/integration/v1/fleet, /alerts, /voyages, /shipments.'),
    secretBox,
    h('table', { class: 'tbl compact' }, h('thead', {}, h('tr', {}, ...['Name', 'Key', 'Scopes', 'Last used', ''].map((c) => h('th', {}, c)))), h('tbody', {}, ...keys.data.keys.map((k) => h('tr', { class: k.revokedAt ? 'retired' : '' }, h('td', {}, k.name), h('td', {}, `${k.prefix}…`), h('td', {}, k.scopes.join(', ')), h('td', {}, k.lastUsedAt ? dt(k.lastUsedAt) : 'never'), h('td', {}, k.revokedAt ? 'revoked' : h('button', { class: 'btn small danger', onclick: async () => { await ctx.api('DELETE', `/api/org/api-keys/${k.id}`); await reload(); } }, 'Revoke')))))),
    h('div', { class: 'row-gap' }, kname, h('button', { class: 'btn primary', onclick: async () => {
      const r = await ctx.api<{ secret?: string; error?: string }>('POST', '/api/org/api-keys', { name: kname.value });
      if (r.status === 201 && r.data.secret) {
        secretBox.hidden = false;
        secretBox.textContent = `New key (copy it now — it is shown only once): ${r.data.secret}`;
        kerr.textContent = '';
      } else showError(kerr, r.data.error ?? 'Could not create the key');
    } }, 'Create API key')),
    kerr,
    h('h4', {}, 'Webhooks'),
    h('p', { class: 'muted small' }, `Events: ${(ctx.catalog()?.webhookEvents ?? []).join(', ')}. Each delivery is signed (X-ORVMS-Signature = HMAC-SHA256 of "timestamp.body") and retried up to 3 times.`),
    h('table', { class: 'tbl compact' }, h('thead', {}, h('tr', {}, ...['URL', 'Events', 'Signing secret', ''].map((c) => h('th', {}, c)))), h('tbody', {}, ...hooks.data.webhooks.map((w) => h('tr', {}, h('td', {}, w.url), h('td', {}, w.events.join(', ')), h('td', {}, h('code', {}, w.secret)), h('td', {}, h('button', { class: 'btn small danger', onclick: async () => { await ctx.api('DELETE', `/api/org/webhooks/${w.id}`); await reload(); } }, 'Delete')))))),
    h('div', { class: 'row-gap' }, url, h('button', { class: 'btn primary', onclick: async () => {
      const r = await ctx.api<{ error?: string }>('POST', '/api/org/webhooks', { url: url.value });
      if (r.status === 201) {
        ctx.toast('Webhook created', 'ok');
        await reload();
      } else showError(werr, r.data.error ?? 'Could not create the webhook');
    } }, 'Add webhook')),
    werr,
    h('h4', {}, 'Recent deliveries'),
    dels.data.deliveries.length ? h('table', { class: 'tbl compact' }, h('thead', {}, h('tr', {}, ...['Time', 'Event', 'Status', 'Attempts', 'HTTP'].map((c) => h('th', {}, c)))), h('tbody', {}, ...dels.data.deliveries.slice(0, 10).map((d) => h('tr', {}, h('td', {}, dt(d.createdAt)), h('td', {}, d.event), h('td', {}, h('span', { class: `rbadge ${d.status === 'delivered' ? 'ok' : 'bad'}` }, d.status)), h('td', {}, String(d.attempts)), h('td', {}, d.responseStatus ? String(d.responseStatus) : d.error ?? '—'))))) : h('p', { class: 'muted small' }, 'No deliveries yet.'),
  );
  return card;
}

// ── platform admin: organisations ────────────────────────────────────────────
export function orgsAdminPage(ctx: Ctx): HTMLElement {
  const root = h('div', { class: 'page-inner wide' });
  const body = h('div', {}, loading());
  root.append(h('div', { class: 'page-head' }, h('h2', {}, 'Customer organisations')), h('p', { class: 'muted' }, 'Onboard customers, assign subscription plans and suspend accounts. Every customer is an isolated tenant.'), body);
  const load = async (): Promise<void> => {
    const r = await ctx.api<{ organizations: Array<Organization & { vessels: number; users: number }> }>('GET', '/api/admin/orgs');
    clear(body);
    const plans = ctx.catalog()?.plans ?? [];
    body.append(h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ...['Organisation', 'Type', 'Plan', 'Vessels', 'Users', 'Status', ''].map((c) => h('th', {}, c)))), h('tbody', {}, ...r.data.organizations.map((o) => {
      const plan = select(plans.map((p): [string, string] => [p.id, `${p.name} (${inr(p.monthlyFeeInr)}/mo)`]), o.planId);
      plan.addEventListener('change', async () => { await ctx.api('PUT', `/api/admin/orgs/${o.id}`, { planId: plan.value }); ctx.toast('Plan updated', 'ok'); await load(); });
      return h('tr', {}, h('td', {}, h('strong', {}, o.name)), h('td', {}, o.kind.replace('_', ' ')), h('td', {}, o.kind === 'shipping_company' ? plan : o.planId), h('td', {}, String(o.vessels)), h('td', {}, String(o.users)), h('td', {}, h('span', { class: `rbadge ${o.status === 'active' ? 'ok' : 'bad'}` }, o.status)), h('td', {}, o.kind === 'shipping_company' ? h('button', { class: 'btn small', onclick: async () => { await ctx.api('PUT', `/api/admin/orgs/${o.id}`, { status: o.status === 'active' ? 'suspended' : 'active' }); await load(); } }, o.status === 'active' ? 'Suspend' : 'Reactivate') : null));
    }))));
    const f = { name: h('input', { placeholder: 'Company name' }) as HTMLInputElement, plan: select(plans.map((p): [string, string] => [p.id, p.name]), 'starter'), user: h('input', { placeholder: 'admin username' }) as HTMLInputElement, pw: h('input', { type: 'password', placeholder: 'min 10 characters', autocomplete: 'new-password' }) as HTMLInputElement };
    const err = h('p', { class: 'error', role: 'alert' });
    body.append(h('details', { class: 'card' }, h('summary', { class: 'card-sum' }, '＋ Onboard a customer'), h('form', { class: 'grid-form', onsubmit: async (e: Event) => {
      e.preventDefault();
      const res = await ctx.api<{ error?: string }>('POST', '/api/admin/orgs', { name: f.name.value, kind: 'shipping_company', planId: f.plan.value, adminUsername: f.user.value, adminPassword: f.pw.value });
      if (res.status === 201) {
        ctx.toast('Customer onboarded', 'ok');
        await load();
      } else showError(err, res.data.error ?? 'Could not onboard');
    } }, field('Company name', f.name), field('Plan', f.plan), field('First admin username', f.user), field('First admin password', f.pw), h('div', { class: 'full' }, err, h('button', { class: 'btn primary', type: 'submit' }, 'Create organisation')))));
  };
  void load();
  return root;
}

export type { Shipment };
