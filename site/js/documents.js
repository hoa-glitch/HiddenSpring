import { api } from './api.js';
import { esc, formatDate, formatSize, fileKind } from './ui.js';

const container = document.getElementById('doc-groups');
const search = document.getElementById('doc-search');
const categoryFilter = document.getElementById('doc-category');
let docs = [];

function render() {
  const q = search.value.trim().toLowerCase();
  const cat = categoryFilter.value;
  const shown = docs.filter(d =>
    (!cat || d.category === cat) &&
    (!q || `${d.title} ${d.description || ''} ${d.filename}`.toLowerCase().includes(q)));

  if (!shown.length) {
    container.innerHTML = `<p class="empty">${docs.length ? 'No documents match your search.' : 'No documents have been posted yet.'}</p>`;
    return;
  }
  const groups = shown.reduce((acc, d) => ((acc[d.category] ||= []).push(d), acc), {});
  container.innerHTML = Object.entries(groups).map(([name, list]) => `
    <section class="doc-group" aria-labelledby="g-${esc(name)}">
      <h2 id="g-${esc(name)}">${esc(name)}</h2>
      <ul class="doc-list">
        ${list.map(d => `
          <li>
            <div>
              <div class="doc-title">${esc(d.title)}</div>
              ${d.description ? `<div>${esc(d.description)}</div>` : ''}
              <div class="doc-meta">${fileKind(d.content_type)} ${formatSize(d.size_bytes) ? `(${formatSize(d.size_bytes)})` : ''}, posted ${formatDate(d.created_at)}</div>
            </div>
            <button class="btn btn-sm" data-download="${d.id}">Download</button>
          </li>`).join('')}
      </ul>
    </section>`).join('');
}

container.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-download]');
  if (!btn) return;
  btn.disabled = true; btn.textContent = 'Preparing…';
  try {
    const { url } = await api(`/documents/${btn.dataset.download}/download`);
    window.location.assign(url);   // short-lived signed S3 link
    btn.textContent = 'Download';
  } catch (err) {
    btn.textContent = 'Try again';
    alert(err.message);
  } finally { btn.disabled = false; }
});

search.addEventListener('input', render);
categoryFilter.addEventListener('change', render);

try {
  docs = await api('/documents');
  const cats = [...new Set(docs.map(d => d.category))].sort();
  categoryFilter.insertAdjacentHTML('beforeend', cats.map(c => `<option>${esc(c)}</option>`).join(''));
  render();
} catch (e) {
  container.innerHTML = `<p class="empty">${esc(e.message)}</p>`;
}
