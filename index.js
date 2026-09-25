/**
 * whale_craft —— DSH 原生 Minecraft Agent 插件（host 半端）
 * ============================================================================
 * 目标：把"我"接进 MC 做成**一等公民**，而不是外挂一个 MCP 子进程。
 *
 *  1. 原生工具：mc_status / mc_say / mc_move / mc_map / mc_dig / ... 直接注册进
 *     ctx.tools（所有会话可见），不再依赖 @deepseek-ai/dsh-mcp-client。
 *  2. 🔴 **每会话独立实例**：每个 agent（会话）有自己的 McBot + 事件队列 + 看门狗。
 *     不同会话可以连不同服务器、用不同账号，互不干扰。
 *     同一个会话内只能有一个 bot 实例（一个游戏角色）。
 *  3. 🔴 **连接参数工具化**：服务器地址/端口/登录凭据/子服 全部由 mc_connect 工具
 *     运行时传参，AI 根据用户指令或记忆文件决定连哪里。Config 里不再有硬编码的
 *     服务器/凭据（旧字段保留为 fallback，逐步废弃）。
 *  4. 事件通知**只有一条通道**：`mc_watch` 后台看门狗任务（job 结算 → DSH followup
 *     唤醒**同一个会话**）。本插件**不存在**任何跨会话唤醒实现。
 *
 * 机器人核心在 ./src/core.mjs（不依赖 DSH，可独立测试）。
 * 挂载：profile cordis.patch.yml 里 `- id: whale_craft / name: whale_craft`。
 * ============================================================================
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, unlinkSync, statSync, renameSync, realpathSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { resolve, sep, join, isAbsolute, dirname } from 'node:path'
import { homedir } from 'node:os'
import { McBot, lossless, logLine, libraryInfo } from './src/core.mjs'
import { versionPromptText, versionPromptTitle, versionPromptSource } from './src/version-prompt.mjs'
import { EXPRESS_DIR, OUT_DIR, expressRootOf, outRootOf, parseExpressPath, safeExpressTarget, mimeOf, SANDBOX_TYPES, expressRefFor, EXPRESS_OFF_TEXT, EXPRESS_NEED_BASE_TEXT, normalizeExpressBase, onlineUrlOf } from './src/express.mjs'
import { Watchdog, WATCH_DEFAULTS } from './src/watchdog.mjs'
import { MemoryStore } from './src/memory.mjs'
import { PluginConfig, DEFAULT_CONFIG, resolveStateDir, pickPresetTarget, pickPresetSource, isCopiedPresetDescription, PREFERRED_PRESET_SOURCES, MC_PRESET_SPEC, planPresetAction, patchPersonaInComposition, personaTextKeyOf, disableShellInComposition, patchToolGroupsIntoComposition, MC_PRESET_TOOL_GROUPS } from './src/config.mjs'
import { AccountStore, parseAuthlibCard, normalizeServerUrl, dashUuid } from './src/accounts.mjs'
import { DEFAULT_AGENTS_MD, agentsMdPath, legacyAgentsMdPath, migrateLegacyAgentsMd, readAgentsMd, writeAgentsMd, resetAgentsMd, isAgentsMdPath, syncRulesVersion, readRulesVersion } from './src/agentsmd.mjs'
import { encodePng } from './src/png.mjs'
import { userMessage, noticeSource, messageFactoryKind, pluginLoadNote } from './src/user-message.mjs'
import { ImageEngine, imageEngineAvailable, imageEngineError } from './src/image.mjs'
import { listenLanBroadcast } from './src/lan.mjs'
import { statusPing, parseAddress } from './src/ping.mjs'
import { waitForEvents } from './src/wait.mjs'

export const name = 'whale_craft'
export const inject = ['tools']

/** 插件版本（`mc_capabilities` 会报给 Master；读不到就 unknown） */
const PLUGIN_VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? 'unknown' } catch { return 'unknown' }
})()

/* ============================ HTTP 工具与信任栅栏 ============================ */
/* 与 @deepseek-ai/dsh-client-connection 的 /api 同款栅栏（DNS-rebinding + 跨站），
 * 非认证层。照抄 dsh-serve 的实现，保持同源插件行为一致。 */

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255)
    && parts[0] === '127'
}

function parseAuthority(authority) {
  try { return new URL(`http://${authority}`) } catch { return undefined }
}

function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
    const canonical = port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
    return canonical === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

function isTrustedRequest(headers, trustedHosts) {
  const host = headers.host
  if (typeof host !== 'string') return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (headers['sec-fetch-site'] === 'cross-site') return false
  const origin = headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) })
  res.end(data)
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1_000_000) req.destroy()      // 防手滑发大包
    })
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })
}

/**
 * Config 只保留**行为配置**（与"连哪个服"无关）。
 * 连接参数（host/port/authUrl/authUser/authPass/subserver）已全部移到 mc_connect 工具。
 * 旧字段保留为 fallback（工具不传参时用），但默认值已清空凭据。
 */
export const Config = z.object({
  // ── 以下为 fallback（deprecated，工具传参优先）──
  host: z.string().default(''),
  port: z.natural().default(25565),
  subserver: z.string().default(''),
  authUrl: z.string().default(''),
  authUser: z.string().default(''),
  authPass: z.string().default(''),
  autoConnect: z.boolean().default(false),

  // ── 行为配置（保留）──
  /**
   * "喊我"的触发词（正则，大小写不敏感）。聊天里命中这些词才算在叫我。
   *
   * 🔴 2026-09-16 用户投诉："为什么这台服务器上会有那种叫法的记忆？你暴露了些什么东西出去了！"
   *    根因就是这里**曾经把私人的账号名/昵称写成了默认值**——那串名字跟着代码进了**公开的开源副本**。
   *    默认值只留**通用叫法**；具体账号名由插件在连接成功后**从登录档案里现学**
   *    （见 `Watchdog.learnName`），外号用 `mc_config {patch:{mentionPatterns:[…]}}` 加
   *    —— **代码里永不再出现私人名字**。
   */
  mentions: z.array(z.string()).default([
    'deepseek', 'deep\\s*seek', '\\bds\\b', '\\bdsh\\b', '\\bai\\b', 'agent',
    '机器人', '麦块',
  ]),
  /** 聊天是否必须命中触发词才算叫我（默认 true：避免公屏闲聊把我叫醒） */
  chatMentionOnly: z.boolean().default(true),
  /** 受攻击/低血是否算作"叫我"（默认 true；看门狗可按次覆盖） */
  damageCountsAsCall: z.boolean().default(true),
})


/* ======================== 每会话独立实例 ======================== */

/**
 * 一个会话的 MC 状态：独立 McBot + 事件队列 + 看门狗。
 * 不同会话的 McSession 互不干扰。
 */
class McSession {
  constructor(agentId, config, lockDir = null) {
    this.agentId = agentId
    this.config = config
    // 不传固定 config：连接参数走 connect()；instanceId 让每个会话有独立的锁与日志标识。
    // 🔴 lockDir = 插件的家（`$DSH_HOME/whale_craft/`）：**别把锁文件写进插件包目录**
    //    （装进 node_modules 后可能是只读的，升级时也会被覆盖）——与日志同一条理由。
    this.bot = new McBot({ instanceId: agentId, ...(lockDir ? { lockDir } : {}) })
    this.mode = 'standby'           // standby / active / sleep
    this.events = []                // 未消费的 MC 事件
    this.maxEvents = 200
    this.watchdog = null            // 看门狗（Watchdog 实例，进服自动挂载）
    this.selectedAccount = null     // 本会话选定的账户 innerID（mc_accounts{action:"use"}）
    // 「正在等待」被打断的标记（看门狗要唤醒 AI 时置位）——见 src/wait.mjs 的文件头说明：
    // 宿主把 steer 放在下一个 step 边界投递，而 step 边界要等当前工具返回 ⇒
    // 一个 mc_events{waitSec} 就能把唤醒拖到最后。这个标记让等待提前收工。
    this.waitInterruptedAt = 0
    this.waitInterruptReason = null
    this._wired = false
  }

  /**
   * 打断本会话正在进行的 `mc_events {waitSec}` 等待（看门狗注入前调用）。
   * 只置一个标记：等待循环每 250ms 看一眼，见到就立刻返回（工具一返回，step 结束，唤醒文案当场投出去）。
   */
  interruptWait(reason = null) {
    this.waitInterruptedAt = Date.now()
    this.waitInterruptReason = reason ? String(reason) : null
  }

  /* ── 事件绑定（懒绑：首次使用时才 wire，避免未连接的 bot 产生无意义事件）── */

  ensureWired(pluginCtx) {
    if (this._wired) return
    this._wired = true
    const self = this

    this.bot.on('log', (line) => pluginCtx.logger?.info?.(`[${self.agentId}] ${line}`))
    this.bot.on('spawn', (e) => self.#pushEvent('lifecycle', `已上线 ${e.sub} @ ${JSON.stringify(e.position)}`))
    this.bot.on('death', (e) => self.#pushEvent('lifecycle', `我死了 @ ${JSON.stringify(e.position)}`))
    this.bot.on('reconnect', (e) => self.#pushEvent('lifecycle', `已重连 ${e.sub}`))
    // 🔴 断线也要进事件队列（2026-09-19）：`mc_events` 里看得见，AI 才不会以为"一直在线"。
    this.bot.on('offline', (e) => self.#pushEvent('lifecycle',
      `连接断开：${e?.reason ?? '连接结束'}${e?.willReconnect ? '（正在自动重连）' : '（不会自动重连）'}`))
    this.bot.on('chat', ({ who, text }) => self.#pushEvent('chat', `<${who}> ${text}`, { who }))
    this.bot.on('system', ({ text }) => self.#pushEvent('system', text))
    this.bot.on('damage', (e) => self.#pushEvent('damage', `血量降到 ${e.health} @ ${JSON.stringify(e.position)}`))
  }

  /* ── 清理 ── */

  destroy() {
    try { this.watchdog?.disarm('会话结束') } catch {}
    try { this.bot.disconnect('会话结束') } catch {}
    this.watchdog = null
    this.events = []
  }

  /* ── 事件队列 ── */

  #pushEvent(kind, text, extra = {}) {
    this.events.push({ at: Date.now(), kind, text, ...extra })
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents)
  }

  drainEvents(limit = 20, kind = null) {
    const taken = []
    const rest = []
    for (const e of this.events) {
      if (taken.length < limit && (!kind || e.kind === kind)) taken.push(e)
      else rest.push(e)
    }
    this.events = rest
    return taken
  }

  /* ── 模式 ── */

  modeView() {
    return {
      mode: this.mode,
      online: this.bot.online,
      // 断了但还要重连（含"正在尝试连接"那段，最长 45s）：前端要能显示"重连中"，AI 也别以为还能操作角色
      reconnecting: Boolean(this.bot.reconnecting || this.bot.reconnectPending),
      sub: this.bot.sub,
      connection: this.bot.connectionView(),
      pendingEvents: this.events.length,
      watch: this.watchdog?.status() ?? null,
    }
  }

  /* ── "喊我"判定 ── */

  mentionRegex() {
    if (this._mentionRe?.source !== this.config.mentions.join('|')) {
      this._mentionRe = new RegExp(this.config.mentions.map((p) => `(?:${p})`).join('|'), 'i')
    }
    return this._mentionRe
  }

  isCalled(text) { return this.mentionRegex().test(String(text ?? '')) }

  calledBy(text) {
    const s = String(text ?? '')
    return this.config.mentions.filter((p) => { try { return new RegExp(`(?:${p})`, 'i').test(s) } catch { return false } })
  }
}


/* ======================== 全局注册表 ======================== */

/**
 * 管理所有活跃的 McSession。按 agentId 索引。
 * 插件卸载时统一清理。
 */
class McRegistry {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    /** 插件状态目录（`$DSH_HOME/whale_craft/`）：会话锁文件放这里，不写插件包目录 */
    this.lockDir = null
    /** @type {Map<string, McSession>} */
    this.sessions = new Map()
  }

  /** 获取当前会话的 McSession（不存在就创建） */
  getOrCreate(agentId) {
    let sess = this.sessions.get(agentId)
    if (!sess) {
      sess = new McSession(agentId, this.config, this.lockDir)
      sess.ensureWired(this.ctx)
      this.sessions.set(agentId, sess)
      this.ctx.logger?.info?.(`[whale_craft] 新建会话实例：${agentId}`)
    }
    return sess
  }

  /** 只读查询：不存在就返回 undefined（**不要**用 getOrCreate——查状态不该建实例） */
  peek(agentId) { return this.sessions.get(agentId) }

  /** 销毁某个会话的实例 */
  destroy(agentId) {
    const sess = this.sessions.get(agentId)
    if (sess) {
      sess.destroy()
      this.sessions.delete(agentId)
      this.ctx.logger?.info?.(`[whale_craft] 销毁会话实例：${agentId}`)
    }
  }

  /** 销毁所有（插件卸载时） */
  destroyAll() {
    for (const [id, sess] of this.sessions) {
      try { sess.destroy() } catch {}
    }
    this.sessions.clear()
  }

  /** 列出所有活跃实例（诊断用） */
  listSessions() {
    return [...this.sessions.entries()].map(([id, sess]) => ({
      agentId: id,
      online: sess.bot.online,
      sub: sess.bot.sub,
      mode: sess.mode,
      connection: sess.bot.connectionView(),
      pendingEvents: sess.events.length,
      watching: sess.watchdog?.status() ?? null,
    }))
  }
}


/* ======================== 看门狗（绑定到具体 McSession）======================== */

/**
 * 拿到（或创建）本会话的看门狗。
 * 看门狗要往会话里注入消息，必须绑 agent —— 在这里补齐并随时刷新引用。
 * @param gate - 可选：**模式闸门**，返回 false 时看门狗不往会话里注入（见 `Watchdog#gate`）。
 *   切出 MC 模式后仍 armed 的看门狗靠它闭嘴；切回 MC 模式自动恢复。
 */
function ensureWatchdog (ctx, sess, agent, promptSignal = null, gate = null) {
  if (!sess.watchdog) {
    // 注意：看门狗**不**往 sess.events 写（唯一写入方是 McSession.ensureWired）——
    // 两边都写会让同一句话进队列两遍。
    sess.watchdog = new Watchdog({ ctx, sess, agent, promptSignal })
  } else {
    if (agent) sess.watchdog.agent = agent
    if (promptSignal) sess.watchdog.promptSignal = promptSignal
  }
  if (gate) sess.watchdog.gate = gate
  return sess.watchdog
}


/* ============================ 插件主体 ============================ */

export function apply(ctx, config) {
  const registry = new McRegistry(ctx, config)

  /* ── 插件状态目录（**配置 + 账户库**）：`$DSH_HOME/whale_craft/` ──────────────────
   * 🔴 2026-09-16 用户要求：配置和账户**不该躺在工作区里** —— 工作区是项目的家，
   *    插件有插件自己的家。宿主（app-boot）`ctx.provide('dshHomePath', …)` 给了这个路径，
   *    与 `$DSH_HOME/skills` / `.agent-presets` / `storages` / `attachments` 同一套规矩。
   * ------------------------------------------------------------------------ */
  const dshHomePath = (() => { try { return ctx.get('dshHomePath') } catch { return undefined } })()
  const stateDir = resolveStateDir({ dshHomePath, whaleDir: process.env.WHALE_CRAFT_DIR })
  registry.lockDir = stateDir      // 会话锁文件也放插件自己的家（别写进插件包目录）

  /* ── 记忆 / 提示词：挂在**会话工作区**下，不再假设"插件装在工作区里" ──────────────
   * 抽取成标准插件后，包可能装在 `node_modules/` 或任意目录，**不能**再用 `__dirname/..` 推工作区。
   * 正路：宿主给工具的 `exec.agent.session.header.cwd` 就是该会话的工作区（tool-fs 同款来源）。
   * 记忆与提示词都挂它下面：`<工作区>/.whale-craft/`。
   * 优先级：`WHALE_CRAFT_MEMORY_DIR` → `config.memoryDir` → `<工作区>/.whale-craft`
   *         （**没有会话上下文时**兜底 `WHALE_CRAFT_DIR` 或 `$DSH_HOME/whale_craft/memory`）。
   * ------------------------------------------------------------------------ */
  /** 会话工作区（拿不到就 null：说明调用方没有 agent 上下文） */
  const workspaceOf = (agent) => {
    const cwd = agent?.session?.header?.cwd
    return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : null
  }

  const memoryRootFor = (cwd) => {
    const explicit = process.env.WHALE_CRAFT_MEMORY_DIR ?? pluginConfig.memoryDir
    if (explicit) return explicit
    if (cwd) return join(cwd, '.whale-craft')
    return process.env.WHALE_CRAFT_DIR ? stateDir : join(stateDir, 'memory')
  }

  /** 老版本（≤0.3.x）把 config/accounts 放在 `<工作区>/.whale-craft/`：每个工作区首次见到时搬一次 */
  const migratedWorkspaces = new Set()
  const migrateWorkspaceState = (cwd) => {
    if (!cwd || migratedWorkspaces.has(cwd)) return
    migratedWorkspaces.add(cwd)
    for (const [name, label] of [['config.json', '全局配置'], ['accounts.json', '账户库']]) {
      const from = join(cwd, '.whale-craft', name)
      const to = join(stateDir, name)
      try {
        if (!existsSync(to) && existsSync(from)) {
          mkdirSync(stateDir, { recursive: true })
          copyFileSync(from, to)
          if (readFileSync(to, 'utf8') === readFileSync(from, 'utf8')) unlinkSync(from)
          logLine(`已把${label}搬出工作区：${from} → ${to}`)
        }
      } catch (e) { logLine(`${label}搬迁失败（保留旧位置）：${e.message}`) }
    }
  }

  /** 按工作区缓存 MemoryStore（同一工作区不重复扫盘） */
  const memoryCache = new Map()
  const memoryFor = (cwd) => {
    const root = memoryRootFor(cwd)
    let store = memoryCache.get(root)
    if (!store) {
      migrateWorkspaceState(cwd)
      // 🔴 `create:false`：**读**记忆不该顺手把 `.whale-craft/` 建出来。
      //    建目录/建行事准则（RULES.md）只发生在"首次发起 MC 模式会话"与"点开 MC设置"这两个时机
      //    （用户 2026-09-16 定），由 `ensureMemoryRoot` 显式做。
      store = new MemoryStore(root, { create: false })
      memoryCache.set(root, store)
    }
    return store
  }

  const pluginConfig = new PluginConfig(stateDir)
  /** 无会话上下文时用的兜底记忆库（`capabilities` / 扩展 api / 全局注入用） */
  const memory = memoryFor(null)
  /** 这个会话的工作区根（mc_kit_image / 地图落盘用）；拿不到就给个兜底目录 */
  const workspaceRootFor = (agent) => workspaceOf(agent) ?? join(stateDir, 'workspace')

  /**
   * 按 sessionId 找**这个会话选中的工作区**：
   *   ① 活着的 agent（`agent.session.header.cwd`，首选，最准）；
   *   ② 冷会话 → 问宿主的 `sessionQuery.listSessions()`（header 里有 cwd）。
   * 都没有 = 这个会话没选工作区（用户 2026-09-16：那种情况要**拒绝** MC 模式与 MC设置）。
   */
  const workspaceOfSession = async (sessionId) => {
    const sid = String(sessionId ?? '').trim()
    if (!sid) return null
    const live = workspaceOf(safeAgentById(sid))

    if (live) return live
    try {
      const q = ctx.get('sessionQuery')
      const records = await q?.listSessions?.()
      const rec = (records ?? []).find((r) => String(r?.header?.id ?? r?.id ?? '') === sid)
      const cwd = rec?.header?.cwd ?? rec?.cwd ?? null
      return typeof cwd === 'string' && cwd.trim() ? cwd : null
    } catch { return null }
  }

  /** 按 sessionId 找 agent（HTTP 那几个接口用；拿不到就 null） */
  const safeAgentById = (sessionId) => {
    if (!sessionId) return null
    try { return ctx.get('agents')?.get?.(String(sessionId)) ?? null } catch { return null }
  }
  logLine(`whale_craft：配置 ${pluginConfig.file}｜记忆 <会话工作区>/.whale-craft（兜底 ${memory.root}）`)

  /* ─────────── 发布区（`.whale-craft/.express/`）：地址用**工作区 uuid** ───────────
   * 用户 2026-09-17 定稿：`<base>/api/whale-craft/express/<工作区 uuid>/<剩余路径>`。
   * uuid 直接从宿主的工作区注册表拿（`ctx.workspaceRegistry.list()` 是**同步**的，`path` 已 realpath 规范化）——
   * 不再用"目录名 + 进程内见过的工作区集合"那套（同名会撞、改名会失效、重启要重新见过）。
   * 🔴 用户定的兜底是 **(a) 拒绝**：注册表里查不到这个 cwd 对应的 uuid 就不分享（不退回目录名）。
   * ------------------------------------------------------------------------ */
  const EXPRESS_MAX_BYTES = 32 * 1024 * 1024

  /** 宿主的工作区注册表（可能还没就绪 → 返回空表，别抛） */
  const workspaceRows = () => {
    try {
      const rows = ctx.get('workspaceRegistry')?.list?.()
      return Array.isArray(rows) ? rows : []
    } catch { return [] }
  }

  /** cwd → 工作区 uuid（比对 realpath 规范化后的路径；查不到 = null） */
  const workspaceIdOfCwd = (cwd) => {
    const s = typeof cwd === 'string' ? cwd.trim() : ''
    if (!s || !isAbsolute(s)) return null
    let real = s
    try { real = realpathSync(s) } catch { /* 目录可能还不存在，就用原样比 */ }
    for (const w of workspaceRows()) {
      const p = String(w?.path ?? '')
      if (p && (p === real || p === s)) return String(w.id)
    }
    return null
  }

  /** 工作区 uuid → cwd（注册表里的规范路径） */
  const workspaceCwdById = (id) => {
    const key = String(id ?? '')
    if (!key) return null
    for (const w of workspaceRows()) if (String(w?.id) === key) return String(w.path)
    return null
  }

  /* ─────────── 「文件分享」页要的两件事：看现状 / 清除数据（用户 2026-09-17 定）───────────
   * · 现状 = 这个工作区的发布区在哪、攒了几个文件、多大（分享模式本身是全局配置，见 configView）；
   * · 清除 = 用户确认后把 `.express/` 下的东西**全删掉**（目录自己留着，AI 不用重新建）。
   * 🔴 目录永远由服务端按「工作区 + `.whale-craft/.express`」推出来，**不接受任何用户给的路径**。
   * ------------------------------------------------------------------------ */
  const sharedStat = (cwd) => {
    const root = expressRootOf(memoryRootFor(cwd))
    let files = 0
    let bytes = 0
    const walk = (dir) => {
      let entries = []
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const ent of entries) {
        const p = join(dir, ent.name)
        if (ent.isDirectory()) { walk(p); continue }
        if (!ent.isFile()) continue
        files++
        try { bytes += statSync(p).size } catch { /* 读不到大小就当 0 */ }
      }
    }
    if (existsSync(root)) walk(root)
    return { dir: root, exists: existsSync(root), files, bytes }
  }

  const clearShared = (cwd) => {
    const root = expressRootOf(memoryRootFor(cwd))
    const before = sharedStat(cwd)
    if (!existsSync(root)) return { ...before, existed: false, removed: 0 }
    try {
      rmSync(root, { recursive: true, force: true })     // 连目录一起删（里面有符号链接也只删链接本身）
      mkdirSync(root, { recursive: true })               // 立刻重建：发布区随时可用
    } catch (e) {
      throw new Error(`清除分享数据失败：${e.message}`)
    }
    logLine(`「文件分享」清除分享数据：${root}（${before.files} 个文件 / ${before.bytes} 字节）`)
    return { ...before, existed: true, removed: before.files }
  }

  /**
   * 「当前地址」= 浏览器**实际在用**的那个地址（在线 base 的默认值 / 「获取当前」按钮的值）。
   *
   * 精度从高到低：
   *   ① **浏览器自己报的** `clientOrigin`（查询参数，前端塞 `location.origin`）——
   *     协议/域名/端口都是它真在用的，反代终止 TLS 也不会错。只认 host 与请求 Host 一致的；
   *   ② `Origin` 请求头；
   *   ③ `Referer`（只取 origin，且 host 必须与 Host 一致）；
   *   ④ `X-Forwarded-Proto` + `Host`；
   *   ⑤ `Host` + socket 是否 TLS。
   * 都拿不到就回 `''`（前端提示手填）。
   *
   * 🔴 为什么必须有 ①/③ 这两档：用户可能从 `https://域名` 访问、而 TLS 是**反代终止**的
   * （转发到本机是明文 http，代理也未必带 `X-Forwarded-Proto`）—— 只看 Host 会推出 `http://域名`：
   * 协议错，图片会被浏览器当混合内容挡掉。
   * ⚠️ DSH **没有"挂载前缀"概念**（`API_PATH` 是常量 `/api`，前端一律用根绝对路径调接口），
   * 所以反代额外加的路径前缀不可能自动得知 —— 那种情况由用户自己补（前缀会原样拼在 base 后面）。
   */
  const currentBaseOf = (req, hints = {}) => {
    const host = String(req?.headers?.host ?? '').trim()
    const sameHost = (value) => {
      try { return Boolean(host) && new URL(value).host === new URL(`http://${host}`).host } catch { return false }
    }
    const originPart = (value) => {
      try {
        const u = new URL(String(value))
        return u.protocol === 'http:' || u.protocol === 'https:' ? `${u.protocol}//${u.host}` : ''
      } catch { return '' }
    }
    // ① 浏览器报上来的（最准：协议/域名/端口都是它真在用的）——服务端不裁剪它；host 必须与请求 Host 一致
    const hint = normalizeExpressBase(hints.clientOrigin)
    if (hint && sameHost(hint)) return hint
    // ② Origin 头
    const o = normalizeExpressBase(originPart(req?.headers?.origin))
    if (o) return o
    // ③ 同源 Referer
    const ref = originPart(req?.headers?.referer)
    if (ref && sameHost(ref)) {
      const r = normalizeExpressBase(ref)
      if (r) return r
    }
    if (!host) return ''
    // ④ 反代声明的协议 + Host；⑤ Host + socket
    const fwd = String(req?.headers?.['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase()
    const proto = fwd === 'https' || fwd === 'http' ? fwd : (req?.socket?.encrypted ? 'https' : 'http')
    return normalizeExpressBase(`${proto}://${host}`) ?? ''
  }

  /* ─────────── MC账户库：元数据在 $DSH_HOME/whale_craft/accounts.json，凭据只进宿主凭据服务 ───────────
   * 🔴 LLM 永远拿不到密码/token：工具只回基本信息；凭据只在这两个 helper 里出现，且不外传。
   * ------------------------------------------------------------------------ */
  const accounts = new AccountStore({ dir: stateDir, logger: ctx.logger ?? null })
  accounts.ensureDefaults()
  // 凭据服务可能晚就绪 → 必须 ctx.inject 等（老教训：apply() 时 ctx.get() 常是 undefined）
  ctx.inject(['credentials'], (scope) => {
    accounts.credentials = scope.get('credentials') ?? null
    // 🔴 必须 catch：未处理的 Promise 拒绝会被宿主的 fail-loud 当致命错误 → exit(1)（2026-09-17 真炸过）
    void accounts.refreshCredentialIndex().then(() => {
      logLine(`账户库就绪：${accounts.list().length} 个账户｜凭据服务 ${accounts.credentialsReady ? '可用' : '不可用（拒绝存密码）'}`)
    }).catch((e) => { logLine(`凭据索引刷新失败（不影响启动）：${e?.message ?? e}`) })
  })

  /** 账户 → core 的 auth 描述符（**唯一**读凭据的地方；返回值含密码，绝不外传） */
  const resolveAuth = async (innerID = null) => {
    const acc = accounts.resolve(innerID)
    if (!acc) {
      const e = new Error('一个账户都没有——请在「MC设置」里新建一个（默认应该有一个离线账户 DeepSeek）')
      e.needUserAction = true
      throw e
    }
    const view = accounts.view(acc)
    if (acc.type === 'offline') {
      return { innerID: acc.innerID, label: view.name, auth: { mode: 'offline', name: view.name, uuid: view.uuid } }
    }
    const srv = accounts.listAuthServers().find((s) => s.id === acc.serverId)
    if (!srv) {
      const e = new Error(`账户「${view.name}」用的认证服务器已经被移除了`)
      e.needUserAction = true
      e.hint = '请在「MC设置」里给这个账户换一个认证服务器，或删掉它'
      throw e
    }
    const cred = await accounts.getCredential(acc.innerID)
    if (!cred?.password && !cred?.accessToken) {
      const e = new Error(`账户「${view.name}」还没有保存的登录凭据`)
      e.needUserAction = true
      e.hint = '请在「MC设置」里重新登录这个账户（输入账号密码）'
      throw e
    }
    return {
      innerID: acc.innerID,
      label: view.name,
      auth: {
        mode: 'yggdrasil',
        authUrl: srv.url,
        authUser: acc.login ?? null,
        authPass: cred.password ?? null,
        accessToken: cred.accessToken ?? null,
        clientToken: cred.clientToken ?? null,
      },
    }
  }

  /**
   * 登录成功后回写：皮肤站账户把**档案名/UUID/账号 id** 更新进账户库，并把**新令牌**存回凭据服务。
   * ⚠️ 只对皮肤站账户做 name/uuid 覆盖：离线账户的 UUID 是"按名字派生"的，写死会毁掉这个语义。
   */
  const persistAuth = async (resolved, profile, session) => {
    try {
      const acc = accounts.get(resolved.innerID)
      if (!acc) return
      if (acc.type === 'yggdrasil') {
        const patch = {}
        const uuid = dashUuid(profile?.id)
        if (uuid) patch.uuid = uuid
        if (profile?.name) patch.name = String(profile.name)
        if (session?.user?.id) patch.id = String(session.user.id)
        if (Object.keys(patch).length) accounts.update(resolved.innerID, patch)
        if (session?.accessToken) {
          const cur = await accounts.getCredential(resolved.innerID)
          await accounts.setCredential(resolved.innerID, {
            password: resolved.auth.authPass ?? cur?.password ?? null,
            accessToken: session.accessToken,
            clientToken: session.clientToken ?? cur?.clientToken ?? null,
          })
        }
      }
      await accounts.refreshCredentialIndex()
    } catch (e) { ctx.logger?.warn?.(`[whale_craft] 回写账户信息失败：${e.message}`) }
  }

  /** 把"需要用户处理"的提示拼进错误里（让 LLM 知道该叫用户去「MC设置」） */
  const withUserHint = (e, label) => {
    if (!e?.needUserAction) return e
    const hint = e.hint ?? '请让用户在「MC设置」里重新登录这个账户，或点它的「刷新」'
    const out = new Error(`${e.message}｜${hint}${label ? `（账户：${label}）` : ''}`)
    out.needUserAction = true
    return out
  }

  // 注入用的 AbortSignal（插件生命周期）。`sessionController.prompt` 是 @Remote 方法，
  // 签名 (request, signal)，**必须传 signal**——否则 undefined.throwIfAborted() 直接炸。
  const promptAbort = new AbortController()
  ctx.effect(() => () => { try { promptAbort.abort() } catch {} }, 'whale_craft: prompt signal')

  ctx.effect(() => () => { registry.destroyAll() })

  /* ─────────── HTTP API：状态条 UI 用（状态查询 / 强制停止 / 普通停止）─────────── */

  /** 运行期信任列表（--trusted-host 等） */
  const liveTrustedHosts = () => {
    const runtime = ctx.get('webRuntime')
    return runtime !== undefined && Array.isArray(runtime.trustedHosts) ? runtime.trustedHosts : []
  }

  /**
   * **强制停止**某个会话的 MC —— 用户 2026-09-16 定的语义与顺序：
   *
   *   ① **先停 LLM**（如果它正在输出）。不先停的话：它还会继续调工具、甚至把刚退掉的游戏重连回来。
   *      中断之所以有效，靠的是工具侧 raceAbort 监听 exec.signal —— 宿主自己**没有**硬中断能力
   *      （`tools/index.ts:219` 原话 "cannot hard-kill same-process code"），所以"让工具必然结算"是唯一出路。
   *   ② **先尝试优雅退出游戏**（`bot.quit` + 宽限期，真走不掉才强断；见 src/core.mjs 的 disconnect）。
   *   ③ **再强清该会话全部后台任务**（看门狗就在里面）。
   *   ④ **最后再停一次 LLM**：②③期间会有退服事件/注入（"你被踢了"、工具被 abort 的结算）可能又把它推起来，
   *      收尾再停一次，避免会话停在异常状态。
   *
   * ⚠️ **普通停止已移除**（用户要求："移除停止，只剩强行停止"）。唯一的例外是 `cancelTurn:false`：
   * 给 **AI 自己调 `mc_stop`** 用——工具就跑在被停的那一轮里，cancel 会 abort 掉它自己所在的 turn
   * （表现为 "tool call aborted"，真机报告过）。UI 的按钮走 HTTP，用默认的 cancelTurn:true。
   *
   * @param {string} sessionId
   * @param {{reason?: string, cancelTurn?: boolean}} [opts]
   */
  const stopSession = async (sessionId, { reason = '用户强制停止', cancelTurn = true } = {}) => {
    const sess = registry.peek(sessionId)
    const agents = ctx.get('agents')
    const agent = agents?.get?.(sessionId)
    const out = {
      sessionId, reason, order: [],
      stoppedLLM: false, finalStopLLM: false, stopLLMError: null,
      quit: null, kicked: false, killedJobs: [],
    }

    /** 停 LLM：优先 sessionController.cancel（宿主正路），退到 agent.cancel */
    const cancelLLM = () => {
      try {
        const sc = ctx.get('sessionController')
        if (typeof sc?.cancel === 'function') { sc.cancel({ sessionId }); return true }
        if (typeof agent?.cancel === 'function') { agent.cancel({ kind: 'user' }, { keepInbox: true }); return true }
      } catch (e) { out.stopLLMError = String(e?.message ?? e) }
      return false
    }

    /**
     * 等它真的停下来（running → 其它）。拿不到 status 就只给一小段缓冲，别白等。
     * 详见 packages/core/agent-loop/src/agent.ts 的 `get status()`。
     */
    const waitIdle = async (ms) => {
      const known = agent?.status !== undefined
      const budget = known ? ms : Math.min(ms, 120)
      const t0 = Date.now()
      while (Date.now() - t0 < budget) {
        if (known && agent.status !== 'running') return true
        await new Promise((r) => setTimeout(r, 50))
      }
      return !known
    }

    // ① 先停 LLM
    if (cancelTurn) {
      out.stoppedLLM = cancelLLM()
      out.order.push('stop-llm')
      await waitIdle(1500)
    }

    // ② 先尝试退出游戏（关看门狗 → 优雅 quit → 走不掉才强断）
    if (sess?.watchdog) { try { sess.watchdog.disarm(reason, { notify: false }) } catch {} }
    if (sess) {
      try {
        out.quit = await sess.bot.disconnect(reason)
        out.kicked = true
      } catch (e) { out.quitError = String(e?.message ?? e) }
      sess.mode = 'standby'
      out.order.push('quit-game')
    }

    // ③ 再强清该会话全部后台任务
    //
    // 🔴 2026-09-22：`jobs` 这一族的 `caller` 参数要的是**会话 id 字符串**，不是 agent 对象
    //    （宿主 `assertAccess()` 比的是 `job.owner.id !== caller`；见 src/watchdog.mjs#ownerId）。
    //    以前传 `agent` 对象，`list()` 于是**一个自己的 job 都匹配不到**，
    //    却把 `owner === undefined` 的**宿主级"无主 job"**全列出来 —— 那些 job 的
    //    `assertAccess` 对无主任务是不设防的，于是"强制停止某个会话"会顺手杀掉
    //    跟这个会话毫无关系的后台任务。这里两处一起改：用会话 id 查，且**只杀自己的**。
    const jobs = ctx.get('jobs')
    const jobOwner = agent?.id
    if (jobs && typeof jobOwner === 'string' && jobOwner.length > 0) {
      try {
        for (const j of jobs.list(jobOwner) ?? []) {
          const id = j?.id ?? j?.jobId
          if (!id) continue
          if (j?.owner !== jobOwner) continue     // 无主 job（宿主自己的）不归我们管
          try { jobs.kill(id, jobOwner, reason); out.killedJobs.push(id) } catch {}
        }
      } catch (e) { out.jobsError = String(e?.message ?? e) }
    }
    out.order.push('kill-jobs')

    // ④ 最后再停一次 LLM（收尾，避免状态异常）
    if (cancelTurn) {
      out.finalStopLLM = cancelLLM()
      out.order.push('stop-llm-final')
      await waitIdle(800)
    }

    ctx.logger?.info?.(`[whale_craft] 强制停止 ${sessionId}｜${JSON.stringify(out)}`)
    return out
  }

  /* ─────────── 归档保护（用户 2026-09-15 补充要求）───────────
   * "会话归档前要自动强行停止，或者阻止归档。"
   *
   * 做法：包一层 `ctx.workspaceRegistry.archiveSession`。归档一个正在玩 MC 的会话时，
   * 先把机器人踢下线、关看门狗、清后台任务、中断当前轮，**再**放行归档。
   * 选择"自动停止"而不是"阻止归档"——用户想归档就该让它归档，只是别留个孤儿 bot 在线。
   *
   * 为什么能包：`archiveSession` 是 workspace 服务上的普通方法（`workspace/src/index.ts:243`），
   * 不是抽象/私有；卸载时还原原方法。
   * ------------------------------------------------------------------------ */

  /**
   * 安装归档保护。
   *
   * ⚠️ 必须在 `workspaceRegistry` **就绪之后**才能装：`apply()` 跑的时候它往往还没起来，
   *    `ctx.get('workspaceRegistry')` 会返回 undefined（隔离实例实测踩到）。
   *    正解是 `ctx.inject(['workspaceRegistry'], cb)` —— 服务就绪（或重新就绪）时回调，
   *    并且回调里的 `scope.effect` 把还原逻辑挂在**那个 fiber** 上。
   *    参照宿主自己的写法：`packages/client/modules/src/index.ts:576`。
   */
  const installArchiveGuard = (scope) => {
    const wsRegistry = scope.get('workspaceRegistry')
    if (!wsRegistry || typeof wsRegistry.archiveSession !== 'function') {
      logLine('宿主没有 workspaceRegistry：归档保护未启用')
      return
    }
    const originalArchive = wsRegistry.archiveSession
    wsRegistry.archiveSession = async function (sessionId) {
      const id = String(sessionId)
      const sess = registry.peek(id)
      if (sess && (sess.bot?.online || sess.watchdog?.armed)) {
        logLine(`会话 ${id} 将被归档 → 先强制停止 MC`)
        try {
          await stopSession(id, { reason: '会话被归档' })
        } catch (e) {
          logLine(`归档前停止失败（仍继续归档）：${e.message}`)
        }
      }
      return originalArchive.call(this, sessionId)
    }
    scope.effect(() => () => { wsRegistry.archiveSession = originalArchive }, 'whale_craft: archive guard')
    logLine('已挂上归档保护（归档前自动停止 MC）')
    scope.logger?.info?.('[whale_craft] 已挂上归档保护（归档前自动停止 MC）')
  }

  if (ctx.get('workspaceRegistry') === undefined) {
    ctx.inject(['workspaceRegistry'], (scope) => installArchiveGuard(scope))
  } else {
    installArchiveGuard(ctx)
  }

  /**
   * 「MC设置」模态框的后端（账户 / 认证服务器 / 指令白名单）。
   * 🔴 响应里**永远没有密码或 token**；错误统一 200 + `{ok:false,error,needUserAction?,hint?}`，
   *    这样前端只管解析 JSON，不用管状态码。
   */
  let authProbe = null
  const probeBot = () => (authProbe ??= new McBot({ instanceId: 'auth-probe', lockDir: stateDir }))

  /** 设置页要的那几项配置（集中一处，GET/PATCH 共用） */
  const configView = () => ({
    commandWhitelist: pluginConfig.get('commandWhitelist'),
    allowAllCommands: pluginConfig.get('allowAllCommands'),
    injectWhaleCraftAgentsMd: pluginConfig.get('injectWhaleCraftAgentsMd'),
    injectWorkspaceAgentsMd: pluginConfig.get('injectWorkspaceAgentsMd'),
    // 「提示词」页的「随版本更新」（默认开）
    rulesFollowVersion: pluginConfig.get('rulesFollowVersion') !== false,
    // 「MC设置 → 文件分享」：模式 + 在线 base（两种模式：off 关闭 / online 在线）
    expressMode: pluginConfig.expressMode,
    expressBase: pluginConfig.expressBase,
    // 「MC设置」入口的模式门控：前端拿这份名单 + 会话记录的 preset 就能**本地**判定
    // （不必为按钮问一次服务端；2026-09-16 事故：一次性请求失败后按钮永久消失）
    mcModePresets: pluginConfig.mcModePresets,
    configFile: pluginConfig.file,
  })

  const handleSettingsApi = async (req, res, path, url) => {
    const ok = (body) => sendJson(res, 200, { ok: true, ...body })
    // ⚠️ DELETE **也带 body**（前端把 innerID/id 放在 body 里）——只有 GET 没有 body。
    //    E2E 实测踩过：早先按 "GET/DELETE 都不读体" 写，两个删除接口全废。
    const body = req.method === 'GET' ? {} : await readJsonBody(req)

    /* 前端**门控**要的那份名单（哪些 preset 算 MC 模式）：极小、只读、不需要 sessionId / 工作区。
     * 绝不能挂在 `settingsGate` 后面 —— 否则浏览器拿不到名单就静默退回兜底值，
     * 按钮显示与否会和服务端口径不一致（2026-09-16 自查出来的自伤）。 */
    if (path === '/api/mc/presets' && req.method === 'GET') {
      return ok({ mcModePresets: pluginConfig.mcModePresets })
    }

    /**
     * 「MC设置」这组接口的**工作区闸门**（用户 2026-09-16）：
     *   · **没有选中工作区 → 拒绝**（400），不猜、也不落到 `$DSH_HOME` 兜底目录；
     *   · 顺带承担"**点开 MC设置**"这个时机：把该工作区的 `.whale-craft/`（README.md / RULES.md）备好。
     */
    /**
     * 「MC设置」这组接口的**工作区闸门**（用户 2026-09-16）：
     *   · 优先按 sessionId 找会话的工作区；
     *   · 新对话页那个会话可能**还没落盘**（客户端已经选好工作区了）→ 允许客户端直接报 `cwd`；
     *   · 都没有 → 拒绝（400），不猜、也不落到 `$DSH_HOME` 兜底目录。
     *   · 顺带承担"**点开 MC设置**"这个时机：把该工作区的 `.whale-craft/` 备好。
     */
    const usableWorkspace = (p) => {
      const s = String(p ?? '').trim()
      if (!s || !isAbsolute(s)) return null
      try { return statSync(s).isDirectory() ? s : null } catch { return null }
    }
    const settingsGate = async (sessionId, cwdHint) => {
      const sid = String(sessionId ?? '').trim()
      let cwd = sid ? await workspaceOfSession(sid) : null
      let from = cwd ? 'session' : null
      if (!cwd) {
        cwd = usableWorkspace(cwdHint)
        if (cwd) from = 'client'
      }
      if (!cwd) {
        return {
          ok: false,
          error: sid
            ? '这个会话**没有选中工作区**，「MC设置」不可用：请先在会话里选定一个工作区（记忆与提示词都放在那里）。'
            : '缺少 sessionId：这组接口只在某个会话里可用（要用它的工作区放记忆与提示词）；新对话页请先选好工作区。',
        }
      }
      ensureMemoryRootForCwd(cwd)
      return { ok: true, cwd, from }
    }
    const gateOf = (b) => settingsGate(
      url.searchParams.get('sessionId') ?? b?.sessionId,
      url.searchParams.get('cwd') ?? b?.cwd,
    )

    if (path === '/api/mc/accounts' && req.method === 'GET') {
      const gate = await gateOf()
      if (!gate.ok) return sendJson(res, 400, { ok: false, error: gate.error })
      return ok({
        defaultAccount: accounts.resolve()?.innerID ?? null,
        authServers: accounts.listAuthServers(),
        accounts: accounts.list(),
        credentialsReady: accounts.credentialsReady,
      })
    }
    if (path === '/api/mc/accounts' && req.method === 'POST') {
      const gate = await gateOf(body)
      if (!gate.ok) return sendJson(res, 400, { ok: false, error: gate.error })
      // 第三方账户：允许**顺手把认证服务器记住**——前端「新建第三方账户」就是"先填服务器、再填账号密码"，
      // 只给一个地址，这里负责 resolve-or-create（免得前端要发两次请求、也不怕重复地址）。
      let serverId = body.serverId ? String(body.serverId) : null
      if (String(body.type) === 'yggdrasil' && !serverId && body.serverUrl) {
        const url = normalizeServerUrl(String(body.serverUrl))
        const existing = accounts.listAuthServers().find((s) => s.url === url)
        serverId = existing ? existing.id : accounts.addAuthServer({ name: body.serverName ?? null, url }).id
      }
      // 选了缓存里的服务器、但把**名字**改了 → 顺手改名（名字只给人看，id 不动）。
      // 不填就不动：`addAuthServer` 默认拿域名当名字，用户想改成"认证服务器"这种看得懂的就靠这一步。
      if (serverId && body.serverName) {
        const cur = accounts.listAuthServers().find((s) => s.id === serverId)
        const nm = String(body.serverName).trim()
        if (cur && nm && nm !== cur.name) accounts.renameAuthServer(serverId, nm)
      }
      const acc = accounts.add({
        type: body.type, name: body.name, uuid: body.uuid ?? null,
        serverId, login: body.login ?? null,
      })
      if (body.password) await accounts.setCredential(acc.innerID, { password: String(body.password) })
      if (body.default === true) accounts.update(acc.innerID, { default: true })
      await accounts.refreshCredentialIndex()
      return ok({ account: accounts.view(accounts.get(acc.innerID)) })
    }
    if (path === '/api/mc/accounts' && req.method === 'PATCH') {
      const gate = await gateOf(body)
      if (!gate.ok) return sendJson(res, 400, { ok: false, error: gate.error })
      const patch = { ...body }
      delete patch.innerID
      return ok({ account: accounts.update(String(body.innerID ?? ''), patch) })
    }
    if (path === '/api/mc/accounts' && req.method === 'DELETE') {
      const gate = await gateOf(body)
      if (!gate.ok) return sendJson(res, 400, { ok: false, error: gate.error })
      return ok(await accounts.remove(String(body.innerID ?? '')))
    }
    if (path === '/api/mc/accounts/refresh' && req.method === 'POST') {
      const gate = await gateOf(body)
      if (!gate.ok) return sendJson(res, 400, { ok: false, error: gate.error })
      const innerID = String(body.innerID ?? '')
      const resolved = await resolveAuth(innerID)
      if (resolved.auth.mode === 'offline') {
        return ok({ account: accounts.view(accounts.get(innerID)), note: '离线账户不需要认证（UUID 按名字派生）' })
      }
      let captured = null
      await probeBot().authOnly(resolved.auth, { onSession: (s) => { captured = s } })
      if (captured) await persistAuth(resolved, captured.selectedProfile, captured)
      return ok({ account: accounts.view(accounts.get(innerID)) })
    }
    if (path === '/api/mc/authservers' && req.method === 'POST') {
      const gate = await gateOf(body)
      if (!gate.ok) return sendJson(res, 400, { ok: false, error: gate.error })
      let url = body.url ? String(body.url) : null
      if (!url && body.card) {
        url = parseAuthlibCard(body.card)
        if (!url) throw new Error('这张卡片里没找到认证服务器地址（要 `authlib-injector:yggdrasil-server:<网址>` 或一条网址）')
      }
      if (!url) throw new Error('要给 url，或把卡片拖进来（card）')
      return ok({ server: accounts.addAuthServer({ name: body.name ? String(body.name) : null, url }) })
    }
    if (path === '/api/mc/authservers' && req.method === 'DELETE') {
      const gate = await gateOf(body)
      if (!gate.ok) return sendJson(res, 400, { ok: false, error: gate.error })
      return ok(accounts.removeAuthServer(String(body.id ?? '')))
    }
    if (path === '/api/mc/config' && req.method === 'GET') {
      const gate = await gateOf()
      if (!gate.ok) return sendJson(res, 400, { ok: false, error: gate.error })
      return ok(configView())
    }
    if (path === '/api/mc/config' && req.method === 'PATCH') {
      const gate = await gateOf(body)
      if (!gate.ok) return sendJson(res, 400, { ok: false, error: gate.error })
      for (const k of ['commandWhitelist', 'allowAllCommands', 'injectWhaleCraftAgentsMd', 'injectWorkspaceAgentsMd', 'rulesFollowVersion', 'expressMode', 'expressBase']) {
        if (body[k] !== undefined) pluginConfig.set(k, body[k])
      }
      return ok(configView())
    }

    /* ── 「MC设置 → 文件分享」：这个工作区的发布区现状 / 清除分享数据 ──────────────
     * 分享**模式与 base** 是全局配置（走 `/api/mc/config`）；这两个接口是**按工作区**的：
     *   · GET    看发布区在哪、攒了多少（页面上显示，省得用户去翻文件夹）；
     *   · DELETE 「清除分享数据」—— 前端必须**先让用户确认**再调它（不可撤销）。
     * 目录由服务端推导，前端传不了路径。
     * ------------------------------------------------------------------------ */
    if (path === '/api/mc/express' && req.method === 'GET') {
      const gate = await gateOf()
      if (!gate.ok) return sendJson(res, 400, { ok: false, error: gate.error })
      // 顺带把「当前地址」给前端：base 的「获取当前」按钮 / 切到在线时的自动填，都用它
      // （`clientOrigin` = 浏览器塞进来的 `location.origin`，最精准那一档）
      return ok({
        ...sharedStat(gate.cwd),
        currentBase: currentBaseOf(req, { clientOrigin: url?.searchParams?.get('clientOrigin') }),
      })
    }
    if (path === '/api/mc/express' && req.method === 'DELETE') {
      const gate = await gateOf()
      if (!gate.ok) return sendJson(res, 400, { ok: false, error: gate.error })
      return ok(clearShared(gate.cwd))
    }

    /* ── 提示词（「MC设置 → 提示词」页 = `.whale-craft/RULES.md`）：读 / 存 / 恢复默认 ──
     * 🔴 它是**按会话工作区**的（`<工作区>/.whale-craft/RULES.md`），所以前端要带 sessionId。
     * 🔴 没有选中工作区 → **拒绝**（用户 2026-09-16）；有工作区则顺带把文件备好（点开设置即建）。 */
    if (path === '/api/mc/agents-md') {
      const gate = await gateOf(body)
      if (!gate.ok) return sendJson(res, 400, { ok: false, error: gate.error })
      const sessionId = String(body.sessionId ?? url?.searchParams?.get('sessionId') ?? '')
      const cwd = gate.cwd
      const promptDir = memoryRootFor(cwd)
      const wsPath = join(workspaceRootFor(safeAgentById(sessionId)), 'AGENTS.md')
      if (req.method === 'GET') {
        const cur = readAgentsMd(promptDir)
        return ok({
          text: cur.text,
          source: cur.source,
          path: cur.path,
          isDefault: cur.source === 'default',
          defaultText: DEFAULT_AGENTS_MD,
          // 「随版本更新」：开关（配置里那份）+ 当前内容对应的版本（`.rules-version` 标记）
          followVersion: pluginConfig.get('rulesFollowVersion') !== false,
          rulesVersion: readRulesVersion(promptDir),
          pluginVersion: PLUGIN_VERSION,
          workspacePath: wsPath,
          workspaceExists: existsSync(wsPath),
          // 「提示词」页要能直接告诉用户"这几段到底会不会进模型"（省得靠猜）
          injection: promptInjectionStatus(safeAgentById(sessionId)),
        })
      }
      if (req.method === 'PUT') return ok({ ...writeAgentsMd(promptDir, body.text), source: 'custom' })
      if (req.method === 'DELETE') return ok({ ...resetAgentsMd(promptDir), source: 'default' })
    }
    throw new Error(`未知的设置接口：${req.method} ${path}`)
  }

  /**
   * 发布区服务：`GET/HEAD /api/whale-craft/express/<工作区 uuid>/<剩余路径>`
   *   → `<工作区>/.whale-craft/.express/<剩余路径>`（**子目录可以有**）。
   *
   * 用户 2026-09-16 定的规矩（照做）：
   *   · **不用 token**（DSH 本身禁止公网访问；真要架公网，架的人自己加代理与鉴权）；
   *   · **目录即白名单**：只有 `.express/` 下的文件可访问，`.out/`（默认输出）不对外；
   *   · **所有扩展名都放行**（用户自己把握）；
   *   · 🔴 **必须防穿透**：段级校验（`.whale-craft` 那边已做）之后，这里再用
   *     `realpath` 复查一次"真实路径仍在发布区里" —— 这样**符号链接也跳不出去**。
   *   · 信任栅栏在路由入口处（非回环且不在 trustedHosts → 403）。
   *
   * 🔴 2026-09-17：地址里的"工作区指代"从**目录名**换成**工作区 uuid**（`workspaceRegistry` 的 id）。
   *    查不到对应工作区（或段不合法）→ 统一 404，不给探测依据。
   */
  const serveSharedFile = (req, res, hit) => {
    const notFound = (why) => {
      // 统一 404（不区分"没有这个工作区/没有这个文件/段不合法"）：不给人做探测的依据
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(`not found${why ? ` (${why})` : ''}`)
      return true
    }
    try {
      const cwd = workspaceCwdById(hit.workspaceId)
      if (!cwd) {
        logLine(`发布区：工作区注册表里没有 uuid=「${hit.workspaceId}」`)
        return notFound()
      }
      const root = expressRootOf(memoryRootFor(cwd))
      const target = safeExpressTarget(root, hit.segments)
      if (!target) return notFound()
      let real = null
      try { real = realpathSync(target) } catch { return notFound() }   // 不存在
      const rootReal = (() => { try { return realpathSync(root) } catch { return root } })()
      const prefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep
      if (real !== rootReal && !real.startsWith(prefix)) {              // 符号链接跳出去了
        logLine(`发布区：拒绝越界（符号链接）${real}`)
        return notFound()
      }
      let st = null
      try { st = statSync(real) } catch { return notFound() }
      if (!st.isFile()) return notFound()                                // 目录不列目录
      if (st.size > EXPRESS_MAX_BYTES) {
        res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`too large (${st.size} > ${EXPRESS_MAX_BYTES})`)
        return true
      }
      const type = mimeOf(real)
      const head = {
        'content-type': type,
        'content-length': st.size,
        'cache-control': 'private, max-age=300',
        'x-content-type-options': 'nosniff',
        // 会被当文档执行脚本的类型（svg/html/xml/js）→ 加 sandbox：内联 <img> 照常显示，导航过去跑不了脚本
        ...(SANDBOX_TYPES.test(type) ? { 'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'" } : {}),
      }
      res.writeHead(200, head)
      if (req.method === 'HEAD') { res.end(); return true }
      res.end(readFileSync(real))
      return true
    } catch (e) {
      logLine(`发布区服务失败：${e?.message ?? e}`)
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('internal error')
      return true
    }
  }

  const handleMcApi = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname

    // 🔴 2026-09-17：发布区**不再挂在 `/api/mc` 下**（旧地址 `/api/mc/whale-craft/<目录名>/…` 已停用）。
    //    新地址是 `/api/whale-craft/express/<工作区 uuid>/…`，由**自己的顶层前缀路由**服务（见 shareRoute）。

    if (req.method === 'GET' && path === '/api/mc/status') {
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const sess = registry.peek(sessionId)
      if (!sess) return sendJson(res, 200, { ok: true, active: false })
      // 🔴 active = **真在游戏里**（机器人在线 或 看门狗挂着），不是"这个会话碰过 mc_* 工具"。
      //    只要调过一次 mc_status 就会建 McSession；若按"存在即 active"，
      //    状态条会在所有用过的会话上永久显示"未上线"（用户要的是"只在真进游戏时显示"）。
      // 🔴 2026-09-19 补：**正在自动重连**时也要算 active —— 否则刚断线状态条就整个消失，
      //    用户看不到"断了、正在重连"，还以为插件把状态忘了。
      //    （用 reconnecting || reconnectPending：后者覆盖"正在尝试连接"那段，最长 45s）
      const active = Boolean(sess.bot.online)
        || Boolean(sess.bot.reconnecting || sess.bot.reconnectPending)
        || Boolean(sess.watchdog?.armed)
      if (!active) return sendJson(res, 200, { ok: true, active: false })
      return sendJson(res, 200, {
        ok: true, active: true, sessionId,
        ...sess.bot.status(), ...sess.modeView(),
        lastTimeout: sess.bot.lastTimeout ?? null,
        timeouts: sess.bot.stats?.timeouts ?? 0,
      })
    }

    if (req.method === 'GET' && path === '/api/mc/sessions') {
      return sendJson(res, 200, { ok: true, sessions: registry.listSessions() })
    }

    /* ── 「MC设置」入口的模式门控（2026-09-16；2026-09-18 调整）─────────────
     * 前端只该在 **MC 模式**的会话里显示设置入口（普通会话显示过按钮，出过事故）。
     * 这里给出**与 restrict/guard 完全同一个判据**（isMcModeAgent）的真值。
     *
     * 🔴 2026-09-18 用户要求改口径：**有没有选工作区，只要新对话选中了 MC 模式就显示按钮**；
     *    工作区改到**点按钮时**再检查，没有就提示用户先选。
     *    所以这里**不再**因为"没工作区"把 `mcMode` 压成 false（那正是前端藏入口的依据）——
     *    改成额外报 `hasWorkspace`，让前端自己决定是打开设置还是提示。
     *    注意：`applyMcModePolicy` 里"没工作区就不当 MC 会话"的**服务端行为没变**
     *    （不套工具白名单、不注入提示词、`.whale-craft` 也不建），变的只是**入口可见性**。
     * ──────────────────────────────────────────────────────────────────── */
    if (req.method === 'GET' && path === '/api/mc/mode') {
      const sessionId = url.searchParams.get('sessionId') ?? ''
      let mcMode = false
      let agent = null
      let reason = null
      let hasWorkspace = null
      if (sessionId) {
        try {
          agent = ctx.get('agents')?.get?.(sessionId) ?? null
          // 🔴 判据是 **preset**（与 restrict/guard 同一个 isMcModeAgent）——
          //    **不再**因为"没工作区"把它压成 false：那是前端藏入口的旧依据，
          //    而 2026-09-18 起入口一律显示、工作区改到点击时检查（另报 hasWorkspace）。
          mcMode = agent ? isMcModeAgent(agent) : mcModeAgentIds.has(sessionId)
        } catch {
          mcMode = mcModeAgentIds.has(sessionId)
        }
        if (agent) {
          hasWorkspace = Boolean(workspaceOf(agent))
          if (!hasWorkspace && mcMode) reason = 'no-workspace'
        } else if (noWorkspaceRefused.has(sessionId)) {
          reason = 'no-workspace'
          hasWorkspace = false
        }
      }
      // 诊断：把"判定依据"和"各段实际长度"一并报出来。
      // 2026-09-16 事故的教训：只回一个 false，谁都查不出是 preset 没认出来还是段没注册。
      let diag = null
      if (sessionId) {
        try {
          const cwd = workspaceOf(agent)
          const root = cwd ? memoryRootFor(cwd) : null
          const cur = root ? readAgentsMd(root) : { path: null, source: null, text: '' }
          const sent = sentNoticeRels(agent)
          diag = {
            reason,
            workspace: cwd,
            presetId: (agent && lastPresetSeen.get(agent)) ?? null,
            agentFound: Boolean(agent),
            serviceReady: Boolean(agentPresetsSvc) || (() => { try { return Boolean(ctx.get('agentPresets')) } catch { return false } })(),
            memoryRoot: root,
            agentsMd: { path: cur.path, exists: cur.path ? existsSync(cur.path) : false, source: cur.source, bytes: Buffer.byteLength(cur.text) },
            // **实际投出去的**插件提示行（不是"我们打算投"）：投递是唯一通道，这里就是判据
            notices: sent,
            segments: {
              'agents-md': sent.includes('.whale-craft/RULES.md') ? cur.text.length : 0,
              'workspace-agents-md': sent.includes('AGENTS.md') ? 1 : 0,
              'memory-index': sent.includes('.whale-craft/README.md') && root ? memoryIndexText(memoryFor(cwd)).length : 0,
            },
          }
        } catch (e) { diag = { reason, error: String(e.message) } }
      }
      return sendJson(res, 200, { ok: true, sessionId, mcMode, hasWorkspace, diag })
    }

    if (req.method === 'POST' && path === '/api/mc/stop') {
      const body = await readJsonBody(req)
      const sessionId = String(body.sessionId ?? '')
      if (!sessionId) return sendJson(res, 400, { ok: false, error: 'sessionId 必填' })
      // 用户 2026-09-16：**普通停止已移除**，这里只有强制停止一种语义
      // （顺序：停 LLM → 优雅退游戏 → 清该会话后台任务 → 再停一次 LLM）。
      // body.hard 不再有意义，传了也忽略（旧前端/旧脚本兼容）。
      const result = await stopSession(sessionId, {
        reason: body.reason ? String(body.reason) : '用户强制停止',
      })
      return sendJson(res, 200, { ok: true, ...result })
    }

    /* ── 「MC设置」模态框用的接口（门控名单 / 账户 / 认证服务器 / 白名单 / 提示词 / 文件分享）──
     * 🔴 2026-09-17 隔离实例实测抓到的**真 bug**：`/api/mc/presets` 一直没进这个分派名单
     *    （它只在 `handleSettingsApi` 里判过），于是真机上它一律 404 —— 前端只能靠
     *    `MC_PRESETS_FALLBACK` 兜底，名单一旦和默认值不同就悄悄失灵。谁再加接口，**记得也加这里**。 */
    if (path.startsWith('/api/mc/accounts') || path.startsWith('/api/mc/authservers')
      || path.startsWith('/api/mc/agents-md') || path === '/api/mc/config'
      || path === '/api/mc/express' || path === '/api/mc/presets') {
      try {
        return await handleSettingsApi(req, res, path, url)
      } catch (e) {
        const err = { ok: false, error: String(e?.message ?? e) }
        if (e?.needUserAction) { err.needUserAction = true; if (e.hint) err.hint = String(e.hint) }
        return sendJson(res, 200, err)
      }
    }

    return sendJson(res, 404, { ok: false, error: `unknown endpoint ${req.method} ${path}` })
  }

  const apiRoute = {
    kind: 'prefix',
    path: '/api/mc',
    handler: async (req, res) => {
      if (!isTrustedRequest(req.headers, liveTrustedHosts())) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('forbidden')
        return
      }
      try { await handleMcApi(req, res) } catch (e) {
        ctx.logger?.warn?.(`[whale_craft] /api/mc 处理失败：${e instanceof Error ? e.message : String(e)}`)
        sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    },
  }
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => scope.webServer.register(apiRoute), 'whale_craft: /api/mc 路由')
  })

  /**
   * 发布区服务路由（用户 2026-09-17 定稿）：`/api/whale-craft/express/<工作区 uuid>/<剩余路径>`。
   *
   * 为什么单独一条前缀路由而不是挂 `/api/mc` 下：
   *   · 用户要求地址**放在 `/api` 后面**、但不要混进 `/api/mc`（那是设置接口）；
   *   · webServer 是**最长前缀优先**（`packages/host/webserver/src/index.ts:317`），
   *     所以 `/api/whale-craft` 会赢过宿主自己在 `/api` 上的 RPC 前缀，跟注册顺序无关；
   *   · 信任栅栏得**自己再过一遍**（`/api/mc` 那道只管它自己），判据与用法完全一致。
   *
   * 🔴 只有「在线」模式才服务（关闭模式 404）：不留"以为关了其实还能访问"的口子。
   */
  const shareRoute = {
    kind: 'prefix',
    path: '/api/whale-craft',
    handler: async (req, res) => {
      if (!isTrustedRequest(req.headers, liveTrustedHosts())) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('forbidden')
        return
      }
      try {
        if (pluginConfig.expressMode !== 'online') {
          logLine('发布区：当前是「关闭」模式，不提供访问（/api/whale-craft/… 只在线模式下开）')
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
          res.end('not found (sharing disabled)')
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const hit = parseExpressPath(url.pathname)
        if (!hit || (req.method !== 'GET' && req.method !== 'HEAD')) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
          res.end('not found')
          return
        }
        serveSharedFile(req, res, hit)
      } catch (e) {
        ctx.logger?.warn?.(`[whale_craft] /api/whale-craft 处理失败：${e instanceof Error ? e.message : String(e)}`)
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('internal error')
      }
    },
  }
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => scope.webServer.register(shareRoute), 'whale_craft: /api/whale-craft 路由（发布区）')
  })

  // 启动自检标记：确认"插件到底加载了没"（同时写 whale-craft.log 与宿主日志）
  const startup = `插件已加载｜pid=${process.pid}｜每会话独立实例｜工具注册中…`
  logLine(startup)
  ctx.logger?.info?.(`[whale_craft] ${startup}`)

  /* ─────────── 「遗言」网：未处理拒绝会要了整个 Harness 的命，至少把原因留下来 ───────────
   * 背景（2026-09-17 真机）：宿主的 `installFailLoud`（`apps/cli/src/profile-boot.ts:311` →
   * `packages/boot/app-boot/src/index.ts:652`）把**任何**未处理拒绝当致命，打印
   * `dsh: fatal load failure` 然后 `exit(1)`。插件**无法否决**它的 exit（别的监听的
   * `process.exit` 拦不住），所以能做的只有两件：① 自己链路零悬空 + 把第三方已知的悬空点补掉
   * （见 core.mjs 的 yggdrasil 兼容层与 sessionFlags）；
   * ② 在进程被杀之前**把那条拒绝的栈写进我们的日志**，免得下次只能看到一句 fatal load failure。
   * ⚠️ 只记录，不吞：宿主该怎么处置还是怎么处置（我们不改变它的行为）。
   * ------------------------------------------------------------------------ */
  try {
    let logged = 0
    process.on('unhandledRejection', (reason) => {
      if (logged >= 5) return                    // 别刷爆日志
      logged++
      const stack = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
      logLine(`⚠️ 未处理拒绝（宿主可能会因此 exit(1)，栈如下，请据此定位）：${stack.split('\n').slice(0, 6).join(' ⏎ ')}`)
    })
  } catch (e) { logLine(`装未处理拒绝记录器失败（不影响使用）：${e?.message ?? e}`) }

  const text = (value, render) => ({
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (args, value2) => [{ type: 'text', text: render ? render(args, value2) : String(value2?.text ?? JSON.stringify(value2, null, 2)) }],
  })

  /**
   * 工具定义统一入口：
   *   ① 返回值无损化（宿主要求无损 JSON；mineflayer 到处返回 Vec3 类实例）
   *   ② 注入本轮 turn 的 exec.signal 给 bot —— 这是"停止按钮真的有效"的关键：
   *      宿主的 cancel 只是 abort 一个 signal（它无法抛弃同进程 pending 的 promise，
   *      见 packages/core/tools/src/index.ts:219 "cannot hard-kill same-process code"），
   *      所以必须由我们在每个 mineflayer await 上监听它，否则按停止要等本地超时（最长 25s）。
   */
  /**
   * MC 模式白名单里的**文件工具**（宿主 tool-fs / tool-fs-search 注册的名字）。
   *
   * 🔴 用户 2026-09-16："读写文件都只能在记忆文件夹内！" —— 这几个工具留在可见面上
   *    （看地图、写 SVG、读回自己存的图都要用），但路径由 guard 硬限在 `<工作区>/.whale-craft/`。
   */
  const MC_FILE_TOOLS = ['read', 'write', 'edit', 'glob', 'grep', 'read_image']

  /**
   * MC 模式白名单里的**交付工具**：`present`（宿主 `@deepseek-ai/dsh-tool-present`）。
   *
   * 🔴 用户 2026-09-16 定的：删掉 `mc_kit_share`（它其实是在调宿主另装的 dsh-file-host，插件本身
   *    没有文件服务器），改用 DSH 自带的交付机制 —— `present` 会往会话里写 `deliverables/presented`，
   *    Web 端 `ui-deliverables` 在该轮末尾渲染**产出文件卡片**（可预览、可打开），正文里写成行内代码的
   *    文件名也会变成可点链接。也就是说："让本地用户看到文件"这件事，宿主本来就提供。
   *    它按 preset 挂载（随附 Web 的 standard/ptc/cordis 有，minimal 没有）—— 我们负责
   *    ①把 `tool-present` 组补进 MC 模式的 preset ②把它放进白名单。
   * 交付路径由 guard 限在**本会话工作区**内（`.whale-craft/` 与 `out/` 都在里面）。
   */
  const MC_PRESENT_TOOL = 'present'

  /**
   * 从一次工具调用里取"要碰的路径"：是文件工具才返回（不是 → null；是但没给路径 → 空串）。
   * 路径参数名按宿主用 `path`，也兼容 harness 的 `file_path`；glob/grep 的目录参数同样是 `path`。
   */
  const fileToolPath = (exec) => {
    const name = String(exec?.name ?? '')
    if (!/^(read|write|edit|glob|grep|read_image)$/i.test(name)) return null
    const args = exec?.arguments ?? {}
    const v = args.path ?? args.file_path ?? args.dir ?? args.directory
    if (v === undefined || v === null) return ''
    return String(v)
  }

  /** `present` 那次调用里要交付的文件路径列表（不是 present → null） */
  const presentPaths = (exec) => {
    if (String(exec?.name ?? '') !== MC_PRESENT_TOOL) return null
    const files = exec?.arguments?.files
    if (!Array.isArray(files)) return []
    return files.map((f) => String(f?.path ?? '')).filter(Boolean)
  }

  /** 我们自己注册的工具名（MC 模式做工具白名单时要带上它们，否则会被 restrict 一并滤掉） */
  const ourToolNames = []

  const asTool = (spec) => {
    if (spec?.name && !ourToolNames.includes(spec.name)) ourToolNames.push(spec.name)
    return defineTool({
      ...spec,
      async execute(args, exec) {
        const sess = getSession(exec)
        sess.bot.setAbortSignal(exec?.signal)
        return lossless(await spec.execute(args, exec))
      },
    })
  }

  /** 从 exec 里拿 agentId，再拿到当前会话的 McSession */
  const getSession = (exec) => {
    const agent = exec?.agent
    if (!agent) throw new Error('拿不到当前会话（exec.agent 不可用）')
    return registry.getOrCreate(agent.id)
  }

  /* ── 状态与开关 ── */

  ctx.tools.register(asTool({
    name: 'mc_status',
    description: '看我在 Minecraft 里的状态：是否在线、子服、坐标、血量、模式、连接信息、待处理事件数、看门狗状态。',
    parameters: {},
    output: text(),
    async execute(args, exec) {
      const sess = getSession(exec)
      const s = sess.bot.status()
      return { ...s, ...sess.modeView(), recentChat: sess.bot.recentChat(5) }
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_lan',
    description: '探测**局域网里的 Minecraft 服务器**（只读：不连接、不进服）。\n'
      + '原理就是**原版那一件事**：谁是"对局域网开放"的，谁就会往多播 `224.0.2.60:4445` 上周期性发\n'
      + '`[MOTD]…[/MOTD][AD]端口[/AD]`（重发周期 1.5 秒）。**只听这个公告**，听到就拿到对方地址+端口+MOTD；\n'
      + '🔴 不扫端口、不发任何探测包（原版客户端也不扫），所以**恒定在 `seconds` 秒内返回**（默认 3，上限 15）。\n'
      + '拿到 host/port 后用 `mc_connect` 进服（版本 / 人数那些进服后自然知道）。\n'
      + '没听到时：确认对方真的开了"对局域网开放"（或服务端开了 `enable-lan-visibility`）；\n'
      + '有些网络（部分 WiFi / VPN / 容器）会挡多播，那种情况原版客户端自己也看不到——请直接问对方地址。',
    parameters: {
      mode:    { type: 'string', description: '探测模式。目前只有 `broadcast`（默认）：听局域网公告' },
      seconds: { type: 'number', description: '听多久（默认 3 秒，上限 15）' },
    },
    output: text(),
    async execute(args, exec) {
      // 只有广播这一条路：不扫端口、不连服。恒定在 seconds 秒内返回。
      const seconds = Math.max(1, Math.min(Number(args.seconds) || 3, 15))
      const broadcast = await listenLanBroadcast({ seconds })
      return {
        ok: true,
        mode: 'broadcast',
        seconds,
        count: broadcast.length,
        found: broadcast.slice(0, 20),
        ...(broadcast.length ? {} : { hint: '没听到公告。确认对方已经"对局域网开放"（或服务端开了 enable-lan-visibility）；有些网络（部分 WiFi / VPN / 容器）会挡多播，那种情况原版客户端自己也看不到——直接问对方地址即可。' }),
      }
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_ping',
    description: '【单地址探测】**已知地址**时，先问一句"你是谁、通不通"——发一次 Minecraft STATUS ping：\n'
      + '拿 **通不通**（能不能拿到状态响应）/ **版本** / **协议号** / **MOTD** / **人数** / **延迟**。\n'
      + '🔴 **不登录、不用账户、不进服**，拿到就断；超时由自己兜（默认 5 秒，上限 30 秒），**不会挂住**。\n'
      + '和 `mc_connect` 的分工：先用 `mc_ping` 确认地址与版本（**推荐**），再 `mc_connect` 真进服；\n'
      + '连不上时它会把原因说成人话（ECONNREFUSED=端口没人听 / ENOTFOUND=域名拼错 / 超时=防火墙或 enable-status=false）。\n'
      + '和 `mc_lan` 的分工：`mc_lan` 是"不知道地址"时听局域网公告；`mc_ping` 是"知道地址"时主动探一次。',
    parameters: {
      address:   { type: 'string', description: '地址，认 `example.com` / `example.com:25566` / `[::1]:25565`（必填）' },
      port:      { type: 'number', description: '端口（默认 25565）；address 里已经带 `:端口` 时以 address 为准' },
      timeoutMs: { type: 'number', description: '超时（默认 5000，上限 30000）——超时就是这个工具的硬顶，不会更久' },
      subserver: { type: 'string', description: '（可选）Velocity 之类的子服域名：握手里的 serverHost 用它路由到子服，如 mc.example.com' },
    },
    output: text(),
    async execute(args) {
      const { host, port } = parseAddress(args.address, Number(args.port) || 25565)
      const timeoutMs = Number(args.timeoutMs) || 5000
      const r = await statusPing({ host, port, timeoutMs, fakeHost: args.subserver ? String(args.subserver) : '' })
      // 通了但版本表里没有对应话术的情况也用得上：把"能不能连"与"连上会怎样"分开说
      return r
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_connect',
    description: '连接到 MC 服务器。**这里没有账号密码**——用哪个账户由「MC设置」里维护的账户决定：\n'
      + '先用 `mc_accounts` 看有哪些账户（用 `action:"use"` 选定，或用本工具的 `account` 参数指名 innerID）。\n'
      + '服务器地址/端口/子服由你传（不传就用插件配置里的 fallback）；连接成功后会等区块加载完成。\n'
      + '登录失败时会明确说"需要用户处理"——那就告诉用户去「MC设置」里重新登录或点「刷新」。',
    parameters: {
      host:      { type: 'string', description: '服务器地址（如 example.com）' },
      port:      { type: 'number', description: '端口（默认 25565）' },
      subserver: { type: 'string', description: '子服域名（Velocity fakeHost 路由，如 mc.example.com）' },
      account:   { type: 'string', description: '（可选）用哪个账户：innerID（mc_accounts 里能看到）；不传就用本会话选定的/默认账户' },
      version:   { type: 'string', description: 'MC 版本（如 1.20.4 / 26.2）。**默认不传 = 自动探测**（发 STATUS ping 按服务端上报的协议号反查），这是推荐用法；只有探测失败时才手填。' },
    },
    output: text(),
    async execute(args, exec) {
      const sess = getSession(exec)
      const innerID = args.account ? String(args.account) : (sess.selectedAccount ?? null)
      const resolved = await resolveAuth(innerID)
      sess.selectedAccount = resolved.innerID

      const opts = { auth: resolved.auth }
      if (args.host)      opts.host      = String(args.host)
      if (args.port)      opts.port      = Number(args.port)
      if (args.subserver) opts.subserver = String(args.subserver)
      if (args.version)   opts.version   = String(args.version)
      // 登录成功后把（皮肤站的）档案信息与新令牌回写；回调只活在插件层，不进工具返回值
      // ⚠️ 回写是"顺带"的事：失败只能记日志，**绝不能**变成未处理拒绝（那会 exit(1)）
      opts.onAuth = ({ profile, session }) => {
        Promise.resolve()
          .then(() => persistAuth(resolved, profile, session))
          .catch((e) => logLine(`登录后回写账户信息失败（不影响本次进服）：${e?.message ?? e}`))
      }

      try {
        await sess.bot.connect(opts)
      } catch (e) {
        throw withUserHint(e, resolved.label)
      }
      sess.mode = 'active'
      const ready = await sess.bot.waitForChunks()
      // 进服自动挂看门狗（用户要求：进游戏自动打开）
      const wd = ensureWatchdog(ctx, sess, exec?.agent, promptAbort.signal, watchdogGate(sess))
      // 把自己的游戏名学进叫法（默认叫法里**没有**私人名字 —— 见 learnName 的注释）
      try { wd.learnName(sess.bot?.bot?.username) } catch { /* 拿不到就算了 */ }
      if (wd.config.autoArm && !wd.armed) {
        try { wd.arm() } catch (e) { ctx.logger?.warn?.(`[whale_craft] 看门狗自动挂载失败：${e.message}`) }
      }
      return {
        connected: true,
        account: accounts.view(accounts.get(resolved.innerID)),
        ...sess.bot.status(), chunksReady: ready,
        // 连接信息（host/port/子服）已在 status() 里；这里**不再**回带
        // `_connectionProfile`（那份含 authMode 与账号名，没必要发出去）。
        watchdog: wd.status().armed ? '已自动挂载' : '未挂载（autoArm 关闭）',
      }
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_accounts',
    description: '【账户】列出 / 搜索 / 刷新 / 选定 MC 账户。**永远拿不到密码或 token**——只有基本信息。\n'
      + 'action：\n'
      + '· list（默认）列出所有账户：innerID / ID / 游戏名 / UUID / 类型（离线或皮肤站）/ 服务器名与地址 / 是否已存凭据\n'
      + '· search  按指令搜（名字、UUID、服务器名、登录账号都行）：给 query\n'
      + '· use     选定本会话要用的账户：给 innerID（之后 mc_connect 就用它）\n'
      + '· refresh 刷新某个账户的登录状态（皮肤站会去认证服换新令牌）：innerID 不传就用当前选定/默认的\n'
      + '⚠️ 刷新或登录失败时会带 needUserAction——**这时候要明确告诉用户**：请到「MC设置」里重新登录该账户，'
      + '或点它的「刷新」按钮（密码只有用户能填，你拿不到）。',
    parameters: {
      action:  { type: 'string', description: 'list（默认）/ search / use / refresh' },
      innerID: { type: 'string', description: '账户内部 id（list 里能看到，形如 acc-xxxxxxxx）' },
      query:   { type: 'string', description: 'search 的关键词' },
    },
    output: text(),
    async execute(args, exec) {
      const action = String(args.action ?? 'list').toLowerCase()
      const sess = getSession(exec)

      if (action === 'list') {
        return {
          accounts: accounts.list(),
          authServers: accounts.listAuthServers(),
          credentialsReady: accounts.credentialsReady,
          selected: sess.selectedAccount ?? accounts.resolve()?.innerID ?? null,
        }
      }
      if (action === 'search') return accounts.search(args.query)

      if (action === 'use') {
        const id = String(args.innerID ?? '').trim()
        if (!id) throw new Error('use 要给 innerID（先 action:"list" 看看有哪些账户）')
        const acc = accounts.get(id)
        if (!acc) throw new Error(`没有这个账户：${id}`)
        sess.selectedAccount = id
        return {
          selected: accounts.view(acc),
          note: '本会话之后 mc_connect 就用这个账户（要进服请再调 mc_connect）',
        }
      }

      if (action === 'refresh') {
        const innerID = args.innerID ? String(args.innerID) : (sess.selectedAccount ?? accounts.resolve()?.innerID ?? null)
        const resolved = await resolveAuth(innerID)
        if (resolved.auth.mode === 'offline') {
          return {
            refreshed: resolved.innerID, type: 'offline',
            account: accounts.view(accounts.get(resolved.innerID)),
            note: '离线账户不需要认证；UUID 按名字派生（想固定就在「MC设置」里给它设自定义 UUID）',
          }
        }
        let captured = null
        let out
        try {
          out = await sess.bot.authOnly(resolved.auth, { onSession: (s) => { captured = s } })
        } catch (e) {
          throw withUserHint(e, resolved.label)
        }
        if (captured) await persistAuth(resolved, captured.selectedProfile, captured)
        return {
          refreshed: resolved.innerID, type: 'yggdrasil', auth: out,
          account: accounts.view(accounts.get(resolved.innerID)),
        }
      }

      throw new Error(`未知 action："${action}"（可用 list/search/use/refresh）`)
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_stop',
    description: '停止本会话的 Minecraft：**先尝试优雅退出游戏，再清空本会话全部后台任务（看门狗在里面）**。\n'
      + '⚠️ 它**不会中断你自己当前这一轮**（你正跑在这轮里，自我 abort 会表现为 "tool call aborted"）。'
      + '所以它适合"我不想玩了，下线"——想停掉自己正在跑的动作，直接别再调工具就行。\n'
      + '页面上标题旁只剩一个「强制停止」按钮，它比这个工具更狠：**先停 LLM → 再优雅退游戏 → '
      + '再清后台任务 → 最后再停一次 LLM**（那是给人按的）。',
    parameters: {
      reason: { type: 'string', description: '原因（写进日志）' },
    },
    output: text(),
    async execute(args, exec) {
      const sessionId = exec?.agent?.id
      if (!sessionId) throw new Error('拿不到当前会话')
      // cancelTurn:false —— 工具就跑在被停的这一轮里，绝不能让 stop 把这一轮 abort 掉
      return stopSession(sessionId, {
        reason: args.reason ? String(args.reason) : 'AI 主动下线',
        cancelTurn: false,
      })
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_disconnect',
    description: '从 MC 下线（当前会话的机器人退出游戏）。不影响其他会话的机器人。看门狗会自动关闭并提醒你。',
    parameters: { reason: { type: 'string' } },
    output: text(),
    async execute(args, exec) {
      const sess = getSession(exec)
      const why = args.reason ? String(args.reason) : 'agent 主动下线'
      // 退服自动关看门狗 + 提醒（用户要求：退出游戏会提醒 AI）
      let watchOff = null
      if (sess.watchdog) { try { watchOff = sess.watchdog.disarm(`下线：${why}`, { notify: true }) } catch {} }
      const quit = await sess.bot.disconnect(why)      // 优雅优先，走不掉才强断
      sess.mode = 'standby'
      return { online: false, quit, watchdog: watchOff ? '已关闭并已提醒' : '本来就没挂' }
    },
  }))

  /* ── 说话与事件 ── */

  ctx.tools.register(asTool({
    name: 'mc_say',
    description: '在 MC 公屏说话（游戏里所有玩家能看到）。',
    parameters: { message: { type: 'string', required: true, description: '要说的话（单行，会被截断到 220 字）' } },
    output: text(),
    async execute(args, exec) {
      const sess = getSession(exec)
      return { sent: sess.bot.chatSay(String(args.message)) }
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_watch',
    description: '看门狗控制（**唯一**的事件通知通道）。看门狗在**进服时自动挂载、退服时自动卸载**，'
      + '整局游戏期间持续运行：记录所有事件，命中唤醒条件就在**同一个对话里**提醒你——'
      + '你空闲时开新一轮；你正在跑时在下一步插话（不打断）。'
      + 'action="status"（默认）看状态与配置；"arm" 手动挂载；"disarm" 关闭；"log" 看最近事件留档。'
      + '唤醒条件/近距半径/心跳/观察窗口等一律用 mc_config 调（有默认值）。',
    parameters: {
      action: { type: 'string', description: 'status（默认）/ arm / disarm / log' },
      reason: { type: 'string', description: 'disarm 时的原因（会写进日志）' },
    },
    output: text(),
    async execute(args, exec) {
      const sess = getSession(exec)
      const agent = exec?.agent
      if (!agent) throw new Error('拿不到当前会话（exec.agent 不可用），看门狗必须绑定会话')
      const wd = ensureWatchdog(ctx, sess, agent, promptAbort.signal, watchdogGate(sess))
      const action = String(args.action ?? 'status')
      if (action === 'arm') return { ...wd.arm(), note: '看门狗已挂载，整局游戏期间有效（退服自动卸载并提醒你）。' }
      if (action === 'disarm') return wd.disarm(args.reason ? String(args.reason) : 'AI 主动关闭')
      if (action === 'log') return { armed: wd.armed, stats: { ...wd.stats }, recent: wd.log.slice(-30) }
      return wd.status()
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_config',
    description: '读写本会话的 MC 配置（看门狗唤醒条件、近距半径、心跳间隔、观察窗口、叫法等）。'
      + '不传参数 = 看当前配置 + 默认值。改配置传 patch；嵌套项用点号键，'
      + '如 {"wakeOn.itemPickup":true,"nearRadius":24,"mentionPatterns":["ds","用户"]}。'
      + '叫法是**配置不是硬编码**——学到玩家的新称呼就加进 mentionPatterns。',
    parameters: {
      patch: { type: 'object', additionalProperties: true, description: '要改的配置项（浅合并）；不传=只读' },
      reset: { type: 'boolean', description: 'true=恢复默认配置' },
    },
    output: text(),
    async execute(args, exec) {
      const sess = getSession(exec)
      const wd = ensureWatchdog(ctx, sess, exec?.agent, promptAbort.signal, watchdogGate(sess))
      const clone = (v) => JSON.parse(JSON.stringify(v))
      if (args.reset) {
        wd.config = clone(WATCH_DEFAULTS)
        return { reset: true, config: wd.config }
      }
      // 把 "wakeOn.itemPickup": true 这种点号键拆成嵌套补丁
      const patch = {}
      for (const [k, v] of Object.entries(args.patch ?? {})) {
        const dot = k.indexOf('.')
        if (dot > 0) {
          const head = k.slice(0, dot)
          patch[head] = { ...(patch[head] ?? {}), [k.slice(dot + 1)]: v }
        } else patch[k] = v
      }
      if (Object.keys(patch).length) wd.updateConfig(patch)
      return { config: wd.config, defaults: clone(WATCH_DEFAULTS) }
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_capabilities',
    description: '【边界信息】这个插件能做什么、边界在哪：**支持的 MC 版本范围**（testedVersions）、底层 mineflayer 版本、'
      + '支持的登录方式、工具命名空间、各种上限（序列步数/记忆大小/事件队列）以及当前配置要点。\n'
      + '**进服前不确定版本能不能连时先看它**；确实不支持就如实告诉 Master，别硬试。',
    parameters: {},
    output: text(),
    async execute(args, exec) {
      const lib = libraryInfo()
      return {
        plugin: { name: 'whale_craft', version: PLUGIN_VERSION, dir: fileURLToPath(new URL('.', import.meta.url)) },
        game: {
          testedVersions: lib.testedVersions,
          oldest: lib.oldest,
          latest: lib.latest,
          mineflayer: lib.mineflayer,
          dataVersions: lib.dataVersions,
          note: 'testedVersions = "实测可用"清单（也是上界拒绝的依据）。不在这份清单里的版本**可能**仍能连'
            + '（协议数据更全），但属于未验证；连不上就如实反馈，别反复硬试。',
        },
        auth: {
          modes: ['offline（离线账户）', 'yggdrasil（皮肤站/外置登录）'],
          notSupported: ['microsoft（Mojang 官方正版登录）—— 暂不支持'],
          note: '凭据只存本机 DSH 凭据库；AI 只能看到账户基本信息（innerID/ID/名字/UUID/服务器），看不到密码或 token。',
        },
        tools: {
          namespaces: { mc_: '游戏内', mc_kit_: '游戏外辅助（记忆/画图/交付）', mc_admin_: '管理（MC 模式看不见也调不动）' },
          count: ourToolNames.length,
          names: [...ourToolNames],
        },
        limits: {
          sequence: { steps: 64, budgetMs: 600_000 },
          memory: { textBytes: 256 * 1024, blobBytes: 16 * 1024 * 1024, files: 2000, depth: 5 },
          eventsQueued: 200,
          timeoutsMs: { lookAt: 4000, equip: 6000, dig: 25000, place: 6000, flyTo: 30000 },
        },
        config: {
          file: pluginConfig.file,
          keys: Object.keys(DEFAULT_CONFIG),
          commandWhitelist: pluginConfig.get('commandWhitelist'),
          allowAllCommands: pluginConfig.get('allowAllCommands'),
          memoryDir: memoryFor(workspaceOf(exec?.agent)).root,
          mcModePresets: pluginConfig.mcModePresets,
        },
        prompt: {
          agentsMd: agentsMdPath(memoryFor(workspaceOf(exec?.agent)).root),
          injectWhaleCraftAgentsMd: pluginConfig.get('injectWhaleCraftAgentsMd'),
          injectWorkspaceAgentsMd: pluginConfig.get('injectWorkspaceAgentsMd'),
        },
      }
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_sessions',
    description: '列出当前所有活跃的 MC 会话实例（诊断用：确认各会话的 bot 状态、连接信息）。',
    parameters: {},
    output: text(),
    async execute() {
      return {
        note: '每会话独立实例；事件只经 mc_watch 回各自会话。',
        sessions: registry.listSessions(),
      }
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_events',
    description: '读取/消费当前会话的 MC 事件队列（**看门狗记下来的**：聊天、系统消息、受伤、上线/死亡/重连/断线）。'
      + '默认消费掉；`peek=true` 只看不清。\n'
      + '⚠️ **被传送 / 捡物 / 其他玩家上下线不在这里**（那些只在看门狗的留档里，用 `mc_watch {action:"log"}` 看）。\n'
      + '⚠️ `waitSec` 是**兜底**，别用它长时间空等：有人叫你（mention）/ 受击 / 死亡 / 断线时，'
      + '**看门狗会主动叫醒你**，而且**会打断这个等待**（返回里 `interrupted:true` 就是在告诉你"有人找你了，'
      + '唤醒内容马上会作为提示注入进来"）。真需要盯着某一类事件时才给 waitSec（建议 ≤30）。',
    parameters: {
      limit: { type: 'number', description: '最多取几条（默认 20）' },
      kind: { type: 'string', description: '只看某类：chat / system / damage / lifecycle' },
      peek: { type: 'boolean', description: 'true=只看不消费' },
      waitSec: { type: 'number', description: '先等最多几秒（默认 0=不等，上限 120）。⚠️ 会被看门狗唤醒打断，别长等' },
    },
    output: text(),
    timeoutMs: 130_000,
    async execute(args, exec) {
      const sess = getSession(exec)
      const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 100)
      const kind = args.kind ? String(args.kind) : null

      // 可选阻塞等待（吸收原 mc_wait）。⚠️ 等待逻辑在 src/wait.mjs：**看门狗唤醒会打断它**
      //    —— 否则 steer 注入要等这个工具跑完（2026-09-19 真机：用户空等特别久）。
      const waitSec = Math.min(Math.max(Number(args.waitSec ?? 0), 0), 120)
      let waitedMs = 0
      let interrupted = false
      let interruptReason = null
      if (waitSec > 0) {
        const r = await waitForEvents({
          sess, from: sess.events.length, kind, waitSec, signal: exec?.signal ?? null,
        })
        waitedMs = r.waitedMs
        interrupted = r.interrupted
        interruptReason = r.reason
      }

      const list = args.peek
        ? sess.events.filter((e) => !kind || e.kind === kind).slice(-limit)
        : sess.drainEvents(limit, kind)
      return {
        waitedMs, count: list.length, events: list,
        ...(interrupted
          ? {
              interrupted: true,
              interruptReason,
              hint: '等待被打断：看门狗命中唤醒条件（有人叫你 / 受击 / 死亡 / 断线…），'
                + '唤醒内容马上会作为提示注入——**先别急着再 wait**，等那条提示进来（或直接看上面的 events）。',
            }
          : {}),
      }
    },
  }))

  /* ── 世界读取 ── */

  ctx.tools.register(asTool({
    name: 'mc_scan',
    description: '扫描我周围方块：给 name 就找这种方块的位置；不给就返回方块统计。',
    parameters: {
      radius: { type: 'number', description: '水平半径（默认 8，上限 24）' },
      height: { type: 'number', description: '垂直范围 ±（默认 4，上限 16）' },
      name: { type: 'string', description: '可选：只找这种方块（如 oak_log）' },
      limit: { type: 'number', description: 'name 模式下最多返回几个（默认 10）' },
    },
    output: text(),
    async execute(args, exec) {
      const sess = getSession(exec)
      await sess.bot.waitForChunks()
      return sess.bot.scan({
        radius: args.radius, height: args.height,
        name: args.name ? String(args.name) : null,
        limit: args.limit,
      })
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_map',
    description: '看周围地形。format="chars"（默认）返回**字符地形图**（无视觉也能读：'
      + '@ 是我 · ~ 水 · . 沙 · " 草木 · T 木构 · : 石/建筑 · _ 土/农田 · # 白 · ? 未加载）；'
      + 'format="image" 额外生成**俯视图像**（模型有视觉时直接能看，并落盘到工作区）。'
      + `🔴 要让 **Master** 看到图：给 \`out:"\\.whale-craft/${EXPRESS_DIR}/<子目录>/map.png"\` 写进发布区，`
      + '再用 `mc_kit_express` 取那一行（按「文件分享」模式返回路径 / URL / 或一句提示），自己拼进回复。'
      + 'format="both" 两者都给。字符图省 token 且坐标精确；形状/外观问题用图像。',
    parameters: {
      radius: { type: 'number', description: '半径（默认 32，上限 96）' },
      glyphStep: { type: 'number', description: '字符图抽稀步长（默认 2；1 最细）' },
      yTop: { type: 'number', description: '地表搜索起始高度偏移（默认 +10）' },
      yBottom: { type: 'number', description: '向下搜索深度（默认 -24）' },
      format: { type: 'string', description: 'chars（默认）/ image / both' },
      scale: { type: 'number', description: '图像每格放大倍数（默认 4，1–16）' },
      out: { type: 'string', description: `落盘路径（工作区相对；默认 .whale-craft/${OUT_DIR}/mc-map-<时间>.png 不对外）。`
        + `想让 Master 看到就写到 .whale-craft/${EXPRESS_DIR}/<子目录>/x.png（发布区），再用 mc_kit_express 取那一行` },
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (args, value) => {
        const blocks = [{ type: 'text', text: String(value?.text ?? JSON.stringify(value, null, 2)) }]
        // 图像以附件形式内联；纯文本模型由宿主自动降级成文本占位
        if (value?.image?.attachment) blocks.push({ type: 'image', attachment: value.image.attachment })
        return blocks
      },
    },
    timeoutMs: 60_000,
    async execute(args, exec) {
      const sess = getSession(exec)
      await sess.bot.waitForChunks()
      const format = String(args.format ?? 'chars').toLowerCase()
      const step = Math.max(1, Number(args.glyphStep ?? 2))
      const hm = sess.bot.heightmap({ radius: args.radius, yTop: args.yTop, yBottom: args.yBottom })

      const out = {
        center: hm.center, radius: hm.radius, unloadedTiles: hm.unloaded,
        legend: hm.legend.slice(0, 15),
        format,
      }
      if (format === 'chars' || format === 'both') {
        out.glyphMap = McBot.glyphMap(hm.names, step, { x: hm.radius, y: hm.radius })
      }
      if (format === 'image' || format === 'both') {
        const img = sess.bot.mapImage({
          radius: args.radius, yTop: args.yTop, yBottom: args.yBottom, scale: args.scale,
        })
        const png = encodePng(img.width, img.height, img.rgba)
        out.image = { width: img.width, height: img.height, bytes: png.length, scale: img.scale }

        // ① 内联给模型/前端看
        const att = ctx.get('attachments')
        if (att && typeof att.saveImage === 'function') {
          try {
            out.image.attachment = await att.saveImage({
              data: new Uint8Array(png), mediaType: 'image/png', name: 'mc-map.png',
            })
          } catch (e) { out.image.attachmentError = e.message }
        } else {
          out.image.attachmentError = '宿主没有 attachments 服务'
        }
        // ② 顺手落盘：默认 **`.whale-craft/.out/`**（不对外）。给了 `out`（例如
        //    `.whale-craft/.express/world1/map.png`）就写那儿 —— 落在发布区时结果里会带上
        //    现成的 `express.url` 与 `express.markdown`（`![](url)`），原样粘进回复 Master 就能看到。
        try {
          const { writeFileSync, mkdirSync } = await import('node:fs')
          const wsRoot = workspaceRootFor(exec?.agent)
          const rel = args.out
            ? String(args.out)
            : `.whale-craft/${OUT_DIR}/mc-map-${Date.now()}.png`
          const file = resolve(wsRoot, rel)
          mkdirSync(dirname(file), { recursive: true })
          writeFileSync(file, png)
          out.image.file = rel
          out.image.hint = `要让用户看到这张图：把它写到发布区（out:".whale-craft/${EXPRESS_DIR}/<子目录>/x.png"），`
            + '再用 mc_kit_express 取"给用户的那一行"（按「文件分享」模式返回路径/URL/或一句提示）。'
            + '默认输出（.out/）不对外。'
        } catch (e) { out.image.fileError = e.message }
      }
      return out
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_entities',
    description: '附近有哪些实体（玩家/生物/掉落物）及距离。',
    parameters: { radius: { type: 'number', description: '半径（默认 24）' } },
    output: text(),
    async execute(args, exec) {
      const sess = getSession(exec)
      await sess.bot.waitForChunks()
      return { entities: sess.bot.entities(Number(args.radius ?? 24)) }
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_inventory',
    description: '看背包、手持物品和身上穿着的装备（wearing 是头/胸/腿/脚/副手）。',
    parameters: {},
    output: text(),
    async execute(args, exec) {
      const sess = getSession(exec)
      return sess.bot.inventory()
    },
  }))

  /* ── 行动 ── */

  ctx.tools.register(asTool({
    name: 'mc_move',
    description: '移动。mode="walk" 走过去（自动避障/游泳）；mode="fly" 创造模式直飞（最稳，创造模式默认用它）；'
      + 'mode="jump" 原地跳一下（爬台阶/脱困，不需要坐标）。',
    parameters: {
      x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' },
      mode: { type: 'string', description: 'walk / fly / jump（创造模式缺省 fly；jump 不需要坐标）' },
      budgetMs: { type: 'number', description: 'walk 的最长时间（默认 40000，上限 90000）' },
    },
    output: text(),
    timeoutMs: 120_000,
    async execute(args, exec) {
      const sess = getSession(exec)
      const mode = String(args.mode ?? '')
      if (mode === 'jump') return sess.bot.jump()
      if (args.x === undefined || args.y === undefined || args.z === undefined) {
        throw new Error('walk/fly 需要 x/y/z；只想跳一下请给 mode:"jump"')
      }
      const target = { x: Number(args.x), y: Number(args.y), z: Number(args.z) }
      const creative = sess.bot.bot?.game?.gameMode === 'creative'
      const use = mode || (creative ? 'fly' : 'walk')
      if (use === 'fly') return sess.bot.flyTo(target.x, target.y, target.z)
      if (use !== 'walk') throw new Error(`未知 mode："${use}"（可用 walk / fly / jump）`)
      return sess.bot.walkTo(target, { budget: Math.min(Number(args.budgetMs ?? 40_000), 90_000) })
    },
  }))

  /* ── 行动：看向/走近/放置/破坏/使用/攻击/装备/丢弃（统一入口）── */

  ctx.tools.register(asTool({
    name: 'mc_act',
    description: '与游戏世界互动（**优先用这个，而不是服务器指令**）。mode：\n'
      + '· look   看向坐标(x,y,z)或玩家(who)——"看向我"就是 look + who\n'
      + '· toward 看向并走近某个玩家(who)\n'
      + '· place  把背包方块放到 (x,y,z)；悬空时会先垫脚搭上去（=搭高）\n'
      + '· break  破坏 (x,y,z) 的方块\n'
      + '· use    使用/激活方块(x,y,z)或实体(who)：开门、按按钮、拉杆、喂动物；给了 name 会先把它拿到手上再用（骨粉/锄头/打火石/水桶）\n'
      + '· useItem 用**手上的物品**（对着空气）：吃东西、喝药水、倒水、点火、拉弓、丢珍珠；name 可先装备，holdMs 控制按住多久\n'
      + '· attack 攻击 4.5 格内的实体（可给 who 指定名字）；**要追着打就换 mc_hunt**（自动寻路追上+连续打+自动挖/垫脚）\n'
      + '· equip  装备物品(name)；dest 指定槽位 hand/off-hand/head/torso/legs/feet，**不给就按物品自动判槽**（盔甲会穿到对应部位）\n'
      + '· wear   一键穿上背包里最好的全套盔甲（头/胸/腿/脚）\n'
      + '· toss   丢弃物品(name, count)',
    parameters: {
      mode: { type: 'string', description: 'look / toward / place / break / use / useItem / attack / equip / wear / toss' },
      who: { type: 'string', description: '玩家或实体名（look/toward/use/attack 用）' },
      x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' },
      name: { type: 'string', description: '方块或物品名（place/use/useItem/equip/toss 用）' },
      dest: { type: 'string', description: 'equip 的槽位：hand / off-hand / head / torso / legs / feet（不给=自动判槽）' },
      holdMs: { type: 'number', description: 'useItem 按住多久（毫秒；不给就按物品估，食物 1600、药水 1800、弓 1200）' },
      count: { type: 'number', description: 'toss 丢几个（默认 1）' },
      approach: { type: 'boolean', description: 'toward 是否走近（默认 true）' },
      budgetMs: { type: 'number' },
    },
    output: text(),
    timeoutMs: 120_000,
    async execute(args, exec) {
      const sess = getSession(exec)
      const bot = sess.bot
      const mode = String(args.mode ?? 'look')
      switch (mode) {
        case 'look':    return { mode, ...(await bot.lookAt(args)) }
        case 'toward':  return { mode, ...(await bot.interact(args)) }
        case 'place':   return { mode, ...(await bot.placeBlock(args)) }
        case 'break':   return { mode, ...(await bot.breakBlock(args)) }
        case 'use':     return { mode, ...(await bot.useBlock(args)) }
        case 'useItem': return { mode, ...(await bot.useItem({ name: args.name, holdMs: args.holdMs })) }
        case 'attack':  return { mode, ...(await bot.attack(args)) }
        case 'equip':   return { mode, ...(await bot.equip({ name: args.name, destination: args.dest ?? null })) }
        case 'wear':    return { mode, ...(await bot.equipArmor({})) }
        case 'toss':    return { mode, ...(await bot.tossItem({ name: args.name, count: args.count })) }
        default: throw new Error(`未知 mode："${mode}"（可用 look/toward/place/break/use/useItem/attack/equip/wear/toss）`)
      }
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_give',
    description: '**创造模式直接获取物品**（不走 /give 指令——那是协议级改槽位，非 OP 也能用）。'
      + '给英文物品 id，如 oak_planks / diamond_sword / white_concrete。clearAll=true 清空背包。',
    parameters: {
      name: { type: 'string', description: '物品英文 id（如 oak_planks）' },
      count: { type: 'number', description: '数量（默认 1，上限该物品堆叠数）' },
      slot: { type: 'number', description: '指定槽位 0-44（缺省自动找快捷栏空位）' },
      clearAll: { type: 'boolean', description: 'true=清空整个背包（忽略 name）' },
    },
    output: text(),
    timeoutMs: 60_000,
    async execute(args, exec) {
      const sess = getSession(exec)
      if (args.clearAll) return sess.bot.clearInventory()
      return sess.bot.giveItem({ name: args.name, count: args.count, slot: args.slot })
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_sequence',
    description: '**按顺序执行一串世界交互**（替代"写脚本"）：适合"走到这里放几个方块，再走到那里放几个"这类连串动作。\n'
      + 'steps 是数组，每项 op 可为：wait(sec) / move(x,y,z,mode) / look(x,y,z 或 who) / toward(who) / '
      + 'place(x,y,z,name) / break(x,y,z) / dig(name 或 x,y,z,count) / use(x,y,z 或 who, 可给 name) / '
      + 'useItem(name,holdMs) / attack(who) / hunt(who,durationSec,range,hpFloor,reacquire) / equip(name,dest) / wear / give(name,count) / toss(name,count) / '
      + 'say(text) / jump。\n'
      + '逐步执行，默认遇错即停，整体有预算上限（默认 300s）。',
    parameters: {
      steps: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '步骤数组（上限 64）' },
      stopOnError: { type: 'boolean', description: '出错是否停（默认 true）' },
      budgetMs: { type: 'number', description: '总预算（默认 300000）' },
    },
    output: text(),
    timeoutMs: 600_000,
    async execute(args, exec) {
      const sess = getSession(exec)
      return sess.bot.runSequence(args.steps, {
        stopOnError: args.stopOnError !== false,
        budgetMs: Math.min(Number(args.budgetMs ?? 300_000), 570_000),
      })
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_build',
    description: '批量搭方块：把 (x1,y1,z1)–(x2,y2,z2) 这个实心长方体用 name 方块搭出来（会自己走近/垫脚，上限 max 个）。'
      + '适合"搭一面墙/一根柱子/一个平台"，比一个个 mc_act{place} 省事。',
    parameters: {
      x1: { type: 'number', required: true }, y1: { type: 'number', required: true }, z1: { type: 'number', required: true },
      x2: { type: 'number', required: true }, y2: { type: 'number', required: true }, z2: { type: 'number', required: true },
      name: { type: 'string', description: '用哪种方块（缺省背包第一种）' },
      max: { type: 'number', description: '最多放几个（默认 64，防手滑）' },
    },
    output: text(),
    timeoutMs: 180_000,
    async execute(args, exec) {
      const sess = getSession(exec)
      return sess.bot.build({
        x1: Number(args.x1), y1: Number(args.y1), z1: Number(args.z1),
        x2: Number(args.x2), y2: Number(args.y2), z2: Number(args.z2),
        name: args.name ? String(args.name) : null,
        max: Math.min(Math.max(Number(args.max ?? 64), 1), 256),
      })
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_dig',
    description: '挖方块：给 name 挖最近的，或给 pos 挖指定坐标；count 可连续挖多个。',
    parameters: {
      name: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' },
      maxDistance: { type: 'number', description: '搜索半径（默认 6）' },
      count: { type: 'number', description: '挖几个（默认 1，上限 16）' },
    },
    output: text(),
    timeoutMs: 120_000,
    async execute(args, exec) {
      const sess = getSession(exec)
      const pos = (args.x !== undefined && args.y !== undefined && args.z !== undefined)
        ? { x: Number(args.x), y: Number(args.y), z: Number(args.z) } : null
      const lines = await sess.bot.dig({
        name: args.name ? String(args.name) : null, pos,
        maxDistance: args.maxDistance, count: args.count,
      })
      return { result: lines }
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_hunt',
    description: '**自动攻击（追着打）**：决定打谁之后一次调用即可 —— 自动寻路追上去、锁定**这一个**实体连续打，'
      + '途中**自动挖挡路方块、自动垫脚**（靠 mineflayer-pathfinder），不必一步步调 mc_act（省 token）。\n'
      + 'v2 战斗逻辑按 Wurst 客户端设计：**前方脚/头两格主动采样**——一格台阶直接跳、挡墙直接挖（不等视线掠过骗人、不等卡死）+ 挖死 8s 看门狗强制中止重规划；'
      + '**视线被墙挡 → 换最快工具挖穿再打**（挖不动的领地方块挂死竞速+2 次即放弃，不再空耗；不贴墙空挥）；'
      + '**每次出手前把最强武器拿回手上**（寻路垫脚会临时换手，收场也换回）；'
      + '**卡在台阶/墙角 0.7s 不动 → 兜底自动跳**；**血量 ≤ hpFloor → 自动跑开 → 吃食物回血 → 再锁定追上来**（最多撤 3 轮，回不上血才收场）。\n'
      + '**PVP 套装**（对标 Wurst）：**300ms 下落段跳劈暴击**（Criticals 合法版 ×1.5）+ 攻速 625ms 高斯 ±100ms 抖动（Killaura speedRandMS 防节奏固定）+ **血量≤10 自动图腾换副手**（AutoTotem）+ **6-22 格拉弓抛物线射击**（原版箭 v0=3.0/重力0.05/阻力0.99 解算 + 移动提前量，蓄力 0.85s；背包要有弓和箭）+ 推进按 sprint。\n'
      + '开战自动换背包最强武器到手；**目标锁定规则**：就近锁定（距离最近的匹配实体）；**非玩家目标**太远（初距>60 格不追、追丢了拉开>60 格持续 4s 即取消锁定）；**玩家目标**不设距离限制、锁到死。'
      + '目标死/跑丢/回不上血/超时/被中断/太远都会收场并返回战报（含 hits/retreats/ate/outcome）。'
      + '背包带些方块（脚手架类）才能垫脚过沟，还要带点食物才回得了血。也可作为 mc_sequence 的 hunt 步骤。',
    parameters: {
      who: { type: 'string', required: true, description: '目标名字（子串匹配；先用 mc_entities 看附近有谁）' },
      durationSec: { type: 'number', description: '最多追打多少秒（默认 45，上限 120）' },
      range: { type: 'number', description: '追到多近算跟上（默认 2，1-8）' },
      hpFloor: { type: 'number', description: '自己血量低于此值就撤退：跑开→吃食物回血→再锁定追上来（默认 10；回不上才收场）' },
      reacquire: { type: 'number', description: '目标丢失后宽限几秒再收场（默认 4，可能只是过区块边界）' },
    },
    output: text(),
    timeoutMs: 180_000,
    async execute(args, exec) {
      const sess = getSession(exec)
      return sess.bot.hunt({
        who: args.who,
        durationSec: args.durationSec,
        range: args.range,
        hpFloor: args.hpFloor,
        reacquire: args.reacquire,
      })
    },
  }))

  ctx.tools.register(asTool({
    name: 'mc_command',
    description: '以玩家身份执行服务器指令。**白名单可配置**（默认 tp/give/time/weather/say/gamemode/effect/'
      + 'setblock/fill/clone/summon/title/clear/xp）。要放行别的指令，在**普通会话**里用 `mc_admin_config` 改 '
      + '`commandWhitelist`（MC 模式会话改不了）。\n'
      + '⚠️ 这是**最后手段**：正经动作优先 `mc_act` / `mc_build` / `mc_move`（那些不需要 OP）。',
    parameters: { command: { type: 'string', required: true, description: '以 / 开头的完整指令' } },
    output: text(),
    async execute(args, exec) {
      const sess = getSession(exec)
      const raw = String(args.command ?? '').trim()
      const name = raw.replace(/^\//, '').split(/\s+/)[0].toLowerCase()
      if (!pluginConfig.commandAllowed(name)) {
        throw new Error(`指令 /${name} 不在白名单里。当前白名单：${JSON.stringify(pluginConfig.get('commandWhitelist'))}`
          + '（要放行请在普通会话里用 mc_admin_config 改 commandWhitelist）')
      }
      return { sent: sess.bot.command(raw, { allow: (n) => pluginConfig.commandAllowed(n) }) }
    },
  }))

  /* ── 图像：SVG 为编辑语言（写/引图/光栅化/保存）──
   * 用户的思路：SVG 是文本，AI 本来就会写——拼网格/画框/加文字（含中文）都在 SVG 里表达，
   * 我们只补它做不到的两件事：**把外部图片塞进 SVG**（embed）和 **SVG→PNG**（render）。
   *
   * 🔴 2026-09-16：**删掉了 mc_kit_share**（以及 mc_map 的 share 参数）。原因：它不是"我们实现的
   *    上传"，而是去调宿主实例里另装的 `dsh-file-host`（`/serve/file-host/api/upload`）——
   *    插件本身没有文件服务器，开源出去别人也没有那个条目，等于提供一个"看着能用、实际 404"的工具。
   *    要"让本地用户看到文件"，DSH 自带的正路是 **`present`**（`deliverables/presented` → Web 的
   *    产出文件卡片：可预览、可打开；正文里写行内代码的文件名也会变成可点链接）。
   *    所以现在只负责**把图落到工作区**，交付交给 `present`。
   * ------------------------------------------------------------------------ */

  /** 把用户给的路径解析到**这个会话的工作区**内（不许越界） */
  const insideWorkspace = (raw, agent) => {
    const root = workspaceRootFor(agent)
    const abs = resolve(root, String(raw ?? '').trim())
    const prefix = root.endsWith(sep) ? root : root + sep
    if (abs !== root && !abs.startsWith(prefix)) {
      throw new Error(`路径必须在工作区内（${root}）`)
    }
    return abs
  }

  ctx.tools.register(asTool({
    name: 'mc_kit_image',
    description: '图像能力。**SVG 是编辑语言**：布局/画矩形框/加文字（含中文）/拼网格，'
      + '都可以直接写 SVG 文本（用 write 存成 .svg），再用这个工具光栅化成 PNG。\n'
      + 'action：\n'
      + '· info    看一张图的尺寸/格式（也能确认文件到底是不是能用的图）\n'
      + '· embed   把图片变成 data URI + 现成的 `<image>` 标签 —— **往 SVG 里引入图片必须这么做**\n'
      + '· render  SVG → PNG（可给 width/height/scale；svg 文本或 svgPath 二选一）\n'
      + '· grid    把多张图按网格拼成**可继续编辑的 SVG 文本**（省掉重复写 N 个 <image> 和算坐标）\n'
      + '· save    把 SVG 文本或 PNG 字节落盘\n'
      + `输出默认落在 \`.whale-craft/${OUT_DIR}/\`（**不对外**）。要给用户看，就把 \`out\` 写成`
      + `\`.whale-craft/${EXPRESS_DIR}/<子目录>/x.png\`（**发布区**），再用 \`mc_kit_express\` 取那一行。`,
    parameters: {
      action: { type: 'string', description: 'info / embed / render / grid / save' },
      path: { type: 'string', description: '输入文件（info/embed 用）' },
      out: { type: 'string', description: '输出路径（render/save 用）' },
      svg: { type: 'string', description: 'render：SVG 文本' },
      svgPath: { type: 'string', description: 'render：SVG 文件路径' },
      width: { type: 'number', description: 'render：目标宽' },
      height: { type: 'number', description: 'render：目标高' },
      scale: { type: 'number', description: 'render：倍率（2=两倍清晰度）' },
      paths: { type: 'array', items: { type: 'string' }, description: 'grid：要拼的图片路径（按顺序）' },
      cols: { type: 'number', description: 'grid：列数（默认自动）' },
      cell: { type: 'number', description: 'grid：每格最长边（默认 256）' },
      gap: { type: 'number', description: 'grid：格子间距（默认 8）' },
      labels: { type: 'array', items: { type: 'string' }, description: 'grid：每格标签（可中文）' },
      title: { type: 'string', description: 'grid：整图标题' },
    },
    output: text(),
    timeoutMs: 120_000,
    async execute(args, exec) {
      const inWs = (p) => insideWorkspace(p, exec?.agent)
      if (!ImageEngine.available()) {
        throw new Error(`图像引擎不可用：${imageEngineError() ?? 'sharp 未解析到'}`)
      }
      const action = String(args.action ?? '').toLowerCase()
      /**
       * 输出路径。默认落在**记忆夹的 `.out/`**（`.whale-craft/.out/`，**不对外**）。
       *
       * 🔴 用户 2026-09-16 定的**发布模型**：
       *    · `.out/` = 默认输出，**谁都访问不到**；
       *    · `.express/` = **发布区**，放进去的文件可通过
       *      `GET /api/mc/whale-craft/<工作区目录名>/<剩余路径>` 访问 —— 要给用户看就显式写进这里，
       *      再用专用工具 `mc_kit_express` 换回那行路径，自己拼 markdown。
       */
      const outDir = outRootOf(memoryRootFor(workspaceOf(exec?.agent)))
      const needOut = (name) => (args.out ? inWs(args.out) : join(outDir, name))
      /* 🔴 用户 2026-09-16：结果里**不再**塞任何 express 字段（'不要乱给已有工具加'）——取路径统一走 mc_kit_express。 */

      switch (action) {
        case 'info': {
          const p = inWs(args.path)
          return await ImageEngine.info(p)
        }

        case 'embed': {
          const r = await ImageEngine.embed(inWs(args.path), {
            asTag: true, x: args.x ?? 0, y: args.y ?? 0, width: args.width, height: args.height,
          })
          // data URI 很长，别原样刷屏：给长度 + 现成标签 + 用法
          return {
            file: r.file, mime: r.mime, bytes: r.bytes, dataUriLength: r.dataUri.length,
            tag: r.tag, note: r.note,
          }
        }

        case 'render': {
          if (!args.svg && !args.svgPath) throw new Error('render 需要 svg 文本或 svgPath')
          const r = await ImageEngine.render({
            svg: args.svg ?? null,
            svgPath: args.svgPath ? inWs(args.svgPath) : null,
            width: args.width, height: args.height, scale: args.scale,
          })
          const out = needOut('mc-image.png')
          const saved = ImageEngine.save(out, r.png)
          return { rendered: `${r.width}x${r.height}`, ...saved }
        }

        case 'grid': {
          const r = await ImageEngine.grid({
            paths: (args.paths ?? []).map((p) => inWs(p)),
            cols: args.cols, cell: args.cell, gap: args.gap,
            labels: args.labels, title: args.title,
          })
          const out = needOut('mc-grid.svg')
          ImageEngine.save(out, r.svg)
          return {
            svg: `${r.width}x${r.height}`, cells: r.cells, layout: `${r.cols}x${r.rows}`,
            file: out, bytes: Buffer.byteLength(r.svg),
            note: '这是**可继续编辑的 SVG 文本**：想加标注就改这个文件（画 <rect stroke>、加 <text>），'
              + '再 mc_kit_image{action:"render"} 光栅化成 PNG。',
          }
        }

        case 'save': {
          if (!args.svg && !args.path) throw new Error('save 需要 svg（文本）或 path（要复制的文件）')
          const out = needOut('mc-image.svg')
          if (args.svg) return { ...ImageEngine.save(out, String(args.svg)), kind: 'svg' }
          const src = inWs(args.path)
          const { readFileSync } = await import('node:fs')
          return { ...ImageEngine.save(out, readFileSync(src)), kind: 'copy', from: src }
        }

        default:
          throw new Error(`未知 action："${action}"（可用 info/embed/render/grid/save）`)
      }
    },
  }))

  /**
   * 发布区取链接：**唯一**的"把文件端给用户"的入口（用户 2026-09-16 定）。
   *
   * 只做一件事：把 `.whale-craft/.express/` 下的文件换成**给用户用的那一行**，
   * 剩下的 markdown 由 AI 自己拼（`![名](url)` / `[名](url)`）——不再往别的工具返回值里塞字段。
   *
   * 🔴 **回什么由「文件分享」模式决定**（用户 2026-09-17 定，见 config.mjs `expressMode`）：
   *   · off    关闭（默认）→ 恒回一句"文件分享已关闭…"，服务也不开（AI 只能把绝对路径告诉用户）；
   *   · online 在线 → 回 `base + 相对路径` 的**完整 URL**，只有这个模式才开服务。
   * 两种模式都仍然**只认发布区**（`.express/`）里的文件。
   */
  ctx.tools.register(asTool({
    name: 'mc_kit_express',
    description: '把**发布区**（`.whale-craft/.express/`）里的文件换成"给用户的东西"。\n'
      + '· 入参：`path` —— 发布区下的文件（工作区相对或绝对都行，**必须在 `.whale-craft/.express/` 下**）；\n'
      + '· 返回**一行**，内容取决于用户在「MC设置 → 文件分享」里选的模式：\n'
      + '  · 关闭（默认）：只回一句"文件分享已关闭…"——那就把文件的**绝对路径**告诉用户，让用户自己打开；\n'
      + '  · 在线：回**完整 URL**——图片 `![图片名](url)`、其它文件 `[文件名](url)` 嵌进回复里；\n'
      + '· 在线链接**原样使用**，不要再补 `http://…` 或域名。\n'
      + '⚠️ 只有 `.whale-craft/.express/` 下的文件可分享；默认输出目录 `.whale-craft/.out/` **不对外**。',
    parameters: {
      path: { type: 'string', required: true, description: '发布区下的文件路径（工作区相对或绝对；必须在 .whale-craft/.express/ 下）' },
    },
    output: {
      schema: { type: 'object', properties: { url: { type: 'string' }, mode: { type: 'string' } }, additionalProperties: true },
      // **只把那一行给模型**（用户："输出纯路径，让 AI 自己拼接 md"）
      render: (_args, value) => [{ type: 'text', text: String(value?.url ?? '') }],
    },
    async execute(args, exec) {
      const cwd = workspaceOf(exec?.agent)
      const memRoot = memoryRootFor(cwd)
      const raw = String(args.path ?? '').trim()
      if (!raw) throw new Error('path 不能为空')
      // 解析顺序：绝对路径照用；相对路径先按**记忆根**试（`.express/x.png` 这种写法最常见），
      // 再按**工作区**试（`.whale-craft/.express/x.png`）。都不存在才算文件不存在。
      const candidates = isAbsolute(raw)
        ? [resolve(raw)]
        : [resolve(memRoot, raw), resolve(cwd ?? memRoot, raw)]
      const abs = candidates.find((p) => { try { return statSync(p).isFile() } catch { return false } })
      if (!abs) {
        throw new Error(`找不到这个文件：${raw}（试过：${candidates.join(' / ')}）`)
      }
      // 🔴 地址里的"工作区指代"= **工作区 uuid**（`workspaceRegistry` 的 id）。
      //    用户定的兜底是 (a) 拒绝：这个 cwd 在注册表里查不到就直接报错，不退回目录名。
      const wsId = workspaceIdOfCwd(cwd)
      if (!wsId) {
        throw new Error('这个会话的工作区不在 DSH 的工作区注册表里，拿不到分享地址（不退回目录名）。'
          + '请让用户在工作区选择器里选中该目录（或用它新建/打开一个会话）后再试。')
      }
      const ref = expressRefFor(abs, memRoot, wsId)
      if (!ref) {
        throw new Error('这个文件不在发布区里，所以没有可分享的地址。'
          + `请先把它放到 .whale-craft/${EXPRESS_DIR}/<子目录>/ 下（出图时把 out 写成那里，`
          + '或用 mc_kit_memory {action:"put", path:".express/<子目录>/x.png"} 复制过去），再来取。')
      }
      const mode = pluginConfig.expressMode
      // 关闭（默认）：恒回那一句（**不抛错** —— 让 AI 直接把话转达用户，而不是去试别的歪招）
      if (mode !== 'online') return { mode, url: EXPRESS_OFF_TEXT, rel: ref.rel, abs: abs }
      // 在线：base + 相对路径；base 还没配就把"让用户去设置"这句话交给 AI
      const url = onlineUrlOf(pluginConfig.expressBase, ref.url)
      if (!url) return { mode, url: EXPRESS_NEED_BASE_TEXT, rel: ref.rel }
      return { mode, url, rel: ref.rel }
    },
  }))

  /* ── 长期记忆（游戏外通用能力，所以叫 mc_kit_ 不叫 mc_）──
   * 固定 <工作区>/.whale-craft/：AI 维护 README.md 索引，按服务器建子文件夹，
   * 任意格式文件可读写（含图片），**不执行任何东西**。
   * ------------------------------------------------------------------------ */

  ctx.tools.register(asTool({
    name: 'mc_kit_memory',
    description: '长期记忆（跨会话、重启后还在）。固定放在工作区的 **`.whale-craft/`** 文件夹里，'
      + '按服务器建子文件夹（`_global/` 放通用的）。\n'
      + '**索引由你自己维护**：`.whale-craft/README.md`（插件每轮把它的内容 + 一份自动目录树注入你的上下文，'
      + '所以就算忘了更新 README 也不会失真；但记得**改了记忆就顺手更新 README**）。\n'
      + 'action：\n'
      + '· index（默认）看总览：有哪些文件夹/文件、各多少条、README 现状\n'
      + '· read    读文件（path 或 topic+server）；**读图片会作为附件给你，你能直接看到**\n'
      + '· append  追加一条（最常用；给 key 则**覆盖**同 key 的那条，不会堆积）——只对文本文件\n'
      + '· write   整文件覆盖（重组内容、写小标题/表格）——文本文件\n'
      + '· put     把自己读到的**任意文件（图片最常用）复制进记忆**，之后可随时 read 出来看\n'
      + '· delete  删文件（path 指向目录则整目录删）\n'
      + '· search  跨文本文件搜关键词，返回命中行\n'
      + '路径写法：`path:"mc.example.com/maps/town.png"`，或 `topic:"landmarks"`（server 默认取你当前所在服，'
      + '不传 server 就写进 `_global/`）。\n'
      + '⚠️ 这个文件夹里**只读写文件，不执行任何东西**（没有 shell、不跑脚本）。',
    parameters: {
      action: { type: 'string', description: 'index（默认）/ read / append / write / put / delete / search' },
      path: { type: 'string', description: '相对路径，如 mc.example.com/landmarks.md（与 topic 二选一）' },
      topic: { type: 'string', description: '主题名（会拼成 <server>/<topic>.md）' },
      server: { type: 'string', description: '服务器文件夹；默认当前所在服，不传则 _global' },
      text: { type: 'string', description: 'append 的内容（一条事实，一句话说清）' },
      content: { type: 'string', description: 'write 的完整内容（文本文件）' },
      key: { type: 'string', description: 'append 用：同 key 覆盖（如 "用户叫什么"）' },
      source: { type: 'string', description: 'put 用：要存入记忆的文件路径（工作区内；图片最常用）' },
      name: { type: 'string', description: 'put 用：存进去的名字（缺省用原文件名）' },
      query: { type: 'string', description: 'search 的关键词' },
      limit: { type: 'number', description: 'search 最多几条（默认 30）' },
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (args, value) => {
        const blocks = [{ type: 'text', text: String(value?.text ?? JSON.stringify(value, null, 2)) }]
        // read 到图片时把它作为附件带出去 —— 这样模型**能直接看到**存下来的图
        if (value?.attachment) blocks.push({ type: 'image', attachment: value.attachment })
        return blocks
      },
    },
    async execute(args, exec) {
      const mem = memoryFor(workspaceOf(exec?.agent))
      const action = String(args.action ?? 'index').toLowerCase()
      if (action === 'index') return mem.overview()

      // put：把工作区里的源文件复制进记忆（图片最常用；任何格式都行）
      if (action === 'put') {
        const src = insideWorkspace(args.source, exec?.agent)
        let server = args.server
        if (server === undefined && args.path === undefined) {
          const sess = getSession(exec)
          server = sess.bot.sub ?? null
        }
        return mem.put({ source: src, name: args.name, path: args.path, server })
      }

      // 只在"没显式给 server 且没给 path"时，才用当前所在服兜底
      let server = args.server
      if (server === undefined && args.path === undefined) {
        const sess = getSession(exec)
        server = sess.bot.sub ?? null      // 不在线 → null → 落进 _global
      }

      const sel = { path: args.path, topic: args.topic, server }
      switch (action) {
        case 'read': {
          const r = mem.read(sel)
          // 读的是图片 → 顺手做成附件，render 会把它当 image 块发出去（模型就能看到）
          if (r.kind === 'image') {
            const att = ctx.get('attachments')
            if (att && typeof att.saveImage === 'function') {
              try {
                const { readFileSync } = await import('node:fs')
                r.attachment = await att.saveImage({
                  data: new Uint8Array(readFileSync(r.file)),
                  mediaType: r.mediaType ?? 'image/png',
                  name: r.path.split('/').pop(),
                })
              } catch (e) { r.attachmentError = e.message }
            } else {
              r.attachmentError = '宿主没有 attachments 服务'
            }
          }
          return r
        }
        case 'append': return mem.append({ ...sel, text: args.text, key: args.key })
        case 'write':  return mem.write({ ...sel, content: args.content })
        case 'delete': return mem.delete(sel)
        case 'search': return mem.search({ query: args.query, limit: args.limit })
        default: throw new Error(`未知 action："${action}"（可用 index/read/append/write/put/delete/search）`)
      }
    },
  }))

  /* ── 总索引自动注入系统提示（用户要求：自动注入 + 提醒及时读）── */

  /** 记忆索引的正文（按工作区渲染；`store` 的根不存在且要求静默时返回空串） */
  const memoryIndexText = (store, { silentWhenMissing = false } = {}) => {
    if (silentWhenMissing && !existsSync(store.root)) return ''
    // 没记忆时不占位（第一次 append 后自动出现）
    const files = store.list()
    if (!files.length) {
      return '【麦块长期记忆】现在是空的（`.whale-craft/`）。学到值得记住的事（用户是谁、地标坐标、约定）就用 '
        + '`mc_kit_memory {action:"append", topic:"<主题>", text:"..."}` 记下来，'
        + '并在 `.whale-craft/README.md` 里补一行索引。'
    }
    return '【麦块长期记忆】根目录 `.whale-craft/`（其中 `README.md` 是**你维护的索引**）\n\n'
      + store.indexText()
      + '\n\n**要动手前先读相关文件**（`mc_kit_memory {action:"read", path:"..."}`）——'
      + '别凭印象做事；不确定就先 `search`。新学到的事实随手 `append`，'
      + '并且**改了记忆就顺手更新 `.whale-craft/README.md`**。'
  }

  /**
   * 🔴 2026-09-16 用户定的：**本插件不再往系统提示词里塞任何东西**。
   *
   * 他的原话：系统提示词在 preset 里设置好就行，宿主管组装、**会自动注入**；
   * 插件再往系统提示里注册段是冗余。而且真机事故证明那条路**不可靠**：
   * 宿主 `system-prompt/src/index.ts:606` 是 `contexts: runtimeContextSuppressed ? [] : [...]`，
   * 从官方 `minimal` 复制来的 persona 带着 `includeRuntimeContext: false` / `complete: true` 时，
   * 我们注册的 context 段会在组装时被**整个丢掉** —— 症状正是"设置页显示正常、AI 却什么都没收到"。
   *
   * 所以注入**只剩一条通道**：学宿主注入工作区 `AGENTS.md` 的做法，把内容当**插件提示行**
   * 投进 `agent.inbox.nextStep`（见 `reconcileNotices`，在 `agent/pre-step` 里对账投递）——
   * 必达、在对话里看得见、而且完全不过 systemPrompt 组装，任何 persona 都压不掉它。
   * 记忆索引（`.whale-craft/README.md`）也走同一条路。
   */

  /* 🔴 这里原来有一段"给每个 agent 注册两个 systemPrompt 段（记忆索引 + 模式指导）"的代码，
   * 2026-09-16 用户要求**整段删掉**："系统提示词不用显式注入，设置好了会自动注入" ——
   * 插件自己往系统提示里塞东西既冗余，又会被 persona 的 complete/includeRuntimeContext 压掉
   * （见上一段）。记忆索引与模式相关的话现在都走 `reconcileNotices()` 的插件提示行。 */

  /**
   * 行事准则文件缺了就补一份默认。
   * 用户 2026-09-16："启动对话时设置要求注入、但找不到文件" → **注入默认 + 重建文件**（自愈）。
   * @returns {boolean} 是否刚建出来（调用方据此打一行日志）
   */
  const ensureAgentsMdFile = (dir) => {
    const p = agentsMdPath(dir)
    try {
      // 先把老名字（`.whale-craft/AGENTS.md`）迁走 —— 只要那个文件名还在，宿主就会把它
      // 当"工作区指令"注入任何碰过本目录的会话（含非 MC 会话），而我们的开关关不掉它。
      const mig = migrateLegacyAgentsMd(dir)
      if (mig.migrated) logLine(`行事准则已改名迁移：${legacyAgentsMdPath(dir)} → ${p}（老文件备份为 ${mig.backup}）`)
      else if (mig.reason) logLine(`行事准则迁移失败（不影响使用）：${mig.reason}`)
      if (existsSync(p)) return false
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(p, DEFAULT_AGENTS_MD, 'utf8')
      return true
    } catch (e) { logLine(`重建行事准则失败（${p}）：${e.message}`); return false }
  }

  /**
   * **把提示词当"插件提示"投递**（学宿主的做法，**绝不冒充用户发言**）。
   *
   * 投三条（各一条插件提示行）：
   *    ① `<工作区>/AGENTS.md`（开关 `injectWorkspaceAgentsMd`）—— 用户要求先投它
   *    ② `<工作区>/.whale-craft/RULES.md`（开关 `injectWhaleCraftAgentsMd`）
   *    ③ `<工作区>/.whale-craft/README.md` = **记忆总索引**（无开关：记忆是这个模式的本职）
   *
   * 🔴 为什么走这条路：宿主注入工作区 `AGENTS.md` **不用 systemPrompt** ——
   *    `packages/context/agent-instructions` 把一条消息放进 `agent.inbox.nextStep`
   *    → ① **必达**（不经过 systemPrompt 组装：persona 的 `complete:true` /
   *    `includeRuntimeContext:false` 压不到它）；② **看得见**（对话里一行折叠提示）。
   *
   * 用户 2026-09-16 的要求（照做，**不多做**）：
   *    · **不加新开关** —— 就用设置里那两个：`injectWhaleCraftAgentsMd` / `injectWorkspaceAgentsMd`；
   *    · 两个都开时**先投工作区的，再投我们自己的**；
   *    · 每条都要让人**和 AI**一眼看出是哪个文件：折叠标题与正文首行都带**相对路径**
   *      （`AGENTS.md` 与 `.whale-craft/AGENTS.md` 是两回事）；
   *    · `source` 走 `noticeSource()` = `{kind:'plugin:whale_craft', form:'notice'}` → 插件提示行，不归到用户头上；
   *      （🔴 kind 必须是 producer-owned：v4 会话格式拒绝 V3 的 `'plugin'`，见 src/user-message.mjs 顶部）
   *    · **不做 steer 兜底**（steer 空闲会"起一轮"＝没问就替用户说话）。
   */
  /**
   * 造一条"用户角色"的消息（宿主 `UserMessage` 的形状）。
   *
   * 🔴🔴 2026-09-18 真机事故（用户在**另一台设备**上 npm 装了 0.1.3）：**提示词一条都没注入**，
   *    而工具白名单/guard 一切正常。根因这里：`@deepseek-ai/dsh-llm` **没有写进依赖声明**，
   *    本机是因为 `node_modules` 里有指向宿主源码树的链接才 `require` 得到；
   *    别人 `npm i` 装出来的插件目录里没有这个包、向上也找不到 ⇒ 提示行**一条都建不出来**。
   *    而工具白名单（`tools.restrict`）+ guard 全靠 ctx，不碰任何宿主包 ——
   *    于是症状精确地是"**工具都在、提示词全无**"。
   *
   * 现在统一走 `src/user-message.mjs`：**优先宿主实现，拿不到就用自带等价实现**
   * （字段逐个对齐 `role` / `content` / `source` / `id`），并且解析失败会记一行日志。
   * 看门狗（`src/watchdog.mjs`）是同一次事故的第二处，也已切到同一个模块。
   */
  if (pluginLoadNote) {
    logLine(`拿不到宿主的 createUserMessage（${pluginLoadNote}）→ 用插件自带的等价实现兜底（提示词与看门狗注入照常）`)
  }

  /**
   * 提示词投递台账（agent → 状态）。
   *
   * 🔴 2026-09-18 改挂载点（用户："应该切换到正确的挂载点……而是在对话开始后设置工具/注入提示词"）：
   *    **投递时机从"会话开始/切模式那一刻"搬到"每个请求组装之前"**（`agent/pre-step`）。
   *    台账因此按 **preset** 记账：`fp` 记"这批提示词是给哪个模式投的"，切模式就作废重投。
   *
   * 字段：`sessionId` · `fp`（mode/版本指纹）· `rel`（已投的文件名）· `items`（那一刻的正文）
   *      · `since`（会话日志的下标：**上次切出模式那一刻**，之前的投递记录不再算数）
   */
  const noticeLedger = new WeakMap()
  const ledgerOf = (agent) => {
    let l = noticeLedger.get(agent)
    if (!l) { l = { sessionId: null, fp: null, rel: [], items: new Map(), since: 0 }; noticeLedger.set(agent, l) }
    if (l.sessionId !== (agent?.id ?? null)) { l.sessionId = agent?.id ?? null; l.fp = null; l.rel = []; l.items = new Map(); l.since = 0 }
    return l
  }

  /** 这条待投递消息是不是**我们**（whale_craft）投的插件提示行 */
  const isOurNotice = (m) => String(m?.source?.plugin ?? '') === 'whale_craft' && m?.source?.form === 'notice'

  /** 提示行正文里"它出自哪个文件"（首行 `Instructions from: <rel>`），取不到就 null */
  const noticeRelOf = (m) => {
    try {
      const text = (m?.content ?? []).map((c) => c?.text ?? '').join('')
      const m2 = /^Instructions from:\s*(\S+)/m.exec(text)
      return m2 ? m2[1] : null
    } catch { return null }
  }

  /**
   * 从**会话日志**里读"这个 preset 下我们已经投过哪些文件"。
   *
   * 为什么必须读日志：台账是**进程内**的（WeakMap），宿主重启 / 插件重载就没了，
   * 而会话日志是持久的 —— 一个已经投过提示词的 MC 会话在重启后 resume，
   * 只看台账就会**再投一遍**（重复注入）。`snapshotEvents()` 在真机上可用，
   * 拿不到就退化成"只信台账"（不抛错，绝不让诊断路径把 turn 弄挂）。
   *
   * ⚠️ 只看 `l.since`（**上次切出 MC 模式那一刻**）之后的事件：切出时提示词已经作废
   *    （台账也清了），若不划这条线，"切出 → 再切回"会被日志里的旧记录误判成"已经投过"
   *    ⇒ **再也不投**（自检逮到过这个 bug）。
   */
  const deliveredRelsFor = (agent, rels) => {
    const out = new Set()
    try {
      const from = Number(ledgerOf(agent).since) || 0
      let events = []
      try {
        const ev = agent?.session?.snapshotEvents?.()
        events = Array.isArray(ev) ? ev : []
      } catch { events = [] }
      for (const ev of events.slice(from)) {
        if (ev?.type !== 'user/message') continue
        const m = ev.data
        if (!isOurNotice(m)) continue
        const text = (m.content ?? []).map((c) => c?.text ?? '').join('')
        for (const rel of rels) if (rel && text.includes(rel)) out.add(rel)
      }
    } catch { /* 读不到日志就只信台账 */ }
    return out
  }

  /**
   * 把一条插件提示行放进会话的"待投递"队列。
   * 优先用宿主的 inbox API（`append` → 会**durable** 落事件 + 通知投影；宿主自己也走 splice 系列），
   * 老版本/替身没有这个 API 才退回直接 push。
   */
  const pushNotice = (inbox, message) => {
    if (typeof inbox.append === 'function') { inbox.append('next-step', message); return true }
    if (Array.isArray(inbox.nextStep)) { inbox.nextStep.push(message); return true }
    return false
  }

  /**
   * **清掉还没投递的**本插件提示行（切出 MC 模式时用）。
   *
   * 🔴 2026-09-18 变简单了（挂载点搬到 `agent/pre-step` 之后）：
   *    以前提示词是"会话开始/切到 MC 模式那一刻"就入队，而模式允许在**空白期**继续改，
   *    于是"切 MC → 一句话没发 → 切回标准"会把 MC 提示词留在一个标准模式会话里
   *    （真机 `session-be2e43d7`：seq 3 切 MC、seq 4 切回标准、seq 7 三条提示词还在队列里等着）。
   *    现在**只在请求组装前现场判定并投递**（见 reconcileNotices）：不是 MC 模式就一条都不投，
   *    所以那种串模式**从根上不可能发生**，也**不再需要**补一条"MC 行事准则作废"声明去圆场。
   * 这里只负责把队列里可能残留的自家提示行摘干净（幂等；本模式重新进入时会照常重投）。
   * @param agent - 宿主 Agent
   * @returns {{removed: number, delivered: boolean}} 摘掉的条数 / 之前是否真的投递过
   */
  const withdrawAgentsMdNotices = (agent) => {
    const inbox = agent?.inbox
    let removed = 0
    if (inbox && Array.isArray(inbox.nextStep)) {
      for (const m of [...inbox.nextStep]) {
        if (!isOurNotice(m)) continue
        try {
          if (typeof inbox.remove === 'function' && m?.id !== undefined && inbox.remove(m.id) === true) { removed++; continue }
          const i = inbox.nextStep.indexOf(m)
          if (i >= 0) { inbox.nextStep.splice(i, 1); removed++ }
        } catch (e) { logLine(`清掉待投递提示行失败：${e?.message ?? e}`) }
      }
    }
    // 🔴 真事故（自检逮到）：清了队列就必须**同时把台账里的 rel 抹掉**。
    //    否则"切回普通模式（清队列）→ 再切回 MC 模式"时，台账还以为投过了 ⇒ **永远不再投**，
    //    典型症状就是"提示词莫名其妙没了"。队列里还没被 claim 的，本来就不算投过。
    // 🔴 切出模式 ⇒ 这批提示词**作废**：台账里的"已投"记录必须一起清掉，否则再切回来会被
    //    误判成"已经投过" ⇒ **再也不投**。这里**不能**加 `if (removed > 0)` 的条件 ——
    //    现在提示行是在本步消息里当场送出的，队列通常是空的（removed === 0），
    //    当年那版靠"队列非空"来判断"这次真的要作废"是错的（自检逮到过）。
    {
      const l = ledgerOf(agent)
      l.rel = []
      l.items = new Map()
    }
    // 🔴 无论有没有从队列里摘到东西，都要**划一条线**：把"切出这一刻"的日志下标记下来，
    //    之后 `deliveredRelsFor` 只认这条线之后的投递记录 —— 这样"切出 → 再切回"才会重投
    //    （否则日志里的旧记录会让插件误判"已经投过"，表现为**再也不投**）。
    try {
      const ev = agent?.session?.snapshotEvents?.()
      ledgerOf(agent).since = Array.isArray(ev) ? ev.length : 0
    } catch { /* 拿不到日志下标就算了（退化：只信台账） */ }
    // 队列本来就干净 ⇒ 说明那几条**已经进过对话**（载入时从日志认出来的）
    const delivered = removed === 0 && Boolean(ledgerOf(agent).fp)
    if (removed || delivered) {
      logLine(`已退出 MC 模式：清掉待投递提示行 ${removed} 条${delivered ? '（之前投过的那几条仍在对话历史里）' : ''}`)
    }
    return { removed, delivered }
  }

  /**
   * **每个请求组装之前对账一次**：现在是 MC 模式 + 这个模式还没投过 → 投三条插件提示行。
   *
   * 🔴 2026-09-18 改挂载点（用户："应该切换到正确的挂载点"）。挂在这里而不是"会话开始/切模式那一刻"，
   *    是因为**模式的最终值在第一次请求之前仍然可能变**（宿主允许空白期反复切 preset：
   *    `agent-presets/src/index.ts:709-728`，真机 `session-be2e43d7` 就是 seq3 切 MC、seq4 切回标准），
   *    而"发给 LLM 之前"这一刻才是模式已经定下来的时刻。
   *    宿主自己的同类特性也挂在这条瀑布上（`context/agent-instructions` 在 `agent/pre-step` 里同步上下文）。
   *
   * 幂等靠两件事：① 台账按 **preset 指纹**记账（`rel` 已有就不重复投）；
   * ② 队列里已经有同名提示行也不重复投（宿主可能还没把它们领走）。
   * @param agent - 宿主 Agent
   * @returns {{delivered: boolean, queued: number, reason?: string}}
   */
  const reconcileNotices = (agent) => {
    // ⚠️ 每个提前返回都必须带 `todo` 字段：`enterWithNotices` 会读 `r.todo.length`，
    //    漏一个就是 TypeError（这里被 catch 兜住 ⇒ 表现成"静默不注入"，正是最难查的那种）。
    if (!agent?.ctx) return { delivered: false, todo: [], queued: 0, reason: 'no-agent' }
    if (!isMcModeAgent(agent)) return { delivered: false, todo: [], queued: 0, reason: 'not-mc-mode' }
    const cwd = workspaceOf(agent)
    if (!cwd) return { delivered: false, todo: [], queued: 0, reason: 'no-workspace' }
    const inbox = agent.inbox
    if (!inbox || !Array.isArray(inbox.nextStep)) return { delivered: false, todo: [], queued: 0, reason: 'no-inbox' }
    // 注：消息构造由 `src/user-message.mjs` 保证 —— 宿主实现拿不到就用自带等价实现，
    //     所以这里**不再有"静默失败"的死角**。

    // 顺序：**先工作区，再我们自己的**（用户指定）
    const items = []
    if (pluginConfig.get('injectWorkspaceAgentsMd') === true) {
      try {
        const p = join(workspaceRootFor(agent), 'AGENTS.md')
        const t = existsSync(p) ? readFileSync(p, 'utf8').trim() : ''
        if (t) items.push({ rel: 'AGENTS.md', title: '提示词注入：AGENTS.md', text: t })
      } catch { /* 读不到就当没有 */ }
    }
    if (pluginConfig.get('injectWhaleCraftAgentsMd') === true) {
      const root = memoryRootFor(cwd)
      ensureAgentsMdFile(root)
      const cur = readAgentsMd(root)
      items.push({
        rel: '.whale-craft/RULES.md',
        title: '提示词注入：.whale-craft/RULES.md',
        text: `【Whale Craft 行事准则（${cur.source === 'custom' ? 'Master 自定义版' : '默认版'}）】\n\n${cur.text.trim()}`,
      })
    }
    // ③ **版本硬提示词**（随插件版本发布、硬编码、不给开关）：紧跟行事准则之后，
    //    读起来就是"对这个版本的工具成熟度的补充说明"。见 src/version-prompt.mjs。
    items.push({
      rel: versionPromptSource(PLUGIN_VERSION),
      title: versionPromptTitle(PLUGIN_VERSION),
      text: versionPromptText(),
    })
    // ④ 记忆总索引（`.whale-craft/README.md`）：**每个 MC 会话都给一次**——这正是"长期记忆"的入口。
    //    内容空（还没记过东西）也照样给：里面写着"怎么记"，第一轮就知道该往哪写。
    {
      const idx = memoryIndexText(memoryFor(cwd)).trim()
      if (idx) items.push({ rel: '.whale-craft/README.md', title: '提示词注入：.whale-craft/README.md', text: idx })
    }
    if (!items.length) return { delivered: false, todo: [], queued: 0, reason: 'no-items' }

    const ledger = ledgerOf(agent)
    const preset = lastPresetSeen.get(agent) ?? String(agent?.ctx ? '' : '')
    const fp = `${preset}|${PLUGIN_VERSION}`
    if (ledger.fp !== fp) { ledger.fp = fp; ledger.rel = []; ledger.items = new Map() }

    const delivered = deliveredRelsFor(agent, items.map((i) => i.rel))
    // 队列里**已经排着的**同名提示行：算"已经安排了"，不重复投（宿主下一个 step 会领走它）。
    const queuedRels = new Set(inbox.nextStep.filter(isOurNotice).map(noticeRelOf).filter(Boolean))
    const rels = new Set([...ledger.rel, ...delivered])
    const todo = items.filter((it) => !rels.has(it.rel) && !queuedRels.has(it.rel))
    if (!todo.length) {
      return { delivered: false, todo: [], queued: queuedRels.size }
    }
    // 只负责"算出该投什么"；**真正入队/改写本步消息**由 pre-step 监听器做（那里才有 decision）。
    // 注：版本提示的短哈希由 `versionPromptTitle()` 自己带进折叠标题，这里不需要再算。
    return { delivered: true, todo, queued: queuedRels.size }
  }

  /**
   * 🔴🔴 2026-09-18 **第二次改挂载点**（用户："两个全都是 LLM 运行了一半才后知后觉地注入，
   *    根本不是用户发送第一条信息后注入"）。
   *
   * 上一次我只把投递挂到 `agent/pre-step`，但**塞进了 `inbox.nextStep`** —— 而宿主的顺序是：
   *    `preStep()` 里**先 `inbox.claim()`**（把这一步的消息领走）**再**跑 `agent/pre-step` 瀑布
   *    （`core/agent-loop/src/agent.ts:244` → `:249`）。
   * 所以那一步塞进队列的提示行**这一步用不上**，要等**下一步**才被领走 ——真机实测：
   *
   *     seq= 7-9  next-step +3        ← 我在 pre-step 塞进队列
   *     seq=10    step/start  step=1  ← 这一步的消息**已经领完了**
   *     seq=12    user/message 用户那句
   *     seq=25    next-step -3        ← 到第 2 步才被领走
   *     seq=27-29 user/message ×3     ← 提示行晚了整整一步
   *
   * 这正是宿主 `agent-instructions` 的写法要解决的问题：**改写 `decision.messages`**
   *   （`context/agent-instructions/src/index.ts:313-338`：拿 `next()` 的结果 → 先把队列里
   *    那几条 `inbox.remove()` → 再 `{...decision, messages: toSpliced(...)}` 返回）。
   * 宿主紧接着在 `agent.ts:373-377` 把 `decision.messages` **逐条落成会话日志的 `user/message`**
   * 并作为请求里的那批消息 —— 既是**正规通道**（`stepAt`/重放都对得上），又能**当场**生效。
   *
   * 位置：**排在本步消息的最前面**。本步消息 = 用户那句 + 运行时上下文快照；
   * 把规矩放在最前，模型第一眼就看到（而不是先看到用户那句话再补规矩）。
   *
   * cordis：`agent/pre-step` 是 waterfall，**必须交棒**（`next()`）—— 见下面那段注释与自检。
   */
  const noticeMessagesFor = (todo) => todo.map((it) => userMessage({
    content: [{ type: 'text', text: `Instructions from: ${it.rel}\n\n${it.text}` }],
    // 🔴 source 必须 producer-owned（`plugin:whale_craft`），不能是 V3 的 `'plugin'` ——
    //    见 src/user-message.mjs 顶部那段 v4 事故说明。写成 `'plugin'` 会让整个 step 失败。
    source: noticeSource(it.title),
  }))

  /** 记一笔台账（投出去的那些文件名 + 正文，供诊断与"内容变了就地更新"） */
  const markNoticesSent = (agent, todo) => {
    const ledger = ledgerOf(agent)
    for (const it of todo) ledger.items.set(it.rel, it.text)
    ledger.rel = [...new Set([...ledger.rel, ...todo.map((i) => i.rel)])]
    logLine(`提示词已投递 ${todo.length} 条（**本步消息里**，与用户那句同批送出；插件提示行，非用户发言）：${todo.map((i) => i.rel).join(' → ')}`)
  }

  /**
   * 把提示行塞进**本步**的 `decision.messages` 最前面；没有要投的就原样返回。
   * 幂等：投过就记账，下一个 step 不会再投。
   * @param agent - 宿主 Agent（用来判模式与工作区）
   * @param decision - 交棒拿回来的 `PreStepDecision`
   * @returns 改写后的 decision（不改就别返回新对象）
   */
  const enterWithNotices = (agent, decision) => {
    try {
      if (!decision || decision.kind !== 'enter') return decision
      const r = reconcileNotices(agent)
      if (!r.todo.length) return decision
      // 队列里若有残留的自家提示行，先摘掉：它们马上要作为**本步消息**送出去了，
      // 留着会让下一步再送一遍（重复注入）。
      try { withdrawAgentsMdNotices(agent) } catch { /* 摘不掉也不影响本步 */ }
      markNoticesSent(agent, r.todo)
      const msgs = (decision.messages ?? []).filter((m) => !isOurNotice(m))
      const out = { ...decision, messages: [...noticeMessagesFor(r.todo), ...msgs] }
      return out
    } catch (e) {
      // 绝不带崩这一轮：改写失败就用内层原样结果。
      logLine(`提示词注入失败（不打断本轮，按原样继续）：${e?.message ?? e}｜${String(e?.stack ?? '').split('\n')[1] ?? ''}`)
      return decision
    }
  }

  /**
   * 「MC模式」那个 preset 的**人设压制**诊断（每次现读，便宜）。
   *
   * 为什么需要：宿主 `system-prompt/src/index.ts:606` 写着
   * `contexts: runtimeContextSuppressed ? [] : […]` —— persona 只要写了 `includeRuntimeContext: false`，
   * **我们注入的段（全是 context）会在组装时被整个丢掉**；`complete: true` 再压掉别的 section。
   * 复制官方 `minimal` 恰好带这两个开关 → "设置页显示一切正常、AI 却什么都没收到"（2026-09-16 真机）。
   */
  let mcPresetDiag = null
  const refreshMcPresetDiag = () => {
    try {
      const svc = agentPresetsSvc
      if (!svc) return mcPresetDiag
      for (const id of pluginConfig.mcModePresets) {
        const dir = mcPresetDir(svc, id)
        const p = dir ? join(dir, 'agent.cordis.yml') : null
        if (!p || !existsSync(p)) continue
        const comp = readFileSync(p, 'utf8')
        mcPresetDiag = {
          id,
          path: p,
          complete: /complete:\s*true/.test(comp),
          runtimeContextSuppressed: /includeRuntimeContext:\s*false/.test(comp),
          personaIsOurs: /Minecraft Java 版服务器里扮演一名玩家/.test(comp),
        }
        return mcPresetDiag
      }
    } catch { /* 读不到就当没有 */ }
    return mcPresetDiag
  }

  /**
   * 这个会话**已经投出去**的提示行文件名（诊断/UI 用）。
   *
   * 来源两处，缺一不可：① 进程内台账（`ledgerOf`，按 preset 记账）；
   * ② **会话日志回读** —— 台账是进程内的，宿主重启/插件重载就没了，只信台账会漏报
   *    （用户会看到"没投递"，而 AI 其实早就收到了）。
   */
  const sentNoticeRels = (agent) => {
    if (!agent) return []
    const out = new Set(ledgerOf(agent).rel)
    for (const rel of deliveredRelsFor(agent, noticeRelCandidates())) out.add(rel)
    return [...out]
  }

  /** 所有可能被投递的文件名（回读日志时用来匹配） */
  const noticeRelCandidates = () => [
    'AGENTS.md',
    '.whale-craft/RULES.md',
    '.whale-craft/README.md',
    versionPromptSource(PLUGIN_VERSION),
  ]

  /**
   * **提示词注入状态**（给 UI / `mc_diag` 看）：每条各自"投出去了没有、为什么没有"。
   *
   * 2026-09-16 加：用户在真机上反复报"没有任何我们的提示词"，而这件事**极难从外面判断**
   * （是没进 MC 模式？开关关了？文件不在？投递失败？）。与其让人猜，不如把判据摆出来：
   * `segments` 报**实际投递**（台账 + 会话日志回读），`notes` 是人话版原因。
   */
  const promptInjectionStatus = (agent) => {
    const cwd = workspaceOf(agent)
    const root = cwd ? memoryRootFor(cwd) : null
    const mcMode = Boolean(agent) && isMcModeAgent(agent)
    const wsAgents = agent ? join(workspaceRootFor(agent), 'AGENTS.md') : null
    const cur = root ? readAgentsMd(root) : null
    const agentsFile = root ? agentsMdPath(root) : null
    const injectWc = pluginConfig.get('injectWhaleCraftAgentsMd') === true
    const injectWs = pluginConfig.get('injectWorkspaceAgentsMd') === true
    const wsExists = Boolean(wsAgents) && existsSync(wsAgents)
    const presetId = (agent && lastPresetSeen.get(agent)) ?? null
    // 🔴 宿主的硬规则（system-prompt/src/index.ts:606）：persona 若写了 `includeRuntimeContext: false`，
    //    组装时 `contexts` 直接变成 `[]`；写了 `complete: true` 则"人设即全部系统提示"。
    //    复制官方 minimal 就会带这两个开关（2026-09-16 真机事故的根因）。
    //    ⚠️ 现在我们的提示词走**插件提示行**（inbox.nextStep），**不受它影响** —— 这条只作为
    //    "preset 还没被修好"的提示留着（它仍会压掉宿主自己的运行期上下文）。
    const personaSuppresses = Boolean(refreshMcPresetDiag()?.complete || mcPresetDiag?.runtimeContextSuppressed)
    const sent = sentNoticeRels(agent)
    return {
      mcMode,
      presetId,
      workspace: cwd ?? null,
      switches: { injectWhaleCraftAgentsMd: injectWc, injectWorkspaceAgentsMd: injectWs },
      files: {
        agentsMd: agentsFile
          ? { path: agentsFile, exists: existsSync(agentsFile), source: cur?.source ?? null, bytes: cur ? Buffer.byteLength(cur.text) : 0 }
          : null,
        workspaceAgentsMd: wsAgents ? { path: wsAgents, exists: wsExists } : null,
        memoryIndex: root ? { path: join(root, 'README.md'), exists: existsSync(join(root, 'README.md')) } : null,
      },
      preset: mcPresetDiag ?? null,
      // **实际投出去的文件名**（投递是唯一通道，这就是判据本身）
      notices: sent,
      // 版本硬提示词（随版本发布、无开关）：界面上只读展示（正文也带上，方便用户看它到底说了什么）
      versionPrompt: {
        version: PLUGIN_VERSION,
        title: versionPromptTitle(PLUGIN_VERSION),
        text: versionPromptText(),
        bytes: Buffer.byteLength(versionPromptText()),
      },
      // 保留 registered/segments 两个键名（前端与 mc_diag 在用）：现在两者同源 —— 都是"真的投了"
      registered: {
        'agents-md': sent.includes('.whale-craft/RULES.md'),
        'workspace-agents-md': sent.includes('AGENTS.md'),
        'version-prompt': sent.some((r) => String(r).startsWith('whale_craft@')),
        'memory-index': sent.includes('.whale-craft/README.md'),
      },
      segments: {
        'agents-md': sent.includes('.whale-craft/RULES.md'),
        'workspace-agents-md': sent.includes('AGENTS.md'),
        'version-prompt': sent.some((r) => String(r).startsWith('whale_craft@')),
        'memory-index': sent.includes('.whale-craft/README.md'),
      },
      // ⚠️ 这里只留**用户看不出来、又真的影响投递**的原因。
      //    "还没到投递时机 / 开关是关的" 这种**不用提示**（用户 2026-09-18：多余）——
      //    上面那行 `本会话注入：…` 已经用 ✓/✗ 摆出来了，而"还没发过消息"本来就是一目了然的状态。
      //    （前端对 `notes.length === 0` 已经不渲染那一行了，所以全空也没关系。）
      notes: [
        ...(agent ? [] : ['拿不到当前会话（没有 agent 上下文）']),
        ...(agent && !cwd ? ['这个会话没有选中工作区 → 提示词没地方放，插件不会投递'] : []),
        ...(agent && cwd && !mcMode ? [`这个会话不是 MC 模式（preset=${presetId ?? '未知'} 不在 mcModePresets 里）→ 不投递`] : []),
        ...(mcMode && injectWs && !wsExists ? ['工作区根目录里没有 AGENTS.md 这个文件'] : []),
        ...(personaSuppresses ? ['⚠️ preset 的 persona 还带着 complete / includeRuntimeContext:false（会压掉宿主自己的运行期上下文；我们的提示走插件提示行不受影响。重启 DSH 后本插件会自动修这个 preset）'] : []),
      ],
    }
  }

  /**
   * 在**选中工作区**里备好 `.whale-craft/`（缺 README.md / RULES.md 就补默认）。
   *
   * 🔴 用户 2026-09-16 定的**时机**：**不是**启动时对每个会话建，只在两个时刻建：
   *    ① **首次发起 MC 模式会话**（`applyMcModePolicy` 跑的时候）
   *    ② **点开「MC设置」**（那组 /api/mc/* 接口进来的时候）
   * 🔴 **没有选中工作区就拒绝**（不再退到 `$DSH_HOME` 兜底目录去建）。
   *
   * @returns {boolean} 备好了吗（false = 没工作区 / 建失败）
   */
  const seededRoots = new Set()
  const ensureMemoryRootForCwd = (cwd) => {
    if (!cwd) return false
    const root = memoryRootFor(cwd)
    if (seededRoots.has(root)) return true
    seededRoots.add(root)
    try {
      if (!existsSync(root)) {
        mkdirSync(root, { recursive: true })
        logLine(`已在工作区建立记忆目录：${root}`)
      }
      try { if (memoryFor(cwd).ensureReadme()) logLine(`已写入默认记忆索引：${join(root, 'README.md')}`) } catch (e) { logLine(`写默认索引失败：${e.message}`) }
      if (ensureAgentsMdFile(root)) logLine(`已写入默认行事准则：${agentsMdPath(root)}`)
      /* 「随版本更新」（默认开）：插件版本变了就用新版本默认准则替换文件里那份。
       * 首次遇到这个功能（没有 `.rules-version` 标记）只记版本、不覆盖；关着时也只记版本。 */
      const sync = syncRulesVersion(root, PLUGIN_VERSION, { follow: pluginConfig.get('rulesFollowVersion') !== false })
      if (sync.action === 'replaced') logLine(`插件已更新到 v${sync.to}：「随版本更新」开启 → 行事准则已替换为新版本默认内容（原为 v${sync.from}）`)
      else if (sync.action === 'created') logLine(`已写入默认行事准则：${agentsMdPath(root)}（v${sync.to}）`)
      else if (sync.error) logLine(`行事准则版本同步失败（不影响使用）：${sync.error}`)
      return true
    } catch (e) { logLine(`初始化记忆目录失败（${root}）：${e.message}`); return false }
  }

  /** 同上，但按 agent 取工作区（活 agent 路径：首次发起 MC 模式会话时用） */
  const ensureMemoryRoot = (agent) => ensureMemoryRootForCwd(workspaceOf(agent))

  /* ─────────── MC 模式：权限隔离 + 专属指导（用户 2026-09-16 要求）───────────
   * 判定"是不是 MC 模式"：`agentPresets.composedPreset(agent.ctx)` 落在配置的
   * `mcModePresets` 里。然后做三件事：
   *   ① 工具可见性：对这个 agent 挂 `tools.restrict`（隐藏 mc_admin_*，以及配置的白/黑名单）
   *   ② 工具执行：注册**全局 guard** 硬拒 mc_admin_*（即使隐藏失效也调不动）
   *   ③ 提示词：注入 whale_craft 专属指导（宿主的 AGENTS.md 注入之外，另加这一段）
   * ------------------------------------------------------------------------ */

  /** 自动创建 preset 时的显示名（preset.yml 里的 `name:`） */
  const MC_PRESET_NAME = 'MC模式'
  /**
   * 自动建出来的 preset 的简介。
   * 🔴 用户 2026-09-16 报："MC 模式的简介变成了和极简模式一样"——
   *    因为官方 `copy()` **只改 name、保留源 preset 的 description**（`copyComposition` 里的注释写得很清楚）。
   *    所以复制完必须把**元数据**改回来（`preset.yml` 是显示文本，不是 composition，可以自己写）。
   */
  const MC_PRESET_DESCRIPTION = '可以加入Minecraft Java版服务器，模拟玩家进行交互。'

  /** `~` 开头的 preset 根展开成绝对路径（宿主的 root 配置允许写 `~`） */
  /**
   * 自动建出来的 preset 的**人设**（persona）。
   *
   * 🔴 用户给的**定稿原文**（2026-09-16，一个字都不许改）：
   *    "你在一台真实的 Minecraft Java 版服务器里扮演一名玩家：你的"身体"是一台无头机器人，
   *     能观察世界、移动、挖掘和建造。"
   *
   * 从前那句 "You are a helpful software engineer assistant." 来自我们复制的官方 `minimal`。
   * 这里只写**身份 + 能力**；规矩（称呼/记忆/看门狗/指令/边界）全在 `.whale-craft/RULES.md`，不重复。
   * 系统提示词**由宿主按这个 preset 自动注入**，插件不再自己往 systemPrompt 里塞（用户要求）。
   */
  const MC_PERSONA_TEXT = '你在一台真实的 Minecraft Java 版服务器里扮演一名玩家：你的"身体"是一台无头机器人，能观察世界、移动、挖掘和建造。'

  const expandHome = (p) => {
    const s = String(p ?? '')
    return s.startsWith('~') ? join(homedir(), s.slice(1).replace(/^[/\\]+/, '')) : s
  }

  /** 只有**我们建的**那份才修：persona 键名对不对（以"本版本源 preset"为标尺） */
  const repairPersonaKeyIfNeeded = (svc, id, { composition, sourceKey, mine, stillComplete }) => {
    const mineKey = personaTextKeyOf(composition)
    if (!mine || composition === null) return false
    if (!((sourceKey && mineKey !== sourceKey) || stillComplete)) return false
    const fixed = patchMcPresetComposition(svc, id, { key: sourceKey ?? null })
    logLine(fixed
      ? `MC 模式 preset「${id}」persona 键名与本版本不符（${mineKey ?? '认不出'} → ${sourceKey ?? '跟随文件'}${stillComplete ? '，且 complete 还是 true' : ''}）→ 已自动修正`
      : `MC 模式 preset「${id}」persona 键名需要修正，但这次没改成（下次启动再试；必要时手动编辑 agent.cordis.yml）`)
    return fixed
  }

  /**
   * 复制完官方 preset 之后，把**我们自己的几处**覆盖上去：
   *   ① persona（官方那句 "You are a helpful software engineer assistant." + `complete: true` 都不要）
   *   ② 关掉那个持久 shell（MC 模式的指导写着"本模式没有 shell"，两边必须一致）
   *   ③ 补齐 MC 模式需要的组 —— 官方 `minimal` 里一个都没有：
   *      · 工具组 tool-fs / tool-jobs / present
   *      · 压缩组 compaction（`/compact` 指令 + 自动压缩；2026-09-22 用户真机投诉"压缩上下文没了"）
   * @param {string} id 目标 preset
   * @param {{key?: 'prefix'|'text'|null}} [opts] `key` = **本版本源 preset 用的那个键**（新版 prefix / 老版 text）
   * @returns {boolean} 是否改动过（false = 结构不认识 / 无需改动，日志里说明）
   */
  const patchMcPresetComposition = (svc, id, opts = {}) => {
    try {
      const dir = mcPresetDir(svc, id)
      if (!dir) return false
      const p = join(dir, 'agent.cordis.yml')
      if (!existsSync(p)) return false
      const cur = readFileSync(p, 'utf8')
      const withPersona = patchPersonaInComposition(cur, MC_PERSONA_TEXT, opts)
      if (withPersona === null) { logLine('MC 模式 preset：composition 里没找到可用的 persona 段 → 保持原样（人设还是官方那句）'); return false }
      let finalText = disableShellInComposition(withPersona) ?? withPersona
      finalText = patchToolGroupsIntoComposition(finalText, availableToolGroups()) ?? finalText
      if (finalText === cur) return false
      writeFileSync(p, finalText, 'utf8')
      return true
    } catch (e) { logLine(`改 preset 的 persona/shell/工具组失败（不影响挂载）：${e.message}`); return false }
  }

  /**
   * 这份部署里**能加载哪些** MC 模式需要的工具组？
   *
   * 为什么要探：这些包是按 preset 挂载的，"在不在"取决于 DSH 版本与随附 bundle。
   * 给一份**装不到某个包**的 preset 加组 = 让那份 preset 直接挂不起来（MC 模式整个坏掉）——
   * 比"少一个工具"糟得多。判据很直接：**随附的 preset 里有没有人引用它**
   * （随附 Web 的 standard/ptc/cordis 有 tool-fs/tool-jobs/present，minimal 一个都没有）。
   */
  let availableGroups = null
  const availableToolGroups = () => {
    if (availableGroups) return availableGroups
    const shipped = []
    try {
      for (const row of agentPresetsSvc?.list?.() ?? []) {
        const text = compositionOf(row)
        if (text) shipped.push(text)
      }
    } catch { /* 读不到就当没有 */ }
    const all = shipped.join('\n')
    availableGroups = MC_PRESET_TOOL_GROUPS.filter((g) => all.includes(g.pkg))
    const missing = MC_PRESET_TOOL_GROUPS.filter((g) => !all.includes(g.pkg)).map((g) => g.pkg)
    if (missing.length) logLine(`这些工具包在本部署的 preset 里没人引用 → 不往 MC 模式 preset 里加：${missing.join(', ')}`)
    return availableGroups
  }

  /** 给**已存在**的 preset 补工具组（用 `leave`/`meta` 分支时用；不动别的行） */
  const ensureToolGroupsInPreset = (svc, id) => {
    try {
      const groups = availableToolGroups()
      if (!groups.length) return false
      const dir = mcPresetDir(svc, id)
      if (!dir) return false
      const p = join(dir, 'agent.cordis.yml')
      if (!existsSync(p)) return false
      const cur = readFileSync(p, 'utf8')
      const next = patchToolGroupsIntoComposition(cur, groups)
      if (next === null) return false
      writeFileSync(p, next, 'utf8')
      logLine(`已给 MC 模式 preset（${id}）补上工具组：${groups.filter((g) => !cur.includes(g.pkg)).map((g) => g.pkg).join(', ')}`)
      return true
    } catch (e) { logLine(`补 preset 工具组失败（不影响挂载）：${e.message}`); return false }
  }

  /** preset 目录（用户可写根下那个），拿不到就 null */
  const mcPresetDir = (svc, id) => {
    try {
      const roots = Array.isArray(svc?.roots) ? svc.roots : []
      const userRoot = roots.find((r) => r?.trust === 'user')?.path
      return userRoot ? join(expandHome(userRoot), id) : null
    } catch { return null }
  }

  /** 读组成文本（`list()` 给的行里有 path = composition 文件） */
  const compositionOf = (row) => {
    try {
      const p = row?.path
      return p && existsSync(p) ? readFileSync(p, 'utf8') : null
    } catch { return null }
  }
  const hash16 = (s) => (s == null ? null : createHash('sha256').update(String(s)).digest('hex').slice(0, 16))

  /**
   * 把 `preset.yml`（显示名 / 简介 / 排序）写回去。
   * ⚠️ 只写**元数据**：composition（`agent.cordis.yml`）一根手指都不碰 ——
   *    官方 authoring 只允许"整目录复制"，但显示文本本来就是给人改的。
   */
  const writeMcPresetMetadata = (svc, id) => {
    try {
      const dir = mcPresetDir(svc, id)
      if (!dir || !existsSync(dir)) return false
      const body = [
        `name: ${JSON.stringify(MC_PRESET_NAME)}`,
        `description: ${JSON.stringify(MC_PRESET_DESCRIPTION)}`,
        'order: 5',
        '',
      ].join('\n')
      writeFileSync(join(dir, 'preset.yml'), body, 'utf8')
      return true
    } catch (e) { logLine(`写 preset 简介失败（不影响使用）：${e.message}`); return false }
  }

  /**
   * 我们的"自建标记"：写在 preset 目录里（dot 文件，宿主不认它是 preset 内容）。
   * 作用：**下次启动能认出自建的那份**，从而"检查不对就重建"；用户改过的一律不碰。
   * 文件名故意带 `.json` 与点前缀 —— preset id 规则 `/^[a-z0-9][a-z0-9-]*$/` 不含点，
   * 所以它在 discovery 眼里根本不是 preset 槽位。
   */
  const MC_PRESET_MARKER = '.whale-craft.json'
  const writeMcPresetMarker = (svc, id, { source, composition }) => {
    try {
      const dir = mcPresetDir(svc, id)
      if (!dir || !existsSync(dir)) return false
      writeFileSync(join(dir, MC_PRESET_MARKER), JSON.stringify({
        createdBy: 'whale_craft',
        spec: MC_PRESET_SPEC,
        at: new Date().toISOString(),
        source: source ?? null,
        compositionHash: hash16(composition),
        name: MC_PRESET_NAME,
        description: MC_PRESET_DESCRIPTION,
      }, null, 2) + '\n', 'utf8')
      return true
    } catch { return false }
  }
  const readMcPresetMarker = (svc, id) => {
    try {
      const dir = mcPresetDir(svc, id)
      if (!dir) return null
      const p = join(dir, MC_PRESET_MARKER)
      return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
    } catch { return null }
  }

  /** 宿主 agentPresets 服务（可能晚就绪 → 必须走 inject 等，别用 apply 时的 ctx.get） */
  let agentPresetsSvc = null
  ctx.inject(['agentPresets'], (scope) => {
    agentPresetsSvc = scope.get('agentPresets') ?? null
    // 🔴 同上：preset 自检/自建失败只能记日志，不能让 rejection 漏出去（fail-loud → exit(1)）
    void ensureMcPreset().catch((e) => logLine(`MC 模式 preset 自检失败（不影响启动）：${e?.message ?? e}`))
  })

  /**
   * **MC 模式 preset 的初始化自检**（用户 2026-09-16 定，两次追加要求）：
   *   ① 没有 → 自动建一个（复制官方 preset）
   *   ② 有 → **检查对不对**：显示名/简介/排序、以及"组成是否还等于我们当初复制的那份"
   *      · 我们自己建的 + 用户没改过 + 规格/官方源变了 → **重建**（先备份成 `<id>.bak-<时间>`）
   *      · 我们自己建的但**组成被改过** → **绝不动**（用户改的就是用户的）
   *      · 不是我们建的，只有"简介明显是复制残留"才修显示文本
   *
   * 🔴 **只能用宿主官方接口 `agentPresets.copy/remove`**：官方 authoring 明令
   *    "只允许整目录复制已有 preset，调用方不得提供 composition 文本"
   *    （`agent-presets/src/authoring.ts` 头注释）。
   * 🔴 `ensureMcPreset:false` 可关；没有可写根（`authorable:false`）就跳过并说明。
   */
  let presetEnsureTried = false
  const ensureMcPreset = async () => {
    if (presetEnsureTried) return
    if (pluginConfig.get('ensureMcPreset') !== true) return
    const svc = agentPresetsSvc
    if (!svc || typeof svc.list !== 'function' || typeof svc.copy !== 'function') return
    presetEnsureTried = true
    try {
      if (svc.authorable === false) {
        logLine('MC 模式 preset 需要"用户可写的 preset 根"，但这份部署没有 → 跳过自动创建（请手动建一个）')
        return
      }
      const list = await svc.list()
      const rows = new Map((list ?? []).map((p) => [String(p?.id ?? ''), p]))
      const ids = [...rows.keys()].filter(Boolean)
      const wanted = pluginConfig.mcModePresets
      const existingId = wanted.find((id) => rows.has(id))
      const source = pickPresetSource(ids, svc.defaultId)

      if (existingId) {
        const row = rows.get(existingId)
        const dir = mcPresetDir(svc, existingId)
        const marker = readMcPresetMarker(svc, existingId)
        const composition = compositionOf(row)
        const shippedDescs = PREFERRED_PRESET_SOURCES.map((sid) => rows.get(sid)?.description)
        const plan = planPresetAction({
          exists: true,
          marker,
          compositionHash: hash16(composition),
          // 源变了才重建：拿**我们当初记的源**（marker.source）当前的组成来比
          sourceHash: hash16(compositionOf(rows.get(String(marker?.source ?? source ?? '')))),
          metaOk: String(row?.name ?? '') === MC_PRESET_NAME && String(row?.description ?? '') === MC_PRESET_DESCRIPTION,
          shippedDescriptionMatch: isCopiedPresetDescription(row?.description, shippedDescs),
        })
        if (plan.action === 'leave') {
          logLine(`MC 模式 preset「${existingId}」检查通过，不动它（${plan.reason}）`)
          // 只有一件例外：**补 present 组**（显式文件交付）—— 删掉 mc_kit_share 之后，这是
          // "让本地用户看到产出文件"的唯一正路；只做"没有才加"，不动别的行。
          ensureToolGroupsInPreset(svc, existingId)
          /* 🔴 启动自检之二（用户 2026-09-17）：**persona 的键名必须跟本版本的源 preset 一致** ——
           * 新版 DSH 要 `prefix`、老版要 `text`（我们曾写死 prefix，把老环境的 preset 建坏了：
           * 加载即 `$text missing required value`，MC 模式直接切不进去）。 */
          try {
            const sourceKey = personaTextKeyOf(compositionOf(rows.get(String(marker?.source ?? source ?? ''))))
            repairPersonaKeyIfNeeded(svc, existingId, {
              composition,
              sourceKey,
              mine: marker !== null || isCopiedPresetDescription(row?.description, shippedDescs),
              stillComplete: /^\s{2,}complete\s*:\s*true\s*$/m.test(String(composition ?? '')),
            })
          } catch (e) { logLine(`persona 键名自检失败（不影响启动）：${e?.message ?? e}`) }
          return
        }
        if (plan.action === 'meta') {
          const fixed = writeMcPresetMetadata(svc, existingId)
          // 旧版（没有自建标记）建的那份：**只在组成与某个官方源逐字相同**时才动 persona/shell ——
          // 「简介是复制残留」+「组成没被改过」两条同时成立，才敢认它是我们早期复制出来的。
          let fixedComp = false
          if (marker === null && composition !== null) {
            // 🔴 判据不看"和官方源逐字相同"（DSH 一升级就比不上了），而看**那句官方 persona 还在不在**
            //    —— 这才是真正有害的状态（它带着 complete:true / includeRuntimeContext:false，
            //    会把我们注入的 context 段整个压掉）。用户改过人设的 preset 不会被碰。
            const stillShippedPersona = /You are a helpful software engineer assistant\./.test(composition)
              && /complete:\s*true/.test(composition)
            if (stillShippedPersona) fixedComp = patchMcPresetComposition(svc, existingId, { key: personaTextKeyOf(compositionOf(rows.get(source))) })
          }
          logLine(`MC 模式 preset「${existingId}」${plan.reason} → 已修好显示名/简介`
            + `${fixedComp ? '，并把 persona 换成 MC 的、关掉了 shell' : ''}`
            + `${fixed ? '' : '（⚠️ 写入失败，请手动编辑 preset.yml）'}`)
          // 旧版建的那份没有标记 → 修完补一个（hash 取**修完**之后的组成），下次才算"我们的"
          if (marker === null) {
            writeMcPresetMarker(svc, existingId, {
              source: marker?.source ?? source,
              composition: compositionOf(rows.get(existingId)) ?? composition,
            })
          }
          ensureToolGroupsInPreset(svc, existingId)
          // 同一件事也在这条路上做一遍：显示名/简介要修的那份，persona 键名可能也是坏的
          try {
            repairPersonaKeyIfNeeded(svc, existingId, {
              composition,
              sourceKey: personaTextKeyOf(compositionOf(rows.get(String(marker?.source ?? source ?? '')))),
              mine: marker !== null || isCopiedPresetDescription(row?.description, shippedDescs),
              stillComplete: /^\s{2,}complete\s*:\s*true\s*$/m.test(String(composition ?? '')),
            })
          } catch (e) { logLine(`persona 键名自检失败（不影响启动）：${e?.message ?? e}`) }
          return
        }
        // plan.action === 'rebuild'：先备份整个目录，再用官方接口重新复制一遍
        let backup = null
        try {
          if (dir && existsSync(dir)) {
            backup = `${dir}.bak-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
            renameSync(dir, backup)
          }
          await svc.copy(String(marker?.source ?? source), existingId, MC_PRESET_NAME)
          patchMcPresetComposition(svc, existingId, { key: personaTextKeyOf(compositionOf(rows.get(String(marker?.source ?? source)))) })
          writeMcPresetMetadata(svc, existingId)
          writeMcPresetMarker(svc, existingId, { source: marker?.source ?? source, composition: compositionOf(rows.get(String(marker?.source ?? source ?? ''))) })
          logLine(`MC 模式 preset「${existingId}」${plan.reason} → 已重建${backup ? `（旧的备份在 ${backup}）` : ''}`)
        } catch (e) {
          // 重建失败：把备份放回去，别把用户坑在"什么都没有"的状态
          try { if (backup && !existsSync(dir)) renameSync(backup, dir) } catch { /* 尽力而为 */ }
          logLine(`MC 模式 preset 重建失败（已回滚）：${e?.message ?? e}`)
        }
        return
      }

      // preset id 必须是目录名（宿主 `PRESET_ID = /^[a-z0-9][a-z0-9-]*$/`）——
      // 所以默认名单里的 `whale_craft`（下划线）**永远不可能是 preset id**，只能建 `minecraft` 这种。
      const target = pickPresetTarget(wanted)
      if (!target) {
        logLine(`没找到 MC 模式 preset，而 mcModePresets 里没有**合法**的 preset id（${wanted.join(' / ')}）→ 跳过`)
        return
      }
      if (!source) {
        logLine(`没找到 MC 模式 preset，且找不到可复制的官方 preset 源（现有：${ids.join(' / ') || '（空）'}）→ 跳过`)
        return
      }
      await svc.copy(source, target, MC_PRESET_NAME)
      // 复制完立刻打我们的补丁：persona 换成 MC 的、关掉那个 shell（否则就是"软件助手"+一个 pwsh）
      const patched = patchMcPresetComposition(svc, target, { key: personaTextKeyOf(compositionOf(rows.get(source))) })
      // copy() 会**保留源 preset 的简介**（官方只改 name）→ 必须把元数据改回来，否则简介跟极简模式一样
      const meta = writeMcPresetMetadata(svc, target)
      // 留个"这是我们建的"标记（含规格版本 + 组成 hash）→ 下次启动才能"检查不对就重建"
      const marked = writeMcPresetMarker(svc, target, {
        source,
        composition: compositionOf((await svc.list())?.find?.((p) => String(p?.id ?? '') === target)),
      })
      logLine(`已自动创建「${MC_PRESET_NAME}」preset：复制官方 ${source} → ${target}`
        + `${meta ? '（简介已改）' : '（⚠️ 简介没改成，请手动编辑 preset.yml）'}`
        + `${patched ? '（persona 已换成 MC 的、shell 已关）' : '（⚠️ persona/shell 没改成，请手动看一眼 agent.cordis.yml）'}`
        + `${marked ? '' : '（⚠️ 没留下自建标记，下次不会自动维护它）'}`
        + `；想改就编辑 ${expandHome(String(svc.roots?.find?.((r) => r?.trust === 'user')?.path ?? '$DSH_HOME/.agent-presets'))}/${target}/`
        + `，想关掉自动创建设 ensureMcPreset=false`)
    } catch (e) {
      logLine(`自动创建 MC 模式 preset 失败（不影响其它功能）：${e?.message ?? e}`)
    }
  }

  /** 诊断用：每个 agent 最近一次看到的 preset id（`/api/mc/mode` 会报出来） */
  const lastPresetSeen = new WeakMap()

  const isMcModeAgent = (agent) => {
    if (!agent?.ctx) return false
    try {
      // 服务可能晚就绪 / `ctx.inject` 没跑到 → **现场再拿一次**。
      // 🔴 以前只认 inject 抓到的那个引用：一旦它还是 null，isMcModeAgent 就永远 false，
      //    表现就是"按钮有、提示词没有、隔离也不生效"（2026-09-16 真机事故的同一家族）。
      let svc = agentPresetsSvc
      if (!svc) { try { svc = agent.ctx.get('agentPresets') } catch { svc = null } }
      if (!svc) { try { svc = ctx.get('agentPresets') } catch { svc = null } }
      const id = svc?.composedPreset?.(agent.ctx)
      if (typeof id === 'string' && id) lastPresetSeen.set(agent, id)
      return pluginConfig.isMcModePreset(id)
    } catch { return false }
  }

  /**
   * 看门狗的**模式闸门**：只有"仍然是 MC 模式"的会话才允许它往会话里注入。
   *
   * 🔴 同类残留（2026-09-17）：狗是**黏**的 —— `armed` 挂在会话实例上，切模式不会自动关它，
   *    于是切回普通模式后它仍会把"有人叫你 / 你被打了一下"注进一个已经不是 MC 模式的会话。
   *    闸门按**现场判据**（preset）开关：切出闭嘴、切回自动恢复（不必重新 arm）。
   * @param sess - McSession（闸门在注入那一刻读 `sess.watchdog.agent`）
   * @returns {() => boolean} 供 `Watchdog#gate` 用的回调
   */
  const watchdogGate = (sess) => () => isMcModeAgent(sess?.watchdog?.agent)

  /** 取某个 agent scope 上的 tools 服务：restrict **必须**用 scoped 服务，否则会被宿主拒绝 */
  const scopedTools = (agentCtx) => {
    const pickers = [() => agentCtx.get('tools'), () => agentCtx.tools]
    for (const pick of pickers) {
      try {
        const t = pick()
        if (t && typeof t.restrict === 'function') return t
      } catch { /* 该 scope 没 inject 时属性访问会抛，换下一种拿法 */ }
    }
    return null
  }

  /* 🔴 2026-09-16：这里原来有一段"麦块模式专属指导"（通过系统提示注入）。
   * 用户要求**删掉显式注入**，而且它的内容（单对话 / 记忆 / 看门狗 / 指令是最后手段 / 别乱挖乱建）
   * 已经全部写在 `.whale-craft/AGENTS.md`（Master 亲自给的那版）里 —— 留着就是重复。 */

  /** 这个 agent 是否已经应用过 MC 模式策略（WeakSet：一个 agent 只做一次） */
  const mcPolicyApplied = new WeakSet()

  /**
   * MC 模式工具白名单的**撤销手柄**：`tools.restrict()` 返回的 disposer。
   *
   * 🔴 2026-09-17 修（用户报的"标准模式会话无法执行命令"）：`restrict()` 是**黏**的 ——
   *    它挂在 agent scope 上，**会话不死就不消失**；而我们以前把返回的 disposer 丢掉了，
   *    `agent-preset/selected` 又只"套用"不"撤销" ⇒ 从 MC模式 切回 标准模式 的会话
   *    会一直留着 MC 白名单（没有 pwsh/bash），看起来就像"标准模式坏了"。
   *    真机复现：`session-55d48701`（standard → 04:51 切 minecraft → 06:34 切回 standard，
   *    之后那个"标准模式"会话的工具面仍是 mc_* + read/write/edit/read_image/present）。
   *    现在：切到非 MC 模式 → `release()` 摘掉白名单，并从 `mcPolicyApplied` 里删掉，
   *    这样再切回 MC模式 还能重新套上。
   *    （只有白名单是黏的：admin/文件越界那两道在 **guard** 里，每次调用现场判 `isMcModeAgent`，
   *      切模式立刻自愈，不需要撤销。）
   */
  const mcRestrictRelease = new WeakMap()

  /**
   * 已确认属于 MC 模式的会话 id（给前端 `/api/mc/mode` 兜底用）。
   * 主路径是现场问 `agentPresets`（见 handleMcApi 的 /api/mc/mode），
   * 这里只是"agent 已经不在了 / 拿不到 agentPresets"时的退路。
   */
  const mcModeAgentIds = new Set()
  /** 因为"没选中工作区"被拒绝进入 MC 模式的会话（`/api/mc/mode` 用它报原因） */
  const noWorkspaceRefused = new Set()

  const applyMcModePolicy = (agent) => {
    if (!agent || mcPolicyApplied.has(agent)) return
    if (!isMcModeAgent(agent)) return
    // 🔴 用户 2026-09-16："如果没有选中工作区，则拒绝发起 MC 模式会话和设置。"
    //    没有工作区 → `.whale-craft/`（记忆 + 提示词）无处安放 → 不当成 MC 会话：
    //    不套隔离、不注入专属提示词、前端也会隐藏「MC设置」入口（/api/mc/mode 会带 reason）。
    if (!workspaceOf(agent)) {
      if (agent.id) noWorkspaceRefused.add(String(agent.id))
      logLine(`拒绝启用 MC 模式：这个会话没有选中工作区（.whale-craft 与提示词要建在工作区里）`)
      return
    }
    mcPolicyApplied.add(agent)
    if (agent.id) mcModeAgentIds.add(String(agent.id))
    ensureMemoryRoot(agent)        // ← 首次发起 MC 模式会话 = 建 `.whale-craft/`（README / RULES.md）的时机
    // 🔴 2026-09-18：**这里不再投提示词**。投递搬到"每个请求组装之前"（`agent/pre-step` → `reconcileNotices`），
    //    因为模式在第一次请求之前还可能被改（宿主允许空白期反复切 preset）。
    //    这条日志只是"模式已生效"的标记；真投出去时 `reconcileNotices` 自己会记一行。
    logLine(`MC 模式生效（preset=${lastPresetSeen.get(agent) ?? '?'}，${agent.id}）提示词将在首次请求组装前投递`)

    // ② 工具可见性：**白名单**（用户 2026-09-16 真机投诉："这个 agent 怎么还能用 pwsh！不是只暴露我们指定的工具吗！"）
    //
    // 🔴 以前是"allowOtherTools 非空才走白名单"——默认为空 ⇒ 只 deny 了我们自己的管理工具，
    //    宿主那一堆工具（pwsh / subagent / workflow / serve_* / web_* …）**全都还在**。
    //    那不是"隔离"，只是"藏了自家两个工具"。现在**无条件白名单**：
    //      我们自己的非管理工具（mc_* / mc_kit_*）+ **文件工具**（会被 guard 限在 .whale-craft/ 内）
    //      + 配置里额外允许的其它工具。
    try {
      const t = scopedTools(agent.ctx)
      if (!t) { logLine('MC 模式：拿不到 scoped tools，跳过可见性限制（guard 仍会硬拒）'); return }
      const { allowOtherTools, hideAdminTools } = pluginConfig.mcMode
      const adminNames = ourToolNames.filter((n) => n.startsWith('mc_admin_'))
      const wanted = [
        ...ourToolNames.filter((n) => !n.startsWith('mc_admin_')),
        ...(hideAdminTools ? [] : adminNames),
        ...MC_FILE_TOOLS,
        MC_PRESENT_TOOL,
        ...allowOtherTools,
      ]
      // 🔴 `tools.restrict()` 对**不认识的工具名是抛错**的（宿主 index.ts:1078 拿 restrictableNames 校验）。
      //    而"哪些文件工具在场"取决于 preset 挂了哪些工具包（本机这份 preset 只挂了 tool-fs，
      //    **没有** tool-fs-search ⇒ `glob`/`grep` 不存在）。要是让一个不存在的名字把整次调用炸掉，
      //    结果就是"白名单没生效、pwsh 照样能用"—— 正是用户投诉的那个症状。
      //    所以：**失败 → 从宿主的报错里读出"它认识的名字"，过滤一次再试**（只重试一次，之后才认输）。
      const applyAllow = (names) => {
        try {
          return { allow: names, release: t.restrict({ allow: names }) }
        } catch (e) {
          const knownPart = /known global tools:\s*([\s\S]*)$/.exec(String(e?.message ?? ''))
          const known = new Set((knownPart?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean))
          const usable = names.filter((n) => known.has(n))
          if (!known.size || !usable.length) throw e
          const release = t.restrict({ allow: usable })
          logLine(`MC 模式：白名单里有宿主不认识的名字（${names.filter((n) => !known.has(n)).join(', ')}）→ 已按实际在场的工具过滤`)
          return { allow: usable, release }
        }
      }
      const { allow, release } = applyAllow(wanted)
      // 存下撤销手柄（切出 MC 模式时用；见 mcRestrictRelease 的说明）
      mcRestrictRelease.set(agent, release)
      logLine(`MC 模式：工具白名单已生效（${agent.id}）：${allow.join(', ')}`)
    } catch (e) {
      logLine(`MC 模式工具白名单**没生效**（${String(e?.message).slice(0, 160)}）—— 管理工具与文件越界仍由 guard 兜底`)
    }
  }

  /**
   * 退出 MC 模式：**把工具白名单摘掉**（切回普通模式必须能再用 pwsh/bash）。
   *
   * 🔴 2026-09-17 新增（用户报的"标准模式会话无法执行命令"）：`applyMcModePolicy` 是"只套一次"
   *    （`mcPolicyApplied`），而**没有任何地方撤销** —— 从 MC模式 切回 标准模式 的会话就永久
   *    留在 MC 白名单里。这里与其对称：套用/撤销都由 `touch()` 按**现场判据**决定。
   *
   * 幂等：没套过就什么都不做（`mcRestrictRelease` 里没有手柄）。
   * 撤销后 `mcPolicyApplied` 也删掉 → 再切回 MC模式 能重新套上。
   * @param agent - 宿主 Agent 对象（WeakMap 键，不阻止回收）
   */
  const liftMcModePolicy = (agent) => {
    if (!agent) return
    // 这个会话已经不是 MC 模式了 → "因没选工作区被拒绝"的旧标记也一起清掉
    if (agent.id) noWorkspaceRefused.delete(String(agent.id))
    // ① 撤回提示行（还没投递的直接删；已经进对话的补一条作废声明）——见 withdrawAgentsMdNotices
    try { withdrawAgentsMdNotices(agent) } catch (e) { logLine(`撤回 MC 提示行失败：${e?.message ?? e}`) }
    // ② 看门狗：armed 挂在会话实例上、切模式不会自动关 → 关掉它的**注入闸门**
    //    （不 disarm：切回 MC 模式时自动恢复，不用重新 arm）
    try {
      const wd = agent.id ? registry.peek(String(agent.id))?.watchdog : null
      if (wd?.armed) logLine(`本会话已退出 MC 模式：看门狗注入已闸掉（仍 armed，切回 MC 模式即恢复）`)
    } catch { /* 只是记一行日志，失败无所谓 */ }
    const release = mcRestrictRelease.get(agent)
    if (release) {
      mcRestrictRelease.delete(agent)
      try { release() } catch (e) { logLine(`撤销 MC 模式工具白名单失败（guard 仍会兜底）：${e?.message ?? e}`) }
    }
    if (mcPolicyApplied.has(agent)) {
      mcPolicyApplied.delete(agent)
      if (agent.id) mcModeAgentIds.delete(String(agent.id))
      logLine(`已退出 MC 模式（preset=${lastPresetSeen.get(agent) ?? '?'}，${agent.id ?? '?'}）：工具白名单已撤销`)
    } else if (release) {
      logLine(`已撤销 MC 模式工具白名单（${agent.id ?? '?'}）`)
    }
  }

  // ③ 硬保证（不管可见性怎样）：管理工具调不动 + **文件工具只能碰 `<工作区>/.whale-craft/`**
  try {
    ctx.tools.guard((exec) => {
      const name = String(exec?.name ?? '')
      if (!isMcModeAgent(exec?.agent)) return undefined

      // ① 管理工具：MC 模式一律拒绝（隐藏之外再上一道硬锁）
      if (name.startsWith('mc_admin_')) {
        return 'MC 模式会话不能读取或修改 whale_craft 配置——请在普通会话里用 mc_admin_config 改。'
      }

      if (/^(read|edit|write|glob|grep|ls|cat|read_image|mc_kit_memory)$/i.test(name)) {
        const args = exec?.arguments ?? {}
        const text = JSON.stringify(args)
        if (/(\.credentials|credentials\.yaml|[/\\]\.dsh[/\\])/i.test(text)) {
          return 'MC 模式不允许触碰宿主凭据文件；账号密码在「MC设置」里维护，AI 不需要也不应该看到。'
        }
        // ② 明文凭据备忘（`secrets/` 下用户自己的私密档）：同样不许读
        //    （2026-09-16：账户体系上线后，密码只该待在「MC设置 → 账户」里）
        if (/[/\\]secrets[/\\]/i.test(text)) {
          return 'MC 模式不允许读凭据备忘目录（secrets/）；账号密码在「MC设置 → 账户」里维护，AI 不需要也不应该看到。'
        }
        if (isAgentsMdPath(text)) {
          return '行事准则（.whale-craft/RULES.md）是给 Master 编辑的，AI 不能读写它（要改请在「MC设置 → 提示词」里改）。'
        }
      }

      // ③ 🔴 用户 2026-09-16："读写文件都只能在记忆文件夹内！"
      //    文件工具（read/write/edit/read_image/glob/grep）的路径一律解析到
      //    `<工作区>/.whale-craft/` 之内；**没给路径也算越界**（glob/grep 不给路径 = 扫整个工作区）。
      const raw = fileToolPath(exec)
      if (raw !== null) {
        const root = memoryRootFor(workspaceOf(exec?.agent))
        const rel = String(raw ?? '').trim()
        if (!rel) {
          return `MC 模式的文件工具只能在记忆文件夹（${root}）里用——请显式给 .whale-craft/ 内的路径。`
        }
        const abs = resolve(root, rel)
        const prefix = root.endsWith(sep) ? root : root + sep
        if (abs !== root && !abs.startsWith(prefix)) {
          return `MC 模式只能在记忆文件夹（${root}）里读写文件；这个路径在外面：${rel}`
        }
      }

      // ④ `present`：**只能交付本会话工作区内的文件**（`.whale-craft/` 与 `out/` 都在里面）。
      //    宿主自己也要求"文件已存在且在工作区里"，这里只是把边界说清、给可读的拒绝理由。
      const delivering = presentPaths(exec)
      if (delivering !== null) {
        const wsRoot = workspaceRootFor(exec?.agent)
        const prefix = wsRoot.endsWith(sep) ? wsRoot : wsRoot + sep
        for (const rel of delivering) {
          const abs = resolve(wsRoot, rel)
          if (abs !== wsRoot && !abs.startsWith(prefix)) {
            return `present 只能交付本会话工作区（${wsRoot}）里的文件；这个路径在外面：${rel}`
          }
        }
      }
      return undefined
    })
  } catch (e) { logLine(`注册 MC 模式 guard 失败：${e.message}`) }

  // agent 建立 / 首轮开始 / **模式被选上** 时应用策略。
  // 🔴 2026-09-16 真机事故：只挂 `agent/created` + `agent/session-start` 是不够的 ——
  //    preset 完全可能在 agent 建好之后才选上（在会话里点「MC模式」芯片），宿主为这种情况
  //    专门发 **`agent-preset/selected`**（`agent-presets/src/index.ts` 里 emit，两个位置参数：
  //    `(sessionId, presetId)`）。当时没挂它 → 策略与提示词都不会生效。
  //    每个 agent 只做两件事：① 若是 MC 模式就投提示行并套白名单（applyMcModePolicy）
  //    ② **若不是 MC 模式就把白名单摘掉**（liftMcModePolicy，2026-09-17 补 —— 见 mcRestrictRelease）。
  ctx.effect(() => {
    const handlers = []
    const touch = (agent) => {
      if (!agent?.ctx) return
      // ⚠️ 这里**不再**建 `.whale-craft/` —— 建文件只发生在"首次发起 MC 模式会话"
      //    （applyMcModePolicy 里）和"点开 MC设置"（HTTP 接口里）这两个时机（用户 2026-09-16 定）。
      try {
        // 🔴 2026-09-17：**两个方向都要处理** —— 是 MC 模式就套用，**不是就撤销**。
        //    以前只"套用"，于是 MC模式 → 标准模式 的会话会一直留着 MC 白名单（没有 pwsh），
        //    表现就是"标准模式会话无法执行命令"（用户真机报的，见 mcRestrictRelease 的说明）。
        if (isMcModeAgent(agent)) applyMcModePolicy(agent)
        else liftMcModePolicy(agent)
      } catch (e) { logLine(`MC 模式策略失败：${e.message}`) }
    }
    for (const ev of ['agent/created', 'agent/session-start']) {
      try { handlers.push(ctx.on(ev, ({ agent } = {}) => touch(agent))) } catch { /* 宿主没有这个事件就跳过 */ }
    }
    // 模式被选上/切换：两个位置参数，agent 要自己找回来
    try {
      handlers.push(ctx.on('agent-preset/selected', (sessionId, presetId) => {
        // 🔴 两个方向都记：切到 MC模式 才进兜底名单，切走要**移出去**（否则前端入口判据会残留）
        if (pluginConfig.isMcModePreset(presetId)) mcModeAgentIds.add(String(sessionId))
        else mcModeAgentIds.delete(String(sessionId))
        touch(safeAgentById(sessionId))
      }))
    } catch { /* 老宿主没有这个事件 */ }

    /* 🔴🔴 2026-09-18 **提示词的挂载点**（用户："应该切换到正确的挂载点……而是在对话开始后设置
     *    工具/注入提示词"）。宿主给的时序是：`agent/created`（setup 完成 = preset 已 mount）
     *    → `agent/session-start` → **首次请求组装**，而 `agent/pre-step` 正是"消息已经被领走、
     *    系统提示词已经装好、这个 step 马上要发给模型"的那条**瀑布**
     *    （`core/agent-loop/src/agent.ts:240-258`；宿主自己的 `agent-instructions` 也挂在这条上同步上下文）。
     *
     *    为什么必须是这里：**模式在第一次请求之前仍然可能改** —— 宿主只禁止"已经跑过一轮"之后切换
     *    （`agent-presets/src/index.ts:709-728`，抛 `agent-preset/locked`），空白期可以反复切
     *    （真机 `session-be2e43d7`：seq3 切 MC、seq4 切回 standard）。在 `agent/created` 入队就会
     *    "按当时的模式投一份、之后模式变了而它已经排上队" —— 那正是"标准模式会话里冒出 MC 提示词"。
     *    挂在这里 ⇒ 投出去的每一份都是"**发起请求那一刻**这个会话真正在用的模式"，串模式从根上不可能。
     *
     *    幂等与去重见 `reconcileNotices`（按 preset 记账 + 会话日志回读 + 队列同名检查）。
     *
     * 🔴🔴 **`agent/pre-step` 是 cordis 的 waterfall 事件，监听器必须 `next()` 交棒。**
     *    0.1.4 首发版本这里写成 `({ agent } = {}) => { reconcileNotices(agent) }` —— 只声明了一个形参、
     *    也没有 `return`，于是 **没有调用 `next()`**。cordis 的语义是
     *    （`@deepseek-ai/cordis` 的 `waterfall()`）："a listener that does not call `next()` **vetoes
     *    the rest of the chain, including the built-in behavior**"，并且 waterfall 的返回值就是那个
     *    监听器的返回值 ⇒ 恒定 `undefined` ⇒ 宿主 `agent-loop` 下一行 `decision.kind` 直接
     *    `TypeError: Cannot read properties of undefined (reading 'kind')`。
     *    **后果是 P0 级**：`turn/start` 之后、`step/start` 之前就抛，**任意会话、任意模式、每一轮**都失败，
     *    装了插件就没法对话（真机 `whale_craft@0.1.4`，标准模式与 MC 模式一视同仁）。
     *
     *    正确写法（宿主自己的 `agent-instructions` 就是这么写的）：接第二个形参 `next` 并交棒，
     *    然后**用交棒拿回的结果做改写**（见下面 `enterWithNotices`）。
     *    且**无论对账成功与否都必须交棒**：抛错也不能否决整条链。
     * 教训：挂到 waterfall 之前，先读那个 dispatch 模式的契约，别只看事件签名。 */
    try {
      handlers.push(ctx.on('agent/pre-step', ({ agent } = {}, next) => {
        if (typeof next !== 'function') {
          // 万一宿主把这条改成普通 emit（不该发生）：别抛，记一行就走，绝不能带崩这一轮。
          try { reconcileNotices(agent) } catch (e) { logLine(`提示词对账失败（不打断本轮）：${e?.message ?? e}`) }
          return undefined
        }
        const inner = next()
        // 交棒一定发生；拿回内层 decision 后把提示行塞进**本步消息的最前面**（与用户那句同批送出）。
        if (inner && typeof inner.then === 'function') {
          return inner.then((decision) => enterWithNotices(agent, decision))
        }
        return enterWithNotices(agent, inner)
      }))
    } catch { /* 老宿主没有这条瀑布 */ }
    return () => { for (const off of handlers) { try { off?.() } catch {} } }
  }, 'whale_craft: mc-mode policy')

  /* ── 管理工具：只有**非 MC 模式**会话能用（MC 模式看不见 + 调了被 guard 拒）── */

  ctx.tools.register(asTool({
    name: 'mc_admin_config',
    description: '【管理】读写 whale_craft 的**全局配置**（服务器指令白名单、MC 模式的工具暴露、记忆目录…）。\n'
      + '⚠️ **只有非 MC 模式的会话能用**：麦块模式会话看不见、也调不动它（要改配置就在普通会话里改）。\n'
      + 'action：\n'
      + '· get（默认）看生效配置；给 path 只看某一项\n'
      + '· set   改一项（path + value）\n'
      + '· unset 删掉一项（回到默认值）· reset 全部恢复默认 · list 看默认值 + 生效值\n'
      + '可用键：`commandWhitelist`（字符串数组；支持 "tp" 精确名、"/^gi.*/" 正则、"*" 全放行）· '
      + '`mcModePresets`（哪些 preset 算 MC 模式）· `mcMode.allowOtherTools`（MC 模式白名单里**额外**放行的工具）· '
      + '`mcMode.hideAdminTools`（默认 true）· `expressMode`（文件分享：off 关闭 / online 在线）· '
      + '`expressBase`（在线模式的 base，如 https://example.com）· `memoryDir`。\n'
      + '改完**立即生效**，落在 `$DSH_HOME/whale_craft/config.json`。（白名单只能"收窄"，不能凭空添加 preset 没挂的工具。）',
    parameters: {
      action: { type: 'string', description: 'get（默认）/ set / unset / reset / list' },
      path: { type: 'string', description: '配置项点号路径，如 commandWhitelist 或 mcMode.allowOtherTools' },
      value: { type: 'json', description: 'set 用的值（数组 / 字符串 / 布尔 / 对象）' },
    },
    output: text(),
    async execute(args) {
      const action = String(args.action ?? 'get').toLowerCase()
      const info = { file: pluginConfig.file, lastError: pluginConfig.lastError ?? null }
      switch (action) {
        case 'get':
          return args.path
            ? { ...info, path: String(args.path), value: pluginConfig.get(args.path) }
            : { ...info, values: pluginConfig.values() }
        case 'set':
          return { ...info, ...pluginConfig.set(args.path, args.value) }
        case 'unset':
          return { ...info, ...pluginConfig.unset(args.path) }
        case 'reset':
          return { ...info, ...pluginConfig.reset() }
        case 'list':
          return { ...info, values: pluginConfig.values(), defaults: DEFAULT_CONFIG, mcModePresets: pluginConfig.mcModePresets }
        default:
          throw new Error(`未知 action："${action}"（可用 get/set/unset/reset/list）`)
      }
    },
  }))

  /* ─────────── 扩展点：其他 Agent 往 extensions/ 丢文件就能加工具 ───────────
   * 需求 6 的另一半："其他 Agent 要保留为它做扩展、写 Agent 的能力"。
   * 任何 .mjs 导出 `apply(api)` 即可；api 里给了 asTool / getSession / registry /
   * memory / ctx / config。这样别的会话可以给它加能力而**不用改这个文件**。
   * 说明文档：whale_craft/extensions/README.md
   * ------------------------------------------------------------------------ */

  ctx.effect(() => {
    const dir = fileURLToPath(new URL('./extensions/', import.meta.url))
    if (!existsSync(dir)) return
    let files = []
    try { files = readdirSync(dir).filter((f) => f.endsWith('.mjs') || f.endsWith('.js')) } catch { return }
    if (!files.length) return
    void (async () => {
      for (const f of files) {
        try {
          const mod = await import(new URL(`./extensions/${f}`, import.meta.url).href)
          if (typeof mod.apply === 'function') {
            await mod.apply({ ctx, config, registry, asTool, getSession, ensureWatchdog, memory, memoryFor, workspaceOf, logLine, Watchdog })
            const label = mod.name ?? f
            logLine(`扩展已加载：${label}`)
            ctx.logger?.info?.(`[whale_craft] 扩展已加载：${label}`)
          }
        } catch (e) {
          logLine(`扩展 ${f} 加载失败：${e.message}`)
          ctx.logger?.warn?.(`[whale_craft] 扩展 ${f} 加载失败：${e.message}`)
        }
      }
    })()
  }, 'whale_craft: extensions')

  /* ── 诊断 ── */

  ctx.tools.register(asTool({
    name: 'mc_diag',
    description: '诊断：当前会话的机器人内部状态（物理/控制位/收包/事件队列）——排查"走不动/收不到消息"用。'
      + '同时报**提示词注入状态**（`promptInjection`：三段提示词各自会不会注入、为什么不会）。',
    parameters: {},
    output: text(),
    async execute(args, exec) {
      const sess = getSession(exec)
      const injection = promptInjectionStatus(exec?.agent)
      const b = sess.bot.bot
      if (!b?.entity) return { online: false, lastError: sess.bot.lastError, mode: sess.mode, promptInjection: injection }
      return {
        online: true, version: b.version, physicsEnabled: b.physicsEnabled,
        controlState: { forward: b.controlState?.forward, jump: b.controlState?.jump, sneak: b.controlState?.sneak },
        velocity: b.entity.velocity, onGround: b.entity.onGround, inWater: b.entity.isInWater,
        position: { x: Math.floor(b.entity.position.x), y: Math.floor(b.entity.position.y), z: Math.floor(b.entity.position.z) },
        pendingEvents: sess.events.length, mode: sess.mode, stats: sess.bot.stats,
        connection: sess.bot.connectionView(),
        watching: sess.watchdog?.status() ?? null,
        promptInjection: injection,
      }
    },
  }))
}

export default { name, inject, Config, apply }
