import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, type Env, type Store } from '../src/app';
import { hash, decrypt } from '../src/crypto';
import { normalizeRepo, selectAsset, type Asset } from '../src/releases';

class MemoryKV implements Store {
  data = new Map<string, string>();
  async get(key: string) { return this.data.get(key) ?? null; }
  async put(key: string, value: string) { this.data.set(key, value); }
  async delete(key: string) { this.data.delete(key); }
  async list(options: { prefix: string; cursor?: string }) {
    const keys = [...this.data.keys()].filter(key => key.startsWith(options.prefix)).sort();
    const offset = Number(options.cursor || 0); const end = offset + 2;
    return { keys: keys.slice(offset, end).map(name => ({ name })), list_complete: end >= keys.length, cursor: String(end) };
  }
}
const NOW = Date.parse('2026-09-13T00:00:00Z');
const origin = 'https://releases.example';
function fixture() {
  const kv = new MemoryKV(); const env: Env = { APP_KV: kv, ADMIN_PASSWORD: 'a-long-test-password', MASTER_KEY: btoa('m'.repeat(32)) };
  let now = NOW; let mode = 200; let calls = 0; let privateRepo = false;
  const assets = [{ name: 'App-win-x64.exe', browser_download_url: 'https://github.com/test/app/releases/download/v1/App-win-x64.exe', size: 10, state: 'uploaded' }];
  const fetcher = (async (input: string | URL | Request) => {
    calls++;
    if (mode !== 200) return new Response('{}', { status: mode, headers: { 'Retry-After': '120' } });
    return new Response(JSON.stringify(String(input).endsWith('/releases/latest') ? { tag_name: 'v1', assets, draft: false, prerelease: false } : { private: privateRepo }));
  }) as typeof fetch;
  async function request(path: string, method = 'GET', data?: unknown, options: { cookie?: string; token?: string; origin?: string; now?: number } = {}) {
    const headers: Record<string, string> = {};
    if (method !== 'GET') headers.Origin = options.origin ?? origin;
    if (data !== undefined) headers['Content-Type'] = 'application/json';
    if (options.cookie) headers.Cookie = options.cookie;
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    return handle(new Request(origin + path, { method, headers, body: data === undefined ? undefined : JSON.stringify(data) }), env, async () => new Response('ADMIN CONTENT'), { now: () => options.now ?? now, fetcher });
  }
  async function login() {
    const response = await request('/api/auth/login', 'POST', { password: env.ADMIN_PASSWORD });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie')!.split(';')[0];
  }
  async function key(cookie: string, overrides = {}) {
    const response = await request('/api/admin/keys', 'POST', { name: 'test', expiresAt: new Date(NOW + 86400000).toISOString(), ...overrides }, { cookie });
    assert.equal(response.status, 201); return response.json() as Promise<{ apiKey: string; key: { id: string } }>;
  }
  return { kv, env, request, login, key, assets, setNow: (value: number) => { now = value; }, setMode: (value: number) => { mode = value; }, setPrivate: () => { privateRepo = true; }, calls: () => calls };
}

test('admin page and all secret endpoints require login; static page remains accessible', async () => {
  const f = fixture();
  for (const path of ['/admin', '/admin.html', '/admin/', '/admin/anything']) { const res = await f.request(path); assert.equal(res.status, 302); assert.equal(res.headers.get('location'), '/'); }
  for (const path of ['/api/admin/settings', '/api/admin/keys', '/api/admin/rules']) assert.equal((await f.request(path)).status, 401);
  assert.equal((await f.request('/')).status, 200);
});
test('configuration accepts a six-character admin password and rejects shorter values', async () => {
  const valid = fixture(); valid.env.ADMIN_PASSWORD = '123456';
  assert.equal((await valid.request('/api/auth/login', 'POST', { password: '123456' })).status, 200);
  const invalid = fixture(); invalid.env.ADMIN_PASSWORD = '12345';
  const response = await invalid.request('/api/auth/login', 'POST', { password: '12345' });
  assert.equal(response.status, 503);
  assert.equal((await response.json() as any).error.code, 'NOT_CONFIGURED');
});
test('login issues secure cookie, rejects wrong password and locks repeated failures', async () => {
  const f = fixture();
  const ok = await f.request('/api/auth/login', 'POST', { password: f.env.ADMIN_PASSWORD });
  assert.match(ok.headers.get('set-cookie')!, /HttpOnly; Secure; SameSite=Strict/);
  for (let i = 0; i < 5; i++) assert.equal((await f.request('/api/auth/login', 'POST', { password: 'bad' })).status, 401);
  assert.equal((await f.request('/api/auth/login', 'POST', { password: 'bad' })).status, 429);
});
test('CSRF origin verification on login, settings and logout', async () => {
  const f = fixture(); const cookie = await f.login();
  for (const path of ['/api/auth/login', '/api/auth/logout', '/api/admin/settings']) assert.equal((await f.request(path, 'POST', {}, { cookie, origin: 'https://evil.example' })).status, 403);
});
test('saved secrets decrypt for administrator only, are encrypted in KV and never cacheable', async () => {
  const f = fixture(); const cookie = await f.login();
  const original = await (await f.request('/api/admin/settings', 'GET', undefined, { cookie })).json() as { signingKey: string };
  const config = { signingKey: original.signingKey, githubToken: 'github_pat_test_secret' };
  assert.equal((await f.request('/api/admin/settings', 'PUT', config, { cookie })).status, 200);
  const stored = f.kv.data.get('settings:v1')!;
  assert.ok(!stored.includes(config.githubToken)); assert.ok(!stored.includes(config.signingKey));
  assert.deepEqual(await decrypt(stored, f.env.MASTER_KEY), config);
  const response = await f.request('/api/admin/settings', 'GET', undefined, { cookie });
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.deepEqual(await response.json(), config);
  assert.equal((await f.request('/api/admin/settings')).status, 401);
});
test('signing key rotation invalidates old sessions; password login works with new key', async () => {
  const f = fixture(); const cookie = await f.login();
  const res = await f.request('/api/admin/settings', 'PUT', { signingKey: 'new-signing-key-'.repeat(3), githubToken: '' }, { cookie });
  assert.equal((await res.json() as { relogin: boolean }).relogin, true);
  assert.equal((await f.request('/api/admin/settings', 'GET', undefined, { cookie })).status, 401);
  assert.equal((await f.request('/admin', 'GET', undefined, { cookie: await f.login() })).status, 200);
});
test('tampered and expired session rejected; logout clears browser cookie', async () => {
  const f = fixture(); const cookie = await f.login();
  assert.equal((await f.request('/admin', 'GET', undefined, { cookie: cookie + 'bad' })).status, 302);
  assert.equal((await f.request('/admin', 'GET', undefined, { cookie, now: NOW + 8 * 3600000 })).status, 302);
  assert.match((await f.request('/api/auth/logout', 'POST', undefined, { cookie })).headers.get('set-cookie')!, /Max-Age=0/);
});
test('API keys are stored as hashes and omitted from paginated lists', async () => {
  const f = fixture(); const cookie = await f.login(); const keys = [];
  for (let i = 0; i < 5; i++) keys.push(await f.key(cookie));
  const res = await f.request('/api/admin/keys', 'GET', undefined, { cookie }); const text = await res.text();
  assert.equal(JSON.parse(text).keys.length, 5);
  for (const key of keys) { assert.ok(!text.includes(key.apiKey)); assert.ok(f.kv.data.has(`key:${await hash(key.apiKey)}`)); assert.ok(![...f.kv.data.values()].join('').includes(key.apiKey)); }
});
test('API authentication precedes cache read and GitHub request', async () => {
  const f = fixture(); const cookie = await f.login(); const key = await f.key(cookie);
  assert.equal((await f.request('/api/latest?repo=test/app')).status, 401); assert.equal(f.calls(), 0);
  assert.equal((await f.request('/api/latest?repo=test/app', 'GET', undefined, { token: key.apiKey })).status, 200);
  assert.equal((await f.request('/api/latest?repo=test/app')).status, 401); assert.equal(f.calls(), 2);
});
test('access start and expiry boundaries enforced even with a populated cache', async () => {
  const f = fixture(); const cookie = await f.login(); const key = await f.key(cookie, { startsAt: new Date(NOW + 1000).toISOString(), expiresAt: new Date(NOW + 2000).toISOString() });
  const call = (now: number) => f.request('/api/latest?repo=test/app', 'GET', undefined, { token: key.apiKey, now });
  assert.equal((await (await call(NOW)).json() as any).error.code, 'API_KEY_NOT_ACTIVE');
  assert.equal((await call(NOW + 1000)).status, 200);
  assert.equal((await call(NOW + 1999)).status, 200);
  assert.equal((await (await call(NOW + 2000)).json() as any).error.code, 'API_KEY_EXPIRED'); assert.equal(f.calls(), 2);
});
test('disable, reenable and delete a key', async () => {
  const f = fixture(); const cookie = await f.login(); const key = await f.key(cookie); const path = `/api/admin/keys/${key.key.id}`;
  await f.request(path, 'PATCH', { enabled: false }, { cookie });
  assert.equal((await f.request('/api/latest?repo=test/app', 'GET', undefined, { token: key.apiKey })).status, 403);
  await f.request(path, 'PATCH', { enabled: true }, { cookie });
  assert.equal((await f.request('/api/latest?repo=test/app', 'GET', undefined, { token: key.apiKey })).status, 200);
  await f.request(path, 'DELETE', undefined, { cookie });
  assert.equal((await f.request('/api/latest?repo=test/app', 'GET', undefined, { token: key.apiKey })).status, 401);
});
test('invalid validity ranges and timezone-free dates rejected', async () => {
  const f = fixture(); const cookie = await f.login();
  for (const expiresAt of ['bad', '2026-09-15T00:00:00', new Date(NOW - 1).toISOString()]) assert.equal((await f.request('/api/admin/keys', 'POST', { name: 'test', expiresAt }, { cookie })).status, 400);
});
test('fresh cache avoids upstream calls; stale fallback has retry backoff and hard age limit', async () => {
  const f = fixture(); const cookie = await f.login(); const key = await f.key(cookie, { expiresAt: new Date(NOW + 3 * 86400000).toISOString() });
  const call = () => f.request('/api/latest?repo=test/app', 'GET', undefined, { token: key.apiKey });
  assert.equal((await call()).status, 200); assert.equal((await call()).status, 200); assert.equal(f.calls(), 2);
  f.setNow(NOW + 3600000); f.setMode(429);
  const stale = await (await call()).json() as any; assert.equal(stale.stale, true); assert.equal(stale.checked_at, new Date(NOW).toISOString());
  const calls = f.calls(); assert.equal((await call()).status, 200); assert.equal(f.calls(), calls);
  f.setNow(NOW + 86400000); assert.equal((await call()).status, 503);
});
test('404 invalidates previous cached release and negatively caches absence', async () => {
  const f = fixture(); const cookie = await f.login(); const key = await f.key(cookie);
  const call = () => f.request('/api/latest?repo=test/app', 'GET', undefined, { token: key.apiKey });
  await call(); f.setNow(NOW + 3600000); f.setMode(404);
  assert.equal((await call()).status, 404); const count = f.calls(); assert.equal((await call()).status, 404); assert.equal(f.calls(), count);
});
test('private repositories never expose releases even with a privileged token', async () => {
  const f = fixture(); f.setPrivate(); const cookie = await f.login();
  assert.equal((await f.request('/api/admin/resolve?repo=test/app', 'POST', undefined, { cookie })).status, 404); assert.equal(f.calls(), 1);
});
test('admin force refresh bypasses cache; rules apply to existing cached assets', async () => {
  const f = fixture(); const cookie = await f.login(); f.assets.push({ ...f.assets[0], name: 'App-win-x64-portable.exe' });
  const path = '/api/admin/resolve?repo=test/app';
  assert.equal((await f.request(path, 'POST', undefined, { cookie })).status, 409);
  await f.request('/api/admin/rules', 'PUT', { repo: 'Test/App', patterns: { x64: '*portable.exe' } }, { cookie });
  assert.equal((await (await f.request(path, 'POST', undefined, { cookie })).json() as any).filename, 'App-win-x64-portable.exe'); assert.equal(f.calls(), 2);
  assert.equal((await f.request(path + '&refresh=1', 'POST', undefined, { cookie })).status, 200); assert.equal(f.calls(), 4);
  await f.request('/api/admin/rules?repo=test/app', 'DELETE', undefined, { cookie });
  assert.equal((await f.request(path, 'POST', undefined, { cookie })).status, 409);
});
test('sensitive endpoints reject unsupported methods and excessive body', async () => {
  const f = fixture(); const cookie = await f.login();
  assert.equal((await f.request('/api/admin/settings', 'DELETE', undefined, { cookie })).status, 405);
  assert.equal((await f.request('/api/admin/settings', 'PUT', { githubToken: 'x'.repeat(17000) }, { cookie })).status, 413);
  assert.equal((await f.request('/api/admin/settings', 'PUT', { githubToken: '', signingKey: 'short' }, { cookie })).status, 400);
});
test('repo normalization prevents SSRF and accepts URL, .git and owner/repo', () => {
  assert.equal(normalizeRepo('https://github.com/Owner/Repo.git/'), 'owner/repo');
  assert.equal(normalizeRepo('Owner/Repo'), 'owner/repo');
  for (const input of ['https://evil.example/a/b', 'https://github.com@evil.example/a/b', 'https://github.com/a/b?x=1', 'a/b/releases', '../x', 'http://github.com/a/b', 'https://github.com/a/b#x']) assert.throws(() => normalizeRepo(input));
});
const asset = (name: string): Asset => ({ name, browser_download_url: 'https://github.com/test/app/releases/download/v1/' + name, size: 1 });
test('selection distinguishes architectures, installer type, symbols and source files', () => {
  const assets = ['app-linux-x64.zip', 'app-win-arm64.exe', 'app-win-x64-symbols.zip', 'app-win-x64.msi', 'app-win-x64.exe', 'app-win-x86.exe', 'app-win-x64-source.zip'].map(asset);
  assert.equal(selectAsset(assets, 'x64').name, 'app-win-x64.exe');
  assert.equal(selectAsset(assets, 'arm64').name, 'app-win-arm64.exe');
  assert.equal(selectAsset(assets, 'x86').name, 'app-win-x86.exe');
  assert.equal(selectAsset([asset('app-windows-x86_64.zip')], 'x64').name, 'app-windows-x86_64.zip');
});
test('unknown architecture needs explicit rule; ambiguous assets never guessed', () => {
  assert.throws(() => selectAsset([asset('setup.exe')], 'x64'), /没有/);
  assert.equal(selectAsset([asset('setup.exe')], 'x64', 'setup.exe').name, 'setup.exe');
  assert.throws(() => selectAsset([asset('a-win-x64.exe'), asset('b-win-x64.exe')], 'x64'), /多个/);
  assert.throws(() => selectAsset([asset('app-arm64.exe')], 'x64', '*'), /没有/);
  assert.throws(() => selectAsset([asset('source.zip')], 'x64', '*'), /没有/);
});
