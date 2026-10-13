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

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body;
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'Request body must be valid JSON.'); }
}

// ---------- Basic auth for board members ----------
// ADMIN_USERS env var: comma-separated entries made with tools/make-password.html
//   username:iterations:salt:hash   (PBKDF2-SHA256, hex). Plain passwords are never stored.
function loadAdmins() {
  const map = new Map();
  for (const entry of (process.env.ADMIN_USERS || '').split(',')) {
    const [user, iterations, salt, hash] = entry.trim().split(':');
    if (user && iterations && salt && hash) {
      map.set(user.toLowerCase(), { iterations: Number(iterations), salt, hash });
    }
  }
  return map;
}
const ADMINS = loadAdmins();

// Usernames of everyone who can sign in to the board tools (never the hashes).
export function boardMembers() { return [...ADMINS.keys()].sort(); }
const DUMMY = { iterations: 600000, salt: '00'.repeat(16), hash: '00'.repeat(32) };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pbkdf2Async = promisify(pbkdf2);

export async function requireAdmin(event) {
  const header = event.headers?.authorization || event.headers?.Authorization || '';
  const match = header.match(/^Basic\s+(\S+)$/i);
  if (!match) throw new HttpError(401, 'Sign in to continue.');

  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  const user = i > 0 ? decoded.slice(0, i).trim().toLowerCase() : '';
  const password = i > 0 ? decoded.slice(i + 1) : '';
  const admin = ADMINS.get(user);
  const rec = admin || DUMMY;

  // Always hash, so a wrong username takes as long as a wrong password.
  const actual = await pbkdf2Async(password, Buffer.from(rec.salt, 'hex'), rec.iterations, 32, 'sha256');
  const ok = admin && timingSafeEqual(actual, Buffer.from(rec.hash, 'hex'));
  if (!ok) {
    await sleep(1000);   // slows down password guessing
    throw new HttpError(401, "That username and password don't match a board account.");
  }
  return user;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export function validEmail(e) { return typeof e === 'string' && e.length <= 254 && EMAIL_RE.test(e.trim()); }
