// "Forgot your password?" for board members.
//   reset-password.html             -> ask for a reset link by email
//   reset-password.html?token=...   -> choose a new password with that link
import { api } from './api.js';
import { setStatus } from './ui.js';

const status = document.getElementById('reset-status');
const requestForm = document.getElementById('request-form');
const newForm = document.getElementById('new-password-form');

const token = new URLSearchParams(location.search).get('token');
if (token) {
  // Take the token out of the address bar right away so it isn't left in history or shared by accident.
  history.replaceState({}, '', location.pathname);
  requestForm.hidden = true;
  newForm.hidden = false;
}

requestForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const login = requestForm.login.value.trim();
  const btn = requestForm.querySelector('button');
  btn.disabled = true;
  setStatus(status, 'Sending…');
  try {
    await api('/account/forgot', { method: 'POST', body: { login } });
    requestForm.hidden = true;
    setStatus(status, "If that login has an email address on file, we've sent it a reset link. It works once and expires in 1 hour. Check your spam folder if it doesn't arrive in a few minutes.", 'ok');
  } catch (err) { setStatus(status, err.message, 'error'); }
  finally { btn.disabled = false; }
});

newForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = newForm.newPassword.value;
  if (pw !== newForm.confirmPassword.value) return setStatus(status, "The passwords don't match.", 'error');
  const btn = newForm.querySelector('button');
  btn.disabled = true;
  try {
    const { username } = await api('/account/reset', { method: 'POST', body: { token, newPassword: pw } });
    newForm.hidden = true;
    document.getElementById('reset-foot').hidden = true;
    status.className = 'status ok';
    status.setAttribute('role', 'status');
    status.innerHTML = `Your password is changed. <a href="admin.html">Sign in</a> as <strong></strong> with your new password.`;
    status.querySelector('strong').textContent = username;
  } catch (err) {
    setStatus(status, err.message, 'error');
    // An expired or used link can't be retried; offer a new one instead.
    if (/expired|already used|incomplete/.test(err.message)) { newForm.hidden = true; requestForm.hidden = false; }
  } finally { btn.disabled = false; }
});
