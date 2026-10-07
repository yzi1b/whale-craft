# Whale Craft / 鲸鱼工艺

**[English ↓](#english)** · 中文 · [![CI](https://github.com/yzi1b/whale-craft/actions/workflows/ci.yml/badge.svg)](https://github.com/yzi1b/whale-craft/actions/workflows/ci.yml)

**让 DSH 玩 MC** —— 一个 DSH（DeepSeek Harness）原生插件
把一台无头 Minecraft 机器人（mineflayer）跑在 DSH 进程里，让它进入到MC服务器中，通过工具调用与世界和玩家交互，完成创造、生存任务。

- 🎮 **每会话一个独立机器人**：不同对话可以连不同服务器、用不同账号，互不干扰
- 👀 **看到这个世界**：地形图、高度图，以及方块、实体探索工具，帮助AI了解这个世界
- 🔔 **单代理+看门狗**：使用一个主代理作为“大脑”，使用看门狗接收事件、记录消息。适时唤醒、打断AI，确保助理及时相应发生的各种事件，如玩家召唤
- 🧠 **长期记忆**：`<工作区>/.whale-craft/` 文档树，由助理自动维护，保证工作、冒险的可持续性
- 🖥️ **友好的 UI**：游戏状态条、停止按钮、MC设置，以及一键连接到MC，简单易用
- 🔒 **账户安全**：支持离线账户、第三方皮肤站账户。凭据写在宿主配置中，AI不会直接拿到，使用类似“凭据管理器”的机制进行操作
- 📢 **提示词调优**：插件内置提示词，教会AI如何与AI交互，如何存储记忆等，也提供“建出好建筑”的建议、引导。部分提示词还可自由修改

> ⚠️ **当前为预览版 `0.2.0-beta.2`**
>
> 预览版，面向 DSH **0.2.0-rc.2 及以上**。0.2.0 正式版功能尚未全部完成，本版本先行发布已完成功能，以及支持 DSH 0.2.0-rc.2 和 DSH Desktop。**预览版可能存在未知问题，如遇到请向我们反馈。**
>
> ⚠️ **相对于 0.1 的破坏性变更**
>
> 1. 插件现要求DSH最低版本为 0.2.0-rc.2，不再支持更低版本。*解决方案：将你的DSH升级至 0.2.0-rc.2 及以上版本。*
> 2. 除了MC和MC+模式外，其余模式无法再调用MC游戏相关工具。*解决方案：将需要使用MC工具的会话迁移到MC+模式，找到助手的最后一个回答，点击“方块”图案的“创建MC+分支”按钮。*
> 3. 此前对Minecraft 26.2的临时支持已移除。*解决方案：等待后续版本。MineFlayer支持Minecraft 26.2后，我们会及时跟进。*

---

## 开始使用

1. 创建新对话，选中或新建一个工作区，选择“MC模式”；
2. 点击“连接到MC”按钮，选择好游戏账户，输入服务器地址并点击“连接”，或者点击连接到一个局域网服务器。
3. 在对话窗口下命令，或直接在游戏里聊天。

---

## 要求


| 项   | 要求                                                                    |
| ---- | ----------------------------------------------------------------------- |
| DSH  | 版本`>=0.2.0-rc.2 <0.3.0`                                               |
| Node | ≥ 22（与 DSH  要求一致）                                               |
| 可选 | npm `sharp`（SVG→PNG 光栅化）用于 `mc_kit_image` 的渲染，不影响其它功能 |

---

## 安装

> ⚠️ 需要重启
>
> 无论你从何种方式安装本插件，安装完成后，为保证所有功能正常，务必完全重启DSH实例。

对你的 AI 说：`帮我安装插件 npm:whale_craft@^0.2.0-beta.2`

### DSH 插件管理

在 DSH 主界面找到“插件”，点击打开插件页面，点击“添加插件”按钮，在输入框中输入 `whale_craft@^0.2.0-beta.2`，点击安装。

### 手动安装

本插件的 github 地址为 https://github.com/yzi1b/whale-craft ，npm 包名为 `whale_craft`。

历史遗留原因，npm包名使用下划线，应当注意到仓库名和包名的不同，以免安装错误。

> 此处 profile 以 web 为例。DSH Desktop 的 profile 为 desktop，如果你使用了自己定义的 profile，情况有所不同。

从 github 仓库安装：

```bash
dsh plugin --profile web add github:yzi1b/whale-craft
```

从 npm 安装：

```bash
dsh plugin --profile web add whale_craft@^0.2.0-beta.2
```

别忘了重启DSH。

---

## MC模式 / MC+模式 与权限隔离

> 不止是权限隔离，有限的工具暴露可以让 AI 更专注于 MC 交互。

| | MC模式 |	MC+模式 |
| --- | --- | --- |
| 工具面 | 只提供与MC游戏有关的工具，以及其他必要的工具 |	额外提供标准模式下的所有工具，如运行命令 |
| 文件工具边界	| 只允许操作工作区下.whale-craft 子目录内的文件 |	允许操作工作区所有文件，权限放开后允许操作所有文件 |
| 提示词注入	| RULES.md / 版本提示 / 记忆索引，可选注入工作区 AGENTS.md	| 同上，此外固定注入工作区 AGENTS.md |
| 看门狗 / 长期记忆 / MC设置 |	✓ |	✓ |

除这两个模式外，其他模式不再暴露  MC 游玩相关工具，MC 管理工具除外。

## 落盘位置


| 东西               | 位置                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| 全局配置           | `$DSH_HOME/whale_craft/config.json`                                                                           |
| 账户元数据         | `$DSH_HOME/whale_craft/accounts.json`                                                                         |
| 插件日志           | `$DSH_HOME/whale_craft/logs/whale-craft.log`（可用 `MC_LOG` 覆盖）                                            |
| 会话锁（连服期间） | `$DSH_HOME/whale_craft/.instance.<会话>.json`                                                                 |
| 记忆 / 提示词      | **`<会话工作区>/.whale-craft/`**：`README.md`（AI 维护的总索引）+ `RULES.md`（行事准则）+ 任意文档/图片等文件 |
| 按工作区的配置     | `<会话工作区>/.whale-craft/config.json`（提示词三个开关 + 版本标记；对 MC模式 AI **只读**，MC+ 按宿主默认）   |
| 分享               | `<会话工作区>/.whale-craft/.express/`                                                                         |

> 记忆是**按会话工作区**的，与插件装在哪、DSH 装在哪都无关。

## 开发与自检

```bash
node tools/check-core.mjs     # 全树语法 + 动态 import + 私有字段一致性（改 core.mjs 必跑）
node selfcheck.mjs            # 726 条离线断言（假 ctx，不需要 MC 服务器、不连网）
node tools/check-standalone-import.mjs   # 干净环境回归：pack → 独立目录 install → import 必须成功（慢，CI 跑）
# 起一个隔离 DSH 实例验证"整树加载"（需要一份 DSH checkout）：
DSH_ROOT=/path/to/deepseek-harness node tools/isolate.mjs start
```

`selfcheck.mjs` 覆盖：工具面与参数、每会话实例隔离、超时/中断、放置判据（与 `minecraft-data` 真值表比对）、
看门狗唤醒投递与 job 结算、未签名/系统位置聊天的识别、记忆树读写与路径穿越防护、**发布区的防穿透与真路由**、
**「文件分享」按宿主模式拆键（web=base / 桌面=独立端口）**、base 推导（含反代 `Referer` 一档）、账户库与凭据隔离、配置校验、
提示词注入去重与版本提示、preset 自检与重建、**强制停止的四步顺序**、
依赖面（含"`vec3` 与 `mineflayer` 必须是同一份"这类运行时断言），以及客户端 bundle 的静态检查。

CI 跑的就是这两条（`.github/workflows/ci.yml`）：**ubuntu（Node 22 / 24）+ windows（Node 22）**；
另有一个「打包产物」job，`npm pack` 之后核对 tarball 里该有的文件都在、且没混进 `node_modules` / 日志 / 账户，
再跑一遍 **干净环境回归**（pack → 独立目录 `npm install` → `import('whale_craft')` 必须成功 ——
本机 link 安装永远测不出「宿主包解析不到」，只有干净安装复现得了用户环境，见 issue #5）。

发布走 tag（`.github/workflows/release.yml`）：`git tag v0.1.7 && git push origin v0.1.7` →
先跑上面两条 + 校验 tag 与 `package.json` 版本一致，再 `npm pack` 并把 zip 挂到 GitHub Release
（正文取 `CHANGELOG.md` 里本版本那一节），最后**发 npm**（用仓库 secret `NPM_TOKEN`）。
`npm publish` 前还会自动跑一遍上面两条（`prepublishOnly`）—— **坏树发不出去**。

- 🔴 **npm 那步是"先探再发"**：仓库里配了 `NPM_TOKEN` 才发；**没配就明确跳过**（只发 Release，工作流照样绿）。
  加 secret 的位置：仓库 **Settings → Secrets and variables → Actions → New repository secret**，
  名字必须是 `NPM_TOKEN`，值是 npm 的 Automation token。
- 也可以**在本机手动发**（不依赖任何 secret）：`npm login` 后跑 `npm run publish:npm`
  —— 前置校验、失败即停、默认要确认，细则见 `agent-docs/release.md`。
- **每个版本改了什么**见 [`CHANGELOG.md`](CHANGELOG.md)（`0.2.0-beta.2`：修新 DSH 上装不上 / 跑不起来、
  新增 MC+模式、连接类工具收口；`0.1.7`：修 1.21/1.21.1 进服掉线、断线状态不同步、`mc_events` 等待堵住唤醒；
  `0.1.6`：修皮肤站登录 400；`0.1.5`：修"连不存在的服把整个 DSH 搞崩"、`mc_lan` 只留局域网公告、新增 `mc_ping`）。

---

## 已知限制

- **微软正版登录未实现**（只有离线 / Yggdrasil 皮肤站）。
- **文件分享默认是关的**：AI 画了图只会把**绝对路径**给你，要让它直接在对话里显示，
  得在「MC设置 → 文件分享」里**打开开关**。**配置按宿主模式分两套**（从哪种模式进来就只认哪种）：
  - **web 模式**（`expressWebBase`）：填你访问这台 DSH 用的 `base`（如 `https://example.com`）；
  - **桌面模式**（`expressDesktopPort`，默认 `16049`）：插件自起一个**只监听本机**的独立端口直接托管分享文件，
    地址形如 `http://localhost:16049/<工作区>/<文件名>`；端口被占用时设置页会红字提示，可改端口或恢复默认。
  前端只认绝对 http(s) 图片地址，所以关闭时的本地路径**不会**内联成图（这是设计如此，不是 bug）。
- 文件分享的 `base`（web）/ 端口（桌面）**不做连通性自检**：web 的 base 填错了只有你自己能发现（AI 拿到的 URL 打不开）；桌面端口占用会在设置页红字提示。
- 🔴 **行事准则为什么叫 `RULES.md`**（见上）：`AGENTS.md` 会被 DSH 当工作区指令自动注入到任何碰过该目录的会话，
  与 MC 模式无关 —— 所以这个名字是刻意的。
- 把 `memoryDir` 指到共享目录时，多个工作区会**共用**同一份记忆与 `config.json`（按工作区的设置也随之共享）。
- 工具描述与文档目前是**中文**。
- **能连的 MC 版本取决于依赖里的 `mineflayer`**；想连官方还没支持的新版本，可以自行替换 profile 里的那一份。
- 归档保护依赖宿主内部方法，DSH 升级后可能需要跟进。

## AI 使用

本项目代码由 AI 生成，可能存在未知风险，请谨慎使用。

- 工具：DeepSeek Harness
- 模型：DeepSeek V4.1 Flash

## 许可

MIT（见 `LICENSE`）。第三方组件与许可见 `THIRD_PARTY_NOTICES.md`。

---

## English

**[↑ 中文版](#whale-craft--鲸鱼工艺)**

**Let DSH play MC** — a native DSH (DeepSeek Harness) plugin that runs a headless Minecraft bot
(mineflayer) inside the DSH process, joins a Minecraft server, and interacts with the world and
players through tool calls to build, survive and finish tasks.

- 🎮 **One bot per conversation** — different chats can play on different servers with different accounts, independently.
- 👀 **It sees the world** — terrain and height maps, plus block/entity exploration tools, help the agent understand the world.
- 🔔 **One agent + a watchdog** — a single main agent is the "brain"; the watchdog receives events and logs messages, waking and interrupting the agent at the right moment so it reacts to what happens, e.g. a player calling it.
- 🧠 **Long-term memory** — a document tree under `<workspace>/.whale-craft/`, kept up to date by the agent, so work and adventures continue across sessions.
- 🖥️ **Friendly UI** — a game status chip, a stop button, MC Settings, and one-click "Connect to MC".
- 🔒 **Account safety** — offline and third-party (Yggdrasil) accounts. Credentials live in the host config and are never handed to the model directly, via a credential-manager-style flow.
- 📢 **Tuned prompts** — built-in prompts teach the agent how to interact with the world and how to keep memory, and give advice that guides good builds. Some prompts are freely editable.

> ⚠️ **Preview release `0.2.0-beta.2`**
>
> For DSH **0.2.0-rc.2 and above**. Not all 0.2.0 features are finished; this release ships what is
> done, plus support for DSH 0.2.0-rc.2 and DSH Desktop. **A preview may have unknown issues — please
> report them if you hit any.**
>
> ⚠️ **Breaking changes from 0.1**
>
> 1. The plugin now requires DSH 0.2.0-rc.2 or newer; older versions are no longer supported.
>    *Fix: upgrade DSH to 0.2.0-rc.2 or above.*
> 2. Outside MC and MC+ mode, other modes can no longer call MC game tools. *Fix: move the session
>    that needs them to MC+ mode — find the last assistant reply and click the "box"-icon "Create MC+
>    branch" button.*
> 3. The earlier temporary support for Minecraft 26.2 has been removed. *Fix: wait for a later
>    release; we will follow up once MineFlayer supports Minecraft 26.2.*

---

## Getting started

1. Start a new conversation, pick or create a workspace, and choose **MC mode**.
2. Click **Connect to MC**, pick a game account, enter the server address and click **Connect** — or
   connect to a LAN server.
3. Give orders in the chat, or talk to the bot directly in game.

---

## Requirements


| Item     | Requirement                                                                                  |
| -------- | -------------------------------------------------------------------------------------------- |
| DSH      | version `>=0.2.0-rc.2 <0.3.0`                                                                |
| Node     | ≥ 22 (same as DSH)                                                                           |
| Optional | npm `sharp` (SVG→PNG rasteriser) for `mc_kit_image` rendering; nothing else is affected      |

---

## Install

> ⚠️ **A restart is required**
>
> However you install the plugin, fully restart the DSH instance afterwards so every feature works.

Tell your agent: *"install the plugin `npm:whale_craft@^0.2.0-beta.2`"*

### DSH plugin manager

Open **Plugins** from the DSH main UI, click **Add plugin**, enter `whale_craft@^0.2.0-beta.2`, and
install.

### Manual install

The GitHub repo is https://github.com/yzi1b/whale-craft ; the npm package name is `whale_craft`.
For historical reasons the npm name uses an underscore — note that the repo name and the package name
differ, so you do not install the wrong thing.

> The profile below is `web`. DSH Desktop's profile is `desktop`; a custom profile is different.

Install from the GitHub repo:

```bash
dsh plugin --profile web add github:yzi1b/whale-craft
```

Install from npm:

```bash
dsh plugin --profile web add whale_craft@^0.2.0-beta.2
```

Don't forget to restart DSH.

---

## MC mode / MC+ mode and permission isolation

> Beyond isolation, a limited toolset also keeps the agent focused on MC interaction.

| | MC mode | MC+ mode |
| --- | --- | --- |
| Toolset | Only MC-game tools, plus other necessary tools | Additionally exposes all standard-mode tools, e.g. running commands |
| File tool boundary | Only files under the workspace's `.whale-craft/` | All files in the workspace (all files once permissions are relaxed) |
| Prompt injection | RULES.md / version note / memory index; workspace `AGENTS.md` optional | The same, plus workspace `AGENTS.md` always injected |
| Watchdog / long-term memory / MC Settings | ✓ | ✓ |

Outside these two modes, other modes no longer expose MC-play tools (MC admin tools excepted).

## Where things live


| What               | Where                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| Global config      | `$DSH_HOME/whale_craft/config.json`                                                                           |
| Account metadata   | `$DSH_HOME/whale_craft/accounts.json`                                                                         |
| Plugin log         | `$DSH_HOME/whale_craft/logs/whale-craft.log` (override with `MC_LOG`)                                         |
| Session lock (while connected) | `$DSH_HOME/whale_craft/.instance.<session>.json`                                                   |
| Memory / prompts   | **`<workspace>/.whale-craft/`**: `README.md` (the agent's index) + `RULES.md` (conduct) + any docs/images     |
| Per-workspace settings | `<workspace>/.whale-craft/config.json` (prompt toggles + version marker; **read-only** to the MC-mode agent, host default in MC+) |
| Sharing            | `<workspace>/.whale-craft/.express/`                                                                          |

> Memory is **per workspace** — independent of where the plugin or DSH is installed.

## Development and self-check

```bash
node tools/check-core.mjs     # whole-tree syntax + dynamic import + private-field consistency
node selfcheck.mjs            # 726 offline assertions (fake ctx; no MC server, no network)
node tools/check-standalone-import.mjs   # clean-env regression: pack → install → import must succeed (slow; CI)
# run an isolated DSH instance to check whole-tree loading (needs a DSH checkout):
DSH_ROOT=/path/to/deepseek-harness node tools/isolate.mjs start
```

`selfcheck.mjs` covers: the tool surface and parameters, per-session instance isolation,
timeouts/interruption, placement rules (checked against the real `minecraft-data` table), watchdog
wake-up delivery and job settlement, recognition of unsigned / system-slot chat, memory-tree
read/write and path-traversal protection, **the publish area's traversal defences and real route**,
**the two file-sharing modes and `base` derivation** (including the reverse-proxy `Referer` case),
the account store and credential isolation, config validation, prompt-injection de-duplication and
version notes, preset self-check and rebuild, **the four-step stop sequence**, the dependency surface
(including runtime assertions like "`vec3` and `mineflayer` must be the same copy"), and a static
check of the client bundle.

CI runs exactly these two (`.github/workflows/ci.yml`): **ubuntu (Node 22 / 24) + windows (Node 22)**;
a separate "package" job runs `npm pack` and checks the tarball has the files it should and no
`node_modules` / logs / accounts, then runs the clean-env regression (pack → install in a separate
directory → `import('whale_craft')` must succeed — a local link install can never catch "host packages
not resolvable"; only a clean install reproduces the user's environment, see issue #5).

Releases go through a tag (`.github/workflows/release.yml`): `git tag v0.1.7 && git push origin v0.1.7`
→ run the two checks above + verify the tag matches the `package.json` version, then `npm pack` and
attach the zip to the GitHub Release (the body is taken from that version's section in `CHANGELOG.md`),
and finally publish to npm (using the repo secret `NPM_TOKEN`). `npm publish` also runs the two checks
first (`prepublishOnly`) — **a broken tree cannot be published**.

- 🔴 The npm step "checks before publishing": it only publishes when the repo has `NPM_TOKEN`; **if not,
  it skips explicitly** (Release only, the workflow still goes green). Add the secret at
  **Settings → Secrets and variables → Actions → New repository secret**, name `NPM_TOKEN`, value an
  npm Automation token.
- You can also **publish from your own machine** (no secret needed): `npm login`, then
  `npm run publish:npm` — pre-flight checks, stops on failure, asks for confirmation by default;
  details in `agent-docs/release.md`.
- **What changed in each version** — see [`CHANGELOG.md`](CHANGELOG.md) (`0.2.0-beta.2`: fixes so it
  installs / runs on the new DSH, new MC+ mode, connection tools consolidated; `0.1.7`: 1.21/1.21.1
  disconnect, connection state out of sync, `mc_events` wait blocking wake-ups; `0.1.6`: skin-site login
  400; `0.1.5`: crash on a non-existent server, `mc_lan` kept to LAN announcements, new `mc_ping`).

---

## Known limitations

- **Microsoft (Mojang) login is not implemented** (offline / Yggdrasil only).
- **File sharing is off by default**: the agent only gives you an **absolute path**; to render inline in
  the chat, turn on the switch under **MC Settings → File sharing**. Settings come in **two sets, one per
  host mode** (only the current mode's set is used):
  - **web mode** (`expressWebBase`): set the `base` you use to reach this DSH (e.g. `https://example.com`);
  - **desktop mode** (`expressDesktopPort`, default `16049`): the plugin starts its own **loopback-only**
    port to serve shared files directly, e.g. `http://localhost:16049/<workspace>/<file>`; if the port is
    taken the settings page shows a red hint — change the port or restore the default.
  The frontend only accepts absolute http(s) image URLs, so a local path is **not** inlined (by design).
- File sharing's `base` (web) / port (desktop) has **no connectivity check**: a typo'd web base is only
  noticeable by you (the URL the agent gets won't open); a busy desktop port is flagged in the settings page.
- 🔴 **Why the conduct file is `RULES.md`**: `AGENTS.md` is picked up by DSH as a workspace instruction
  file and injected into any session that touched that directory, MC or not — so the name is deliberate.
- If `memoryDir` points at a shared directory, multiple workspaces **share** one memory and `config.json`
  (and the per-workspace settings with them).
- Tool descriptions and docs are currently in **Chinese**.
- **Which MC versions you can connect to depends on the bundled `mineflayer`**; to connect to a version
  the official one doesn't support yet, replace that copy in the profile.
- Archive protection relies on a host-internal method and may need follow-up after a DSH upgrade.

## AI usage

This project's code is generated by AI and may carry unknown risks — use with care.

- Tool: DeepSeek Harness
- Model: DeepSeek V4.1 Flash

## License

MIT (see `LICENSE`). Third-party components and licences in `THIRD_PARTY_NOTICES.md`.
