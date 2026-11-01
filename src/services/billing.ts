/** Commercial services: contracts, invoicing, sandbox payments and receivables. */
import { PAYMENT_METHODS, RETENTION_OPTIONS, SUPPORT_TIERS, amountDue, applyPayment, buildInvoice, daysOverdue, defaultContract, invoiceCsv, isPeriod, mrrOf, periodBounds, previousPeriod, receivables, viewStatus } from '../domain/billing';
import { PLANS, periodOf } from '../domain/plans';
import type { Contract, Invoice, Organization, PaymentMethod, ReportFrequency, SupportTier } from '../domain/types';
import { randomToken } from '../domain/webhooks';
import { emit, type Services } from './context';
import { usageSummary, type Result } from './org';

const bad = (error: string, status: 400 | 402 | 403 | 404 | 409 = 400): { ok: false; status: 400 | 402 | 403 | 404 | 409; error: string } => ({ ok: false, status, error });

/** Every organisation has exactly one contract; create the default lazily for customers onboarded before this module existed. */
export async function ensureContract(s: Services, org: Organization): Promise<Contract> {
  const existing = await s.repo.contracts.get(org.id);
  if (existing) return existing;
  const c = defaultContract(org, 'platform', s.now());
  await s.repo.contracts.upsert(c);
  return c;
}

/** Customer-editable terms (org admin) and commercial terms (platform admin only). */
export async function updateContract(s: Services, org: Organization, actor: { username: string; admin: boolean }, input: Record<string, unknown>): Promise<Result<Contract>> {
  const c = { ...(await ensureContract(s, org)) };
  if (input.billingContact !== undefined) {
    if (typeof input.billingContact !== 'string' || input.billingContact.length > 120) return bad('billingContact must be text up to 120 characters');
    if (input.billingContact && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.billingContact)) return bad('billingContact must be an e-mail address');
    c.billingContact = input.billingContact;
  }
  if (input.gstin !== undefined) {
    if (typeof input.gstin !== 'string' || (input.gstin !== '' && !/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(input.gstin.toUpperCase()))) return bad('gstin must be a valid 15-character GSTIN');
    c.gstin = input.gstin.toUpperCase();
  }
  if (input.autoRenew !== undefined) {
    if (typeof input.autoRenew !== 'boolean') return bad('autoRenew must be true or false');
    c.autoRenew = input.autoRenew;
  }
  if (input.reportFrequency !== undefined) {
    if (input.reportFrequency !== 'off' && input.reportFrequency !== 'monthly') return bad('reportFrequency must be off or monthly');
    c.reportFrequency = input.reportFrequency as ReportFrequency;
  }
  if (input.retentionMonths !== undefined) {
    if (typeof input.retentionMonths !== 'number' || !RETENTION_OPTIONS.includes(input.retentionMonths)) return bad(`retentionMonths must be one of ${RETENTION_OPTIONS.join(', ')}`);
    c.retentionMonths = input.retentionMonths;
  }
  const commercial = ['supportTier', 'paymentTermsDays', 'termMonths', 'slaUptimePct'].some((k) => input[k] !== undefined);
  if (commercial) {
    if (!actor.admin) return bad('Commercial terms can only be changed by the platform administrator', 403);
    if (input.supportTier !== undefined) {
      if (typeof input.supportTier !== 'string' || !(input.supportTier in SUPPORT_TIERS)) return bad('Unknown support tier');
      c.supportTier = input.supportTier as SupportTier;
    }
    if (input.paymentTermsDays !== undefined) {
      if (typeof input.paymentTermsDays !== 'number' || ![7, 15, 30, 45, 60].includes(input.paymentTermsDays)) return bad('paymentTermsDays must be 7, 15, 30, 45 or 60');
      c.paymentTermsDays = input.paymentTermsDays;
    }
    if (input.termMonths !== undefined) {
      if (typeof input.termMonths !== 'number' || ![12, 24, 36].includes(input.termMonths)) return bad('termMonths must be 12, 24 or 36');
      c.termMonths = input.termMonths;
      const end = new Date(c.startsAt);
      end.setUTCMonth(end.getUTCMonth() + c.termMonths);
      c.renewsAt = end.getTime();
    }
    if (input.slaUptimePct !== undefined) {
      if (typeof input.slaUptimePct !== 'number' || input.slaUptimePct < 95 || input.slaUptimePct > 99.99) return bad('slaUptimePct must be between 95 and 99.99');
      c.slaUptimePct = input.slaUptimePct;
    }
  }
  await s.repo.contracts.upsert(c);
  s.hub.log(actor.username, 'contract.updated', `${org.id} ${Object.keys(input).join(',')}`);
  return { ok: true, value: c };
}

/** Issue the invoice for a billing period. Idempotent: an existing invoice for the period is returned unchanged. */
export async function issueInvoice(s: Services, org: Organization, period: string): Promise<Result<Invoice | undefined>> {
  if (!isPeriod(period)) return bad('period must be YYYY-MM');
  const existing = await s.repo.invoices.getByPeriod(org.id, period);
  if (existing) return { ok: true, value: existing };
  const contract = await ensureContract(s, org);
  const voyages = await s.repo.usage.get(org.id, period, 'voyages');
  const issuedAt = Math.max(s.now(), periodBounds(period).to);
  const inv = buildInvoice({ org, contract, period, voyages, issuedAt, id: crypto.randomUUID() });
  if (!inv) return { ok: true, value: undefined };
  await s.repo.invoices.insert(inv);
  s.log('info', 'invoice.issued', { org: org.id, number: inv.number, totalInr: inv.totalInr });
  s.hub.log('system', 'invoice.issued', `${org.id} ${inv.number} INR ${inv.totalInr}`);
  emit(s, org.id, 'invoice.issued', { invoiceId: inv.id, number: inv.number, period, totalInr: inv.totalInr, dueAt: inv.dueAt });
  return { ok: true, value: inv };
}

/** Month-end billing run for every active customer. Returns how many new invoices were issued. */
export async function runBilling(s: Services, period?: string): Promise<number> {
  const target = period ?? previousPeriod(periodOf(s.now()));
  const { to } = periodBounds(target);
  let issued = 0;
  for (const org of await s.repo.orgs.list()) {
    if (org.kind !== 'shipping_company' || org.status !== 'active' || org.createdAt >= to) continue;
    if (await s.repo.invoices.getByPeriod(org.id, target)) continue;
    const r = await issueInvoice(s, org, target);
    if (r.ok && r.value) issued++;
  }
  return issued;
}

/** Take payment through the SANDBOX gateway: records the payment and settles the invoice. No real money moves. */
export async function payInvoice(s: Services, org: Organization, actor: string, id: string, method: unknown): Promise<Result<Invoice>> {
  if (typeof method !== 'string' || !(PAYMENT_METHODS as string[]).includes(method)) return bad(`method must be one of: ${PAYMENT_METHODS.join(', ')}`);
  const inv = await s.repo.invoices.get(org.id, id);
  if (!inv) return bad('Invoice not found', 404);
  if (inv.status === 'paid') return bad('Invoice is already paid', 409);
  if (inv.status === 'void') return bad('Invoice is void', 409);
  const next = applyPayment(inv, method as PaymentMethod, actor, s.now(), crypto.randomUUID(), `SBX-${randomToken(10).toUpperCase()}`);
  await s.repo.invoices.update(next);
  s.log('info', 'invoice.paid', { org: org.id, number: next.number, totalInr: next.totalInr, method });
  s.hub.log(actor, 'invoice.paid', `${org.id} ${next.number} via ${method} (sandbox)`);
  emit(s, org.id, 'invoice.paid', { invoiceId: next.id, number: next.number, totalInr: next.totalInr, paidAt: next.paidAt });
  return { ok: true, value: next };
}

export const withView = (inv: Invoice, now: number) => ({ ...inv, view: viewStatus(inv, now), amountDueInr: amountDue(inv), daysOverdue: daysOverdue(inv, now) });

/** Everything the customer's billing page needs. */
export async function billingSummary(s: Services, org: Organization) {
  const [contract, invoices, usage] = await Promise.all([ensureContract(s, org), s.repo.invoices.list(org.id), usageSummary(s, org)]);
  const now = s.now();
  const preview = buildInvoice({ org, contract, period: usage.period, voyages: usage.usage.voyages, issuedAt: periodBounds(usage.period).to, id: 'upcoming' });
  return {
    contract,
    plan: PLANS[org.planId],
    support: SUPPORT_TIERS[contract.supportTier],
    period: usage.period,
    usage: usage.usage,
    upcoming: preview,
    invoices: invoices.map((i) => withView(i, now)),
    receivables: receivables(invoices, now),
    sandbox: true,
  };
}

export async function invoiceFile(s: Services, org: Organization, id: string): Promise<{ csv: string; number: string } | undefined> {
  const inv = await s.repo.invoices.get(org.id, id);
  return inv ? { csv: invoiceCsv(inv, org.name), number: inv.number } : undefined;
}

/** Platform-owner revenue console: recurring revenue, receivables and collection per customer. */
export async function revenueOverview(s: Services) {
  const now = s.now();
  const [orgs, invoices, contracts] = await Promise.all([s.repo.orgs.list(), s.repo.invoices.listAll(), s.repo.contracts.list()]);
  const byOrg = new Map(contracts.map((c) => [c.orgId, c]));
  const customers = orgs.filter((o) => o.kind === 'shipping_company');
  const rows = customers.map((o) => {
    const c = byOrg.get(o.id) ?? defaultContract(o, 'platform', now);
    const mine = invoices.filter((i) => i.orgId === o.id);
    const ar = receivables(mine, now);
    return { orgId: o.id, name: o.name, planId: o.planId, status: o.status, supportTier: c.supportTier, mrrInr: o.status === 'active' ? mrrOf(o.planId, c) : 0, renewsAt: c.renewsAt, autoRenew: c.autoRenew, ...ar };
  });
  const total = receivables(invoices, now);
  const mrr = rows.reduce((a, r) => a + r.mrrInr, 0);
  const periods = [...new Set(invoices.map((i) => i.period))].sort().slice(-6);
  const trend = periods.map((p) => ({ period: p, billedInr: invoices.filter((i) => i.period === p).reduce((a, i) => a + i.totalInr, 0), collectedInr: invoices.filter((i) => i.period === p).reduce((a, i) => a + i.payments.reduce((x, y) => x + y.amountInr, 0), 0) }));
  return { mrrInr: mrr, arrInr: mrr * 12, ...total, customers: rows, trend, mix: Object.fromEntries((['starter', 'professional', 'enterprise'] as const).map((p) => [p, customers.filter((o) => o.planId === p).length])) };
}
