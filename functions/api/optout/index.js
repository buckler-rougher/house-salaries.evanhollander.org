// POST /api/optout — someone asks to be removed. Validates that the address
// they gave is a house.gov one belonging to the name they're claiming, then
// mails a signed verification link there.
//
// Sending the link is the whole verification. We never check the address
// exists, and nothing is recorded here — only clicking the link, which
// requires reading that mailbox, does anything. Nothing is stored between the
// two steps either: the request travels inside the signed token.
import { SMTP, HOUSE_DOMAIN, LINK_TTL_SECONDS, emailMatchesName, signToken, json, claimSource, claimRecipient } from '../_lib.js';
import { sendMail } from '../_smtp.js';
import { verificationText, verificationHtml } from '../_email.js';

const ALLOWED_ORIGINS = ['https://house-salaries.evanhollander.org'];

function cors(request) {
  const origin = request.headers.get('Origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: cors(request) });
}

export async function onRequestPost({ env, request }) {
  const h = cors(request);
  try {
    const { name = '', office = '', email = '', website = '' } = await request.json();

    // Honeypot, same trick the contact form uses.
    if (website) return json({ success: true }, 200, h);

    if (!name.trim() || !office.trim() || !email.trim()) {
      return json({ success: false, error: 'Missing required fields.' }, 400, h);
    }

    if (!emailMatchesName(email, name)) {
      // Deliberately specific rather than vague. Whether someone is listed is
      // already public — this whole site is a directory — so there's nothing
      // to protect by being coy, and a person who genuinely can't be matched
      // needs to know to use the manual route instead of retyping forever.
      return json({
        success: false,
        error: `That doesn't look like a @${HOUSE_DOMAIN} address for this name.`,
        manual: true,
      }, 400, h);
    }

    // Limits are claimed only after the name/address gate passes, so a
    // scripted sweep of bad guesses can't burn a legitimate person's daily
    // allowance before they get to use it.
    // Origin of whatever host is serving — production or a preview deploy —
    // so verification links and cache keys both point back at the same build
    // that issued them.
    const origin = new URL(request.url).origin;
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    if (!(await claimSource(origin, ip, env.HMAC))) {
      return json({ success: false, error: 'Too many requests from here. Try again later.', manual: true }, 429, h);
    }
    if (!(await claimRecipient(origin, email, env.HMAC))) {
      // Same wording as success, deliberately. Saying "already sent today"
      // would confirm to a third party that this address had been used —
      // and the person who genuinely just requested one has a link already,
      // so the advice is identical either way.
      return json({ success: true }, 200, h);
    }

    const token = await signToken({
      n: name.trim().slice(0, 120),
      o: office.trim().slice(0, 160),
      e: email.trim().toLowerCase().slice(0, 254),
      x: Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS,
    }, env.HMAC);

    const link = `${origin}/api/optout/confirm?t=${encodeURIComponent(token)}`;
    const mail = { name: name.trim(), office: office.trim(), link, origin };

    await sendMail({
      server: SMTP.server,
      port: SMTP.port,
      username: SMTP.username,
      token: env.smtp,
      to: email.trim(),
      fromLabel: 'House Staff Salaries',
      subject: 'Confirm removing your listing',
      body: verificationText(mail),
      html: verificationHtml(mail),
    });

    return json({ success: true }, 200, h);
  } catch (e) {
    console.error('optout:', e?.message ?? e);
    return json({ success: false, error: 'Could not send the verification email.' }, 500, h);
  }
}
