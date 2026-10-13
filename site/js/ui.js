// Small shared helpers used by every page.
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

export function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = Number(bytes);
  if (!n) return '';
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function fileKind(type) {
  if (type === 'application/pdf') return 'PDF';
  if (type?.includes('word')) return 'Word';
  if (type?.includes('sheet') || type?.includes('excel')) return 'Excel';
  if (type?.startsWith('image/')) return 'Image';
  return 'File';
}

export function setStatus(el, message, kind = 'info') {
  el.className = `status ${kind}`;
  el.textContent = message;
  if (message) el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
}

export function renderAnnouncement(a, headingTag = 'h3') {
  return `
    <${headingTag}>${esc(a.title)}${a.pinned ? '<span class="pin-tag">Pinned</span>' : ''}</${headingTag}>
    <time datetime="${esc(a.created_at)}">${formatDate(a.created_at)}</time>
    <div class="body">${esc(a.body)}</div>`;
}

// Fill in the association name and year anywhere they appear
document.querySelectorAll('[data-hoa-name]').forEach(el => { el.textContent = window.HOA_CONFIG.hoaName; });
document.querySelectorAll('[data-year]').forEach(el => { el.textContent = new Date().getFullYear(); });
