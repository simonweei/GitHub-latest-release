# Release Desk

通过 Cloudflare Pages Functions + KV 获取 GitHub 最新正式版的 Windows 文件地址。原生前端、TypeScript 后端，无运行时 npm 依赖。

## 功能

- 管理员密码登录，8 小时签名会话。
- 管理页面查看、显示/隐藏、修改会话签名密钥和 GitHub Token；两者以 AES-256-GCM 加密存入 KV，登录后的管理员可读取明文。
- 生成 API Key，指定生效时间和到期时间，启用、停用、删除。API Key 只在创建时返回，KV 保存 SHA-256 哈希及元数据。
- 公开 GitHub 仓库最新正式版解析，支持 x64（默认）、ARM64、x86，自动识别或项目通配符规则。
- 一小时新鲜缓存；GitHub 暂时故障可返回距最后成功检查不足 24 小时的旧结果，标记 `stale: true`。不代理文件下载。

## 本地启动

需要 Node.js 22.12 或更新版本。

```sh
npm ci
npm run setup
npm run dev
```

打开 http://localhost:8788 ，使用 `.dev.vars` 内的 `ADMIN_PASSWORD` 登录。`setup` 随机生成本地密码和加密主密钥，不覆盖现有文件。本地 KV 位于 `.wrangler`，与生产隔离。

不要提交 `.dev.vars`。更换 `MASTER_KEY` 会导致已有加密设置无法解密，必须恢复原主密钥或删除 KV 的 `settings:v1` 后重新配置；API Key 和项目规则不会因此删除。

## 部署到 Cloudflare Pages

1. 登录 Cloudflare 并创建一个 Pages 项目和 KV 命名空间：

   ```sh
   npx wrangler login
   npx wrangler kv namespace create APP_KV
   ```

2. 在 Pages 项目的 **Settings → Bindings → Add → KV namespace** 添加绑定，变量名必须为 `APP_KV`，选择刚创建的命名空间。生产和预览环境建议使用不同 KV，避免测试修改生产配置。保存后重新部署。
3. 在 Pages 项目的 Settings → Variables and Secrets 添加 **Secret**：
   - `ADMIN_PASSWORD`：至少 6 个字符，最多 256 个字符。建议生产环境仍使用较长的随机密码。
   - `MASTER_KEY`：32 个随机字节的 Base64 编码。可在本机运行以下命令生成，再安全保存：

     ```sh
     node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
     ```

   也可使用交互命令输入 Secret（不要放入命令参数或提交 Git）：

   ```sh
   npx wrangler pages secret put ADMIN_PASSWORD --project-name github-windows-releases
   npx wrangler pages secret put MASTER_KEY --project-name github-windows-releases
   ```

4. 验证并部署：

   ```sh
   npm run check
   npm run deploy
   ```

5. 登录正式站点，在「系统设置」填写 GitHub Token。仅访问公开仓库，使用不包含私有仓库授权的最小权限 Token。随后在「API 密钥」生成调用密钥。

使用 Git 集成时，构建命令设置为 `npm run build`，输出目录为 `public`，不设置 Deploy command；Pages 会在构建后自动部署并编译仓库根目录的 `functions`。不要把 `.build` 作为静态目录，也不要使用 Workers 的 `npx wrangler deploy`。

仓库不包含 `wrangler.toml`，因此生产 KV、变量和兼容性设置由 Cloudflare Pages 控制台管理。本地 `npm run dev` 使用 Wrangler 的 `--kv=APP_KV` 创建独立本地 KV。

不要在 Cloudflare 控制台使用“拖放文件”部署本项目：该方式只上传静态资源，不会编译 `functions`，登录和 API 都将不可用。如需从本机直接上传，请在仓库根目录运行 `npm ci` 后执行 `npm run deploy`；Wrangler 会同时上传 `public` 和编译后的 Pages Functions。控制台中的 `APP_KV`、`ADMIN_PASSWORD` 和 `MASTER_KEY` 绑定仍需提前配置。

## 调用 API

```sh
curl 'https://YOUR-SITE.pages.dev/api/latest?repo=owner/repo&arch=x64' \
  -H 'Authorization: Bearer YOUR_API_KEY'
```

`repo` 支持 `owner/repo`、`https://github.com/owner/repo` 和 `.git` 后缀。仅支持仓库根地址，不接受其他网站、私有仓库或任意 URL 抓取。

```json
{
  "repo": "owner/repo",
  "version": "v1.2.3",
  "platform": "windows",
  "arch": "x64",
  "filename": "App-win-x64.exe",
  "url": "https://github.com/owner/repo/releases/download/v1.2.3/App-win-x64.exe",
  "size": 123456,
  "checked_at": "2026-09-13T00:00:00.000Z",
  "stale": false
}
```

所有 API 响应均为 `Cache-Control: no-store`，有效期在读取版本缓存之前验证，不接受查询参数中的 API Key。不开放跨域浏览器调用；脚本和客户端可以直接调用。

| HTTP 状态 | 错误码示例 | 含义 |
| --- | --- | --- |
| 400 | INVALID_REPO / INVALID_ARCH / INVALID_TIME | 参数错误 |
| 401 | INVALID_API_KEY / UNAUTHORIZED | 密钥无效或未登录 |
| 403 | API_KEY_NOT_ACTIVE / API_KEY_EXPIRED / API_KEY_DISABLED | 尚未生效、到期或停用 |
| 404 | RELEASE_NOT_FOUND / NO_WINDOWS_ASSET | 仓库、正式版不存在或无明确匹配文件 |
| 409 | AMBIGUOUS_ASSET | 多个候选，需配置规则 |
| 429 | LOGIN_RATE_LIMITED | 登录错误次数过多 |
| 503 | GITHUB_RATE_LIMITED / GITHUB_UNAVAILABLE | 上游故障，按 Retry-After 重试 |

## 匹配与时间约定

- 使用 GitHub `/releases/latest`，遵循 GitHub 的 Latest 标记，不自行按 tag 排序；不会回退到旧版本寻找 Windows 文件。
- 自动匹配必须能识别目标架构。默认优先 `.exe` → `.msi` → 明确标记 Windows 的 `.zip`，相同优先级多个文件返回候选列表。
- 未标注架构的 `setup.exe` 需要管理员指定精确规则，避免将 x86 文件误判为 x64。规则只支持 `*` 通配符（其余字符按字面匹配），不区分大小写。规则不覆盖明确不兼容的系统或架构，也不选择源码、符号文件等。
- 有效区间为 `startsAt <= 当前时间 < expiresAt`。页面始终按北京时间输入和显示；接口使用带时区 ISO 时间。1/7/30 天按生效时间起算。
- 有效期限制此服务的 API 访问，无法撤销已公开的 GitHub 下载 URL。

## KV 与稳定性边界

- KV 最终一致：修改、创建、停用、删除密钥及签名密钥轮换可能需 60 秒或更久传播。旧会话在新配置生效后失效；签名密钥修改成功会立即清除当前浏览器 Cookie。
- 到期检查使用服务端当前时间；固定到期时间不会依赖 KV 自动删除。无需定时任务。
- 登录使用 KV 记录 15 分钟窗口的失败次数，5 次后暂时拒绝。这是尽力限速，不能抵御分布式并发爆破；公网部署可为登录和 API 路径增加 Cloudflare 平台限速。KV 不用于精确配额或分布式锁。
- 并发冷缓存请求可能重复访问 GitHub。此方案适合轻量服务，不承诺全球请求去重。每次成功刷新最多进行两次上游请求（确认公开仓库 + 最新版本），均设 8 秒超时。
- 故障回退带重试退避，不会在每个请求中重复刷新；404 短暂缓存 5 分钟。管理员强制刷新时直接报告上游错误，不伪装成刷新成功。
- 密钥和设置响应不缓存、不写浏览器 localStorage；日志不记录密钥或上游响应正文。加密主密钥仅在部署 Secrets 中保存，不返回页面。
- 退出登录清除当前浏览器 Cookie；无状态会话在原到期时间前仍可验证。需要使所有既有会话失效时轮换签名密钥。

## 验证

```sh
npm run check
```

包含 TypeScript 检查、使用模拟 GitHub 与内存 KV 的接口测试，以及真实 Pages Functions 编译。测试覆盖登录/CSRF/会话轮换、加密存储和明文读取、API 时间边界、分页、禁用/删除、缓存降级、私有仓库拒绝、文件匹配和仓库输入验证。模拟测试不代表 Cloudflare 跨地区一致性测试。

启动本地服务后，可另外运行 `npm run test:smoke`：它只连接 localhost:8788，验证真实 Cloudflare 本地运行时、密钥读写和真实 GitHub 仓库解析。测试会临时修改本地 Token、创建测试 API Key，并在结束时恢复设置、删除测试 Key；请在单独的本地测试状态运行，勿与其他本地管理操作同时进行。此测试需要访问 GitHub 网络。

项目目录：`src` 核心逻辑，`functions` Pages 入口，`public` 管理页面，`tests` 自动测试，`scripts` 本地初始化。
