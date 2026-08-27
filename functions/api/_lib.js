// Shared helpers for the opt-out endpoints. Underscore-prefixed, so Pages
// doesn't route it.

// SMTP settings are not secrets, so they're here rather than in the Pages
// environment — only the token is configured there (as `smtp`). Port 587 with
// STARTTLS, matching what contact.evanhollander.org already runs in
// production against this same Proton account.
export const SMTP = {
  server: 'smtp.protonmail.ch',
  port: 587,
  username: 'support@evanhollander.org',
};

export const SITE = 'https://house-salaries.evanhollander.org';
export const HOUSE_DOMAIN = 'mail.house.gov';

// How long a verification link stays good. Long enough to survive a staffer
// not checking mail until tomorrow, short enough that a link sitting in an
// archived mailbox isn't indefinitely replayable.
export const LINK_TTL_SECONDS = 48 * 60 * 60;

const enc = new TextEncoder();

/** Must stay byte-identical to normalize_name() in scripts/suppression.py —
 *  the digest this feeds is compared against ones the Python build computes.
 *  Sorting the tokens absorbs the SOD's unpredictable surname ordering;
 *  middle initials and generational suffixes are deliberately KEPT, because
 *  dropping them merges genuinely distinct people (see that file). */
export function normalizeName(name) {
  return name
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^a-z ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

export function personKey(name, officeKey) {
  return `${normalizeName(name)}|${officeKey.trim().toUpperCase()}`;
}

async function hmacRaw(keyBytes, message) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** The suppression digest, matching suppression.digest() in Python. */
export async function suppressionDigest(name, officeKey, pepper) {
  return hex(await hmacRaw(enc.encode(pepper), personKey(name, officeKey)));
}

/** Verification links are signed with a key DERIVED from the pepper rather
 *  than the pepper itself. One secret to configure, but the two uses stay
 *  cryptographically separate: HMAC is one-way, so a leaked link key doesn't
 *  expose the pepper, and the suppression list stays opaque even if link
 *  signing is compromised. Their blast radii are very different — forging a
 *  link lets someone delist one person; recovering the pepper turns
 *  suppressed.json into a public list of everyone who asked for privacy. */
async function linkKey(pepper) {
  return await hmacRaw(enc.encode(pepper), 'optout-link-v1');
}

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = (s) => {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

/** Stateless signed token: the whole request travels in the link, so nothing
 *  needs storing between the request and the click. */
export async function signToken(payload, pepper) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = b64url(await hmacRaw(await linkKey(pepper), body));
  return `${body}.${sig}`;
}

export async function verifyToken(token, pepper) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;

  const expected = await hmacRaw(await linkKey(pepper), body);
  const got = b64urlDecode(sig);
  // Constant-time compare — a fast-exit comparison leaks how much of a forged
  // signature was right, which is enough to reconstruct one byte at a time.
  if (got.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ expected[i];
  if (diff !== 0) return null;

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
  } catch {
    return null;
  }
  if (!payload?.x || Math.floor(Date.now() / 1000) > payload.x) return null;
  return payload;
}

/** Does `email`'s local part plausibly belong to the person named `name`?
 *
 *  House addresses are first.last@mail.house.gov, but SOD names carry middle
 *  initials and reordered surnames the address won't have. So rather than
 *  constructing the expected address and comparing, this checks that every
 *  word in the local part is one of the person's name words, and that at
 *  least two match — enough to rule out an unrelated staffer while tolerating
 *  a dropped middle initial or a swapped name order.
 *
 *  It intentionally does NOT prove the address exists. That's what sending
 *  the link to it establishes. */
export function emailMatchesName(email, name) {
  const [local, domain] = String(email).toLowerCase().split('@');
  if (domain !== HOUSE_DOMAIN || !local) return false;
  const nameWords = new Set(normalizeName(name).split(' '));
  const localWords = local.replace(/[^a-z]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
  if (localWords.length < 2) return false;
  return localWords.every((w) => nameWords.has(w));
}

// Rate limiting, built on the Workers Cache API.
//
// The name/address gate proves an address belongs to the person being
// claimed; it does nothing about volume. Every name on the site is public, so
// a script can derive first.last@mail.house.gov for all ~8,600 staff and
// submit every one — each passes the gate, because each really is that
// person's address. That's thousands of unrequested emails from one Proton
// account, which is both a spam incident and a good way to lose the account.
//
// Cache API rather than KV because it needs no namespace, binding or extra
// configuration. The tradeoff is that it's per-datacenter rather than global,
// so a distributed attacker could get one allowance per colo. That's fine
// against the realistic threat — one person with a script hits one colo — and
// it beats shipping with nothing while waiting on setup. Move to KV if this
// ever gets abused for real.
//
// Keys are digests, not addresses: cache keys shouldn't hold the mail
// addresses of people asking for privacy.
const RL_PREFIX = `${SITE}/__ratelimit/`;

async function rlKey(kind, value, pepper) {
  const d = hex(await hmacRaw(enc.encode(pepper), `rl:${kind}:${value}`));
  return new Request(`${RL_PREFIX}${kind}-${d}`);
}

/** One verification email per address per day. The important limit: it caps
 *  what any single staffer can be made to receive, no matter who asks. */
export async function claimRecipient(email, pepper, ttl = 86400) {
  const cache = caches.default;
  const req = await rlKey('to', email.toLowerCase(), pepper);
  if (await cache.match(req)) return false;
  await cache.put(req, new Response('1', { headers: { 'Cache-Control': `max-age=${ttl}` } }));
  return true;
}

/** A handful of requests per source per hour, so one client can't walk the
 *  roster even though each individual address is only hit once. */
export async function claimSource(ip, pepper, limit = 5, ttl = 3600) {
  const cache = caches.default;
  const req = await rlKey('ip', ip, pepper);
  const hit = await cache.match(req);
  const n = hit ? parseInt(await hit.text(), 10) || 0 : 0;
  if (n >= limit) return false;
  await cache.put(req, new Response(String(n + 1), { headers: { 'Cache-Control': `max-age=${ttl}` } }));
  return true;
}

export const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra },
  });
