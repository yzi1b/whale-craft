# Fork 分支说明：AuthMe 6.x 对话框登录 + DSH 0.1.7（v4 会话格式）适配

> 本分支是 [yzi1b/whale-craft](https://github.com/yzi1b/whale-craft) 的 fork，
> 基线为上游 `aac3130`（whale_craft **0.1.7**），**fork 自身版本 `0.3.0`**。
> 相对上游改了 **13 个文件（+1701 / -70）**：4 处新增能力（AuthMe 登录 / 穿戴装备 / 使用手上的物品 / 自动攻击 `mc_hunt`）、4 处修复、1 处自检夹具、若干文档与配置。
> **不含任何密码、账户名或服务器地址**（AuthMe 密码改由环境变量提供，见第四节）。

---

## 一、适配了什么

| 项 | 版本 |
|---|---|
| **DSH（DeepSeek Harness）** | **`0.1.7-alpha.1`** |
| whale_craft 上游基线 | **0.1.7**（commit `aac3130`） |
| **whale_craft（本 fork 发布的版本）** | **`0.3.0`** |
| Minecraft 服务端 | **EtheriumMC 26.2 / Paper 26.2**（Folia 调度器），协议号 **775** |
| AuthMe | **6.x**（`preJoin` 对话框登录流程） |
| mineflayer | 实测 4.39.0（上游声明 `^4.37.1`） |
| Node.js | `>= 22`（上游要求） |

---

## 二、新增了什么

### 1. AuthMe 6.x 对话框登录（`src/core.mjs`，+90/-1）

**为什么需要**：MC 26.2 上 AuthMe 6.x 不再只靠聊天命令 `/login`。它在 **configuration 阶段**
下发一个 Dialog（`show_dialog` 包），要求客户端回一个 `custom_click_action` 原始包；
`preJoin.enable=true` 时这一步不可跳过，`loginCancelKicks=true` 时没回就会被踢下线。
mineflayer 不处理这个包，所以这部分是手写协议：

- **`writeVarInt()`**（`src/core.mjs:33`）—— 手写 Minecraft 协议的变长整数，用来自己拼包体。
- **加载 `prismarine-nbt`**（`src/core.mjs:33-63`）—— 上游没有这个直接依赖，改为从 mineflayer
  的依赖树里 `createRequire` 解析（解析不到再回退动态 `import`），用来解析 `show_dialog` 的 NBT、
  并构造回包。**不往 `package.json` 里加依赖。**
- **登录块**（`src/core.mjs:751`，+47 行）：在 `connect()` 里监听 `show_dialog` →
  - 从对话框 NBT 里解析**提交按钮的 action id**（找 `*/submit`，兜底 `authme:prejoin-login/submit`）
    和**输入框的 key**（取第一个 input，兜底 `password`）；
  - 用 `prismarine-nbt` 编出 payload，去掉根名做成**匿名 NBT**；
  - 按当前协议阶段选包 id（configuration `0x08` / play `0x44`）；
  - 用 `client.writeRaw()` 发出去，并把结果写进日志。
- **`authmePassword` 配置项**（`src/core.mjs:178`）：`process.env.MC_AUTHME_PASSWORD ?? ''`
  —— **只从环境变量读，不落任何配置文件**。
- **`spawn` 之后补一条 `/login <密码>`**（`src/core.mjs:831`）：`preJoin` 已经成功时这条多余但无害
  （AuthMe 会忽略已登录玩家），用来兼容仍然走 post-join 的服务器。

### 2. webServer 懒注入（`index.js`）

**为什么需要**：在 DSH 0.1.7 上，插件激活顺序会让 `webServer` 还没就绪就被引用，
原来写死的 `export const inject = ['webServer', 'tools']` 会因此报错。改成：

- 硬依赖只留 `['tools']`（`index.js:45`）；
- 两处路由注册改成**懒注入**：

```js
ctx.inject(['webServer'], (scope) => {
  scope.effect(() => scope.webServer.register(apiRoute), 'whale_craft: /api/mc 路由')
})
```

（另一处是发布区的 `/api/whale-craft` 路由，`index.js:1310`。）

### 3. DSH v4 会话格式适配：提示行投递（`src/user-message.mjs` + 2 个调用点）

**为什么需要**：DSH 0.1.7 的会话格式升到 **v4**，其准入检查**点名拒绝** `source.kind === 'plugin'`
（V3 的包装值）。插件原来用它投递"提示行"，于是在 0.1.7 上**整轮运行直接失败**：

```
本轮运行失败 format v4 message requires a producer-owned source kind
```

这个 bug 的症状很有迷惑性 —— **工具全都正常**，只有"注入提示行"这条通道炸，
看起来像是"插件没装提示词"而不是"会话写不进去"。

- 新增 `PLUGIN_SOURCE_KIND = 'plugin:whale_craft'`（`src/user-message.mjs:48`）——
  `kind` 取宿主 `producerKind()` 对第三方插件的规范值 `plugin:<插件名>`；
- 新增统一的 `noticeSource(summary)` 构造器（`src/user-message.mjs:59`），
  返回 `{ kind: 'plugin:whale_craft', plugin: 'whale_craft', form: 'notice', summary }`
  （`summary` 截到 120 字，与宿主 `CONTEXT_SUMMARY_MAX_CHARS` 一致）；
- 两处投递点改用它：`index.js:2774`（版本/规则提示行）、`src/watchdog.mjs:611`（看门狗唤醒）；
- `src/version-prompt.mjs` 里描述这套机制的注释同步订正（避免后人照抄错的 kind）。

### 4. 看门狗后台 job 的 owner 修正（`src/watchdog.mjs` + `index.js`）

**为什么需要**：真机上报

```
挂 job 失败（降级为无 job 模式）：session "[object Object]" has no live agent
(background job owner must be live)
```

看门狗因此降级成"无 job 模式"——还能唤醒，但 `job_list` 里看不到、UI 也停不掉。

**根因**：`jobs` 这一族的 `owner` / `caller` 参数要的是**会话 id 字符串**，插件传的是 **agent 对象**。
宿主 `resolveOwner(session)`（`@deepseek-ai/dsh-jobs-local/lib/index.js:526-533`）拿它去
`agents.get(session)` 查表，而那张表**按会话 id 字符串索引**
（`@deepseek-ai/dsh-agent`：`get(id) { return this.store.get(id)?.agent }`，
且 `enter()` 里断言 `agent.id === agent.session.id`）⇒ 传对象必然查不到，
错误信息里对象被 `String()` 成了 `[object Object]`。

**修法**：新增私有方法 `#ownerId()`（取 `agent?.id ?? sess.agentId`，并校验是非空字符串），
4 处调用点全部改传会话 id：

| 位置 | 旧 | 新 |
|---|---|---|
| `src/watchdog.mjs:389` `jobs.start` | `owner: this.agent` | `owner: ownerId` |
| `src/watchdog.mjs:312` `jobs.kill` | `kill(jobId, this.agent, reason)` | `kill(jobId, this.#ownerId(), reason)` |
| `index.js:761` `jobs.list` | `list(agent)` | `list(jobOwner)` |
| `index.js:765` `jobs.kill` | `kill(id, agent, reason)` | `kill(id, jobOwner, reason)` |

**顺带修掉一个更危险的隐患**：宿主

```js
assertAccess(job, caller) { if (job.owner !== void 0 && job.owner.id !== caller) throw … }
```

对 `owner === undefined` 的"**无主 job**"**完全不设防**。旧代码传 agent 对象时，
`list()` 一个自己的 job 都匹配不到，却把 `owner === undefined` 的**宿主级无主 job 全列出来**，
再因为不设防而全 `kill` 掉 —— 也就是说：点一次「强制停止」，会顺手清掉
跟这个会话**毫无关系**的宿主后台任务。现在改成只杀自己的（`if (j?.owner !== jobOwner) continue`），
并且 `jobOwner` 不是非空字符串时直接跳过。

**另一处防御**：拿不到会话 id 时**不再挂"无主 job"**（`owner` 缺省会让它对所有会话可见、
也能被别的会话的"强制停止"带走），而是照旧降级为"无 job 模式"并记一行日志说明原因。

### 5. 自检夹具补齐（`selfcheck.mjs`，+81/-9）

- **懒注入那次改动（上游已合入的 `074d61f`）之后，自检里所有路由注册相关的断言都是死的**：
  两处假 ctx 的 `inject` 一个是空壳、一个只登记不回调 ⇒ `/api/mc` 与 `/api/whale-craft`
  两条路由**从没注册**，断言全废，脚本还在 `callOn(undefined, …)` 上 `TypeError` 崩掉。
  （**真机不受影响**：真 cordis 的 `inject` 会回调。）已让夹具对 `webServer` 立刻回调。
- 新增 **8 条回归钉子**，把这次两个真机事故钉死：
  - `jobs.list` / `jobs.kill` 收到的必须是**会话 id 字符串**（不是 agent 对象）；
  - 无主 job（宿主自己的）**不许**被顺手杀掉；
  - `jobs.start` 的 `owner` 必须是会话 id 字符串，且 `kind` / `label` 元信息正确；
  - 拿不到会话 id 时**不挂无主 job**、降级为无 job 模式并把原因记进日志。

### 6. 配置示例里不再出现密码（`cordis.patch.yml`，+20）

上游的 `cordis.patch.yml` 是**插件包的一部分**（会被提交、打包、备份、随手分享，
而且模型能直接读到），里面**不该出现任何密码**。本分支在里面加了一段注释，说明
AuthMe 密码改由环境变量 `MC_AUTHME_PASSWORD` 提供，并给出 `export` 与
systemd `EnvironmentFile`（`0600`）两种写法。文件本身仍然只有 `autoConnect: false`。

### 7. MC 模式 preset 补上压缩组（`src/config.mjs` + `selfcheck.mjs`）

**问题**：`/compact` 由 `@deepseek-ai/dsh-command-compact` 提供，它属于 preset 里的**压缩组**：

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-basic            # 压缩服务本体
      name: '@deepseek-ai/dsh-compaction-basic'
    - id: command-compact             # /compact 这条斜杠指令
      name: '@deepseek-ai/dsh-command-compact'
    - id: tool-result-pruner          # 超长工具结果裁剪
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
      config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 }
```

官方 `standard` / `ptc` / `cordis` 三个 preset 都有这一组，**`minimal` 没有** ——
而 whale_craft 建 MC 模式 preset 时是照 `minimal` 复制再补的，只补了 `tool-fs` / `tool-jobs` / `present`，
于是这个 preset **既没有 `/compact`、也没有自动压缩**（用户真机投诉："压缩上下文没了"）。

**修法**：

- `MC_PRESET_TOOL_GROUPS` 增加第 4 个条目，带 **`block` 字段**（整组 YAML 逐字对齐官方那块）；
- `patchToolGroupsIntoComposition()`：有 `block` 就整块追加，否则维持原来的
  "一行 `- id` + 一行 `name`" 简单形式 ⇒ **老的三组输出逐字节不变**（幂等性断言不受影响）；
- `MC_PRESET_SPEC` **6 → 7**：升级时会把 6 建的那些 preset 重建一遍，顺手补上压缩组
  （和 `spec 5 → 6` 修 persona 键名走的是同一条路）。

**⚠️ 关键**：只补 `command-compact` 是**没用**的 —— 压缩服务本体在 `compaction-basic`，
`isolate` 那两个键在别处根本不存在，**必须整组加**。

**自检**：新增 4 条断言 —— 整组结构（`cordis:group` + `group: true` + 两个 `isolate` 键）、
三个 `config` 条目齐全、`tool-result-pruner` 参数与官方一致、`MC_PRESET_SPEC === 7`。

### 8. 穿戴装备 / 使用手上的物品（`src/core.mjs` + `index.js` + `selfcheck.mjs`）

**问题**（用户真机）："无法穿戴装备，使用工具。" —— 两处缺口：

- `equip()` 把目标槽**硬编码成 `'hand'`** ⇒ 盔甲（头盔 / 胸甲 / 护腿 / 靴子）与副手**根本穿不上**，
  物品只会在快捷栏和主手之间挪；而且 `bot.inventory.items()` 只覆盖槽 9–44，
  **不含盔甲槽 5–8 与副手 45**，所以"穿没穿"也看不见。
- 只有 `use`，它做的是 `activateBlock` / `activateEntity`（开门 / 按钮 / 拉杆 / 喂动物），
  **没有"用手上的物品"这一路** ⇒ 吃不了、喝不了、倒不了水、点不了火。

**修法**：

- `equip({ name, destination, auto })`：`destination` 支持 `hand / off-hand / head / torso / legs / feet`，
  别名归一（`off-hand` / `off_hand` / `off hand` 等价，中文 `头 / 胸 / 腿 / 脚` 也认）；
  **不给就自动判槽**，权威依据是 minecraft-data 的 `enchantCategories`
  （`armor_head` / `armor_chest` / `armor_legs` / `armor_feet`）⇒ `turtle_helmet`、
  `chainmail_chestplate` 这类名字不规则的也判得对，`elytra` / `shield` / `carved_pumpkin` 兜底；
- `equipArmor()` + `mc_act { mode: "wear" }`：一键穿全套，同槽多件按材质挑最好的
  （netherite > diamond > iron > chainmail > golden > leather），**鞘翅默认不穿**（占胸槽会顶掉胸甲），
  缺哪件如实报出并给获取办法；
- `useItem()` + `mc_act { mode: "useItem" }`：可选先 equip 再 `activateItem()`；
  **食物走 `bot.consume()`**（等服务器 `entity_status`，不自己数秒），吃饱给友好提示；
  非食物按类型给按下时长（弓 1200 / 药水 1800 / 食物 1600 / 其余 120 ms）再 `deactivateItem()`；
- `useBlock()` 新增 `name`：先拿到手上再右键（骨粉催熟 / 锄头耕地 / 打火石点火）；
- `inventory()` 新增 **`wearing`**（读装备槽 5–8 + 副手 45）；
- `mc_sequence` 认 `wear` 与 `useItem` 两个新 op，`equip` 支持 `dest`。

**⚠️ 顺序坑**：`equip` 原先**先找物品、后校验 destination**，dest 写错时会报"背包里没有 X"，
把真因盖掉 —— 已把校验提到前面（自检里专门钉了这条）。

**自检**：新增 **24 条**断言，总数 **757 ✅ / 5 ❌**（5 条为既有问题，与本次无关）。

---

### 9. 自动攻击：mc_hunt（`src/core.mjs` + `index.js` + `selfcheck.mjs` + `README.md` + 依赖）

- **背景**（用户 2026-09-22）：上游 `attack` 只能打 4.5 格内一次，追着打要一步步调工具、费 token；
  要求"**自动寻路追上去、锁定这一个实体连续打，途中自动挖挡路方块、自动垫脚**"，
  并指定参考 opencode 配置里的 `/www/minecraft-mcp-server`（深研结论：其 `brain.mjs` 用
  `mineflayer-pathfinder` 的 `Movements + setMovements + GoalNear` 寻路，`canDig = false`）。
- **实现**：
  · **新增依赖** `mineflayer-pathfinder@^2.4.5`（lockfile 同步）；`createBot` 返回后 `loadPlugin`
    （官方 README 与参考项目 `bot.ts:136` 同款时机，挂失败降级、`hunt()` 里再检查并清晰报错）；
  · `hunt()`：名字子串锁定单体 → `new GoalFollow(target, range)` + `setGoal(goal, true)`（dynamic）
    持续追击 → 进 4 格按 600ms 攻击冷却 `bot.attack`；250ms 决策 tick，
    寻路 / 挖 / 垫脚全由 pathfinder 在 physicsTick 里自己跑；
  · **自动挖** = `Movements.canDig = true`（astar toBreak → 自动换最快工具 + `bot.dig`）；
    **自动垫脚** = astar `toPlace` + 背包方块（无方块时战报注明"垫不了脚"）；
  · 开战自动换最强武器（`#bestWeapon`：剑 > 斧；netherite > diamond > iron > stone > golden/wooden）；
  · 收场：`target_gone`（宽限 `reacquire` 秒）/ `retreated`（血量 ≤ `hpFloor`）/
    `timeout`（`durationSec` 1–120s，默认 45）/ `aborted` / `disconnected`；
    收尾必定 `setGoal(null)` + `clearControlStates()`，不把移动状态留在场上；
  · `mc_sequence` 新 op `hunt`（`#runStep` 分支 + 工具描述 + 报错 op 列表同步）；
    `mc_act{attack}` 描述指向 `mc_hunt`；README 工具表 29→30、mc_* 25→26。
- **坑**：目标丢失重搜到**新实体对象**时必须**重建 `GoalFollow`** —— 旧引用 `isValid()` 恒真，
  pathfinder 会追着一个不再更新的残留坐标跑。
- **自检**：新增 **8 条**断言，总数 **770 ✅ / 5 ❌**（5 条 ❌ 仍为既有平台差异）。

### 10. 战斗升级与真机修复（0.4.0，`src/core.mjs` + `index.js` + `selfcheck.mjs` + 文档）

- **背景**（用户 2026-09-24）：① "pvp功能还是不够好"；② 目标锁定要"就近锁、非玩家太远达不到
  就取消锁定、玩家锁到死"；③ "现在吃东西、攻击、挖东西，还有被一个方块挡住，全有问题"，
  并要求"**仔细分析** `/www/Wurst-Client-v7.54-MC26.1.2.jar`"（长期基准：所有打怪功能以 Wurst 为准）。
- **实现**（全部对照 Wurst 源码逐行核过）：
  · **PVP 套装**：攻速 625ms + 高斯 ±100ms（Killaura speedRandMS）；**下落段跳劈**（轮询位置真在
    下落才出手，Criticals FULL_JUMP 合法版）；血量 ≤10 自动图腾换副手（AutoTotem）；6–22 格弓箭
    抛物线 + 移动提前量（BowAimbot/Trajectories：v0=3.0/重力 0.05/阻力 0.99 逐 tick 解算）；推进 sprint；
  · **前方障碍**：`frontObstacle` 五方向弧扫（正前 ±45° ±90°）× 两档距离（0.55/1.05 格）——
    脚挡头空=台阶（`stepJump` **先转向**台阶再跳）、脚头都挡=挖、低顶=挖头那格；**逃跑段**同样接
    台阶跳；停滞判定 700 → **450ms**（FightBot 撞墙当拍就跳）；
  · **目标锁定**：就近锁；非玩家初距 >60 格直接不追（报错）、追丢后拉开 >60 格持续 4s →
    收场 `too_far` **取消锁定**；**玩家目标不设距离限制，锁到死**（durationSec 内）；
  · **挖掘**：`digTime` **带效率附魔**（prismarine-nbt simplify 传 Enchantments，不再把 1 秒的活
    误判成硬墙）；挖前 `lookAt` 方块中心（NukerLegit faceVector）；失败黑名单改 **5 秒时间窗**
    （`failOf`，被怪打断不再一票否决），挂死仍 99 立即永久放弃；
  · **吃喝**（AutoEat 对齐）：吃前 `setGoal(null)` + 清控制位（**移动中不吃**）、装备后验手持是
    `FOOD_RE` 食物再 `consume`；
- **坑**：Edit 工具的 `old_string` 在中文全角/缩进上极易不中（doc 头/README 多次失败）——
  改用 python 锚定行首正则插入，一次成功；
- **自检**：新增 3 条断言，总数 **781 ✅ / 5 ❌**（5 条 ❌ 仍为既有平台差异，`npm run check` rc=0）。

---

## 三、相对上游改了什么

| 文件 | 变化 | 说明 |
|---|---|---|
| `src/core.mjs` | **+438 / -13** | AuthMe 6.x 对话框登录 + 穿戴装备（`equip`/`equipArmor`）与用物品（`useItem`）+ **自动攻击 `mc_hunt`**（pathfinder 挂载、追击循环、`#bestWeapon`） |
| `src/watchdog.mjs` | **+46 / -13** | `#ownerId()`、job owner/caller 修正、v4 `noticeSource` |
| `src/config.mjs` | **+40 / -5** | 压缩组**整组**补进 `MC_PRESET_TOOL_GROUPS`（新增 `block` 字段）、`MC_PRESET_SPEC` 升到 7 |
| `index.js` | **+72 / -20** | webServer 懒注入、job owner/caller 修正、v4 `noticeSource`、**`mc_hunt` 工具注册**、工具组注释订正 |
| `selfcheck.mjs` | **+316 / -13** | 夹具补懒注入回调 + 8 条 jobs 回归钉子 + 4 条压缩组断言 + 24 条穿戴 / 用物品断言 + **8 条 `mc_hunt` 断言** |
| `src/user-message.mjs` | **+39 / -1** | `PLUGIN_SOURCE_KIND` + `noticeSource()`（v4 合规） |
| `src/version-prompt.mjs` | **+3 / -2** | 注释订正（kind 不能是 V3 的 `'plugin'`） |
| `cordis.patch.yml` | **+20 / -0** | 加注释说明密码走环境变量（文件本身无密码） |
| `package.json` | **+2 / -1** | 版本号 `0.1.7` → `0.4.0`；**新增依赖** `mineflayer-pathfinder@^2.4.5` |
| `package-lock.json` | **+18 / -2** | 同步 lockfile 版本号 + `mineflayer-pathfinder` 依赖树 |
| `CHANGELOG.md` | **+159 / -0** | 本分支的变更记录（0.1.8 / 0.1.9 / 0.2.0 / 0.3.0 / 0.4.0 五节） |
| `FORK-NOTES.md` | **+331 / -0** | 本文件（fork 独有，上游没有） |
| `README.md` | **+217 / -0** | 重写为 fork 说明（上游版本 / 上游问题 / 修复 / 新增 / 安装 / 限制），上游原文折叠在文末 |

**没有改**：其余源码。**新增依赖**：`mineflayer-pathfinder@^2.4.5`（`mc_hunt` 的寻路引擎）。

---

## 四、怎么用

### 1. 安装

按上游 README 的方式装即可，例如：

```bash
dsh plugin --profile <你的 profile> add link:/path/to/whale-craft
```

fork 也提供打包好的 tgz（见本 fork 的 **Releases** 页，附件 `whale_craft-0.4.0.tgz`）：

```bash
npm install /path/to/whale_craft-0.4.0.tgz
```

> ⚠️ npm 上的 `whale_craft` 属于原作者（`lyricraft <yzi1b@outlook.com>`），
> 所以这个包**没有发到 npm**，只作为 Release 附件提供。

### 2. 提供 AuthMe 密码（不进配置文件）

只有**离线服 + AuthMe** 需要；正版验证服不用。

```bash
export MC_AUTHME_PASSWORD='你的密码'
```

用 systemd 部署时建议走 `EnvironmentFile`（文件权限 `0600`）：

```ini
EnvironmentFile=-/path/to/authme.env
```

```bash
# authme.env
MC_AUTHME_PASSWORD=你的密码
```

**不设这个环境变量时**，对话框登录整段不会启用（`authmePassword` 为空 → 直接跳过），
行为与上游一致。

### 3. 自检

```bash
npm run check        # = node tools/check-core.mjs && node selfcheck.mjs
```

---

## 五、已知限制

- **对话框解析**依赖 AuthMe 的默认 action id（`*/submit`）和输入框 key（`password`）；
  自定义过对话框布局的服务器可能解析不到 —— 这时日志里会写 `AuthMe 对话框提交失败：…`。
- **只在 EtheriumMC 26.2 / AuthMe 6.x 上实测过**。更老的 AuthMe（1.20.x 那批）走的是聊天命令
  `/login`，本分支补的那条命令能覆盖，但对话框那段不会触发。
- **需要 DSH 0.1.7-alpha.1**：懒注入与 v4 `noticeSource` 都是为它改的。
  更早的 DSH 两种写法应该都能跑，未实测。
- **`selfcheck.mjs` 还有 5 条 ❌，都是平台/数据差异，与本分支无关**（`npm run check` 不因 ❌ 退出非零）：
  3 条是夹具里写死了 Windows 路径（`D:\dsh/whale_craft`、`E:\x\README.md` 之类），
  在 Linux 上 `path.resolve()` 会把它们当普通文件名，于是"越界拦截"用例判失败
  （真正的越界如 `/etc/passwd`、`../../x` 仍被正确拒绝）；
  1 条是 `minecraft-data@3.116.0` 的 `dataPaths.json` 里没有 `pc.26.2` 条目
  （磁盘上有 `26.2/` 目录但未被索引）⇒ `#supportsPacket('26.2', …)` 返回 null，
  被当成"不支持"；服务端实际协议号 775 映射到 `26.1`（那个条目是有的）。
- **`jobs` 那两处修正需要在插件代码更新后重启 DSH 才生效**（Node ESM 模块缓存）。
