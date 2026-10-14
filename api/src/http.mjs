import { pbkdf2, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
// ALLOWED_ORIGIN: one site address, or several separated by commas
// (e.g. https://yourhoa.org,https://www.yourhoa.org). The reply names whichever one asked.
const ORIGINS = (process.env.ALLOWED_ORIGIN || '*').split(',').map(o => o.trim().replace(/\/$/, '')).filter(Boolean);
let requestOrigin = '';
export function setRequestOrigin(event) {
  requestOrigin = event.headers?.origin || event.headers?.Origin || '';
}
function allowOrigin() {
  if (ORIGINS.includes('*')) return '*';
  return ORIGINS.includes(requestOrigin) ? requestOrigin : ORIGINS[0];
}

export function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': allowOrigin(),
      'Vary': 'Origin',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    },
    body: body === undefined ? '' : JSON.stringify(body),
  };
}

// `code` is an optional machine-readable reason the page can act on (e.g. password_change_required).
export class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

export function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body;
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'Request body must be valid JSON.'); }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export function validEmail(e) { return typeof e === 'string' && e.length <= 254 && EMAIL_RE.test(e.trim()); }


