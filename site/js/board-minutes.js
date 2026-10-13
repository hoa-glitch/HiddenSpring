// Board-only meeting minutes: list, upload drafts, review (comments + sign-offs), revise, approve.
import { api } from './api.js';
import { esc, formatDate, formatSize, setStatus } from './ui.js';

const home = () => document.getElementById('minutes-home');
const detail = () => document.getElementById('minutes-detail');
const listEl = () => document.getElementById('minutes-list');

// 'YYYY-MM-DD' -> "October 6, 2026", read as a local date (no time-zone shift)
function meetingDate(d) {
  const [y, m, day] = String(d).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}
function statusTag(status) {
  return status === 'approved'
    ? '<span class="tag tag-approved">Approved</span>'
    : '<span class="tag tag-draft">Draft</span>';
}

// Upload a file to S3 with the signed link, then tell the API it finished.
async function sendFile(id, uploadUrl, file) {
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file })
    .catch(() => ({ ok: false }));
  if (!put.ok) throw new Error('The file upload to storage failed. Try again.');
  return api(`/minutes/${id}/complete`, { method: 'POST', auth: true });
}

// Word files from some systems arrive with no type; fill it in from the extension.
function fileType(file) {
  if (file.type) return file.type;
  const ext = file.name.split('.').pop().toLowerCase();
  return { pdf: 'application/pdf', doc: 'application/msword', txt: 'text/plain',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }[ext] || '';
}

// ---------- List ----------
export async function loadMinutes() {
  showList();
  const ul = listEl();
  try {
    const { board, minutes } = await api('/minutes', { auth: true });
    ul.innerHTML = minutes.length ? minutes.map(m => `
      <li>
        <button type="button" class="minutes-row" data-open="${m.id}">
          <span class="minutes-row-main">
            <strong>${esc(meetingDate(m.meeting_date))}</strong> ${statusTag(m.status)}
            <span class="doc-meta">${esc(m.title)}</span>
          </span>
          <span class="doc-meta">
            ${m.status === 'approved'
              ? `Approved by ${esc(m.approved_by)}`
              : `Reviewed by ${m.signoffs.length} of ${board.length}`}${m.comment_count ? `, ${m.comment_count} comment${m.comment_count === 1 ? '' : 's'}` : ''}
          </span>
        </button>
      </li>`).join('')
      : '<li class="empty">No minutes yet. Upload the draft from your last meeting to start the review.</li>';
  } catch (e) {
    ul.innerHTML = `<li class="empty">${esc(e.message)}</li>`;
  }
}

function showList() { home().hidden = false; detail().hidden = true; detail().innerHTML = ''; }

// ---------- Detail ----------
async function openMinutes(id, flash) {
  home().hidden = true;
  const box = detail();
  box.hidden = false;
  box.innerHTML = '<p class="empty">Loading…</p>';
  let m;
  try { m = await api(`/minutes/${id}`, { auth: true }); }
  catch (e) { box.innerHTML = `<button type="button" class="btn btn-quiet btn-sm" data-back>Back to all minutes</button><p class="empty">${esc(e.message)}</p>`; return; }

  const reviewed = m.signoffs.map(s => s.reviewer);
  const waiting = m.board.filter(u => !reviewed.includes(u));
  const iReviewed = reviewed.includes(m.me);
  const draft = m.status === 'draft';

  box.innerHTML = `
    <button type="button" class="btn btn-quiet btn-sm" data-back>Back to all minutes</button>
    <div class="minutes-head">
      <h2>${esc(m.title)} ${statusTag(m.status)}</h2>
      <p class="doc-meta">Meeting on ${esc(meetingDate(m.meeting_date))}. Version ${m.version}, ${esc(m.filename)}${m.size_bytes ? ` (${formatSize(m.size_bytes)})` : ''}, uploaded by ${esc(m.uploaded_by)}.
      ${m.status === 'approved' ? `Approved by ${esc(m.approved_by)} on ${formatDate(m.approved_at)}.` : ''}</p>
      <div id="minutes-detail-status" class="status"></div>
      <button type="button" class="btn" data-view>Open minutes</button>
    </div>

    <div class="minutes-grid">
      <div>
        <section class="form-card minutes-card">
          <h3>Board review</h3>
          ${draft
            ? `<p>${reviewed.length ? `Reviewed by ${reviewed.map(esc).join(', ')}.` : 'No one has reviewed this version yet.'}
               ${waiting.length ? `Waiting on ${waiting.map(esc).join(', ')}.` : 'Everyone on the board has reviewed it.'}</p>`
            : `<p>Approved by ${esc(m.approved_by)}.${reviewed.length ? ` Reviewed by ${reviewed.map(esc).join(', ')} before approval.` : ''}</p>`}
          ${draft ? `<button type="button" class="btn ${iReviewed ? 'btn-quiet' : ''}" data-signoff="${iReviewed ? 'remove' : 'add'}">
            ${iReviewed ? 'Undo my review' : "I've reviewed this version"}</button>` : ''}
        </section>

        <section class="minutes-comments">
          <h3>Comments</h3>
          <ul class="comment-list">
            ${m.comments.length ? m.comments.map(c => `
              <li>
                <div class="comment-meta"><strong>${esc(c.author)}</strong>
                  <span class="doc-meta">${formatDate(c.created_at)}${c.version !== m.version ? `, on version ${c.version}` : ''}</span>
                  ${c.author === m.me ? `<button type="button" class="link-btn" data-del-comment="${c.id}">Remove</button>` : ''}</div>
                <div class="comment-body">${esc(c.body)}</div>
              </li>`).join('') : '<li class="empty">No comments yet. Note any corrections here before the board approves.</li>'}
          </ul>
          <form id="comment-form">
            <div class="field">
              <label for="comment-body">Add a comment or correction</label>
              <textarea id="comment-body" name="body" required maxlength="5000" placeholder="e.g. Item 4: the vote was 4 to 1, not unanimous."></textarea>
            </div>
            <button class="btn" type="submit">Add comment</button>
          </form>
        </section>
      </div>

      <div>
        ${draft ? `
        <section class="form-card minutes-card">
          <h3>Upload a revised version</h3>
          <p class="hint">Use this after making corrections. Everyone's reviews reset so the board checks the new version; comments stay.</p>
          <form id="revise-form">
            <div class="field"><label for="revise-file">Revised file</label>
              <input type="file" id="revise-file" required accept=".pdf,.doc,.docx,.txt"></div>
            <button class="btn btn-quiet" type="submit">Upload version ${m.version + 1}</button>
          </form>
        </section>` : ''}

        <section class="form-card minutes-card">
          <h3>Approval</h3>
          ${draft
            ? `<p class="hint">Mark the minutes approved once the board votes to approve them.</p>
               <button type="button" class="btn" data-status="approved">Mark as approved</button>`
            : `<p class="hint">Approved minutes are locked. Return them to draft to make changes.</p>
               <button type="button" class="btn btn-quiet" data-status="draft">Return to draft</button>`}
        </section>

        <section class="form-card minutes-card">
          <h3>Delete</h3>
          <p class="hint">Removes the file, comments, and reviews for good.</p>
          <button type="button" class="btn btn-danger" data-delete-minutes>Delete these minutes</button>
        </section>
      </div>
    </div>`;

  const status = document.getElementById('minutes-detail-status');
  if (flash) setStatus(status, flash, 'ok');
  box.dataset.id = id;

  document.getElementById('comment-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      await api(`/minutes/${id}/comments`, { method: 'POST', auth: true, body: { body: e.target.body.value } });
      openMinutes(id, 'Comment added.');
    } catch (err) { setStatus(status, err.message, 'error'); btn.disabled = false; }
  });

  document.getElementById('revise-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = document.getElementById('revise-file').files[0];
    if (!file) return setStatus(status, 'Choose the revised file.', 'error');
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    setStatus(status, 'Uploading…');
    try {
      const { uploadUrl } = await api(`/minutes/${id}/revise`, { method: 'POST', auth: true,
        body: { filename: file.name, contentType: fileType(file), size: file.size } });
      const { version } = await sendFile(id, uploadUrl, file);
      openMinutes(id, `Uploaded version ${version}. Reviews were reset for the new version.`);
    } catch (err) { setStatus(status, err.message, 'error'); btn.disabled = false; }
  });
}

// One click handler for everything inside the detail view and the list.
async function onClick(e) {
  const t = e.target.closest('button');
  if (!t) return;
  const id = Number(detail().dataset.id);
  const status = document.getElementById('minutes-detail-status');
  try {
    if (t.dataset.open) return openMinutes(Number(t.dataset.open));
    if (t.hasAttribute('data-back')) return loadMinutes();
    if (t.hasAttribute('data-view')) {
      // Open the tab now (before the await) so pop-up blockers allow it.
      const win = window.open('', '_blank');
      try {
        const { url } = await api(`/minutes/${id}/view`, { auth: true });
        if (win) win.location = url; else window.location.assign(url);
      } catch (err) { win?.close(); throw err; }
      return;
    }
    if (t.dataset.signoff) {
      t.disabled = true;
      await api(`/minutes/${id}/signoff`, { method: t.dataset.signoff === 'add' ? 'POST' : 'DELETE', auth: true });
      return openMinutes(id, t.dataset.signoff === 'add' ? 'Marked as reviewed.' : 'Review removed.');
    }
    if (t.dataset.delComment) {
      await api(`/minutes/${id}/comments/${t.dataset.delComment}`, { method: 'DELETE', auth: true });
      return openMinutes(id, 'Comment removed.');
    }
    if (t.dataset.status) {
      const approving = t.dataset.status === 'approved';
      if (!confirm(approving
        ? 'Mark these minutes approved? Do this after the board has voted to approve them.'
        : 'Return these minutes to draft so they can be revised?')) return;
      await api(`/minutes/${id}`, { method: 'PUT', auth: true, body: { status: t.dataset.status } });
      return openMinutes(id, approving ? 'Marked as approved.' : 'Returned to draft.');
    }
    if (t.hasAttribute('data-delete-minutes')) {
      if (!confirm('Delete these minutes, with all comments and reviews? This cannot be undone.')) return;
      await api(`/minutes/${id}`, { method: 'DELETE', auth: true });
      await loadMinutes();
      setStatus(document.getElementById('minutes-status'), 'Minutes deleted.', 'ok');
    }
  } catch (err) {
    if (status) setStatus(status, err.message, 'error'); else alert(err.message);
    t.disabled = false;
  }
}

// ---------- Setup ----------
let ready = false;
export function initMinutes() {
  if (ready) return;
  ready = true;
  document.getElementById('panel-minutes').addEventListener('click', onClick);

  const form = document.getElementById('minutes-form');
  const status = document.getElementById('minutes-status');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const file = f.get('file');
    if (!file?.size) return setStatus(status, 'Choose a file to upload.', 'error');
    if (!f.get('meetingDate')) return setStatus(status, 'Enter the meeting date.', 'error');
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    setStatus(status, 'Uploading…');
    try {
      const { id, uploadUrl } = await api('/minutes', { method: 'POST', auth: true, body: {
        meetingDate: f.get('meetingDate'), title: f.get('title'),
        filename: file.name, contentType: fileType(file), size: file.size,
      } });
      await sendFile(id, uploadUrl, file);
      form.reset();
      setStatus(status, 'Draft uploaded. The board can now review it.', 'ok');
      await loadMinutes();
    } catch (err) { setStatus(status, err.message, 'error'); }
    finally { btn.disabled = false; }
  });
}
