import { api } from './api.js';
import { renderAnnouncement, esc } from './ui.js';

const feed = document.getElementById('feed');
try {
  const items = await api('/announcements');
  feed.innerHTML = items.length
    ? items.map(a => `<li id="a-${a.id}">${renderAnnouncement(a)}</li>`).join('')
    : `<li class="empty">No announcements yet. <a href="subscribe.html">Subscribe</a> to get new ones by email.</li>`;
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
} catch (e) {
  feed.innerHTML = `<li class="empty">${esc(e.message)}</li>`;
}
