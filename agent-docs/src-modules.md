# src/ 模块参考

> 快照：**0.2.0**（开发中，未发布）。所有模块都是纯 ESM，**只有 config.mjs 引了 express.mjs 一处模块间依赖**，其余全部由 `index.js` 组装。
> 通用规矩：任何可能永不 settle 的 await 套 `withTimeout`/`raceAbort`；日志走 `logLine()`。

---

## 1. `src/core.mjs` —— McBot（mineflayer 封装，不依赖 DSH）

**导出**：`McBot`（default 也是它）、`Vec3`、`DEFAULTS`、`TIMEOUTS`、`DEFAULT_COMMAND_WHITELIST`、`withTimeout`、`raceAbort`、`lossless`、`glyphOf`、`logLine`、`libraryInfo`、`sessionFlags`、`takeAuthJoinError`、`wrapYggdrasilServer`、`friendlyAuthError`。

### 工具函数

- `withTimeout(promise, ms, label)`：race 守卫定时器**故意不 unref**（否则只剩它跑时进程提前退出）；超时错误带 `mcTimeout:true`。
- `raceAbort(promise, signal, label)`：给 await 接 abort（宿主 cancel 不杀同进程 promise）；错误带 `mcAborted:true`。
- `lossless(value)`：宿主工具返回值校验要求纯 JSON（原型必须是 `Object.prototype`/null，不允许 `-0`）。类实例只留自有可枚举属性、Vec3→`{x,y,z}`、Date→ISO、Map/Set 展开、循环→`'[circular]'`、NaN/±Inf→null。
- `logLine(...)`：独立落盘（无实例也能用），前缀 `[whale_craft HH:MM:SS]`，写 `DEFAULTS.logFile`（默认 `$DSH_HOME/whale_craft/logs/whale-craft.log`，`MC_LOG` 可覆盖；**不写包目录**）。
- `libraryInfo()`：报 mineflayer 版本 / testedVersions / minecraft-data 版本，不连服。
- `sessionFlags(mode)`：离线账户 `haveCredentials/useAccessToken=false`（假 token 做 session join 会 `ForbiddenOperationException`，真炸过）；yggdrasil=true。
- `wrapYggdrasilServer` / `takeAuthJoinError` / `friendlyAuthError`：yggdrasil 库新旧回调兼容层 + 认证错误转"可执行的人话"（`needUserAction:true`）。

### McBot 类

- 构造：`{...config, instanceId}`；字段含 `bot/sub/connecting/connectedAt/lastError/autoReconnect/reconnectDelay/reconnecting/reconnectPending/chat/stopped/lastTimeout/abortSignal/stats{connects,deaths,chats,lastEventAt,timeouts}`。
- **`online` getter** = `bot.entity 存在 && _client.ended !== true` —— 幽灵在线的判据（见下）。
- `connect(opts)`：参数 `{host, port, auth, onAuth}`；`auth` 是**唯一凭据入口**（`{mode:'offline'|'yggdrasil', username, password?, server?...}`），绝不出现在任何返回值。2026-10-05：`subserver`/`version` 已删（版本永远自动探测；连上后不在支持范围则断开抛错）。细节：
  - 已在线且同 sub+host → 直接返回；并发 connecting → 等同一个 promise；
  - 顶号（`already connected|already logged` 且建连 <9s）最多重试 4 次 × 3.5s；失败**保留原连接**；
  - yggdrasil 才设 `sessionServer`；`fakeHost: sub` 过 HAProxy 子服路由；等 spawn 超时 `connectTimeoutMs`（45s）。
- **重连**：延迟 5s 起、失败翻倍上限 60s、成功复位；`reconnecting` 只覆盖两次尝试间窗口，`reconnectPending` 覆盖**整个断线期**（直到真重连成功/手动 connect 成功）。
- **`offline` 事件**（`b.on('end')` 里 emit）：`{sub, reason: lastError ?? '连接结束', willReconnect, at}`；`willReconnect = autoReconnect && bot===b && !stopped`。**断线必须进上层队列**（0.1.7 修）。
- `disconnect(reason)`：停重连/观察器 → `quit()` 宽限 3s（计时器故意不 unref）→ 没走掉才强断；返回 `{graceful,forced,ms}`。`authOnly()`：只认证不连接（账户 refresh 用）。
- **事件清单**：`spawn {sub,position,gamemode}`、`offline`、`reconnect {sub}`、`death {position}`、`damage {health,position}`（health≤6）、`chat {who,text}`（不含自己；1.5s 同人同文去重）、`system {text}`、观察器 `playerJoin/playerLeave {who}`、`teleport`（>24 格/秒）、`pushed`（≥2 格且非自移）、`pickup {items}`、`log`。
  - ⚠️ **core 没有 `heartbeat` 事件** —— 心跳是看门狗配置项，靠 `stats.lastEventAt` 判。
- **聊天识别**（`wireChatEvents`/`#playerChatFrom`）：`player_chat` 包（签名）直接处理；`message` 事件里 `position==='chat'` 跳过防重复；`game_info` 必 system；其余先试玩家聊天判据（`chat.type.text` / `chat.type.team.*` / `commands.message.display.incoming` / 兜底渲染形状正则 `<who> text`）——覆盖"被服务端塞进 system 位置的玩家聊天"。
- **按键上报兼容层（`player_input`，为 26.2 加的）已于 2026-10-02 整体移除**：上游还连不了 26.2（mineflayer 4.39.0 的 testedVersions 只到 26.1；minecraft-data 3.117.0 只有元数据、无数据目录），半吊子支持先撤。将来重建**必须**沿用"先查后发"护栏——教训见 [history.md](history.md)（protodef 对未知包名不报错，写出 `02 00 00` 会被服务端当 `accept_teleportation` → 秒踢）。
- **动作方法**（全部经 `#t()` 超时包装，超时/中断自动松 7 个控制位）：`walkTo`（arrive 1.6、|dy|≤1.5、一直按 forward、1.2s 无进展跳）、`flyTo`（仅创造，finally 必 `stopFlying` 恢复重力）、`dig`（自动换收割工具）、`placeBlock`（判据链：选块→缺货自动给→距离>5.5 直接抛"够不着"→目标必须 `canPlaceInto`（boundingBox 'empty'，水/岩浆/草花可放）→ 找 6 邻域参照→**复验 `blockAt` 才报 placed**）、`breakBlock`（复验 `now!==name` 才报 broken）、`build`、`giveItem`（协议级 `creative.setInventorySlot`）、`clearInventory`、`useBlock`、`attack`、`tossItem`、`runSequence`（≤64 步，见工具表）、`command`（必须 `/` 开头，带 allow 回调）、`chatSay`。
- **观察**：`scan` / `heightmap`（R≤96）/ `mapImage`（RGBA，白框标自己）/ `entities` / `inventory` / `waitForChunks`（默认 20s；`blockAt` 脚下出现即算到）/ `status()`（含 ghost 特判）/ `connectionView()`（只出 host/port/**version**，不带账号）/ `context({survival})`（游戏上下文）/ `players()`（tab 名/档案名/uuid）/ `heightGrid·heightImage·heightGlyphs`（mc_height 高度/地势图；`surfaceY` 单列地表 Y）。
- **错误纪律**：`#reportError` 是唯一错误上报口 —— 记 lastError+日志，**仅在有 listener 时才 emit('error')**（EventEmitter 无监听者 emit('error') 会 throw，曾把整个 DSH 带走）。
- 不变量：`setInterval` 回调必须自兜异常（宿主只对 `unhandledRejection` fail-loud，`uncaughtException` **直接杀进程**）；`_selfMovingAt` 用于把自走/自飞从 teleport/pushed 误判中排除（3s 窗口）。

## 2. `src/wait.mjs` —— waitForEvents

- 参数 `{sess, from, kind=null, waitSec=0, signal=null, pollMs=250}`（`now`/`sleep` 可注入，供测试）。
- 返回 `{waitedMs, interrupted, reason}`。收工条件按序检查：① `signal.aborted` → `reason:'用户停止'`（interrupted:false）；② `sess.waitInterruptedAt > startedAt` → `interrupted:true, reason: waitInterruptReason`；③ 新事件出现 → `reason:'有事件'`；④ 超时 → `reason:null`。
- **存在的理由**：宿主 `agent.steer` 在**下一步 step 边界**消费，而 step 边界要等当前工具调用返回 —— 没有打断机制时，`mc_events{waitSec:120}` 会把看门狗的唤醒文案**压到等待结束**才投递（"等待堵住了它正在等的那件事"，0.1.7 事故）。

## 3. `src/watchdog.mjs` —— 单脑看门狗

**导出**：`Watchdog`、`WATCH_DEFAULTS`。

- 构造 `{ctx, sess, agent, promptSignal}`（promptSignal **必传**，`sessionController.prompt` 是 @Remote）。
- `arm()` 幂等：`learnName(sess.bot.username)`（**从登录档案现学游戏名**，不写进源码——防私人名字随开源副本泄露）→ 绑 bot 事件 → `#startJob()`（宿主 jobs，`kind:'mc-watch'`，`owner:agent`；无 jobs 服务降级"无 job 模式"）→ 1s `setInterval(#tick)`。
- `disarm(reason, {notify, fromJob})`：先 teardown，再把 job 结算（**幂等**，只结算一次；`readOutput` = 留档末 30 条）；`notify` 时注入"你已经不在 MC 里了…"。自动关闭时机：offline 且不重连 / `mc_disconnect{notify}` / stopSession / 会话 destroy / 宿主 kill job（`fromJob:true`）。
- **唤醒矩阵**（`wakeOn`，`mc_config` 可改）：

| 项 | 默认 | 判定 | 文案要点 |
| --- | --- | --- | --- |
| `mention` | ✅ | `calledBy()` 正则命中 `mentionPatterns` | `[有人喊我] who text ← 命中叫法` |
| `nearbySpeech` | ✅ | hypot ≤ `nearRadius`(16) | `就在我旁边` |
| `damage` | ✅ | damage 事件 | `血量降到 N` |
| `death` | ✅ | death 事件 | `我死了` |
| `teleport` | ✅ | teleport 事件 | `位置瞬移 N 格` |
| `pushed` | ❌ | pushed 事件 | `被动移动` |
| `itemPickup` | ❌ | pickup 事件 | `捡到 …` |
| `playerJoin` / `playerLeave` | ❌ | 对应事件 | `who 上线/下线了` |
| `disconnect` | ✅ | offline 且 willReconnect | `连接断了（reason）——正在自动重连…` |
| `heartbeat` | ❌ | 距上次唤醒 ≥ `heartbeatSec`(300) 且在线 | `【心跳｜已挂机 Ns】` |

- 同话题延续：唤醒后 `topicWindowSec`(120s) 内的发言**直接算 mention**。命中进 `pending` 攒 `observeWindowMs`(2s) 合并 → `#flush` 过 `maxWakePerMinute`(6) 限流 → 一条 `【MC 看门狗｜标签】` 正文注入。另有 `followUpAfterSec`(45)：唤醒后 45s 无下文补提醒一次。
- **`#inject`（唯一注入口）**：① gate（非 MC 模式只记账 drop）；② **先 `sess.interruptWait(kind)`**；③ 首选 `agent.steer(userMessage(...))`（`source:{kind:'plugin:whale_craft',form:'notice'}`——v4 规范值，宿主渲染成折叠一行；空闲时起一轮、运行中下一步插话）；④ 兜底 `sessionController.prompt({mode:'steer'}, promptSignal)`。**绝不用** `followup`/queue 类"冒充用户发言"的通道。
- 留档 `this.log`（内存，上限 200，`#record` 是唯一写入点）—— 与 `sess.events` 分开，双写曾是 bug。

## 4. `src/memory.mjs` —— MemoryStore（记忆树）

- 构造 `(root, {create=true})`；**生产用 `create:false`**：目录只在两个时机建（首次 MC 模式会话 / 点开 MC设置，`ensureMemoryRootCwd` + `seededRoots` 去重）。
- 常量：单文件文本 256KB、图片 16MB、最多 2000 文件、深度 ≤5、段名 `^[\w.\-一-龥 ]+$`。
- **`safePath(rel)` 是路径安全关口**：拒空/绝对路径/盘符/`.`/`..`/深层/超长/非法段，`resolve` 后必须仍在 root 内。**不再做文件名封锁** —— 根级的受保护文件（RULES.md/AGENTS.md/config.json，见 src/protected.mjs）在这里**放行（读允许）**，结果带 `protected:true`，由写类方法显式拒绝（用户 2026-10-03：可读不可写）。
- 方法：`ensureRoot/ensureReadme`（骨架只建一次）· `pathFor({topic,server})`（server 缺省 `_global/`；无扩展名补 `.md`）· `list()`（根级 README 与受保护文件不算记忆；解析标题/条目数/摘要）· `renderTree()`/`indexText()`（5s 缓存；注入用 = README 正文 + 目录树）· `read()`（文本→content；**图片→附件**（工具层 `attachments.saveImage`）；二进制→元信息）· `put()`（**把工作区任意文件复制进记忆**，16MB，name 清洗）· `append({text,key})`（单条 ≤4000 字；同 key 正则替换旧 bullet）· `write()`（整文件覆盖，拒图片）· `delete()` · `search()`（跨文本文件逐行，limit ≤100）· `overview()`。
- `append/write/delete/put` 对 `protected` 目标一律抛"只读"（`protectedWriteError`）。写后清 `_textCache`（投递的索引恒新）。⚠️ `list()` 只跳过**根级**的 README 与受保护文件，`.out/`/`.express/` 会被遍历进去（未专门跳过）。
- 🔴 **工具 `mc_kit_memory` 已于 2026-10-07 移除**：agent 改用宿主受限文件工具（read/write/edit/glob/grep/read_image）直接读写 `.whale-craft/`。本模块**保留为库**——`put/append/write/delete/search/overview/read` 不再有生产消费方，仍由自检单元测试直接覆盖；`read()` 的图片附件化接线随工具移除（看图改由宿主 `read_image` 承担）。

## 5. `src/agentsmd.mjs` —— RULES.md 行事准则

- 路径：`agentsMdPath(dir)=<记忆根>/RULES.md`；`legacyAgentsMdPath`（老 AGENTS.md，只用于迁移/守卫）。
- `DEFAULT_AGENTS_MD`（默认准则）小节：宗旨 / 称呼 / 记忆 / 边界信息 / 登录游戏 / 看门狗 / 聊天 / 建筑须知 / 较长思考 / 硬规矩。
- `migrateLegacyAgentsMd`：老 `AGENTS.md` → 内容搬进 RULES.md，原文件**改名**为 `AGENTS.md.bak-<时间戳>`（不删：内容不丢、宿主不再认）；幂等。
- `readAgentsMd`（`source` 按内容是否逐字等于默认判 `default/custom`）；`writeAgentsMd`（空拒；≤128KB）；`resetAgentsMd`（**把默认写回文件**而非删除）。
- 路径守卫（原 `isAgentsMdPath`）已**移出**到 `src/protected.mjs`（与 config.json 统一判定）。
- `syncRulesVersion(dir, version, {follow})`：无文件→建默认+`created`；有文件无版本记录→只记版本 `marked`（**不覆盖**）；版本变+follow 开→替换为默认 `replaced`；follow 关→只更新记录 `kept`（以后打开**不翻旧账**）。版本读写走 `src/wsconfig.mjs` 的 `readRulesVersion/setRulesVersion`（存 `<记忆根>/config.json` 的 `rulesVersion` 字段；旧 `.rules-version` 标记由 wsconfig.migrate 迁入后删除）。

## 6. `src/version-prompt.mjs` —— 版本硬提示词

- 导出 `versionPromptText/versionPromptHash/versionPromptTitle/versionPromptSource`。哈希 = 正文 sha256 前 8 位（只标正文；正文**不含版本号**，跨版本稳定）。
- 正文两条：① 本版本 `mc_move/mc_act/mc_build` 不成熟 → 优先 `mc_command`（`/tp` `/setblock` `/fill` `/clone`），被拒再回退；② 本版本生存/冒险能力极弱 → 先明确告知用户再尽力（已有记忆优先按记忆行事）。
- **不可编辑、无开关**（硬编码随版本发布）——与 RULES.md（Master 维护）、记忆（玩出来的经验）三分工。

## 7. `src/user-message.mjs` —— 插件提示行构造

- `userMessage(input)`：宿主 `@deepseek-ai/dsh-llm` 的 `createUserMessage` 优先；解析不到/异常 → `builtinUserMessage`（自带等价实现：`{role:'user', content, source:{kind:'plugin:whale_craft'}, id}`）。
- `messageFactoryKind()`：诊断 `'host'|'builtin'`。
- ⚠️ 存在理由：0.1.4 时该包漏进依赖声明 → 别人 npm 装出来"工具都在、提示词全无"。**依赖声明不能少**，兜底只是保险。
- 🔴 `source.kind` 必须是 **v4 规范值 `plugin:whale_craft`**（v4 会话格式拒绝裸露的 `'plugin'`；宿主对 source 原样透传）——2026-10-04 按 PR #2（@swan3146）的真机实验 + 宿主 `dsh-session-format-v3-to-v4` 源码核实。

## 8. `src/config.mjs` —— 配置 + preset 规划

### DEFAULT_CONFIG（键 → 默认 → 含义）

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `commandWhitelist` | 22 个指令名 | `mc_command` 放行；支持精确名 / `/正则/flags` / `"*"` |
| `mcModePresets` | `['minecraft','minecraft-plus','whale_craft']` | "MC 类模式"判据（含 MC+；`whale_craft` 为历史名单项） |
| `mcPlusPresets` | `['minecraft-plus']` | 其中哪些是 **MC+ 变体**（开放标准模式全部工具；须同时 ∈ mcModePresets） |
| `mcMode.allowOtherTools` | `[]` | MC 模式白名单**额外**放行（只能收窄，不能凭空加；MC+ 不适用） |
| `mcMode.hideAdminTools` | `true` | 隐藏 `mc_admin_*`（仅 MC 模式；MC+ 可见；另有 guard 硬拒） |
| `memoryDir` | `null` | null = `<工作区>/.whale-craft` |
| `allowAllCommands` | `false` | 指令白名单总开关 |
| （提示词三开关 `injectWhaleCraftAgentsMd` / `injectWorkspaceAgentsMd` / `rulesFollowVersion` **已下放为按工作区**，存 `<工作区>/.whale-craft/config.json`，见 [§14 wsconfig](#14-srcwsconfigmjs--按工作区的配置)） | | |
| `ensureMcPreset` | `true` | 旧宿主遗留：目录式自举「MC模式」（0.2.0-rc.2+ 由 `presets/*.patch.yml` 声明提供，此键 no-op） |
| `expressWebEnabled` | `false` | **web 模式**文件分享开关 |
| `expressWebBase` | `''` | **web 模式**的访问 base（如 https://example.com） |
| `expressDesktopEnabled` | `false` | **desktop 模式**文件分享开关 |
| `expressDesktopPort` | `16049` | **desktop 模式**的独立托管端口（只监听 localhost） |
| `exposeDebugTools` | `false` | 「MC设置 → 调试」页的「开放助手调试工具」开关（工作区无关）：是否向助手暴露调试用途的工具 |

- `PluginConfig`：`load`（坏配置不崩、记 `lastError` 按默认跑；**顺带跑 `migrate()`**）、`set` 只认 `TOP_KEYS`（= DEFAULT_CONFIG 键）且过 `validate`、`values()` 深合并（数组整体覆盖）；语义 getter（`mcModePresets/mcPlusPresets/memoryDir/expressWebEnabled/expressWebBase/expressDesktopEnabled/expressDesktopPort/commandAllowed/isMcModePreset/isMcPlusPreset`…）每次现读 ⇒ **改完热生效**。
- `migrate()`：文件分享键逐档搬（都**删旧键**、只在真改动时落盘）——① 老 `expressMode: 'off'|'online'`（曾含 `'local'`）→ `expressWebEnabled`（`online`→`true`，其余→`false`）；② 2026-10-07 拆键：`expressEnabled`→`expressWebEnabled`、`expressBase`→`expressWebBase`。
- `legacyPromptSwitches()`：从**文件原值**里取旧版全局存过的三个提示词开关（只取显式设过且类型合法的）—— 只作工作区建档时的一次性 seed 来源（消费方 index.js → `wsconfig.migrate`）。
- `resolveStateDir`：`WHALE_CRAFT_STATE_DIR` → `WHALE_CRAFT_DIR`+whaleDir → `$DSH_HOME/whale_craft` → `~/.dsh/whale_craft`。

### preset 规划（纯函数；**遗留** —— 只服务旧宿主的目录式自举；0.2.0-rc.2+ 由包内 `presets/*.patch.yml` 声明，见 architecture §8）

- `PRESET_ID_RE=/^[a-z0-9][a-z0-9-]*$/`（与宿主同名规则；下划线非法 ⇒ 目标 id 不能叫 whale_craft）。
- `MC_PRESET_SPEC=7`：规格版本，**改动 = 下次启动重建自建 preset**；`planPresetAction` 判定序：不存在→`create`；非本插件建的→只在简介是复制残留时 `meta` 否则 `leave`；无 compositionHash→只敢 `meta/leave`；spec 变→`rebuild`；组成被用户改过（hash 不符）→`leave`；官方源变了（源 hash 变）→`rebuild`；显示文本不对→`meta`。
- `pickPresetTarget`（取 `mcModePresets` 里第一个合法的）/ `PREFERRED_PRESET_SOURCES=['minimal','standard','ptc']` / `pickPresetSource` / `isCopiedPresetDescription`。
- `PERSONA_TEXT_KEYS=['prefix','text']` + `personaTextKeyOf`：跨 DSH 版本探测 persona 键名。
- `patchPersonaInComposition`（换 persona 正文；`complete:true→false`、`includeRuntimeContext:false→true`，后者会压掉其它提示段）、`disableShellInComposition`（persistent-shell `disabled:true`）、`patchToolGroupsIntoComposition`（`MC_PRESET_TOOL_GROUPS`：`tool-fs`/`tool-jobs`/`present`/`compaction`）。

## 9. `src/accounts.mjs` —— 账户与凭据

- **存储分离**：元数据 `$DSH_HOME/whale_craft/accounts.json`；凭据（password/token/clientToken）**只进宿主凭据服务**（`ctx.credentials`，key=`whale-craft/<innerID>` → `$DSH_HOME/.credentials.yaml` owner-only）。凭据服务不可用 → **直接抛错拒绝，绝不降级写明文**（MC agent 手里有 read 工具）。
- 类型：`offline` / `yggdrasil`（第三方皮肤站，authlib-injector 风格）/ microsoft（`add` 抛"暂不支持"）。
- 工具函数：`offlineUuid`（复刻 Java `UUID.nameUUIDFromBytes("OfflinePlayer:<name>")`：md5+v3+variant）、`dashUuid`、`normalizeServerUrl`、`parseAuthlibCard`（解析 `authlib-injector:yggdrasil-server:<urlencoded>` 卡片/裸网址，raw 与 decode 各试一次）。
- `AccountStore`：`load`（坏库降级空库记 `loadError`）/`save`/`ensureDefaults`（`seeded` 标记**只种一次**：预置 LittleSkin 认证服 + 默认离线账户 `DeepSeek`，可删且不长回）/`view`（**绝不含密码/token**）/`add/update/remove`（remove 连带删凭据并让渡默认）/`search`/`resolve`。
- 凭据方法：`setCredential`（`kind:'grant'` payload）/`getCredential`（**仅内部登录流程**）/`deleteCredential`/`refreshCredentialIndex`（宿主 credentials `listRecords` 是同步的）。
- 认证服务器：`listAuthServers/addAuthServer/renameAuthServer`（id 永不变）/`removeAuthServer`（被账户占用拒删）。网络登录本身在 core.mjs（yggdrasil 流程），本模块只承载元数据/凭据脚手架。

## 10. `src/express.mjs` —— 发布区（纯函数，不碰 fs）

- 常量：`EXPRESS_DIR='.express'`、`OUT_DIR='.out'`、`EXPRESS_URL_PREFIX=/api/whale-craft/express`、`WORKSPACE_ID_RE`。
- `parseExpressPath`：要求**已解码**的 pathname（`%2e%2e` 先还原成 `..` 才可判）；首段 workspaceId 过正则，其后 ≥1 段。
- `safeExpressTarget(root, segments)` 逐段拒：空段/`.`/`..`/含 `/` 或 `\`/盘符/`~` 开头/控制字符/段 >255；拼完复查仍在 root 内（纵深防御，真正兜底是路由层 `realpath`）。
- `mimeOf`（全扩展名放行，未知 octet-stream）、`SANDBOX_TYPES`（svg/html/xml/js → CSP sandbox 头）。
- `normalizeExpressBase`（必须 http(s)、去尾斜杠、非法 null）、`onlineUrlOf`、`expressRefFor`（abs 必须落在 `.express/` 下，`.out` 文件返回 null；产出 `{rel, url, localPath, markdown}`——`url`=含 `EXPRESS_URL_PREFIX` 的 web 形态，`localPath`=`/<uuid>/<rel>` 供 desktop 拼 `http://localhost:<port>`）、文案常量 `EXPRESS_OFF_TEXT` / `EXPRESS_NEED_BASE_TEXT` / `EXPRESS_PORT_BUSY_TEXT(port)`（逐字：自检断言原文）。
- **桌面独立端口**：`DEFAULT_EXPRESS_PORT=16049`、`EXPRESS_HOST='127.0.0.1'`、`isExpressPort` / `normalizeExpressPort`、`parseExpressLocalPath(pathname)`（解析 `/<uuid>/<seg…>`，**无** `/api/…` 前缀）。

## 10b. `src/express-server.mjs` —— 桌面模式的发布区独立端口

- `ExpressShareServer`：`start(port)`（先 `stop()` 再绑 `127.0.0.1`，**尽力**再补 `::1`；**只绑回环**）、`stop()`、`status`=`{listening, port, wantPort, error}`。出错（EADDRINUSE/EACCES…）**不抛**，落 `error`。
- `hostIsLoopback(host)`：最小 Host 回环栅栏（防 DNS-rebinding，外部域名解析到 127.0.0.1 也拒）→ 403。
- `portAvailable(port)`：一次性 bind+close 探测（`/api/mc/express/port` 用；当前已监听端口由调用方特判为可用）。

## 11. `src/image.mjs` + `src/png.mjs` —— 图像

- `image.mjs`：`sharp` 是**可选依赖**（`createRequire` 懒加载）；`imageEngineAvailable()/imageEngineError()`；缺失时 `need()` 抛"图像引擎不可用（sharp 解析失败：…）"，**不静默假装成功**。`ImageEngine`：`info` / `embed`（图片→data URI + `<image>` tag，引图进 SVG）/ `render`（SVG→PNG，density×scale，scale 夹 0.05-16）/ `grid`（≤64 张拼网格，**返回 SVG 文本**可继续编辑）/ `save`。
- `png.mjs`：零依赖 RGBA8 PNG 编码器（color type 6、8bit、filter 0、deflate 9）；`encodePng(width,height,rgba)`。用途：`mc_map` 出真地形图时避免给宿主多加原生依赖。

## 12. `src/lan.mjs` —— 局域网公告监听

- `LAN_BROADCAST={group:'224.0.2.60', port:4445}`；`parseLanBroadcast`（`[AD]…[/AD]` 取 1-65535 端口，`[MOTD]` 可选）。
- `listenLanBroadcast({seconds=3})`：udp4 + reuseAddr 绑 4445 → `addMembership`（禁多播环境**静默降级**为只听本机广播）；按 `host+port` 去重；时长夹 [0.5, 15]s；**错误/超时全 resolve 空数组、绝不 reject**；`timer.unref`。**只被动听，不扫端口**（2026-09-18 砍掉扫网段）。

## 13. `src/ping.mjs` —— STATUS ping

- 协议栈锚点：`requireFromMineflayer` 从 mineflayer 自己的依赖树 `require('minecraft-protocol')`（与 mc_connect 同栈同版本表）。
- `parseAddress`（默认 25565；认 `host`、`host:port`、`[::1]:25565`；裸 IPv6 抛错）；`formatAddress`（**逆操作**：IPv6 加方括号、默认端口省略）；`flattenMotd`（拍平 + 去 `§` 色码）；`friendlyNetError`（ECONNREFUSED/ETIMEDOUT/ENOTFOUND/… → 人话；`unsupported protocol` → 建议手填 version）。
- `statusPing({host, port, timeoutMs, fakeHost, version})`：**永不抛异常**（P0 教训：一切 reject/超时收敛成 `{ok:false, error, hint}`）。流程：不用上游 `mc.ping`（不暴露 client、超时 120s），用 `minecraft-protocol` 原语自建：握手（nextState=1）→ STATUS → `ping_start` → 收 `server_info` → 写 `ping` 量往返延迟 → 无论成败 `client.end()+socket.destroy()` 防挂 socket。硬超时夹 [1s,30s] 默认 5s；成功返回 `{ok:true, elapsedMs, handshakeMs, statusMs, latencyMs, version, protocol, players{online,max,sample≤12}, motd, motdRaw, hasFavicon}`。

## 13b. `src/serverhistory.mjs` —— 「连接到MC」的服务器地址历史（全局）

- 落盘 **`<状态目录>/servers.json`**（`$DSH_HOME/whale_craft/`）——**全局**，不按工作区；形态 `{version:1, recent:[addr…]}`。
- `ServerHistory({dir})`：`list()` / `record(addr)`（**去重 + 最近优先 + 封顶 `MAX_SERVERS=20`**）/ `remove(addr)`；读宽容（坏文件按空跑）、写失败只记 `lastError`。
- **只存地址字符串**（不存账户/凭据）。**只有手动点「连接」才 `record`**；局域网直连不记（调用方保证）。

## 13c. `src/connect-prompt.mjs` —— 「连接到MC」注入的提示词

- `buildConnectPrompt({address, account, via})` → 英文正文（`via='lan'` 时追加"该地址在局域网、可能是临时的"一行）。
- **追加插槽 `CONNECT_PROMPT_APPENDERS`**：`(ctx)=>string` 的数组，非空即按序追加（"因属性追加提示词"的扩展点，默认空）。
- 可读版本同步在 `dev-docs/prompt/connect_to_mc.md`（**改一处要改两处**）。

## 13d. `src/mcversion.mjs` —— MC 版本「在不在支持范围内」判定（2026-10-05）

- **口径**（用户 2026-10-05 拍板）：范围 = mineflayer `lib/version.js` 的 `testedVersions` **上下界**，中间版本按**数值**比；**快照一律不支持**；判不了返回 `null`（按支持处理）。不连服、无副作用。
- `supportedRange()`：`{oldest, latest, tested[]}`（记忆化；读不到 mineflayer → null）。与 `core.mjs::libraryInfo` **同源**。
- `isVersionSupported(version, range?)`：`true`/`false`/`null`。纯函数，`range` 可显式传（selfcheck 不依赖本机 mineflayer）。
- `parseRelease`（`[maj,min,patch]`，缺段补 0）/`compareVersions`/`classifyVersion`（`release|snapshot|unknown`）/`isSnapshotVersion`。
- **两套规则都认**：经典 `1.21.11` 与**新 26.x 规则** `26.1`（26>1，序关系天然成立）；快照含老式 `25w46a`、新式 `26.3-snapshot-10`/`26.3-pre-2`、旧式 `1.21.4-pre1`。
- 调用点：`index.js::probeLan`（局域网行加 `supported` 给前端）、`core.mjs::libraryInfo`（复用区间）。

## 14. `src/wsconfig.mjs` —— 按工作区的配置

> 用户 2026-10-03 定：按工作区独立的设置（提示词版本 + 「MC设置→提示词」三开关）统一存 `<记忆根>/config.json`（默认 `<工作区>/.whale-craft/config.json`），取代原来的 `.rules-version` 独立标记 + 全局三开关。

- 文件形态 `{schema:1, rulesVersion, rulesFollowVersion, injectWhaleCraftAgentsMd, injectWorkspaceAgentsMd}`；缺键按 `WS_DEFAULTS`（= 下放前的全局默认）补齐；**未知键保留**（前向兼容）。
- `load` 不建目录、不抛：文件缺失/坏 JSON/非本格式 → 默认值 + `lastError`；`rulesVersion` 读不到时**兜底旧 `.rules-version`**（未迁移的老工作区行为不变）。
- 写：`config.json.tmp` + rename 原子替换；`patch` 只收三开关（布尔校验）并保留未知键/版本；**文件坏或非本格式 → 拒绝写**（不覆盖用户数据）。
- `migrate(root, {seed})`：建档 + 迁移（幂等）—— 无文件则写 `{schema:1}` + seed 里显式给过的旧全局值 + 旧标记值；**写后回读校验通过才删**旧 `.rules-version`；非本格式文件一概不碰（报 error）。调用点：`ensureMemoryRootForCwd`，**必须在 syncRulesVersion 之前**（否则旧版本值这一轮看不到）。
- 保护：config.json 对 MC 模式 AI **可读不可写**（见 §15）。

## 15. `src/protected.mjs` —— 受保护文件（可读不可写）

> 用户 2026-10-03 定：RULES.md / AGENTS.md（老名）/ config.json 对 MC 模式 AI **只读**。统一收编前身的散落判定：`agentsmd.mjs:isAgentsMdPath`（工具参数 JSON 全文匹配，已删）、`memory.mjs` 的根级文件名封锁。

- `PROTECTED_FILES / isProtectedName`（根级、大小写不敏感）；`isProtectedPathArg(raw)`（guard 用：裸名 或 含 `.whale-craft`/`whale_craft` 段的路径；嵌套记忆文件如 `_global/config.json` 不算）。
- `WRITE_FILE_TOOLS=/^(write|edit)$/`、`MEMORY_WRITE_ACTIONS=append/write/delete/put`（**现无消费方**：guard 侧随 `mc_kit_memory` 于 2026-10-07 移除，保留供将来写类工具复用）；`rejectionText()` / `protectedWriteError(rel)` 统一文案。
- guard（index.js）对文件工具用它 + **解析到记忆根后正好是该文件**的二次判定（memoryDir 重定向时绝对路径不含 `.whale-craft` 段）；写入路径以 memory.mjs 的 `target.protected` 为兜底。

## 16. `src/tool-def.mjs` —— 工具定义（宿主优先 + 内置兜底）

> 2026-10-04（GitHub issue #5）：`index.js` 顶层曾**静态** import 两个 optional peer（`@deepseek-ai/dsh-tools` / `schemastery`）⇒ 干净安装 / 官方 dsh-desktop 上模块**链接期**失败，宿主只报一句 `failed to import`。本模块沿用 `user-message.mjs` 的同款模式（宿主优先、内置兜底、`kind()` 诊断）。

- `defineTool(options)`：`toolDefKind()==='host'` 时用宿主的 defineTool（本机 CLI/源码安装行为完全不变）；解析不到用 `builtinDefineTool`。
- 内置 compiler：`parameters`（属性表 DSL）→ JSON Schema，**key 顺序与宿主逐字一致**（标量 `{type,注解,enum,const}`；object `{type,注解,additionalProperties,properties(声明了才有),required(非空才有)}`；`type:'json'` → 仅注解无 type；属性 `required:true` 收进**父级** required）；`timeoutMs` 透传；oneOf / 未声明 additionalProperties 的 object / presenter 类选项 → **明确抛错**（防静默走样，自检会当场红）。
- 内置 validator：宿主 `validateJsonSchemaValue` 的子集，违规文案/路径逐字对齐（`"arguments" must be an object` 等）；违规抛 `BuiltinToolArgsError`（name=`ToolArgsError`、code=`INVALID_ARGS`）。⚠️ 它不是宿主 `HarnessError` 子类（拿不到宿主类）——宿主显示层会退化成通用错误，文案保持一致（任务书认可的退化）。
- 自检：段 A 直接与宿主编译器对拍；段 B 用 `tools/no-host-init.mjs`（module.register 解析钩子）屏蔽两个包，子进程**整树自检** + 29 个工具注册形状**逐字比对**。CI 另有 `tools/check-standalone-import.mjs`（干净安装 import 回归；改回静态 import 必红）。

## 16b. `src/resolver-shim.mjs` —— 宿主解析器兜底（绕过 DSH rc.2 的 bug；2026-10-06）

> **纯副作用模块**（无导出）：`index.js` 的**第一条 import**，必须排在 `./src/core.mjs`（→ mineflayer）之前（ESM 按 import 顺序求值）。事故档案见 [history.md](history.md) F14。

- **症状**：从 npm/registry 安装（**非 link**）的插件一律 `failed to import`、整个不激活；link 调试正常。
- **根因**：宿主 `dsh-app-boot` 的 `ResolutionRouter.routeScoped` 对 **link 层提前 `routeLinked` 返回**、**非 link 层**才走 `for (const p of createRequire(parent).resolve.paths(name))`；`readable-stream@4` 的 `require('process/')`（尾部斜杠）使 `resolve.paths` 返回 **null** ⇒ `for...of null` 抛 `TypeError`。插件加载 mineflayer（依赖链含 readable-stream）时即炸。
- **修法**：包一层 `Module._resolveFilename`——先原样调宿主那份；**只在它抛该特定 TypeError 时**兜底（去尾斜杠后是内置名 ⇒ 直接返回；否则退回 `_findPath`）。其余请求行为逐字不变。
- ⚠️ 对宿主内部的 monkey-patch，属**临时手段**；DSH 修好后删除（history.md §4 待办有记）。

## 17. 模块依赖与不变式

- 模块间 import：`config.mjs → express.mjs`（`EXPRESS_MODES/normalizeExpressBase/resolveExpressMode`）；`agentsmd.mjs → wsconfig.mjs`（版本读写）；`memory.mjs → protected.mjs`（保护判定）；`tool-def.mjs` 自解析宿主包（可缺省）；index.js 组装其余；`resolver-shim.mjs` 无导出、纯副作用（index.js 首条 import，必须早于其余全部）。
- 记忆根定位（index.js `memoryRootFor`）：`WHALE_CRAFT_MEMORY_DIR` env → `pluginConfig.memoryDir` → `<会话 cwd>/.whale-craft` → `stateDir/memory` 兜底。
- 跨模块不变式：① 记忆路径全过 `safePath`，受保护文件（RULES/AGENTS/config.json）**可读不可写**（写类方法拒绝）；② 凭据只进宿主凭据服务，`view()`/工具返回/HTTP 永不见；③ 发布区只服务 `.express/`，`.out/` 永不对外；④ LAN 只被动听；⑤ ping 永不 reject；⑥ 一切写给模型的注入都是"提示行"。
