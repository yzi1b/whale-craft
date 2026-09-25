// -*- coding: utf-8 -*-
/**
 * whale_craft / core.mjs —— Minecraft 26.2 无头机器人核心（不依赖 DSH，可独立运行与测试）
 * ---------------------------------------------------------------------------
 * 从 mc-bridge/server.mjs 抽出来：连接/保活/世界读取/移动/挖掘/事件分发。
 * 供两处使用：
 *   1. plugins/whale_craft/index.js（DSH 宿主插件，机器人跑在 DSH 进程里）
 *   2. whale_craft/standalone.mjs（脱离 DSH 单独跑，调试用）
 *
 * 依赖：`mineflayer` —— **装哪一份由部署方决定**（官方 npm 版，或本机 link 进来的打过补丁的树）。
 *   🔴 插件不指定版本、不打包、不打补丁（2026-09-16 用户决策）：所以这里只写裸包名，
 *      谁想连新版本就把自己那份 link 成 `mineflayer`（见 .agent-docs/mc-agent-opensource-plan）。
 * 关键坑（详见 .agent-docs/mc-bridge-agent-tools-2026-09-14.md）：
 *   - auth 传函数时必须自己 options.connect(client)
 *   - spawn 早于区块下发，读世界前要 waitForChunks
 *   - 给 mineflayer 传坐标一律用真 Vec3
 *   - 26.2 服务端要 player_input 包上报按键（mineflayer 不发）→ 本模块自己补
 *   - 走路必须"一直按住"前进键
 */
import mineflayer from 'mineflayer'
import vec3pkg from 'vec3'
import { offlineUuid, dashUuid } from './accounts.mjs'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { writeFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const Vec3 = vec3pkg.Vec3 ?? vec3pkg
const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 写 VarInt（Minecraft 协议变量长度整数）。
 * AuthMe 对话框提交需要手动构造 raw packet。
 */
function writeVarInt (value) {
  const bufs = []
  let temp = value
  while (true) {
    let byte = temp & 0x7F
    temp >>>= 7
    if (temp !== 0) byte |= 0x80
    bufs.push(byte)
    if (temp === 0) break
  }
  return Buffer.from(bufs)
}

/**
 * 尝试加载 prismarine-nbt（从 mineflayer 的依赖树里解析）。
 * 用于 AuthMe 对话框登录：解析 show_dialog 的 NBT 并构造 custom_click_action 回复。
 */
let prismarineNBT = null
try {
  const requireFromMf = createRequire(createRequire(import.meta.url).resolve('mineflayer'))
  prismarineNBT = requireFromMf('prismarine-nbt')
} catch {
  try {
    prismarineNBT = (await import('prismarine-nbt')).default ?? (await import('prismarine-nbt'))
  } catch {}
}

/**
 * 尝试加载 mineflayer-pathfinder —— mc_hunt 自动攻击的寻路引擎。
 * 能力全在它身上：GoalFollow 动态追击、自动挖挡路方块（Movements.canDig）、
 * 自动垫脚/搭桥（astar toPlace + 背包方块）。
 * 可选依赖：没装不影响连接与其它工具，只是 mc_hunt 会明确报"没装"。
 * （参考 /www/minecraft-mcp-server —— opencode 里配置的 MCP 项目，实测同款用法。）
 */
let pathfinderPlugin = null
let PathfinderMovements = null
let PathGoals = null
try {
  const pf = createRequire(import.meta.url)('mineflayer-pathfinder')
  pathfinderPlugin = pf.pathfinder
  PathfinderMovements = pf.Movements
  PathGoals = pf.goals
} catch {}

/**
 * 从 mineflayer **自己的**依赖树里解析包（同一份 node_modules）。
 * 用途：创造模式取物要 new 一个 prismarine-item 的 Item 实例塞进槽位。
 * ⚠️ 用"解析到的 mineflayer 实际路径"当锚点，**不写死目录** —— 这样插件装在哪儿都成立。
 */
const requireFromMineflayer = (() => {
  try { return createRequire(createRequire(import.meta.url).resolve('mineflayer')) } catch { return createRequire(import.meta.url) }
})()

/* ─────────── 「Yggdrasil 会话 join」的兼容补丁（用户 2026-09-17：它把整个 DSH 搞崩过）───────────
 * 事故链（真机实测栈）：
 *   minecraft-protocol/src/client/encrypt.js:41
 *     yggdrasilServer.join(accessToken, profileId, serverId, secret, pubkey, cb)   ← **老式回调**
 *   yggdrasil/src/Server.js:20  join 是 **async 函数，根本不调那个 cb**
 *   yggdrasil/src/utils.js:35   `if (body?.error !== undefined) throw new Error(body.error)`
 *                               → 皮肤站令牌失效时抛 `ForbiddenOperationException`
 *   ⇒ 这个 rejection **没有任何人接**（回调没人调、返回的 promise 没人 await）
 *   ⇒ 宿主的 `installFailLoud` 把"未处理的 Promise 拒绝"当致命错误 → `dsh: fatal load failure` → **exit(1)**
 *
 * 所以这里把 `yggdrasil.server(...)` 返回的对象包一层：
 *   · 调用方传了回调 → 我们替新版库把回调调起来（成功/失败都调）⇒ 恢复老式调用的语义、不产生悬空拒绝；
 *   · 没传回调 → 至少 `.catch()` 掉，别把它变成 unhandledRejection。
 * 同时把这类认证失败记下来（`takeAuthJoinError()`），好让上层给出"去 MC设置重新登录"的明确指引。
 *
 * ⚠️ 只动这一个方法；resolver 锚在 **mineflayer 自己的依赖树**上（保证和 minecraft-protocol 用的是同一份）。
 * ─────────────────────────────────────────────────────────────────────────────────────────── */
let lastAuthJoinError = null
/** 取出（并清空）最近一次 session-join 失败 */
export function takeAuthJoinError () { const e = lastAuthJoinError; lastAuthJoinError = null; return e }

/**
 * 把 `yggdrasil.server()` 的对象包一层（**纯函数**，自检直接测它）。
 * @param {object} server `yggdrasil.server({...})` 的返回值
 * @param {(e:Error)=>void} [onError] 失败时的记录钩子
 */
export function wrapYggdrasilServer (server, onError = (e) => { lastAuthJoinError = e }) {
  if (!server || typeof server.join !== 'function' || server.__wcJoinWrapped) return server
  const orig = server.join.bind(server)
  server.join = (...args) => {
    const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null
    const p = orig(...args)
    if (cb) {
      // 回调式调用方（minecraft-protocol 就是这个）：替新版库把回调调起来
      Promise.resolve(p).then((r) => cb(null, r), (e) => { try { onError(e) } catch {} ; cb(e) })
      return p
    }
    return Promise.resolve(p).catch((e) => { try { onError(e) } catch {} })
  }
  server.__wcJoinWrapped = true
  return server
}

/** 一次性装上补丁（模块加载时装；拿不到 yggdrasil 就静默跳过） */
const yggCompat = (() => {
  try {
    const mod = requireFromMineflayer('yggdrasil')
    if (!mod || typeof mod.server !== 'function') return 'no-server-export'
    const orig = mod.server
    const wrapped = function (...args) { return wrapYggdrasilServer(orig.apply(this, args)) }
    try { mod.server = wrapped } catch { return 'readonly-export' }
    return 'patched'
  } catch (e) { return `skip:${e?.code ?? e?.message ?? 'unknown'}` }
})()

/** 认证类失败 → 给用户看的可执行错误（needUserAction 让前端/工具照原样转达） */
export function friendlyAuthError (e) {
  const raw = String(e?.message ?? e ?? '')
  if (/ForbiddenOperationException|InvalidToken|invalid session|Unauthorized|HTTP 40[13]|HTTP 400/i.test(raw)) {
    const err = new Error(`皮肤站认证被拒（${raw}）：这个账户当前的登录令牌在那个认证服上无效`)
    err.needUserAction = true
    err.hint = '请让用户在「MC设置」里重新登录这个账户（或点该账户的「刷新」），再重新进服'
    err.cause = e
    return err
  }
  return e instanceof Error ? e : new Error(raw)
}

/**
 * 交给 minecraft-protocol 的**凭据开关**（纯函数，自检直接测）。
 *
 * 🔴 2026-09-17 真机致命事故的另一半：`haveCredentials` 的语义是"**有真凭据**能拿给认证服看"
 *   （minecraft-protocol `microsoftAuth.js:33` / `mojangAuth.js:24` 都是这么设的），
 *   而我们以前**无条件设 true** ⇒ 离线账户也会被拖去 `sessionserver.mojang.com` 做 session join，
 *   假 token 必然被拒（`ForbiddenOperationException`）→ 那条 rejection 没人接 →
 *   宿主的 fail-loud 直接 `exit(1)`，整个 Harness 死。
 *   离线账户必须走 encrypt.js 的"无凭据"分支（不发 session join）。
 * @param {'offline'|'yggdrasil'} mode 账户类型
 * @returns {{haveCredentials:boolean, useAccessToken:boolean}}
 */
export function sessionFlags (mode) {
  const ygg = mode === 'yggdrasil'
  return { haveCredentials: ygg, useAccessToken: ygg }
}

let _itemLoader = null
function itemLoader () {
  if (!_itemLoader) _itemLoader = requireFromMineflayer('prismarine-item')
  return _itemLoader
}

export const DEFAULTS = {
  // ⚠️ 不预设服务器：host/authUrl/authUser/authPass/subserver 一律由调用方（mc_connect 工具）传入。
  //    这里只留环境变量口子（脱机调试用），没有默认值——避免"忘了传参就静默连到某个服"。
  host: process.env.MC_HOST ?? '',
  port: Number(process.env.MC_PORT ?? 25565),   // 25565 是 MC 协议默认端口，不是某台服务器的绑定
  subserver: process.env.MC_SUBSERVER ?? '',
  authUrl: process.env.MC_AUTH_URL ?? '',
  authUser: process.env.MC_AUTH_USER ?? '',
  authPass: process.env.MC_AUTH_PASS ?? '',
  connectTimeoutMs: 45_000,
  moveBudgetMs: 40_000,
  chatHistory: 300,
  inputPacket: process.env.MC_INPUT_PACKET !== '0',
  /** AuthMe 密码（离线服 + AuthMe preJoin 对话框登录时使用） */
  authmePassword: process.env.MC_AUTHME_PASSWORD ?? '',
  /**
   * 日志落盘位置。🔴 **默认不写插件包目录**（装进 `node_modules/` 后那可能是只读的、
   * 升级时也会被覆盖）：默认写 `$DSH_HOME/whale_craft/logs/`，可用 `MC_LOG` 覆盖。
   */
  logFile: process.env.MC_LOG ?? join(resolveHarnessHome(), 'whale_craft', 'logs', 'whale-craft.log'),
}

/** 宿主家目录：`$DSH_HOME` → `~/.dsh`（与宿主 `resolveDshHome` 同一套规矩） */
function resolveHarnessHome () {
  const fromEnv = String(process.env.DSH_HOME ?? '').trim()
  if (fromEnv) return fromEnv
  try { return join(homedir(), '.dsh') } catch { return join(process.cwd(), '.dsh') }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const isAir = (n) => n === 'air' || n === 'cave_air' || n === 'void_air'
const isLiquid = (n) => n === 'water' || n === 'lava' || /_water$|_lava$/.test(String(n ?? ''))

/**
 * 这个位置**能不能放方块进去**（= 该方块不占空间 / 是可替换物）。
 *
 * 判据用 `boundingBox === 'empty'`，**不是**"名字是不是 air"。
 * 旧版只认 air/cave_air/void_air，2026-09-15 用真实 minecraft-data(26.2) 实测发现漏了一大片：
 *   ✅ air / cave_air / void_air   → 'empty'
 *   ✅ **water / lava**             → 'empty'  ← 旧版这里直接失败，**水里建不了东西**（码头/桥全废）
 *   ✅ 草/花/蕨/雪/藤蔓/海草/海带/气泡柱/火把/火/树苗/地毯/铁轨 → 'empty'
 *   ❌ 石头/木板/台阶/楼梯/土径      → 'block'  （正确拒绝）
 * ⚠️ 未加载（blockAt 返回 null）**不算可放** —— 不能盲放。
 */
const canPlaceInto = (blk) => {
  if (!blk) return false
  if (blk.boundingBox === 'empty') return true
  return isAir(blk.name) || isLiquid(blk.name)     // 兜底：个别版本 boundingBox 可能不准
}

/**
 * 规范化认证端点基址：去首尾空白、去掉结尾多余的斜杠。
 * 否则 `https://x/yggdrasil/` 会拼成 `https://x/yggdrasil//authserver/authenticate`
 * （多数服务端能容忍，但不该指望）。
 */
function normalizeBaseUrl (url) {
  const s = String(url ?? '').trim()
  return s ? s.replace(/\/+$/, '') : ''
}

/**
 * 独立落盘日志（不需要 McBot 实例）。
 * 用途：插件加载/卸载这种"机器人都还没有"的时刻也要在 whale-craft.log 留痕——
 * 排查"插件到底加载了没"全靠这一行（曾因为没有它而误判成"工具没注册"）。
 */
export function logLine (...args) {
  const line = `[whale_craft ${new Date().toISOString().slice(11, 19)}] ${args.join(' ')}`
  try {
    if (!existsSync(dirname(DEFAULTS.logFile))) mkdirSync(dirname(DEFAULTS.logFile), { recursive: true })
    appendFileSync(DEFAULTS.logFile, line + '\n')
  } catch {}
  return line
}

/* ============================================================================
 * 🔴 超时保护 —— "对话卡在生成中、停止键也按不动"的根因修复（2026-09-15）
 * ----------------------------------------------------------------------------
 * mineflayer 的 dig / placeBlock / equip / lookAt / creative.flyTo 返回的都是
 * "**等服务端 ack**" 的 promise。26.2 支持不完整时（我们得当伸手进 _client 补
 * player_input，就是证据）服务端可能根本不回包 → promise 永不 settle
 * → 工具 execute 永不返回 → 整轮 turn 卡死：
 *     前端一直"生成中" · 停止键无效（没有中断点） · 无法插话
 * 症状表现为"LLM 也停止输出了"——其实模型早调完工具在等结果，是工具卡住了。
 *
 * 注意：超时只是**不再等**，底层 promise 仍悬着（JS 无法取消已发出的网络等待）。
 * 因此超时后必须把机器人当作"可能已失步"处理：松掉所有控制位 + 记 lastTimeout。
 * ========================================================================== */

/** 各类操作的默认超时（ms）；可用 cfg.timeouts 覆盖 */
export const TIMEOUTS = {
  lookAt: 4_000,
  equip: 6_000,
  dig: 25_000,
  place: 6_000,
  flyTo: 30_000,
  digBlock: 25_000,
  give: 8_000,
  act: 6_000,
  toss: 5_000,
  attack: 4_000,
}

/**
 * 服务器指令的**内置**白名单（保底值）。
 * 插件层会传自己的可配置白名单覆盖它（`command(cmd, { allow })`）——
 * 这份只是"没有配置时也能安全跑"的默认，和 src/config.mjs 的默认值保持一致。
 */
export const DEFAULT_COMMAND_WHITELIST = new Set([
  'tp', 'teleport', 'give', 'time', 'weather', 'say', 'tell', 'msg',
  'gamemode', 'effect', 'enchant', 'setblock', 'fill', 'clone', 'summon',
  'title', 'spawnpoint', 'difficulty', 'kill', 'clear', 'xp', 'experience',
])

/**
 * 给可能永不 settle 的 promise 套超时。超时抛出的错误带 `mcTimeout: true`。
 */
export function withTimeout (promise, ms, label) {
  let timer
  const guard = new Promise((_, reject) => {
    // ⚠️ 这里**故意不 unref**：守卫定时器代表"有真实工作在等"，unref 掉会让
    //    "只有它在跑"时进程直接退出、超时永不触发（selfcheck 里实测踩到）。
    timer = setTimeout(() => reject(new Error(`__MC_TIMEOUT__${label}`)), ms)
  })
  return Promise.race([promise, guard])
    .catch((e) => {
      if (String(e?.message ?? '').startsWith('__MC_TIMEOUT__')) {
        const err = new Error(`${label} 超时（${ms}ms）：服务端没有回应，机器人可能已失步。`
          + '可用 mc_status / mc_diag 检查，必要时 mc_connect 重连。')
        err.mcTimeout = true
        throw err
      }
      throw e
    })
    .finally(() => { if (timer) clearTimeout(timer) })
}

/**
 * 与 AbortSignal 赛跑 —— 让"停止按钮"真正有效。
 *
 * 为什么必须单独做：宿主的停止链路（GUI 停止键 → POST /api/session/cancel →
 * `agent.cancel({kind:'user'})` → `phase.abort.abort(cause)`）**只是 abort 一个
 * signal**，它没有能力抛弃同进程里 pending 的 promise（宿主源码原话：
 * `tools/index.ts:219` "it cannot hard-kill same-process code"）。
 * 所以工具必须自己在 await 上监听 signal，否则：
 *   本地超时兜底最长要等 25s（dig），用户按停止后仍然"卡着不动"。
 *
 * 拿到 exec.signal 的路径：`ToolExecutionInput.signal`（`exec.signal`），
 * 由 `executeToolCalls(..., signal)` 传入，就是本轮 turn 的 abort signal。
 */
export function raceAbort (promise, signal, label) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError(label, signal))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(label, signal))
    signal.addEventListener('abort', onAbort, { once: true })
    const settle = (fn) => (v) => { signal.removeEventListener('abort', onAbort); fn(v) }
    promise.then(settle(resolve), settle(reject))
  })
}

function abortError (label, signal) {
  const err = new Error(`${label} 被中断（用户停止 / 会话取消）`)
  err.mcAborted = true
  try { err.reason = signal?.reason } catch {}
  return err
}

/**
 * 把 mineflayer 的返回值转成"无损 JSON"。
 * ⚠️ 血的教训（2026-09-14）：工具输出里只要混进 Vec3 实例，DSH 就会报
 *    `tool "mc_status" returned invalid output: value is not lossless JSON`
 *    —— 表现就是"新会话里工具用不了"。所有对外返回都要过这个函数。
 */
export function jsonSafe (value, depth = 0) {
  if (depth > 12) return null
  if (value === null || value === undefined) return null
  const t = typeof value
  if (t === 'string' || t === 'boolean') return value
  if (t === 'number') return Number.isFinite(value) ? value : null
  if (t === 'bigint') return Number(value)
  if (t === 'function' || t === 'symbol') return null
  // Vec3 / 坐标对象 → 纯对象
  if (typeof value.x === 'number' && typeof value.y === 'number' && typeof value.z === 'number'
      && (value.constructor?.name === 'Vec3' || value.constructor?.name === 'Vector3' || value.floored !== undefined || value.offset !== undefined)) {
    return { x: value.x, y: value.y, z: value.z }
  }
  if (Array.isArray(value)) return value.map((v) => jsonSafe(v, depth + 1))
  if (value instanceof Map) { const o = {}; for (const [k, v] of value) o[String(k)] = jsonSafe(v, depth + 1); return o }
  if (value instanceof Set) return [...value].map((v) => jsonSafe(v, depth + 1))
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return `<buffer ${value.length}B>`
  if (t === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      const safe = jsonSafe(v, depth + 1)
      if (safe !== null || v === null) out[k] = safe
    }
    return out
  }
  return null
}

/**
 * 把任意值压成**无损 JSON**，用于工具返回值（宿主会校验，不合格直接报
 * 「value is not lossless JSON」）。
 *
 * 为什么必须有：DSH 的校验（packages/core/tools/src/json-schema.ts）
 *   - isPlainJsonRecord：对象的原型链必须是 Object.prototype/null
 *   - isJsonNumber：必须是有限数，且 **不允许 -0**
 * 而 mineflayer 的 position/velocity 是 **vec3 类实例**，原型对不上，整条
 * 工具直接失败。2026 实测：mc_status / mc_diag / mc_entities / mc_move /
 * mc_connect 五个工具全栽在这一个边界上（工具本身逻辑没错）。
 *
 * 规则：类实例 → 只留自有可枚举属性（Vec3 → {x,y,z}）；Date → ISO 串；
 * Map/Set → 普通对象/数组；循环引用 → '[circular]'；NaN/±Infinity → null；
 * -0 → 0；undefined/函数/symbol → 丢掉该键（数组里补 null）。
 */
export function lossless (value, seen = new WeakSet()) {
  if (value === null) return null
  const t = typeof value
  if (t === 'number') {
    if (!Number.isFinite(value)) return null
    return Object.is(value, -0) ? 0 : value
  }
  if (t === 'bigint') return value.toString()
  if (t === 'string' || t === 'boolean') return value
  if (t !== 'object') return undefined          // undefined / function / symbol
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) {
    return value.map((v) => {
      const s = lossless(v, seen)
      return s === undefined ? null : s
    })
  }
  if (value instanceof Map) return lossless(Object.fromEntries([...value].map(([k, v]) => [String(k), v])), seen)
  if (value instanceof Set) return lossless([...value], seen)
  const out = {}
  // 只取自有可枚举属性：类实例的 getter/原型方法/私有字段一并丢掉
  for (const [k, v] of Object.entries(value)) {
    const s = lossless(v, seen)
    if (s !== undefined) out[k] = s
  }
  return out
}

/** 方块名 → 单字符（给没有视觉的模型"看"地形） */
export function glyphOf (name) {
  if (!name) return '?'
  if (isAir(name)) return ' '
  if (/_water$|water|_ice$|^ice$/.test(name)) return '~'
  if (/sand/.test(name)) return '.'
  if (/_leaves$|grass_block|short_grass|tall_grass|_flower|fern|bush|cactus|moss/.test(name)) return '"'
  if (/_log$|_wood$|_planks$|fence|door|sign|stairs|slab|bookshelf|crafting_table|chest/.test(name)) return 'T'
  if (/stone|cobble|deepslate|brick|concrete|terracotta|copper|iron|gold|diamond|obsidian|quartz|purpur|anvil|enchant/.test(name)) return ':'
  if (/snow|white_|quartz|glass|iron_block/.test(name)) return '#'
  if (/dirt|podzol|mud|gravel|clay|farmland|wheat|carrot|potato|beetroot/.test(name)) return '_'
  return '+'
}

const COLORS = {
  grass_block: [106, 170, 64], dirt: [134, 96, 67], sand: [219, 207, 163], suspicious_sand: [200, 185, 140],
  sandstone: [216, 203, 155], smooth_sandstone: [214, 200, 150], stone: [125, 125, 125], cobblestone: [110, 110, 110],
  water: [51, 76, 178], ice: [160, 180, 240], snow_block: [250, 250, 250], oak_log: [110, 84, 50],
  oak_leaves: [60, 120, 45], oak_planks: [162, 130, 78], glass: [200, 220, 230], farmland: [110, 80, 50],
  wheat: [190, 180, 90], bricks: [150, 97, 83], bookshelf: [140, 110, 70], obsidian: [30, 20, 45],
}
function colorOf (name) {
  if (!name) return [70, 20, 90]
  if (COLORS[name]) return COLORS[name]
  if (/_water$/.test(name)) return [51, 76, 178]
  if (/_leaves$/.test(name)) return [55, 115, 45]
  if (/_log$|_wood$/.test(name)) return [105, 80, 48]
  if (/_planks$/.test(name)) return [162, 130, 78]
  if (/_sand/.test(name)) return [219, 207, 163]
  if (/_concrete$/.test(name)) return [160, 160, 160]
  if (/_wool$/.test(name)) return [220, 220, 220]
  if (/_ore$/.test(name)) return [125, 125, 125]
  if (/stone|cobble|deepslate|brick/.test(name)) return [120, 120, 120]
  return [150, 150, 150]
}

/* ───────────── 装备：槽位名归一 + 自动判槽（2026-09-22）─────────────
 * 为什么有这一段：原来的 `equip` 把 destination 写死成 'hand'，
 * 于是**盔甲（头/胸/腿/脚）一件都穿不上** —— 用户点名的缺口。
 * 参照实现是 opencode 里挂的那个 mc_equip（destination: hand, head, torso, legs, feet）。
 * ⚠️ mineflayer 认的副手槽叫 `off-hand`（**带连字符**），写成 offhand 会被 assert 拒掉。
 */

/** 别名 → mineflayer 槽位名；不认识的返回 null（调用方据此报错） */
const EQUIP_DEST_ALIASES = {
  hand: 'hand', main: 'hand', mainhand: 'hand', 手: 'hand', 主手: 'hand', 右手: 'hand',
  offhand: 'off-hand', off: 'off-hand', 副手: 'off-hand', 左手: 'off-hand',
  head: 'head', helmet: 'head', hat: 'head', 头: 'head', 头盔: 'head',
  torso: 'torso', chest: 'torso', chestplate: 'torso', body: 'torso', 胸: 'torso', 胸甲: 'torso', 身体: 'torso',
  legs: 'legs', leggings: 'legs', pants: 'legs', 腿: 'legs', 护腿: 'legs',
  feet: 'feet', boots: 'feet', shoes: 'feet', 脚: 'feet', 靴子: 'feet',
}

/** 归一装备槽位名；空 → null，不认识 → null（配合 `destination != null` 判"给了但不认识"）。
 *  `-`/`_`/空格一律吃掉，所以 off-hand / off_hand / off hand 都等价（mineflayer 认的是带连字符的 off-hand）。 */
export function normalizeEquipDest (dest) {
  if (dest == null) return null
  const k = String(dest).trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (!k) return null
  return EQUIP_DEST_ALIASES[k] ?? null
}

/** 盔甲四槽（穿全套、回报用） */
export const ARMOR_SLOTS = ['head', 'torso', 'legs', 'feet']

/** 装备槽在背包窗口里的下标（`inventory.items()` 只给 9–44，装备槽得单独看） */
const EQUIP_SLOT_INDEX = { head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 }

/** 同槽位有多件时挑好的：数据里没有盔甲"防御力"字段，按材质排足够用 */
const ARMOR_MATERIALS = ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'leather', 'turtle']
function armorRank (name) {
  const i = ARMOR_MATERIALS.findIndex((m) => String(name).startsWith(m + '_'))
  return i < 0 ? ARMOR_MATERIALS.length : i
}

/**
 * 猜物品该穿哪个槽。**优先用 minecraft-data 的 `enchantCategories`**
 * （armor_head / armor_chest / armor_legs / armor_feet）—— 这是数据里的权威字段，
 * 比按名字后缀硬匹配可靠：turtle_helmet、chainmail_chestplate、模组盔甲都能对上。
 * 数据里没标盔甲类别的（鞘翅、盾、南瓜头、头颅）再按名字兜底，其余一律当手持物。
 */
export function guessEquipDest (registry, itemName) {
  const name = String(itemName ?? '')
  const cats = registry?.itemsByName?.[name]?.enchantCategories ?? []
  if (cats.includes('armor_head')) return 'head'
  if (cats.includes('armor_chest')) return 'torso'
  if (cats.includes('armor_legs')) return 'legs'
  if (cats.includes('armor_feet')) return 'feet'
  if (name === 'elytra') return 'torso'
  if (name === 'shield') return 'off-hand'
  if (name === 'carved_pumpkin' || /(_head|_skull)$/.test(name)) return 'head'
  return 'hand'
}

/** 看起来像食物/药水？—— 数据里没有 edible/foodPoints 字段，只能按名字认（够用） */
const FOOD_RE = /^(apple|golden_apple|enchanted_golden_apple|bread|carrot|golden_carrot|potato|baked_potato|poisonous_potato|beetroot|beetroot_soup|melon_slice|sweet_berries|glow_berries|dried_kelp|cookie|pumpkin_pie|mushroom_stew|rabbit_stew|suspicious_stew|chorus_fruit|honey_bottle|milk_bucket|.*_stew|.*_soup|(cooked|raw)_(beef|porkchop|chicken|mutton|rabbit|cod|salmon)|tropical_fish|pufferfish|rotten_flesh|spider_eye|poisonous_potato)$/
const DRINK_RE = /^(potion|splash_potion|lingering_potion|milk_bucket|honey_bottle)$/

/** 吃/喝/拉弓这类"按住才有用"的物品：估个按住时长（毫秒）；普通物品几乎瞬时 */
function guessUseHoldMs (name) {
  const n = String(name ?? '')
  if (/^(bow|crossbow)$/.test(n)) return 1200
  if (DRINK_RE.test(n)) return 1800
  if (FOOD_RE.test(n)) return 1600
  return 120
}

/**
 * 一个 Minecraft 机器人（保活、事件、世界操作）。
 * 事件（EventEmitter）：'chat'(玩家聊天) 'system'(系统消息) 'spawn' 'end' 'kicked' 'error' 'damage' 'log'
 */
export class McBot extends EventEmitter {
  constructor (config = {}) {
    super()
    this.cfg = { ...DEFAULTS, ...config }
    // 实例标识：多会话各自一个 McBot，锁文件按实例分开（同进程 pid 相同，共用一个锁会互相误删）
    this.instanceId = String(config.instanceId ?? 'default').replace(/[^\w.-]/g, '_')
    if (!existsSync(dirname(this.cfg.logFile))) mkdirSync(dirname(this.cfg.logFile), { recursive: true })
    this.bot = null
    this.sub = null
    this.connecting = null
    this.connectedAt = 0
    this.lastError = null
    this.autoReconnect = true
    this.reconnectDelay = 5000
    this.reconnecting = false
    /** 断线期（从掉线一直置到**真重连成功**）：前端据此显示"重连中…"，见 end 处理里的说明 */
    this.reconnectPending = false
    this.chat = []            // { at, kind, who, text }
    this.inputTimer = null
    this.stopped = false
    this.lastTimeout = null
    this.abortSignal = null       // 本轮 turn 的 abort signal（工具层注入）
    this._packetSupport = new Map()  // `版本/包名 → 该版本协议里有没有这个包`（见 #supportsPacket）
    this.observerTimer = null     // 世界观察器（语义事件）
    this._obs = null
    this._selfMovingAt = 0        // 我们自己发起移动的时刻（排除"被传送"误判）
    this.stats = { connects: 0, deaths: 0, chats: 0, lastEventAt: 0, timeouts: 0 }
  }

  /**
   * 在线 = **有身体** 且 **连接还活着**。
   *
   * 🔴 2026-09-19「幽灵在线」（别人反馈，本地复现）：被踢之后 mineflayer 的 `bot.entity` **还在**，
   *    只看 entity 就会把死连接报成"在线" ⇒ 工具对着死 socket 干等（世界时间冻结、`/list` 零回应）、
   *    用户以为还在游戏里。socket 已结束（`_client.ended`）就不算在线。
   */
  get online () { return Boolean(this.bot?.entity) && this.bot?._client?.ended !== true }
  /** 当前位置（纯对象，绝不返回 Vec3） */
  get position () {
    const p = this.bot?.entity?.position
    if (!p) return null
    return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
  }

  log (...args) {
    const line = `[whale_craft ${new Date().toISOString().slice(11, 19)}] ${args.join(' ')}`
    this.emit('log', line)
    try { appendFileSync(this.cfg.logFile, line + '\n') } catch {}
  }

  /**
   * 🔴🔴 **唯一的错误上报口**（2026-09-18 P0：连一个不存在的服务器 → 整个 DSH 崩）。
   *
   * 事故现场（用户实测）：
   *   `Error: connect ECONNREFUSED 127.0.0.1:61631`
   *   `Emitted 'error' event on McBot instance at: core.mjs:671`
   *   `node:events:486  throw er; // Unhandled 'error' event`  ⇒ **进程直接死**
   *
   * 根因：`McBot extends EventEmitter`，而 **EventEmitter 的语义是"emit('error') 时若没有监听者就 throw"**。
   *   原来那行 `b.on('error', (e) => this.emit('error', e))` 把 bot 的网络错误转发到 McBot，
   *   而 McBot 通常**没有 'error' 监听者**（工具是 await 抛错返回、不订阅 error）
   *   ⇒ 一个"服务器没开"的普通错误把整个宿主带走。
   *   更早那处（认证阶段）虽然是 `try { this.emit('error', err) } catch {}`，
   *   但 **try/catch 对 emit 自抛无效**（它就是抛出来的那个异常）—— 假保护。
   *
   * 现在的规矩：**任何错误都先进这里**，它保证
   *   ① 记 `lastError`（工具层据此给出人话）；
   *   ② 记一行日志（能被 `mc_diag` / 日志看到）；
   *   ③ **只在真有监听者时才 emit**（数量用 `listenerCount` 判断）—— 没人听就到此为止，绝不 throw；
   *   ④ 自己再兜一层 try/catch（监听者回调里抛错也不该带走进程）。
   * @param {unknown} e - 原始错误（socket / 认证 / 被踢…）
   * @returns {Error} 归一化后的错误（调用方想用就用）
   */
  #reportError (e) {
    const err = e instanceof Error ? e : new Error(String(e?.message ?? e ?? '未知错误'))
    if (err.message) this.lastError = err.message
    try { this.log(`连接/运行错误：${err.message}`) } catch { /* 日志失败不致命 */ }
    try {
      if (this.listenerCount('error') > 0) this.emit('error', err)
    } catch (inner) {
      try { this.log(`error 监听者自身抛错（已吞掉，不影响进程）：${inner?.message ?? inner}`) } catch {}
    }
    return err
  }

  /**
   * 所有直接打给 mineflayer 的 await 都必须过这里。
   * 双重保险：① 监听本轮 turn 的 abort signal（用户按停止 → 立即结算）
   *          ② 本地 deadline（服务端不回 ack → 到点结算）
   * 任一触发都：记 stats/lastTimeout → 松控制位（防"一直按住"跑飞）→ 抛错让工具正常返回。
   * 这样 execute **必然结算**，turn 就不会永久卡在"生成中"。
   */
  #t (promise, kind, label = kind) {
    const ms = this.cfg.timeouts?.[kind] ?? TIMEOUTS[kind] ?? 10_000
    const raced = raceAbort(promise, this.abortSignal, label)
    return withTimeout(raced, ms, label).catch((e) => {
      if (e?.mcTimeout || e?.mcAborted) {
        this.stats.timeouts++
        this.lastTimeout = { kind, label, at: Date.now(), aborted: Boolean(e.mcAborted) }
        this.#releaseControls()
        this.log(`⚠️ ${label} ${e.mcAborted ? '被用户中断' : `超时（${ms}ms）`} → 已松控制位，标记为可能失步`)
      }
      throw e
    })
  }

  /** 松掉所有控制位（超时/中断后必做，否则"一直按住前进"会跑飞） */
  #releaseControls () {
    try {
      for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']) {
        this.bot?.setControlState?.(k, false)
      }
    } catch {}
  }

  /**
   * 注入本轮 turn 的 abort signal（`exec.signal`）。
   * 由 index.js 的 asTool 在每次 execute 前设置——不用清：同一 turn 内所有工具
   * 共享**同一个** signal 对象，下一 turn 会被新的覆盖。
   */
  setAbortSignal (signal) { this.abortSignal = signal ?? null }

  /* ───────────── 世界观察器（把"变化"变成语义事件，供看门狗判定唤醒）───────────── */

  /**
   * 启动观察器：每 1s 对比快照，产出 mineflayer 本身**不提供**的语义事件：
   *   'teleport'    位置瞬移（>24 格/秒）= 多半被玩家传送
   *   'pushed'      非自主移动（没按方向键却位移）= 被推/水流
   *   'pickup'      背包总数变多 = 捡到物品
   *   'playerJoin' / 'playerLeave'
   *
   * 为什么放这里而不是看门狗里：这是"世界读取"，属于机器人核心的能力；
   * 看门狗只负责"判定要不要叫醒我"，不该自己解析世界。
   */
  startObserver () {
    if (this.observerTimer) return
    this._obs = {
      lastPos: this.position,
      lastPlayers: new Set(Object.keys(this.bot?.players ?? {})),
      lastInv: this.#invSignature(),
    }
    // 🔴 回调自己兜住异常：`setInterval` 回调里抛错 = **uncaughtException** = 整个宿主进程死
    //    （宿主只对 `unhandledRejection` 做 fail-loud，这条通道它不防）。观察 tick 出错最多是少看一眼世界。
    this.observerTimer = setInterval(() => { try { this.#observeTick() } catch (e) { this.#reportError(e) } }, 1000)
    this.observerTimer.unref?.()
  }

  stopObserver () {
    if (this.observerTimer) { clearInterval(this.observerTimer); this.observerTimer = null }
    this._obs = null
  }

  #invSignature () {
    const items = this.bot?.inventory?.items?.() ?? []
    let total = 0
    const map = {}
    for (const it of items) {
      const c = it?.count ?? 0
      total += c
      map[it.name] = (map[it.name] ?? 0) + c
    }
    return { total, map }
  }

  #observeTick () {
    const b = this.bot
    if (!b?.entity || !this._obs) return
    const now = Date.now()
    const pos = this.position
    const obs = this._obs

    // ① 玩家上下线
    const players = new Set(Object.keys(b.players ?? {}))
    for (const p of players) {
      if (!obs.lastPlayers.has(p) && p !== b.username) this.emit('playerJoin', { who: p })
    }
    for (const p of obs.lastPlayers) {
      if (!players.has(p)) this.emit('playerLeave', { who: p })
    }
    obs.lastPlayers = players

    // ② 位置突变（排除我们自己飞/走造成的变化——那由 _selfMovingAt 标记）
    const selfMovedRecently = now - (this._selfMovingAt ?? 0) < 3000
    if (obs.lastPos && pos && !selfMovedRecently) {
      const d = Math.hypot(pos.x - obs.lastPos.x, pos.y - obs.lastPos.y, pos.z - obs.lastPos.z)
      const cs = b.controlState ?? {}
      const pressing = Boolean(cs.forward || cs.back || cs.left || cs.right || cs.jump)
      if (d > 24) this.emit('teleport', { from: obs.lastPos, to: pos, distance: Number(d.toFixed(1)) })
      else if (d >= 2 && !pressing) this.emit('pushed', { from: obs.lastPos, to: pos, distance: Number(d.toFixed(1)) })
    }
    obs.lastPos = pos

    // ③ 捡到物品（背包总数变多）
    const inv = this.#invSignature()
    if (inv.total > obs.lastInv.total) {
      const gained = []
      for (const [n, c] of Object.entries(inv.map)) {
        const delta = c - (obs.lastInv.map[n] ?? 0)
        if (delta > 0) gained.push(`${n}x${delta}`)
      }
      if (gained.length) this.emit('pickup', { items: gained })
    }
    obs.lastInv = inv
  }

  /* ───────────── 连接与保活 ───────────── */

  /**
   * 连接到 MC 服务器。
   *
   * 🔴 用户 2026-09-16：**凭据不再从这里传**（LLM 不得接触密码/token）。
   *    插件层先把账户解析成一个 `auth` 描述符，再交给这里：
   *      · `{ mode:'offline',   name, uuid? }`                     —— 离线（uuid 空则按名字派生）
   *      · `{ mode:'yggdrasil', authUrl, authUser, authPass?, accessToken?, clientToken? }` —— 皮肤站
   *
   * @param {Object} opts
   * @param {string} [opts.host] / [opts.port] / [opts.subserver]
   * @param {string|false} [opts.version] - 协议版本（默认 false=自动探测）
   * @param {Object} [opts.auth] - 上面的账户描述符（**唯一**的凭据入口）
   */
  async connect (optsOrSub = {}, legacyOpts = {}) {
    // 兼容旧签名 connect('mc.example.com')
    const opts = typeof optsOrSub === 'string'
      ? { subserver: optsOrSub, ...legacyOpts }
      : { ...optsOrSub }

    const host    = opts.host      || this.cfg.host      || DEFAULTS.host
    const port    = Number(opts.port ?? this.cfg.port ?? DEFAULTS.port)
    const sub     = opts.subserver || this.cfg.subserver || DEFAULTS.subserver || ''
    const version = opts.version   ?? false
    const auth    = opts.auth ?? null

    if (!host) {
      throw new Error('缺少服务器地址：需要 host（通过 mc_connect 的 host 参数或 MC_HOST 环境变量提供）')
    }
    if (!auth?.mode) {
      throw new Error('缺少登录账户：先用 mc_accounts{action:"use", innerID:"..."} 选一个账户，'
        + '或在 mc_connect 里用 account 参数指名（账户在「MC设置」里维护）')
    }

    // 记录当前生效的连接参数（给 mc_status 用，**不含任何凭据**）
    this._connectionProfile = {
      host, port, subserver: sub, version,
      authMode: auth.mode,
      account: auth.label ?? auth.name ?? null,
    }

    if (this.online && this.sub === sub && this._lastHost === host) return this.bot
    if (this.connecting) { await this.connecting.catch(() => {}); if (this.online) return this.bot }

    const attemptOnce = async (attempt) => {
      // 账户 → session（离线自己造；皮肤站 token 优先刷新）。凭据只在这一层出现。
      const session = await this.#makeSession(auth)
      // 让插件层有机会把新令牌/档案信息回写到凭据库（回调收到的是含密钥的 session，**只给插件层**）
      try { if (typeof opts.onAuth === 'function') opts.onAuth({ mode: auth.mode, profile: session.selectedProfile, session }) } catch (e) { this.log('onAuth 回调出错：' + e.message) }
      const profile = session.selectedProfile
      const uuid = dashUuid(profile.id) ?? profile.id
      const previous = this.bot

      const b = mineflayer.createBot({
        host,
        port,
        username: profile.name,
        fakeHost: sub || undefined,           // Velocity 按 forced-host 路由子服；空串不传
        // 皮肤站才需要 sessionServer；离线自己造 session，不碰认证服
        ...(auth.mode === 'yggdrasil' ? { sessionServer: `${auth.authUrl}/sessionserver` } : {}),
        accessToken: session.accessToken,
        version,                              // false = 自动探测
        auth: (client, options) => {
          client.session = session
          client.uuid = uuid
          client.username = profile.name
          client.emit('session', session)
          // 🔴 只有**皮肤站**（有真凭据）才 haveCredentials=true；离线账户必须 false，
          //    否则 encrypt.js 会拿假 token 去 sessionserver 做 session join → ForbiddenOperationException
          //    → 悬空拒绝 → 宿主 fail-loud exit(1)（2026-09-17 真炸过，见 .agent-docs）
          const flags = sessionFlags(auth.mode)
          options.haveCredentials = flags.haveCredentials
          if (flags.useAccessToken) {
            options.accessToken = session.accessToken
            options.session = session
          }
          // ⚠️ 必须显式调用；而且**必须接住它的 rejection**：
          //    皮肤站的 session join 失败（令牌失效）会从这里冒出来，
          //    不接住就是"未处理的 Promise 拒绝"→ 宿主的 fail-loud 直接 exit(1)（2026-09-17 真炸过）。
          const p = options.connect(client)
          if (p && typeof p.catch === 'function') {
            p.catch((e) => {
              const err = friendlyAuthError(e)
              this.autoReconnect = false            // 认证失败重连多少次都一样，别刷屏
              // 🔴 走统一上报口：老写法是 `this.emit('error', err)` 包在 try/catch 里 ——
              //    **emit 无监听者时自己就 throw，try/catch 拦不住同一次 emit 抛出的异常**
              //    （2026-09-17 那次"未处理拒绝把 DSH 干掉"是同一族，这里再堵死一遍）。
              this.#reportError(err)
            })
          }
        },
      })
      b._createdAt = Date.now()

      // ──── 挂 pathfinder（mc_hunt 自动追击：寻路 + 自动挖挡路方块 + 自动垫脚）────
      // 官方 README 与参考项目 bot.ts:136 都是 createBot 返回后立刻 loadPlugin。
      // 挂失败不致命：hunt() 里会再检查 bot.pathfinder 并给出清晰报错。
      if (pathfinderPlugin) {
        try { b.loadPlugin(pathfinderPlugin) } catch {}
      }

      // ──── AuthMe 6.x 对话框登录（26.2 Paper + Dialog API） ────
      // AuthMe preJoin 对话框在 configuration 阶段下发，必须用 custom_click_action 回复密码，
      // 否则 loginCancelKicks=true 时会被踢。preJoin.enable=true 时此流程不可跳过。
      const authmePwd = this.cfg.authmePassword
      if (authmePwd && prismarineNBT) {
        const submitAuthMeDialog = (data) => {
          try {
            // dialog 可能是 registryEntryHolder，真正的 NBT 在 .data 上
            let dialog = data?.dialog ?? data
            if (dialog?.data) dialog = dialog.data

            let simple = {}
            try { simple = prismarineNBT.simplify(dialog) || {} } catch { simple = {} }

            // 从对话框里解析出提交按钮的 action id 和输入框的 key
            const submitId =
              (Array.isArray(simple.actions) ? simple.actions : [])
                .map((a) => a?.action?.id)
                .find((id) => typeof id === 'string' && id.endsWith('/submit')) ||
              'authme:prejoin-login/submit'
            const inputKey =
              (Array.isArray(simple.inputs) && simple.inputs[0]?.key) || 'password'

            const payloadNbt = prismarineNBT.comp({ [inputKey]: prismarineNBT.string(authmePwd) })
            const fullNbt = prismarineNBT.writeUncompressed(payloadNbt, 'big')
            // 匿名 NBT：保留根 compound 类型字节(0x0a)，去掉根名(00 00)
            const anonNbt = Buffer.concat([fullNbt.subarray(0, 1), fullNbt.subarray(3)])

            const idBuf = Buffer.from(submitId, 'utf8')
            // configuration 阶段 packet id = 0x08，play 阶段 = 0x44
            const packetId = b._client?.state === 'play' ? 0x44 : 0x08
            const body = Buffer.concat([
              writeVarInt(packetId),
              writeVarInt(idBuf.length), idBuf,
              writeVarInt(anonNbt.length), anonNbt,
            ])
            b._client.writeRaw(body)
            this.log('AuthMe 对话框已提交（submitId=' + submitId + '）')
          } catch (e) {
            this.log('AuthMe 对话框提交失败：' + (e?.message ?? e))
          }
        }
        b._client.on('packet', (data, meta) => {
          if (meta.name === 'show_dialog') submitAuthMeDialog(data)
        })
      }

      let dupe = false
      b.on('error', (e) => { this.#reportError(e) })
      b.on('kicked', (r) => {
        const text = typeof r === 'string' ? r : JSON.stringify(r)
        this.lastError = `被踢: ${text.slice(0, 300)}`
        // 「已连接」类顶号错误短时间重试（服务器放掉旧会话要几秒）
        if (/already connected|already logged/i.test(text) && Date.now() - b._createdAt < 9000) dupe = true
        else this.autoReconnect = false
        this.log(this.lastError)
      })
      b.on('end', (r) => {
        const why = this.lastError ?? '连接结束'
        // 🔴 2026-09-19：断线必须**主动播报**（AI 与前端都要马上知道），不能等下一次工具调用才发现。
        //    以前这里只写日志：于是"被踢之后 mc_status 还说在线、看门狗还挂着、AI 以为还在游戏里"。
        const willReconnect = Boolean(this.autoReconnect && this.bot === b && !this.stopped)
        this.log('连接结束', r ?? '')
        this.stopInputPackets()
        // 「断线期」标记：一直置到**真重连成功**为止。
        // why：`reconnecting` 只在"两次尝试之间的等待窗口"为真，一旦开始尝试连接（最长 45s）它就变 false——
        //      只看它的话，状态条在那 45 秒里会从"重连中…"退回"未上线"，看着像插件放弃了。
        if (willReconnect) this.reconnectPending = true
        this.emit('offline', { sub, reason: why, willReconnect, at: Date.now() })
        if (willReconnect) this.#scheduleReconnect(sub)
      })
      b.on('death', () => { this.stats.deaths++; this.emit('death', { position: this.position }) })
      b.on('health', () => {
        if (b.health !== undefined && b.health <= 6) this.emit('damage', { health: b.health, position: this.position })
      })
      this.wireChatEvents(b)

      try {
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error(`连接 ${sub} 超时`)), this.cfg.connectTimeoutMs)
          b.once('spawn', () => {
            clearTimeout(t)
            // ──── AuthMe post-join /login 命令 ────
            // preJoin 对话框登录成功后，服务器可能还需要 post-join /login 命令。
            // 如果对话框已经登录成功，这条命令会多余但不会出错（AuthMe 会忽略已登录玩家）。
            if (authmePwd) {
              try { b.chat(`/login ${authmePwd}`) } catch {}
            }
            resolve()
          })
          b.once('kicked', (r) => { clearTimeout(t); reject(new Error(`被踢: ${String(r).slice(0, 200)}`)) })
        })
      } catch (e) {
        try { b.quit() } catch {}
        if (dupe && attempt < 4) {
          this.log(`顶号冲突，3.5s 后重试（第 ${attempt} 次）`)
          await sleep(3500)
          return attemptOnce(attempt + 1)
        }
        if (previous?.entity) { this.bot = previous; this.log('新连接失败，保留原有连接') }
        // 认证/入服失败（令牌失效等）：转成"需要用户处理"的明确错误；
        // 顺便把 yggdrasil 兼容层记下的那个 session-join 失败也捞出来当原因。
        const joinErr = takeAuthJoinError()
        throw friendlyAuthError(joinErr ?? e)
      }

      if (previous && previous !== b) { try { previous.quit() } catch {} }
      this.bot = b
      this.sub = sub
      this._lastHost = host          // ⚠️ 必须记：否则上面的"已连着就直接返回"永不生效，
                                     //    重复 mc_connect 会真去重连（先把自己踢下线再登回来）
      this.connectedAt = Date.now()
      this.stats.connects++
      this.autoReconnect = true
      this.reconnectPending = false      // 进来了就算"断线期"结束（手动 mc_connect 也算）
      this.startInputPackets()
      this.startObserver()
      this.writeLock()
      this.log(`已进入 ${sub} @ (${this.position?.x},${this.position?.y},${this.position?.z}) gamemode=${b.game?.gameMode}`)
      this.emit('spawn', { sub, position: this.position, gamemode: b.game?.gameMode })
      return b
    }

    this.connecting = attemptOnce(1)
    // 🔴 再挂一个 catch：调用方可能被 abort/取消而不再 await 这个 promise，
    //    那样它的 rejection 就成了"未处理拒绝"→ 宿主 fail-loud 直接 exit(1)。
    this.connecting.catch(() => {})
    try { return await this.connecting } finally { this.connecting = null }
  }

  #scheduleReconnect (sub) {
    if (this.reconnecting || this.stopped) return
    this.reconnecting = true
    this.log(`断线，${this.reconnectDelay / 1000}s 后重连 ${sub}`)
    setTimeout(async () => {
      this.reconnecting = false
      try {
        await this.connect(sub)
        this.reconnectDelay = 5000
        // 真回来了才算"断线期"结束（前端/状态据此从"重连中…"切回"在游戏中"）
        this.reconnectPending = false
        this.emit('reconnect', { sub })
      } catch (e) {
        this.log('重连失败：' + e.message)
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000)
        this.#scheduleReconnect(sub)
      }
    }, this.reconnectDelay).unref?.()
  }

  /**
   * 下线。**先优雅退出，真走不掉才强断**（用户 2026-09-16 要求："一定要先尝试退出游戏"）。
   *
   *   ① 先关掉自动重连 / 输入上报 / 世界观察器 —— 否则退服事件会把看门狗又吵醒
   *   ② `bot.quit(reason)` 发正常的断开包，给它 graceMs（默认 3s）自己走完
   *   ③ 还没走掉才 `_client.end()` 强断（兜底，不允许吊死）
   *
   * ⚠️ 宽限计时器**故意不 unref**：我们就是"在等"，unref 掉会让"只有它在跑"时进程直接退出。
   * @returns {Promise<{graceful:boolean, forced:boolean, ms:number}>}
   */
  async disconnect (reason = '主动下线', { graceMs = 3000 } = {}) {
    const t0 = Date.now()
    this.stopped = true
    this.autoReconnect = false
    this.stopInputPackets()
    this.stopObserver()

    const b = this.bot
    let graceful = false
    let forced = false

    if (b) {
      // 等它自己走完（end / kicked 任一即算走掉；到点还没走就强断）
      let sawEnd = false
      let timer = null
      const settled = new Promise((resolve) => {
        let done = false
        const finish = (byEvent) => {
          if (done) return
          done = true
          if (byEvent) sawEnd = true
          if (timer) clearTimeout(timer)
          resolve()
        }
        try { b.once('end', () => finish(true)) } catch {}
        try { b.once('kicked', () => finish(true)) } catch {}
        timer = setTimeout(() => finish(false), graceMs)
      })
      try { b.quit(reason) } catch { /* quit 本身失败 → 直接进强断 */ }
      await settled
      graceful = sawEnd || this.bot !== b || !this.online
      if (!graceful) {
        try { b._client?.end?.(reason); forced = true } catch {}
      }
    }

    this.releaseLock()
    this.bot = null
    const ms = Date.now() - t0
    this.log(`已下线：${reason}（${graceful ? '优雅退出' : forced ? '强制断开' : '本来就没连接'}，${ms}ms）`)
    return { graceful, forced, ms }
  }

  /**
   * 只做认证、**不连服**（给「刷新账户」用）。
   * 🔴 返回值**脱敏**：只有名字/uuid/有没有令牌，绝不含 accessToken。
   * 需要持久化新令牌的调用方，用 `onSession` 回调拿（那个 session 只活在插件层）。
   */
  async authOnly (auth, { onSession = null } = {}) {
    const session = await this.#makeSession(auth)
    try { if (typeof onSession === 'function') onSession(session) } catch { /* 回调出错不影响结果 */ }
    const p = session.selectedProfile ?? {}
    return { ok: true, name: p.name ?? null, uuid: dashUuid(p.id), hasToken: Boolean(session.accessToken) }
  }

  /**
   * 账户描述符 → mineflayer 能用的 session。
   *
   *   · `offline`：**自己造** session —— 这样才能支持"自定义 UUID"；
   *     不传 uuid 就按 `OfflinePlayer:<name>` 派生（与官方离线服务器一致）。
   *   · `yggdrasil`（皮肤站）：先拿缓存 accessToken 走 `refresh`（避免每次都用密码），
   *     刷新失败且存了密码才 `authenticate`；两样都没有就报"需要用户处理"。
   *
   * ⚠️ 这里（以及 #authenticate/#refresh）是全插件**唯一**接触凭据的地方；
   *    返回值只给 mineflayer，不进工具输出、不进 HTTP 响应。
   */
  async #makeSession (auth) {
    if (auth.mode === 'offline') {
      const name = String(auth.name ?? '').trim()
      if (!name) throw new Error('离线账户缺少名字——这是插件内部 bug，请报告')
      const uuid = dashUuid(auth.uuid) ?? offlineUuid(name)
      const bare = uuid.replace(/-/g, '')
      return {
        accessToken: '0',
        clientToken: '0',
        selectedProfile: { id: bare, name },
        availableProfiles: [{ id: bare, name }],
      }
    }
    if (auth.mode !== 'yggdrasil') throw new Error(`不支持的登录方式：${auth.mode}（只有 offline / yggdrasil）`)

    const base = normalizeBaseUrl(auth.authUrl)
    if (!base) throw new Error('认证端点为空（authUrl）——这是插件内部 bug，请报告')

    if (auth.accessToken) {
      try {
        const refreshed = await this.#refresh({ authUrl: base, accessToken: auth.accessToken, clientToken: auth.clientToken })
        if (refreshed?.accessToken) return refreshed
      } catch (e) { this.log(`token 刷新失败，改用密码重新登录：${e.message}`) }
    }
    if (auth.authUser && auth.authPass) {
      return this.#authenticate({ authUrl: base, authUser: auth.authUser, authPass: auth.authPass })
    }
    const err = new Error('这个账户的登录状态已失效，而且没有保存密码')
    err.needUserAction = true
    err.hint = '请让用户在「MC设置」里重新登录这个账户（或点该账户的「刷新」手动刷一次）'
    throw err
  }

  /** 用 refreshToken 换新 accessToken（皮肤站 Yggdrasil 标准端点） */
  async #refresh ({ authUrl, accessToken, clientToken }) {
    const base = normalizeBaseUrl(authUrl)
    if (!base) throw new Error('认证端点为空（authUrl）——这是插件内部 bug，请报告')
    if (!accessToken) throw new Error('refresh 需要 accessToken')
    const res = await fetch(`${base}/authserver/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken, clientToken: clientToken ?? undefined, requestUser: true }),
    })
    if (!res.ok) {
      const e = new Error(`刷新访问令牌失败 HTTP ${res.status}`)
      if (res.status === 401 || res.status === 403) e.needUserAction = true
      throw e
    }
    const session = await res.json()
    if (!session?.selectedProfile?.name) throw new Error('刷新返回异常（没拿到档案）')
    return session
  }

  /**
   * 调 Yggdrasil 外置登录。
   *
   * 🔴 这里曾经有个真 bug（2026-09-15 真机暴露）：调用点早就改成传 `{authUrl,...}`，
   *    但本方法**签名没接参数、函数体还在读 `this.cfg.authUrl`**（配置里已清空），
   *    于是退化成 `fetch('/authserver/authenticate')` → `Failed to parse URL`。
   *    守卫检查的是调用点算出的局部变量（所以"不传凭据就报缺凭据"看起来正常），
   *    fetch 用的却是空的 cfg —— 两个来源不一致才让这个 bug 藏了这么久。
   * ⚠️ 以后改动这里务必保证：**只用参数，不读 this.cfg**。
   */
  async #authenticate ({ authUrl, authUser, authPass } = {}) {
    const base = normalizeBaseUrl(authUrl)
    if (!base) throw new Error('认证端点为空（authUrl）——这是插件内部 bug，请报告')
    if (!authUser || !authPass) {
      const e = new Error('这个账户没有可用的密码——请在「MC设置」里重新登录它')
      e.needUserAction = true
      e.hint = '让用户在「MC设置」里重新登录该账户，或点它的「刷新」'
      throw e
    }
    const res = await fetch(`${base}/authserver/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 🔴 `agent` 是 **Yggdrasil 官方协议里 authenticate 的必填字段**（authlib-injector / 官方
      //    Minecraft 客户端都会发）。我们以前没发，多数皮肤站容忍，但 **LittleSkin 的新实现
      //    `Yggdrasil Connect` 不容忍**：缺 agent 直接回 **400**（不是 401/403），
      //    症状就是"LittleSkin 账号一直显示 400 认证失败，而认证服务器那种老实现没事"。
      //    2026-09-19 实测对照（同一地址、只差这一个字段）：
      //      LittleSkin 缺 agent → 400 ｜ 带 agent（假账号）→ 403（正常走完校验）
      //      认证服务器       缺 agent → 403 ｜ 带 agent         → 401
      body: JSON.stringify({
        agent: { name: 'Minecraft', version: 1 },
        username: authUser,
        password: authPass,
        requestUser: true,
      }),
    })
    if (!res.ok) {
      const e = new Error(`认证失败 HTTP ${res.status}`)
      if (res.status === 400) {
        // 400 基本只有两种来路：请求体不合规（最常见就是认证服要求某个字段）、或账号格式被拒。
        e.hint = '认证服拒绝了这次请求（400）。若这个皮肤站换过实现，可能是它要求的请求字段变了——把这条报给插件维护者'
      }
      if (res.status === 401 || res.status === 403) {
        e.needUserAction = true
        e.hint = '账号或密码可能已经变了——请让用户在「MC设置」里重新登录这个账户'
      }
      throw e
    }
    const session = await res.json()
    if (!session?.selectedProfile?.name) {
      const e = new Error('认证返回异常（没拿到游戏档案）')
      e.needUserAction = true
      e.hint = '让用户在「MC设置」里重新登录/手动刷新该账户'
      throw e
    }
    return session
  }

  /**
   * 这个版本的协议数据里有没有这个 **serverbound** 包？
   *
   * 🔴 为什么必须有这道检查：protodef **对未知包名不报错**，而是写出「id=0x00 + 空 body」——
   *    服务端会把它当成自己注册表里 id 0x00 的那个包去解，于是报出一个**与我们真正发的包毫无关系**
   *    的错误名（2026-09-19：1.21.1 上误发 player_input → 服务端报 accept_teleportation 解不开 → 踢人）。
   *    所以**任何版本相关的包都必须先查后发**。
   * @param {string} version mineflayer 报的版本字符串（如 `1.21.1` / `26.2`）
   * @param {string} name    包名（不带 `packet_` 前缀）
   */
  #supportsPacket (version, name) {
    const key = `${version ?? '?'}/${name}`
    if (this._packetSupport.has(key)) return this._packetSupport.get(key)
    let ok = false
    try {
      const data = requireFromMineflayer('minecraft-data')(version)
      ok = Boolean(data?.protocol?.play?.toServer?.types?.[`packet_${name}`])
    } catch { ok = false }                 // 数据里没这个版本 / 解析不了 → 当作不支持
    this._packetSupport.set(key, ok)
    return ok
  }

  /** 26.2 必须：20Hz 上报按键位（位名是 shift 不是 sneak）。
   *
   * 🔴 **只在"这个版本真有 `player_input` 包"时才发**（2026-09-19 事故，别人反馈 + 本地真 1.21.1 复现）：
   *    `minecraft-protocol` 的 protodef **遇到未知包名不报错**，它会写出 `[len=2][0][0x00]`
   *    —— 也就是「包 id = 0x00、body 为空」。服务端把 id 0x00 当成它自己的
   *    `accept_teleportation`（1.21.x 里确认传送就是 0x00），去读 teleportId 时没有字节 ⇒
   *      `io.netty.handler.codec.DecoderException: Failed to decode packet 'serverbound/minecraft:accept_teleportation'`
   *    ⇒ **立刻踢人**。现象极具迷惑性：进服完全成功、1 秒后掉线，错误却指向"确认传送"。
   *    实测：**1.21 / 1.21.1（协议 767）没有 `player_input`**；1.21.3+（含 26.2）才有。
   *    （所以那次只报 1.21.1 掉线、26.2 一切正常 —— 不是版本兼容性玄学，是包不存在。）
   */
  startInputPackets () {
    if (!this.cfg.inputPacket || this.inputTimer) return
    const version = this.bot?.version
    if (!this.#supportsPacket(version, 'player_input')) {
      this.log(`按键上报兼容层不启用：${version ?? '未知版本'} 的协议里没有 player_input 包（1.21/1.21.1 没有，1.21.3+ 才有）`)
      return
    }
    this.inputTimer = setInterval(() => {
      const b = this.bot
      if (!b?._client || b._client.ended) return
      // 重连可能换了版本：每次都按当前版本再确认一遍（结果有缓存，不贵）
      if (!this.#supportsPacket(b.version, 'player_input')) { this.stopInputPackets(); return }
      const cs = b.controlState ?? {}
      try {
        b._client.write('player_input', {
          inputs: {
            forward: Boolean(cs.forward), backward: Boolean(cs.back),
            left: Boolean(cs.left), right: Boolean(cs.right),
            jump: Boolean(cs.jump), shift: Boolean(cs.sneak), sprint: Boolean(cs.sprint),
          },
        })
      } catch (e) { this.log('player_input 失败，停用兼容层：' + e.message); this.stopInputPackets() }
    }, 50)
    this.inputTimer.unref?.()
  }

  stopInputPackets () {
    if (this.inputTimer) { clearInterval(this.inputTimer); this.inputTimer = null }
  }

  /* ───────────── 单实例锁（按实例分文件：同进程多会话不能共用一把锁） ───────────── */

  /**
   * 单实例锁文件（连服时才有，断开即删）。
   *
   * 🔴 默认**不写插件包目录**（与日志同一个道理）：装进 `node_modules/` 后那可能是只读的，
   *    升级时也会被覆盖。优先用调用方给的 `lockDir`（= `$DSH_HOME/whale_craft/`），
   *    只有没给时才退回包目录（老行为，保底能用）。
   */
  get lockFile () {
    const dir = this.cfg.lockDir || HERE
    return join(dir, `.instance.${this.instanceId}.json`)
  }

  writeLock () {
    try {
      const f = this.lockFile
      if (!existsSync(dirname(f))) mkdirSync(dirname(f), { recursive: true })
      writeFileSync(f, JSON.stringify({ pid: process.pid, instanceId: this.instanceId, at: new Date().toISOString(), sub: this.sub }))
    } catch {}
  }

  releaseLock () {
    try {
      const rec = JSON.parse(readFileSync(this.lockFile, 'utf8'))
      if (Number(rec?.pid) === process.pid && rec?.instanceId === this.instanceId) unlinkSync(this.lockFile)
    } catch {}
  }

  /* ───────────── 聊天记录 ───────────── */

  /**
   * 把 mineflayer 的聊天/系统消息接到本实例的 `chat` / `system` 事件上。
   *
   * 🔴🔴 2026-09-16 真机事故（用户："喊我不应，只能 tp 我"）：
   *    以前只有 `_client.on('player_chat')`（**签名**聊天包）才 `emit('chat')`，
   *    而 `bot.on('message')`（`system_chat`，**未签名**聊天）被一律当成 system 丢掉。
   *    对**局域网开放的世界 / 离线服 / 1.19+ 关掉签名聊天**的服务器，玩家说话走的正是
   *    `system_chat` → `player_chat` 永不触发 → 看门狗的 mention / nearbySpeech **全哑**，
   *    只剩 damage / death / teleport 能用（`stats.chats === 0`、看门狗日志里一条 chat 都没有）。
   *
   * 现在按 mineflayer 的约定分流（`lib/plugins/chat.js` 里两种包的 emit 签名）：
   *    · `position === 'chat'`  → 来自 playerChat（签名）→ 由下面的 `player_chat` handler 处理，
   *      这里**直接跳过**（否则同一条进两遍）
   *    · `position === undefined`→ 来自 systemChat 的 **positionId 0 = 聊天**（未签名）
   *    · `position === 'system'` → 来自 systemChat 的 **positionId 1**：**也要按"内容"再判一次**
   *      —— 有的服务端（LAN 开放世界 / 某些插件）把玩家聊天塞进 system 位置，渲染出来仍是
   *      `<名字> 正文`。实验体 2026-09-16 的证据就是这样：事件队列里全是 `kind: system`、
   *      文本形如 `<<user>> tp我，ds。`，而看门狗只对 `chat` 判定 ⇒ mention 永远打不中。
   *    · `position === 'game_info'`（动作栏）→ 一律 system（动作栏刷屏不该唤醒）
   *    · 其余 → 系统消息
   *
   * ⚠️ 这是**公开方法**（不放在 connect 里内联）：自检要能用假 bot 走同一条代码路径 ——
   *    "喊我能不能醒"这种链路，断言必须落在真实实现上，不能只 grep 源码。
   * @param {object} b mineflayer bot（`on` + `_client`）
   */
  wireChatEvents (b) {
    b.on('message', (msg, position) => {
      const text = this.#plain(msg)
      if (position === 'chat') return                    // 签名聊天：player_chat 那条路已处理
      if (position !== 'game_info') {                    // 动作栏除外，其余都按内容再判一次
        const parsed = this.#playerChatFrom(msg, text)
        if (parsed) {
          this.#emitPlayerChat(parsed.who, parsed.text, b.username)
          return
        }
      }
      this.#pushChat('system', null, text)
      this.emit('system', { text })
    })
    b._client?.on?.('player_chat', (p) => {
      const who = String(p?.networkName?.value ?? p?.networkName ?? '?')
      const text = p?.plainMessage ?? ''
      this.#emitPlayerChat(who, text, b.username)
    })
    return b
  }

  #plain (msg) {
    try { return msg.toString().replace(/§./g, '') } catch { return String(msg) }
  }

  /**
   * 一条"玩家说话"进账（**唯一入口**：签名聊天与未签名聊天都走这里）。
   * 自带 1.5 秒去重：同一句同一人在极短时间内从两条路各来一次（理论上不会）也只发一次。
   */
  #emitPlayerChat (who, text, selfName) {
    const w = String(who ?? '?')
    const t = String(text ?? '')
    if (!t) return
    const key = `${w}\u0000${t}`
    const now = Date.now()
    if (this._lastChatKey === key && now - (this._lastChatAt ?? 0) < 1500) return
    this._lastChatKey = key
    this._lastChatAt = now
    this.#pushChat('player', w, t)
    this.stats.chats++
    this.stats.lastEventAt = now
    if (w !== selfName) this.emit('chat', { who: w, text: t })
  }

  /**
   * 从 `bot.on('message')` 收到的消息里**认出"玩家聊天"**（未签名聊天：LAN 开放世界 / 离线服 / 1.19+）。
   *
   * 判据按 translate 键（服务端给的聊天类型），只认这几种"有人在说话"的：
   *    · `chat.type.text`                    —— 普通公屏（渲染成 `<名字> 正文`）
   *    · `chat.type.team.text` / `.team.*`    —— 队伍聊天（with = [队伍, 发送者, 正文]）
   *    · `commands.message.display.incoming` —— 别人私聊我（with = [发送者, 正文]）
   * ④ 兜底看**渲染出来的形状**：`<名字> 正文`。
   *    🔴 这条是从实验体的证据里补的（2026-09-16）：有的服务端把玩家聊天发在 **system 位置**
   *    （positionId 1），translate 也可能是它自己那套；但渲染出来就是 `<<user>> tp我，ds。`。
   *    只按 positionId / translate 判的话，这类消息会永远停在 system 桶里，mention 一辈子打不中。
   *    宁可偶尔把"看起来像聊天的系统消息"算成聊天（最多多醒一次），也不能漏掉真人喊话。
   * @returns {{who:string, text:string}|null}
   */
  #playerChatFrom (msg, plain) {
    const t = String(msg?.translate ?? '')
    const withParts = Array.isArray(msg?.with) ? msg.with : []
    const partText = (p) => {
      if (p === null || p === undefined) return ''
      if (typeof p === 'string') return p
      if (typeof p.text === 'string') return p.text
      try { return String(p) } catch { return '' }
    }

    // ① 队伍聊天：who 取**发送者**（with[1]），不是队伍名
    if (/^chat\.type\.team\./.test(t)) {
      const who = partText(withParts[1] ?? withParts[0])
      const body = partText(withParts[withParts.length - 1])
      if (body) return { who: who || '?', text: body }
    }
    // ② 普通公屏
    if (t === 'chat.type.text') {
      const who = partText(withParts[0])
      const body = partText(withParts[1] ?? withParts[withParts.length - 1])
      if (body) return { who: who || '?', text: body }
    }
    // ③ 私聊（/tell、/msg）
    if (t === 'commands.message.display.incoming') {
      const who = partText(withParts[0])
      const body = partText(withParts[1] ?? withParts[withParts.length - 1])
      if (body) return { who: who || '?', text: body }
    }
    // ④ 兜底：渲染出来就是 `<名字> 正文` 的形状（有些服务端用自定义 chat type，translate 不认识）
    const m = /^\s*<([^<>]{1,32})>\s*(.+)$/s.exec(String(plain ?? ''))
    if (m) return { who: m[1].trim(), text: m[2] }
    return null
  }

  #pushChat (kind, who, text) {
    this.chat.push({ at: Date.now(), kind, who, text })
    if (this.chat.length > this.cfg.chatHistory) this.chat.splice(0, this.chat.length - this.cfg.chatHistory)
  }

  recentChat (n = 10) { return this.chat.slice(-n) }

  /* ───────────── 世界读取 ───────────── */

  async waitForChunks (timeoutMs = 20_000) {
    const b = this.bot
    if (!b?.entity) return false
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      const p = b.entity.position.floored()
      if (b.blockAt(p.offset(0, -1, 0)) || b.blockAt(p)) return true
      await sleep(300)
    }
    return false
  }

  /**
   * 给前端 / 工具看的**连接信息**：只有地址三件套。
   *
   * 🔴 用户 2026-09-16："状态条别只写'在游戏中'，要显示服务器地址。"
   *    `_connectionProfile` 里还带着 `authMode` / `account`（账号名）—— 那是给日志与诊断用的，
   *    **不该跟着这个视图发到浏览器**，所以统一从这里出（`status()` 与 `modeView()` 共用）。
   * @returns {{host: string|null, port: number|null, subserver: string|null}|null}
   */
  connectionView () {
    const p = this._connectionProfile
    if (!p) return null
    return { host: p.host ?? null, port: p.port ?? null, subserver: p.subserver || null }
  }

  status () {
    const b = this.bot
    // 连的哪个服（用户 2026-09-16："状态条别只写'在游戏中'，要显示服务器地址"）。
    // 只回地址/端口/子服，**不含账号与凭据**；前端负责"太长就截断"。
    const connection = this.connectionView()
    // 🔴 「幽灵在线」（2026-09-19）：断线/被踢后 `bot.entity` 会残留，光看它就把死连接报成在线。
    //    连接已结束就按离线报，并明确标出 ghost，免得 AI 与用户都以为还在游戏里。
    const ended = b?._client?.ended === true
    if (!b?.entity || ended) {
      const reconnecting = Boolean(this.reconnecting || this.reconnectPending)
      return {
        online: false, sub: this.sub, connection, lastError: this.lastError,
        ...(reconnecting ? { reconnecting: true } : {}),
        ...(ended && b?.entity
          ? {
              ghost: true,
              hint: reconnecting
                ? '连接已经断了（bot.entity 是 mineflayer 的残留），插件正在自动重连——重连成功会自动告诉你'
                : '连接已经结束了（bot.entity 是 mineflayer 的残留）——要回到游戏里请重新 mc_connect',
            }
          : {}),
      }
    }
    const p = b.entity.position
    return {
      online: true, sub: this.sub, connection,
      position: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) },
      yaw: b.entity.yaw, pitch: b.entity.pitch,
      gamemode: b.game?.gameMode, dimension: b.game?.dimension, time: b.time?.timeOfDay,
      health: b.health, food: b.food, players: Object.keys(b.players ?? {}),
      held: b.heldItem ? `${b.heldItem.name}x${b.heldItem.count}` : null,
      uptimeSec: Math.round((Date.now() - this.connectedAt) / 1000),
      inWater: Boolean(b.entity.isInWater),
    }
  }

  scan ({ radius = 8, height = 4, name = null, limit = 10 } = {}) {
    const b = this.requireBot()
    const R = Math.min(Math.max(radius, 1), 24)
    const H = Math.min(Math.max(height, 0), 16)
    const c = b.entity.position.floored()
    const counts = new Map()
    const found = []
    let unloaded = 0
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        for (let dy = -H; dy <= H; dy++) {
          const pos = new Vec3(c.x + dx, c.y + dy, c.z + dz)
          const blk = b.blockAt(pos)
          if (!blk) { unloaded++; continue }
          if (isAir(blk.name)) continue
          if (name) { if (blk.name === name) found.push(`${pos.x},${pos.y},${pos.z}`) }
          else counts.set(blk.name, (counts.get(blk.name) ?? 0) + 1)
        }
      }
    }
    if (name) return { found: found.slice(0, limit), total: found.length, unloaded }
    return {
      center: { x: c.x, y: c.y, z: c.z }, radius: R, height: H, unloaded,
      counts: [...counts.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, 25).map(([n, v]) => ({ name: n, count: v })),
    }
  }

  /** 俯视地形：返回 { names（二维字符数组）, legend, center, unloaded } */
  heightmap ({ radius = 32, yTop = 10, yBottom = -24 } = {}) {
    const b = this.requireBot()
    const R = Math.min(Math.max(radius, 4), 96)
    const cx = Math.floor(b.entity.position.x)
    const cz = Math.floor(b.entity.position.z)
    const cy = Math.floor(b.entity.position.y)
    const names = []
    const legend = new Map()
    let unloaded = 0
    for (let dz = -R; dz < R; dz++) {
      const row = []
      for (let dx = -R; dx < R; dx++) {
        let nm = null
        for (let y = cy + yTop; y >= cy + yBottom; y--) {
          const blk = b.blockAt(new Vec3(cx + dx, y, cz + dz))
          if (!blk) { nm = null; break }
          if (!isAir(blk.name)) { nm = blk.name; break }
        }
        if (nm === null) unloaded++
        legend.set(nm ?? 'unloaded', (legend.get(nm ?? 'unloaded') ?? 0) + 1)
        row.push(nm)
      }
      names.push(row)
    }
    return {
      center: { x: cx, y: cy, z: cz }, radius: R, unloaded, names, colors: names.map((row) => row.map(colorOf)),
      legend: [...legend.entries()].sort((a, b2) => b2[1] - a[1]).map(([name, count]) => ({ name, count })),
    }
  }

  /** 字符地形图（无视觉也能读） */
  static glyphMap (names, step = 2, selfIndex = null) {
    const out = []
    for (let y = 0; y < names.length; y += step) {
      let line = ''
      for (let x = 0; x < names[y].length; x += step) {
        line += (selfIndex && y === selfIndex.y && x === selfIndex.x) ? '@' : glyphOf(names[y][x])
      }
      out.push(line)
    }
    return out.join('\n')
  }

  /**
   * 俯视地形 → RGBA 像素图（需求 7：视觉模型看图像比看字符强）。
   *
   * 字符图仍是默认（当前模型无视觉）；本方法给"有视觉的模型 / 要发给用户看"用。
   * 每格放大 scale 倍（最近邻），并在自己所在格画一个白框方便定位。
   *
   * @returns {{width:number,height:number,rgba:Uint8Array,center:object,radius:number,unloaded:number,legend:Array}}
   */
  mapImage ({ radius = 32, scale = 4, yTop = 10, yBottom = -24, markSelf = true } = {}) {
    const hm = this.heightmap({ radius, yTop, yBottom })
    const h = hm.names.length
    const w = h > 0 ? hm.names[0].length : 0
    if (!w || !h) throw new Error('地形数据为空（区块可能还没加载）')

    const s = Math.min(Math.max(Number(scale) || 4, 1), 16)
    const W = w * s
    const H = h * s
    const rgba = new Uint8Array(W * H * 4)

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const [r, g, b] = colorOf(hm.names[y][x])
        for (let dy = 0; dy < s; dy++) {
          const rowBase = (y * s + dy) * W
          for (let dx = 0; dx < s; dx++) {
            const o = (rowBase + x * s + dx) * 4
            rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255
          }
        }
      }
    }

    // 自己：中心格画白色外框（内芯保留原色，便于看清脚下是什么）
    if (markSelf) {
      const cx = Math.floor(w / 2) * s
      const cy = Math.floor(h / 2) * s
      const put = (px, py, c) => {
        if (px < 0 || py < 0 || px >= W || py >= H) return
        const o = (py * W + px) * 4
        rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = 255
      }
      const white = [255, 255, 255]
      for (let d = 0; d < s; d++) {
        put(cx + d, cy, white)
        put(cx + d, cy + s - 1, white)
        put(cx, cy + d, white)
        put(cx + s - 1, cy + d, white)
      }
    }

    return {
      width: W, height: H, rgba,
      center: hm.center, radius: hm.radius, unloaded: hm.unloaded,
      legend: hm.legend.slice(0, 15),
      scale: s,
    }
  }

  /* ───────────── 行动 ───────────── */

  chatSay (text) {
    const b = this.requireBot()
    const t = String(text).replace(/[\r\n]+/g, ' ').slice(0, 220)
    b.chat(t)
    this.#pushChat('self', b.username, t)
    return t
  }

  async walkTo (target, { arrive = 1.6, budget = this.cfg.moveBudgetMs } = {}) {
    const b = this.requireBot()
    const t0 = Date.now()
    let last = b.entity.position.clone()
    let lastProgress = Date.now()
    let jumpUntil = 0
    const floorAt = (x, z) => {
      const base = Math.floor(b.entity.position.y)
      for (let dy = 3; dy >= -4; dy--) {
        const blk = b.blockAt(new Vec3(Math.floor(x), base + dy, Math.floor(z)))
        if (blk && blk.boundingBox === 'block') return base + dy + 1
      }
      return null
    }
    b.setControlState('forward', true)     // ⚠️ 一直按住
    try {
      while (Date.now() - t0 < budget) {
        if (this.abortSignal?.aborted) throw abortError('走路', this.abortSignal)
        const pos = b.entity.position
        const dx = target.x - pos.x, dy = target.y - pos.y, dz = target.z - pos.z
        const horiz = Math.hypot(dx, dz)
        if (horiz <= arrive && Math.abs(dy) <= 1.5) return { arrived: true, position: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }, ms: Date.now() - t0 }
        await this.#t(b.lookAt(new Vec3(target.x, target.y + 1.6, target.z), true), 'lookAt', '走路转向')
        const aheadFloor = floorAt(pos.x + (dx / (horiz || 1)) * 0.9, pos.z + (dz / (horiz || 1)) * 0.9)
        const needClimb = dy > 0.9 || (aheadFloor !== null && aheadFloor > pos.y + 0.6)
        const inLiquid = Boolean(b.entity.isInWater || b.entity.isInLava)
        if ((needClimb || inLiquid) && Date.now() > jumpUntil) { b.setControlState('jump', true); jumpUntil = Date.now() + (inLiquid ? 600 : 450) }
        if (Date.now() > jumpUntil) b.setControlState('jump', false)
        if (pos.distanceTo(last) > 0.25) { last = pos.clone(); lastProgress = Date.now() }
        else if (Date.now() - lastProgress > 1200) {
          b.setControlState('jump', true); await sleep(350); b.setControlState('jump', false)
          lastProgress = Date.now(); last = b.entity.position.clone()
        }
        await sleep(120)
      }
      const end = b.entity.position
      return {
        arrived: false,
        position: { x: Math.floor(end.x), y: Math.floor(end.y), z: Math.floor(end.z) },
        ms: Date.now() - t0,
        remaining: Number(end.distanceTo(new Vec3(target.x, target.y, target.z)).toFixed(2)),
      }
    } finally {
      for (const k of ['forward', 'jump', 'back', 'left', 'right']) b.setControlState(k, false)
    }
  }

  /**
   * 飞到某个坐标（仅创造模式）。
   *
   * 🔴 **刻意不使用 mineflayer 的 `bot.creative.flyTo`** —— 它有两处硬伤，
   *    2026-09-15 真机（mc）踩得很惨，三个症状全部源于它：
   *
   *   ① 结尾是 `await once(bot, 'move', 0)` —— **timeout 传 0 = 永不超时**。
   *      服务端不回 move 回执就永久挂住。真机日志里 `飞行 超时（30000ms）` /
   *      `接近放置点 超时（30000ms）` 反复出现，就是这个。
   *      **表现特别坑**：客户端位移其实已经改了 → **动作生效了，但工具迟迟不返回、
   *      最后报超时**（用户原话："移动有时候已经生效了，但等很久工具才返回，返回的是超时"）。
   *
   *   ② 它调 `startFlying()` 把 `physics.gravity` 置 0，却**从不 `stopFlying()`**。
   *      一次失败就把机器人永久留在**零重力** → 之后 `walkTo` 完全失效
   *      （真机症状：fly 超时之后 walk 30s 原地不动）。
   *
   * 所以这里自己实现：小步推进 + **进度检测**（推不动就早停，不耗满预算）+ 预算上限，
   * 并且**无论如何在 finally 里恢复重力**。到位就返回，**不等服务端回执**。
   */
  async flyTo (x, y, z, { budget = 20_000 } = {}) {
    const b = this.requireBot()
    if (b.game?.gameMode !== 'creative') throw new Error('飞行只在创造模式可用（当前 ' + b.game?.gameMode + '）')
    const target = new Vec3(Number(x), Number(y), Number(z))
    const t0 = Date.now()
    let last = b.entity.position.clone()
    let lastProgress = Date.now()
    this._selfMovingAt = Date.now()          // 别把自己飞当成"被传送"
    try {
      b.creative.startFlying()
      while (Date.now() - t0 < budget) {
        if (this.abortSignal?.aborted) throw abortError('飞行', this.abortSignal)
        const pos = b.entity.position
        const v = target.minus(pos)
        const mag = Math.hypot(v.x, v.y, v.z)
        if (mag <= 1.5) break
        const step = Math.min(mag, 2)
        b.physics.gravity = 0
        b.entity.velocity = new Vec3(0, 0, 0)
        b.entity.position = pos.offset((v.x / mag) * step, (v.y / mag) * step, (v.z / mag) * step)
        await sleep(60)
        if (b.entity.position.distanceTo(last) > 0.3) {
          last = b.entity.position.clone()
          lastProgress = Date.now()
        } else if (Date.now() - lastProgress > 2500) {
          break                               // 推不动了（服务端可能不接受客户端位移），别耗满预算
        }
      }
    } finally {
      // 🔴 必须恢复重力：否则之后走路全废（见上面 ②）
      try { b.creative.stopFlying() } catch {}
      this._selfMovingAt = Date.now()
    }
    const p = b.entity.position
    const distance = Number(p.distanceTo(target).toFixed(2))
    const arrived = distance <= 2.5
    return {
      position: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) },
      distance, arrived, ms: Date.now() - t0,
      ...(arrived ? {} : {
        note: `没到目标（还差 ${distance} 格）。创造模式直飞是**客户端位移**，`
          + '服务端未必接受（反作弊/延迟）——可改用 mc_move{mode:"walk"}，或挑更近的点位。',
      }),
    }
  }

  async dig ({ name = null, pos = null, maxDistance = 6, count = 1 } = {}) {
    const b = this.requireBot()
    const out = []
    const n = Math.min(Math.max(count, 1), 16)
    for (let i = 0; i < n; i++) {
      let target
      if (pos && i === 0) {
        target = b.blockAt(new Vec3(pos.x, pos.y, pos.z))
        if (!target) throw new Error(`(${pos.x},${pos.y},${pos.z}) 未加载`)
      } else {
        const want = name ?? (pos ? b.blockAt(new Vec3(pos.x, pos.y, pos.z))?.name : null)
        if (!want) throw new Error('需要 name 或 pos')
        target = b.findBlock({ matching: (blk) => blk?.name === want, maxDistance })
        if (!target) { out.push(`附近找不到 ${want}`); break }
      }
      try {
        if (b.game?.gameMode !== 'creative') {
          const best = b.inventory.items().find((it) => {
            const t = b.registry.itemsByName[it.name]
            return Boolean(t && target.harvestTools && target.harvestTools[t.id])
          })
          if (best && b.heldItem?.name !== best.name) { try { await this.#t(b.equip(best, 'hand'), 'equip', '换工具') } catch {} }
        }
        const p = target.position.clone()
        const nm = target.name
        await this.#t(b.dig(target, true), 'dig', `挖 ${target.name}`)
        await sleep(200)
        out.push(`挖掉 ${nm} @ ${p} → 现在 ${b.blockAt(p)?.name ?? '?'}`)
      } catch (e) { out.push(`挖 ${target.name} 失败：${e.message}`); break }
    }
    return out
  }

  inventory () {
    const b = this.requireBot()
    return {
      held: b.heldItem ? `${b.heldItem.name}x${b.heldItem.count}` : null,
      // 装备槽不在 `inventory.items()` 里（它只给 9–44），单独列出来 —— 否则"我到底穿没穿"看不见
      wearing: this.#wornArmor(b),
      items: b.inventory.items().map((i) => `${i.name}x${i.count}`),
    }
  }

  /* ───────────── 朝向（"看向我"就该用工具，不要用 /tp 指令） ───────────── */

  /** 目标点 → mineflayer 的 yaw/pitch（mineflayer yaw = 反方向 + PI） */
  static lookAnglesTo (from, to) {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const dz = to.z - from.z
    const ground = Math.hypot(dx, dz)
    const yaw = Math.atan2(-dx, -dz)          // atan2(西, 北)
    const pitch = Math.atan2(dy, ground)      // 抬头看上面的东西为正
    return { yaw, pitch }
  }

  /** 看向坐标或某个玩家/实体（who 传名字） */
  async lookAt ({ x, y, z, who = null } = {}) {
    const b = this.requireBot()
    let target = null
    if (who) {
      const needle = String(who).toLowerCase()
      const found = Object.values(b.entities).find((e) => String(e.username ?? e.name ?? '').toLowerCase().includes(needle))
        ?? Object.keys(b.players ?? {}).find((n) => n.toLowerCase().includes(needle))
      if (!found) throw new Error(`附近找不到 "${who}"（可用 mc_entities 看在场的人）`)
      if (typeof found === 'string') {
        const pl = b.players[found]
        target = pl?.entity?.position
        if (!target) throw new Error(`${found} 在玩家列表里，但看不到它的实体位置`)
      } else target = found.position
    } else if (x !== undefined && y !== undefined && z !== undefined) {
      target = new Vec3(Number(x), Number(y), Number(z))
    } else throw new Error('要么给 who（玩家名），要么给 x/y/z')
    await this.#t(b.lookAt(target, true), 'lookAt', '转头')
    return {
      lookingAt: { x: target.x, y: target.y, z: target.z },
      myEye: { x: b.entity.position.x, y: b.entity.position.y + 1.62, z: b.entity.position.z },
      yaw: Number(b.entity.yaw.toFixed(3)), pitch: Number(b.entity.pitch.toFixed(3)),
    }
  }

  /* ───────────── 放置 / 破坏（"搭高"就该用工具，不要用 /setblock） ───────────── */

  /** 找一个能对着放的相邻实体方块 */
  #placeRef (pos) {
    const b = this.requireBot()
    for (const [dx, dy, dz] of [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
      const nb = b.blockAt(new Vec3(pos.x + dx, pos.y + dy, pos.z + dz))
      if (nb && nb.boundingBox === 'block') return { ref: nb, face: { x: -dx, y: -dy, z: -dz } }
    }
    return null
  }

  /** 把背包里的方块放到某个坐标（先走近、必要时往上搭） */
  async placeBlock ({ x, y, z, name = null } = {}) {
    const b = this.requireBot()
    const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))
    const want = name ? String(name) : null
    // 选方块：指定名字，否则用背包里第一种可放置方块
    const pick = () => {
      const items = b.inventory.items()
      if (!items.length) return null
      return want ? (items.find((i) => i.name === want) ?? null) : items[0]
    }
    let item = pick()

    // 创造模式：背包里没有就**自动取**（协议级 set_creative_slot，不需要 OP）。
    // 不这么做的话"给个方块名就能建"不成立——AI 得先想起来调 mc_give，
    // 否则 mc_build 直接报"背包是空的"。生存模式没这福利（得自己挖/合成）。
    if (!item && want && b.game?.gameMode === 'creative') {
      await this.giveItem({ name: want })
      item = pick()
    }
    if (!item) {
      throw new Error(want
        ? `背包里没有 ${want}（生存模式请先挖或合成；创造模式本应自动取物，若仍失败请看上一条错误）`
        : '背包是空的——**给 name 指定要放哪种方块**（创造模式下会自动取物），或先挖方块')
    }

    // 走/飞到够得着的位置（reach 约 4.5 格）
    const dist = () => b.entity.position.distanceTo(pos)
    let approachError = null
    if (dist() > 4) {
      this._selfMovingAt = Date.now()
      try {
        if (b.game?.gameMode === 'creative') await this.flyTo(pos.x + 2, pos.y + 1.5, pos.z + 2)
        else await this.walkTo({ x: pos.x + 2, y: pos.y, z: pos.z + 2 }, { arrive: 2.5, budget: 25_000 })
      } catch (e) { approachError = e.message }
      this._selfMovingAt = Date.now()
      await sleep(250)
    }
    // 🔴 够不着就别硬放。旧版把接近失败 `catch {}` 吞掉、照样往下走，
    //    结果服务端拒了放置，而工具还报"placed: X"——真机被投诉的"报假成功"。
    if (dist() > 5.5) {
      throw new Error(`够不着 (${pos.x},${pos.y},${pos.z})：还差 ${dist().toFixed(1)} 格`
        + (approachError ? `（接近失败：${approachError}）` : '')
        + '。先用 mc_move 靠近，或换更近的点位。')
    }

    // 目标位置必须"能放"：不占空间才放得进去。
    // 判据是 canPlaceInto（boundingBox==='empty'）——覆盖空气三兄弟、**液体**、草/花/藤蔓等可替换物。
    const targetBlock = b.blockAt(pos)
    if (!targetBlock) {
      throw new Error(`(${pos.x},${pos.y},${pos.z}) 未加载（区块还没到）——先 mc_map 看看，或换近一点的点位`)
    }
    if (!canPlaceInto(targetBlock)) {
      throw new Error(`(${pos.x},${pos.y},${pos.z}) 已被 ${targetBlock.name} 占住，放不进去——`
        + '换个位置，或先 mc_act{mode:"break"} 清掉')
    }
    let ref = this.#placeRef(pos)
    if (!ref) {
      // 悬空：先在自己脚下垫一块，站上去，再放目标（等于"搭高"）
      const below = b.entity.position.floored().offset(0, -1, 0)
      const underFeet = b.blockAt(below)
      if (underFeet && !isAir(underFeet.name)) {
        await this.#t(b.equip(item, 'hand'), 'equip', '手持垫脚方块')
        await this.#t(b.lookAt(below.offset(0.5, 0.5, 0.5), true), 'lookAt', '看向脚下')
        await this.#t(b.placeBlock(underFeet, { x: 0, y: 1, z: 0 }), 'place', '垫脚')
        await sleep(250)
      }
      ref = this.#placeRef(pos)
      if (!ref) throw new Error('目标位置悬空且脚下没有可依附方块（先走到有方块的地方，或先放一个垫脚方块）')
    }
    await this.#t(b.equip(item, 'hand'), 'equip', '手持方块')
    await this.#t(b.lookAt(ref.ref.position.offset(0.5, 0.5, 0.5), true), 'lookAt', '看向放置面')
    await this.#t(b.placeBlock(ref.ref, new Vec3(ref.face.x, ref.face.y, ref.face.z)), 'place', '放置方块')
    await sleep(200)

    // 🔴 必须**验证**：旧版不管成没成都是 `placed: item.name` → 真机被投诉的"报假成功"
    //    （mc_build 说 placed，mc_scan 复查一格没放下）
    const now = b.blockAt(pos)?.name ?? null
    const ok = now === item.name
    return {
      placed: ok ? item.name : false,
      requested: item.name,
      at: { x: pos.x, y: pos.y, z: pos.z },
      now,
      held: b.heldItem?.name ?? null,
      ...(ok ? {} : {
        note: `方块**没有出现**（现在那里是 ${now ?? '未加载'}）——服务端可能拒了这次放置`
          + '（领地保护 / 权限 / 反作弊 / 失步）。不要当成放成功了。',
      }),
    }
  }

  /** 破坏某个坐标的方块（比 mc_dig 更直接：按坐标） */
  async breakBlock ({ x, y, z } = {}) {
    const b = this.requireBot()
    const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))
    const blk = b.blockAt(pos)
    if (!blk) throw new Error(`${pos.x},${pos.y},${pos.z} 未加载`)
    if (isAir(blk.name)) return { broken: null, at: { x: pos.x, y: pos.y, z: pos.z }, note: '那里本来就是空气' }
    const name = blk.name
    await this.#t(b.dig(blk, true), 'digBlock', `破坏 ${name}`)
    await sleep(150)
    // 同样要验证：挖失败（服务端拒绝/失步）不能报"broken: name"
    const now = b.blockAt(pos)?.name ?? null
    const ok = now !== name
    return {
      broken: ok ? name : false,
      at: { x: pos.x, y: pos.y, z: pos.z },
      now,
      ...(ok ? {} : { note: `方块还在（${now}）——服务端可能拒了这次破坏，别当成挖掉了` }),
    }
  }

  /** 统一交互入口：mode = look / place / break / toward */
  async interact (args = {}) {
    const mode = String(args.mode ?? 'look')
    if (mode === 'look') return { mode, ...(await this.lookAt(args)) }
    if (mode === 'place') return { mode, ...(await this.placeBlock(args)) }
    if (mode === 'break') return { mode, ...(await this.breakBlock(args)) }
    if (mode === 'toward') {
      const b = this.requireBot()
      if (!args.who) throw new Error('toward 需要 who（玩家名）')
      const r = await this.lookAt({ who: args.who })
      if (args.approach !== false) {
        const target = b.entity.position.clone()
        const eye = { x: r.lookingAt.x, y: target.y, z: r.lookingAt.z }
        await this.walkTo(eye, { arrive: 3, budget: Math.min(Number(args.budgetMs ?? 20_000), 60_000) })
        await this.lookAt({ who: args.who })
      }
      return { mode, ...(await this.lookAt({ who: args.who })), position: this.position }
    }
    throw new Error(`未知 mode：${mode}（可用 look / place / break / toward）`)
  }

  /**
   * 装备某物。
   *
   * `destination` 不给就**按物品自己判槽**（盔甲→头/胸/腿/脚、鞘翅→胸、盾→副手、其余→手），
   * 这正是原来缺的能力：以前写死 'hand'，盔甲一件都穿不上。
   * 给了就用给的（hand / off-hand / head / torso / legs / feet，中英文别名都认）。
   * auto:false 时不猜，一律装到手上（老行为）。
   */
  async equip ({ name, destination = null, auto = true } = {}) {
    const b = this.requireBot()
    const want = String(name ?? '').trim()
    if (!want) throw new Error('要装备什么？给物品名（用 mc_inventory 看有什么）')
    // 先校验 dest 再找物品：否则"背包里没有 X"会把"dest 写错了"这个真因盖掉
    const explicit = normalizeEquipDest(destination)
    if (destination != null && explicit == null) {
      throw new Error(`不认识的装备位置 "${destination}"（可用 hand / off-hand / head / torso / legs / feet）`)
    }
    const item = b.inventory.items().find((i) => i.name === want)
    if (!item) throw new Error(`背包里没有 ${want}（用 mc_inventory 看有什么）`)
    const dest = explicit ?? (auto ? guessEquipDest(b.registry, item.name) : 'hand')
    await this.#t(b.equip(item, dest), 'equip', `装备 ${item.name} → ${dest}`)
    const label = `${item.name}x${item.count}`
    return {
      equipped: label,
      destination: dest,
      autoPicked: explicit == null,
      held: dest === 'hand' ? label : undefined,
      wearing: this.#wornArmor(b),
    }
  }

  /** 当前身上穿着的盔甲 / 副手（`bot.inventory.items()` 不含 5–8 / 45 这些装备槽，得单独看） */
  #wornArmor (b) {
    const out = {}
    for (const [k, s] of Object.entries(EQUIP_SLOT_INDEX)) {
      const it = b.inventory?.slots?.[s]
      if (it) out[k] = `${it.name}x${it.count}`
    }
    return out
  }

  /**
   * 一键穿全套装备：头/胸/腿/脚各挑背包里**最好**的一件穿上。
   *
   * 为什么要这个：玩家说"穿上装备"不会一件件点名，而 `equip` 一次只穿一件 ——
   * 四件套要四次调用，模型很容易漏。这里一次搞定，并回报"穿了哪些、缺哪些"。
   * 鞘翅默认**不自动穿**（它占胸槽会顶掉胸甲），要穿就 elytra:true。
   */
  async equipArmor ({ include = ARMOR_SLOTS, elytra = false } = {}) {
    const b = this.requireBot()
    const pool = b.inventory.items()
    const wanted = (Array.isArray(include) && include.length ? include : ARMOR_SLOTS)
      .map((s) => normalizeEquipDest(s) ?? String(s))
      .filter((s) => ARMOR_SLOTS.includes(s))
    const worn = []
    const missing = []
    const failed = []
    for (const slot of wanted) {
      let cands = pool.filter((i) => guessEquipDest(b.registry, i.name) === slot)
      if (slot === 'torso' && !elytra) cands = cands.filter((i) => i.name !== 'elytra')
      if (!cands.length) { missing.push(slot); continue }
      cands.sort((a, c) => armorRank(a.name) - armorRank(c.name))
      const best = cands[0]
      try {
        await this.#t(b.equip(best, slot), 'equip', `穿 ${best.name} → ${slot}`)
        worn.push(`${slot}=${best.name}`)
      } catch (e) { failed.push(`${slot}: ${e.message}`) }
    }
    return {
      worn, missing, failed,
      nowWearing: this.#wornArmor(b),
      note: missing.length ? `背包里没有可穿的：${missing.join(' / ')}（创造模式可用 mc_give 取）` : undefined,
    }
  }

  /**
   * 使用手上的物品（= 举起来用一下）：吃、喝、水桶、打火石、弓箭、末影珍珠、盾…
   *
   * 和 `useBlock` 的分工：`useBlock` 是"对着**世界**右键"（开门/按钮/喂动物），
   * 这个是对着**空气**用**手上的东西** —— 以前完全没有这条路，所以机器人吃不了东西、
   * 倒不了水、射不了箭（用户点名的第二个缺口）。
   * 给了 name 就先拿到手上（offHand:true 拿副手）。
   * holdMs 不给就按物品类型估（食物 1.6s、药水 1.8s、弓 1.2s、其余 0.12s）；
   * 食物默认走 mineflayer 的 `bot.consume()`（它等服务器确认，比"自己数秒"稳）。
   */
  async useItem ({ name = null, offHand = false, holdMs = null, release = true, consume = null } = {}) {
    const b = this.requireBot()
    const hand = offHand ? 'off-hand' : 'hand'
    if (name) await this.equip({ name, destination: hand })
    const item = b.inventory?.slots?.[b.getEquipmentDestSlot(hand)] ?? (offHand ? null : b.heldItem)
    if (!item) throw new Error(`${offHand ? '副手' : '主手'}上没有物品（给 name 先装备，或用 mc_inventory 看有什么）`)

    const isFood = !offHand && FOOD_RE.test(item.name) && !/^(potion|splash_potion|lingering_potion)$/.test(item.name)
    const useConsume = consume === true || (consume !== false && isFood && holdMs == null)
    if (useConsume) {
      if (typeof b.consume !== 'function') throw new Error('这一版 mineflayer 没有 bot.consume，请改用 holdMs 手动控制')
      try {
        await this.#t(b.consume(), 'act', `吃/喝 ${item.name}`)
      } catch (e) {
        if (/Food is full/i.test(String(e?.message))) {
          throw new Error(`吃饱了（food=${b.food}），现在吃 ${item.name} 没效果`)
        }
        throw e
      }
      return { used: item.name, hand, mode: 'consume', food: b.food, wearing: undefined }
    }

    const ms = holdMs == null ? guessUseHoldMs(item.name) : Math.min(Math.max(Number(holdMs) || 0, 0), 10_000)
    b.activateItem(offHand)
    try {
      if (ms > 0) await sleep(ms)
    } finally {
      if (release) b.deactivateItem()
    }
    return { used: item.name, hand, mode: 'activate', heldMs: ms, released: Boolean(release) }
  }

  /**
   * 批量放置：从 (x1,y1,z1) 到 (x2,y2,z2) 的实心长方体。
   * 逐个调用 placeBlock（会自己走近/垫脚），count 上限保护。
   */
  async build ({ x1, y1, z1, x2, y2, z2, name = null, max = 64 } = {}) {
    const pts = []
    const [ax, bx] = [Math.min(x1, x2), Math.max(x1, x2)]
    const [ay, by] = [Math.min(y1, y2), Math.max(y1, y2)]
    const [az, bz] = [Math.min(z1, z2), Math.max(z1, z2)]
    for (let y = ay; y <= by; y++) for (let z = az; z <= bz; z++) for (let x = ax; x <= bx; x++) pts.push({ x, y, z })
    if (pts.length > max) throw new Error(`要放 ${pts.length} 个方块，超过上限 ${max}（缩小范围或调大 max）`)
    const ok = []
    const fail = []
    for (const p of pts) {
      try { await this.placeBlock({ ...p, name }); ok.push(`${p.x},${p.y},${p.z}`) }
      catch (e) { fail.push(`${p.x},${p.y},${p.z}: ${e.message}`); if (fail.length >= 5) break }
    }
    return { requested: pts.length, placed: ok.length, failed: fail.length, failures: fail.slice(0, 5) }
  }

  /** 原地跳一下（爬台阶用） */
  async jump () {
    const b = this.requireBot()
    b.setControlState('jump', true)
    await sleep(320)
    b.setControlState('jump', false)
    await sleep(200)
    return { position: this.position }
  }

  /* ───────────── 创造取物 / 使用 / 攻击 / 丢弃（补能力，2026-09-15）───────────── */

  /**
   * 选一个槽位放取来的物品。优先级：
   *   ① 已经放着**同一种**东西的槽（重复取同款不占新格，也不会覆盖别的）
   *   ② 快捷栏（36–44）的空槽
   *   ③ 手上那格（实在满了才覆盖）
   * 为什么要在意：连建一面墙会反复调 placeBlock → giveItem，
   * 若每次都挑"第一个空槽"，很快就把之前取的方块覆盖掉，导致后面莫名"背包里没有 X"。
   */
  #freeSlot (b, itemName = null) {
    const slots = b.inventory?.slots ?? []
    if (itemName) {
      for (let s = 36; s <= 44; s++) {
        if (slots[s]?.name === itemName) return s
      }
    }
    for (let s = 36; s <= 44; s++) {
      if (!slots[s]) return s
    }
    return b.quickBarSlot != null ? 36 + b.quickBarSlot : 36
  }

  /**
   * 创造模式直接获取物品。
   *
   * 为什么不用 /give：多数服对非 OP 关掉 /give，而**创造模式改槽位是协议级能力**
   * （`set_creative_slot` 包），服务端一般照收。所以走 `bot.creative.setInventorySlot`。
   * 这也是用户点名的缺口："连创造模式直接获取物品的方法都没有"。
   */
  async giveItem ({ name, count = 1, slot = null } = {}) {
    const b = this.requireBot()
    if (b.game?.gameMode !== 'creative') {
      throw new Error(`取物只在创造模式可用（当前 ${b.game?.gameMode ?? '未知'}）；生存模式请挖或合成`)
    }
    const itemName = String(name ?? '').trim()
    if (!itemName) throw new Error('要给物品名（如 oak_planks / diamond_sword）')
    const type = b.registry?.itemsByName?.[itemName]
    if (!type) throw new Error(`未知物品：${itemName}（用英文 id，如 oak_planks）`)
    const n = Math.min(Math.max(Number(count) || 1, 1), type.stackSize ?? 64)
    const target = slot != null ? Math.min(Math.max(Number(slot), 0), 44) : this.#freeSlot(b, itemName)

    const Item = itemLoader()(b.registry)
    const item = new Item(type.id, n)
    await this.#t(b.creative.setInventorySlot(target, item, 800), 'give', `取物 ${itemName}`)
    await sleep(120)
    return {
      gave: `${itemName}x${n}`, slot: target,
      now: b.inventory.slots?.[target] ? `${b.inventory.slots[target].name}x${b.inventory.slots[target].count}` : null,
      note: target >= 36 ? `已放进快捷栏第 ${target - 35} 格` : '已放进背包',
    }
  }

  /** 清空背包（创造模式） */
  async clearInventory () {
    const b = this.requireBot()
    if (b.game?.gameMode !== 'creative') throw new Error('清空背包只在创造模式可用')
    await this.#t(b.creative.clearInventory(), 'give', '清空背包')
    return { cleared: true }
  }

  /**
   * 使用/激活方块或实体（开门、按按钮、拉杆、喂动物…）。
   *
   * 给了 name 就**先把它拿到手上**再右键 —— 这是"用物品对着方块用"的路子：
   * 骨粉催熟、锄头耕地、打火石点火、水桶倒水、刷怪蛋、喂特定食物都用得上。
   * （只用手上的东西、不对着方块，走 `useItem`。）
   */
  async useBlock ({ x, y, z, who = null, name = null, offHand = false } = {}) {
    const b = this.requireBot()
    if (name) await this.equip({ name, destination: offHand ? 'off-hand' : 'hand' })
    if (who) {
      const needle = String(who).toLowerCase()
      const ent = Object.values(b.entities).find(
        (e) => e !== b.entity && String(e.username ?? e.name ?? '').toLowerCase().includes(needle),
      )
      if (!ent) throw new Error(`附近找不到实体 "${who}"`)
      await this.#t(b.activateEntity(ent), 'act', `与 ${who} 交互`)
      return { usedEntity: ent.username ?? ent.name ?? ent.type }
    }
    const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))
    const blk = b.blockAt(pos)
    if (!blk) throw new Error(`${pos.x},${pos.y},${pos.z} 未加载`)
    await this.#t(b.activateBlock(blk), 'act', `使用 ${blk.name}`)
    return { usedBlock: blk.name, at: { x: pos.x, y: pos.y, z: pos.z } }
  }

  /** 攻击最近的实体（4.5 格内）；给 who 就按名字找 */
  async attack ({ who = null } = {}) {
    const b = this.requireBot()
    const me = b.entity.position
    const needle = who ? String(who).toLowerCase() : null
    const list = Object.values(b.entities)
      .filter((e) => e !== b.entity)
      .filter((e) => e.position.distanceTo(me) <= 4.5)
      .filter((e) => !needle || String(e.username ?? e.name ?? '').toLowerCase().includes(needle))
      .sort((a, c) => a.position.distanceTo(me) - c.position.distanceTo(me))
    const target = list[0]
    if (!target) {
      throw new Error(needle ? `4.5 格内找不到 "${who}"` : '4.5 格内没有可攻击的实体（先用 mc_entities 看附近有什么）')
    }
    const label = target.username ?? target.name ?? target.type
    const d = Number(target.position.distanceTo(me).toFixed(1))
    await this.#t(Promise.resolve(b.attack(target)), 'attack', `攻击 ${label}`)
    return { attacked: label, distance: d, health: b.health }
  }

  /**
   * 自动攻击 v2（战斗基准 = Wurst v7.54：FightBot / KillauraLegit / NukerLegit / AutoEat）：
   * 锁定**一个**实体追着打，跑完整场战斗。相比 v1 专门修了三个实战缺陷：
   *   ①只差一格不跳：GoalFollow 按方块坐标提前判"到点"后寻路就不再规划（不生成跳/挖的边）——
   *     现在**寻路闲着时自己朝目标按住前进**，位置 700ms 不挪窝（且着地、没在挖）就脉冲按住
   *     jump 跳过去（FightBot"撞水平障碍即跳"的手动版；mineflayer 不上报 hasHorizontalCollision，
   *     只能用位置停滞判定）；
   *   ②目标在墙后只贴墙不挖：**先看视线**（眼→胸口 raycast），被挡且挡路方块 ≤4.5 格就换最快
   *     工具（bestHarvestTool）直接挖穿再打——挖 >15s 的硬方块不挖（记进 notes）；挖太远先贴近；
   *   ③低血不退：血量 ≤ hpFloor → **反向 GoalInvert(GoalFollow) 跑开**（≥9 格或 8s）→ 站定**吃食物**
   *     （food<18 才吃，优先级 金苹果>熟食>面包…饱了才有的自然回血）→ 等 6s 回血 → **重新锁定追上去**。
   *     最多撤 3 轮；回不上血/背包没食物 → retreated 收场（血量掉到危险线且已撤过也直接收场）。
   * 攻击节奏 = 原版剑蓄力 625ms + 高斯 ±100ms 抖动（Killaura speedRandMS）；每次出手**跳劈**
   * （Criticals FULL_JUMP 的原版合法实现：起跳→下落段出手 = 暴击 ×1.5；数据包模式不做——那是
   * 伪造移动包）；**6-22 格先拉弓抛物线射一箭**（BowAimbot+Trajectories：v0=3.0/重力 0.05/
   * 阻力 0.99 数值解算 + 移动目标提前量，蓄力 0.85s），近了换剑；**血量 ≤10 点自动图腾换副手**
   * （AutoTotem）；推进按住 sprint（冲刺命中额外击退）。打前先面向胸口。
   * 收场条件：
   *   target_gone 目标死/离开加载范围（宽限 reacquire 秒，可能只是过区块边界）
   *   too_far     非玩家目标拉开 >CHASE_FAR(60) 格持续 4s：达不到 → 取消锁定（玩家目标不设限）
   *   retreated    血量反复跌破 hpFloor：撤退吃食物回不上血（或没食物），或血量已到危险线
   *   timeout      durationSec 用尽
   *   aborted      用户中断；disconnected 断线
   * 返回战报含 hits / retreats / ate / food；durationSec 硬上限 120s。
   */
  async hunt ({ who, durationSec = 45, range = 2, hpFloor = 10, reacquire = 4 } = {}) {
    if (!who) throw new Error('who 必填：要追打的目标名字（子串匹配；先用 mc_entities 看附近有谁）')
    const b = this.requireBot()
    if (!pathfinderPlugin || !PathGoals || typeof b.pathfinder?.setGoal !== 'function') {
      throw new Error('未安装/未挂载 mineflayer-pathfinder（npm i mineflayer-pathfinder@^2.4.5 后重启 dsh-web）')
    }
    const needle = String(who).toLowerCase()
    const findTarget = () => Object.values(b.entities)
      .filter((e) => e !== b.entity && String(e.username ?? e.name ?? '').toLowerCase().includes(needle))
      .sort((a, c) => a.position.distanceTo(b.entity.position) - c.position.distanceTo(b.entity.position))[0] ?? null
    let target = findTarget()
    if (!target) throw new Error(`全图找不到名字含 "${who}" 的实体（先用 mc_entities 看看；它可能不在已加载范围）`)
    // 目标策略（用户 2026-09-24）：就近锁定（findTarget 已按距离取最近）；非玩家太远=打不到
    // → 不硬追、拉开即取消锁定；玩家目标不设距离上限，锁到死（durationSec 内）
    const isPlayer = (t) => !!t && (t.type === 'player' || typeof t.username === 'string')
    const CHASE_FAR = 60
    const firstDist = target.position.distanceTo(b.entity.position)
    if (!isPlayer(target) && firstDist > CHASE_FAR) {
      throw new Error(`最近的 "${who}" 在 ${firstDist.toFixed(0)} 格外（>${CHASE_FAR}），太远不追——先用 mc_entities 看近处；玩家目标不受此限`)
    }

    const label = target.username ?? target.name ?? target.type
    const durMs = Math.min(Math.max(Number(durationSec) || 45, 1), 120) * 1000
    const followRange = Math.min(Math.max(Number(range) || 2, 1), 8)
    const hpLimit = Number.isFinite(Number(hpFloor)) ? Number(hpFloor) : 10
    const lostGraceMs = Math.min(Math.max(Number(reacquire) || 4, 0), 30) * 1000

    // 战斗常量：reach 保守取 4.0（服务器容差未知），冷却=原版剑蓄力整轮
    const ATTACK_REACH = 4.0
    const ATTACK_COOLDOWN_MS = 625         // 原版剑蓄力 = 1/1.6s（Killaura 默认走原版冷却）
    const ATTACK_JITTER_MS = 100           // Killaura speedRandMS：高斯 ±100ms 抖攻速（防节奏固定）
    const DIG_REACH = 4.5               // 手动挖墙最远距离
    const MAX_DIG_MS = 15_000           // 最快工具也要 >15s 的硬方块不挖
    const FLEE_DIST = 9                 // 撤退跑到离目标几格才算脱战
    const FLEE_TIMEOUT_MS = 8_000
    const HEAL_WAIT_MS = 6_000          // 吃完等自然回血的窗口
    const MAX_RETREATS = 3              // 撤退-吃-回来 最多几轮
    const CRIT = Math.max(2, Math.floor(hpLimit * 0.4))  // 危险线（hpFloor=10 → 4）
    const STUCK_MS = 450                // 位置停滞多久算卡住 → 起跳（FightBot 撞墙当拍就跳；700ms 太钝）
    const JUMP_HOLD_MS = 280
    const TOTEM_HP = 10                 // AutoTotem（Wurst 默认≈常备）：血量 ≤10 点(5 心) → 图腾换副手
    const BOW_MIN = 6                   // 弓接战（BowAimbot）：6-22 格先射一箭，近了换剑冲锋
    const BOW_MAX = 22
    const BOW_CHARGE_MS = 850           // 拉弓蓄力 ~1s 满伤害，0.85s ≈ 90%+ 输出
    const BOW_INTERVAL_MS = 2_500       // 两箭最小间隔

    try {
      const weapon = this.#bestWeapon(b)
      if (weapon && b.heldItem?.name !== weapon.name) {
        await this.#t(b.equip(weapon, 'hand'), 'equip', `手持 ${weapon.name}`)
      }
    } catch { /* 换手失败照打 */ }

    const mv = new PathfinderMovements(b)
    mv.canDig = true                     // 挡路方块自动挖（astar toBreak → pathfinder 自带挖+换最快工具）
    b.pathfinder.setMovements(mv)
    const scaffolding = mv.countScaffoldingItems?.() ?? 0

    let goal = new PathGoals.GoalFollow(target, followRange)
    b.pathfinder.setGoal(goal, true)     // dynamic：目标动 → hasChanged → 重规划（v1 验证过的追击底座）
    const relock = () => {
      // 换/找回目标必须重建 goal：旧实体引用的 GoalFollow 坐标不再刷新
      goal = new PathGoals.GoalFollow(target, followRange)
      b.pathfinder.setGoal(goal, true)
    }

    const t0 = Date.now()
    const deadline = t0 + durMs
    let phase = 'fight'                  // fight → flee → heal → fight（低血三段式）
    let phaseAt = t0
    let keepAwaySet = false              // heal 阶段的保距 goal 只挂一次
    let hits = 0
    let retreats = 0
    let ate = 0
    let lastAttackAt = 0
    let lastJumpAt = 0
    let lostAt = null
    let farAt = null                    // 非玩家目标持续超出 CHASE_FAR 的起始时刻（打不到 → 取消锁定）
    let outcome = 'timeout'
    let notes = null
    let hardWall = false                 // 撞上挖不动的墙（记 notes）
    const digFails = new Map()           // 坐标 → {n, at}：挂死(n≥99)永久放弃；普通失败 5s 内连跌 2 次才放弃
    const failOf = (key) => {
      const r = digFails.get(key)
      return r && (r.n >= 99 || Date.now() - r.at < 5000) ? r.n : 0
    }
    let miningStreak = 0                 // 连续"在挖"已持续多久（ms 计数，每拍 +250；挖死看门狗）
    let stallAt = Date.now()             // 位置停滞监视锚点
    let stallPos = b.entity.position.clone()
    let prevT = null                    // 上一拍目标位置（弓箭提前量的速度估计）
    let prevTAt = 0
    let lastBowAt = 0                   // 上一箭时刻（BOW_INTERVAL_MS 节流）
    let bowDead = false                 // 没弓/没箭/连续失败 → 本轮不再尝试弓
    let bowFails = 0
    let totemMissing = false            // 背包确认没有图腾 → 本轮不再找
    let totemFails = 0

    const refreshStall = () => { stallPos = b.entity.position.clone(); stallAt = Date.now() }
    const chestOf = (t) => t.position.offset(0, (t.height ?? 1.8) * 0.5, 0)

    // 挖掘挂死看门狗：pathfinder 自己的 toBreak 或我手动挖，撞上服务器不让挖的方块会无限期卡
    // （真机：领地方块 b.dig 挂死）→ 连续"在挖" > 8s 就强制 stopDigging + 重挂 goal（触发
    // resetPath 换策略：绕路/放弃），绝不无限期卡住
    const MINING_HANG_MS = 8000
    const unstickDig = async () => {
      if (!b.pathfinder.isMining?.()) { miningStreak = 0; return false }
      miningStreak += 250
      if (miningStreak < MINING_HANG_MS) return false
      miningStreak = 0
      try { b.stopDigging?.() } catch {}
      refreshStall()
      if (phase === 'fight') { try { relock() } catch {} }
      return true
    }

    // 攻速抖动：Killaura 的 speedRandMS——两均匀和近似的高斯 ±100ms，攻速节奏不固定
    const gaussMs = () => (Math.random() + Math.random() - 1) * ATTACK_JITTER_MS

    // AutoTotem（Wurst 同名功能，原版合法）：血量 ≤ TOTEM_HP 且副手不是图腾、背包有 → 换副手；
    // 背包确认没有/连续换失败 → 本轮不再找（不空耗）
    const autoTotem = async () => {
      if (totemMissing || b.health > TOTEM_HP) return false
      try {
        const off = b.inventory.slots?.[45]           // 玩家背包 45 号槽 = 副手
        if (off && /totem_of_undying/.test(off.name)) return false
        const totem = b.inventory.items().find((i) => i.name === 'totem_of_undying')
        if (!totem) { totemMissing = true; return false }
        await this.#t(b.equip(totem, 'off-hand'), 'equip', '图腾换到副手')
        return true
      } catch {
        if (++totemFails >= 2) totemMissing = true
        return false
      }
    }
    const fleeGoal = () => new PathGoals.GoalInvert(new PathGoals.GoalFollow(target, FLEE_DIST)) // pathfinder 没有原生逃跑 goal

    // 视线：眼→目标胸口打 ray，返回挡路方块（null=通；出错也算通，宁可空挥也不瘫）
    const losBlock = () => {
      try {
        if (!target || !b.entities[target.id]) return null
        const eye = b.entity.position.offset(0, (b.entity.height ?? 1.8) - 0.18, 0)
        const chest = chestOf(target)
        const d = chest.distanceTo(eye)
        if (d < 0.2) return null
        const dir = chest.minus(eye).normalize()
        return b.world.raycast(eye, dir, d - 0.05, (blk) => blk.boundingBox === 'block' && !/^(water|lava)$/.test(blk.name)) ?? null
      } catch { return null }
    }

    // ── 智能前方障碍检测（2026-09-23 用户实测反馈："总被墙挡不挖；前面一格方块也不跳不挖"）──
    // 光靠视线 ray 太迟钝：眼(1.62)→胸口(0.9) 的射线经常从一格方块**顶上掠过去** → 判"没挡"
    // → 既不挖也不跳，就干瞪眼往前压。改成主动采样：沿**面向方向**（=按住前进会走的方向）在
    // 脚面(y+0.1)、头顶(y+1.1)各探一格实体方块：
    //   脚挡头空 = 一格台阶 → stepJump 直接跳上去（不等卡死）
    //   脚头都挡 = ≥2 格墙   → 4.5 格内换最快工具直接挖（挖不动的 digBlock 内部放弃并记 hardWall）
    //   脚空头挡 = 低顶门洞 → 挖头顶那格
    // 空气/花草（boundingBox=empty）不算挡
    const frontObstacle = () => {
      try {
        const p = b.entity.position
        const yaw = b.entity.yaw ?? 0
        // 正前 + 左右 45°/90° 弧扫：面向没对着墙但身体被侧前方挡住也算
        const dirs = [0, 0.78, -0.78, 1.57, -1.57].map((a) => ({
          dx: -Math.sin(yaw + a), dz: Math.cos(yaw + a),
        }))
        const solid = (dx, dz, fwd, dy) => {
          const blk = b.world.blockAt(p.offset(dx * fwd, dy, dz * fwd))
          return blk && blk.boundingBox === 'block' ? blk : null
        }
        for (const { dx, dz } of dirs) {
          for (const fwd of [0.55, 1.05]) {     // 贴身一格 + 前方一格两档距离
            const foot = solid(dx, dz, fwd, 0.1)
            const head = solid(dx, dz, fwd, 1.1)
            if (!foot && !head) continue
            if (foot && !head) return { kind: 'step', block: foot, dx, dz }
            if (!foot && head) return { kind: 'overhang', block: head, dx, dz }
            return { kind: 'wall', block: foot, dx, dz }
          }
        }
        return null
      } catch { return null }
    }

    const distToTarget = () => (target && b.entities[target.id])
      ? target.position.distanceTo(b.entity.position) : Infinity

    // 手动挖：换最快工具再挖；太硬/太远不挖。2026-09-23 真机教训：领地保护的方块服务器直接
    // 拒绝 → b.dig 会挂死到 #t 的 25s 超时 → 加"挂死竞速"（预测耗时×3，封顶 MAX_DIG_MS），
    // 挂死立即永久放弃、其他错误 2 次放弃（记进 digFails + hardWall），不再每拍重试空耗。
    const digBlock = async (block) => {
      const key = `${block.position.x},${block.position.y},${block.position.z}`
      if (failOf(key) >= 2) return false                  // 已判定挖不动 → 直接放弃
      const tool = b.pathfinder.bestHarvestTool?.(block) ?? null
      // 带效率附魔算实际挖速（Wurst AutoTool：effLvl²+1 加速）——不带会把 1 秒的活判成硬墙
      const enchants = (() => {
        try {
          const nbt = requireFromMineflayer('prismarine-nbt')
          return tool?.nbt ? (nbt.simplify?.(tool.nbt)?.Enchantments ?? []) : []
        } catch { return [] }
      })()
      const digMs = block.digTime(tool ? tool.type : null, false, false, false, enchants, {})
      if (!Number.isFinite(digMs) || digMs > MAX_DIG_MS) {
        hardWall = true
        digFails.set(key, { n: 99, at: Date.now() })
        return false
      }
      try { b.setControlState('forward', false); b.setControlState('sprint', false) } catch {}
      try { await this.#t(b.lookAt(block.position.offset(0.5, 0.5, 0.5)), 'lookAt', '面向挡路方块') } catch {}  // NukerLegit：先 faceVector 再挖
      if (tool && b.heldItem?.type !== tool.type) {
        try { await this.#t(b.equip(tool, 'hand'), 'equip', `换 ${tool.name} 挖墙`) } catch {}
      }
      const hangMs = Math.min(MAX_DIG_MS, Math.max(6000, digMs * 3 + 3000))
      let hung = false
      const digP = Promise.resolve(b.dig(block, true))
      digP.catch(() => {})               // 竞速输掉的 promise 迟到的 rejection 不能打崩进程
      try {
        await this.#t(Promise.race([
          digP,
          sleep(hangMs).then(() => { hung = true }),
        ]), 'dig', `挖 ${block.name}`)
        return true
      } catch {
        // 挂死超时 = 服务器不让挖（领地保护等）→ 立刻永久放弃；其他错误（被击断等）5s 内 2 次才放弃
        const n = failOf(key) + (hung ? 99 : 1)
        digFails.set(key, { n, at: Date.now() })
        if (n >= 2) {
          hardWall = true
          try { b.stopDigging?.() } catch {}
        }
        return false
      }
    }

    // 卡住跳：位置 STUCK_MS 不挪窝 + 着地 + 没在挖/搭 → 脉冲按住 jump（修"差一格不跳"）
    const jumpIfStuck = async () => {
      const now = Date.now()
      const p = b.entity.position
      if (p.distanceTo(stallPos) > 0.15) { refreshStall(); return false }
      if (now - stallAt < STUCK_MS) return false
      if (!b.entity.onGround || b.pathfinder.isMining?.()) { refreshStall(); return false }   // isBuilding 不再抑制跳——寻路自己会跳，这层只防真卡死
      if (now - lastJumpAt < 600) return false
      lastJumpAt = now
      stallAt = now + 400                // 起跳后再宽限一会儿才重新判停滞
      try {
        b.setControlState('jump', true)
        await sleep(JUMP_HOLD_MS)
      } catch { /* 忽略 */ } finally {
        try { b.setControlState('jump', false) } catch {}
      }
      return true
    }

    // 一格台阶正面跳：frontObstacle 判"脚挡头空"就调（FightBot 撞墙跳的正面版）——按住前进+跳
    // 蹬上去，350ms 冷却。不等位置停滞，采样到台阶就跳。
    const stepJump = async (obs) => {
      const now = Date.now()
      if (now - lastJumpAt < 350 || !b.entity.onGround) return false
      lastJumpAt = now
      try {
        if (obs?.dx !== undefined) {   // 弧扫在侧向命中 → 先转向台阶再跳（不然往空处跳）
          await this.#t(b.look(Math.atan2(-obs.dx, obs.dz), 0), 'look', '面向台阶')
        }
        b.setControlState('forward', true)
        b.setControlState('jump', true)
        await sleep(JUMP_HOLD_MS)
      } catch { /* 忽略 */ } finally {
        try { b.setControlState('jump', false) } catch {}
      }
      stallAt = Date.now() + 300          // 刚起跳，给 300ms 宽限再判停滞
      return true
    }

    // ── 远程压制（Wurst BowAimbot + Trajectories 的服务端版）──
    // 原版箭：初速 3.0（满蓄）、每 tick 重力 -0.05、阻力 ×0.99。以"目标扩展 AABB"判命中，
    // 直瞄俯仰 ±70° 内粗扫 1.5° 再精扫 0.15°；拿命中 tick 数加移动目标提前量再解一遍。
    const simArrow = (eye, aim) => {
      const dx = aim.x - eye.x, dy = aim.y - eye.y, dz = aim.z - eye.z
      const yaw = Math.atan2(-dx, dz)
      const basePitch = Math.atan2(-dy, Math.hypot(dx, dz))   // 直瞄俯仰（正=向下）
      let best = { miss: Infinity, yaw, pitch: basePitch, ticks: 0 }
      const tryPitch = (pitch) => {
        const cp = Math.cos(pitch)
        let vx = -Math.sin(yaw) * cp * 3.0
        let vy = -Math.sin(pitch) * 3.0
        let vz = Math.cos(yaw) * cp * 3.0
        let x = eye.x, y = eye.y, z = eye.z
        for (let i = 1; i <= 140; i++) {
          vy -= 0.05
          x += vx; y += vy; z += vz
          vx *= 0.99; vy *= 0.99; vz *= 0.99
          const ex = Math.max(0, Math.abs(x - aim.x) - 0.4)
          const ey = Math.max(0, Math.abs(y - aim.y) - 0.9)
          const ez = Math.max(0, Math.abs(z - aim.z) - 0.4)
          const miss = Math.hypot(ex, ey, ez)
          if (miss < best.miss) best = { miss, yaw, pitch, ticks: i }
          if (miss <= 0.02) return true             // 已进盒内 → 直接命中
          if (y < aim.y - 6) break                  // 掉太深没戏
        }
        return false
      }
      for (let d = -70; d <= 5; d += 1.5) if (tryPitch(basePitch + d * Math.PI / 180)) return best
      const p0 = best.pitch
      for (let d = -1.5; d <= 1.5; d += 0.15) if (tryPitch(p0 + d * Math.PI / 180)) return best
      return best.miss <= 1.2 ? best : null         // 最贴的都不够近 → 这箭别射
    }
    const solveBow = (tv) => {
      const eye = b.entity.position.offset(0, (b.entity.height ?? 1.8) - 0.18, 0)
      let sol = simArrow(eye, chestOf(target))                 // 第一遍：直瞄解出飞行时间
      if (!sol) return null
      const aim = target.position
        .offset(tv.x * sol.ticks / 20, tv.y * sol.ticks / 20, tv.z * sol.ticks / 20)
        .offset(0, (target.height ?? 1.8) * 0.5, 0)
      sol = simArrow(eye, aim)                                 // 第二遍：带提前量精解
      if (!sol || sol.miss > 1.2) return null
      return sol
    }
    const bowShot = async (tv) => {
      if (bowDead || Date.now() - lastBowAt < BOW_INTERVAL_MS) return false
      const bow = b.inventory.items().find((i) => i.name === 'bow')
      const hasArrow = b.inventory.items().some((i) => /^(arrow|tipped_arrow|spectral_arrow)$/.test(i.name))
      if (!bow || !hasArrow) { bowDead = true; return false }
      const sol = solveBow(tv)
      if (!sol) return false
      try {
        if (b.heldItem?.name !== 'bow') await this.#t(b.equip(bow, 'hand'), 'equip', '拿弓')
        await this.#t(b.look(sol.yaw, sol.pitch), 'lookAt', '瞄弓')
        b.activateItem()                     // 按住右键 = 开始拉弓
        await sleep(BOW_CHARGE_MS)           // 蓄力 0.85s（≈90%+ 箭速/伤害）
        b.deactivateItem()                   // 松手射出
        lastBowAt = Date.now()
        return true
      } catch {
        try { b.deactivateItem() } catch {}
        if (++bowFails >= 2) bowDead = true
        return false
      }
    }

    while (Date.now() < deadline) {
      if (this.abortSignal?.aborted) { outcome = 'aborted'; break }
      if (!b.entity || b._client?.ended) { outcome = 'disconnected'; break }

      // 目标从实体表消失：宽限重搜（可能只是过区块边界），耗尽才收场；fight 中找回就重建 goal
      if (!target || !b.entities[target.id]) {
        if (lostAt === null) lostAt = Date.now()
        const found = findTarget()
        if (found) {
          target = found
          lostAt = null
          if (phase === 'fight') relock()
        } else if (Date.now() - lostAt > lostGraceMs) {
          outcome = 'target_gone'
          break
        }
      } else { lostAt = null }

      const hp = b.health
      const dist = distToTarget()
      // 非玩家目标跑太远 → 取消锁定（用户：达不到就别锁了）；玩家不设限，锁到死
      if (target && b.entities[target.id] && !isPlayer(target) && dist > CHASE_FAR) {
        if (farAt === null) farAt = Date.now()
        else if (Date.now() - farAt > 4000) {
          outcome = 'too_far'
          notes = `非玩家目标已拉开 ${dist.toFixed(0)} 格（>${CHASE_FAR}），追不上，取消锁定`
          break
        }
      } else farAt = null

      if (phase === 'fight') {
        // ── 血线分层：危险线+已撤过 → 收场；跌破 hpFloor → 撤（最多 MAX_RETREATS 轮）──
        if (hp <= CRIT && retreats >= 1) {
          outcome = 'retreated'
          notes = `血量 ${hp} 已到危险线（≤${CRIT}）且已撤退过，收场`
          break
        }
        if (hp <= hpLimit) {
          if (retreats >= MAX_RETREATS) {
            outcome = 'retreated'
            notes = `血量 ${hp} ≤ hpFloor ${hpLimit}，撤退 ${retreats} 次仍回不上血`
            break
          }
          retreats++
          phase = 'flee'
          phaseAt = Date.now()
          refreshStall()
          try { b.setControlState('forward', false) } catch {}
          if (target && b.entities[target.id]) {
            try { b.pathfinder.setGoal(fleeGoal(), false) } catch {}
          }
          continue
        }
        if (hp > hpLimit + 6 && retreats > 0) retreats = 0   // 回血充足 → 撤退轮次重新记账
        await autoTotem()                     // AutoTotem：低血把图腾换到副手（Wurst 同名功能）
        // 目标移动速度（弓的提前量）：上一拍→这一拍位移/时间，封顶 ±8 格/秒
        let tvx = 0, tvy = 0, tvz = 0
        if (target && b.entities[target.id]) {
          const nowMs = Date.now()
          if (prevT) {
            const dt = Math.max((nowMs - prevTAt) / 1000, 0.05)
            const cl8 = (v) => Math.max(-8, Math.min(8, v))
            tvx = cl8((target.position.x - prevT.x) / dt)
            tvy = cl8((target.position.y - prevT.y) / dt)
            tvz = cl8((target.position.z - prevT.z) / dt)
          }
          prevT = target.position.clone()
          prevTAt = nowMs
        }

        // ── fight 动作：挖墙 / 打 / 推进+卡住跳（KillauraLegit 视线 + FightBot 推进）──
        const blocked = losBlock()
        if (blocked && !b.pathfinder.isMining?.()) {
          const blockDist = blocked.position.distanceTo(b.entity.position)
          if (blockDist <= DIG_REACH && await digBlock(blocked)) {
            refreshStall()               // 挖成功 → 下一拍重查视线
            await sleep(250)
            continue
          }
          // 挖不动（领地保护/被击断 2 次）或墙在视线里但 >4.5 格 → 落到推进分支往前压/绕
        }
        // 远程压制（BowAimbot 服务端版）：6-22 格、视线通、落地 → 抛物线+提前量射一箭，近了换剑
        if (!blocked && dist >= BOW_MIN && dist <= BOW_MAX && b.entity.onGround && target && b.entities[target.id]) {
          if (await bowShot({ x: tvx, y: tvy, z: tvz })) { await sleep(250); continue }
        }
        if (!blocked && dist <= ATTACK_REACH) {
          try { b.setControlState('forward', false); b.setControlState('sprint', false) } catch {}
          refreshStall()
          if (Date.now() - lastAttackAt >= ATTACK_COOLDOWN_MS + gaussMs()) {
            // 寻路垫脚会把方块/工具临时换到手上 → 出手前把最强武器拿回来（真机教训：曾攥着 cobblestone 空挥）
            try {
              const w = this.#bestWeapon(b)
              if (w && b.heldItem?.name !== w.name) {
                await this.#t(b.equip(w, 'hand'), 'equip', `手持 ${w.name}`)
              }
            } catch { /* 换不上就用手上的打 */ }
            // 跳劈暴击（Criticals 的 FULL_JUMP 合法版）：起跳 300ms 过顶点进入下落段再出手
            // → fallDistance>0 = 暴击 ×1.5；水中/已在空中就直接打。服务器视角=正常移动+正常攻击。
            if (b.entity.onGround && !b.entity.isInWater?.()) {
              try { b.setControlState('jump', true) } catch {}
              await sleep(300)
              try { b.setControlState('jump', false) } catch {}
            }
            try {
              await this.#t(b.lookAt(chestOf(target)), 'lookAt', '看向目标')  // 先面向胸口
              await this.#t(Promise.resolve(b.attack(target)), 'attack', `攻击 ${label}`)
              hits++
              lastAttackAt = Date.now()
            } catch { /* 目标瞬间没了/打空 → 下一拍 */ }
          }
          await sleep(250)
          continue
        }

        // ── 智能前方障碍检测（主动采样，不等视线掠过、不等卡死）：台阶→正面跳；墙/低顶→直接挖 ──
        const obs = frontObstacle()
        if (obs?.kind === 'step') {
          if (await stepJump(obs)) { await sleep(250); continue }
        } else if (obs && !b.pathfinder.isMining?.()) {
          const oDist = obs.block.position.distanceTo(b.entity.position)
          if (oDist <= DIG_REACH && await digBlock(obs.block)) {
            refreshStall()               // 挖通 → 下一拍继续
            await sleep(250)
            continue
          }
          // 挖不动（领地保护，digBlock 内部已放弃）或 >4.5 格 → 落到推进：让寻路绕 / 压过去找口
        }
        // 够不着 / 墙太远挖不到 → 往前压：寻路活着让它跑（该跳该挖它规划）；寻路闲着自己走
        if (!b.pathfinder.isMoving?.() && !b.pathfinder.isMining?.()) {
          if (dist > followRange + 1 && !b.pathfinder.goal) {
            try { relock() } catch {}     // dynamic goal 曾被 goal_reached 清掉 → 重挂，目标跑了才会重规划
          }
          if (target && b.entities[target.id]) {
            try {
              await this.#t(b.lookAt(chestOf(target)), 'lookAt', '看向目标')
            } catch { /* 看不到也照样推 */ }
            try { b.setControlState('forward', true); b.setControlState('sprint', true) } catch {}   // 推进按 sprint（Wurst AutoSprint：冲刺命中额外击退）
          }
        }
        await jumpIfStuck()
        await unstickDig()
        await sleep(250)
        continue
      }

      if (phase === 'flee') {
        // 跑开够远 / 超时 / 血已经开始回升 → 进吃喝阶段
        if (dist >= FLEE_DIST || Date.now() - phaseAt > FLEE_TIMEOUT_MS || hp > hpLimit + 2) {
          phase = 'heal'
          phaseAt = Date.now()
          keepAwaySet = false
          try { b.pathfinder.setGoal(null) } catch {}   // 站住吃（Wurst AutoEat：移动中不吃）
          try { b.clearControlStates?.() } catch {}
          refreshStall()
        } else {
          const o = frontObstacle()       // 逃跑路上一格台阶：正面跳上去（不然被台阶截住跑不掉）
          if (o?.kind === 'step' && await stepJump(o)) { await sleep(180); continue }
          await autoTotem()               // 逃跑途中血只低不涨 → 图腾先换到副手
          await jumpIfStuck()             // 逃跑路上卡台阶照样跳
          await unstickDig()              // 逃跑路上挖挂死同样救
          await sleep(250)
          continue
        }
        continue
      }

      // ── heal：吃食物把 food 抬到 ≥18（自然回血门槛）→ 等血过线 → 重新锁定追上去 ──
      await autoTotem()                     // 等回血的窗口是最脆的 → 图腾换到副手（AutoTotem）
      if (b.food < 18) {
        const foods = b.inventory.items().filter((i) => FOOD_RE.test(i.name))
        if (foods.length === 0) {
          outcome = 'retreated'
          notes = `血量 ${hp} ≤ hpFloor ${hpLimit}，撤了也吃不上东西（背包没食物，food=${b.food}）`
          break
        }
        const rank = (n) => (/golden_apple|enchanted_golden_apple/.test(n) ? 300
          : /^cooked_/.test(n) ? 200
            : /^(bread|golden_carrot|baked_potato|cookie|pumpkin_pie)$/.test(n) ? 150
              : /(rotten_flesh|spider_eye|poisonous_potato)/.test(n) ? -50 : 100)
        foods.sort((a, c) => rank(c.name) - rank(a.name))
        for (const f of foods.slice(0, 3)) {   // 这一拍最多吃 3 件（下一拍 food 仍 <18 会继续吃）
          if (b.food >= 18 || this.abortSignal?.aborted) break
          try {                              // AutoEat：移动中不吃 → 吃前再压一次 goal+控制位
            try { b.pathfinder.setGoal(null) } catch {}
            try { b.clearControlStates?.() } catch {}
            await this.#t(b.equip(f, 'hand'), 'equip', `拿 ${f.name}`)
            if (!FOOD_RE.test(b.heldItem?.name ?? '')) throw new Error(`手持 ${b.heldItem?.name ?? '空'} 不是食物`)
            await this.#t(b.consume(), 'act', `吃 ${f.name}`)
            ate++
          } catch { break }                 // 被撞断/吃饱/背包忙 → 下一拍再试
        }
        if (b.food < 18 && b.inventory.items().filter((i) => FOOD_RE.test(i.name)).length === 0) {
          outcome = 'retreated'
          notes = `血量 ${hp} ≤ hpFloor ${hpLimit}，吃光了食物（food=${b.food}）回不上血`
          break
        }
      }
      if (b.food >= 18 && !keepAwaySet && target && b.entities[target.id]) {
        try { b.pathfinder.setGoal(fleeGoal(), false); keepAwaySet = true } catch {}  // 等回血时也别让人贴脸
      }
      if (b.health > hpLimit) {
        phase = 'fight'                   // 血回过线 → 重新锁定，继续追（用户要的"再锁定追上来"）
        phaseAt = Date.now()
        refreshStall()
        relock()
        await sleep(250)
        continue
      }
      if (Date.now() - phaseAt > HEAL_WAIT_MS) {
        if (retreats >= MAX_RETREATS) {
          outcome = 'retreated'
          notes = `血量 ${b.health} ≤ hpFloor ${hpLimit}，等了 ${HEAL_WAIT_MS / 1000}s 回不上血`
          break
        }
        retreats++                         // 还没到轮次上限 → 再跑开一轮
        phase = 'flee'
        phaseAt = Date.now()
        keepAwaySet = false
        refreshStall()
        if (target && b.entities[target.id]) {
          try { b.pathfinder.setGoal(fleeGoal(), false) } catch {}
        }
        await sleep(250)
        continue
      }
      await sleep(250)
    }

    // 收尾：清 goal + 停控制位，绝不把移动状态留在场上
    try { b.pathfinder.setGoal(null) } catch {}
    try { b.clearControlStates?.() } catch {}
    // 收场把最强武器拿回手（真机教训：寻路垫脚收场时手里常是 dirt/工具）
    try {
      const w = this.#bestWeapon(b)
      if (w && b.heldItem?.name !== w.name) await this.#t(b.equip(w, 'hand'), 'equip', `手持 ${w.name}`)
    } catch { /* 换不上不影响返回 */ }

    if (outcome === 'timeout' && !notes) {
      const parts = []
      if (scaffolding === 0) parts.push('背包无垫脚方块（垫不了脚，遇沟/悬崖只能绕或卡住）')
      if (hardWall) parts.push('目标隔着一时挖不动的硬方块墙')
      if (retreats > 0) parts.push(`期间撤退 ${retreats} 次（吃了 ${ate} 件食物）`)
      if (parts.length) notes = parts.join('；')
    }
    if (outcome === 'retreated' && !notes) {
      notes = `血量 ${b.health} ≤ hpFloor ${hpLimit}，撤退 ${retreats} 次（吃了 ${ate} 件食物）回不上血`
    }
    if (outcome === 'target_gone' && !notes) {
      notes = `目标消失（可能死亡或离开加载范围），最后宽限 ${lostGraceMs / 1000}s`
    }
    return {
      target: label,
      hits,
      outcome,
      distanceEnd: (target && b.entity && b.entities[target.id])
        ? Number(target.position.distanceTo(b.entity.position).toFixed(1)) : null,
      health: b.health,
      food: b.food,
      retreats,
      ate,
      held: b.heldItem?.name ?? null,
      scaffolding,
      elapsedMs: Date.now() - t0,
      ...(notes ? { notes } : {}),
    }
  }

  /** 背包里最强的武器：剑 > 斧，材料 netherite > diamond > iron > stone > golden/wooden；没有返回 null */
  #bestWeapon (b) {
    const tier = { netherite: 5, diamond: 4, iron: 3, stone: 2, golden: 1, wooden: 1 }
    const score = (i) => {
      const m = String(i.name).match(/^(\w+)_(sword|axe)$/)
      if (!m) return -1
      return (tier[m[1]] ?? 1) * 10 + (m[2] === 'sword' ? 5 : 3)
    }
    let best = null
    let bestScore = 0
    for (const i of b.inventory.items()) {
      const s = score(i)
      if (s > bestScore) { best = i; bestScore = s }
    }
    return best
  }

  /** 丢弃手上的物品 */
  async tossItem ({ name = null, count = 1 } = {}) {
    const b = this.requireBot()
    let item = b.heldItem
    if (name) {
      const want = String(name)
      item = b.inventory.items().find((i) => i.name === want)
      if (!item) throw new Error(`背包里没有 ${want}（用 mc_inventory 看有什么）`)
      if (b.heldItem?.name !== want) await this.#t(b.equip(item, 'hand'), 'equip', `手持 ${want}`)
    }
    if (!item) throw new Error('手上没东西可丢')
    const n = Math.min(Math.max(Number(count) || 1, 1), item.count)
    await this.#t(Promise.resolve(b.toss(item.type, null, n)), 'toss', `丢弃 ${item.name}`)
    return { tossed: `${item.name}x${n}` }
  }

  /* ───────────── 序列执行（需求 5：世界交互往往要连串调用）───────────── */

  /**
   * 按顺序执行一串步骤。替代"让 AI 写脚本"——我们不给它脚本能力，
   * 而是把"走这里→放几个→再走那里"这种连串动作收进一个工具，服务端逐步跑。
   *
   * 步骤 op：wait / move / look / turn(toward) / place / break / dig / use / useItem /
   *          attack / hunt / equip / wear / give / toss / say / jump
   */
  async runSequence (steps, { stopOnError = true, budgetMs = 300_000 } = {}) {
    if (!Array.isArray(steps) || !steps.length) throw new Error('steps 必须是非空数组')
    if (steps.length > 64) throw new Error(`步骤太多（${steps.length}），上限 64`)
    const t0 = Date.now()
    const results = []
    for (let i = 0; i < steps.length; i++) {
      if (this.abortSignal?.aborted) { results.push({ i, op: steps[i]?.op, ok: false, error: '被用户中断' }); break }
      if (Date.now() - t0 > budgetMs) { results.push({ i, op: steps[i]?.op, ok: false, error: `总预算 ${budgetMs}ms 用尽` }); break }
      const step = steps[i] ?? {}
      try {
        results.push({ i, op: step.op, ok: true, ...(await this.#runStep(step)) })
      } catch (e) {
        results.push({ i, op: step.op, ok: false, error: e.message })
        if (stopOnError) break
      }
    }
    const okCount = results.filter((r) => r.ok).length
    return {
      requested: steps.length, succeeded: okCount, failed: results.length - okCount,
      elapsedMs: Date.now() - t0, results,
    }
  }

  async #runStep (s) {
    const op = String(s.op ?? '')
    switch (op) {
      case 'wait': {
        const rawSec = s.sec != null ? Number(s.sec) : (s.ms != null ? Number(s.ms) / 1000 : 1)
        const sec = Number.isFinite(rawSec) ? rawSec : 1
        const ms = Math.min(Math.max(sec * 1000, 0), 30_000)
        await sleep(ms)
        return { waitedMs: ms }
      }
      case 'move': {
        const target = { x: Number(s.x), y: Number(s.y), z: Number(s.z) }
        const creative = this.bot?.game?.gameMode === 'creative'
        const mode = String(s.mode ?? (creative ? 'fly' : 'walk'))
        if (mode === 'fly') return { ...(await this.flyTo(target.x, target.y, target.z)), mode }
        return { ...(await this.walkTo(target, { budget: Math.min(Number(s.budgetMs ?? 30_000), 90_000) })), mode }
      }
      case 'look':    return this.lookAt(s)
      // 'toward' 要与 mc_act{mode:"toward"} 语义一致：**看向并走近**（只 lookAt 是错的）
      case 'toward':  return this.interact({ mode: 'toward', who: s.who, approach: s.approach, budgetMs: s.budgetMs })
      case 'place':   return this.placeBlock(s)
      case 'break':   return this.breakBlock(s)
      case 'dig':     return { result: await this.dig(s) }
      case 'use':     return this.useBlock(s)
      case 'attack':  return this.attack(s)
      case 'hunt':    return this.hunt(s)
      case 'equip':   return this.equip(s)
      case 'wear':    return this.equipArmor(s)
      case 'useItem': return this.useItem(s)
      case 'give':    return this.giveItem(s)
      case 'toss':    return this.tossItem(s)
      case 'say':     return { said: this.chatSay(s.text ?? '') }
      case 'jump':    return this.jump()
      default:
        throw new Error(`未知步骤 op："${op}"（可用：wait/move/look/toward/place/break/dig/use/useItem/attack/hunt/equip/wear/give/toss/say/jump）`)
    }
  }

  entities (radius = 24) {
    const b = this.requireBot()
    const me = b.entity.position
    return Object.values(b.entities)
      .filter((e) => e !== b.entity && e.position.distanceTo(me) <= radius)
      .sort((a, c) => a.position.distanceTo(me) - c.position.distanceTo(me))
      .slice(0, 40)
      .map((e) => ({
        name: e.username ?? e.name ?? e.type,
        type: e.type,
        position: { x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z) },
        distance: Number(e.position.distanceTo(me).toFixed(1)),
      }))
  }

  /**
   * 发服务器指令（以玩家身份走聊天）。
   *
   * @param {string} cmd 以 `/` 开头的完整指令
   * @param {{allow?: ((name:string)=>boolean)|null}} [opts]
   *   白名单判定：默认用**内置**那份（保底，独立测试时不依赖插件配置）；
   *   插件层会传自己的可配置白名单进来（用户 2026-09-16 要求白名单可配置）。
   */
  command (cmd, { allow = null } = {}) {
    const b = this.requireBot()
    const c = String(cmd).trim()
    if (!c.startsWith('/')) throw new Error('指令必须以 / 开头')
    const name = c.slice(1).split(/\s+/)[0].toLowerCase()
    const ok = typeof allow === 'function' ? Boolean(allow(name)) : DEFAULT_COMMAND_WHITELIST.has(name)
    if (!ok) throw new Error(`指令不在白名单：/${name}`)
    b.chat(c)
    return c
  }

  requireBot () {
    // ⚠️ 用 `online`（= 有身体 **且** 连接没结束）：只看 `bot.entity` 会把"被踢后的残留"当在线，
    //    于是所有世界工具对着死连接干等（2026-09-19 幽灵在线）。
    if (!this.online) {
      const ghost = this.bot?._client?.ended === true && this.bot?.entity
      throw new Error(`机器人不在线${ghost ? '（连接已结束，bot.entity 是残留，需要 mc_connect 重连）' : ''}${this.lastError ? '：' + this.lastError : ''}`)
    }
    return this.bot
  }
}

/**
 * 边界信息：这个插件"能连哪些 MC 版本"、用的 mineflayer 是哪一版。
 * 数据源是 mineflayer 的模块级常量 `lib/version.js`（`testedVersions` 决定上界拒绝）。
 * 给 `mc_capabilities` 工具用；**不连服、不产生副作用**。
 */
export function libraryInfo () {
  const out = { mineflayer: null, testedVersions: [], oldest: null, latest: null, dataVersions: null, error: null, yggdrasilCompat: yggCompat }
  try {
    const pkg = requireFromMineflayer('./package.json')
    out.mineflayer = pkg?.version ?? null
    const v = requireFromMineflayer('./lib/version.js')
    const list = Array.isArray(v?.testedVersions) ? v.testedVersions : (Array.isArray(v?.default) ? v.default : [])
    out.testedVersions = [...list]
    out.oldest = v?.oldestSupportedVersion ?? list[0] ?? null
    out.latest = v?.latestSupportedVersion ?? list[list.length - 1] ?? null
  } catch (e) { out.error = String(e?.message ?? e) }
  try {
    const mcd = requireFromMineflayer('minecraft-data')
    const pc = mcd?.versions?.pc ?? []
    const releases = pc.map((x) => x?.minecraftVersion).filter((x) => typeof x === 'string' && /^\d+\.\d+(\.\d+)?$/.test(x))
    out.dataVersions = { total: pc.length, releaseCount: releases.length, newest: releases.slice(-6) }
  } catch { /* minecraft-data 拿不到就算了 */ }
  return out
}

export { Vec3 }
export default McBot