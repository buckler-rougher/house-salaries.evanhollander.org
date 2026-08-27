// POST /api/optout — someone asks to be removed. Validates that the address
// they gave is a house.gov one belonging to the name they're claiming, then
// mails a signed verification link there.
//
// Sending the link is the whole verification. We never check the address
// exists, and nothing is recorded here — only clicking the link, which
// requires reading that mailbox, does anything. Nothing is stored between the
// two steps either: the request travels inside the signed token.
import { SMTP, SITE, HOUSE_DOMAIN, LINK_TTL_SECONDS, emailMatchesName, signToken, json } from '../_lib.js';
import { sendMail } from '../_smtp.js';

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

    const token = await signToken({
      n: name.trim().slice(0, 120),
      o: office.trim().slice(0, 160),
      e: email.trim().toLowerCase().slice(0, 254),
      x: Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS,
    }, env.HMAC);

    const link = `${SITE}/api/optout/confirm?t=${encodeURIComponent(token)}`;

    await sendMail({
      server: SMTP.server,
      port: SMTP.port,
      username: SMTP.username,
      token: env.smtp,
      to: email.trim(),
      fromLabel: 'House Staff Salaries',
      subject: 'Confirm removing your listing',
      body: [
        `Someone asked to remove this listing from ${SITE}:`,
        '',
        `    ${name.trim()}`,
        `    ${office.trim()}`,
        '',
        'If that was you, confirm with this link (good for 48 hours):',
        '',
        `    ${link}`,
        '',
        "If it wasn't you, ignore this message. Nothing has changed and no",
        'further email will be sent.',
        '',
        '--',
        'Note that House salary data is published by law in the quarterly',
        'Statement of Disbursements. Removing your listing here does not',
        'remove it from house.gov, which remains the official public record.',
      ].join('\r\n'),
    });

    return json({ success: true }, 200, h);
  } catch (e) {
    console.error('optout:', e?.message ?? e);
    return json({ success: false, error: 'Could not send the verification email.' }, 500, h);
  }
}
