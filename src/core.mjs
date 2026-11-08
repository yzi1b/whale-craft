// -*- coding: utf-8 -*-
/**
 * whale_craft / core.mjs —— Minecraft 无头机器人核心（不依赖 DSH，可独立运行与测试）
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
 *   - 走路必须"一直按住"前进键
 */
import mineflayer from 'mineflayer'
import vec3pkg from 'vec3'
import { offlineUuid, dashUuid } from './accounts.mjs'
import { supportedRange, isVersionSupported } from './mcversion.mjs'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { writeFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

const Vec3 = vec3pkg.Vec3 ?? vec3pkg
const HERE = dirname(fileURLToPath(import.meta.url))

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
  /**
   * 日志落盘位置。🔴 **默认不写插件包目录**（装进 `node_modules/` 后那可能是只读的、
   * 升级时也会被覆盖）：默认写 `$DSH_HOME/whale_craft/logs/`，可用 `MC_LOG` 覆盖。
   */
  logFile: process.env.MC_LOG ?? join(resolveDshHome(), 'whale_craft', 'logs', 'whale-craft.log'),
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

const itemView = (item) => {
  if (!item) return null
  return {
    name: item.name ?? null,
    count: Number(item.count ?? 0),
    ...(Number.isInteger(item.slot) ? { slot: item.slot } : {}),
  }
}

const actionFailure = (result) => {
  if (!result || typeof result !== 'object') return null
  if (result.arrived === false) return result.note ?? '未到达目标'
  if (result.placed === false) return result.note ?? '方块未放置成功'
  if (result.broken === false) return result.note ?? '方块未破坏成功'
  if (Number(result.failed) > 0) {
    return result.results?.find?.((entry) => entry?.ok === false)?.error
      ?? result.failures?.[0]
      ?? `动作有 ${result.failed} 项失败`
  }
  return null
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
 * "**等服务端 ack**" 的 promise。服务端可能根本不回包（版本对不上、支持不完整
 * 时尤其如此）→ promise 永不 settle
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

/** 分层设色（等高图）：t∈[0,1] 低→高 → RGB（蓝→青绿→黄→橙→白） */
function heightColorOf (t) {
  const stops = [
    [0.00, [40, 80, 160]], [0.20, [70, 150, 90]], [0.45, [150, 195, 85]],
    [0.65, [215, 205, 90]], [0.80, [200, 140, 70]], [0.92, [170, 110, 90]], [1.00, [245, 245, 245]],
  ]
  const x = Math.min(1, Math.max(0, t))
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const [t0, c0] = stops[i - 1]; const [t1, c1] = stops[i]
      const k = (x - t0) / Math.max(1e-6, t1 - t0)
      return [0, 1, 2].map((j) => Math.round(c0[j] + (c1[j] - c0[j]) * k))
    }
  }
  return stops[stops.length - 1][1]
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
    this.stopped = false
    this.lastTimeout = null
    this.abortSignal = null       // 本轮 turn 的 abort signal（工具层注入）
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
   * @param {string} [opts.host] / [opts.port] - 由工具层从单一 address 解析好再传进来
   * @param {Object} [opts.auth] - 上面的账户描述符（**唯一**的凭据入口）
   *
   * 🔴 2026-10-05（用户定）：不再有 `subserver` / `version` 参数 —— 用户只输入一个 address；
   *    握手 serverHost 由 mineflayer 默认用 host（= 用户地址）发出，DNS + Velocity 自行路由。
   *    版本**永远自动探测**；连上后发现版本不在支持范围内 → 断开并抛错。
   */
  async connect (opts = {}) {
    const host    = opts.host      || this.cfg.host      || DEFAULTS.host
    const port    = Number(opts.port ?? this.cfg.port ?? DEFAULTS.port)
    const sub     = this.cfg.subserver || DEFAULTS.subserver || ''
    const version = false                 // 永远自动探测（用户 2026-10-05：不再由调用方传）
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
      host, port, version: null,          // 连接成功后回填**实际协商版本**
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
          // 🔴 版本不受支持时 mineflayer 在 spawn 前 async 报 "No data available for version X"——
          //    **只对这种错误快速失败**（否则会干等 45s 超时，把"版本不适配"报成误导性的"连接超时"，
          //    2026-10-05 真机：26.2 服务器）。其余错误/断开保持原有"等服务端/等超时"的行为——
          //    否则会抢在 'end' 之前 reject，破坏"真断开 → 发 offline 事件"的时序。
          const VERSION_RE = /No data available for version\s*([\w.\-]+)/i
          let settled = false
          const cleanup = () => { b.removeListener('error', onErr); b.removeListener('end', onEnd) }
          const finish = (fn) => { if (settled) return; settled = true; clearTimeout(t); cleanup(); fn() }
          const t = setTimeout(() => finish(() => reject(new Error(`连接 ${sub} 超时`))), this.cfg.connectTimeoutMs)
          const onErr = (e) => { if (VERSION_RE.test(String(e?.message ?? ''))) finish(() => reject(e)) }
          const onEnd = (r) => {
            const msg = String(this.lastError ?? (typeof r === 'string' ? r : JSON.stringify(r ?? '')))
            if (VERSION_RE.test(msg)) finish(() => reject(new Error(msg)))
          }
          b.once('spawn', () => finish(() => resolve()))
          b.once('kicked', (r) => finish(() => reject(new Error(`被踢: ${String(r).slice(0, 200)}`))))
          b.on('error', onErr)
          b.on('end', onEnd)
        })
      } catch (e) {
        try { b.quit() } catch {}
        if (dupe && attempt < 4) {
          this.log(`顶号冲突，3.5s 后重试（第 ${attempt} 次）`)
          await sleep(3500)
          return attemptOnce(attempt + 1)
        }
        if (previous?.entity) { this.bot = previous; this.log('新连接失败，保留原有连接') }
        // 🔴 版本不受支持：mineflayer 缺该版本的协议数据 → 转成明确的版本错误（不是"连接超时"）
        const noData = /No data available for version\s*([\w.\-]+)/i.exec(String(e?.message ?? ''))
        if (noData) {
          const err = new Error(`服务器版本 ${noData[1]} 不在插件支持范围内（底层 mineflayer 没有该版本的协议数据）`)
          err.hint = `这台服务器是 ${noData[1]}，当前插件还不支持（可连的版本见 mc_capabilities）。`
          this.lastError = err.message
          throw err
        }
        // 认证/入服失败（令牌失效等）：转成"需要用户处理"的明确错误；
        // 顺便把 yggdrasil 兼容层记下的那个 session-join 失败也捞出来当原因。
        const joinErr = takeAuthJoinError()
        throw friendlyAuthError(joinErr ?? e)
      }

      // 🔴 版本不在支持范围内 → 强制失败（用户 2026-10-05 定）：断开刚建的连接，抛用户可读错误。
      //    放在 spawn 成功之后、接管 this.bot 之前 —— 失败就保留原连接，别把好连接顶掉。
      if (isVersionSupported(b.version) === false) {
        try { b.quit() } catch {}
        if (previous?.entity) { this.bot = previous; this.log('服务器版本不受支持，保留原有连接') }
        const err = new Error(`服务器版本 ${b.version} 不在插件支持范围内`)
        err.hint = `这台服务器是 ${b.version}，当前插件还不支持（可连的版本见 mc_capabilities）。`
        this.lastError = err.message
        throw err
      }

      if (previous && previous !== b) { try { previous.quit() } catch {} }
      this.bot = b
      this.sub = sub
      this._connectionProfile.version = b.version   // 实际协商版本（供 mc_status）
      this._lastHost = host          // ⚠️ 必须记：否则上面的"已连着就直接返回"永不生效，
                                     //    重复 mc_connect 会真去重连（先把自己踢下线再登回来）
      this.connectedAt = Date.now()
      this.stats.connects++
      this.autoReconnect = true
      this.reconnectPending = false      // 进来了就算"断线期"结束（手动 mc_connect 也算）
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
   *   ① 先关掉自动重连 / 世界观察器 —— 否则退服事件会把看门狗又吵醒
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

  /* ───────────── 按键上报兼容层（player_input）——已整体移除（2026-10-02 用户决策） ─────────────
   * 它原本为 26.2 而加（20Hz 上报按键位，mineflayer 不发）。移除原因：上游还连不了 26.2——
   * mineflayer 4.39.0 的 testedVersions 只到 26.1；minecraft-data 3.117.0 只收了 26.2 的
   * **元数据**、没有数据目录（`minecraft-data('26.2')` 为 null）。半吊子支持先撤，等上游真支持
   * 26.2 再重建。
   *
   * 将来重建**必须**沿用"先查后发"：protodef 对未知包名**不报错**，写出「id=0x00 + 空 body」
   * （实测字节 `02 00 00`），服务端会把 id 0x00 当成自己的 `accept_teleportation` 去读
   * teleportId —— 没有字节 ⇒ DecoderException ⇒ 秒踢（2026-09-19 只报 1.21.1 掉线的根因；
   * 现象极迷惑：进服完全成功、1 秒后掉线，错误却指向"确认传送"，详见 CHANGELOG 0.1.7）。
   * ─────────────────────────────────────────────────────────────────────────────────────── */

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
    return { host: p.host ?? null, port: p.port ?? null, version: p.version ?? null }
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

  /**
   * 游戏上下文（`mc_context`）。basic = 模式/维度/坐标/朝向；
   * survival 段（血量/吸收/饱食/饱和/气泡/装备/经验 + buff + 坐骑/骑乘者）——生存/冒险模式默认给，
   * `survival:true` 可强制给（用户 2026-10-05 定）。
   */
  context ({ survival = false } = {}) {
    const b = this.bot
    if (!b?.entity) return { online: false }
    const p = b.entity.position
    const gamemode = b.game?.gameMode ?? null
    const out = {
      online: true,
      gamemode,
      dimension: b.game?.dimension ?? null,
      position: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) },
      yaw: b.entity.yaw ?? null,
      pitch: b.entity.pitch ?? null,
    }
    if (survival !== true && gamemode !== 'survival' && gamemode !== 'adventure') return out
    out.health = b.health ?? null
    out.absorption = b.entity.absorption ?? null
    out.food = b.food ?? null
    out.saturation = b.foodSaturation ?? null
    out.air = b.oxygenLevel ?? null
    out.experience = { level: b.experience?.level ?? null, points: b.experience?.points ?? null }
    out.equipment = this.equipmentView()
    out.effects = this.effectsView()
    const vehicle = b.vehicle?.entity ?? b.vehicle ?? null
    out.vehicle = vehicle ? (vehicle.name ?? vehicle.username ?? null) : null
    out.passengers = (b.entity.passengers ?? []).map((e) => e?.name ?? e?.username ?? null).filter(Boolean)
    return out
  }

  /** 装备视图：手持 / 四件护甲 / 副手（无物品 → null） */
  equipmentView () {
    const b = this.bot
    const slots = b?.inventory?.slots
    if (!slots) return null
    return {
      held: itemView(b.heldItem),
      armor: [slots[5], slots[6], slots[7], slots[8]].map(itemView),
      offhand: itemView(slots[45]),
    }
  }

  /** buff 列表：id + 名字（尽力经 minecraft-data 解析）+ 等级 + 剩余秒 */
  effectsView () {
    const b = this.bot
    const effects = b?.entity?.effects ?? {}
    const out = []
    for (const id of Object.keys(effects)) {
      const e = effects[id]
      let name = null
      try { name = requireFromMineflayer('minecraft-data')(b.version)?.effects?.[Number(id)]?.name ?? null } catch {}
      out.push({
        id: Number(id), name,
        amplifier: e?.amplifier ?? null,
        durationSec: e?.duration != null ? Math.round(e.duration / 1000) : null,
      })
    }
    return out
  }

  /** 在线玩家（含自己）：tab 栏名 / 档案名 / uuid（`mc_players`）*/
  players () {
    const b = this.bot
    if (!b?.players) return { online: false, players: [] }
    const strip = (s) => String(s ?? '').replace(/§[0-9a-fk-or]/gi, '')
    return {
      online: true,
      self: b.username ?? null,
      players: Object.values(b.players).map((p) => ({
        tabName: strip(p.displayName ?? p.username ?? '') || null,
        username: p.username ?? null,
        uuid: p.uuid ?? null,
      })),
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

  /* ───────────── 高度（地势）图（`mc_height`）───────────── */

  /**
   * 单列"地表 Y"：startY 处**没有方块** → 向下找第一个有方块的位置，取其 Y；
   * startY 处**有方块** → 向上找第一个没有方块的位置，取其 **Y − 1**。
   * 未加载（blockAt 为 null）或到界都没有 → null。
   */
  surfaceY (x, y0, z, bottom, top, ignoreLiquid = false) {
    const b = this.bot
    const at = (y) => b.blockAt(new Vec3(x, y, z))
    const solid = (blk) => blk && !isAir(blk.name) && !(ignoreLiquid && isLiquid(blk.name))
    const blk0 = at(y0)
    if (blk0 === null) return null
    if (!solid(blk0)) {
      for (let y = y0 - 1; y >= bottom; y--) {
        const blk = at(y)
        if (blk === null) return null
        if (solid(blk)) return y
      }
      return null
    }
    for (let y = y0 + 1; y <= top; y++) {
      const blk = at(y)
      if (blk === null || !solid(blk)) return y - 1
    }
    return top
  }

  /**
   * 高度网格：按 `step` 抽样（每 step 格取一列，省算力），每列一个地表 Y。
   * @returns {{center, startY, step, bottom, top, min, max, gridWidth, gridHeight, heights:(number|null)[][]}}
   */
  heightGrid ({ radius = 32, step = 2, startY = null, ignoreLiquid = false } = {}) {
    const b = this.requireBot()
    const R = Math.min(Math.max(Math.floor(radius), 4), 96)
    const s = Math.max(1, Math.floor(Number(step) || 1))
    const cx = Math.floor(b.entity.position.x)
    const cz = Math.floor(b.entity.position.z)
    const cy = Math.floor(b.entity.position.y)
    const y0 = (startY === null || startY === undefined || Number.isNaN(Number(startY))) ? cy : Math.floor(Number(startY))
    const minY = Number.isFinite(b.game?.minY) ? b.game.minY : -64
    const height = Number.isFinite(b.game?.height) ? b.game.height : 384
    const bottom = minY
    const top = minY + height - 1
    const cols = Math.ceil((2 * R) / s)
    const heights = []
    let min = Infinity; let max = -Infinity
    for (let gi = 0; gi < cols; gi++) {
      const dz = -R + gi * s
      const row = []
      for (let gj = 0; gj < cols; gj++) {
        const h = this.surfaceY(cx + (-R + gj * s), y0, cz + dz, bottom, top, ignoreLiquid)
        if (h !== null) { if (h < min) min = h; if (h > max) max = h }
        row.push(h)
      }
      heights.push(row)
    }
    if (min === Infinity) { min = y0; max = y0 }
    return { center: { x: cx, y: cy, z: cz }, startY: y0, step: s, ignoreLiquid, bottom, top, min, max, gridWidth: cols, gridHeight: cols, heights }
  }

  /** 高度网格 → 字符（模拟图片，" " 最低、'@' 最高；null = '?'） */
  static heightGlyphs (heights, min, max) {
    const RAMP = ' .:-=+*#%@'
    const span = Math.max(1, max - min)
    return heights.map((row) => row.map((h) => {
      if (h === null) return '?'
      const t = Math.min(1, Math.max(0, (h - min) / span))
      return RAMP[Math.min(RAMP.length - 1, Math.round(t * (RAMP.length - 1)))]
    }).join('')).join('\n')
  }

  /** 高度网格 → 分层设色 RGBA 图（每格最近邻放大 scale 倍；null 画成深灰） */
  heightImage ({ radius = 32, step = 2, startY = null, scale = 4, ignoreLiquid = false } = {}) {
    const g = this.heightGrid({ radius, step, startY, ignoreLiquid })
    const grid = g.heights
    const h = grid.length
    const w = h > 0 ? grid[0].length : 0
    if (!w || !h) throw new Error('高度数据为空（区块可能还没加载）')
    const s = Math.min(Math.max(Number(scale) || 4, 1), 16)
    const W = w * s; const H = h * s
    const rgba = new Uint8Array(W * H * 4)
    const span = Math.max(1, g.max - g.min)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = grid[y][x]
        const [r, gg, bb] = v === null ? [70, 70, 70] : heightColorOf((v - g.min) / span)
        for (let dy = 0; dy < s; dy++) {
          const rowBase = (y * s + dy) * W
          for (let dx = 0; dx < s; dx++) {
            const o = (rowBase + x * s + dx) * 4
            rgba[o] = r; rgba[o + 1] = gg; rgba[o + 2] = bb; rgba[o + 3] = 255
          }
        }
      }
    }
    return {
      width: W, height: H, rgba,
      center: g.center, startY: g.startY, step: g.step, min: g.min, max: g.max,
      gridWidth: w, gridHeight: h, scale: s,
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
    const results = []
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
        if (!target) {
          results.push({ ok: false, block: want, error: `附近找不到 ${want}` })
          break
        }
      }
      const at = { x: target.position.x, y: target.position.y, z: target.position.z }
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
        results.push({ ok: true, block: nm, position: at, now: b.blockAt(p)?.name ?? null })
      } catch (e) {
        results.push({ ok: false, block: target.name, position: at, error: e.message })
        break
      }
    }
    const succeeded = results.filter((entry) => entry.ok).length
    return { requested: n, succeeded, failed: results.length - succeeded, results }
  }

  inventory () {
    const b = this.requireBot()
    return { held: itemView(b.heldItem), items: b.inventory.items().map(itemView) }
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

  /** 装备某物到手上 */
  async equip ({ name } = {}) {
    const b = this.requireBot()
    const item = b.inventory.items().find((i) => i.name === String(name))
    if (!item) throw new Error(`背包里没有 ${name}（用 mc_inventory 看有什么）`)
    await this.#t(b.equip(item, 'hand'), 'equip', `手持 ${name}`)
    return { held: itemView(item) }
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
      try {
        const result = await this.placeBlock({ ...p, name })
        const failure = actionFailure(result)
        if (failure) {
          fail.push(`${p.x},${p.y},${p.z}: ${failure}`)
          if (fail.length >= 5) break
        } else ok.push(`${p.x},${p.y},${p.z}`)
      }
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
      gave: { name: itemName, count: n }, slot: target,
      now: itemView(b.inventory.slots?.[target]),
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

  /** 使用/激活方块或实体（开门、按按钮、拉杆、喂动物…） */
  async useBlock ({ x, y, z, who = null } = {}) {
    const b = this.requireBot()
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
    return { tossed: { name: item.name, count: n } }
  }

  /* ───────────── 序列执行（需求 5：世界交互往往要连串调用）───────────── */

  /**
   * 按顺序执行一串步骤。替代"让 AI 写脚本"——我们不给它脚本能力，
   * 而是把"走这里→放几个→再走那里"这种连串动作收进一个工具，服务端逐步跑。
   *
   * 步骤 op：wait / move / look / turn(toward) / place / break / dig / use /
   *          attack / equip / give / toss / say / jump
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
        const result = await this.#runStep(step)
        const failure = actionFailure(result)
        if (failure) {
          results.push({ i, op: step.op, ...result, ok: false, error: failure })
          if (stopOnError) break
        } else results.push({ i, op: step.op, ...result, ok: true })
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
      case 'dig':     return this.dig(s)
      case 'use':     return this.useBlock(s)
      case 'attack':  return this.attack(s)
      case 'equip':   return this.equip(s)
      case 'give':    return this.giveItem(s)
      case 'toss':    return this.tossItem(s)
      case 'say':     return { said: this.chatSay(s.text ?? '') }
      case 'jump':    return this.jump()
      default:
        throw new Error(`未知步骤 op："${op}"（可用：wait/move/look/toward/place/break/dig/use/attack/equip/give/toss/say/jump）`)
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
  try { out.mineflayer = requireFromMineflayer('./package.json')?.version ?? null } catch (e) { out.error = String(e?.message ?? e) }
  // 支持版本区间与 `mcversion.mjs` **同源**（testedVersions 的上下界）——别再各读一份。
  const range = supportedRange()
  if (range) { out.testedVersions = range.tested; out.oldest = range.oldest; out.latest = range.latest }
  else if (!out.error) out.error = '读不到 mineflayer 的版本表（lib/version.js）'
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
