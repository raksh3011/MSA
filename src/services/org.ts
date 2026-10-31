/** Tenant administration: registry, users, subscription usage, API keys and webhooks. */
import { isCompanyRole, type Role } from '../core/types';
import { checkQuota, estimateInvoice, periodOf, planOf } from '../domain/plans';
import type { ApiKey, ApiScope, Organization, RegistryVessel, Webhook, WebhookEvent } from '../domain/types';
import { isAllowedWebhookUrl, randomToken, sha256Hex } from '../domain/webhooks';
import type { Services } from './context';

export type Result<T> = { ok: true; value: T } | { ok: false; status: 400 | 402 | 403 | 404 | 409; error: string };
const bad = (error: string, status: 400 | 402 | 403 | 404 | 409 = 400): { ok: false; status: 400 | 402 | 403 | 404 | 409; error: string } => ({ ok: false, status, error });

export const orgIdOf = (s: Services, username: string): string | undefined => s.hub.users.get(username)?.orgId;

export function usersOfOrg(s: Services, orgId: string): Array<{ username: string; displayName: string; role: Role }> {
  return [...s.hub.users.values()].filter((u) => u.orgId === orgId).map((u) => ({ username: u.username, displayName: u.displayName, role: u.role }));
}

export async function usageSummary(s: Services, org: Organization) {
  const plan = planOf(org);
  const period = periodOf(s.now());
  const [vessels, voyages, apiCalls] = await Promise.all([s.repo.registry.count(org.id), s.repo.usage.get(org.id, period, 'voyages'), s.repo.usage.get(org.id, period, 'api_calls')]);
  const users = usersOfOrg(s, org.id).length;
  return {
    org,
    plan,
    period,
    usage: { vessels, users, voyages, apiCalls },
    invoiceEstimate: estimateInvoice(plan, { voyages, api_calls: apiCalls }),
  };
}

// ── registry ─────────────────────────────────────────────────────────────────
const MMSI_RE = /^\d{9}$/;
const IMO_RE = /^\d{7}$/;

export async function upsertRegistryVessel(
  s: Services,
  org: Organization,
  input: { mmsi?: unknown; imo?: unknown; name?: unknown; vesselType?: unknown; flag?: unknown; grossTonnage?: unknown; owner?: unknown; status?: unknown },
): Promise<Result<RegistryVessel>> {
  if (typeof input.mmsi !== 'string' || !MMSI_RE.test(input.mmsi)) return bad('mmsi must be a 9-digit string');
  if (typeof input.name !== 'string' || input.name.trim().length < 2 || input.name.length > 80) return bad('name (2-80 characters) is required');
  if (input.imo !== undefined && input.imo !== '' && (typeof input.imo !== 'string' || !IMO_RE.test(input.imo))) return bad('imo must be 7 digits');
  const type = typeof input.vesselType === 'string' && input.vesselType ? input.vesselType : 'cargo';
  if (!['cargo', 'tanker', 'passenger', 'container', 'bulk', 'other'].includes(type)) return bad('Unknown vesselType');
  if (input.grossTonnage !== undefined && (typeof input.grossTonnage !== 'number' || input.grossTonnage < 0 || input.grossTonnage > 500_000)) return bad('grossTonnage out of range');
  const existing = await s.repo.registry.get(org.id, input.mmsi);
  const active = input.status !== 'retired';
  if (!existing && active) {
    const q = checkQuota(planOf(org), 'vessels', await s.repo.registry.count(org.id));
    if (!q.ok) return bad(q.message ?? 'Quota exceeded', 402);
  }
  const v: RegistryVessel = {
    orgId: org.id,
    mmsi: input.mmsi,
    imo: typeof input.imo === 'string' && input.imo ? input.imo : undefined,
    name: input.name.trim(),
    vesselType: type,
    flag: typeof input.flag === 'string' && input.flag ? input.flag.slice(0, 40) : 'India',
    grossTonnage: typeof input.grossTonnage === 'number' ? Math.round(input.grossTonnage) : undefined,
    owner: typeof input.owner === 'string' && input.owner ? input.owner.slice(0, 80) : undefined,
    status: active ? 'active' : 'retired',
    createdAt: existing?.createdAt ?? s.now(),
  };
  await s.repo.registry.upsert(v);
  return { ok: true, value: v };
}

export async function fleetMmsis(s: Services, orgId: string): Promise<Set<string>> {
  return new Set((await s.repo.registry.list(orgId)).filter((v) => v.status === 'active').map((v) => v.mmsi));
}

// ── users ────────────────────────────────────────────────────────────────────
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export async function createOrgUser(
  s: Services,
  org: Organization,
  input: { username?: unknown; password?: unknown; displayName?: unknown; role?: unknown },
): Promise<Result<{ username: string; role: Role }>> {
  const username = typeof input.username === 'string' ? input.username.toLowerCase() : '';
  if (!USERNAME_RE.test(username)) return bad('username must be 3-32 characters: lowercase letters, digits, . _ -');
  if (typeof input.password !== 'string' || input.password.length < 10 || input.password.length > 128) return bad('password must be 10-128 characters');
  if (typeof input.displayName !== 'string' || input.displayName.trim().length < 2) return bad('displayName is required');
  const allowed: Role[] = org.kind === 'shipping_company' ? ['operator', 'risk_officer', 'org_admin'] : ['analyst'];
  if (typeof input.role !== 'string' || !allowed.includes(input.role as Role)) return bad(`role must be one of: ${allowed.join(', ')}`);
  if (s.hub.users.has(username)) return bad('That username is taken', 409);
  const q = checkQuota(planOf(org), 'users', usersOfOrg(s, org.id).length);
  if (!q.ok) return bad(q.message ?? 'Quota exceeded', 402);
  const role = input.role as Role;
  await s.hub.addUser(username, input.password, role, input.displayName.trim(), undefined, isCompanyRole(role) ? org.name : undefined, org.id);
  return { ok: true, value: { username, role } };
}

// ── API keys ─────────────────────────────────────────────────────────────────
const ALL_SCOPES: ApiScope[] = ['read:fleet', 'read:alerts', 'read:voyages', 'write:voyages', 'read:shipments'];

export async function createApiKey(s: Services, org: Organization, actor: string, input: { name?: unknown; scopes?: unknown }): Promise<Result<{ key: ApiKey; secret: string }>> {
  if (!planOf(org).limits.apiKeysAndWebhooks) return bad('API keys are not included in your plan. Upgrade to Professional or Enterprise.', 402);
  if (typeof input.name !== 'string' || input.name.trim().length < 2 || input.name.length > 60) return bad('name (2-60 characters) is required');
  const scopes = Array.isArray(input.scopes) && input.scopes.length > 0 ? (input.scopes as unknown[]) : ['read:fleet', 'read:alerts', 'read:voyages', 'read:shipments'];
  if (!scopes.every((x): x is ApiScope => typeof x === 'string' && (ALL_SCOPES as string[]).includes(x))) return bad(`scopes must be from: ${ALL_SCOPES.join(', ')}`);
  if ((await s.repo.apiKeys.list(org.id)).filter((k) => !k.revokedAt).length >= 10) return bad('At most 10 active API keys per organisation');
  const secret = `orvms_${randomToken(24)}`;
  const key: ApiKey = { id: crypto.randomUUID(), orgId: org.id, name: input.name.trim(), prefix: secret.slice(0, 12), hash: await sha256Hex(secret), scopes: scopes as ApiScope[], createdBy: actor, createdAt: s.now() };
  await s.repo.apiKeys.insert(key);
  s.hub.log(actor, 'apikey.created', `${org.id} ${key.prefix}`);
  return { ok: true, value: { key, secret } };
}

/** Resolve a presented API key to its organisation, enforcing plan entitlement and the monthly call quota. */
export async function authenticateApiKey(s: Services, raw: string): Promise<Result<{ key: ApiKey; org: Organization }>> {
  if (!raw.startsWith('orvms_')) return bad('Invalid API key', 403);
  const key = await s.repo.apiKeys.findByHash(await sha256Hex(raw));
  if (!key) return bad('Invalid API key', 403);
  const org = await s.repo.orgs.get(key.orgId);
  if (!org || org.status !== 'active') return bad('Organisation is not active', 403);
  const plan = planOf(org);
  if (!plan.limits.apiKeysAndWebhooks) return bad('Your plan does not include API access', 402);
  const period = periodOf(s.now());
  const used = await s.repo.usage.get(org.id, period, 'api_calls');
  if (used >= plan.limits.apiCallsPerMonth) return bad(`Monthly API quota (${plan.limits.apiCallsPerMonth}) exhausted`, 402);
  await s.repo.usage.increment(org.id, period, 'api_calls');
  await s.repo.apiKeys.touch(key.id, s.now());
  return { ok: true, value: { key, org } };
}

// ── webhooks ─────────────────────────────────────────────────────────────────
export const WEBHOOK_EVENTS: WebhookEvent[] = ['alert.created', 'voyage.status_changed', 'voyage.deviation', 'case.created', 'case.escalated', 'case.closed', 'shipment.at_risk'];

export async function createWebhook(s: Services, org: Organization, actor: string, input: { url?: unknown; events?: unknown }): Promise<Result<Webhook>> {
  if (!planOf(org).limits.apiKeysAndWebhooks) return bad('Webhooks are not included in your plan. Upgrade to Professional or Enterprise.', 402);
  if (typeof input.url !== 'string') return bad('url is required');
  const check = isAllowedWebhookUrl(input.url, s.allowInsecureWebhooks);
  if (!check.ok) return bad(check.reason ?? 'URL not allowed');
  const events = Array.isArray(input.events) && input.events.length > 0 ? (input.events as unknown[]) : WEBHOOK_EVENTS;
  if (!events.every((e): e is WebhookEvent => typeof e === 'string' && (WEBHOOK_EVENTS as string[]).includes(e))) return bad(`events must be from: ${WEBHOOK_EVENTS.join(', ')}`);
  if ((await s.repo.webhooks.list(org.id)).length >= 10) return bad('At most 10 webhooks per organisation');
  const hook: Webhook = { id: crypto.randomUUID(), orgId: org.id, url: input.url, secret: `whsec_${randomToken(20)}`, events: events as WebhookEvent[], active: true, createdAt: s.now() };
  await s.repo.webhooks.insert(hook);
  s.hub.log(actor, 'webhook.created', `${org.id} ${hook.url}`);
  return { ok: true, value: hook };
}

// ── platform administration ──────────────────────────────────────────────────
export async function createOrganization(
  s: Services,
  actor: string,
  input: { name?: unknown; kind?: unknown; planId?: unknown; adminUsername?: unknown; adminPassword?: unknown },
): Promise<Result<Organization>> {
  if (typeof input.name !== 'string' || input.name.trim().length < 2 || input.name.length > 80) return bad('name is required');
  if (input.kind !== 'shipping_company' && input.kind !== 'coast_guard') return bad('kind must be shipping_company or coast_guard');
  const planId = typeof input.planId === 'string' ? input.planId : 'starter';
  if (!['starter', 'professional', 'enterprise'].includes(planId)) return bad('Unknown plan');
  const org: Organization = {
    id: `org-${randomToken(5)}`, name: input.name.trim(), kind: input.kind, planId: planId as Organization['planId'], status: 'active', createdAt: s.now(),
  };
  if (input.kind === 'shipping_company') {
    const u = await createOrgUserBootstrap(s, org, input);
    if (!u.ok) return u;
  }
  await s.repo.orgs.insert(org);
  s.hub.log(actor, 'org.created', `${org.id} ${org.name} (${org.planId})`);
  return { ok: true, value: org };
}

async function createOrgUserBootstrap(s: Services, org: Organization, input: { adminUsername?: unknown; adminPassword?: unknown }): Promise<Result<true>> {
  const username = typeof input.adminUsername === 'string' ? input.adminUsername.toLowerCase() : '';
  if (!USERNAME_RE.test(username)) return bad('adminUsername must be 3-32 characters: lowercase letters, digits, . _ -');
  if (typeof input.adminPassword !== 'string' || input.adminPassword.length < 10) return bad('adminPassword must be at least 10 characters');
  if (s.hub.users.has(username)) return bad('That username is taken', 409);
  await s.hub.addUser(username, input.adminPassword, 'org_admin', `${org.name} Administrator`, undefined, org.name, org.id);
  return { ok: true, value: true };
}

