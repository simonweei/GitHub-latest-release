export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown, public retryAfter?: number) { super(message); }
}
export type Arch = 'x64' | 'arm64' | 'x86';
export interface Asset { name: string; browser_download_url: string; size: number }
export interface Release { version: string; assets: Asset[]; checkedAt: number }
export interface Rule { repo: string; patterns: Partial<Record<Arch, string>> }
export function normalizeRepo(input: unknown): string {
  if (typeof input !== 'string' || input.length > 300) throw new ApiError(400, 'INVALID_REPO', '请输入 GitHub 仓库地址或 owner/repo');
  let value = input.trim();
  if (/^https:\/\//i.test(value)) {
    let url: URL;
    try { url = new URL(value); } catch { throw new ApiError(400, 'INVALID_REPO', '仓库地址无效'); }
    if (url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) throw new ApiError(400, 'INVALID_REPO', '只支持 github.com 的公开仓库');
    value = url.pathname.replace(/^\//, '').replace(/\/$/, '');
  }
  value = value.replace(/\.git$/i, '');
  if (!/^[a-z\d](?:[a-z\d-]{0,38})\/[a-z\d_.-]{1,100}$/i.test(value) || ['.', '..'].includes(value.split('/')[1])) throw new ApiError(400, 'INVALID_REPO', '请输入仓库根地址，例如 owner/repo');
  return value.toLowerCase();
}
export function parseArch(value: string | null): Arch {
  if (!value) return 'x64';
  if (value === 'x64' || value === 'arm64' || value === 'x86') return value;
  throw new ApiError(400, 'INVALID_ARCH', 'arch 只支持 x64、arm64、x86');
}
function glob(pattern: string, name: string) {
  const expression = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${expression}$`, 'i').test(name);
}
export function selectAsset(assets: Asset[], arch: Arch, pattern?: string): Asset {
  const candidates = assets.filter(asset => {
    const n = asset.name.toLowerCase();
    if (!/\.(exe|msi|zip)$/.test(n) || /(?:^|[._-])(symbols?|debug|pdb|checksums?|sha\d+|blockmap|source|delta|patch)(?:[._-]|$)/.test(n)) return false;
    if (/(?:linux|darwin|macos|osx|android|appimage)/.test(n)) return false;
    const found: Arch | undefined = /(?:arm64|aarch64)/.test(n) ? 'arm64' : /(?:x86_64|amd64|x64|win64)/.test(n) ? 'x64' : /(?:\bx86\b|ia32|i[3-6]86|win32)/.test(n.replaceAll('_', '-')) ? 'x86' : undefined;
    if (found && found !== arch) return false;
    if (pattern) return glob(pattern, asset.name);
    // Unknown architectures need an explicit rule; never silently label an x86 binary x64.
    if (found !== arch) return false;
    return /\.(exe|msi)$/.test(n) || /(?:windows|win32|win64|(?:^|[._-])win(?:[._-]|$))/.test(n);
  });
  const ranked = candidates.map(asset => ({ asset, rank: pattern ? 0 : asset.name.toLowerCase().endsWith('.exe') ? 0 : asset.name.toLowerCase().endsWith('.msi') ? 1 : 2 }));
  const bestRank = Math.min(...ranked.map(item => item.rank));
  const best = ranked.filter(item => item.rank === bestRank);
  if (!best.length) throw new ApiError(404, 'NO_WINDOWS_ASSET', '最新正式版没有可明确匹配的 Windows 文件，请在管理页面配置规则', { candidates: assets.map(a => a.name) });
  if (best.length > 1) throw new ApiError(409, 'AMBIGUOUS_ASSET', '多个文件匹配，请配置更精确的项目规则', { candidates: best.map(item => item.asset.name) });
  return best[0].asset;
}
export async function fetchRelease(repo: string, token: string, fetcher: typeof fetch, now: number): Promise<Release> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'github-windows-releases', 'X-GitHub-Api-Version': '2026-03-10' };
  if (token) headers.Authorization = `Bearer ${token}`;
  async function get(path: string) {
    let response: Response;
    try { response = await fetcher(`https://api.github.com/repos/${repo}${path}`, { headers, signal: AbortSignal.timeout(8000), redirect: 'manual' }); }
    catch { throw new ApiError(503, 'GITHUB_UNAVAILABLE', 'GitHub 暂时无法连接，请稍后重试', undefined, 60); }
    if (response.status >= 300 && response.status < 400) throw new ApiError(400, 'REPOSITORY_MOVED', '仓库地址已变更，请使用当前的 GitHub 仓库地址');
    if (response.status === 404) throw new ApiError(404, 'RELEASE_NOT_FOUND', '公开仓库或最新正式版不存在');
    if (response.status === 429 || response.status === 403) {
      const retry = Number(response.headers.get('retry-after')) || Math.max(60, Number(response.headers.get('x-ratelimit-reset')) - Math.floor(now / 1000));
      throw new ApiError(503, 'GITHUB_RATE_LIMITED', 'GitHub 限流或拒绝访问，请稍后重试', undefined, Math.min(3600, retry));
    }
    if (!response.ok) throw new ApiError(503, 'GITHUB_UNAVAILABLE', 'GitHub 请求失败，请检查 Token 或稍后重试', undefined, 60);
    try { return await response.json() as Record<string, unknown>; }
    catch { throw new ApiError(503, 'GITHUB_UNAVAILABLE', 'GitHub 返回无效数据', undefined, 60); }
  }
  const repository = await get('');
  if (repository.private !== false) throw new ApiError(404, 'RELEASE_NOT_FOUND', '仅支持公开仓库');
  const data = await get('/releases/latest');
  if (data.draft || data.prerelease || typeof data.tag_name !== 'string' || !Array.isArray(data.assets)) throw new ApiError(502, 'INVALID_RELEASE', 'GitHub 未返回有效正式版');
  const assets = (data.assets as Record<string, unknown>[]).filter(a => {
    if (typeof a.name !== 'string' || typeof a.browser_download_url !== 'string' || a.state !== 'uploaded') return false;
    try { const url = new URL(a.browser_download_url); return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !url.port; } catch { return false; }
  }).map(a => ({ name: a.name as string, browser_download_url: a.browser_download_url as string, size: Number(a.size) || 0 }));
  return { version: data.tag_name, assets, checkedAt: now };
}
