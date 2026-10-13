import { api } from './api.js';
import { setStatus } from './ui.js';

const form = document.getElementById('unsubscribe-form');
const status = document.getElementById('unsubscribe-status');
const token = new URLSearchParams(location.search).get('token');

if (token) {
  // Came from the link in an email: ask once, then unsubscribe.
  form.hidden = true;
  const confirmBox = document.getElementById('token-confirm');
  confirmBox.hidden = false;
  confirmBox.querySelector('button').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api('/unsubscribe', { method: 'POST', body: { token } });
      confirmBox.hidden = true;
      setStatus(status, "You're unsubscribed and won't get HOA emails anymore. You can subscribe again anytime.", 'ok');
    } catch (err) {
      setStatus(status, err.message, 'error');
      e.target.disabled = false;
    }
  });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = new FormData(form).get('email');
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    await api('/unsubscribe', { method: 'POST', body: { email } });
    setStatus(status, `If ${email} is on the list, we've sent it a link to unsubscribe.`, 'ok');
    form.reset();
  } catch (err) {
    setStatus(status, err.message, 'error');
  } finally { btn.disabled = false; }
});
