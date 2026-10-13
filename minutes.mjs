// Board-only meeting minutes: upload a draft, comment, sign off, revise, approve.
// Every handler here starts with requireAdmin, and the public routes in index.mjs never
// read these tables, so homeowners can't list or download minutes.
import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3 } from './s3.mjs';
import { randomUUID } from 'node:crypto';
import { db } from './db.mjs';
import { json, HttpError, parseBody, requireAdmin, boardMembers } from './http.mjs';

const BUCKET = () => process.env.DOCS_BUCKET;
const MAX_BYTES = 25 * 1024 * 1024;
const TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function checkFile({ filename, contentType, size }) {
  if (!filename) throw new HttpError(400, 'Choose a file to upload.');
  if (!TYPES.has(contentType)) throw new HttpError(400, 'Upload minutes as a PDF, Word, or text file.');
  if (size > MAX_BYTES) throw new HttpError(400, 'Minutes files must be 25 MB or smaller.');
  const safe = filename.replace(/[^\w.\-]+/g, '_').slice(-120);
  return { safe, key: `board/minutes/${randomUUID()}/${safe}` };
}

async function uploadUrl(key, contentType) {
  return getSignedUrl(s3, new PutObjectCommand({ Bucket: BUCKET(), Key: key, ContentType: contentType }), { expiresIn: 600 });
}

async function getMinutes(id) {
  const { rows: [m] } = await db().query(`SELECT * FROM minutes WHERE id = $1`, [id]);
  if (!m) throw new HttpError(404, 'Those minutes no longer exist.');
  return m;
}

function summary(m) {
  return {
    id: m.id, meeting_date: m.meeting_date, title: m.title, status: m.status, version: m.version,
    filename: m.filename, content_type: m.content_type, size_bytes: m.size_bytes,
    uploaded_by: m.uploaded_by, approved_by: m.approved_by, approved_at: m.approved_at,
    created_at: m.created_at, updated_at: m.updated_at,
  };
}

// GET /minutes
export async function listMinutes(event) {
  await requireAdmin(event);
  const { rows } = await db().query(`
    SELECT m.*,
           COALESCE((SELECT json_agg(s.reviewer ORDER BY s.created_at) FROM minutes_signoffs s WHERE s.minutes_id = m.id), '[]') AS signoffs,
           (SELECT count(*)::int FROM minutes_comments c WHERE c.minutes_id = m.id) AS comment_count
      FROM minutes m
     WHERE m.version > 0
     ORDER BY m.meeting_date DESC, m.id DESC`);
  return json(200, {
    board: boardMembers(),
    minutes: rows.map(m => ({ ...summary(m), signoffs: m.signoffs, comment_count: m.comment_count })),
  });
}

// GET /minutes/{id}
export async function minutesDetail(event, id) {
  const me = await requireAdmin(event);
  const m = await getMinutes(id);
  if (!m.version) throw new HttpError(404, 'Those minutes are still uploading.');
  const [{ rows: comments }, { rows: signoffs }] = await Promise.all([
    db().query(`SELECT id, author, body, version, created_at FROM minutes_comments WHERE minutes_id = $1 ORDER BY created_at`, [id]),
    db().query(`SELECT reviewer, created_at FROM minutes_signoffs WHERE minutes_id = $1 ORDER BY created_at`, [id]),
  ]);
  return json(200, { ...summary(m), me, board: boardMembers(), comments, signoffs });
}

// POST /minutes  {meetingDate, title, filename, contentType, size}
export async function createMinutes(event) {
  const user = await requireAdmin(event);
  const { meetingDate, title = '', filename, contentType, size } = parseBody(event);
  if (!DATE_RE.test(meetingDate || '')) throw new HttpError(400, 'Enter the meeting date.');
  const { safe, key } = checkFile({ filename, contentType, size });
  const name = title.trim() || 'Board meeting minutes';
  const { rows: [m] } = await db().query(
    `INSERT INTO minutes (meeting_date, title, pending_s3_key, pending_filename, pending_content_type, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [meetingDate, name.slice(0, 200), key, safe, contentType, user]);
  return json(201, { id: m.id, uploadUrl: await uploadUrl(key, contentType) });
}

// POST /minutes/{id}/revise  {filename, contentType, size}
export async function reviseMinutes(event, id) {
  await requireAdmin(event);
  const m = await getMinutes(id);
  if (m.status === 'approved') throw new HttpError(409, 'These minutes are approved. Return them to draft before uploading a new version.');
  const { filename, contentType, size } = parseBody(event);
  const { safe, key } = checkFile({ filename, contentType, size });
  await db().query(
    `UPDATE minutes SET pending_s3_key = $2, pending_filename = $3, pending_content_type = $4 WHERE id = $1`,
    [id, key, safe, contentType]);
  return json(200, { id, uploadUrl: await uploadUrl(key, contentType) });
}

// POST /minutes/{id}/complete  — called after the browser finishes uploading to S3
export async function completeMinutesUpload(event, id) {
  await requireAdmin(event);
  const m = await getMinutes(id);
  if (!m.pending_s3_key) throw new HttpError(400, 'There is no upload waiting to finish.');
  const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET(), Key: m.pending_s3_key }))
    .catch(() => { throw new HttpError(400, 'The file did not finish uploading. Try again.'); });

  const isRevision = m.version > 0;
  await db().query(
    `UPDATE minutes SET s3_key = pending_s3_key, filename = pending_filename, content_type = pending_content_type,
            size_bytes = $2, pending_s3_key = NULL, pending_filename = NULL, pending_content_type = NULL,
            version = version + 1, updated_at = now()
      WHERE id = $1`, [id, head.ContentLength]);
  if (isRevision) {
    // Sign-offs were for the old file, so everyone reviews the new version.
    await db().query(`DELETE FROM minutes_signoffs WHERE minutes_id = $1`, [id]);
    if (m.s3_key) await s3.send(new DeleteObjectCommand({ Bucket: BUCKET(), Key: m.s3_key })).catch(() => {});
  }
  return json(200, { ok: true, version: m.version + 1 });
}

// GET /minutes/{id}/view  — short-lived link; PDFs and text open in the browser, Word files download
export async function viewMinutes(event, id) {
  await requireAdmin(event);
  const m = await getMinutes(id);
  if (!m.s3_key) throw new HttpError(404, 'Those minutes are still uploading.');
  const inline = m.content_type === 'application/pdf' || m.content_type === 'text/plain';
  const url = await getSignedUrl(s3, new GetObjectCommand({
    Bucket: BUCKET(), Key: m.s3_key,
    ResponseContentDisposition: `${inline ? 'inline' : 'attachment'}; filename="${m.filename.replace(/"/g, '')}"`,
    ResponseContentType: m.content_type,
  }), { expiresIn: 300 });
  return json(200, { url });
}

// POST /minutes/{id}/comments  {body}
export async function addComment(event, id) {
  const user = await requireAdmin(event);
  const m = await getMinutes(id);
  const body = String(parseBody(event).body || '').trim();
  if (!body) throw new HttpError(400, 'Write a comment first.');
  if (body.length > 5000) throw new HttpError(400, 'Keep comments under 5,000 characters.');
  const { rows: [c] } = await db().query(
    `INSERT INTO minutes_comments (minutes_id, author, body, version) VALUES ($1, $2, $3, $4)
     RETURNING id, author, body, version, created_at`, [id, user, body, m.version]);
  return json(201, c);
}

// DELETE /minutes/{id}/comments/{commentId}  — only the author can remove their comment
export async function deleteComment(event, id, commentId) {
  const user = await requireAdmin(event);
  const { rowCount } = await db().query(
    `DELETE FROM minutes_comments WHERE id = $1 AND minutes_id = $2 AND author = $3`, [commentId, id, user]);
  if (!rowCount) throw new HttpError(403, 'You can only remove your own comments.');
  return json(204);
}

// POST /minutes/{id}/signoff   and   DELETE /minutes/{id}/signoff
export async function signOff(event, id) {
  const user = await requireAdmin(event);
  const m = await getMinutes(id);
  if (!m.version) throw new HttpError(400, 'Those minutes are still uploading.');
  await db().query(
    `INSERT INTO minutes_signoffs (minutes_id, reviewer) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, user]);
  return json(200, { ok: true });
}
export async function removeSignOff(event, id) {
  const user = await requireAdmin(event);
  await db().query(`DELETE FROM minutes_signoffs WHERE minutes_id = $1 AND reviewer = $2`, [id, user]);
  return json(200, { ok: true });
}

// PUT /minutes/{id}  {status: 'approved' | 'draft', title?, meetingDate?}
export async function updateMinutes(event, id) {
  const user = await requireAdmin(event);
  await getMinutes(id);
  const { status, title, meetingDate } = parseBody(event);
  if (status && !['approved', 'draft'].includes(status)) throw new HttpError(400, 'Status must be approved or draft.');
  if (meetingDate && !DATE_RE.test(meetingDate)) throw new HttpError(400, 'Enter a valid meeting date.');
  const { rows: [m] } = await db().query(
    `UPDATE minutes SET
        status       = COALESCE($2, status),
        approved_by  = CASE WHEN $2 = 'approved' THEN $5 WHEN $2 = 'draft' THEN NULL ELSE approved_by END,
        approved_at  = CASE WHEN $2 = 'approved' THEN now() WHEN $2 = 'draft' THEN NULL ELSE approved_at END,
        title        = COALESCE(NULLIF($3, ''), title),
        meeting_date = COALESCE($4::date, meeting_date),
        updated_at   = now()
      WHERE id = $1 RETURNING *`,
    [id, status || null, title?.trim()?.slice(0, 200) || null, meetingDate || null, user]);
  return json(200, summary(m));
}

// DELETE /minutes/{id}
export async function deleteMinutes(event, id) {
  await requireAdmin(event);
  const { rows: [m] } = await db().query(`DELETE FROM minutes WHERE id = $1 RETURNING s3_key, pending_s3_key`, [id]);
  for (const key of [m?.s3_key, m?.pending_s3_key].filter(Boolean)) {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET(), Key: key })).catch(() => {});
  }
  return json(204);
}
