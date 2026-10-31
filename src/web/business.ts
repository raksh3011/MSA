/** Business screens: executive overview, billing and contract, compliance reports, service levels, revenue and operations. */
import type { CaseAnalytics, CaseRecord, Contract, Invoice, Plan, RiskReport } from '../domain/types';
import { columns, dateOnly, donut, hbars, icon, monthName, pretty, ring, rupees, rupeesFull } from './charts';
import type { Ctx } from './ctx';
import { clear, fmtDateTime, h } from './dom';

// ── shared helpers ───────────────────────────────────────────────────────────
const loading = (): HTMLElement => h('p', { class: 'empty' }, 'Loading…');
const dt = (ts: number): string => fmtDateTime(ts);
const ago = (ts: number, now: number): string => {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86_400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86_400)} d ago`;
};
const field = (label: string, input: HTMLElement): HTMLElement => h('div', { class: 'fld' }, h('label', {}, label), input);
const sel = (options: Array<[string, string]>, value?: string): HTMLSelectElement => {
  const s = h('select', {}, ...options.map(([v, l]) => h('option', { value: v }, l))) as HTMLSelectElement;
  if (value !== undefined) s.value = value;
  return s;
};
const badge = (cls: string, text: string): HTMLElement => h('span', { class: `rbadge ${cls}` }, text);
const pageHead = (title: string, sub: string, ...actions: Array<HTMLElement | null>): HTMLElement =>
  h('div', { class: 'ph' }, h('div', {}, h('h1', { class: 'ph-title' }, title), h('p', { class: 'ph-sub muted' }, sub)), h('div', { class: 'ph-actions' }, ...actions));

function download(name: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function printDocument(): void {
  document.body.classList.add('print-doc');
  const done = (): void => document.body.classList.remove('print-doc');
  window.addEventListener('afterprint', done, { once: true });
  window.print();
}

function modal(content: HTMLElement, wide = false): { close: () => void } {
  const back = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' });
  const close = (): void => back.remove();
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  back.append(h('div', { class: `dialog ${wide ? 'wide' : ''}` }, content));
  document.body.append(back);
  return { close };
}

const KCARD_TONE: Record<string, string> = { ok: 'var(--ok)', warn: 'var(--warn)', bad: 'var(--bad)', info: 'var(--accent)' };
function kcard(iconName: string, value: string, label: string, sub?: string, tone: 'ok' | 'warn' | 'bad' | 'info' = 'info', onclick?: () => void): HTMLElement {
  return h(
    onclick ? 'button' : 'div',
    { class: `kcard ${onclick ? 'click' : ''}`, style: `--tone:${KCARD_TONE[tone]}`, onclick },
    h('span', { class: 'kc-ico' }, icon(iconName, 20)),
    h('span', { class: 'kc-body' }, h('strong', {}, value), h('span', { class: 'kc-label' }, label), sub ? h('small', { class: 'muted' }, sub) : null),
  );
}

const CASE_COLOR: Record<string, string> = { resolved: 'var(--ok)', false_alarm: '#60a5fa', confirmed_threat: 'var(--crit)', referred: 'var(--warn)', unspecified: 'var(--muted)' };
const PRIO_COLOR: Record<string, string> = { P1: '#ff2d55', P2: '#f97316', P3: '#d99a06', P4: '#64748b' };

// ── executive overview ───────────────────────────────────────────────────────
interface Overview {
  org: { name: string; planName: string; planId: string };
  fleet: { registered: number; tracked: number };
  voyages: { total: number; funnel: Array<{ status: string; count: number }>; awaitingApproval: number; waitingOnMe: number; active: number };
  supplyChain: { inTransit: number; valueInTransitInr: number; valueAtRiskInr: number; atRisk: number; late: number; unplanned: number };
  incidents: { open: number; escalated: number };
  alerts: { openFleetAlerts: number; critical: number };
  commercial: { mrrInr: number; supportTier: string; estimateInr: number; outstandingInr: number; renewsAt: number };
  quotas: Array<{ metric: string; used: number; limit: number; pct: number }>;
  attention: Array<{ level: 'crit' | 'warn' | 'info'; text: string; tab: string }>;
}

const QUOTA_LABEL: Record<string, string> = { vessels: 'Vessels', users: 'Users', voyagesPerMonth: 'Voyages / month', apiCallsPerMonth: 'API calls / month' };
const FUNNEL_COLOR: Record<string, string> = { draft: '#64748b', submitted: '#f59e0b', approved: '#60a5fa', active: '#10b981', completed: '#94a3b8' };

export function overviewPage(ctx: Ctx): HTMLElement {
  const root = h('div', { class: 'page-inner wide' });
  const body = h('div', {}, loading());
  root.append(body);
  void ctx.api<Overview>('GET', '/api/overview').then((r) => {
    clear(body);
    if (r.status !== 200) return void body.append(h('p', { class: 'empty' }, 'Overview unavailable.'));
    const o = r.data;
    const sc = o.supplyChain;
    body.append(
      pageHead(o.org.name, `${o.org.planName} plan · ${o.commercial.supportTier} support · contract renews ${dateOnly(o.commercial.renewsAt)}`, badge('ok', 'Live')),
      o.attention.length
        ? h('div', { class: 'attn' }, ...o.attention.map((a) => h('button', { class: `attn-i ${a.level}`, onclick: () => ctx.navigate(a.tab) }, h('i', { class: 'attn-dot' }), a.text, h('span', { class: 'attn-go' }, 'Open →'))))
        : h('div', { class: 'attn ok-note' }, icon('check', 16), ' Nothing needs your attention right now.'),
      h(
        'div',
        { class: 'kgrid' },
        kcard('fleet', `${o.fleet.tracked}/${o.fleet.registered}`, 'Fleet tracked live', 'registered vessels reporting AIS', 'info', () => ctx.navigate('fleet')),
        kcard('voyages', String(o.voyages.active), 'Voyages at sea', `${o.voyages.awaitingApproval} awaiting approval`, o.voyages.waitingOnMe ? 'warn' : 'info', () => ctx.navigate('voyages')),
        kcard('supply', String(sc.inTransit), 'Shipments in transit', `${rupees(sc.valueInTransitInr)} cargo value`, 'info', () => ctx.navigate('supply')),
        kcard('shield', rupees(sc.valueAtRiskInr), 'Value at risk', `${sc.atRisk} at risk · ${sc.late} late`, sc.late ? 'bad' : sc.atRisk ? 'warn' : 'ok', () => ctx.navigate('supply')),
        kcard('incidents', String(o.incidents.open), 'Open incident reports', o.incidents.escalated ? `${o.incidents.escalated} escalated` : 'none escalated', o.incidents.escalated ? 'warn' : 'ok', () => ctx.navigate('incidents')),
        kcard('map', String(o.alerts.openFleetAlerts), 'Open alerts on your fleet', `${o.alerts.critical} critical`, o.alerts.critical ? 'bad' : 'ok', () => ctx.navigate('map')),
      ),
      h(
        'div',
        { class: 'grid3' },
        h('section', { class: 'card' }, h('h3', {}, 'Voyage approval pipeline'), hbars(o.voyages.funnel.map((f) => ({ label: pretty(f.status), value: f.count, color: FUNNEL_COLOR[f.status] }))), h('p', { class: 'muted small' }, 'Low-risk voyages auto-approve; high-risk need a risk officer; critical need two people.')),
        h('section', { class: 'card' }, h('h3', {}, 'Plan usage'), h('div', { class: 'rings' }, ...o.quotas.map((q) => ring(q.pct, { size: 92, label: QUOTA_LABEL[q.metric] ?? q.metric, text: `${q.pct}%`, color: q.pct >= 90 ? 'var(--bad)' : q.pct >= 70 ? 'var(--warn)' : 'var(--accent)' })))),
        h(
          'section',
          { class: 'card' },
          h('h3', {}, 'Commercial snapshot'),
          h('div', { class: 'kv' }, h('span', {}, 'Monthly subscription'), h('strong', {}, rupees(o.commercial.mrrInr))),
          h('div', { class: 'kv' }, h('span', {}, 'This month so far (excl. GST)'), h('strong', {}, rupees(o.commercial.estimateInr))),
          h('div', { class: 'kv' }, h('span', {}, 'Awaiting payment'), h('strong', { class: o.commercial.outstandingInr ? 'bad-text' : '' }, rupees(o.commercial.outstandingInr))),
          h('div', { class: 'kv' }, h('span', {}, 'Support tier'), h('strong', {}, o.commercial.supportTier)),
          ctx.session.user.role === 'org_admin' ? h('button', { class: 'btn small', style: 'margin-top:10px', onclick: () => ctx.navigate('billing') }, 'Open billing') : null,
        ),
      ),
    );
  });
  return root;
}

// ── billing & contract ───────────────────────────────────────────────────────
type InvoiceRow = Invoice & { view: 'paid' | 'issued' | 'overdue' | 'void'; amountDueInr: number; daysOverdue: number };
interface BillingData {
  contract: Contract;
  plan: Plan;
  support: { label: string; monthlyFeeInr: number; response: string };
  period: string;
  usage: { vessels: number; users: number; voyages: number; apiCalls: number };
  upcoming: Invoice | null;
  invoices: InvoiceRow[];
  receivables: { outstandingInr: number; overdueInr: number; collectedInr: number; invoices: number; overdueInvoices: number };
}
const VIEW_CLS: Record<string, string> = { paid: 'ok', issued: 'warn', overdue: 'crit', void: 'muted' };

export function billingPage(ctx: Ctx): HTMLElement {
  const root = h('div', { class: 'page-inner wide' });
  const body = h('div', {}, loading());
  root.append(body);

  const load = async (): Promise<void> => {
    const r = await ctx.api<BillingData>('GET', '/api/billing');
    clear(body);
    if (r.status !== 200) return void body.append(h('p', { class: 'empty' }, 'Billing is available to the organisation administrator.'));
    const d = r.data;
    const c = d.contract;
    body.append(
      pageHead('Billing & contract', 'Subscription, invoices and payment terms. Payments use a sandbox gateway: no real money moves.', h('button', { class: 'btn small', onclick: exportData }, icon('download', 14), ' Export all my data')),
      h(
        'div',
        { class: 'kgrid' },
        kcard('money', rupees(d.receivables.outstandingInr), 'Outstanding', `${d.invoices.filter((i) => i.view === 'issued' || i.view === 'overdue').length} open invoice(s)`, d.receivables.outstandingInr ? 'warn' : 'ok'),
        kcard('clock', rupees(d.receivables.overdueInr), 'Overdue', d.receivables.overdueInvoices ? `${d.receivables.overdueInvoices} past due` : 'nothing overdue', d.receivables.overdueInr ? 'bad' : 'ok'),
        kcard('check', rupees(d.receivables.collectedInr), 'Paid to date', 'all invoices', 'ok'),
        kcard('billing', d.upcoming ? rupees(d.upcoming.totalInr) : '₹0', `${monthName(d.period)} so far`, 'incl. GST, invoiced at month end', 'info'),
      ),
      h(
        'div',
        { class: 'grid2w' },
        h(
          'section',
          { class: 'card' },
          h('h3', {}, 'Contract'),
          kv('Plan', `${d.plan.name} · ${rupees(d.plan.monthlyFeeInr)}/month`),
          kv('Support', `${d.support.label} — ${d.support.response}`),
          kv('Term', `${c.termMonths} months · renews ${dateOnly(c.renewsAt)}${c.autoRenew ? ' (auto-renew)' : ''}`),
          kv('Payment terms', `Net ${c.paymentTermsDays} days`),
          kv('Availability SLA', `${c.slaUptimePct}% monthly uptime`),
          kv('Signed', `${c.signedBy} · ${dateOnly(c.signedAt)}`),
          h('p', { class: 'muted small', style: 'margin-top:8px' }, 'Plan, support tier, term and payment terms are changed by the platform administrator.'),
        ),
        h('section', { class: 'card' }, h('h3', {}, 'Billing & compliance settings'), settingsForm(ctx, c, load)),
      ),
      h('h3', {}, `Upcoming invoice — ${monthName(d.period)} (estimate)`),
      d.upcoming
        ? lineTable(d.upcoming)
        : h('p', { class: 'empty' }, 'Nothing billable this month on the current plan.'),
      h('h3', {}, 'Invoices'),
      invoiceTable(ctx, d.invoices, load),
    );
  };

  const exportData = async (): Promise<void> => {
    const r = await ctx.api<unknown>('GET', '/api/org/export');
    download('orvms-my-data.json', JSON.stringify(r.data, null, 2), 'application/json');
    ctx.toast('Your data export was downloaded (secrets excluded)', 'ok');
  };

  void load();
  return root;
}

const kv = (k: string, v: string): HTMLElement => h('div', { class: 'kv' }, h('span', {}, k), h('strong', {}, v));

function lineTable(inv: Invoice): HTMLElement {
  return h(
    'table',
    { class: 'tbl compact' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Description'), h('th', { class: 'num' }, 'Qty'), h('th', { class: 'num' }, 'Unit'), h('th', { class: 'num' }, 'Amount'))),
    h(
      'tbody',
      {},
      ...inv.lines.map((l) => h('tr', {}, h('td', {}, l.description), h('td', { class: 'num' }, String(l.quantity)), h('td', { class: 'num' }, rupeesFull(l.unitInr)), h('td', { class: 'num' }, rupeesFull(l.amountInr)))),
      h('tr', {}, h('td', { colspan: 3, class: 'num muted' }, 'Subtotal'), h('td', { class: 'num' }, rupeesFull(inv.subtotalInr))),
      h('tr', {}, h('td', { colspan: 3, class: 'num muted' }, 'GST @ 18%'), h('td', { class: 'num' }, rupeesFull(inv.gstInr))),
      h('tr', { class: 'total' }, h('td', { colspan: 3, class: 'num' }, 'Total'), h('td', { class: 'num' }, rupeesFull(inv.totalInr))),
    ),
  );
}

function settingsForm(ctx: Ctx, c: Contract, reload: () => Promise<void>): HTMLElement {
  const contact = h('input', { type: 'email', value: c.billingContact, placeholder: 'accounts@yourcompany.com' }) as HTMLInputElement;
  const gstin = h('input', { value: c.gstin, placeholder: '27AABCB1234C1Z5', maxlength: 15 }) as HTMLInputElement;
  const freq = sel([['monthly', 'Monthly report pack (automatic)'], ['off', 'Off (generate manually)']], c.reportFrequency);
  const keep = sel([6, 12, 24, 36, 60].map((m): [string, string] => [String(m), `${m} months`]), String(c.retentionMonths));
  const auto = h('input', { type: 'checkbox', checked: c.autoRenew }) as HTMLInputElement;
  const err = h('p', { class: 'error', role: 'alert' });
  return h(
    'div',
    {},
    h('div', { class: 'grid-form' }, field('Billing contact (e-mail)', contact), field('GSTIN', gstin), field('Compliance reports', freq), field('Retention of reports & delivery logs', keep)),
    h('label', { class: 'chk', style: 'margin:10px 0 0' }, auto, 'Renew the contract automatically'),
    err,
    h('button', { class: 'btn primary small', onclick: async () => {
      const r = await ctx.api<{ error?: string }>('PUT', '/api/billing/contract', { billingContact: contact.value.trim(), gstin: gstin.value.trim(), reportFrequency: freq.value, retentionMonths: Number(keep.value), autoRenew: auto.checked });
      if (r.status === 200) { ctx.toast('Settings saved', 'ok'); await reload(); } else err.textContent = r.data.error ?? 'Could not save';
    } }, 'Save settings'),
  );
}

function invoiceTable(ctx: Ctx, rows: InvoiceRow[], reload: () => Promise<void>): HTMLElement {
  if (rows.length === 0) return h('p', { class: 'empty' }, 'No invoices yet. The first one is issued at the end of the billing month.');
  return h(
    'table',
    { class: 'tbl' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Invoice'), h('th', {}, 'Period'), h('th', {}, 'Issued'), h('th', {}, 'Due'), h('th', { class: 'num' }, 'Amount'), h('th', {}, 'Status'), h('th', {}, ''))),
    h(
      'tbody',
      {},
      ...rows.map((i) =>
        h(
          'tr',
          {},
          h('td', {}, h('button', { class: 'link', onclick: () => openInvoice(ctx, i.id, reload) }, i.number)),
          h('td', {}, monthName(i.period)),
          h('td', {}, dateOnly(i.issuedAt)),
          h('td', {}, dateOnly(i.dueAt)),
          h('td', { class: 'num' }, rupeesFull(i.totalInr)),
          h('td', {}, badge(VIEW_CLS[i.view] ?? 'muted', i.view === 'overdue' ? `Overdue ${i.daysOverdue}d` : i.view)),
          h('td', { class: 'row-actions' },
            h('button', { class: 'btn small', onclick: () => openInvoice(ctx, i.id, reload) }, 'View'),
            i.view === 'issued' || i.view === 'overdue' ? h('button', { class: 'btn small primary', onclick: () => openPayment(ctx, i, reload) }, 'Pay') : null,
          ),
        ),
      ),
    ),
  );
}

async function openInvoice(ctx: Ctx, id: string, reload: () => Promise<void>): Promise<void> {
  const r = await ctx.api<{ invoice: InvoiceRow; customer: { name: string } }>('GET', `/api/billing/invoices/${id}`);
  if (r.status !== 200) return ctx.toast('Invoice not found', 'warn');
  const { invoice: i, customer } = r.data;
  const m = modal(
    h(
      'div',
      {},
      h(
        'div',
        { class: 'paper' },
        h('div', { class: 'paper-top' }, h('div', {}, h('div', { class: 'paper-brand' }, 'ORVMS'), h('div', { class: 'paper-sub' }, 'Ocean Risk & Vessel Monitoring System')), h('div', { class: 'paper-title' }, 'TAX INVOICE')),
        h('div', { class: 'paper-meta' },
          h('div', {}, h('small', {}, 'Billed to'), h('strong', {}, customer.name)),
          h('div', {}, h('small', {}, 'Invoice no.'), h('strong', {}, i.number)),
          h('div', {}, h('small', {}, 'Period'), h('strong', {}, monthName(i.period))),
          h('div', {}, h('small', {}, 'Issued'), h('strong', {}, dateOnly(i.issuedAt))),
          h('div', {}, h('small', {}, 'Due'), h('strong', {}, dateOnly(i.dueAt))),
          h('div', {}, h('small', {}, 'Status'), h('strong', {}, i.view.toUpperCase())),
        ),
        lineTable(i),
        i.payments.length ? h('div', { class: 'paper-pay' }, h('strong', {}, 'Payments'), ...i.payments.map((p) => h('div', {}, `${dateOnly(p.ts)} · ${rupeesFull(p.amountInr)} · ${p.method.toUpperCase()} · ref ${p.reference} (sandbox)`))) : null,
        h('p', { class: 'paper-foot' }, 'Illustrative invoice generated by a demonstration system. Payments are processed by a sandbox gateway; no real transaction takes place.'),
      ),
      h('div', { class: 'row no-print' },
        h('button', { class: 'btn', onclick: () => m.close() }, 'Close'),
        h('span', { class: 'row-gap' },
          h('button', { class: 'btn', onclick: async () => { const f = await ctx.api<string>('GET', `/api/billing/invoices/${id}/csv`); download(`${i.number}.csv`, f.data, 'text/csv'); } }, 'CSV'),
          h('button', { class: 'btn', onclick: printDocument }, 'Print / Save PDF'),
          i.view === 'issued' || i.view === 'overdue' ? h('button', { class: 'btn primary', onclick: () => { m.close(); openPayment(ctx, i, reload); } }, 'Pay now') : null,
        ),
      ),
    ),
    true,
  );
}

function openPayment(ctx: Ctx, i: InvoiceRow, reload: () => Promise<void>): void {
  let method = 'upi';
  const err = h('p', { class: 'error', role: 'alert' });
  const stage = h('div', {});
  const methods: Array<[string, string, string]> = [['upi', 'UPI', 'Instant, from any UPI app'], ['card', 'Card', 'Credit / debit card'], ['netbanking', 'Net banking', 'Direct bank transfer']];
  const m = modal(stage);
  const choose = (): void => {
    clear(stage);
    stage.append(
      h('h2', {}, `Pay ${i.number}`),
      h('p', { class: 'muted' }, 'Sandbox payment gateway — for demonstration. No real money moves.'),
      h('div', { class: 'pay-amt' }, rupeesFull(i.amountDueInr)),
      h('div', { class: 'pay-methods' }, ...methods.map(([v, l, s]) => h('label', { class: `pay-m ${v === method ? 'on' : ''}` }, h('input', { type: 'radio', name: 'pm', checked: v === method, onchange: () => { method = v; choose(); } }), h('strong', {}, l), h('small', { class: 'muted' }, s)))),
      err,
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: pay }, `Pay ${rupeesFull(i.amountDueInr)}`)),
    );
  };
  const pay = async (): Promise<void> => {
    const r = await ctx.api<{ invoice?: InvoiceRow; error?: string }>('POST', `/api/billing/invoices/${i.id}/pay`, { method });
    if (r.status !== 200 || !r.data.invoice) return void (err.textContent = r.data.error ?? 'Payment failed');
    const p = r.data.invoice.payments.at(-1);
    clear(stage);
    stage.append(
      h('div', { class: 'pay-ok' }, h('span', { class: 'pay-tick' }, icon('check', 30)), h('h2', {}, 'Payment received'), h('p', { class: 'muted' }, `${rupeesFull(p?.amountInr ?? 0)} via ${method.toUpperCase()}`), h('code', {}, p?.reference ?? '')),
      h('div', { class: 'row' }, h('span', {}), h('button', { class: 'btn primary', onclick: () => { m.close(); void reload(); } }, 'Done')),
    );
    ctx.toast(`Invoice ${i.number} paid (sandbox)`, 'ok');
  };
  choose();
}

// ── compliance reports ───────────────────────────────────────────────────────
interface ReportMeta { id: string; period: string; generatedAt: number; generatedBy: string; postureScore: number; headline: string[] }

export function reportsPage(ctx: Ctx): HTMLElement {
  const root = h('div', { class: 'page-inner wide' });
  const body = h('div', {}, loading());
  root.append(body);
  const periods = (): Array<[string, string]> => {
    const out: Array<[string, string]> = [];
    const now = new Date(ctx.nowMs());
    for (let k = 0; k < 6; k++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1));
      const p = d.toISOString().slice(0, 7);
      out.push([p, `${monthName(p)}${k === 0 ? ' (to date)' : ''}`]);
    }
    return out;
  };
  const load = async (): Promise<void> => {
    const r = await ctx.api<{ reports: ReportMeta[] }>('GET', '/api/reports');
    clear(body);
    if (r.status !== 200) return void body.append(h('p', { class: 'empty' }, 'Reports are available to risk officers and organisation administrators.'));
    const period = sel(periods());
    body.append(
      pageHead('Risk & compliance reports', 'Monthly evidence pack for management, insurers and auditors: voyage approvals, delivery performance, incident handling and control checks. Each snapshot is immutable.',
        h('span', { class: 'row-gap' }, period, h('button', { class: 'btn primary', onclick: async () => {
          const g = await ctx.api<{ id?: string; error?: string }>('POST', '/api/reports', { period: period.value });
          if (g.status === 201 && g.data.id) { ctx.toast('Report generated', 'ok'); await load(); void openReport(ctx, g.data.id); } else ctx.toast(g.data.error ?? 'Failed', 'warn');
        } }, 'Generate report'))),
      r.data.reports.length === 0
        ? h('p', { class: 'empty' }, 'No reports yet. Generate the first one above.')
        : h('div', { class: 'rep-grid' }, ...r.data.reports.map((x) => h('article', { class: 'rep-card' },
            h('div', { class: 'rep-top' }, ring(x.postureScore, { size: 76, label: 'posture', text: String(x.postureScore) }), h('div', {}, h('h2', {}, monthName(x.period)), h('p', { class: 'muted small' }, `${x.generatedBy === 'scheduler' ? 'Scheduled' : `By ${x.generatedBy}`} · ${dt(x.generatedAt)}`))),
            h('ul', { class: 'rep-head' }, ...x.headline.slice(0, 3).map((l) => h('li', {}, l))),
            h('div', { class: 'row-gap' }, h('button', { class: 'btn small primary', onclick: () => void openReport(ctx, x.id) }, 'Open'), h('button', { class: 'btn small', onclick: async () => { const f = await ctx.api<string>('GET', `/api/reports/${x.id}/csv`); download(`orvms-report-${x.period}.csv`, f.data, 'text/csv'); } }, 'CSV')),
          ))),
    );
  };
  void load();
  return root;
}

const RISK_COLOR: Record<string, string> = { low: '#10b981', medium: '#f59e0b', high: '#fb7185', critical: '#ff2d55' };
const STATUS_COLOR: Record<string, string> = { draft: '#64748b', submitted: '#f59e0b', changes_requested: '#d99a06', approved: '#60a5fa', rejected: '#fb7185', active: '#10b981', completed: '#94a3b8', cancelled: '#475569' };
const SHIP_COLOR: Record<string, string> = { on_track: '#10b981', at_risk: '#f59e0b', late: '#fb7185', unplanned: '#64748b' };

async function openReport(ctx: Ctx, id: string): Promise<void> {
  const r = await ctx.api<{ id: string; period: string; generatedAt: number; generatedBy: string; payload: RiskReport }>('GET', `/api/reports/${id}`);
  if (r.status !== 200) return ctx.toast('Report not found', 'warn');
  const p = r.data.payload;
  const m = modal(
    h(
      'div',
      {},
      h(
        'div',
        { class: 'paper report' },
        h('div', { class: 'paper-top' }, h('div', {}, h('div', { class: 'paper-brand' }, 'ORVMS'), h('div', { class: 'paper-sub' }, 'Risk & Compliance Report')), h('div', { class: 'paper-title' }, monthName(p.period).toUpperCase())),
        h('div', { class: 'paper-meta' }, h('div', {}, h('small', {}, 'Organisation'), h('strong', {}, p.org.name)), h('div', {}, h('small', {}, 'Generated'), h('strong', {}, `${dt(r.data.generatedAt)} (${r.data.generatedBy === 'scheduler' ? 'scheduled' : r.data.generatedBy})`))),
        h('div', { class: 'rep-hero' }, ring(p.postureScore, { size: 110, label: 'Risk posture', text: String(p.postureScore) }), h('ul', {}, ...p.headline.map((l) => h('li', {}, l)))),
        h('h4', {}, 'Voyages'),
        h('div', { class: 'rep-cols' },
          donut(Object.entries(p.voyages.byRiskLevel).map(([k, v]) => ({ label: k, value: v, color: RISK_COLOR[k] ?? '#64748b' })), { big: String(p.voyages.total), small: 'voyages' }, 130),
          hbars(Object.entries(p.voyages.byStatus).map(([k, v]) => ({ label: pretty(k), value: v, color: STATUS_COLOR[k] }))),
          h('div', {}, kv('Awaiting approval', String(p.voyages.awaitingApproval)), kv('Avg time to approve', p.voyages.avgApprovalHours === null ? 'n/a' : `${p.voyages.avgApprovalHours} h`), kv('Deviation / exposure alerts', String(p.voyages.deviations))),
        ),
        h('h4', {}, 'Supply chain'),
        h('div', { class: 'rep-cols' },
          donut(Object.entries(p.shipments.byRisk).map(([k, v]) => ({ label: pretty(k), value: v, color: SHIP_COLOR[k] ?? '#64748b' })), { big: String(p.shipments.total), small: 'shipments' }, 130),
          h('div', {}, kv('Delivered', String(p.shipments.delivered)), kv('On-time delivery', p.shipments.onTimePct === null ? 'n/a' : `${p.shipments.onTimePct}%`), kv('Value moved', rupees(p.shipments.valueMovedInr)), kv('Value currently at risk', rupees(p.shipments.valueAtRiskInr))),
        ),
        h('h4', {}, 'Incident handling'),
        h('div', { class: 'rep-cols' },
          ring(p.incidents.slaMetPct, { size: 96, label: 'SLA met' , text: p.incidents.slaMetPct === null ? 'n/a' : `${p.incidents.slaMetPct}%` }),
          h('div', {}, kv('Reports filed', String(p.incidents.total)), kv('Escalated', String(p.incidents.escalated)), kv('Avg acknowledgement', p.incidents.avgAckMinutes === null ? 'n/a' : `${p.incidents.avgAckMinutes} min`), kv('Avg resolution', p.incidents.avgResolveHours === null ? 'n/a' : `${p.incidents.avgResolveHours} h`)),
        ),
        h('h4', {}, 'Alerts on the fleet'),
        h('div', { class: 'rep-cols' }, h('div', {}, kv('Total alerts', String(p.alerts.total)), ...Object.entries(p.alerts.bySeverity).map(([k, v]) => kv(k, String(v)))), hbars(p.alerts.topRules.map((x) => ({ label: pretty(x.rule), value: x.count })))),
        h('h4', {}, 'Approval controls (evidence)'),
        h('table', { class: 'tbl compact' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Control'), h('th', { class: 'num' }, 'Passed'), h('th', {}, 'Result'))),
          h('tbody', {}, ...p.compliance.checks.map((c) => h('tr', {}, h('td', {}, c.label), h('td', { class: 'num' }, `${c.passed} / ${c.total}`), h('td', {}, c.total === 0 ? badge('muted', 'n/a') : c.passed === c.total ? badge('ok', 'Pass') : badge('bad', 'Review')))))),
        h('p', { class: 'paper-foot' }, `Posture score starts at 100 and loses points for route deviations, late deliveries, escalated incidents and failed approval controls. Zones are modelled, not official limits. Plan: ${p.org.planId}. Usage: ${p.usage.voyages} voyages, ${p.usage.apiCalls} API calls.`),
      ),
      h('div', { class: 'row no-print' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Close'), h('span', { class: 'row-gap' }, h('button', { class: 'btn', onclick: async () => { const f = await ctx.api<string>('GET', `/api/reports/${id}/csv`); download(`orvms-report-${p.period}.csv`, f.data, 'text/csv'); } }, 'CSV'), h('button', { class: 'btn primary', onclick: printDocument }, 'Print / Save PDF'))),
    ),
    true,
  );
}

// ── service levels (Coast Guard) ─────────────────────────────────────────────
export function serviceLevelsPage(ctx: Ctx): HTMLElement {
  const root = h('div', { class: 'page-inner wide' });
  const body = h('div', {}, loading());
  root.append(body);
  const load = async (): Promise<void> => {
    const r = await ctx.api<{ analytics: CaseAnalytics }>('GET', '/api/cases/analytics');
    await ctx.refreshIncidents();
    clear(body);
    const a = r.data.analytics;
    const missing = (ctx.incidents() as CaseRecord[]).filter((c) => c.status === 'closed' && !c.postIncident);
    body.append(
      pageHead('Service levels', 'How well reports are being worked: response times, SLA compliance, outcomes and post-incident learning.'),
      h('div', { class: 'kgrid' },
        kcard('shield', a.slaMetPct === null ? 'n/a' : `${a.slaMetPct}%`, 'SLA compliance', 'closed cases within deadline', a.slaMetPct === null ? 'info' : a.slaMetPct >= 90 ? 'ok' : a.slaMetPct >= 70 ? 'warn' : 'bad'),
        kcard('clock', a.avgAckMinutes === null ? 'n/a' : `${a.avgAckMinutes} min`, 'Avg acknowledgement', 'report to first response', 'info'),
        kcard('service', a.avgResolveHours === null ? 'n/a' : `${a.avgResolveHours} h`, 'Avg resolution', 'report to closure', 'info'),
        kcard('incidents', String(a.open), 'Open cases', `${a.escalated} escalated overall`, a.escalated ? 'warn' : 'ok'),
        kcard('reports', `${a.postIncidentFiled}/${a.closed}`, 'Post-incident reports', `${a.closedWithoutReport} still to file`, a.closedWithoutReport ? 'warn' : 'ok'),
      ),
      h('div', { class: 'grid3' },
        h('section', { class: 'card' }, h('h3', {}, 'Outcome of closed cases'), donut(Object.entries(a.byClosure).map(([k, v]) => ({ label: pretty(k), value: v, color: CASE_COLOR[k] ?? 'var(--muted)' })), { big: String(a.closed), small: 'closed' })),
        h('section', { class: 'card' }, h('h3', {}, 'Cases by priority'), hbars(Object.entries(a.byPriority).sort().map(([k, v]) => ({ label: k, value: v, color: PRIO_COLOR[k] })))),
        h('section', { class: 'card' }, h('h3', {}, 'Cases by category'), hbars(Object.entries(a.byCategory).sort((x, y) => y[1] - x[1]).map(([k, v]) => ({ label: pretty(k), value: v })))),
      ),
      h('h3', {}, 'Performance by controller desk'),
      h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Desk'), h('th', { class: 'num' }, 'Cases'), h('th', { class: 'num' }, 'Open'), h('th', {}, 'SLA met'))),
        h('tbody', {}, ...a.byDesk.map((d) => h('tr', {}, h('td', {}, d.desk), h('td', { class: 'num' }, String(d.total)), h('td', { class: 'num' }, String(d.open)), h('td', {}, d.slaMetPct === null ? h('span', { class: 'muted' }, 'n/a') : h('span', { class: 'sla-cell' }, hbars([{ label: '', value: d.slaMetPct, color: d.slaMetPct >= 90 ? 'var(--ok)' : d.slaMetPct >= 70 ? 'var(--warn)' : 'var(--bad)' }], { max: 100, format: (n) => `${n}%` }))))))),
      h('h3', {}, `Closed cases awaiting a post-incident report (${missing.length})`),
      missing.length === 0 ? h('p', { class: 'empty' }, 'All closed cases have a post-incident report.') : h('div', {}, ...missing.slice(0, 8).map((c) => h('div', { class: 'inc-mini row-between' }, h('span', {}, h('strong', {}, c.vesselName), ` · ${c.station.name} · closed ${c.closureCode ? pretty(c.closureCode) : ''}`), h('button', { class: 'btn small primary', onclick: () => openPostIncident(ctx, c, load) }, 'File report')))),
    );
  };
  void load();
  return root;
}

export function openPostIncident(ctx: Ctx, c: CaseRecord, done: () => void | Promise<void>): void {
  const area = (ph: string, rows = 3): HTMLTextAreaElement => h('textarea', { rows, placeholder: ph, maxlength: 1500 }) as HTMLTextAreaElement;
  const summary = area('What happened, in two or three sentences', 3);
  const findings = area('What was found (identity, behaviour, evidence)');
  const actions = area('What was done (assets tasked, communications, hand-overs)');
  const lessons = area('What should change next time (optional)', 2);
  const err = h('p', { class: 'error', role: 'alert' });
  const m = modal(h('div', {},
    h('h2', {}, 'Post-incident report'),
    h('p', { class: 'muted' }, `${c.vesselName} · ${c.station.name} · ${c.priority} · closed as ${c.closureCode ? pretty(c.closureCode) : 'n/a'}`),
    field('Summary', summary), field('Findings', findings), field('Actions taken', actions), field('Lessons learned', lessons), err,
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: async () => {
      const r = await ctx.api<{ error?: string }>('POST', `/api/cases/${c.id}/post-incident`, { summary: summary.value, findings: findings.value, actionsTaken: actions.value, lessonsLearned: lessons.value });
      if (r.status === 200) { m.close(); ctx.toast('Post-incident report filed', 'ok'); await done(); } else err.textContent = r.data.error ?? 'Could not file the report';
    } }, 'File report')),
  ));
}

// ── platform: revenue ────────────────────────────────────────────────────────
interface Revenue {
  mrrInr: number; arrInr: number; outstandingInr: number; overdueInr: number; collectedInr: number; overdueInvoices: number;
  customers: Array<{ orgId: string; name: string; planId: string; status: string; supportTier: string; mrrInr: number; renewsAt: number; autoRenew: boolean; outstandingInr: number; overdueInr: number; collectedInr: number }>;
  trend: Array<{ period: string; billedInr: number; collectedInr: number }>;
  mix: Record<string, number>;
}
const PLAN_COLOR: Record<string, string> = { starter: '#64748b', professional: '#22b8cf', enterprise: '#a78bfa' };

export function revenuePage(ctx: Ctx): HTMLElement {
  const root = h('div', { class: 'page-inner wide' });
  const body = h('div', {}, loading());
  root.append(body);
  const load = async (): Promise<void> => {
    const r = await ctx.api<Revenue>('GET', '/api/admin/revenue');
    clear(body);
    const v = r.data;
    body.append(
      pageHead('Revenue & receivables', 'Recurring revenue, billing and collections across customers (sandbox payments).', h('button', { class: 'btn primary', onclick: async () => {
        const run = await ctx.api<{ issued: number }>('POST', '/api/admin/billing/run', {});
        ctx.toast(run.data.issued ? `${run.data.issued} invoice(s) issued for last month` : 'Nothing new to invoice for last month', run.data.issued ? 'ok' : 'info');
        await load();
      } }, 'Run month-end billing')),
      h('div', { class: 'kgrid' },
        kcard('revenue', rupees(v.mrrInr), 'Monthly recurring revenue', `${rupees(v.arrInr)} annualised`, 'ok'),
        kcard('money', rupees(v.collectedInr), 'Collected to date', 'sandbox payments', 'ok'),
        kcard('billing', rupees(v.outstandingInr), 'Outstanding', 'awaiting payment', v.outstandingInr ? 'warn' : 'ok'),
        kcard('clock', rupees(v.overdueInr), 'Overdue', `${v.overdueInvoices} invoice(s)`, v.overdueInr ? 'bad' : 'ok'),
      ),
      h('div', { class: 'grid2w' },
        h('section', { class: 'card' }, h('h3', {}, 'Billed vs collected'), v.trend.length ? columns(v.trend.map((t) => ({ label: monthName(t.period).split(' ')[0] ?? t.period, a: t.billedInr, b: t.collectedInr })), ['Billed', 'Collected'], rupees) : h('p', { class: 'empty' }, 'No invoices yet.')),
        h('section', { class: 'card' }, h('h3', {}, 'Customers by plan'), donut(Object.entries(v.mix).map(([k, n]) => ({ label: k, value: n, color: PLAN_COLOR[k] ?? '#64748b' })), { big: String(Object.values(v.mix).reduce((a, b) => a + b, 0)), small: 'customers' })),
      ),
      h('h3', {}, 'Customers'),
      h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Customer'), h('th', {}, 'Plan'), h('th', {}, 'Support'), h('th', { class: 'num' }, 'MRR'), h('th', { class: 'num' }, 'Outstanding'), h('th', { class: 'num' }, 'Overdue'), h('th', {}, 'Renews'))),
        h('tbody', {}, ...v.customers.map((c) => h('tr', {}, h('td', {}, h('strong', {}, c.name), c.status === 'suspended' ? badge('bad', 'suspended') : null), h('td', {}, badge('muted', c.planId)), h('td', {}, c.supportTier), h('td', { class: 'num' }, rupees(c.mrrInr)), h('td', { class: 'num' }, rupees(c.outstandingInr)), h('td', { class: `num ${c.overdueInr ? 'bad-text' : ''}` }, rupees(c.overdueInr)), h('td', {}, `${dateOnly(c.renewsAt)}${c.autoRenew ? ' ↻' : ''}`))))),
    );
  };
  void load();
  return root;
}

// ── platform: operations ─────────────────────────────────────────────────────
interface Ops {
  version: string; now: number; uptimeSec: number;
  storage: { engine: string; schemaVersion: number; migrations: number };
  feed: { source: string; connected: boolean; synthetic: boolean; region: string | null; messages: number; lastMessageAt: number | null; error: string | null };
  live: { vessels: number; alerts: number; openAlerts: number };
  records: Record<string, number>;
  background: { runs: number; errors: number; lastRunAt: number | null; lastRunMs: number | null; lastResult: Record<string, number> | null; lastBilling: number | null; lastReports: number | null; lastRetention: number | null };
  integrations: { apiCallsThisMonth: number; webhooks24h: number; webhookSuccessPct: number | null; webhookFailed24h: number };
  environment: { name: string };
  logs: Array<{ ts: number; level: string; event: string; data?: Record<string, unknown> }>;
}

const uptime = (s: number): string => (s >= 86_400 ? `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h` : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m ${s % 60}s`);

export function opsPage(ctx: Ctx): HTMLElement {
  const root = h('div', { class: 'page-inner wide' });
  const body = h('div', {}, loading());
  root.append(body);
  const timer = setInterval(() => void load(), 5000);
  const load = async (): Promise<void> => {
    if (!root.isConnected && root.dataset.ready) return void clearInterval(timer);
    const r = await ctx.api<Ops>('GET', '/api/admin/ops');
    if (r.status !== 200) return;
    const o = r.data;
    const feedOk = o.feed.connected && !o.feed.error;
    const health = (ok: boolean, warn = false): HTMLElement => h('span', { class: `hdot ${ok ? 'ok' : warn ? 'warn' : 'bad'}` });
    clear(body);
    body.append(
      pageHead('Operations & health', `Version ${o.version} · environment ${o.environment.name} · refreshes every 5 seconds`, h('button', { class: 'btn', onclick: async () => {
        const b = await ctx.api<unknown>('GET', '/api/admin/backup');
        download(`orvms-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(b.data, null, 2), 'application/json');
        ctx.toast('Platform backup downloaded: store it off-platform', 'ok');
      } }, icon('download', 14), ' Download platform backup')),
      h('div', { class: 'kgrid' },
        kcard('ops', uptime(o.uptimeSec), 'Uptime', `since last restart`, 'ok'),
        kcard('map', String(o.live.vessels), 'Vessels tracked', `${o.live.openAlerts} open alerts`, 'info'),
        kcard('service', o.background.lastRunMs === null ? 'n/a' : `${o.background.lastRunMs} ms`, 'Last background run', `${o.background.runs} runs · ${o.background.errors} errors`, o.background.errors ? 'warn' : 'ok'),
        kcard('shield', o.integrations.webhookSuccessPct === null ? 'n/a' : `${o.integrations.webhookSuccessPct}%`, 'Webhook delivery (24h)', `${o.integrations.webhooks24h} sent · ${o.integrations.webhookFailed24h} failed`, o.integrations.webhookFailed24h ? 'warn' : 'ok'),
      ),
      h('div', { class: 'grid3' },
        h('section', { class: 'card' }, h('h3', {}, health(feedOk, o.feed.connected), ' Live data feed'), kv('Source', o.feed.source), kv('Coverage', o.feed.region ?? 'n/a'), kv('Last message', o.feed.lastMessageAt ? ago(o.feed.lastMessageAt, o.now) : 'none yet'), kv('Messages received', o.feed.messages.toLocaleString('en-IN')), kv('Synthetic traffic', o.feed.synthetic ? 'blended in' : 'off'), o.feed.error ? h('p', { class: 'warn-text' }, o.feed.error) : null),
        h('section', { class: 'card' }, h('h3', {}, health(true), ' Storage'), kv('Engine', o.storage.engine), kv('Schema version', `v${o.storage.schemaVersion} (${o.storage.migrations} migrations)`), ...Object.entries(o.records).map(([k, n]) => kv(pretty(k), String(n)))),
        h('section', { class: 'card' }, h('h3', {}, health(o.background.errors === 0), ' Scheduled processing'), kv('Voyage / SLA / shipment sweeps', o.background.lastRunAt ? ago(o.background.lastRunAt, o.now) : 'pending'), kv('Month-end billing', o.background.lastBilling ? ago(o.background.lastBilling, o.now) : 'pending'), kv('Scheduled reports', o.background.lastReports ? ago(o.background.lastReports, o.now) : 'pending'), kv('Retention purge', o.background.lastRetention ? ago(o.background.lastRetention, o.now) : 'pending'), kv('API calls this month', o.integrations.apiCallsThisMonth.toLocaleString('en-IN'))),
      ),
      h('h3', {}, 'Structured log (latest 80)'),
      h('div', { class: 'logbox' }, ...(o.logs.length ? o.logs.map((l) => h('div', { class: `logline ${l.level}` }, h('span', { class: 'lt' }, new Date(l.ts).toISOString().slice(11, 19)), h('span', { class: 'll' }, l.level), h('span', { class: 'le' }, l.event), h('span', { class: 'ld muted' }, l.data ? JSON.stringify(l.data) : ''))) : [h('p', { class: 'empty' }, 'No events logged yet.')])),
    );
  };
  void load().then(() => { root.dataset.ready = '1'; });
  return root;
}
