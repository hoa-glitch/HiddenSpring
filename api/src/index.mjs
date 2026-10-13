// HOA API — a single Lambda reached through its function URL (payload format 2.0).
import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3 } from './s3.mjs';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { db } from './db.mjs';
import { json, HttpError, parseBody, requireAdmin, validEmail, setRequestOrigin } from './http.mjs';
import { sendMail, confirmEmail, unsubscribeLinkEmail, announcementEmail } from './mail.mjs';
import * as minutes from './minutes.mjs';

const BUCKET = process.env.DOCS_BUCKET;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/png', 'image/jpeg', 'text/plain',
]);
const UUID_RE = /^[0-9a-f-]{36}$/i;

// ---------- Announcements ----------
async function listAnnouncements(event) {
  const limit = Math.min(parseInt(event.queryStringParameters?.limit || '50', 10) || 50, 100);
  const { rows } = await db().query(
    `SELECT id, title, body, pinned, author, created_at, updated_at
       FROM announcements ORDER BY pinned DESC, created_at DESC LIMIT $1`, [limit]);
  return json(200, rows);
}

async function createAnnouncement(event) {
  const author = await requireAdmin(event);
  const { title, body, pinned = false, sendEmail = false } = parseBody(event);
  if (!title?.trim() || !body?.trim()) throw new HttpError(400, 'Add a title and a message.');
  const { rows: [a] } = await db().query(
    `INSERT INTO announcements (title, body, pinned, author) VALUES ($1, $2, $3, $4) RETURNING *`,
    [title.trim(), body.trim(), !!pinned, author]);

  let emailed = 0;
  if (sendEmail) {
    const { rows: subs } = await db().query(
      `SELECT email, unsubscribe_token FROM subscribers WHERE status = 'active'`);
    // SES default rate is ~14/sec once out of sandbox. For large lists, move this to SQS.
    for (const s of subs) {
      try { await sendMail({ to: s.email, unsubscribeToken: s.unsubscribe_token, ...announcementEmail(a, s.unsubscribe_token) }); emailed++; }
      catch (e) { console.error('send failed', s.email, e.message); }
    }
    await db().query(`UPDATE announcements SET emailed_at = now() WHERE id = $1`, [a.id]);
  }
  return json(201, { ...a, emailed });
}

async function updateAnnouncement(event, id) {
  await requireAdmin(event);
  const { title, body, pinned } = parseBody(event);
  const { rows: [a] } = await db().query(
    `UPDATE announcements SET title = COALESCE($2, title), body = COALESCE($3, body),
            pinned = COALESCE($4, pinned), updated_at = now()
      WHERE id = $1 RETURNING *`, [id, title?.trim() || null, body?.trim() || null, pinned ?? null]);
  if (!a) throw new HttpError(404, 'That announcement no longer exists.');
  return json(200, a);
}

async function deleteAnnouncement(event, id) {
  await requireAdmin(event);
  await db().query(`DELETE FROM announcements WHERE id = $1`, [id]);
  return json(204);
}

// ---------- Documents ----------
async function listDocuments() {
  const { rows } = await db().query(
    `SELECT id, title, category, description, filename, content_type, size_bytes, created_at
       FROM documents WHERE uploaded ORDER BY category, created_at DESC`);
  return json(200, rows);
}

async function downloadDocument(id) {
  const { rows: [d] } = await db().query(`SELECT * FROM documents WHERE id = $1 AND uploaded`, [id]);
  if (!d) throw new HttpError(404, 'That document is no longer available.');
  const url = await getSignedUrl(s3, new GetObjectCommand({
    Bucket: BUCKET, Key: d.s3_key,
    ResponseContentDisposition: `attachment; filename="${d.filename.replace(/"/g, '')}"`,
  }), { expiresIn: 300 });
  return json(200, { url });
}

async function createUploadUrl(event) {
  await requireAdmin(event);
  const { title, category = 'General', description = '', filename, contentType, size } = parseBody(event);
  if (!title?.trim() || !filename) throw new HttpError(400, 'Add a title and choose a file.');
  if (!ALLOWED_TYPES.has(contentType)) throw new HttpError(400, 'Upload a PDF, Word, Excel, image, or text file.');
  if (size > MAX_UPLOAD_BYTES) throw new HttpError(400, 'Files must be 50 MB or smaller.');

  const safeName = filename.replace(/[^\w.\-]+/g, '_').slice(-120);
  const key = `documents/${randomUUID()}/${safeName}`;
  const { rows: [d] } = await db().query(
    `INSERT INTO documents (title, category, description, s3_key, filename, content_type, size_bytes)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [title.trim(), category.trim() || 'General', description.trim(), key, safeName, contentType, size || null]);
  const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({
    Bucket: BUCKET, Key: key, ContentType: contentType,
  }), { expiresIn: 600 });
  return json(201, { id: d.id, uploadUrl });
}

async function completeUpload(event, id) {
  await requireAdmin(event);
  const { rows: [d] } = await db().query(`SELECT s3_key FROM documents WHERE id = $1`, [id]);
  if (!d) throw new HttpError(404, 'That document record was not found.');
  const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: d.s3_key }))
    .catch(() => { throw new HttpError(400, 'The file did not finish uploading. Try again.'); });
  await db().query(`UPDATE documents SET uploaded = TRUE, size_bytes = $2 WHERE id = $1`, [id, head.ContentLength]);
  return json(200, { ok: true });
}

async function deleteDocument(event, id) {
  await requireAdmin(event);
  const { rows: [d] } = await db().query(`DELETE FROM documents WHERE id = $1 RETURNING s3_key`, [id]);
  if (d) await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: d.s3_key }));
  return json(204);
}

// ---------- Email list ----------
async function subscribe(event) {
  const { email, name = '', website = '' } = parseBody(event);
  if (website) return json(200, { ok: true });            // honeypot field filled = bot
  if (!validEmail(email)) throw new HttpError(400, 'Enter a valid email address.');
  const { rows: [s] } = await db().query(
    `INSERT INTO subscribers (email, name) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET
       name = COALESCE(NULLIF(EXCLUDED.name, ''), subscribers.name),
       status = CASE WHEN subscribers.status = 'active' THEN 'active' ELSE 'pending' END,
       confirm_token = CASE WHEN subscribers.status = 'active' THEN subscribers.confirm_token ELSE gen_random_uuid() END
     RETURNING status, confirm_token`, [email.trim(), name.trim()]);
  if (s.status === 'pending') await sendMail({ to: email.trim(), ...confirmEmail(s.confirm_token) });
  // Same response either way so the form can't be used to check who's on the list.
  return json(200, { ok: true });
}

async function confirm(event) {
  const { token } = parseBody(event);
  if (!UUID_RE.test(token || '')) throw new HttpError(400, 'This confirmation link is incomplete.');
  const { rowCount } = await db().query(
    `UPDATE subscribers SET status = 'active', confirmed_at = now()
      WHERE confirm_token = $1 AND status = 'pending'`, [token]);
  if (!rowCount) throw new HttpError(404, 'This link has expired or was already used. Subscribe again to get a new one.');
  return json(200, { ok: true });
}

async function unsubscribe(event) {
  const { token, email } = parseBody(event);
  if (token) {
    if (!UUID_RE.test(token)) throw new HttpError(400, 'This unsubscribe link is incomplete.');
    await db().query(
      `UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = now()
        WHERE unsubscribe_token = $1 AND status <> 'unsubscribed'`, [token]);
    return json(200, { ok: true });
  }
  // No token: email the person their personal link so nobody can unsubscribe someone else.
  if (!validEmail(email)) throw new HttpError(400, 'Enter a valid email address.');
  const { rows: [s] } = await db().query(
    `SELECT unsubscribe_token FROM subscribers WHERE email = $1 AND status = 'active'`, [email.trim()]);
  if (s) await sendMail({ to: email.trim(), ...unsubscribeLinkEmail(s.unsubscribe_token) });
  return json(200, { ok: true, linkSent: true });
}

async function oneClickUnsubscribe(event) {
  const token = event.queryStringParameters?.token;
  if (UUID_RE.test(token || '')) {
    await db().query(`UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = now()
                       WHERE unsubscribe_token = $1`, [token]);
  }
  return json(200, { ok: true });
}

async function listSubscribers(event) {
  await requireAdmin(event);
  const { rows } = await db().query(
    `SELECT email, name, status, created_at, confirmed_at FROM subscribers ORDER BY created_at DESC`);
  return json(200, rows);
}

// ---------- Board sign-in check ----------
async function adminCheck(event) {
  return json(200, { user: await requireAdmin(event) });
}

// ---------- One-time database setup ----------
// Run from the Lambda console Test tab with the event {"action": "setup-database"}.
// Website visitors can't trigger this: web requests always arrive with requestContext.
async function setupDatabase() {
  const sql = readFileSync(new URL('./sql/schema.sql', import.meta.url), 'utf8');
  await db().query(sql);
  const { rows } = await db().query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`);
  return { ok: true, tables: rows.map(r => r.table_name) };
}

// ---------- Router ----------
const routes = [
  ['GET',    /^\/announcements$/,                 listAnnouncements],
  ['POST',   /^\/announcements$/,                 createAnnouncement],
  ['PUT',    /^\/announcements\/(\d+)$/,          updateAnnouncement],
  ['DELETE', /^\/announcements\/(\d+)$/,          deleteAnnouncement],
  ['GET',    /^\/documents$/,                     listDocuments],
  ['GET',    /^\/documents\/(\d+)\/download$/,    (e, id) => downloadDocument(id)],
  ['POST',   /^\/documents$/,                     createUploadUrl],
  ['POST',   /^\/documents\/(\d+)\/complete$/,    completeUpload],
  ['DELETE', /^\/documents\/(\d+)$/,              deleteDocument],
  ['POST',   /^\/subscribe$/,                     subscribe],
  ['POST',   /^\/subscribe\/confirm$/,            confirm],
  ['POST',   /^\/unsubscribe$/,                   unsubscribe],
  ['POST',   /^\/unsubscribe\/one-click$/,        oneClickUnsubscribe],
  ['GET',    /^\/subscribers$/,                   listSubscribers],
  ['GET',    /^\/admin\/check$/,                  adminCheck],
  // Board-only meeting minutes (every handler checks the board login)
  ['GET',    /^\/minutes$/,                       minutes.listMinutes],
  ['POST',   /^\/minutes$/,                       minutes.createMinutes],
  ['GET',    /^\/minutes\/(\d+)$/,                minutes.minutesDetail],
  ['PUT',    /^\/minutes\/(\d+)$/,                minutes.updateMinutes],
  ['DELETE', /^\/minutes\/(\d+)$/,                minutes.deleteMinutes],
  ['GET',    /^\/minutes\/(\d+)\/view$/,          minutes.viewMinutes],
  ['POST',   /^\/minutes\/(\d+)\/revise$/,        minutes.reviseMinutes],
  ['POST',   /^\/minutes\/(\d+)\/complete$/,      minutes.completeMinutesUpload],
  ['POST',   /^\/minutes\/(\d+)\/comments$/,      minutes.addComment],
  ['DELETE', /^\/minutes\/(\d+)\/comments\/(\d+)$/, minutes.deleteComment],
  ['POST',   /^\/minutes\/(\d+)\/signoff$/,       minutes.signOff],
  ['DELETE', /^\/minutes\/(\d+)\/signoff$/,       minutes.removeSignOff],
];

export async function handler(event) {
  if (event.action === 'setup-database' && !event.requestContext) return setupDatabase();
  setRequestOrigin(event);
  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = (event.rawPath || event.path || '/').replace(/^\/(prod|dev)(?=\/)/, '');
  if (method === 'OPTIONS') return json(204);
  try {
    for (const [m, re, fn] of routes) {
      const match = m === method && path.match(re);
      if (match) return await fn(event, ...match.slice(1).map(Number));
    }
    throw new HttpError(404, 'Not found.');
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.message });
    console.error(err);
    return json(500, { error: 'Something went wrong on the server. Try again in a minute.' });
  }
}
