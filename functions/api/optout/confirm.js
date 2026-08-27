// GET /api/optout/confirm?t=… — the link from the verification email.
//
// Reaching here proves control of the mailbox, which is the only
// authorization the automated lane has. So this is where the opt-out is
// actually recorded: it appends the person's digest to data/suppressed.json
// via the GitHub contents API.
//
// That commit is not itself the removal. data/*.json are committed build
// artifacts, so the person stays in the published files until fetch_sod.py
// re-runs and filters them out — which is why update-data.yml also triggers
// on pushes to data/suppressed.json. The chain is:
//     confirm -> commit -> workflow -> regenerated data -> deploy
import { verifyToken, suppressionDigest, json } from '../_lib.js';

const REPO = 'buckler-rougher/house-salaries.evanhollander.org';
const FILE = 'data/suppressed.json';
const BRANCH = 'main';

const page = (title, body, status = 200) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
       max-width:34rem;margin:12vh auto;padding:0 1.5rem;color:#1a1a1a;background:#faf9f7}
  h1{font-size:1.4rem;margin:0 0 1rem}
  p{margin:0 0 1rem;color:#444}
  a{color:#1a6b3c}
  @media(prefers-color-scheme:dark){body{background:#1a1a1a;color:#eee}p{color:#bbb}a{color:#6fce9a}}
</style>
<h1>${title}</h1>${body}`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );

async function gh(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'house-salaries-optout',
      ...(init.headers || {}),
    },
  });
}

export async function onRequestGet({ env, request }) {
  const token = new URL(request.url).searchParams.get('t');
  const payload = await verifyToken(token, env.HMAC);
  if (!payload) {
    return page(
      'This link has expired',
      `<p>Verification links are good for 48 hours. Start again from your listing
       and a fresh one will be sent.</p>
       <p><a href="/">Back to House Staff Salaries</a></p>`,
      400
    );
  }

  try {
    const digest = await suppressionDigest(payload.n, payload.o, env.HMAC);

    // Read-modify-write against the file's current sha. Two confirmations
    // landing together would otherwise silently clobber one another — the
    // loser's opt-out would vanish with no error anyone sees.
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await gh(env, `contents/${FILE}?ref=${BRANCH}`);
      if (!res.ok) throw new Error(`read ${res.status}`);
      const meta = await res.json();
      const doc = JSON.parse(atob(meta.content.replace(/\n/g, '')));

      const already = (doc.entries || []).some((e) => (e.hashes || []).includes(digest));
      if (already) return page('Already removed', donePara(), 200);

      doc.entries = [...(doc.entries || []), {
        id: digest.slice(0, 12),
        hashes: [digest],
        added: new Date().toISOString().slice(0, 10),
        via: 'auto',
      }];

      const body = new TextEncoder().encode(JSON.stringify(doc, Object.keys(doc).sort(), 2) + '\n');
      const put = await gh(env, `contents/${FILE}`, {
        method: 'PUT',
        body: JSON.stringify({
          // No name in the commit message — it would undo the whole point of
          // storing digests rather than names in a public repo.
          message: `Honor opt-out request ${digest.slice(0, 12)}`,
          content: btoa(String.fromCharCode(...body)),
          sha: meta.sha,
          branch: BRANCH,
        }),
      });
      if (put.ok) return page('Removed', donePara(), 200);
      if (put.status !== 409) throw new Error(`write ${put.status}`);
      // 409 = someone else committed first; re-read and retry.
    }
    throw new Error('write conflict');
  } catch (e) {
    console.error('optout/confirm:', e?.message ?? e);
    return page(
      'Something went wrong',
      `<p>Your request was verified but could not be recorded. Please use the
       contact form and it will be handled by hand.</p>
       <p><a href="/">Back to House Staff Salaries</a></p>`,
      500
    );
  }
}

const donePara = () => `
  <p>Your listing will disappear from House Staff Salaries within about ten
     minutes, once the site's data is rebuilt.</p>
  <p>To be straightforward about the limits of this: House salary data is
     published by law in the quarterly Statement of Disbursements. This
     removes you from this site only — it does not remove you from house.gov,
     which remains the official public record, and it does not change the
     site's overall statistics, which are calculated before removals.</p>
  <p><a href="/">Back to House Staff Salaries</a></p>`;
