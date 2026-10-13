import { api } from './api.js';
import { esc, formatDate } from './ui.js';

const notice = document.getElementById('latest-notice');
try {
  const [latest] = await api('/announcements?limit=1');
  if (latest) {
    notice.innerHTML = `
      <h2>${esc(latest.title)}</h2>
      <time datetime="${esc(latest.created_at)}">Posted ${formatDate(latest.created_at)}</time>
      <p>${esc(latest.body.length > 360 ? latest.body.slice(0, 360).trimEnd() + '…' : latest.body)}</p>
      <a href="announcements.html#a-${latest.id}">Read the full notice</a>`;
  } else {
    notice.innerHTML = `<h2>No notices right now</h2><p>New board announcements will be posted here.</p>`;
  }
} catch (e) {
  notice.innerHTML = `<h2>Latest notice</h2><p>${esc(e.message)}</p><a href="announcements.html">See all announcements</a>`;
}
