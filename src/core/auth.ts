/** Password hashing (PBKDF2) and HS256 JWTs using WebCrypto — runs in Workers, browsers and Node. */
import type { Role } from './types';

const PBKDF2_ITERATIONS = 100_000; // Cloudflare Workers' maximum
const enc = new TextEncoder();

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64url = (bytes: Uint8Array): string => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string): Uint8Array<ArrayBuffer> => unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

export async function verifyPassword(password: string, record: string): Promise<boolean> {
  const [iter, salt, hash] = record.split('$');
  if (!iter || !salt || !hash) return false;
  const iterations = Number(iter);
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 1_000_000) return false;
  const derived = await pbkdf2(password, unb64(salt), iterations);
  return constantTimeEqual(derived, unb64(hash));
}

export interface TokenClaims {
  sub: string;
  role: Role;
  exp: number; // epoch seconds
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signToken(claims: Omit<TokenClaims, 'exp'>, secret: string, ttlSec = 8 * 3600, nowMs = Date.now()): Promise<string> {
  const header = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(enc.encode(JSON.stringify({ ...claims, exp: Math.floor(nowMs / 1000) + ttlSec })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(new Uint8Array(sig))}`;
}

export async function verifyToken(token: string, secret: string, nowMs = Date.now()): Promise<TokenClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts as [string, string, string];
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64url(sig), enc.encode(`${header}.${body}`));
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(unb64url(body))) as TokenClaims;
    if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number') return null;
    if (claims.exp * 1000 < nowMs) return null;
    if (!['admin', 'analyst', 'operator', 'risk_officer', 'org_admin'].includes(claims.role)) return null;
    return claims;
  } catch {
    return null;
  }
}
