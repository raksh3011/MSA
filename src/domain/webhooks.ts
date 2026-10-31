/** Outbound integration: signed webhooks with URL safety checks and recorded delivery attempts. */
import type { Repo } from '../data/repo';
import type { Delivery, Webhook, WebhookEvent } from './types';

const enc = new TextEncoder();

const hex = (b: ArrayBuffer): string => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

/** HMAC-SHA256 signature over `${timestamp}.${body}` so receivers can verify origin and reject replays. */
export async function signPayload(secret: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${body}`)));
}

export function randomToken(bytes = 24): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Basic SSRF guard: https only, no credentials, and no localhost / private / link-local / internal hostnames.
 * (Hostnames that resolve to private IPs cannot be fully excluded without DNS checks — documented limitation.)
 */
export function isAllowedWebhookUrl(raw: string, allowInsecure = false): { ok: boolean; reason?: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'Not a valid URL' };
  }
  if (allowInsecure) return u.protocol === 'http:' || u.protocol === 'https:' ? { ok: true } : { ok: false, reason: 'Only http(s) URLs' };
  if (u.protocol !== 'https:') return { ok: false, reason: 'Webhook URLs must use https' };
  if (u.username || u.password) return { ok: false, reason: 'URLs with credentials are not allowed' };
  const host = u.hostname.toLowerCase();
  const blockedName = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host === '::1' || host.startsWith('[');
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  const privateIp = m ? isPrivateIpv4(Number(m[1]), Number(m[2])) : false;
  if (blockedName || privateIp) return { ok: false, reason: 'Private, loopback or internal addresses are not allowed' };
  return { ok: true };
}

function isPrivateIpv4(a: number, b: number): boolean {
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export interface Envelope {
  id: string;
  event: WebhookEvent;
  orgId: string;
  createdAt: string;
  data: unknown;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; ok: boolean }>;

/** Send one event to all of an organisation's active, subscribed webhooks; every attempt is recorded. */
export async function dispatchEvent(
  repo: Repo,
  orgId: string,
  event: WebhookEvent,
  data: unknown,
  deps: { fetch: FetchLike; now: number },
): Promise<Delivery[]> {
  const hooks = (await repo.webhooks.list(orgId)).filter((w) => w.active && w.events.includes(event));
  const out: Delivery[] = [];
  for (const hook of hooks) out.push(await deliver(repo, hook, event, data, deps));
  return out;
}

async function deliver(repo: Repo, hook: Webhook, event: WebhookEvent, data: unknown, deps: { fetch: FetchLike; now: number }): Promise<Delivery> {
  const envelope: Envelope = { id: crypto.randomUUID(), event, orgId: hook.orgId, createdAt: new Date(deps.now).toISOString(), data };
  const body = JSON.stringify(envelope);
  const delivery: Delivery = { id: envelope.id, orgId: hook.orgId, webhookId: hook.id, event, payload: body, status: 'pending', attempts: 0, createdAt: deps.now };
  await repo.deliveries.insert(delivery);
  const ts = Math.floor(deps.now / 1000);
  const signature = await signPayload(hook.secret, ts, body);
  for (let attempt = 1; attempt <= 3 && delivery.status !== 'delivered'; attempt++) {
    delivery.attempts = attempt;
    try {
      const res = await deps.fetch(hook.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-ORVMS-Event': event, 'X-ORVMS-Delivery': envelope.id, 'X-ORVMS-Timestamp': String(ts), 'X-ORVMS-Signature': `sha256=${signature}` },
        body,
      });
      delivery.responseStatus = res.status;
      if (res.ok) {
        delivery.status = 'delivered';
        delivery.deliveredAt = deps.now;
        delivery.error = undefined;
      } else {
        delivery.error = `HTTP ${res.status}`;
      }
    } catch (e) {
      delivery.error = e instanceof Error ? e.message.slice(0, 200) : 'network error';
    }
  }
  if (delivery.status !== 'delivered') delivery.status = 'failed';
  await repo.deliveries.update(delivery);
  return delivery;
}
