import { api } from './api.js';
import { setCredentials, clearCredentials, authHeader } from './auth.js';
import { esc, formatDate, formatSize, setStatus } from './ui.js';
import { initMinutes, loadMinutes } from './board-minutes.js';

const signInForm = document.getElementById('sign-in-form');
const panel = document.getElementById('admin-panel');
const pageStatus = document.getElementById('admin-status');
let started = false;

async function showPanelIfSignedIn() {
  if (!authHeader()) { signInForm.hidden = false; panel.hidden = true; return; }
  try {
    const { user } = await api('/admin/check', { auth: true });
    document.getElementById('who').textContent = user;
    signInForm.hidden = true;
    panel.hidden = false;
    setStatus(pageStatus, '');
    if (!started) { started = true; initTabs(); initMinutes(); }
    loadAnnouncements();
    loadDocuments();
  } catch (e) {
    signInForm.hidden = false;
    panel.hidden = true;
    setStatus(pageStatus, e.message, 'error');
  }
}

signInForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(signInForm);
  const btn = signInForm.querySelector('button[type="submit"]');
  btn.disabled = true;
  setStatus(pageStatus, 'Signing in…');
  setCredentials(f.get('username'), f.get('password'));
  signInForm.reset();
  await showPanelIfSignedIn();
  btn.disabled = false;
});

document.getElementById('sign-out').addEventListener('click', () => {
  clearCredentials();
  panel.hidden = true;
  signInForm.hidden = false;
  setStatus(pageStatus, "You're signed out.", 'ok');
});

showPanelIfSignedIn();

// ---------- Tabs ----------
function initTabs() {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  tabs.forEach(tab => tab.addEventListener('click', () => {
    tabs.forEach(t => {
      const on = t === tab;
      t.setAttribute('aria-selected', on);
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    });
    if (tab.id === 'tab-subscribers') loadSubscribers();
    if (tab.id === 'tab-minutes') loadMinutes();
  }));
}

// ---------- Announcements ----------
const annForm = document.getElementById('announcement-form');
const annStatus = document.getElementById('announcement-status');
const annList = document.getElementById('announcement-list');

async function loadAnnouncements() {
  try {
    const items = await api('/announcements');
    annList.innerHTML = items.length ? items.map(a => `
      <li>
        <div><strong>${esc(a.title)}</strong>${a.pinned ? '<span class="pin-tag">Pinned</span>' : ''}
          <div class="doc-meta">${formatDate(a.created_at)}</div></div>
        <span>
          <button class="btn btn-quiet btn-sm" data-pin="${a.id}" data-pinned="${a.pinned}">${a.pinned ? 'Unpin' : 'Pin'}</button>
          <button class="btn btn-danger btn-sm" data-delete-ann="${a.id}">Delete</button>
        </span>
      </li>`).join('') : '<li class="empty">No announcements posted yet.</li>';
  } catch (e) { annList.innerHTML = `<li class="empty">${esc(e.message)}</li>`; }
}

annForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(annForm);
  const sendEmail = f.get('sendEmail') === 'on';
  if (sendEmail && !confirm('Post this announcement and email it to every subscriber?')) return;
  const btn = annForm.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const res = await api('/announcements', { method: 'POST', auth: true, body: {
      title: f.get('title'), body: f.get('body'), pinned: f.get('pinned') === 'on', sendEmail,
    } });
    annForm.reset();
    setStatus(annStatus, sendEmail ? `Posted and emailed to ${res.emailed} subscribers.` : 'Posted.', 'ok');
    loadAnnouncements();
  } catch (err) { setStatus(annStatus, err.message, 'error'); }
  finally { btn.disabled = false; }
});

annList.addEventListener('click', async (e) => {
  const del = e.target.closest('[data-delete-ann]');
  const pin = e.target.closest('[data-pin]');
  try {
    if (del && confirm('Delete this announcement? This cannot be undone.')) {
      await api(`/announcements/${del.dataset.deleteAnn}`, { method: 'DELETE', auth: true });
      loadAnnouncements();
    }
    if (pin) {
      await api(`/announcements/${pin.dataset.pin}`, { method: 'PUT', auth: true, body: { pinned: pin.dataset.pinned !== 'true' } });
      loadAnnouncements();
    }
  } catch (err) { setStatus(annStatus, err.message, 'error'); }
});

// ---------- Documents ----------
const docForm = document.getElementById('document-form');
const docStatus = document.getElementById('document-status');
const docList = document.getElementById('document-list');

async function loadDocuments() {
  try {
    const docs = await api('/documents');
    docList.innerHTML = docs.length ? docs.map(d => `
      <li>
        <div><strong>${esc(d.title)}</strong>
          <div class="doc-meta">${esc(d.category)}, ${formatSize(d.size_bytes)}, ${formatDate(d.created_at)}</div></div>
        <button class="btn btn-danger btn-sm" data-delete-doc="${d.id}">Delete</button>
      </li>`).join('') : '<li class="empty">No documents uploaded yet.</li>';
  } catch (e) { docList.innerHTML = `<li class="empty">${esc(e.message)}</li>`; }
}

docForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(docForm);
  const file = f.get('file');
  if (!file?.size) return setStatus(docStatus, 'Choose a file to upload.', 'error');
  const btn = docForm.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    setStatus(docStatus, 'Uploading…');
    const { id, uploadUrl } = await api('/documents', { method: 'POST', auth: true, body: {
      title: f.get('title'), category: f.get('category'), description: f.get('description'),
      filename: file.name, contentType: file.type, size: file.size,
    } });
    const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
    if (!put.ok) throw new Error('The file upload to storage failed. Try again.');
    await api(`/documents/${id}/complete`, { method: 'POST', auth: true });
    docForm.reset();
    setStatus(docStatus, `Uploaded "${f.get('title')}".`, 'ok');
    loadDocuments();
  } catch (err) { setStatus(docStatus, err.message, 'error'); }
  finally { btn.disabled = false; }
});

docList.addEventListener('click', async (e) => {
  const del = e.target.closest('[data-delete-doc]');
  if (!del || !confirm('Delete this document? Members will no longer be able to download it.')) return;
  try {
    await api(`/documents/${del.dataset.deleteDoc}`, { method: 'DELETE', auth: true });
    loadDocuments();
  } catch (err) { setStatus(docStatus, err.message, 'error'); }
});

// ---------- Subscribers ----------
async function loadSubscribers() {
  const body = document.getElementById('subscriber-rows');
  const count = document.getElementById('subscriber-count');
  try {
    const rows = await api('/subscribers', { auth: true });
    const active = rows.filter(r => r.status === 'active').length;
    count.textContent = `${active} active of ${rows.length} total`;
    body.innerHTML = rows.map(r => `
      <tr><td>${esc(r.email)}</td><td>${esc(r.name || '')}</td><td>${esc(r.status)}</td><td>${formatDate(r.created_at)}</td></tr>`).join('');
  } catch (e) { count.textContent = e.message; }
}
