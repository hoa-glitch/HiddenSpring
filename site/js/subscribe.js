import { api } from './api.js';
import { setStatus } from './ui.js';

const form = document.getElementById('subscribe-form');
const status = document.getElementById('subscribe-status');

// Handle the confirmation link from the email: subscribe.html?confirm=<token>
const confirmToken = new URLSearchParams(location.search).get('confirm');
if (confirmToken) {
  form.hidden = true;
  setStatus(status, 'Confirming your subscription…');
  try {
    await api('/subscribe/confirm', { method: 'POST', body: { token: confirmToken } });
    setStatus(status, "You're subscribed. New announcements will arrive in your inbox.", 'ok');
  } catch (e) {
    setStatus(status, e.message, 'error');
    form.hidden = false;
  }
  history.replaceState({}, '', location.pathname);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = form.querySelector('button[type="submit"]');
  const data = Object.fromEntries(new FormData(form));
  btn.disabled = true;
  try {
    await api('/subscribe', { method: 'POST', body: data });
    form.reset();
    setStatus(status, `Check ${data.email} for a confirmation link. You'll start getting emails once you click it.`, 'ok');
  } catch (err) {
    setStatus(status, err.message, 'error');
  } finally { btn.disabled = false; }
});
