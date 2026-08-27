// SMTP-over-TCP client for Cloudflare Pages Functions.
//
// Lifted from buckler-rougher/contact's functions/api/submit.js rather than
// written fresh: that one has been sending through this same Proton account
// in production, so its STARTTLS handshake and multi-line response parsing
// are known-good. Divergence here would mean debugging a second SMTP
// implementation against a mail server we can't test locally.
//
// The one meaningful difference is the recipient. The contact form always
// sends to a fixed TO_EMAIL; this sends to whichever @mail.house.gov address
// the requester gave, which is why callers must validate that address before
// getting here — see emailMatchesName() and the rate limit in optout.
import { connect } from 'cloudflare:sockets';

function mimeWord(s) {
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  const bytes = new TextEncoder().encode(s);
  return `=?UTF-8?B?${btoa(String.fromCharCode(...bytes))}?=`;
}

export async function sendMail({ server, port, username, token, to, subject, body, fromLabel }) {
  const directTLS = port === 465;
  let socket = connect({ hostname: server, port }, { secureTransport: directTLS ? 'on' : 'starttls' });

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let writer = socket.writable.getWriter();
  let reader = socket.readable.getReader();
  let buf = '';

  const readLine = async () => {
    while (true) {
      const i = buf.indexOf('\r\n');
      if (i !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        return line;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('SMTP: connection closed');
      buf += dec.decode(value, { stream: true });
    }
  };

  // Multi-line responses use "NNN-text" for continuation; final line "NNN text".
  const readResp = async () => {
    let code = 0;
    while (true) {
      const line = await readLine();
      code = parseInt(line, 10);
      if (line.length < 4 || line[3] === ' ') break;
    }
    if (code >= 400) throw new Error(`SMTP error ${code}`);
    return code;
  };

  const send = (s) => writer.write(enc.encode(s + '\r\n'));

  try {
    await readResp(); // 220 greeting
    await send('EHLO house-salaries.evanhollander.org');
    await readResp();

    if (!directTLS) {
      await send('STARTTLS');
      await readResp(); // 220 go ahead
      reader.releaseLock();
      writer.releaseLock();
      socket = socket.startTls();
      writer = socket.writable.getWriter();
      reader = socket.readable.getReader();
      buf = '';
      await send('EHLO house-salaries.evanhollander.org');
      await readResp();
    }

    await send('AUTH LOGIN');
    await readResp(); // 334
    await send(btoa(username));
    await readResp(); // 334
    await send(btoa(token));
    await readResp(); // 235

    await send(`MAIL FROM:<${username}>`);
    await readResp();
    await send(`RCPT TO:<${to}>`);
    await readResp();
    await send('DATA');
    await readResp(); // 354

    // Dot-stuffing: a line starting with "." would otherwise end the message.
    const safeBody = body.split('\r\n').map((l) => (l.startsWith('.') ? '.' + l : l)).join('\r\n');

    const msg = [
      `From: "${fromLabel}" <${username}>`,
      `To: <${to}>`,
      `Subject: ${mimeWord(subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      safeBody,
    ].join('\r\n');

    await writer.write(enc.encode(msg + '\r\n.\r\n'));
    await readResp(); // 250
    await send('QUIT');
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
    try { await writer.close(); } catch { /* ignore */ }
  }
}
