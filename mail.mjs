import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

const ses = new SESv2Client({});
const FROM = process.env.SES_FROM;          // e.g. "Maple Ridge HOA <board@mapleridgehoa.org>"
const SITE = process.env.SITE_URL;          // e.g. "https://mapleridgehoa.org"
const API  = process.env.API_URL;           // e.g. "https://abc123.execute-api.us-east-1.amazonaws.com"

export async function sendMail({ to, subject, text, html, unsubscribeToken }) {
  const headers = [];
  if (unsubscribeToken) {
    // One-click unsubscribe support for Gmail / Yahoo bulk-sender rules (RFC 8058)
    headers.push({ Name: 'List-Unsubscribe', Value: `<${API}/unsubscribe/one-click?token=${unsubscribeToken}>` });
    headers.push({ Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' });
  }
  await ses.send(new SendEmailCommand({
    FromEmailAddress: FROM,
    Destination: { ToAddresses: [to] },
    Content: { Simple: {
      Subject: { Data: subject },
      Body: { Text: { Data: text }, ...(html ? { Html: { Data: html } } : {}) },
      Headers: headers,
    } },
  }));
}

export function confirmEmail(token) {
  const link = `${SITE}/subscribe.html?confirm=${token}`;
  return {
    subject: 'Confirm your HOA email subscription',
    text: `Confirm that you want HOA announcements by email:\n\n${link}\n\nIf you didn't ask for this, ignore this message and you won't be added.`,
  };
}

export function unsubscribeLinkEmail(token) {
  const link = `${SITE}/unsubscribe.html?token=${token}`;
  return {
    subject: 'Your HOA unsubscribe link',
    text: `Use this link to stop receiving HOA emails:\n\n${link}\n\nIf you didn't ask for this, ignore this message and nothing will change.`,
  };
}

export function announcementEmail(a, token) {
  const unsub = `${SITE}/unsubscribe.html?token=${token}`;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return {
    subject: a.title,
    text: `${a.title}\n\n${a.body}\n\nRead on the website: ${SITE}/announcements.html#a-${a.id}\n\nUnsubscribe: ${unsub}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px">
      <h2>${esc(a.title)}</h2>
      <p style="white-space:pre-line">${esc(a.body)}</p>
      <p><a href="${SITE}/announcements.html#a-${a.id}">Read on the website</a></p>
      <hr><p style="font-size:12px;color:#666">You're getting this because you subscribed to HOA announcements.
      <a href="${unsub}">Unsubscribe</a></p></div>`,
  };
}
