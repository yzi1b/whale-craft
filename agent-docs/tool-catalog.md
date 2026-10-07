# 工具目录（31 个）

> 快照：**0.2.0**（开发中，未发布）。注册全部在 `index.js` 的 `apply()` 内（`ctx.tools.register(asTool({...}))`），
> 分四段：`mc_*`（游戏内，26）/ `mc_kit_*`（游戏外辅助，2）/ `mc_admin_*`（管理，1）/ `mc_debug_*`（调试，2）。
> 可见性按模式分档（2026-10-04）：**MC模式** 只见 mc/mckit + 文件工具；**MC+模式** 全量可见（含 admin）；
> **其他模式** 隐藏 mc_* / mc_kit_*（仅保留 `mc_admin_*`），另有 guard 硬拒兜底。
> 🔴 **调试工具（`mc_debug_*`）另受「MC设置 → 调试」的 `exposeDebugTools` 开关门控**（2026-10-05）：关时在 MC/MC+ 也不暴露（白名单 / MC+ deny / guard 三处）。

## 通用约定

- **必须经 `asTool()` 注册**：它做两件事 —— ① 对返回值做 `lossless()` 无损化（类实例只留自有可枚举属性、Vec3→`{x,y,z}`、Date→ISO、NaN/±Inf→null、`-0`→0；宿主校验要求纯 JSON，Vec3 实例曾让 5 个工具全挂）；② 把 `exec.signal` 注入 `bot.setAbortSignal`（宿主取消能中断走路/挖掘循环）。
- **超时纪律**：调 `src/core.mjs` 的方法已自带超时/中断；扩展自己写 mineflayer 调用时**必须**套 `withTimeout` / `raceAbort`（宿主无法硬杀同进程代码）。
- **错误形态**：工具失败直接抛错（`mcTimeout:true` / `mcAborted:true` 标记可辨）；HTTP 设置 API 相反——统一 200+`{ok:false,...}`。
- 工具名列表由 `ourToolNames` 收集（注册时自动登记）：MC 模式白名单用它 + `MC_FILE_TOOLS`；其他模式的 deny 名单也用它（`mc_kit_*` + 非 admin 的 `mc_*`）。

---

## 一、连接与会话（8）

| 工具 | 职责 | 关键点 |
| --- | --- | --- |
| `mc_status` | 连接态 | `connection`（host/port/**version**）+ online/lastError/reconnecting/ghost；在线时内联 `mc_context`。**不含**改版前的 modeView/最近聊天（2026-10-05 去掉，待重做） |
| `mc_lan` | 找**局域网房间** | **只听**原版多播公告（`224.0.2.60:4445`，`[MOTD]…[/MOTD][AD]端口[/AD]`）；`seconds` 夹 [1,15] 默认 3，**恒定按时返回**（不扫端口）；多播被挡 → 空结果，请对方直接报地址。**`mode` 参数已删**（它本来就没被读，2026-10-05） |
| `mc_ping` | **已知地址**的探路 | 发一次 STATUS ping（握手+状态请求），**不登录、不用账户、不进服**；参数只有 `address`（host[:port]，端口默认 25565）+ `timeoutMs`（默认 5s 上限 30s）；拿通不通/版本/协议号/MOTD/人数/延迟；错误说人话。**`subserver`/`port` 已删**（2026-10-05：地址自带端口；无子服概念） |
| `mc_connect` | 进服（唯一连接入口） | 参数只有 `address`（host[:port]）+ `account`（innerID）。**不再有 `host/port/subserver/version`**；地址内部 `parseAddress`，握手 serverHost 就用该地址（DNS+Velocity 自行路由）；**版本永远自动探测**；版本不受支持（mineflayer 无该版本协议数据）→ **建连期间快速失败 + 明确版本错误**（不是"连接超时"；另有 spawn 后 `isVersionSupported` 兜底，复用 `src/mcversion.mjs`）；连接后等区块、**自动挂看门狗**、`learnName`；**返回 = `mc_status` 的内容** |
| `mc_accounts` | 账户管理（会话内） | `list/search/refresh`（**`use` 已删**，2026-10-05）；`refresh` 走 `bot.authOnly`（只认证不连接），`innerID` 缺省用本会话选定/默认；返回值**永不含密码/token** |
| `mc_disconnect` | 主动退服 | 看门狗 `disarm(notify:true)`（提醒 AI 已不在游戏）+ 优雅 quit |
| `mc_stop` | 停本会话 | 等价强制停止但 `cancelTurn: false`（**防自我 abort**；HTTP 的 `/api/mc/stop` 用 `cancelTurn:true`） |
| `mc_capabilities` | 能力/限制自述 | 报 plugin 版本、mineflayer testedVersions、超时上限、指令白名单等 |

> `mc_sessions` / `mc_diag` 已改名并移入「调试」（见 §七）。

## 二、观察（8）

| 工具 | 职责 | 关键点 |
| --- | --- | --- |
| `mc_context` | 游戏上下文 | basic = 模式/维度/坐标/朝向；survival 段（血量/吸收/饱食/饱和/气泡/装备/经验 + buff + 坐骑/骑乘者）——生存/冒险默认给，`survival:true` 强制给。底层 `core.context()` |
| `mc_players` | 在线玩家 | tab 栏名 / 档案名 / uuid（含自己）。底层 `core.players()` |
| `mc_map` | 地表方块图 | `format: chars / image`（**`both` 已删**）；`image` 渲染真彩俯视图 → 手工 PNG（`encodePng`）；🔴 **2026-10-05 改版**：`out` → **`dist`**（结果文件路径；空=不写文件）+ **`reply`**（默认 true=结果回复到上下文；false=只写文件/stub）；无默认输出目录；相对路径以**工作区根**为基准；chars 存 `.txt`；附图前先查模型是否接受视觉（`ctx.llm.resolveModelInfo`），不接受则跳过附图并给警告 |
| `mc_height` | 高度（地势）图 | 每列一个地表 Y（startY 处无方块→向下找第一个方块；有方块→向上找第一个空格取 Y−1；startY 空=当前 Y）；按 `glyphStep` 抽样省算力；`ignoreLiquid:true` 把液体当空气（水面/岩浆下的地面才算地表）。`format: chars / image / full`（分层设色等高图 / 字符模拟 / **逐格高度值 CSV**——一格一个 Y、非 x/y/z 坐标）；`scale` 仅 image；chars→.txt、full→.csv；`reply`/`dist` 同 `mc_map`。**网格上北下南·左西右东**。底层 `core.heightGrid/heightImage/heightGlyphs` |
| `mc_scan` | 范围扫描 | 半径 ≤24、高 ≤16；25 类方块计数或按名搜索 |
| `mc_entities` | 附近实体 | 半径默认 24，返回前 40 |
| `mc_inventory` | 背包 | — |
| `mc_events` | 事件队列（拉） | `limit ≤100`、`waitSec ≤120`（阻塞等新事件，**只是兜底**）；被看门狗唤醒打断时返回 `interrupted:true` + `interruptReason` + "先别再 wait"提示；内部 `timeoutMs` 130s。⚠️ 被传送/捡物/上下线**不在这个队列**（只进看门狗留档） |

## 三、看门狗控制（2）

| 工具 | 职责 | 关键点 |
| --- | --- | --- |
| `mc_watch` | 唤醒通道的唯一控制面 | `action: status / arm / disarm / log`；`log` 返回 `{armed, stats, recent: 留档末 30 条}`。进服默认自动 arm |
| `mc_config` | 改看门狗参数 | `patch`（点号键如 `wakeOn.pushed`）/ `reset`；响应附 `WATCH_DEFAULTS`。**只能改本会话的看门狗**，全局配置在 `mc_admin_config` |

## 四、交互与动作（8）

| 工具 | 职责 | 关键点 |
| --- | --- | --- |
| `mc_say` | 公屏说话 | 换行折空格、截 220 字符 |
| `mc_move` | 走/飞/跳 | `jump` 无需坐标；创造模式缺省 fly；生存走路上限 ~90s；走路**一直按住 forward**、卡住自跳 |
| `mc_act` | 单动作 | 8 种子模式：`look/toward/place/break/use/attack/equip/toss`；`toward` = 看向+走近+再看 |
| `mc_dig` | 挖掘 | `name` 或 `pos`；`count ≤16`；距离 ≤6；非创造自动换 `harvestTools` 里最好的工具 |
| `mc_build` | 长方体搭建 | 尺寸夹 [1,256]；失败 5 个即停；创造缺方块自动取 |
| `mc_give` | 拿物品 | **协议级 `set_creative_slot`**（创造模式即可，**不需要 OP**）；`clearAll` = 清背包；自动找空槽（优先同物品/快捷栏） |
| `mc_sequence` | 连串动作 | **最多 64 步**；`stopOnError` 默认 true；`budgetMs ≤570s`、`timeoutMs 600s`；步类型 wait≤30s/move/look/toward/place/break/dig/use/attack/equip/give/toss/say/jump。比让模型写脚本稳 |
| `mc_command` | 服务器指令 | **最后手段**：要 OP、受白名单（`commandWhitelist` 精确名/`/正则/`/`"*"`；`allowAllCommands` 全放行） |

## 五、游戏外辅助（2，`mc_kit_*`）

| 工具 | 职责 | 关键点 |
| --- | --- | --- |
| `mc_kit_image` | 图像处理 | `info/embed/render/grid/save`：SVG→PNG 光栅化（`sharp`，可选依赖，缺失只影响 `render`）、引图进 SVG、拼网格（≤64 张，返回 SVG）、落盘。输入输出都限制在本会话工作区内（`insideWorkspace`） |
| `mc_kit_express` | 把发布区文件换成"给用户的东西" | 路径解析先记忆根后 cwd；只认 `.express/`（目录即白名单）；**按宿主模式回不同 URL** —— web：`base + /api/whale-craft/express/<uuid>/…`；desktop：`http://localhost:<port>/<uuid>/…`（端口服务没起来回占用文案）；关闭恒回"文件分享已关闭…绝对路径…"；工作区 uuid 查不到即拒。宿主另有 `present`（显式文件交付组，MC 模式白名单里放行）——两者互补 |

## 六、管理（1，`mc_admin_*`）

| 工具 | 职责 | 关键点 |
| --- | --- | --- |
| `mc_admin_config` | 全局配置读写 | `get/set/unset/reset/list` 点号键；改完**立即热生效**（消费方每次过 getter）。**MC 模式会话看不见、也调不动**（白名单隐藏 + guard 硬拒双保险）；普通模式与 **MC+模式** 可见可用（MC+ 系用户 2026-10-04 定）。只含全局键——提示词三开关已下放为**按工作区**（`<工作区>/.whale-craft/config.json`，在「MC设置→提示词」改），不在本工具里 |

## 七、调试（2，`mc_debug_*`）

| 工具 | 职责 | 关键点 |
| --- | --- | --- |
| `mc_debug_sessions` | 列全部会话实例 | （原 `mc_sessions`）每会话独立性的直观证据 |
| `mc_debug_diag` | 诊断快照 | （原 `mc_diag`）物理状态/控制位/收包统计/事件队列 + `promptInjection` |

> 两者受「MC设置 → 调试」的 `exposeDebugTools` 开关门控（默认关）+ **只在 MC/MC+ 模式**暴露；其他模式一律摘掉。

---

## 超时基线（`src/core.mjs` → `TIMEOUTS` / `DEFAULTS`）

| 项 | 默认 |
| --- | --- |
| 建连（等着 spawn） | 45s |
| 走路预算 | 40s（工具侧 ≤90s） |
| 等区块 | 20s |
| 飞行预算 | 20s（2500ms 无进展早停） |
| `mc_events` 等待 | `waitSec ≤120` + 1 个轮询周期，内部兜底 130s |
| `mc_sequence` 总预算 | 300s（DEFAULTS）/ 工具上限 570s |
| 聊天历史 | 300 条 |

## 历史变更（防混淆）

- **`mc_kit_memory` 已删除**（2026-10-07）：长期记忆改由**宿主受限文件工具**（`read/write/edit/glob/grep/read_image`，MC 模式 guard 已限在 `.whale-craft/` 内）直接读写。**记忆模型本身保留**：固定 `<工作区>/.whale-craft/`、AI 维护 `README.md` 索引、每轮自动注入索引（`memoryIndexText`）都不变；`MemoryStore`（`src/memory.mjs`）保留为库。自检里有"mc_kit_memory 已移除"的断言——老名字不要再出现。已知缺口（等宿主补）：宿主暂无删文件工具、也无二进制 `put`。
- **`mc_kit_share`（及 `mc_map` 的 `share` 参数）已删除**（2026-09-16）：它只是在调宿主**另装**的 `dsh-file-host`，插件本身没有文件服务器。"让用户看到文件"改走：宿主 `present`（显式文件交付）+ 本插件的 `mc_kit_express`。自检里有"mc_kit_share 已移除 / 源码无文件服务器残留"的断言——老名字不要再出现。
- 文件分享 2026-10-04 起是**开关**（`expressEnabled`），不再有"模式"；老配置里的 `expressMode`（含 `local`）由 `PluginConfig.migrate` 搬成布尔（`online`→`true`，其余→`false`）。
- **2026-10-07 文件分享按宿主模式拆键**：`expressEnabled`/`expressBase` → **web 那套** `expressWebEnabled`/`expressWebBase`；新增 **desktop 那套** `expressDesktopEnabled`/`expressDesktopPort`（默认 16049，独立端口只监听 localhost）。从哪种模式（宿主 profile）进来只认哪套；`expressMode` 与两个旧键都由 `migrate` 逐档搬（见 architecture §10）。
- **2026-10-05 工具面改动**：① `mc_connect`/`mc_ping` 收成单一 `address`（删 `host/port/subserver/version`；版本永远自动探测，连上后版本不支持则强制断开）② `mc_accounts` 删 `use` ③ `mc_lan` 删 `mode` ④ 新增 `mc_context`/`mc_players` ⑤ `mc_sessions`/`mc_diag` → `mc_debug_sessions`/`mc_debug_diag`（受 `exposeDebugTools` 门控）⑥ `mc_status` 改为"连接态 + 在线内联 context" ⑦ `mc_map` 改版：`out`→`dist` + `reply`、去 `both`、无默认输出目录、相对路径以工作区根为基准、chars 存 .txt、附图前查视觉；新增 **`mc_height`**（高度/地势图，chars/image/full）。工具总数 29 → **32**。
