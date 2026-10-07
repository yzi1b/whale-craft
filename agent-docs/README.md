# whale_craft 内部开发文档（agent-docs）

> 面向接手本仓库的 AI agent（**只给 agent 看、由 agent 维护**；需要人看的底层设计放 [`dev-docs/`](../dev-docs/)）。**先读这一页**，再按需进入各专题。
> 仓库根有一份 [`AGENTS.md`](../AGENTS.md) 作为引导入口（DSH 宿主会把根 `AGENTS.md` 当工作区指令自动注入），
> 它只放"先读这里 + 最硬的几条铁律 + 验证命令"，完整地图与铁律速查以本页为准。
> 快照：whale_craft **0.2.0**（**开发中，未发布**；自 `v0.1.7` 起累计：issue #1 修复、`tools/dev.mjs`、26.2 兼容层移除、DSH 版本范围、插件页本地化、按工作区 config.json、**设置两态 + 插件页「设置」入口 + 「连接到MC」弹窗 + 文件分享改开关**）；**0.2.0-beta.1（2026-10-06）**已作为预览发布，已知：registry 安装后 `failed to import`（宿主 resolver bug，见 history.md F14，`src/resolver-shim.mjs` 临时兜底），2026-10-06。
> 本文档写"机制与不变式（为什么）"；**细节以代码为准**，文档负责给地图与避坑指引。

## 项目一句话

DSH（DeepSeek Harness）原生插件：把一台无头 Minecraft 机器人（mineflayer）跑在 DSH 宿主进程里，
给模型一套 `mc_*` 工具去走路、挖建、说话、看图、记事，并在"值得注意"时把它**唤醒**（单脑看门狗）。

核心设计（用户视角的完整说明见仓库根 `README.md`）：

- **每会话独立实例**：每个会话（agent）有自己的 McBot + 事件队列 + 看门狗；不同会话可连不同服务器、不同账号。
- **事件唤醒只有一条通道**：`mc_watch` 看门狗（绑定宿主 job → 结算/注入）；**不存在**跨会话唤醒。
- **提示词只走"插件提示行"**：`source:{kind:'plugin:whale_craft',form:'notice'}`（v4 规范值），绝不冒充用户发言。
- **凭据不进模型上下文**：密码/token 只写宿主凭据服务（`$DSH_HOME/.credentials.yaml`），工具返回/HTTP 永不携带。
- **长期记忆** `<工作区>/.whale-craft/`：AI 维护的文档树，会话开始时以提示行注入索引。
- **按工作区配置** `<工作区>/.whale-craft/config.json`：提示词三个开关 + 版本标记；对 MC 模式 AI 只读（与 RULES.md 同一套保护）。

## 代码地图（顶层）

| 位置 | 角色 |
| --- | --- |
| `index.js`（~3.9k 行） | **host 半端入口**：`apply()` 装配一切 —— Config / McSession / Watchdog、29 个工具、HTTP API、提示词注入、MC模式/MC+模式 三档权限策略、归档保护、扩展加载 |
| `presets/*.patch.yml` | 「MC模式」「MC+模式」两个 preset 的**声明式**定义（0.2.0-rc.2+ 注册表；经 `dsh.bundle.patch` 数组随包挂载） |
| `client.js`（~1.8k 行） | **浏览器半端 bundle**（手写 factory，无构建步骤，HMR 热更）：状态条 / MC设置弹窗 / 新会话页 hero 入口 |
| `src/core.mjs`（~2k 行） | `McBot`：mineflayer 封装（连接/重连/动作/观察/协议护栏）；**不依赖 DSH**，可独立测试 |
| `src/*.mjs` | 协作模块（watchdog / memory / config / **wsconfig** / **protected** / accounts / agentsmd / express / **express-server** / image / png / lan / ping / wait / user-message / version-prompt / **resolver-shim** …），全部由 index.js 组装 |
| `tools/` | `check-core.mjs`（静态检查）、`dev.mjs`（隔离调试实例，**本机主用**）、`isolate.mjs`（老方式，需 DSH 源码 checkout） |
| `selfcheck.mjs`（~3.5k 行） | 600+ 条离线断言：假 ctx 加载**真** `apply()`，不连 MC |
| `scripts/` | `publish-npm.mjs`（本机手动发 npm）、`land-workflow-fix.mjs`（工作流文件落地）、`release.workflow.yml`（模板） |
| `extensions/` | 扩展点：丢一个 `.mjs` 进目录即自动加载（契约见 `extensions/README.md`） |
| `cordis.patch.yml` | 插件自带的挂载声明（`package.json` → `dsh.bundle.patch`） |
| `.github/workflows/` | `ci.yml`（三平台矩阵自检 + 打包核对）、`release.yml`（tag → Release → npm 先探再发） |
| `.dev/` | `dev.mjs` 的隔离 DSH_HOME（gitignored；含 `web-instance.json` pidfile） |
| `logs/` | 自检日志（`selfcheck.log`）等，gitignored |

## 文档地图

| 文档 | 内容 | 何时读 |
| --- | --- | --- |
| [architecture.md](architecture.md) | 全局架构、运行时数据流、注入/唤醒/隔离/自举机制、HTTP 面 | 想理解"系统怎么转" |
| [tool-catalog.md](tool-catalog.md) | 29 个工具逐个说明 + 通用约定 | 改/加工具时 |
| [src-modules.md](src-modules.md) | src/ 模块参考：导出、语义、不变式、坑 | 改某个模块时 |
| [client-ui.md](client-ui.md) | 浏览器半端：插槽扩展点、**图标约定**、root vs 会话作用域 | 改 client.js / 加 UI 入口时 |
| [dev-workflow.md](dev-workflow.md) | 本机环境硬约束、隔离铁律、自检、调试、升级敏感点 | **动手前必读** |
| [release.md](release.md) | 发版流程（tag / CI / npm 手动发）—— **发版唯一权威文档**（原根 `RELEASING.md` 已并入） | 发版时 |
| [history.md](history.md) | 版本史、P0 事故档案、设计决策记录 | 想动"看起来奇怪"的代码前 |

## 铁律速查（都是违反过、吃过亏的）

1. 🔴 **调试/测试实例必须独立 `DSH_HOME`**（用 `npm run dev:web`，home 在 `.dev/home`），绝不写用户真实 `~/.dsh` 与工作区；`DSH_HOME` 要**显式**传给每个子进程（两次真事故，见 dev-workflow.md §1）。
2. 🔴 **`agent/pre-step` 是 cordis waterfall，必须调用 `next()`** —— 曾导致"所有模式的所有会话每一轮都失败"（0.1.4 P0）。
3. 🔴 **任何可能永不 settle 的 await 必须套 `withTimeout`/`raceAbort`**（mineflayer 的 dig/place/equip 等是等服务端 ack 的 promise）。宿主无法硬中断（"cannot hard-kill same-process code"），一个卡住的工具会让整轮 turn / 停止按钮 / 插话全部失效。
4. 🔴 **工具必须用 `asTool()` 注册**（自动 lossless + 注入 `exec.signal`）；返回值里混进 Vec3 类实例会让宿主报 "not lossless JSON"，整条工具失败。
5. 🔴 **唤醒/通知一律走"插件提示行"**（`userMessage()`，`source.kind='plugin'`/`form='notice'`），**不许**退回冒充用户来源的 fallback；看门狗在注入前**必须先 `interruptWait()`**（否则 `mc_events{waitSec}` 的等待会把唤醒压到等待结束才投递 —— 0.1.7 修的"等待堵住唤醒"）。
6. 改 `src/core.mjs` / `src/config.mjs` 等大文件后**必跑** `node tools/check-core.mjs`（私有字段一致性会抓"少换行导致 class 提前结束"这类事故）；提交前 `npm run check`（check-core + selfcheck）。
7. 仓库统一 **LF 行尾**（`.gitattributes`）——自检里有大量按行匹配的断言，行尾漂移会红。
8. **事件队列 `sess.events` 的唯一写入方是 `McSession.ensureWired`**；看门狗留档写自己的内存 `watchdog.log`。双写曾是 bug。
9. 工作流文件（`.github/workflows/*`）的落地有 GitHub **workflow scope** 坑 —— 走 Contents API，别硬推（见 release.md §4）。

## 快速验证改动

```bash
node tools/check-core.mjs     # 全树语法 + 动态 import + 私有字段一致性
node selfcheck.mjs            # 600+ 条离线断言（不连 MC 服务器、不碰真实实例）
npm run dev:web               # 起隔离调试实例验证"整树加载"（本机桌面版 DSH）
npm run check                 # = check-core + selfcheck
```

> 改完结构性内容（模块、工具、机制）后，**请同步更新本目录**。
> 本目录（`agent-docs/`）**只给 agent 看、完全由 agent 维护**；需要人看的**底层设计 / 接口参考**放
> [`dev-docs/`](../dev-docs/)（人类和 agent 共维护，如 `prompt/`、`ui/`、`tools/mc-tools.md` 工具参考）。
> 结构性改动两处都要同步（例如工具：本目录 `tool-catalog.md` 速览 + `dev-docs/tools/mc-tools.md` 工具参考）。
