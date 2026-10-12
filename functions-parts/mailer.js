// Sends mail through an account's SMTP login: the same as createMailer and isPermanent in
// functions-alerts/request-alert.js, copied because a function deploys only its own folder.
import nodemailer from 'nodemailer';

export function createMailer({ host = 'smtp.gmail.com', port = 465, user, pass }) {
  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: pass ? { user, pass } : undefined,
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 60000,
  });
  return ({ fromName, ...message }) => transport.sendMail({ ...message, from: { name: fromName, address: user } });
}

// Errors another try won't fix: the login was refused, or an address was rejected.
export const isPermanent = (e) => e?.code === 'EAUTH' || e?.code === 'EENVELOPE' || (e?.responseCode >= 500 && e?.responseCode < 600);
