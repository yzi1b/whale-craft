# 开发与调试工作流

> **动手前必读**。本文写的每条"必须/绝不"背后都有一次真实事故（见 [history.md](history.md)）。

## 0. 本机环境硬约束（先读这条，不然会炸）

本机跑 whale_craft 的 DSH 是 **Electron 桌面安装版**（`D:\Program Files\DeepSeek Harness`），**不是源码 checkout**（2026-09-30 时是 0.2.0-rc.2），所以：

| 事实 | 说明 |
| --- | --- |
| CLI 位置 | `<安装根>/resources/runtime/cli/bin/dsh.cmd`；实际是 `ELECTRON_RUN_AS_NODE=1` 跑 `<安装根>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js` |
| **`ELECTRON_RUN_AS_NODE` 不能漏** | 少这个变量，那个 exe 会变成"桌面应用本体"启动（弹窗口、还会去建 desktop profile）——真发生过 |
| **Electron 单实例锁按 userData 走**（`%APPDATA%\…dsh-desktop`），与 `DSH_HOME` 无关 | **桌面调试实例与用户日常的桌面应用不能同时开**，必须先完全退出日常应用 |
| `desktop` profile 由应用独占 | CLI 拒绝启动它，`dsh plugin` 也得等应用完全退出（profile 有 lock） |
| desktop profile 的插件管理 | **只有桌面安装自带的这份 CLI** 能管（带 `manageDesktopProfile: true`）；npm 全局的 dsh 会被拒 |
| 宿主 Node 运行时 | `<安装根>/resources/runtime/` |
| 老 `tools/isolate.mjs start` | 需要 DSH **源码 checkout**（`DSH_ROOT/apps/cli/src/bin.ts`）——在本机**起不来**，日常用 `npm run dev:web` / `dev:desktop`（`tools/dev.mjs`） |

`tools/dev.mjs` 按目标选**两套运行时**：**web / link 用 PATH 上的 npm 全局 dsh**（`@deepseek-ai/dsh`，见上表——web 不该被那几百 MB 的桌面应用绑架）；**desktop 才用桌面安装自带的那份 CLI**（desktop profile 只有它能管）。桌面安装的定位走**注册表卸载项**（`InstallLocation`），所以装在 `D:\` 这种非 C: 盘也找得到 —— 光看 `%ProgramFiles%` / `%LOCALAPPDATA%\Programs` 会漏（真踩过：装在 D: 上就一路报"没有 exe / app.asar"）。

## 1. 🔴 隔离铁律（违反过两次）

给这个项目搭任何"跑起来试试"的东西（调试实例、e2e、隔离环境），**必须**与用户日常 DSH 隔离：

- 独立 `DSH_HOME`（`dev.mjs` 用 `.dev/home`）+ 独立的插件状态/记忆目录；
- **绝不碰** `~/.dsh/profiles/*`、`~/.dsh/whale_craft/*`、用户工作区的 `.whale-craft/`；
- `DSH_HOME` 要**显式**传给**每一个**子进程（`cmd` 子命令、pnpm、Electron），**不要依赖继承**；
- 诊断/清理只动自己创建的东西；删软链前先 `lstatSync().isSymbolicLink()` 确认。

**Why（两次真事故）**：
1. 更早的 e2e 清场步骤把用户刚加的认证服务器删了 → `tools/isolate.mjs` 就是为立这条规矩；
2. 2026-09-30 `runDsh` 漏传 `DSH_HOME`，一条 `dsh plugin add link:` 把**生产 web profile** 的 whale_craft 从 npm 版换成了本地 link。

用户 2026-09-30 在两个方案里明确选了"独立 home + 拷凭据、生产不动"——这就是默认路线。

## 2. 日常命令

```bash
node tools/check-core.mjs     # ① 全树语法(node --check) ② 动态 import src 纯模块 ③ 私有字段(#x)声明/引用一致性
node selfcheck.mjs            # 600+ 条离线断言（假 ctx 加载真 apply()；不连 MC、不碰真实实例；含"无宿主模拟"子进程）
npm run check                 # = 上面两条
node tools/check-standalone-import.mjs   # 干净环境回归（pack→独立目录 install→import；要联网装依赖，CI 跑）

npm run dev:web               # 起隔离调试实例（web）——本机主用
npm run dev:desktop           # 起隔离调试实例（desktop 壳；先完全退出日常桌面应用）
npm run dev:link              # 把开发实例的 web profile 接到本仓库（link 安装）
npm run dev:status            # 看实例状态（link 是否接上 / pid / 端口）
npm run dev:stop              # 按 pidfile 停实例
```

- **改 `src/core.mjs` 等大文件后必跑 `check-core`**：它抓"私有方法失联"——少换行会让 V8 提前结束 class，报误导性的 `Private field must be declared…`，整树加载失败；`config.mjs` 两行粘连只有动态 import 才炸。失败 `exit 1`。
- 提交/发版前 `npm run check` 必须全绿（CI 直接跑；`prepublishOnly` 只在绕过脚本裸跑 `npm publish` 时兜底 —— 官方两条发布路径都带 `--ignore-scripts`，不会再跑第二遍）。

## 3. `tools/dev.mjs` 细节

- 子命令：`web`（默认/主用）、`desktop`、`link`、`status`、`stop`；`--watch` 附加：watch `index.js` + `src/` → 400ms 防抖重启实例（改 `client.js` 只提示——浏览器端是 HMR）。
- 目录/常量：`DEV_HOME=.dev/home`、pidfile `.dev/web-instance.json`、`LINK_SPEC='link:'+仓库路径`、登记端口 39901 起（避开一组 FORBIDDEN 端口）。
- 首次启动会 `seedDevHome`：从生产 `~/.dsh` **只拷缺失的**凭据/账户/配置进隔离 home（拷完生产不动）；`ensureRepoDeps` 会补 `npm install` 缺的 mineflayer。
- `link` 校验是**双条件**：profile `dependencies.whale_craft === link:E:/Works/whale-craft` **且** `node_modules/whale_craft` realpath 指回仓库；Windows 上重装前要先摘旧软链（EPERM）。
- 运行时分两套（`webCliRuntime()` / `requireDesktopInstall()`）：`desktop` 用 `spawn(exe, ['--expose-internals', hostCli, ...])` 绕开 .cmd 引号问题；`npm` 用 `spawn(process.execPath, [<npm 全局 dsh>/lib/bin.js, ...])`。`childEnv` 硬性带上 `ELECTRON_RUN_AS_NODE:'1'` + `DSH_HOME=DEV_HOME`（漏了写生产 home，见事故 ②）+ 默认 `WHALE_CRAFT_MEMORY_DIR=.dev/home/memory`。
- `desktop` 子命令注意：首次没有 `profiles/desktop/package.json` 时**要先让桌面应用自己建**（脚本会启动 GUI 轮询 90×2s）；`desktopAppRunning()` 用 PowerShell 查进程命令行、判据是"不含 `--expose-internals`"（因为 CLI/web 实例也叫同名 exe）。
- `status`/`stop` 只认 pidfile 里的 pid，绝不广谱杀进程。

## 4. `tools/isolate.mjs`（老方式，供 e2e/整树验证）

- `start` 需要 **DSH 源码 checkout**（`DSH_ROOT` 环境变量或 `--dsh-root`，要求存在 `apps/cli/src/bin.ts`），用当前 node `--import tsx/esm` 直接跑源码 CLI；`status` 用 netstat 查端口；`stop` 只杀自己记录的 pid。
- 隔离不变量：`WHALE_CRAFT_STATE_DIR=logs/isolate-state`（副本）、`WHALE_CRAFT_MEMORY_DIR=stateDir/memory`、**`WHALE_CRAFT_NO_PRESET_WRITE=1`**（preset 根在真实 `~/.dsh/.agent-presets` 无法重定向，与生产共用——所以禁止写）。
- 与 `dev.mjs` 同源约定（FORBIDDEN 端口、39901 起）；日常开发用 dev.mjs，isolate 用于"整树加载"级别的验收。

## 5. `selfcheck.mjs` 套件

- **形态**：假 ctx（工具注册表、sessionController、jobs、agentPresets…全部 stub）+ 加载**真** `apply()`；用 `console.log('  ✅/❌ …')` 输出；只有 `apply()` 抛错才 `exit 1`，末尾恒 `process.exit(0)`。
- **污染隔离**：`MC_LOG` → `logs/selfcheck.log`；`WHALE_CRAFT_DIR`/`WHALE_CRAFT_MEMORY_DIR` → `mkdtemp` 临时目录（构造用 `fileURLToPath` 而非 `new URL().pathname`——中文用户名路径会被百分号编码，2026-09-24 卡过自检）。
- **覆盖分组**（节标题）：超时保护单元｜工具面与参数｜每会话实例分离｜未连接行为｜看门狗 v2（含断线同步、等待被打断）｜mc_act/give/sequence/stop｜强制停止顺序｜MC设置 HTTP（真路由）｜发布区与文件分享（防穿透/两模式/base 推导）｜玩家说话辨认｜记忆树｜图像地图｜扩展点｜归档保护｜提示词注入单通道与去重｜配置+权限隔离｜协议护栏禁发未知包｜幽灵在线｜账户/凭据分离｜受保护文件（RULES/AGENTS/config.json 可读不可写）与版本标记｜认证 URL｜未处理拒绝不留患｜唤醒投递（必须提示词注入）｜job 结算｜事件队列单一写入方｜无 OP 建造｜放置判据（与 minecraft-data 真值表比对）｜mc_connect 全参数｜client bundle 静态断言｜mc_lan/mc_ping｜设置页 UI 静态断言｜打包完整性｜**宿主包缺省**（内置 defineTool 与宿主逐字对拍 + 无宿主模拟子进程）。
- **无宿主模拟**（2026-10-04，issue #5）：`tools/no-host-init.mjs`（module.register 解析钩子）屏蔽 `@deepseek-ai/dsh-tools`/`schemastery` 后**再跑一遍 selfcheck**（子进程），并逐字比对 29 个工具的注册形状——本机 link 安装测不出的问题靠它钉住；发布侧另有 `tools/check-standalone-import.mjs`（干净安装 import 回归，CI 必跑，改回静态 import 必红）。
- **加断言的惯例**：断言要打在**真实实现**上（别只测 stub）；曾有"集成断言假绿"（复制完 preset 要改 persona/关 shell 那两条测不到）与"前端拿不到真路由"（真机 404）的教训，所以有一条专门**打真路由**的断言。计数口径：README 里写的 726/686 是历史数字，以实际运行为准（当前 600+ ✅）。

## 6. 调试技巧

- **日志**：插件日志 `$DSH_HOME/whale_craft/logs/whale-craft.log`（`MC_LOG` 可覆盖；启动时同时进宿主 logger）。自检日志 `logs/selfcheck.log`。
- **会话内诊断**：`mc_debug_diag`（物理/控制位/收包/事件队列 + `promptInjection` 投递状态；需开启调试开关）；`mc_watch {action:"log"}` 看看门狗留档；`GET /api/mc/mode?sessionId=` 有注入诊断。
- **真机验收文化**：本项目修 bug 讲究"真机复现 → 修 → 真机验收"（CHANGELOG 每条修复都带现象/根因/修法/验收）。能起本地 MC 服务端就起，别只靠自检。
- **别信"状态在撒谎"**：历史多次出现"界面/AI/工具三处一起撒谎"（断线后仍显示在游戏中、幽灵在线）。改状态相关代码时，同步核对：`McBot.online`、`McSession.modeView()`、`/api/mc/status`、client 状态条、`mc_events`/看门狗——五处要一致。

## 7. DSH 升级敏感清单（升级后逐项自查）

完整清单见 [architecture.md §13](architecture.md)。最常踩的：`agent/pre-step` 必须 `next()`；`tools.restrict` 黏性；`archiveSession` 内部方法包装；`agentPresets` 的 `copy` 契约与同步 `roots`（async `list()` 静默失效）；persona 键名 `text/prefix`；`@deepseek-ai/dsh-llm` 的 `createUserMessage`；`sessionController.prompt` 是 @Remote。

另外，插件在 `package.json` 里声明了受支持的 DSH 运行时范围（`engines.dsh` + dsh peer 均为 `>=0.2.0-rc.1 <0.3.0`）：**DSH 升到范围外时，新安装会被拒、已装的会在启动时被跳过**（stderr 一行 `skipping profile bundle`）——这是有意为之的围栏，不是 bug；处理方式见 [release.md §7](release.md)（豁免命令或改范围发新版）。

## 8. 仓库约定

- **ESM**（`"type":"module"`，Node ≥22），只用 `node:` 前缀内置模块；**无构建步骤**（client.js 是手写 bundle）。
- **行尾统一 LF**（`.gitattributes`，`text=auto eol=lf`）；二进制扩展名声明 `binary`——自检有按行匹配断言，行尾漂移会红。
- 文档/注释/提交信息以**中文**为主；用户可见文案即测试断言对象（改动文案要同步改断言）。
- 提交信息风格：`<版本号>：<一句话>` 或 `修<现象>`（见 git log）；发版 commit 例：`0.1.7：修三个真机问题 + 订正 README / 更新日志`。
- `package.json` 的 `files` 白名单决定 npm 包内容——新增运行期文件（如新 src 模块）要**同时**更新它和 CI 打包核对断言、selfcheck 的打包断言。
- 改动结构性内容后同步更新本目录（agent-docs/）。

## 9. 事故防呆速查（写代码前扫一眼）

| 场景 | 防呆 |
| --- | --- |
| 写 spawn/子进程（起 DSH、装插件） | `DSH_HOME` 显式传、`ELECTRON_RUN_AS_NODE` 显式传 |
| 写 `setInterval` | 回调自兜异常（uncaughtException 直接杀 DSH 进程） |
| 写 `emit('error')` | 先查 `listenerCount`（无监听者会 throw） |
| 写 async 钩子/waterfall | waterfall 必须 `next()`；所有 rejection 显式 catch（宿主 fail-loud `exit(1)`） |
| 调 mineflayer ack 类 API | `withTimeout`/`raceAbort` 包裹 |
| 报"成功" | 复验实际状态（blockAt / 状态字段）再报 |
| 改工具返回值 | 过 `lossless`（经 asTool 自动） |
| 投递提示/唤醒 | 走 `userMessage()` + 看门狗 `#inject`；先 `interruptWait` |
| 新增**可选宿主包**（宿主可能给不到） | 顶层**绝不静态 import**（`await import()`+try/catch）；宿主优先、`kind()` 记来源；拿不到写**等价实现**并在 selfcheck 里与宿主**逐字对拍**；名字加进 `tools/no-host-hooks.mjs` 名单；CI 的 standalone 回归自动覆盖任何包（详见 src-modules.md §16、history F11） |
| 动 `.github/workflows/*` | 用 Contents API 落地（workflow scope 坑，见 release.md） |
