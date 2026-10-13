// Thin wrapper around fetch for the HOA API.
import { authHeader, clearCredentials } from './auth.js';

const BASE = window.HOA_CONFIG.apiBaseUrl.replace(/\/$/, '');

export async function api(path, { method = 'GET', body, auth = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) {
    const h = authHeader();
    if (!h) throw new Error('Sign in to continue.');
    headers.Authorization = h;
  }

  let res;
  try {
    res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new Error("Couldn't reach the server. Check your connection and try again.");
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && auth) clearCredentials();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}
