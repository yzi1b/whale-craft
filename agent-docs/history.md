# 版本史、事故档案与设计决策

> 快照：**0.2.0**（开发中，未发布；main 已宣告 0.2.0，距上次发布 0.1.7 多一批未发版改动），2026-10-04。
> 目的：遇到"这代码为什么写得这么绕/这么谨慎"时来这里找答案。每条都有出处（git log / CHANGELOG / 提交历史）。

## 1. 版本史（released）

| 版本 | 日期 | 主题 |
| --- | --- | --- |
| 0.1.0 | 2026-09-16 | 初版：原生 `mc_*` 工具 + 每会话独立实例 + `mc_watch` 唯一事件通道 + MC 模式权限隔离 |
| 0.1.1 | 2026-09-17 | 工具面扩充/修复（含一次不兼容变更） |
| 0.1.2 | 2026-09-17 | 修"0.1.1 里有一条会把整个 DSH 带崩的路径" |
| 0.1.3 | 2026-09-17 | 行事准则更新；修"部分 DSH 版本切不进 MC 模式"；修切出模式后白名单不撤销 / 提示词仍灌普通会话 |
| 0.1.4 | 2026-09-18 | 行事准则第二版（建筑须知）；**P0：pre-step 不交棒**；提示词注入挂点搬家（pre-step）；修"提示词一条都没注入"（dsh-llm 漏依赖）；投递失败不再静默 |
| 0.1.5 | 2026-09-18 | **P0：连不存在的服务器崩整个 DSH**；行事准则第五版（较长思考）；`mc_lan` 只留广播；新增 `mc_ping`；uncaughtException 通道收口 |
| 0.1.6 | 2026-09-19 | 皮肤站登录 400（authenticate 补 Yggdrasil 必填 `agent` 字段） |
| 0.1.7 | 2026-09-20 | 三修：断线状态不同步（三处撒谎）／`mc_events{waitSec}` 堵唤醒／1.21·1.21.1 进服秒踢（协议护栏）+ 幽灵在线 |
| main 未发版 | 2026-09 末 / 10-03 | GitHub issue #1 五处修复（工具组探针静默失效等，版本无关）；`tools/dev.mjs` 调试工具链（`chore: 调试工具`）；26.2 按键上报兼容层整体移除（上游尚无 26.2 数据；详见 F10）；DSH 版本范围声明（engines.dsh + dsh peer）；**0.1 时代死配置/死代码清理**（Config 的 7+2 个无人读字段、`jsonSafe`、`connect` 旧字符串签名、`BUILTIN_AUTH_SERVERS` 别名、patch.yml 的 autoConnect 块）；**插件页中英本地化**（鲸鱼工艺 / Whale Craft + 描述；`locale/*.json` 逐文件 exports——模式写法踩过 `en.json.json` 静默坑）；**按工作区 settings→`config.json`**（提示词三开关从全局下放 + `.rules-version` 迁入删除 + 受保护文件统一"可读不可写"）；**「MC+模式」+ MC模式转声明式 preset**；**issue #5「failed to import」**（见 F11）；**v4 会话 `source.kind` / 看门狗 job owner 修复**（见 F12） |
| 0.2.0-beta.1 | 2026-10-06 | 上表这批未发版大改的首度对外**预览**（MC+/声明式 preset、连接类工具收口、issue #5 修复…）。⚠️ **已知缺陷**：从 npm 安装后 `failed to import`（宿主 resolver bug，见 F14），link 安装不受影响 |

## 2. 事故档案（按主题）

### A. "把整个 DSH 带崩"系（P0）

| # | 现象 | 根因 | 修法 |
| --- | --- | --- | --- |
| A1 | 连一个**不存在的服务器** → 整个 DSH 进程崩溃（0.1.5 前） | 未处理的 Promise rejection —— 宿主 fail-loud 对任何 `unhandledRejection` 直接 `exit(1)` | `statusPing` 改为**永不抛异常**（收敛成 `{ok:false,error,hint}`）；`unhandledRejection` 记录器（最多 5 条）；账户索引刷新 / `persistAuth` / `ensureMcPreset` 等全部显式 catch |
| A2 | 装了某版本后**所有模式所有会话每一轮都失败**（0.1.4 前） | `agent/pre-step` 是 cordis **waterfall**，监听器没调 `next()` | 必须交棒；自检加断言；这段注释就留在代码里（"P0 事故"标记） |
| A3 | 某些错误把 DSH 带走 | `EventEmitter` 无监听者时 `emit('error')` **会 throw** | `#reportError` 只在 `listenerCount('error') > 0` 时 emit |
| A4 | 定时器回调里的异常杀进程 | 宿主只对 unhandledRejection fail-loud；`uncaughtException` 直接杀进程 | `setInterval` 回调自兜异常（看门狗 tick 等）；0.1.5 加"审计探针"再收一道 |
| A5 | 0.1.2 修的一条"把整个 DSH 带崩"的路径（0.1.1 引入） | 见 CHANGELOG 0.1.2 节 | 同上家族 |

### B. 提示词注入系

| # | 现象 | 根因 | 修法 |
| --- | --- | --- | --- |
| B1 | 别人 npm 装出来"工具都在、提示词全无"（0.1.4 前） | `@deepseek-ai/dsh-llm` 没进依赖声明，`createUserMessage` 解析不到 | 依赖声明补上 + `src/user-message.mjs` 自带**等价兜底实现**（永不退回"冒充用户"通道） |
| B2 | 提示词**晚一步**/注入时机不对（0.1.4 前） | 宿主 `preStep()` 先 `inbox.claim()`（把消息领走）**再**跑 `agent/pre-step` 瀑布——塞 `inbox.nextStep` 会晚一步 | 改为在 `agent/pre-step` 里**改写 `decision.messages`**，置于本步最前 |
| B3 | 切出 MC 模式后**提示词再也不投**（0.1.4 前） | 切模式漏清投递台账 | `withdrawAgentsMdNotices` 清队列 + 清台账 + 划 `since` 线 |
| B4 | MC 模式下 `.whale-craft/AGENTS.md` 会在**任何**模式被宿主额外注入 | 宿主把 `AGENTS.md`/`CLAUDE.md` 当工作区指令文件候选，不受插件开关控制 | 行事准则改名 **`RULES.md`**（不在候选名单）；老文件自动迁移 + `.bak` 改名 |
| B5 | 用户投诉："为什么这台服务器上叫 'auth' 的记忆它有？"（2026-09-16） | 默认 `mentionPatterns` 写死了私人账号名/昵称，随开源副本公开 | 默认只放通用叫法；账号名由 `learnName()` 从登录档案**现学**（不进源码） |

### C. 权限隔离系

| # | 现象 | 根因 | 修法 |
| --- | --- | --- | --- |
| C1 | 用户真机投诉："不是只暴露我们指定的工具吗！"——MC 模式里 `pwsh` 照样能用（2026-09-16） | `allowOtherTools` 为空时退化成"只 deny 自家管理工具"的黑名单 | 改成**无条件白名单**（`tools.restrict`）；删掉无意义的 `denyOtherTools` |
| C2 | 切出 MC 模式后白名单不撤销 / 提示词与游戏事件仍灌进普通会话（0.1.3） | 缺少撤销侧 | `liftMcModePolicy`（release restrict + 撤回提示行）；三个钩子（created/session-start/preset-selected）双向对账 |
| C3 | "标准模式没 pwsh"事故 | 撤销时**没撤回提示行**（用户看到的通知残留） | lift 里显式 `withdrawAgentsMdNotices` |

### D. 协议 / MC 版本兼容系

| # | 现象 | 根因 | 修法 |
| --- | --- | --- | --- |
| D1 | 连 1.21/1.21.1 进服成功、**1 秒后被踢**：`Failed to decode packet 'accept_teleportation'`（0.1.7） | `player_input` 包（26.2 加的按键上报）是**无条件**发的，但 1.21/1.21.1 没有这个包；protodef **未知包名不报错**，写出 `02 00 00`（id=0x00 空 body），被服务端当 `accept_teleportation` 解 → DecoderException | `#supportsPacket` 护栏（查 `minecraft-data` 协议表，带缓存；每 tick 复查防重连换版本）；查不到就记日志不发 |
| D2 | "幽灵在线"：被踢后 `bot.entity` 残留 → 死连接被报成"在线"（0.1.7 一并修） | `online` 只看 `entity` | `online` 加"连接没结束"条件（`_client.ended !== true`）；`status()` 标 `ghost:true` + 提示重新 connect；`requireBot()` 明确报错 |
| D3 | 某皮肤站登录一直 400（0.1.6） | `authenticate` 少了 Yggdrasil 必填的 `agent` 字段 | 补 `agent: {name:'minecraft', version:1}` |
| D4 | 离线账户用假 token 做 session join → `ForbiddenOperationException`（2026-09-17 真炸） | 离线模式不该走 session join | `sessionFlags(mode)`：offline 的 `haveCredentials/useAccessToken=false` |
| D5 | 顶号（同账号另开）连接失败 | `already connected|already logged` | 建连 <9s 时最多重试 4 次 × 3.5s |
| D6 | yggdrasil 库新旧回调不兼容 → 悬空 rejection | 老式回调调用方 vs 新 async 库 | `wrapYggdrasilServer` 兼容层 + `takeAuthJoinError` 捞错 |

### E. 状态同步系（0.1.7 集中修）

| # | 现象 | 根因 | 修法 |
| --- | --- | --- | --- |
| E1 | "连接断开了状态没有同步"——`mc_status`/状态条/AI 都以为还连着 | **三处一起撒谎**：core 不 emit 断线、会话不转发、看门狗没这条唤醒项还照旧挂着 | core emit `offline {reason, willReconnect}` → 会话转进事件队列 → 看门狗 `wakeOn.disconnect`（会重连=唤醒说"正在自动重连"；不重连=自动关闭+通知）；前端 `active` 认 `reconnecting`、状态条显示**"重连中…"**、`reconnectPending` 覆盖"正在尝试连接"窗口 |
| E2 | "等到消息也不唤醒，空等特别久"——`mc_events {waitSec:120}` 把唤醒堵住 | 宿主 `agent.steer` 在**下一步 step 边界**消费，而 step 边界要等当前工具返回；等待把正在等的事堵住了 | `src/wait.mjs` 多一条收工条件"被唤醒打断"；看门狗**所有注入前**先 `sess.interruptWait(kind)`；实测打断后 126ms 返回 |

### F. 工程 / 环境系

| # | 事件 | 要点 |
| --- | --- | --- |
| F1 | e2e 清场步骤**把用户刚加的认证服务器删了** | 立隔离规矩：`tools/isolate.mjs`（独立 state/memory + `WHALE_CRAFT_NO_PRESET_WRITE`） |
| F2 | 2026-09-30 `runDsh` 漏传 `DSH_HOME` → 一条 `dsh plugin add link:` **把生产 web profile 的 whale_craft 从 npm 版换成本地 link** | 规矩升级：env 显式传给**每一个**子进程，不依赖继承（见 dev-workflow.md §1） |
| F3 | 2026-09-30 仓库 `.git/` 的**松散文件（HEAD/config/index/hooks/info）全部消失**，只剩 `objects/pack` 与 refs | 已按"`git init` + `symbolic-ref HEAD refs/heads/main` + `remote add origin` + `git reset` 重建 index"恢复，历史一条不丢、`git fsck` 干净；**再犯=坐实是运行时某环节干的**——先抓现场（当时哪个 DSH/IDE 在动这个目录），别急着重克隆（pack 和 refs 通常都在） |
| F4 | 自检在中文用户名路径下 `EPERM: mkdir` 崩（2026-09-24，issue #1 附带） | `new URL(...).pathname` 会把非 ASCII 百分号编码（`%E4%B8%80…`）——自检里一律 `fileURLToPath` |
| F5 | 自建 preset 的工具组补丁**静默失效**（issue #1） | `agentPresets.list()` 是 async、探测时机/来源不对；必须用**同步 `svc.roots` 扫目录**判断"这个部署里有没有那个包" |
| F6 | "假绿"教训 | 集成断言测不到真实现时绿得毫无意义（preset 复制完要改 persona/关 shell 那两条）；有一条断言专门**打真路由**（真机 404 的教训） |
| F7 | `mc_lan` 扫网段被砍（0.1.5） | 用户定性"Windows 很鸡肋"同款逻辑：只保留"听局域网公告"这一件原版的事，恒定按时返回 |
| F8 | 提示词页两条多余提示被删（0.1.5） | "还没到投递时机 / 开关是关的"——UI 别替用户做多余解释 |
| F9 | `mc_kit_share` 被删（2026-09-16） | 它只是在调宿主**另装**的 `dsh-file-host`，不是插件自己的实现；"让用户看到文件"改走宿主 `present` + 本插件 `mc_kit_express`。自检留了"已移除 / 无文件服务器残留"断言防回归 |
| F10 | 26.2 按键上报兼容层（`player_input`）整体移除（2026-10-02） | 上游还连不了 26.2——mineflayer 4.39.0 的 testedVersions 只到 26.1；minecraft-data 3.117.0 只收了 26.2 的**元数据**、没有数据目录（`minecraft-data('26.2')` 为 null）。插件里的该层属于不完整支持 → 代码 + 自检断言整体撤掉，留"已移除"护栏防残代码；将来上游就绪，按 CHANGELOG 0.1.7 的方案（先查后发）重建 |
| F11 | 官方 dsh-desktop / 干净安装上插件 **`failed to import`**（issue #5，2026-10-04） | `index.js` 顶层**静态** import 两个 optional peer（`@deepseek-ai/dsh-tools`/`schemastery`）——包管理器永不装、desktop 上宿主包在 `app.asar` 里喂不进来 ⇒ 模块**链接期**失败（与 B1 的 dsh-llm 漏依赖同族，这次是"包在宿主里但插件解析不到"）。修法：两个包全部**可缺省**（`src/tool-def.mjs` 宿主优先/内置兜底；Config 拿不到 schemastery 就**不导出**、apply 自己兜默认值）。**本机 link 安装测不出来** ⇒ 新增"无宿主模拟"子进程自检 + CI 干净安装回归（已反证：改回静态 import 必红） |
| F12 | v4 会话格式下**提示词注入/看门狗唤醒整轮失败** + 看门狗 job 挂不上（PR #2 @swan3146 的真机实验；2026-10-04 核实并修） | ① `source.kind` 写死 V3 包装值 `'plugin'`，**v4 准入点名拒绝**（规范值 `plugin:whale_craft`，宿主 `createUserMessage` 对 source 原样透传不修正）；② jobs 的 `owner`/`caller` 只认**会话 id 字符串**（`resolveOwner()` 拿它查 agents 注册表 `agents.get(session)`、`assertAccess()` 按 `job.owner.id === caller` 比对）——传 agent 对象 ⇒ job 挂不上（静默降级"无 job 模式"）、kill 被判"别人的 job"。两条都拿 desktop 0.2.0-rc.2 的 `app.asar` 逐字核对过（本机会话文件即 `session.v4.jsonl.zstd`）。修法：两处 source 改 v4 规范值；start/kill/list 全改传 `agent.id`，拿不到 id 不挂无主 job |
| F13 | 部分 DSH 版本上**切不进 MC 模式**：`persona … invalid config: - $text missing required value`（0.1.3） | persona 的"人设正文"字段名**跨 DSH 版本变过**（老版 `text`、新版 `prefix`），而 `ensureMcPreset` 此前写死 `prefix`。修法：键名**跟着该部署自带的源 preset 走**（源用 `text` 就用 `text`），只替换正文值、绝不新增对方 schema 里没有的键；认不出结构就一行都不动并记日志。启动自检对**插件自建的** preset 做键名核对与自动修复（`MC_PRESET_SPEC` 升版会重建），手写/改过的那份一律不碰 |
| F14 | **从 npm/registry 安装（非 link）的插件一律 `failed to import`**、整个不激活；**本机 link 调试却正常**（2026-10-06；issue #5 里 @Pub-Polaris 已顺带点出） | 宿主 `dsh-app-boot` 用 `ResolutionRouter` 补丁了 CJS `Module._resolveFilename`；其 `routeScoped()`（`lib/index.js` 约 1422 行）**对 link 层提前 `routeLinked` 返回、只有非 link 层**才走 `for (const p of createRequire(parent).resolve.paths(name))`。而 `readable-stream@4` 里是 `require('process/')`（**尾部带斜杠**，它留给打包器的写法）——普通 Node 把 `process/` 当内置 `process`，但 `resolve.paths('process/')` 返回 **null** ⇒ `for...of null` 抛 `TypeError: createRequire.resolve.paths is not a function or its return value is not iterable`。插件加载 mineflayer（依赖链含 readable-stream）时即炸 ⇒ bundle 拿不到 fiber、宿主只报一句 `failed to import`（本机 link 安装测不出）。**宿主 bug、与本插件无关**（issue #5 里已单独报给 DSH）。修法：`src/resolver-shim.mjs`（`index.js` 首条 import，必须早于 core.mjs）包一层 `_resolveFilename`，只在该 TypeError 时兜底 |
| F15 | `mc_kit_memory` 被删（2026-10-07） | 与宿主受限文件工具（read/write/edit/glob/grep/read_image，guard 已限在 `.whale-craft/` 内）功能重叠 —— **删工具不删模型**：固定目录、README 索引、每轮索引注入（`memoryIndexText`）全保留，`MemoryStore`（`src/memory.mjs`）与自检单元测试保留。自检改留 "mc_kit_memory 已移除" 断言防回归。已知缺口（等宿主补）：宿主暂无删文件工具、无二进制 `put` |

## 3. 设计决策记录（"为什么这么设计"）

| 决策 | 理由 |
| --- | --- |
| 事件唤醒只走 `mc_watch` **一条通道**、注入是"插件提示行" | 用户明确要求：**提示词注入，不模拟用户发言**。`source:{kind:'plugin:whale_craft',form:'notice'}`（v4 规范值）被宿主渲染成折叠一行；`agent.followup`/queue 类通道写死 `{kind:'user'}`，禁用 |
| 看门狗挂宿主 **job**（`kind:'mc-watch'`，整局存活） | 宿主任务条可见、可被"强制停止"；宿主 kill job → `cancel` → disarm 兜底 teardown，不会留孤儿 |
| 行事准则叫 `RULES.md` 而不是 `AGENTS.md` | 避开宿主对 `AGENTS.md`/`CLAUDE.md` 的自动注入（不受插件开关控制）；改名后注入只剩插件一条、且只对 MC 模式生效 |
| **连接参数全在 `mc_connect` 工具里**，Config 只留行为配置 | AI 按用户指令/记忆决定连哪；Config 无凭据可泄露；旧字段保留为 deprecated fallback |
| 发布区地址用**工作区 uuid** 指代 | 不同父目录下的同名工作区不会撞；目录改名链接不失效；查不到就 404（**不退回目录名**，防猜测） |
| `.out/` 与 `.express/` 分离 | "目录即白名单"：草稿永不对外；要分享必须显式放进发布区 |
| 分享模式砍到只剩 `off`/`online`（砍 `local`） | 前端只认绝对 http(s) 地址，本地路径既点不开也内联不了——留着只会误导 |
| 记忆目录 `create:false`，只在两个时机建 | 不在用户没玩 MC 的普通会话里乱建 `.whale-craft/` |
| `mc_give` 走协议级 `set_creative_slot` | 创造模式即可用，**不需要 OP**；也绕过指令白名单 |
| `mc_sequence` 上限 64 步 | 让模型做"连串动作"比让它写脚本稳；步数上限防失控 |
| 事件队列与看门狗留档**分家** | `sess.events`（AI 拉）/`watchdog.log`（唤醒留档）语义不同；双写曾是 bug，"唯一写入方"写进注释与断言 |
| 按工作区设置统一收进 `<工作区>/.whale-craft/config.json`（2026-10-03） | 提示词三开关原来存**全局**，而「MC设置」弹窗本身按工作区门控、RULES.md 也按工作区 —— 语义错位；版本标记原来是独立 `.rules-version` 文件。合并成一个文件后：保护语义统一为**可读不可写**（与 RULES.md 一致；散落的 `isAgentsMdPath`/PLUGIN_FILES 判定收编进 `src/protected.mjs`）、写入原子（tmp+rename）、坏文件只读不写、未知键保留；旧数据（`.rules-version`、全局旧值）在建档时一次性迁移，**写后回读校验通过才删**旧标记 |
| 「MC模式」「MC+模式」改为包内**声明式 preset**（`presets/*.patch.yml`，经 `dsh.bundle.patch` **数组**挂载） | DSH 0.2.0-rc.2+ 有 preset 注册表：装好即出现在模式列表、用户可用 Web 编辑器按行 id 覆盖组成。工具暴露按 `mcModePresets`/`mcPlusPresets` 判**三档**（其他模式用 `restrict({deny})` 摘掉 `mc_*`/`mc_kit_*` + guard 硬拒双保险，`mc_admin_*` 保留）。旧宿主的目录式自举 `ensureMcPreset` 原样保留（新宿主上 `svc.copy` 不存在 → no-op） |
| `mc_ping` **不用**上游 `mc.ping()`，自己走一遍包序 | 上游 `ping()` ① **不暴露 client**：想在超时时真掐掉连接就得覆盖 `options.connect`，而 `ping.js` 结尾正是 `options.connect(client)` —— 覆盖掉它 = 谁都不建 socket（四种场景全只能干等硬超时）；② 它的超时是 `closeTimeout`，默认 **120 秒**，对一次工具调用太长。改法：用同一套底层（`Client` + `states` + `tcpDns`）自己发握手 + `ping_start`，**超时与清理自控**（默认 5 秒、上限 30；无论成功/失败/超时都 `end()` + `destroy()`） |
| 心跳默认**关**（300s） | 防睡死是可选需求；默认关省 token。开启才走心跳文案 |
| 唤醒矩阵多数"被动"事件默认关（pushed/捡物/上下线） | 太频繁，只留档不唤醒（`mc_watch log` 可看） |
| 超时守卫定时器**故意 unref/不 unref** | `withTimeout` 守卫**不 unref**（否则只剩它跑时进程提前退出）；observer timer 可 unref；`disconnect` 宽限计时器**不 unref**（要等完） |
| 宿主包（`dsh-tools`/`schemastery`）**可缺省**，不塞进 `dependencies` | 塞 dependencies 会在 profile 里装出**第二份** Tool/schema，破坏"全进程单实例"语义（这正是它们当初被改成 optional peer 的原因）；宿主拿不到时用自带等价实现兜底，编译形状与报错文案**逐字对齐宿主**、由"无宿主模拟"自检钉死 |
| `check-core` 抓"私有字段一致性" | 大文件少换行 → V8 提前结束 class → 报误导性错误；`config.mjs` 两行粘连只有动态 import 才炸 |
| selfcheck 末尾恒 `exit(0)`、几乎不用 assert 库 | 设计成"人可读的 ✅ 清单"；只有 apply() 抛错才红——它定位是**回归护栏 + 文档**，不是严苛测试框架 |
| 用 monkey-patch 宿主 `Module._resolveFilename`（`src/resolver-shim.mjs`）绕过 DSH rc.2 的 resolver bug | 宿主 `routeScoped` 对**非 link** 插件的 `require('process/')` 会崩，导致 registry 装出的插件整个不加载；bug 在宿主、我们改不了，而 registry 安装是主要分发方式。shim **只在原函数抛该特定 TypeError 时**兜底、其余请求逐字透传；属临时手段，宿主修好后删除（见 F14 与 §4 待办） |

## 4. 待办 / 已知边界

- 微软正版登录未实现（只有离线 / Yggdrasil）。
- 归档保护依赖宿主内部方法（`workspaceRegistry.archiveSession`）——DSH 升级需跟进。
- online 分享模式的 `base` 不做连通性自检（填错只有用户能发现）。
- `mc_move/mc_act/mc_build` 官方定性"不成熟"（版本硬提示词里让 AI 优先 `mc_command`）。
- 工具描述与文档目前中文。
- 能连的 MC 版本取决于依赖里的 mineflayer（想连新版本可自行替换）。
- **🔴 待办（等 DSH 修好 F14 的 resolver bug 后）**：删掉 `src/resolver-shim.mjs` + `index.js` 首条 `import './src/resolver-shim.mjs'`（连同 `src-modules.md` §16b 与本节这条），并记一条 CHANGELOG。判据：**registry（非 link）安装的插件加载 mineflayer 不再 `failed to import`**。
