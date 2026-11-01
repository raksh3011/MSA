import type { Organization, Plan, PlanId, UsageMetric } from './types';

/** Subscription catalogue. Prices are illustrative (INR); payments are not processed by ORVMS. */
export const PLANS: Record<PlanId, Plan> = {
  starter: {
    id: 'starter',
    name: 'Starter',
    monthlyFeeInr: 0,
    overagePerVoyageInr: 2500,
    limits: { vessels: 5, users: 3, voyagesPerMonth: 5, apiCallsPerMonth: 0, apiKeysAndWebhooks: false },
  },
  professional: {
    id: 'professional',
    name: 'Professional',
    monthlyFeeInr: 49_000,
    overagePerVoyageInr: 1500,
    limits: { vessels: 25, users: 10, voyagesPerMonth: 50, apiCallsPerMonth: 10_000, apiKeysAndWebhooks: true },
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    monthlyFeeInr: 150_000,
    overagePerVoyageInr: 800,
    limits: { vessels: 500, users: 100, voyagesPerMonth: 1000, apiCallsPerMonth: 1_000_000, apiKeysAndWebhooks: true },
  },
};

export function planOf(org: Pick<Organization, 'planId'>): Plan {
  return PLANS[org.planId];
}

export const periodOf = (ts: number): string => new Date(ts).toISOString().slice(0, 7);

export interface QuotaCheck {
  ok: boolean;
  limit: number;
  used: number;
  message?: string;
}

/** Hard quota (vessels, users): refuse when adding one more would exceed the plan limit. */
export function checkQuota(plan: Plan, metric: 'vessels' | 'users', used: number): QuotaCheck {
  const limit = plan.limits[metric];
  const ok = used + 1 <= limit;
  return { ok, limit, used, message: ok ? undefined : `${plan.name} plan allows ${limit} ${metric}. Upgrade to add more.` };
}

/** Invoice estimate for the period: subscription + voyages above the allowance (usage-based). */
export function estimateInvoice(plan: Plan, usage: Record<UsageMetric, number>): { subscriptionInr: number; overageVoyages: number; overageInr: number; totalInr: number } {
  const overageVoyages = Math.max(0, usage.voyages - plan.limits.voyagesPerMonth);
  const overageInr = overageVoyages * plan.overagePerVoyageInr;
  return { subscriptionInr: plan.monthlyFeeInr, overageVoyages, overageInr, totalInr: plan.monthlyFeeInr + overageInr };
}
