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
  const hasNamedPlatforms = assets.some(asset => /(?:linux|darwin|macos|osx|android|windows|win32|win64)/i.test(asset.name));
  const candidates = assets.flatMap(asset => {
    const n = asset.name.toLowerCase();
    if (!/\.(exe|msi|msix|msixbundle|appx|appxbundle|zip)$/.test(n) || /(?:^|[._-])(symbols?|debug|pdbs?|checksums?|sha\d+|blockmap|sources?|delta|patch)(?:[._-]|$)/.test(n)) return [];
    if (/(?:linux|darwin|macos|osx|android|appimage)/.test(n)) return [];
    const normalized = n.replaceAll('_', '-');
    const found: Arch | undefined = /(?:arm[-_]?64|arm64ec|aarch64)/.test(normalized) ? 'arm64'
      : /(?:x86[-_]64|amd64|x64|win64|windows-64|(?:^|[.-])64[-]?bit(?:[.-]|$))/.test(normalized) ? 'x64'
      : /(?:^|[.-])(?:x86|ia32|i[3-6]86|386|win32|windows-86|32[-]?bit)(?:[.-]|$)/.test(normalized) ? 'x86' : undefined;
    if (found && found !== arch) return [];
    if (pattern) return glob(pattern, asset.name) ? [{ asset, score: 0 }] : [];
    const executable = /\.(exe|msi|msix|msixbundle|appx|appxbundle)$/.test(n);
    const windows = /(?:windows|win32|win64|(?:^|[._-])win(?:[._-]|$))/.test(n);
    const unmarkedArchive = !hasNamedPlatforms && found === arch;
    // Unmarked executables are a common Windows x64 default (for example Joplin-Setup.exe).
    if (!(found === arch && (executable || windows || unmarkedArchive)) && !(arch === 'x64' && !found && (executable || windows))) return [];
    let score = n.endsWith('.exe') ? 0 : n.endsWith('.msi') ? 10 : /\.(msix|msixbundle|appx|appxbundle)$/.test(n) ? 12 : 20;
    if (/(?:setup|installer)/.test(n)) score -= 3;
    if (!found) score += 30;
    if (/(?:unsigned|portable|min[-_]?git|(?:^|[.-])cli(?:[.-]|$)|(?:^|[._-])lite(?:[._-]|$)|legacy|preview|fixed[_-]?webview|(?:^|[._-])desktop(?:[._-]|$)|(?:^|[._-])gnu(?:[._-]|$)|(?:^|[._-])qt5(?:[._-]|$)|(?:^|[._-])lt20(?:[._-]|$))/.test(normalized)) score += 15;
    // When variants are otherwise equivalent, the least-qualified filename is normally the primary build.
    score += n.length / 1000;
    return [{ asset, score }];
  });
  const bestScore = Math.min(...candidates.map(item => item.score));
  const best = candidates.filter(item => item.score === bestScore);
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
