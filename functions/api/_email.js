// The verification email.
//
// Constraints that shape all of this: table layout and inline styles, because
// Outlook's renderer ignores most modern CSS and several clients strip <style>
// blocks entirely; no external images, both because clients block them by
// default and because a remote image in a privacy email would be a tracking
// pixel; and hand-wrapped short lines, because SMTP caps a line at 1000 bytes
// and _smtp.js sends 8bit with no quoted-printable encoding.
//
// The plain-text part is a real fallback, not a formality — it has to stand on
// its own for anyone whose client won't render HTML.

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const INK = '#1a1a1a';
const INK2 = '#4a4a4a';
const INK3 = '#8a8a8a';
const ACCENT = '#1b6f2c';
const PAPER = '#faf9f7';
const LINE = '#e8e5e0';

export function verificationText({ name, office, link, origin }) {
  return [
    `Someone asked to remove this listing from ${origin}:`,
    '',
    `    ${name}`,
    `    ${office}`,
    '',
    'If that was you, confirm with this link (good for 48 hours):',
    '',
    `    ${link}`,
    '',
    "If it wasn't you, ignore this message. Nothing has changed and no",
    'further email will be sent.',
    '',
    '--',
    'House staff salaries are published by law in the quarterly Statement',
    'of Disbursements. Removing your listing takes you off this site only',
    '— it does not remove you from house.gov, which stays the official',
    'public record, and it does not change the site overall statistics.',
  ].join('\r\n');
}

export function removedText({ name, office, origin }) {
  return [
    'Your removal request has been recorded. This listing:',
    '',
    `    ${name}`,
    `    ${office}`,
    '',
    `will be gone from ${origin} within about ten minutes, once the`,
    "site's data rebuilds.",
    '',
    'No further action is needed, and no more email will be sent about',
    'this.',
    '',
    '--',
    'House staff salaries are published by law in the quarterly Statement',
    'of Disbursements. This removes you from that site only — it does not',
    'remove you from house.gov, which stays the official public record.',
  ].join('\r\n');
}

export function removedHtml({ name, office, origin }) {
  const host = origin.replace(/^https?:\/\//, '');
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>Your listing has been removed</title>',
    '</head>',
    `<body style="margin:0;padding:0;background:${PAPER};">`,
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">',
    'Recorded. Your listing comes down within about ten minutes.',
    '</div>',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"`,
    ` border="0" style="background:${PAPER};padding:32px 12px;">`,
    '<tr><td align="center">',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"`,
    ` border="0" style="max-width:520px;background:#ffffff;border:1px solid ${LINE};`,
    ' border-radius:10px;font-family:-apple-system,BlinkMacSystemFont,',
    'Segoe UI,Helvetica,Arial,sans-serif;">',

    `<tr><td style="padding:24px 28px 0;font-size:12px;letter-spacing:.1em;`,
    ` text-transform:uppercase;font-weight:700;color:${INK3};">`,
    'House Staff Salaries</td></tr>',

    `<tr><td style="padding:14px 28px 0;font-size:17px;line-height:1.5;`,
    ` color:${INK};font-weight:700;">Your removal request is recorded</td></tr>`,

    '<tr><td style="padding:16px 28px 0;">',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"`,
    ` style="background:${PAPER};border:1px solid ${LINE};border-radius:8px;">`,
    `<tr><td style="padding:14px 16px;font-size:15px;line-height:1.5;color:${INK};`,
    ' font-weight:700;">',
    esc(name),
    `<div style="font-size:13px;font-weight:400;color:${INK3};padding-top:2px;">`,
    esc(office),
    '</div></td></tr></table></td></tr>',

    `<tr><td style="padding:16px 28px 0;font-size:14px;line-height:1.6;color:${INK2};">`,
    `This listing will be gone from ${esc(host)} within about ten minutes,`,
    " once the site's data rebuilds. No further action is needed, and no more",
    ' email will be sent about this.</td></tr>',

    `<tr><td style="padding:18px 28px 24px;">`,
    `<div style="border-top:1px solid ${LINE};padding-top:14px;font-size:12px;`,
    ` line-height:1.6;color:${INK3};">`,
    'House staff salaries are published by law in the quarterly Statement of',
    ' Disbursements. This removes you from that site only — it does not remove',
    ' you from house.gov, which stays the official public record.',
    '</div></td></tr>',

    '</table></td></tr></table></body></html>',
  ].join('\r\n');
}

export function verificationHtml({ name, office, link, origin }) {
  const host = origin.replace(/^https?:\/\//, '');
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>Confirm removing your listing</title>',
    '</head>',
    `<body style="margin:0;padding:0;background:${PAPER};">`,
    // Preheader: the grey preview line mail clients show next to the subject.
    // Hidden in the body itself, otherwise the client grabs the first visible
    // words, which would be the wordmark.
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">',
    'Confirm you want your listing removed. The link expires in 48 hours.',
    '</div>',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"`,
    ` border="0" style="background:${PAPER};padding:32px 12px;">`,
    '<tr><td align="center">',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"`,
    ` border="0" style="max-width:520px;background:#ffffff;border:1px solid ${LINE};`,
    ' border-radius:10px;font-family:-apple-system,BlinkMacSystemFont,',
    'Segoe UI,Helvetica,Arial,sans-serif;">',

    // Wordmark
    `<tr><td style="padding:24px 28px 0;font-size:12px;letter-spacing:.1em;`,
    ` text-transform:uppercase;font-weight:700;color:${INK3};">`,
    'House Staff Salaries</td></tr>',

    `<tr><td style="padding:14px 28px 0;font-size:17px;line-height:1.5;`,
    ` color:${INK};font-weight:700;">Confirm removing your listing</td></tr>`,

    `<tr><td style="padding:12px 28px 0;font-size:14px;line-height:1.6;color:${INK2};">`,
    `Someone asked to remove this listing from ${esc(host)}:</td></tr>`,

    // The listing being removed
    '<tr><td style="padding:16px 28px 0;">',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"`,
    ` style="background:${PAPER};border:1px solid ${LINE};border-radius:8px;">`,
    `<tr><td style="padding:14px 16px;font-size:15px;line-height:1.5;color:${INK};`,
    ' font-weight:700;">',
    esc(name),
    `<div style="font-size:13px;font-weight:400;color:${INK3};padding-top:2px;">`,
    esc(office),
    '</div></td></tr></table></td></tr>',

    // Button. Bulletproof-ish: padded anchor, explicit colours, no background
    // image — Outlook renders this as a plain block rather than dropping it.
    '<tr><td style="padding:22px 28px 0;">',
    `<a href="${esc(link)}" style="display:inline-block;background:${ACCENT};`,
    ' color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;',
    ' padding:11px 20px;border-radius:6px;">Confirm removal</a></td></tr>',

    `<tr><td style="padding:14px 28px 0;font-size:12px;line-height:1.6;color:${INK3};">`,
    'This link expires in 48 hours. If the button does not work, paste this',
    ' into your browser:',
    // word-break so a long signed token doesn't blow out the layout
    `<div style="padding-top:6px;word-break:break-all;color:${INK3};">`,
    esc(link),
    '</div></td></tr>',

    `<tr><td style="padding:18px 28px 0;font-size:13px;line-height:1.6;color:${INK2};">`,
    "If it wasn't you, ignore this message. Nothing has changed and no further",
    ' email will be sent.</td></tr>',

    // The honest footnote about what this does and doesn't do.
    `<tr><td style="padding:18px 28px 24px;">`,
    `<div style="border-top:1px solid ${LINE};padding-top:14px;font-size:12px;`,
    ` line-height:1.6;color:${INK3};">`,
    'House staff salaries are published by law in the quarterly Statement of',
    ' Disbursements. Removing your listing takes you off this site only — it',
    ' does not remove you from house.gov, which stays the official public',
    " record, and it does not change the site's overall statistics.",
    '</div></td></tr>',

    '</table></td></tr></table></body></html>',
  ].join('\r\n');
}
