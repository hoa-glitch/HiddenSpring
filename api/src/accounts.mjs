// Board sign-in and board account management.
//
// Two kinds of board login:
//   - "aws" logins come from the Lambda's ADMIN_USERS setting. They always work and can't be
//     removed or reset from the website, so the board can never lock itself out completely.
//   - "site" logins live in the board_users table. Any signed-in board member can add, remove,
//     or reset them from the Board members tab, and every change is written to board_audit.
//
// Passwords are stored only as PBKDF2-SHA256 hashes (600,000 iterations).
import { pbkdf2, randomBytes, randomInt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { db } from './db.mjs';
import { json, HttpError, parseBody } from './http.mjs';

const pbkdf2Async = promisify(pbkdf2);
const ITERATIONS = 600000;
const USERNAME_RE = /^[a-z0-9._-]{2,40}$/;
const MIN_PASSWORD = 12;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- AWS-managed (recovery) logins from ADMIN_USERS ----------
// Format: username:iterations:salt:hash, comma-separated (made with tools/make-password.html).
function loadAwsLogins() {
  const map = new Map();
  for (const entry of (process.env.ADMIN_USERS || '').split(',')) {
    const [user, iterations, salt, hash] = entry.trim().split(':');
    if (user && iterations && salt && hash) {
      map.set(user.toLowerCase(), { iterations: Number(iterations), salt, hash });
    }
  }
  return map;
}
const AWS_LOGINS = loadAwsLogins();

// ---------- Hashing ----------
async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await pbkdf2Async(password, salt, ITERATIONS, 32, 'sha256');
  return { iterations: ITERATIONS, salt: salt.toString('hex'), hash: hash.toString('hex') };
}

async function passwordMatches(password, rec) {
  const actual = await pbkdf2Async(password, Buffer.from(rec.salt, 'hex'), rec.iterations, 32, 'sha256');
  const expected = Buffer.from(rec.hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const DUMMY = { iterations: ITERATIONS, salt: '00'.repeat(16), hash: '00'.repeat(32) };

// Readable one-time password, e.g. "k7mp-x3qr-9fwt-h2nd" (no 0/o, 1/l/i).
function temporaryPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const groups = Array.from({ length: 4 }, () =>
    Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join(''));
  return groups.join('-');
}

// ---------- Looking up a login ----------
async function findAccount(username) {
  const aws = AWS_LOGINS.get(username);
  if (aws) return { username, source: 'aws', must_change_password: false, ...aws };
  const { rows: [r] } = await db().query(
    `SELECT username, iterations, salt, hash, must_change_password FROM board_users WHERE username = $1`, [username]);
  return r ? { ...r, source: 'site' } : null;
}

export async function boardMembers() {
  const { rows } = await db().query(`SELECT username FROM board_users`);
  return [...new Set([...AWS_LOGINS.keys(), ...rows.map(r => r.username)])].sort();
}

async function audit(actor, action, target) {
  await db().query(`INSERT INTO board_audit (actor, action, target) VALUES ($1, $2, $3)`, [actor, action, target || null]);
}

// ---------- Checking the sign-in on each request ----------
// Basic auth sends the password with every board request, and a full hash takes a moment, so a
// warm Lambda remembers successful checks for 5 minutes. The cache key includes the stored hash,
// so a password change, reset, or removal takes effect on the very next request.
const recentlyVerified = new Map();
const CACHE_MS = 5 * 60 * 1000;
const cacheKey = (acct, password) =>
  createHash('sha256').update(`${acct.username}\0${acct.hash}\0${password}`).digest('hex');

export async function authenticate(event) {
  const header = event.headers?.authorization || event.headers?.Authorization || '';
  const match = header.match(/^Basic\s+(\S+)$/i);
  if (!match) throw new HttpError(401, 'Sign in to continue.');

  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  const username = i > 0 ? decoded.slice(0, i).trim().toLowerCase() : '';
  const password = i > 0 ? decoded.slice(i + 1) : '';
  const acct = USERNAME_RE.test(username) ? await findAccount(username) : null;

  if (acct) {
    const key = cacheKey(acct, password);
    if ((recentlyVerified.get(key) || 0) > Date.now()) return acct;
    if (await passwordMatches(password, acct)) {
      if (recentlyVerified.size > 500) recentlyVerified.clear();
      recentlyVerified.set(key, Date.now() + CACHE_MS);
      return acct;
    }
  } else {
    await passwordMatches(password, DUMMY);   // same time for unknown usernames
  }
  await sleep(1000);                           // slows down password guessing
  throw new HttpError(401, "That username and password don't match a board account.");
}

// Use on every board-only route. Returns the username.
export async function requireAdmin(event) {
  const acct = await authenticate(event);
  if (acct.must_change_password) {
    throw new HttpError(403, 'Set a new password before continuing.', 'password_change_required');
  }
  return acct.username;
}

// ---------- Routes ----------

// GET /admin/check — used by the sign-in form
export async function adminCheck(event) {
  const acct = await authenticate(event);
  if (acct.source === 'site') {
    await db().query(`UPDATE board_users SET last_sign_in_at = now() WHERE username = $1`, [acct.username]);
  }
  return json(200, { user: acct.username, source: acct.source, mustChangePassword: acct.must_change_password });
}

// GET /board-users
export async function listBoardUsers(event) {
  const me = await requireAdmin(event);
  const [{ rows: site }, { rows: log }] = await Promise.all([
    db().query(`SELECT username, created_by, created_at, must_change_password, last_sign_in_at
                  FROM board_users ORDER BY username`),
    db().query(`SELECT actor, action, target, created_at FROM board_audit ORDER BY created_at DESC LIMIT 25`),
  ]);
  const users = [
    ...[...AWS_LOGINS.keys()].map(username => ({ username, source: 'aws' })),
    ...site.filter(u => !AWS_LOGINS.has(u.username)).map(u => ({ ...u, source: 'site' })),
  ].sort((a, b) => a.username.localeCompare(b.username));
  return json(200, { me, users, log });
}

// POST /board-users  {username}  -> one-time temporary password
export async function addBoardUser(event) {
  const me = await requireAdmin(event);
  const username = String(parseBody(event).username || '').trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    throw new HttpError(400, 'Usernames are 2 to 40 characters: letters, numbers, dots, dashes, or underscores.');
  }
  if (AWS_LOGINS.has(username)) throw new HttpError(409, `"${username}" is already a board login.`);
  const temp = temporaryPassword();
  const h = await hashPassword(temp);
  const { rowCount } = await db().query(
    `INSERT INTO board_users (username, iterations, salt, hash, must_change_password, created_by)
     VALUES ($1, $2, $3, $4, TRUE, $5) ON CONFLICT (username) DO NOTHING`,
    [username, h.iterations, h.salt, h.hash, me]);
  if (!rowCount) throw new HttpError(409, `"${username}" is already a board login.`);
  await audit(me, 'added', username);
  return json(201, { username, temporaryPassword: temp });
}

// DELETE /board-users/{username}
export async function removeBoardUser(event, username) {
  const me = await requireAdmin(event);
  username = String(username).toLowerCase();
  if (username === me) throw new HttpError(400, "You can't remove your own login. Ask another board member.");
  if (AWS_LOGINS.has(username)) {
    throw new HttpError(400, `"${username}" is a recovery login kept in the AWS settings, so it can't be removed here.`);
  }
  const { rowCount } = await db().query(`DELETE FROM board_users WHERE username = $1`, [username]);
  if (!rowCount) throw new HttpError(404, `"${username}" isn't a board login.`);
  await audit(me, 'removed', username);
  return json(204);
}

// POST /board-users/{username}/reset  -> new one-time temporary password
export async function resetBoardUser(event, username) {
  const me = await requireAdmin(event);
  username = String(username).toLowerCase();
  if (username === me) throw new HttpError(400, 'To change your own password, use "Change my password".');
  if (AWS_LOGINS.has(username)) {
    throw new HttpError(400, `"${username}" is a recovery login kept in the AWS settings, so its password can't be reset here.`);
  }
  const temp = temporaryPassword();
  const h = await hashPassword(temp);
  const { rowCount } = await db().query(
    `UPDATE board_users SET iterations = $2, salt = $3, hash = $4, must_change_password = TRUE WHERE username = $1`,
    [username, h.iterations, h.salt, h.hash]);
  if (!rowCount) throw new HttpError(404, `"${username}" isn't a board login.`);
  await audit(me, 'reset the password for', username);
  return json(200, { username, temporaryPassword: temp });
}

// POST /account/password  {newPassword}
// The Authorization header already proves the current password. Works during a forced change.
export async function changeOwnPassword(event) {
  const acct = await authenticate(event);
  if (acct.source === 'aws') {
    throw new HttpError(400, 'Your login is a recovery login kept in the AWS settings. Change it there with the password tool.');
  }
  const newPassword = String(parseBody(event).newPassword || '');
  if (newPassword.length < MIN_PASSWORD) throw new HttpError(400, `Use at least ${MIN_PASSWORD} characters.`);
  if (newPassword.length > 200) throw new HttpError(400, 'Use 200 characters or fewer.');
  if (await passwordMatches(newPassword, acct)) throw new HttpError(400, 'Choose a password different from your current one.');
  const h = await hashPassword(newPassword);
  await db().query(
    `UPDATE board_users SET iterations = $2, salt = $3, hash = $4, must_change_password = FALSE,
            password_changed_at = now() WHERE username = $1`,
    [acct.username, h.iterations, h.salt, h.hash]);
  await audit(acct.username, 'changed their own password', null);
  return json(200, { ok: true });
}
