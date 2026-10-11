// A fake mail server for local testing: it takes every email and keeps it instead of delivering it.
// In the emulator (functions/.env.demo-stellar-glass points the alerts at 127.0.0.1:2525), run
//   node functions/test/smtp-sink.js [port] [folder]
// and each alert is saved as a .eml file (default folder: functions/test/mail/), which any mail app can open.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Starts the server. onMessage gets { from, to, raw } for each email. Options:
//   auth: 'accept' or 'reject' makes it ask for a login and take or refuse it; rejectRcpt refuses every address.
export function startSmtpSink({ port = 2525, onMessage = () => {}, auth, rejectRcpt = false } = {}) {
  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let mail = { to: [] };
    const reply = (line) => socket.write(`${line}\r\n`);
    reply('220 localhost fake mail server');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          const raw = buffer.slice(0, end).replace(/\r\n\.\./g, '\r\n.');
          buffer = buffer.slice(end + 5);
          inData = false;
          onMessage({ ...mail, raw: Buffer.from(raw, 'latin1') });
          mail = { to: [] };
          reply('250 2.0.0 Kept');
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO') reply(`250-localhost\r\n250-SIZE 52428800\r\n250-8BITMIME\r\n${auth ? '250-AUTH PLAIN\r\n' : ''}250 SMTPUTF8`);
        else if (cmd === 'HELO') reply('250 localhost');
        else if (cmd === 'AUTH') reply(auth === 'accept' ? '235 2.7.0 Accepted' : '535 5.7.8 Username and Password not accepted');
        else if (cmd === 'MAIL') { mail.from = line.match(/<(.*?)>/)?.[1]; reply('250 2.1.0 OK'); }
        else if (cmd === 'RCPT') {
          if (rejectRcpt) reply('550 5.1.1 No such user');
          else { mail.to.push(line.match(/<(.*?)>/)?.[1]); reply('250 2.1.5 OK'); }
        } else if (cmd === 'DATA') { inData = true; reply('354 Go ahead'); }
        else if (cmd === 'QUIT') { reply('221 Bye'); socket.end(); return; }
        else reply('250 OK'); // RSET, NOOP
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => { server.listen(port, '127.0.0.1', () => resolve(server)); });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2]) || 2525;
  const dir = process.argv[3] || path.join(path.dirname(fileURLToPath(import.meta.url)), 'mail');
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  await startSmtpSink({
    port,
    onMessage: ({ to, raw }) => {
      const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${++n}.eml`);
      fs.writeFileSync(file, raw);
      console.log(`Email to ${to.join(', ')} saved: ${file}`);
    },
  });
  console.log(`Fake mail server on 127.0.0.1:${port}, saving emails to ${dir}`);
}
