// Board sign-in with HTTP Basic auth.
// The username and password are kept in this browser tab only (sessionStorage),
// sent over HTTPS with each admin request, and cleared on sign-out or when the tab closes.
const KEY = 'hoa_basic_auth';

export function setCredentials(username, password) {
  const bytes = new TextEncoder().encode(`${username.trim()}:${password}`);
  sessionStorage.setItem(KEY, btoa(String.fromCharCode(...bytes)));
}
export function clearCredentials() { sessionStorage.removeItem(KEY); }
export function authHeader() {
  const v = sessionStorage.getItem(KEY);
  return v ? `Basic ${v}` : null;
}
