/** Commercial rules: contracts, invoice generation, payment terms and receivables. Pure functions; amounts are INR. */
import { PLANS, periodOf } from './plans';
import type { Contract, Invoice, InvoiceLine, Organization, Payment, PaymentMethod, PlanId, SupportTier } from './types';

export const GST_RATE = 0.18;
const DAY = 86_400_000;

export const SUPPORT_TIERS: Record<SupportTier, { label: string; monthlyFeeInr: number; response: string }> = {
  standard: { label: 'Standard', monthlyFeeInr: 0, response: 'Business hours, next business day' },
  priority: { label: 'Priority', monthlyFeeInr: 15_000, response: '24x5, 4-hour first response' },
  premium: { label: 'Premium', monthlyFeeInr: 45_000, response: '24x7, 30-minute first response, named engineer' },
};

export const PAYMENT_METHODS: PaymentMethod[] = ['upi', 'card', 'netbanking'];
export const RETENTION_OPTIONS = [6, 12, 24, 36, 60];

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Contract a new customer starts with (platform admin adjusts it afterwards). */
export function defaultContract(org: Pick<Organization, 'id' | 'planId' | 'createdAt'>, signedBy: string, now: number): Contract {
  const enterprise = org.planId === 'enterprise';
  const startsAt = org.createdAt;
  return {
    orgId: org.id,
    supportTier: enterprise ? 'premium' : org.planId === 'professional' ? 'priority' : 'standard',
    termMonths: 12,
    startsAt,
    renewsAt: addMonths(startsAt, 12),
    autoRenew: true,
    paymentTermsDays: enterprise ? 45 : 15,
    slaUptimePct: enterprise ? 99.9 : org.planId === 'professional' ? 99.5 : 99,
    billingContact: '',
    gstin: '',
    reportFrequency: org.planId === 'starter' ? 'off' : 'monthly',
    retentionMonths: 24,
    signedBy,
    signedAt: Math.min(startsAt, now),
  };
}

export function addMonths(ts: number, months: number): number {
  const d = new Date(ts);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.getTime();
}

/** First instant of a YYYY-MM period and of the next one. */
export function periodBounds(period: string): { from: number; to: number } {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return { from: Date.UTC(y, m - 1, 1), to: Date.UTC(y, m, 1) };
}

export function previousPeriod(period: string): string {
  const { from } = periodBounds(period);
  return periodOf(from - DAY);
}

export const isPeriod = (p: unknown): p is string => typeof p === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(p);

export function monthLabel(period: string): string {
  const { from } = periodBounds(period);
  return new Date(from).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** Monthly recurring revenue for a customer: subscription plus the contracted support add-on. */
export function mrrOf(planId: PlanId, contract: Pick<Contract, 'supportTier'>): number {
  return PLANS[planId].monthlyFeeInr + SUPPORT_TIERS[contract.supportTier].monthlyFeeInr;
}

export const invoiceNumber = (orgId: string, period: string): string => `INV-${period.replace('-', '')}-${orgId.replace(/^org-/, '').toUpperCase().slice(0, 6)}`;

/**
 * Build the invoice for a period: subscription + support add-on + voyage overage, plus GST at 18 %.
 * Returns undefined when there is nothing to bill (e.g. a free plan with no overage).
 */
export function buildInvoice(input: { org: Organization; contract: Contract; period: string; voyages: number; issuedAt: number; id: string }): Invoice | undefined {
  const { org, contract, period, voyages, issuedAt, id } = input;
  const plan = PLANS[org.planId];
  const label = monthLabel(period);
  const lines: InvoiceLine[] = [];
  if (plan.monthlyFeeInr > 0) lines.push({ description: `${plan.name} plan subscription - ${label}`, quantity: 1, unitInr: plan.monthlyFeeInr, amountInr: plan.monthlyFeeInr });
  const support = SUPPORT_TIERS[contract.supportTier];
  if (support.monthlyFeeInr > 0) lines.push({ description: `${support.label} support (${support.response}) - ${label}`, quantity: 1, unitInr: support.monthlyFeeInr, amountInr: support.monthlyFeeInr });
  const over = Math.max(0, voyages - plan.limits.voyagesPerMonth);
  if (over > 0) lines.push({ description: `Voyage risk assessments above the ${plan.limits.voyagesPerMonth}/month allowance (${voyages} used)`, quantity: over, unitInr: plan.overagePerVoyageInr, amountInr: over * plan.overagePerVoyageInr });
  if (lines.length === 0) return undefined;
  const subtotalInr = round2(lines.reduce((a, l) => a + l.amountInr, 0));
  const gstInr = round2(subtotalInr * GST_RATE);
  return {
    id, orgId: org.id, number: invoiceNumber(org.id, period), period, issuedAt, dueAt: issuedAt + contract.paymentTermsDays * DAY,
    lines, subtotalInr, gstInr, totalInr: round2(subtotalInr + gstInr), status: 'issued', payments: [],
  };
}

export type InvoiceView = 'paid' | 'issued' | 'overdue' | 'void';

/** Overdue is derived from the due date, never stored, so it cannot go stale. */
export function viewStatus(inv: Pick<Invoice, 'status' | 'dueAt'>, now: number): InvoiceView {
  if (inv.status === 'paid') return 'paid';
  if (inv.status === 'void') return 'void';
  return now > inv.dueAt ? 'overdue' : 'issued';
}

export const daysOverdue = (inv: Pick<Invoice, 'dueAt'>, now: number): number => Math.max(0, Math.floor((now - inv.dueAt) / DAY));

export const amountDue = (inv: Pick<Invoice, 'totalInr' | 'payments' | 'status'>): number =>
  inv.status === 'paid' || inv.status === 'void' ? 0 : round2(inv.totalInr - inv.payments.reduce((a, p) => a + p.amountInr, 0));

/** Record a payment taken through the sandbox gateway; marks the invoice paid when fully covered. */
export function applyPayment(inv: Invoice, method: PaymentMethod, by: string, now: number, paymentId: string, reference: string): Invoice {
  const due = amountDue(inv);
  const payment: Payment = { id: paymentId, ts: now, amountInr: due, method, reference, by };
  const payments = [...inv.payments, payment];
  const settled = payments.reduce((a, p) => a + p.amountInr, 0) >= inv.totalInr - 0.005;
  return { ...inv, payments, status: settled ? 'paid' : inv.status, paidAt: settled ? now : undefined };
}

export interface Receivables {
  outstandingInr: number;
  overdueInr: number;
  collectedInr: number;
  invoices: number;
  overdueInvoices: number;
}

export function receivables(invoices: Invoice[], now: number): Receivables {
  const r: Receivables = { outstandingInr: 0, overdueInr: 0, collectedInr: 0, invoices: invoices.length, overdueInvoices: 0 };
  for (const i of invoices) {
    r.collectedInr += i.payments.reduce((a, p) => a + p.amountInr, 0);
    const v = viewStatus(i, now);
    if (v === 'issued' || v === 'overdue') r.outstandingInr += amountDue(i);
    if (v === 'overdue') {
      r.overdueInr += amountDue(i);
      r.overdueInvoices++;
    }
  }
  r.outstandingInr = round2(r.outstandingInr);
  r.overdueInr = round2(r.overdueInr);
  r.collectedInr = round2(r.collectedInr);
  return r;
}

const csvCell = (v: string | number): string => {
  const t = String(v);
  return /^[=+\-@\t\r]/.test(t) ? `'${t}` : /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

export function invoiceCsv(inv: Invoice, orgName: string): string {
  const rows: Array<Array<string | number>> = [
    ['invoice', inv.number], ['customer', orgName], ['period', inv.period], ['issued', new Date(inv.issuedAt).toISOString().slice(0, 10)], ['due', new Date(inv.dueAt).toISOString().slice(0, 10)],
    [],
    ['description', 'quantity', 'unit_inr', 'amount_inr'],
    ...inv.lines.map((l) => [l.description, l.quantity, l.unitInr, l.amountInr]),
    [],
    ['subtotal_inr', '', '', inv.subtotalInr], ['gst_18pct_inr', '', '', inv.gstInr], ['total_inr', '', '', inv.totalInr], ['status', inv.status],
  ];
  return rows.map((r) => r.map(csvCell).join(',')).join('\n');
}
