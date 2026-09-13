import { decrypt, encrypt, hash, randomSecret, sign, verify } from './crypto';
import { ApiError, fetchRelease, normalizeRepo, parseArch, selectAsset, type Release, type Rule } from './releases';

export interface Store {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
}
export interface Env { APP_KV: Store; ADMIN_PASSWORD: string; MASTER_KEY: string }
interface Settings { signingKey: string; githubToken: string }
interface AccessKey { id: string; name: string; startsAt: number; expiresAt: number; enabled: boolean; createdAt: number }
interface Cached { release?: Release; error?: { code: string; message: string }; checkedAt: number; retryAt?: number }
interface Dependencies { now?: () => number; fetcher?: typeof fetch }
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const COOKIE = 'release_session';
const securityHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}
function cookie(value: string, maxAge = 8 * 3600) { return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`; }
function requireMethod(request: Request, method: string) { if (request.method !== method) throw new ApiError(405, 'METHOD_NOT_ALLOWED', `请使用 ${method}`); }
async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new ApiError(415, 'INVALID_CONTENT_TYPE', '请求体必须是 JSON');
  const reader = request.body?.getReader();
  let raw = ''; let length = 0; const decoder = new TextDecoder();
  if (reader) {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 16_384) { await reader.cancel(); throw new ApiError(413, 'BODY_TOO_LARGE', '请求体过大'); }
      raw += decoder.decode(chunk.value, { stream: true });
    }
    raw += decoder.decode();
  }
  try { const value = JSON.parse(raw); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); return value; }
  catch { throw new ApiError(400, 'INVALID_JSON', '请求体必须是 JSON 对象'); }
}
function string(value: unknown, name: string, min: number, max: number) {
  if (typeof value !== 'string' || value.length < min || value.length > max) throw new ApiError(400, 'INVALID_INPUT', `${name} 长度必须为 ${min}–${max} 个字符`);
  return value;
}
function date(value: unknown, name: string): number {
  if (typeof value !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new ApiError(400, 'INVALID_TIME', `${name} 必须是带时区的 ISO 时间`);
  return Date.parse(value);
}
async function read<T>(kv: Store, key: string): Promise<T | null> { const value = await kv.get(key); return value ? JSON.parse(value) as T : null; }
async function list<T>(kv: Store, prefix: string): Promise<T[]> {
  const result: T[] = []; let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix, cursor, limit: 100 });
    const values = await Promise.all(page.keys.map(key => read<T>(kv, key.name)));
    for (const value of values) if (value !== null) result.push(value);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return result;
}
async function settings(env: Env): Promise<Settings> {
  const saved = await env.APP_KV.get('settings:v1');
  return saved ? decrypt<Settings>(saved, env.MASTER_KEY) : { signingKey: await sign('initial-session-key:v1', env.MASTER_KEY), githubToken: '' };
}
async function authenticated(request: Request, config: Settings, now: number) {
  const value = request.headers.get('cookie')?.split(';').map(v => v.trim()).find(v => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!value) return false;
  const parts = value.split('.');
  if (parts.length !== 3 || !/^\d+$/.test(parts[0]) || Number(parts[0]) <= now || Number(parts[0]) > now + 8 * HOUR) return false;
  return verify(`${parts[0]}.${parts[1]}`, parts[2], config.signingKey);
}
async function authorizeKey(request: Request, env: Env, now: number) {
  const bearer = request.headers.get('authorization')?.match(/^Bearer (gr_[A-Za-z0-9_-]{43})$/);
  if (!bearer) throw new ApiError(401, 'INVALID_API_KEY', '请通过 Authorization: Bearer 提供有效 API Key');
  const key = await read<AccessKey>(env.APP_KV, `key:${await hash(bearer[1])}`);
  if (!key) throw new ApiError(401, 'INVALID_API_KEY', 'API Key 无效');
  if (!key.enabled) throw new ApiError(403, 'API_KEY_DISABLED', 'API Key 已停用');
  if (now < key.startsAt) throw new ApiError(403, 'API_KEY_NOT_ACTIVE', 'API Key 尚未生效');
  if (now >= key.expiresAt) throw new ApiError(403, 'API_KEY_EXPIRED', 'API Key 已到期');
}
async function resolve(request: Request, env: Env, config: Settings, now: number, fetcher: typeof fetch, force = false) {
  const url = new URL(request.url);
  const repo = normalizeRepo(url.searchParams.get('repo'));
  const arch = parseArch(url.searchParams.get('arch'));
  const key = `release:${repo}`;
  const cached = await read<Cached>(env.APP_KV, key);
  let release = cached?.release;
  let stale = false;
  if (!force && cached?.error && now - cached.checkedAt < 300_000) throw new ApiError(404, cached.error.code, cached.error.message);
  const age = release ? now - release.checkedAt : Infinity;
  if (force || age >= HOUR) {
    if (!force && release && age < DAY && cached?.retryAt && cached.retryAt > now) stale = true;
    else {
      try {
        release = await fetchRelease(repo, config.githubToken, fetcher, now);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        if (error.status === 503 && release && age < DAY && !force) {
          stale = true;
          await env.APP_KV.put(key, JSON.stringify({ release, checkedAt: now, retryAt: now + (error.retryAfter || 60) * 1000 }), { expirationTtl: Math.max(60, Math.ceil((DAY - age) / 1000)) });
        } else {
          if (error.status === 404) await env.APP_KV.put(key, JSON.stringify({ error: { code: error.code, message: error.message }, checkedAt: now }), { expirationTtl: 300 });
          throw error;
        }
      }
      if (!stale && release) await env.APP_KV.put(key, JSON.stringify({ release, checkedAt: now }), { expirationTtl: 86400 });
    }
  }
  if (!release) throw new ApiError(503, 'GITHUB_UNAVAILABLE', '暂时无法获取版本');
  const rule = await read<Rule>(env.APP_KV, `rule:${repo}`);
  const asset = selectAsset(release.assets, arch, rule?.patterns[arch]);
  return json({ repo, version: release.version, platform: 'windows', arch, filename: asset.name, url: asset.browser_download_url, size: asset.size, checked_at: new Date(release.checkedAt).toISOString(), stale });
}

export async function handle(request: Request, env: Env, next: () => Promise<Response> = async () => new Response('Not found', { status: 404 }), dependencies: Dependencies = {}): Promise<Response> {
  const now = (dependencies.now || Date.now)(); const fetcher = dependencies.fetcher || fetch;
  const url = new URL(request.url); const path = url.pathname;
  try {
    if (path.startsWith('/api/') || /^\/admin(?:[/.]|$)/i.test(path)) {
      if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 12 || !env.MASTER_KEY) throw new ApiError(503, 'NOT_CONFIGURED', '请先配置 ADMIN_PASSWORD（至少 12 位）和 MASTER_KEY');
    }
    if (path.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method)) {
      if (request.headers.get('origin') !== url.origin) throw new ApiError(403, 'INVALID_ORIGIN', '请求来源不允许');
    }
    if (path === '/api/auth/login') {
      requireMethod(request, 'POST');
      const data = await body(request); const password = string(data.password, '密码', 1, 256);
      // Best-effort local/global KV backoff, not an exact distributed rate limiter.
      const bucket = `login:${await hash(request.headers.get('cf-connecting-ip') || 'local')}`;
      const failures = await read<{ count: number; until: number }>(env.APP_KV, bucket);
      if (failures && failures.until > now && failures.count >= 5) throw new ApiError(429, 'LOGIN_RATE_LIMITED', '尝试次数过多，请 15 分钟后重试', undefined, Math.ceil((failures.until - now) / 1000));
      if (!await verify('admin-password-check', await sign('admin-password-check', password), env.ADMIN_PASSWORD)) {
        await env.APP_KV.put(bucket, JSON.stringify({ count: failures && failures.until > now ? failures.count + 1 : 1, until: now + 900_000 }), { expirationTtl: 900 });
        throw new ApiError(401, 'INVALID_PASSWORD', '密码错误');
      }
      await env.APP_KV.delete(bucket);
      const config = await settings(env); const value = `${now + 8 * HOUR}.${randomSecret()}`;
      return json({ ok: true }, 200, { 'Set-Cookie': cookie(`${value}.${await sign(value, config.signingKey)}`) });
    }
    if (path === '/api/auth/logout') { requireMethod(request, 'POST'); return json({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) }); }
    if (path === '/api/latest') {
      requireMethod(request, 'GET'); await authorizeKey(request, env, now);
      return await resolve(request, env, await settings(env), now, fetcher);
    }
    if (path.startsWith('/api/admin/') || /^\/admin(?:[/.]|$)/i.test(path)) {
      const config = await settings(env);
      if (!await authenticated(request, config, now)) {
        if (!path.startsWith('/api/')) return new Response(null, { status: 302, headers: { ...securityHeaders, Location: '/' } });
        throw new ApiError(401, 'UNAUTHORIZED', '请先登录');
      }
      if (path === '/api/admin/settings') {
        if (request.method === 'GET') return json(config);
        requireMethod(request, 'PUT'); const data = await body(request);
        const updated: Settings = {
          signingKey: string(data.signingKey, '会话签名密钥', 32, 256),
          githubToken: string(data.githubToken, 'GitHub Token', 0, 256).trim(),
        };
        if (/\s/.test(updated.githubToken)) throw new ApiError(400, 'INVALID_INPUT', 'GitHub Token 不能包含空白');
        await env.APP_KV.put('settings:v1', await encrypt(updated, env.MASTER_KEY));
        const changed = updated.signingKey !== config.signingKey;
        return json({ ok: true, relogin: changed }, 200, changed ? { 'Set-Cookie': cookie('', 0) } : {});
      }
      if (path === '/api/admin/keys') {
        if (request.method === 'GET') return json({ keys: (await list<AccessKey>(env.APP_KV, 'key:')).sort((a, b) => b.createdAt - a.createdAt) });
        requireMethod(request, 'POST'); const data = await body(request);
        const name = string(data.name, '名称', 1, 80).trim(); if (!name) throw new ApiError(400, 'INVALID_INPUT', '名称不能为空');
        const startsAt = data.startsAt ? date(data.startsAt, '生效时间') : now;
        const expiresAt = date(data.expiresAt, '到期时间');
        if (expiresAt <= startsAt || expiresAt <= now) throw new ApiError(400, 'INVALID_TIME', '到期时间必须晚于生效时间和当前时间');
        const apiKey = `gr_${randomSecret()}`; const id = await hash(apiKey);
        const key: AccessKey = { id, name, startsAt, expiresAt, enabled: true, createdAt: now };
        await env.APP_KV.put(`key:${id}`, JSON.stringify(key));
        return json({ key, apiKey }, 201);
      }
      if (path.startsWith('/api/admin/keys/')) {
        const id = path.slice('/api/admin/keys/'.length);
        if (!/^[A-Za-z0-9_-]{43}$/.test(id)) throw new ApiError(400, 'INVALID_INPUT', '密钥 ID 无效');
        const key = await read<AccessKey>(env.APP_KV, `key:${id}`);
        if (!key) throw new ApiError(404, 'NOT_FOUND', '密钥不存在');
        if (request.method === 'DELETE') { await env.APP_KV.delete(`key:${id}`); return json({ ok: true }); }
        requireMethod(request, 'PATCH'); const data = await body(request);
        if (typeof data.enabled !== 'boolean') throw new ApiError(400, 'INVALID_INPUT', 'enabled 必须为布尔值');
        await env.APP_KV.put(`key:${id}`, JSON.stringify({ ...key, enabled: data.enabled }));
        return json({ ok: true });
      }
      if (path === '/api/admin/rules') {
        if (request.method === 'GET') return json({ rules: await list<Rule>(env.APP_KV, 'rule:') });
        if (request.method === 'DELETE') { await env.APP_KV.delete(`rule:${normalizeRepo(url.searchParams.get('repo'))}`); return json({ ok: true }); }
        requireMethod(request, 'PUT'); const data = await body(request); const repo = normalizeRepo(data.repo);
        if (!data.patterns || typeof data.patterns !== 'object' || Array.isArray(data.patterns)) throw new ApiError(400, 'INVALID_INPUT', 'patterns 必须是对象');
        const patterns: Rule['patterns'] = {};
        for (const [arch, pattern] of Object.entries(data.patterns)) {
          const valid = parseArch(arch); const value = string(pattern, '文件通配符', 0, 200).trim();
          if (value) patterns[valid] = value;
        }
        if (!Object.keys(patterns).length) throw new ApiError(400, 'INVALID_INPUT', '请至少填写一条匹配规则');
        const rule = { repo, patterns }; await env.APP_KV.put(`rule:${repo}`, JSON.stringify(rule)); return json({ rule });
      }
      if (path === '/api/admin/resolve') {
        requireMethod(request, 'POST');
        return await resolve(request, env, config, now, fetcher, url.searchParams.get('refresh') === '1');
      }
      if (path.startsWith('/api/')) throw new ApiError(404, 'NOT_FOUND', '接口不存在');
    }
    if (path.startsWith('/api/')) throw new ApiError(404, 'NOT_FOUND', '接口不存在');
    const response = await next(); const secured = new Response(response.body, response);
    for (const [key, value] of Object.entries(securityHeaders)) secured.headers.set(key, value);
    return secured;
  } catch (error) {
    if (error instanceof ApiError) return json({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } }, error.status, error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {});
    // Never serialize upstream errors, tokens, passwords, or encrypted settings.
    return json({ error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用，请检查部署配置或稍后重试' } }, 500);
  }
}
