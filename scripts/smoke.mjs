import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Local-only runtime verification. No production writes or credential output.
const base = 'http://localhost:8788';
const vars = await readFile('.dev.vars', 'utf8');
const password = vars.match(/^ADMIN_PASSWORD="([^"]+)"/m)?.[1];
assert.ok(password, 'Run npm run setup first');
let cookie = '';
async function call(path, method = 'GET', body, token) {
  const headers = { Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  return fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
}
assert.equal((await call('/admin')).status, 302);
const login = await call('/api/auth/login', 'POST', { password });
assert.equal(login.status, 200); cookie = login.headers.get('set-cookie').split(';')[0];
assert.equal((await call('/admin')).status, 200);
const original = await (await call('/api/admin/settings')).json();
let id;
try {
  const saved = { ...original, githubToken: 'local-smoke-test-token' };
  assert.equal((await call('/api/admin/settings', 'PUT', saved)).status, 200);
  assert.deepEqual(await (await call('/api/admin/settings')).json(), saved);
  assert.equal((await call('/api/admin/settings', 'PUT', original)).status, 200);
  console.log('PASS: local runtime login, protected admin and saved secret retrieval');
  const created = await call('/api/admin/keys', 'POST', { name: 'Local smoke test', expiresAt: new Date(Date.now() + 120000).toISOString() });
  assert.equal(created.status, 201); const key = await created.json(); id = key.key.id;
  const path = '/api/latest?repo=notepad-plus-plus/notepad-plus-plus';
  assert.equal((await call(path)).status, 401);
  const release = await call(path, 'GET', undefined, key.apiKey);
  const result = await release.json();
  assert.equal(release.status, 200, JSON.stringify(result));
  assert.equal(result.arch, 'x64'); assert.match(result.url, /^https:\/\/github\.com\//); assert.match(result.filename, /\.exe$/i);
  console.log(`PASS: live GitHub release ${result.version}, ${result.filename}`);
  await call(`/api/admin/keys/${id}`, 'PATCH', { enabled: false });
  assert.equal((await call(path, 'GET', undefined, key.apiKey)).status, 403);
  console.log('PASS: API key enforcement, cached release and disabled key');
} finally {
  if (id) await call(`/api/admin/keys/${id}`, 'DELETE');
  await call('/api/admin/settings', 'PUT', original);
  await call('/api/auth/logout', 'POST');
}
