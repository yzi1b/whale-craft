# AGENTS.md —— 接手本仓库的 agent 从这里开始

whale_craft 是 DSH（DeepSeek Harness）原生插件：把无头 Minecraft 机器人（mineflayer）跑在宿主进程里，
给模型一套 `mc_*` 工具，并在"值得注意"时唤醒它。**给用户的说明见根 `README.md`。**

## 第一步：读内部文档地图

**动手前先读 [`agent-docs/README.md`](agent-docs/README.md)** —— 那是本仓库内部/开发文档的索引与"铁律速查"，
面向接手本仓库的 AI agent。它列出了代码地图（每个顶层目录/大文件的角色）和文档地图，按需进入各专题：

| 想做的事 | 读 |
| --- | --- |
| 理解系统怎么转（数据流 / 注入 / 唤醒 / 隔离） | `agent-docs/architecture.md` |
| 改 / 加工具 | `agent-docs/tool-catalog.md`（速览）· `dev-docs/tools/mc-tools.md`（工具参考） |
| 改 `src/` 某个模块 | `agent-docs/src-modules.md` |
| 改浏览器半端 / 加 UI 入口 | `agent-docs/client-ui.md` |
| **动手前必读**：本机环境硬约束、隔离铁律、调试 | `agent-docs/dev-workflow.md` |
| 发版 | `agent-docs/release.md` |
| 想动"看起来奇怪"的代码前 | `agent-docs/history.md`（版本史 / P0 事故档案） |

> 内部文档分两处，别放混：
> · `agent-docs/` —— **主要给 agent 看**（人类一般不看），完全由 agent 维护、与项目记忆对齐；写调研/机制/流程/代码地图
>   类文档放这里，并更新其 `README.md` 索引。
> · `dev-docs/` —— 与**底层设计**相关，**人类和 agent 共同维护**（如 `prompt/`、`ui/`、`tools/mc-tools.md` 工具详细参考）。
> 改动了结构性内容（模块、工具、机制）后，**两处相应篇目都要同步**。

## 铁律速查（都是违反过、吃过亏的）

1. 🔴 **调试/测试实例必须独立 `DSH_HOME`**（用 `npm run dev:web`，home 在 `.dev/home`），绝不写用户真实 `~/.dsh` 与工作区。
2. 🔴 **`agent/pre-step` 是 cordis waterfall，必须调用 `next()`** —— 曾导致"所有模式所有会话每一轮都失败"（0.1.4 P0）。
3. 🔴 **任何可能永不 settle 的 await 必须套 `withTimeout`/`raceAbort`**（mineflayer 的 dig/place/equip 等要等服务端 ack）。宿主无法硬中断，一个卡住的工具会让整轮 turn 失效。
4. 🔴 **工具必须用 `asTool()` 注册**；返回值里混进 Vec3 类实例会让宿主报 "not lossless JSON"，整条工具失败。
5. 🔴 **唤醒/通知一律走"插件提示行"**（`source.kind='plugin'`/`form='notice'`），不许冒充用户来源；看门狗注入前必须先 `interruptWait()`。
6. 改 `src/core.mjs` / `src/config.mjs` 等大文件后**必跑** `node tools/check-core.mjs`（会抓私有字段一致性事故）。
7. 仓库统一 **LF 行尾**（`.gitattributes`）—— 自检里有大量按行匹配的断言，行尾漂移会红。

> 完整铁律（含事件队列唯一写入方、workflow scope 坑等）见 `agent-docs/README.md`。

## 快速验证改动

```bash
node tools/check-core.mjs     # 全树语法 + 动态 import + 私有字段一致性
node selfcheck.mjs            # 600+ 条离线断言（不连 MC 服务器、不碰真实实例）
npm run dev:web               # 起隔离调试实例验证"整树加载"（web 用 npm 全局 dsh）
npm run check                 # = check-core + selfcheck
```

## 代码结构（顶层速览）

| 位置 | 角色 |
| --- | --- |
| `index.js` | host 半端入口：`apply()` 装配一切（会话/看门狗/33 个工具/HTTP/提示词注入/权限策略） |
| `client.js` | 浏览器半端 bundle（手写 factory，无构建步骤，HMR 热更） |
| `src/*.mjs` | 协作模块（core = mineflayer 封装，**不依赖 DSH**，可独立测试） |
| `presets/*.patch.yml` | 「MC模式」「MC+模式」两个 preset 的声明式定义 |
| `selfcheck.mjs` | 600+ 条离线断言：假 ctx 加载**真** `apply()`，不连 MC |
| `tools/` | `check-core.mjs`（静态检查）、`dev.mjs`（隔离调试实例） |
| `extensions/` | 扩展点：丢一个 `.mjs` 进目录即自动加载（契约见 `extensions/README.md`） |

详细代码地图见 `agent-docs/README.md`。
