# 发布流程

> 快照：**0.2.0**（开发中，未发布；2026-10-04）。本文是发版的**唯一权威文档**：给 agent 的摘要 + CI 行为细节 + 面向人的操作步骤与实测记录
> （原仓库根 `RELEASING.md` 已并入本文）。
> ⚠️ 当前状态：**版本号已宣告为 `0.2.0`（`package.json` 已改），但尚未发布** —— main 距上次发布 `v0.1.7` 有一大批改动。
> 真正发版时仍需：在 `CHANGELOG.md` 补 `[0.2.0]` 节 → 打 `v0.2.0` tag（版本号这次已提前升好）。

## 0. 两条渠道，互不依赖

| 渠道 | 触发 | 产物 |
| --- | --- | --- |
| **GitHub Release** | 推 `v*` tag → CI 自动 | `whale_craft-<版本>.zip` + 正文取 CHANGELOG 本节 |
| **npm** | ① CI（仓库配了 `NPM_TOKEN` 就自动发）② 或本机手动 `npm run publish:npm` | npm 包 `whale_craft@<版本>` |

> 🔴 **2026-09-18 起 npm 步骤加回工作流了**（用户要求），但**是"先探再发"**：仓库
> Settings → Secrets and variables → Actions 里有 `NPM_TOKEN` 才发；**没配就明确跳过并打一条 notice**，
> 工作流照样绿 —— 不会再出现 2026-09-17 那种"token 失效 → 整条红叉、而发布其实早就成功"的情况。
> 想完全不依赖 secret，就走 §6 在本机手动发。

## 1. 版本纪律（发版前必做）

1. `package.json` 的 `version` 升到目标版本；
2. `CHANGELOG.md` 加一节 `## [<版本>] - YYYY-MM-DD`（**Release 正文就是它**）。写**面向用户**的版本说明：现象 / 用户能看懂的根因 / 用户影响 / 不兼容变更。
   **技术细节不进 CHANGELOG** —— 代码片段、上游源码的文件:行号、自检断言与计数、内部标识符、CI 明细、给维护者的教训，
   一律写进 [`history.md`](history.md)（事故档案 + 设计决策）；CHANGELOG 是给终端用户读的；
3. 提交、推 main；
4. 打 tag 并推：
   ```bash
   git commit -am "0.1.7：…"
   git push
   git tag -a v0.1.7 -m "whale_craft 0.1.7"
   git push origin v0.1.7
   ```
   **tag 必须与 `package.json` 版本逐字一致**（release.yml 会校验并直接失败）。

## 2. `release.yml` 行为（推 tag 后）

1. 跑 `check-core` + `selfcheck`（全绿才继续）；
2. 校验 tag == `package.json.version`；
3. `npm pack` → 解包 → 打 **zip**（不是 .tgz）；
4. 用 `.notes.cjs` 从 `CHANGELOG.md` 提取 `## [<版本>]` 那一节当 Release 正文（**不用 `--generate-notes`**，不用 diff）；
5. `gh release create` 挂 zip；
6. **npm "先探再发"**：探测仓库 secret `NPM_TOKEN` —— 有才发（发布前再查 `npm view <pkg>@<版本>` 防重复，已存在则跳过）；
   **没有就打一条 notice 跳过，工作流照样绿**（2026-09-17 的教训：token 失效让"整条红叉、而发布其实早就成功"）。

## 3. `ci.yml` 行为（push main / dev / PR）

- **check 矩阵**：ubuntu（Node 22 / 24）+ windows（Node 22）→ `npm ci` → `check-core` → `selfcheck`；
- **package job**（全绿后）：`npm pack` 核对 tarball —— 必含
  `package.json/index.js/client.js/selfcheck.mjs/cordis.patch.yml/LICENSE/README.md/tools/check-core.mjs`；
  **不得**混进 `node_modules/`、`logs/`、`accounts.json`、`config.json`、`.whale-craft`；上传 artifact。

## 4. 落地 / 修工作流文件（workflow scope 坑）

`.github/workflows/*` 的推送可能需要 token 有 **`workflow`** scope，而经代理通道推可能**明明有 scope 也被拒**
（是通道问题，不是 token 问题）。**实测 Contents API 可以**（PUT `contents/.github/workflows/release.yml` 成功）。
所以 `release.yml` 的内容在 `scripts/release.workflow.yml` 留一份（**普通文件**，随代码分发）：

```bash
node scripts/land-workflow-fix.mjs --dry        # 先看会改什么
GITHUB_TOKEN=<带 workflow scope 的 token> node scripts/land-workflow-fix.mjs
```

`land-workflow-fix.mjs`：预检 token scopes → 优先 Contents API（GET 拿 sha → PUT base64）→ 失败回退 git push
（报 workflow scope 错时提示改用 API）→ 回读校验（与模板逐字比对）。

- ⚠️ 改 `.github/workflows/release.yml` 时**连模板 `scripts/release.workflow.yml` 一起改**，
  否则下次同步会按旧模板把它覆盖回去（脚本会先报"与模板不同"）。
- `ci.yml` **没有模板** —— 改它只能走 Contents API（`gh api`）或网页编辑（网页编辑不需要 workflow scope）。

## 5. 本机手动发 npm（不依赖任何 CI secret）

```bash
npm login                                   # 或 NODE_AUTH_TOKEN / 本仓库 .npmrc（已 gitignore）
node scripts/publish-npm.mjs --dry          # 先演练：全检查走一遍不真发
node scripts/publish-npm.mjs                # 真发（要求输入 yes 确认）
node scripts/publish-npm.mjs --yes --otp 123456 --tag next
```

`publish-npm.mjs` **前置检查（任一不过即停，不会发出半成品）**：

1. git 工作树干净（`git status --porcelain` 为空）；
2. `package.json` 版本在 `CHANGELOG.md` 里有对应节；
3. `check-core` + `selfcheck` 全绿（`--skip-checks` 可跳）；
4. `npm whoami` 拿得到身份（token 不可用当场停，不会等 publish 才 404）；
5. 该版本 npm 上**还没发过**（并报当前 latest）；
6. `npm pack --dry-run` 清单里没有 `logs/`、`accounts.json`、`config.json`、`.whale-craft`；
7. 提醒 GitHub 有没有对应 tag（只提醒，不拦）。

发完脚本会打印 `https://www.npmjs.com/package/whale_craft/v/<版本>`。

- **token 放哪**：首选 `npm login`（凭据进 `~/.npmrc`）；或环境变量 `NODE_AUTH_TOKEN`；写进本仓库 `.npmrc` 也行——**已在 `.gitignore` 里忽略**。
- `publishConfig` 钉死 `registry: https://registry.npmjs.org/` + `access: public`（避免本机镜像 registry 把包发错地方）。
- `prepublishOnly` = `npm run check`（**坏树发不出去**，即使不经脚本直接 `npm publish` 也拦得住）。
- ⚠️ **别让检查跑两遍**：CI 的「发布前必须全绿」和本机脚本的 ③ 已经跑过 `check-core` + `selfcheck`，
  所以两处的 `npm publish` 都带 `--ignore-scripts`，免得 lifecycle 再触发一次 `prepublishOnly`（重复又慢）。
  `prepublishOnly` 本身保留，只为"绕过脚本裸跑 `npm publish`"兜底。
- Windows 上脚本显式走 `cmd.exe /c`（不用 `shell:true`，防 DEP0190 与参数拆分）。

## 6. 常见问题（速查）

| 现象 | 原因 / 处理 |
| --- | --- |
| 推送被拒 `… without 'workflow' scope` | token 缺 workflow（或**推送通道**问题）→ §4 Contents API / 网页编辑 |
| `E404 Not Found - PUT https://registry.npmjs.org/…` | token 不能发布（过期/只读/非 Automation）→ 重新 `npm login` |
| `npm whoami` 401 | token 没配好 |
| tag 工作流红叉、报 `npm …` 失败 | 远端还是旧工作流 → §4 |
| Release 正文是 `Full Changelog: …compare/…` / 附件是 `.tgz` | 同上，旧工作流 → §4 |
| tag 校验失败 | tag 与 package.json 版本不一致（改 tag 或改版本重发） |
| Release 正文/附件都对但没发 npm | 仓库没配 `NPM_TOKEN`（打 notice 跳过，属正常）→ 见 §5 本机手动发 |

## 7. DSH 版本范围声明（engines.dsh + peerDependencies，2026-10-02 起）

`package.json` 明确声明支持的 DSH **运行时**范围：**`>=0.2.0-rc.2 <0.3.0`**，且三处保持一致（改一处漏两处，selfcheck 的 `DSH_RANGE` 断言会红）：

| 位置 | 性质 |
| --- | --- |
| `engines.dsh` | 官方声明字段（`@deepseek-ai/dsh-package-manifest` 定义），**当前宿主不强制**（"兼容性仅作声明"） |
| `peerDependencies` 的 `@deepseek-ai/dsh-llm` / `@deepseek-ai/dsh-tools` | **真正强制**：宿主 dsh-app-boot 拿它和运行时版本做 `semver.satisfies(runtime, range, {includePrerelease:true})`（只查名字为 `@deepseek-ai/dsh` / `dsh-*` 的 peer；schemastery 不查，保持 `*` 即可） |
| `selfcheck.mjs` 里的 `DSH_RANGE` 常量 | 把上面几处钉在一起 |

- 失配的后果：**安装被拒**（`dsh plugin add` 预检，exit 1、什么都不装，含 `link:` 本地路径）；已装好的则是**启动时跳过该 bundle**（stderr 一行 `dsh: skipping profile bundle "whale_craft": …`，profile 其余照常）。
- 逃生门（精确版本豁免）：`dsh plugin --profile web allow-version whale_craft@<版本> --dsh-version <运行时版本> --accept-risk`（配 `revoke-version` / `version-exemptions`；插件管理 UI 同款），落在 `<profile>/compatibility.json`。
- ⚠️ 范围写法的坑：**预发布必须显式写进范围**——`^0.2.0` 匹配不了 `0.2.0-rc.2`（rc 低于下限）；`^0.2.0-rc.1` / `>=0.2.0-rc.1 <0.3.0` 可以。
- DSH 升级超出范围时（例如到 0.3.0）：要么发新版放宽/收紧范围，要么在用户侧加豁免——加宽范围前先真机验证。
