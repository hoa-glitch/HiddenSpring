// Board members tab: list logins, add, remove, reset passwords, change your own password.
import { api } from './api.js';
import { setCredentials } from './auth.js';
import { esc, formatDate, setStatus } from './ui.js';

const $ = id => document.getElementById(id);
let getUser = () => '';

function when(iso) { return iso ? formatDate(iso) : 'Never'; }

function showTempPassword(title, password) {
  $('temp-password-title').textContent = title;
  $('temp-password-value').textContent = password;
  $('temp-password-copy').textContent = 'Copy';
  $('temp-password-box').hidden = false;
  $('temp-password-box').scrollIntoView({ block: 'nearest' });
}

export async function loadBoardUsers() {
  const rows = $('board-rows');
  try {
    const { me, users, log } = await api('/board-users', { auth: true });
    rows.innerHTML = users.map(u => {
      const isMe = u.username === me;
      const actions = u.source === 'aws'
        ? '<span class="doc-meta">Recovery login</span>'
        : isMe
          ? '<span class="doc-meta">You</span>'
          : `<button type="button" class="btn btn-quiet btn-sm" data-reset="${esc(u.username)}">Reset password</button>
             <button type="button" class="btn btn-danger btn-sm" data-remove="${esc(u.username)}">Remove</button>`;
      return `<tr>
        <td><strong>${esc(u.username)}</strong>${isMe && u.source === 'aws' ? ' <span class="doc-meta">(you)</span>' : ''}
          ${u.must_change_password ? '<br><span class="doc-meta">Temporary password</span>' : ''}</td>
        <td>${u.source === 'aws' ? '<span class="doc-meta">AWS settings</span>' : `${esc(formatDate(u.created_at))}<br><span class="doc-meta">by ${esc(u.created_by)}</span>`}</td>
        <td>${u.source === 'aws' ? '<span class="doc-meta">Not tracked</span>' : esc(when(u.last_sign_in_at))}</td>
        <td class="board-actions">${actions}</td>
      </tr>`;
    }).join('');
    $('board-log').innerHTML = log.length
      ? log.map(l => `<li><span><strong>${esc(l.actor)}</strong> ${esc(l.action)}${l.target ? ` <strong>${esc(l.target)}</strong>` : ''}</span>
          <span class="doc-meta">${esc(formatDate(l.created_at))}</span></li>`).join('')
      : '<li class="empty">No changes yet.</li>';
  } catch (e) {
    rows.innerHTML = `<tr><td colspan="4">${esc(e.message)}</td></tr>`;
  }
}

let ready = false;
export function initBoardUsers(currentUser) {
  if (ready) return;
  ready = true;
  getUser = currentUser;
  const status = $('board-status');

  $('add-board-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      const { username, temporaryPassword } = await api('/board-users', {
        method: 'POST', auth: true, body: { username: form.username.value },
      });
      form.reset();
      setStatus(status, '');
      showTempPassword(`Added ${username}`, temporaryPassword);
      loadBoardUsers();
    } catch (err) { setStatus(status, err.message, 'error'); }
    finally { btn.disabled = false; }
  });

  $('change-password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const pw = form.newPassword.value;
    if (pw !== form.confirmPassword.value) return setStatus(status, "The passwords don't match.", 'error');
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await api('/account/password', { method: 'POST', auth: true, body: { newPassword: pw } });
      setCredentials(getUser(), pw);   // keep this browser tab signed in with the new password
      form.reset();
      setStatus(status, 'Your password is changed. Use the new one next time you sign in.', 'ok');
      loadBoardUsers();
    } catch (err) { setStatus(status, err.message, 'error'); }
    finally { btn.disabled = false; }
  });

  $('panel-board').addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    try {
      if (t.dataset.remove) {
        const u = t.dataset.remove;
        if (!confirm(`Remove ${u}'s board login? They won't be able to sign in to the board tools.`)) return;
        t.disabled = true;
        await api(`/board-users/${encodeURIComponent(u)}`, { method: 'DELETE', auth: true });
        setStatus(status, `Removed ${u}.`, 'ok');
        loadBoardUsers();
      } else if (t.dataset.reset) {
        const u = t.dataset.reset;
        if (!confirm(`Reset ${u}'s password? Their current password stops working right away.`)) return;
        t.disabled = true;
        const { temporaryPassword } = await api(`/board-users/${encodeURIComponent(u)}/reset`, { method: 'POST', auth: true });
        setStatus(status, '');
        showTempPassword(`New temporary password for ${u}`, temporaryPassword);
        loadBoardUsers();
      } else if (t.id === 'temp-password-copy') {
        await navigator.clipboard.writeText($('temp-password-value').textContent);
        t.textContent = 'Copied';
      } else if (t.id === 'temp-password-done') {
        $('temp-password-value').textContent = '';
        $('temp-password-box').hidden = true;
      }
    } catch (err) {
      setStatus(status, err.message, 'error');
      t.disabled = false;
    }
  });
}
