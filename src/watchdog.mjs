// -*- coding: utf-8 -*-
/**
 * whale_craft / watchdog.mjs —— 事件看门狗（v2，2026-09-15 体系化重构）
 * ============================================================================
 * 用户 2026-09-15 的要求，逐条对应到实现：
 *
 *  · "从进游戏到离开前保持运行，进服自动打开、退服自动关闭，退服提醒 AI"
 *      → arm() / disarm()，由 mc_connect / mc_disconnect 自动调用；disarm 默认通知 AI。
 *        job 存活期 = 整局游戏（不再是"醒来一次就结算"）。
 *
 *  · "高度可配置，有默认配置，AI 调用工具修改"
 *      → WATCH_DEFAULTS + updateConfig(patch)，经 mc_config 工具读写。
 *
 *  · "受击/位置被动移动/捡到物品/死亡/被传送 是否唤醒"
 *      → wakeOn 矩阵，逐项开关（默认值见 WATCH_DEFAULTS，附理由）。
 *
 *  · "玩家提到什么唤醒（不硬编码）"
 *      → mentionPatterns 是**配置项**，AI 可用 mc_config 增删（学到新外号就记下来）。
 *
 *  · "唤醒后短时间内再发话算同话题，继续唤醒"
 *      → topicWindowSec：唤醒后这段时间内的发言按"延续话题"处理，直接再叫醒。
 *
 *  · "全服才两三个人，重视每个对话 / 说话时离得近算在对我说话"
 *      → wakeOn.nearbySpeech + nearRadius：近距说话不需要叫法。
 *
 *  · "可配置的心跳"
 *      → wakeOn.heartbeat + heartbeatSec。
 *
 *  · "被唤醒后要判断是否静观其变；玩家没反应超时后也要反应"
 *      → observeWindowMs：首次命中后先攒一小段（把连珠炮合并成一次唤醒，
 *        避免一句一醒烧 token）；followUpAfterSec：等不到下文再补一次提醒。
 *
 *  · "LLM 正在运行时应当成为中断管理器/事件记录器，记录改变，
 *     并在 LLM 合适时插话注入提示词，并暴露读取事件接口"
 *      → 运行中**不**打断，改为在下一步边界插话；事件同时留档在看门狗 log
 *        （mc_watch{action:'log'} 读）与 sess.events（mc_events 读）。
 *
 * 设计要点（2026-09-15 定稿，用户明确要求）：
 *
 *   ① **不用 job 结算来唤醒**——结算是一次性的，没法"在运行中插话"。
 *   ② **不用 followup 模拟用户发言**。`agent.followup()` 的宿主文档是
 *      "an ordinary follow-up turn … the sole ordinary message of its own turn"，
 *      即往对话里插一条**用户消息**；走 `sessionController.prompt({mode:'queue'})`
 *      效果一样（commands.ts 把 source 写死成 `{kind:'user'}`）。用户不要这个。
 *   ③ 改为 `agent.steer(plugin 来源的 message)`：
 *      · 文档："**An idle driver starts a turn**; a running driver consumes it at
 *        its next step boundary" —— **空闲起一轮 = 唤醒**，运行中下一步插话，两用都对；
 *      · `source: {kind:'plugin:whale_craft', form:'notice'}` → 宿主渲染成**折叠的一行摘要**，
 *        不是用户发言。这就是"提示词注入"。
 *   ④ 仍然是单脑——注入目标始终是**同一个** session。
 * ============================================================================
 */

import { userMessage, noticeSource } from './user-message.mjs'

/** 默认配置。括号里是"为什么默认这样"。 */
export const WATCH_DEFAULTS = {  /** 进服自动挂载（用户要求：进游戏自动打开） */
  autoArm: true,
  /** 退服时是否提醒 AI（用户要求：退出游戏会提醒 AI） */
  notifyOnDisarm: true,

  /** 唤醒条件矩阵。true = 这类事件叫醒我 */
  wakeOn: {
    mention: true,        // 命中叫法 —— 主通道
    nearbySpeech: true,   // 近距说话（无需叫法）—— 全服才两三个人，身边说话基本就是在跟我说话
    damage: true,         // 受击/低血 —— 要自卫/逃跑，不能装死
    death: true,          // 死亡 —— 必须知道，要复活/重连
    teleport: true,       // 位置瞬移 —— 多半是有人在动我
    pushed: false,        // 被推/水流 —— 太频繁，默认只记事件
    itemPickup: false,    // 捡到物品 —— 噪音最大，默认只记事件
    playerJoin: false,    // 有人上线
    playerLeave: false,   // 有人下线
    disconnect: true,     // 断线/被踢 —— 必须知道（用户 2026-09-19：断了 AI 却以为还在游戏里）
    heartbeat: false,     // 心跳（防睡死；开了要配 heartbeatSec）
  },

  /** 近距说话判定半径（格）。说话者在这个距离内 → 视为对我说话，不需要叫法 */
  nearRadius: 16,

  /** 心跳间隔（秒）；wakeOn.heartbeat 打开才生效 */
  heartbeatSec: 300,

  /** 观察窗口（毫秒）：首次命中后先攒这么久，把连珠炮合并成一次唤醒 */
  observeWindowMs: 2000,

  /** 唤醒后这段时间（秒）内的发言算"同话题延续"，直接再叫醒 */
  topicWindowSec: 120,

  /** 叫醒后等不到下文的补提醒（秒）；0 = 关闭 */
  followUpAfterSec: 45,

  /** 限流：每分钟最多叫醒几次（防公屏刷屏烧 token） */
  maxWakePerMinute: 6,

  /**
   * 叫法（正则片段，大小写不敏感）。**这是配置不是代码**——AI 可以用 mc_config
   * 增删（例如玩家给它起了外号，它记下来）。
   *
   * 🔴 这里**只放通用叫法**。2026-09-16 用户投诉过："为什么这台服务器上叫'auth'的记忆它有？"
   *    —— 之前默认值里写死了他私人的账号名/昵称，跟着开源副本一起公开了。
   *    账号自己的名字由 `learnName()` 在连接/挂载时**从登录档案现学**（不进源码）。
   */
  mentionPatterns: [
    'deepseek', 'deep\\s*seek', '\\bds\\b', '\\bdsh\\b', '\\bai\\b', 'agent',
    '机器人', '麦块',
  ],
}

/** 深拷贝（配置是嵌套对象，不能共享引用） */
const clone = (v) => JSON.parse(JSON.stringify(v))
/**
 * 构造注入用的 message（`src/user-message.mjs` 统一提供）。
 *
 * 关键在于 `source`：宿主要求 `ContextFormed`，用
 * `{kind:'plugin:whale_craft', plugin, form:'notice', summary}`
 * 会被渲染成**折叠的一行摘要**（"One-line account of what happened, shown without expanding
 * the row"），而**不是**用户发言 —— 这正是用户要的"提示词注入而非模拟用户发消息"。
 *
 * 🔴 2026-09-18：以前这里是「解析不到 `@deepseek-ai/dsh-llm` 就置 null → 退到
 *    sessionController.prompt 兜底」，而那条兜底是**用户来源**消息（会在对话里冒充用户说话）。
 *    现在统一走 `userMessage()`：宿主实现拿不到就用**自带等价实现**，永远轮不到那条兜底。
 */

/** 事件类型 → 中文标签（写进给 AI 的消息里） */
const LABEL = {
  mention: '有人喊我',
  nearbySpeech: '身边有人说话',
  damage: '我受到攻击/低血',
  death: '我死了',
  teleport: '我被传送了',
  pushed: '我被推动了',
  itemPickup: '我捡到东西',
  playerJoin: '有人上线',
  playerLeave: '有人下线',
  heartbeat: '心跳',
}

export class Watchdog {
  /**
   * @param {object} o
   * @param {object} o.ctx    宿主 ctx（要 jobs / sessionController / logger）
   * @param {object} o.sess   McSession（要 bot / events）
   * @param {object} o.agent  当前会话的 agent（注入消息用）
   * @param {Function} o.onFire 事件回调钩子（用于同步到 sess.events）
   */
  constructor ({ ctx, sess, agent, promptSignal = null }) {
    this.ctx = ctx
    this.sess = sess
    this.agent = agent
    /**
     * 注入用的 AbortSignal。
     *
     * 🔴 `sessionController.prompt` 是 **@Remote 方法**，签名 `(request, signal)` ——
     *    进程内直接调也**必须传 signal**，因为它第一行就是 `signal.throwIfAborted()`
     *    （`api/session-controller/src/index.ts:346`）。不传 → `undefined.throwIfAborted()`
     *    → "Cannot read properties of undefined (reading 'throwIfAborted')"。
     *    而这条注入路径是**空闲时唯一的叫醒通道**——一炸就等于永远叫不醒
     *    （2026-09-15 真机事故：喊我没反应）。
     */
    this.promptSignal = promptSignal ?? new AbortController().signal
    this.config = clone(WATCH_DEFAULTS)
    this.config.mentionPatterns = [...WATCH_DEFAULTS.mentionPatterns]

    this.jobId = null
    this.armed = false
    this.startedAt = 0
    this.tickTimer = null

    /** 待处理的命中事件（观察窗口内累积） */
    this.pending = []
    this.pendingSince = 0
    /** 最近一次唤醒 */
    this.lastWakeAt = 0
    this.lastWakeKind = null
    /** 唤醒时间戳队列（限流用） */
    this.wakeTimes = []
    /** 累计统计 */
    this.stats = { fired: 0, injected: 0, dropped: 0, suppressed: 0 }
    /** 事件留档（readOutput 与 mc_events 读） */
    this.log = []
    this.maxLog = 200

    /** 绑定的监听器（disarm 时摘掉） */
    this._listeners = []

    /**
     * **模式闸门**：只有"仍然是 MC 模式"的会话才允许注入（2026-09-17 补）。
     *
     * 🔴 同类残留事故：看门狗的 `armed` 挂在**会话实例**上，切模式不会自动关它 ——
     *    从「MC模式」切回普通模式后，它仍会把"游戏里有人叫你/你被打了一下"这类 MC 事件
     *    注进一个**已经不在 MC 模式**的会话（用户："开到 mc 模式再开回去标准，
     *    居然注入了 mc 模式提示词"）。插件在 `ensureWatchdog` 后挂上这个回调（现场判 preset），
     *    闸门关着时**只记账不注入**；切回 MC 模式**自动恢复**（不必重新 arm）。
     * @type {(() => boolean) | null}
     */
    this.gate = null
  }

  /* ─────────────── 配置 ─────────────── */

  /** 浅合并补丁；wakeOn / mentionPatterns 单独处理 */
  updateConfig (patch = {}) {
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'wakeOn' && v && typeof v === 'object') {
        this.config.wakeOn = { ...this.config.wakeOn, ...v }
      } else if (k === 'mentionPatterns') {
        if (Array.isArray(v)) this.config.mentionPatterns = [...v]
      } else if (k in WATCH_DEFAULTS) {
        this.config[k] = v
      } else {
        throw new Error(`未知配置项：${k}（可用：${Object.keys(WATCH_DEFAULTS).join(', ')}）`)
      }
    }
    return this.config
  }

  status () {
    return {
      armed: this.armed,
      jobId: this.jobId,
      startedAt: this.startedAt || null,
      uptimeSec: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      pending: this.pending.length,
      lastWakeAt: this.lastWakeAt || null,
      lastWakeKind: this.lastWakeKind,
      stats: { ...this.stats },
      config: clone(this.config),
    }
  }

  /* ─────────────── 叫法判定 ─────────────── */

  calledBy (text) {
    const s = String(text ?? '')
    return this.config.mentionPatterns.filter((p) => {
      try { return new RegExp(`(?:${p})`, 'i').test(s) } catch { return false }
    })
  }

  /**
   * 把**自己的游戏名**学进叫法里（连接成功 / 挂载时调用）。
   *
   * 为什么要现学：默认叫法里**不许**再写私人名字（见 WATCH_DEFAULTS 的注释），
   * 但"别人喊我的名字"必须能叫醒我 —— 而这个名字每台机器都不一样（账号档案里的名字），
   * 所以从 `bot.username` 现拿：既通用又不泄露。
   * @param {string} name 玩家名（正则特殊字符会被转义）
   * @returns {boolean} 是否新增了一条
   */
  learnName (name) {
    const n = String(name ?? '').trim()
    if (!n || n.length > 32) return false
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (this.config.mentionPatterns.some((p) => p === esc || p === n)) return false
    this.config.mentionPatterns = [...this.config.mentionPatterns, esc]
    return true
  }

  /** 说话者是否在近距范围内（拿不到位置时保守返回 false） */
  #isNearby (who) {
    try {
      const b = this.sess.bot.bot
      const me = b?.entity?.position
      const them = b?.players?.[who]?.entity?.position
      if (!me || !them) return false
      return Math.hypot(me.x - them.x, me.y - them.y, me.z - them.z) <= this.config.nearRadius
    } catch { return false }
  }

  /* ─────────────── 挂载 / 卸载 ─────────────── */

  arm () {
    if (this.armed) return this.status()
    this.armed = true
    this.startedAt = Date.now()

    // 挂载时顺手把自己的游戏名学进叫法（源码里没有私人名字，见 learnName）
    try { this.learnName(this.sess?.bot?.bot?.username ?? this.sess?.bot?.username) } catch { /* 没连上也正常 */ }

    this.#bind()
    this.#startJob()
    // 🔴 同理：定时器回调里抛错是 uncaughtException，会把整个宿主带走（宿主只防未处理拒绝）。
    this.tickTimer = setInterval(() => { try { this.#tick() } catch (e) { this.#record('lifecycle', `看门狗 tick 出错（已吞，不影响进程）：${e?.message ?? e}`) } }, 1000)
    this.tickTimer.unref?.()
    this.#record('lifecycle', `看门狗已挂载（${this.config.wakeOn.heartbeat ? `心跳 ${this.config.heartbeatSec}s` : '无心跳'}）`)
    return this.status()
  }

  /**
   * 卸载看门狗。
   * @param {string} reason
   * @param {{notify?:boolean, fromJob?:boolean}} [opts]
   *   notify=true 时在对话里提醒 AI（退服提醒）；
   *   fromJob=true 表示这次是宿主 job 被 kill 触发的，**不要**再回头去 kill 那个 job
   *   （否则自我递归，而且 job 会卡在 stopping 永远不结算）。
   */
  disarm (reason = '主动关闭', { notify = false, fromJob = false } = {}) {
    // 🔴 **不管谁发起的，done 都必须结算**（2026-09-16 真机 bug：强制关闭后 UI 一直显示
    //    "还有 1 个后台任务 / 正在停止"）。
    //    旧代码只有 `fromJob` 那条路结算：我们**主动** disarm 时先 `jobs.kill()` 请宿主停 →
    //    宿主回调我们的 `cancel()` → 又进这里，可那时 `armed` 已 false →
    //    在下面的提前 return 里**跳过结算** → `done` 永不 resolve → 宿主的 job 永远停在 'stopping'。
    //    `#settleJob` 是幂等的（先清 `_resolveJob` 再 resolve），所以两条路都结算也只结算一次。
    if (!this.armed) {
      this.#settleJob(reason)
      return { alreadyOff: true, ...this.status() }
    }
    const jobId = this.jobId
    this.#teardown(reason)

    // 停 job（若宿主没有 jobs、或本次就是 job 触发的，跳过）
    if (jobId && !fromJob) {
      try { this.ctx.get('jobs')?.kill(jobId, this.#ownerId(), reason) } catch {}
    }
    // 结算 done —— 否则 job 永远停在 'stopping'，job_list 里挂着不动、job_kill 永远"请求中"
    this.#settleJob(fromJob ? `被取消（${reason}）` : `已停止（${reason}）`)

    if (notify && this.config.notifyOnDisarm) {
      this.#inject(`【看门狗已关闭｜${reason}】你已经不在 Minecraft 里了，事件监听停止。`
        + '如需继续请用 mc_connect 重新进服（进服后看门狗会自动挂上）。', 'lifecycle')
    }
    return { ...this.status(), reason }
  }

  /** 内部拆除：清定时器、摘监听、清待处理。幂等。 */
  #teardown (reason) {
    if (!this.armed) return
    this.armed = false
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null }
    this.#unbind()
    this.pending = []
    this.pendingSince = 0
    this.startedAt = 0
    this.#record('lifecycle', `看门狗已卸载：${reason}`)
  }

  /** 结算 job 的 done（只能结算一次） */
  #settleJob (detail, status = 'killed') {
    const resolve = this._resolveJob
    this._resolveJob = null
    this.jobId = null
    if (typeof resolve !== 'function') return
    try {
      resolve({ status, detail: detail ?? 'killed', output: this.log.slice(-30).map((e) => e.text).join('\n') })
    } catch {}
  }

  /**
   * 宿主 `jobs` 服务要的是**会话 id（字符串）**，不是 agent 对象。
   *
   * 🔴 2026-09-22 真机事故（用户）：看门狗挂 job 失败、降级成"无 job 模式"，
   *    日志是 `挂 job 失败（降级为无 job 模式）：session "[object Object]" has no live
   *    agent (background job owner must be live)`。
   *
   *    根因：`jobs.start({ owner: this.agent })` 把 **agent 对象**塞进了 `owner`，
   *    而宿主 `resolveOwner(session)`（`@deepseek-ai/dsh-jobs-local/lib/index.js:526-533`）
   *    是拿它去 `agents.get(session)` 查表 —— 那张表**按会话 id 字符串索引**
   *    （`@deepseek-ai/dsh-agent`：`get(id) { return this.store.get(id)?.agent }`，
   *    且 `enter()` 里断言 `agent.id === agent.session.id`），
   *    传对象必然查不到 → 抛错，错误信息里把对象 `String()` 成了 `[object Object]`。
   *
   *    宿主的对照写法：`@deepseek-ai/dsh-tool-jobs` 一律用 `exec.agent?.id`
   *    （`jobs.list(exec.agent?.id)` / `jobs.kill(id, exec.agent?.id, reason)`）。
   *
   *    同理 `jobs.kill(id, caller, reason)` / `jobs.list(caller)` 的 `caller` 也是会话 id，
   *    宿主 `assertAccess()` 比的是 `job.owner.id !== caller`。
   *
   * @returns {string|undefined} 会话 id；拿不到返回 undefined（调用方据此降级，不挂"无主 job"）
   */
  #ownerId () {
    const id = this.agent?.id ?? this.sess?.agentId
    return typeof id === 'string' && id.length > 0 ? id : undefined
  }

  #startJob () {
    const jobs = this.ctx.get('jobs')
    if (!jobs) {
      this.#record('lifecycle', '宿主没有 jobs 服务：看门狗以"无 job"模式运行（仍能唤醒，但 job_list 看不到）')
      return
    }
    // 🔴 owner 必须是**会话 id 字符串**（见 #ownerId 的说明）。拿不到就不挂 ——
    //    挂成"无主 job"（owner 缺省）会让它对所有会话可见、也能被别的会话停掉。
    const ownerId = this.#ownerId()
    if (!ownerId) {
      this.#record('lifecycle', '拿不到会话 id（agent 未就绪）：看门狗以"无 job"模式运行')
      return
    }
    const self = this
    try {
      this.jobId = jobs.start({
        kind: 'mc-watch',
        label: `MC 看门狗（整局存活）`,
        owner: ownerId,
        run: () => ({
          // 宿主 job_kill → 这里。走 fromJob:true：拆除但**不回头 kill 自己**，
          // 并结算 done（否则 job 卡在 stopping）。
          cancel: (r) => { self.disarm(r ? `被取消（${r}）` : '被取消', { fromJob: true }) },
          done: new Promise((resolve) => { self._resolveJob = resolve }),
          readOutput: () => {
            const text = self.log.slice(-30).map((e) => `[${new Date(e.at).toISOString().slice(11, 19)}] (${e.kind}) ${e.text}`).join('\n')
            return text || '（暂无事件）'
          },
        }),
      })
    } catch (e) {
      this.#record('lifecycle', `挂 job 失败（降级为无 job 模式）：${e.message}`)
      this.jobId = null
    }
  }

  /* ─────────────── 事件绑定 ─────────────── */

  #bind () {
    const bot = this.sess.bot
    const on = (evt, fn) => { bot.on(evt, fn); this._listeners.push([evt, fn]) }

    /**
     * 🔴 断线（2026-09-19 用户："连接断开了状态没有同步，AI 也以为连接还在"）。
     *
     * 以前 core **根本不发**这个事件，于是：
     *   · 看门狗还挂着 → `watch.armed` 说"在监听"，AI 以为还在游戏里；
     *   · 前端状态条照旧显示"在游戏中"（配合 `online` 只看 bot.entity 的旧判定）；
     *   · 直到 AI 下一次调工具才撞上"不在线"。
     * 现在分两种：
     *   · **会重连** → 叫醒 AI 说清"断了、正在自动重连"，看门狗继续挂着（重连成功后照常工作）；
     *   · **不重连了**（主动下线 / 重连没戏）→ 关掉看门狗，它的关闭通知本来就会告诉 AI
     *     "你已经不在 Minecraft 里了，要用 mc_connect 重新进服"。
     * 想安静点就把 `wakeOn.disconnect` 关掉（mc_config 改），但仍然会记档到事件队列里。
     */
    on('offline', (e) => {
      const reason = String(e?.reason ?? '连接结束')
      if (e?.willReconnect) {
        if (!this.config.wakeOn.disconnect) return
        this.#fire(['disconnect'], {
          kind: 'offline',
          text: `连接断了（${reason}）——插件正在自动重连，先别再操作角色，等重连结果`,
        })
        return
      }
      // 不会重连了：关掉看门狗（notify 默认开 → AI 会收到"你已不在 MC 里"的提示）
      try { this.disarm(`连接断开：${reason}`) } catch { /* 关不掉也不能让它把流程带走 */ }
    })

    on('chat', ({ who, text }) => {
      const called = this.calledBy(text)
      const near = this.#isNearby(who)
      // 同话题延续：唤醒后 topicWindowSec 内的发言直接算延续
      const topical = this.lastWakeAt > 0 && (Date.now() - this.lastWakeAt) < this.config.topicWindowSec * 1000
      const why = []
      if (called.length && this.config.wakeOn.mention) why.push('mention')
      if (near && this.config.wakeOn.nearbySpeech) why.push('nearbySpeech')
      if (!why.length && topical) why.push('mention')          // 延续话题
      this.#fire(why, {
        kind: 'chat',
        text: `<${who}> ${text}`,
        who,
        calledBy: called,
        near,
        topical,
      })
    })

    on('damage', (e) => {
      if (!this.config.wakeOn.damage) return
      this.#fire(['damage'], { kind: 'damage', text: `血量降到 ${e.health}` })
    })
    on('death', () => {
      if (!this.config.wakeOn.death) return
      this.#fire(['death'], { kind: 'death', text: '我死了' })
    })
    on('teleport', (e) => {
      if (!this.config.wakeOn.teleport) return
      this.#fire(['teleport'], { kind: 'teleport', text: `位置瞬移 ${e.distance} 格：${JSON.stringify(e.from)} → ${JSON.stringify(e.to)}` })
    })
    on('pushed', (e) => {
      if (!this.config.wakeOn.pushed) return
      this.#fire(['pushed'], { kind: 'pushed', text: `被动移动 ${e.distance} 格` })
    })
    on('pickup', (e) => {
      if (!this.config.wakeOn.itemPickup) return
      this.#fire(['itemPickup'], { kind: 'pickup', text: `捡到 ${e.items.join(', ')}` })
    })
    on('playerJoin', (e) => {
      if (!this.config.wakeOn.playerJoin) return
      this.#fire(['playerJoin'], { kind: 'playerJoin', text: `${e.who} 上线了` })
    })
    on('playerLeave', (e) => {
      if (!this.config.wakeOn.playerLeave) return
      this.#fire(['playerLeave'], { kind: 'playerLeave', text: `${e.who} 下线了` })
    })
  }

  #unbind () {
    for (const [evt, fn] of this._listeners) { try { this.sess.bot.off(evt, fn) } catch {} }
    this._listeners = []
  }

  /* ─────────────── 事件处理 ─────────────── */

  /**
   * 收到一个事件。reasons 非空 = 命中唤醒条件；为空 = 只记档。
   * 命中时不立刻唤醒，先进观察窗口攒着（把连珠炮合并成一次）。
   */
  #fire (reasons, detail) {
    // 无论是否唤醒都留档（这就是"事件记录器"）。
    // 🔴 注意：**只有这一处**写看门狗自己的 log；会话事件队列（sess.events，mc_events 读的）
    //    由 index.js 的 McSession.ensureWired **单独**写。两边都写会导致同一句话进队列两遍
    //    （chat/damage/death 三类尤其明显）——曾经的真 bug，别再加回来。
    this.#record(detail.kind, detail.text)

    if (!reasons.length) return
    this.pending.push({ reasons, ...detail, at: Date.now() })
    if (!this.pendingSince) this.pendingSince = Date.now()
  }

  #record (kind, text) {
    this.log.push({ at: Date.now(), kind, text })
    if (this.log.length > this.maxLog) this.log.splice(0, this.log.length - this.maxLog)
  }

  #tick () {
    if (!this.armed) return
    const now = Date.now()

    // 观察窗口到期 → 结算成一次唤醒
    if (this.pending.length && this.pendingSince && (now - this.pendingSince) >= this.config.observeWindowMs) {
      this.#flush('事件命中')
      this.pendingSince = 0
    }

    // 心跳（⚠️ 只在**真在线**时发：断了还喊"我还在游戏里"就是撒谎，2026-09-19 顺手堵掉）
    if (this.config.wakeOn.heartbeat && this.config.heartbeatSec > 0 && this.sess.bot.online) {
      const since = now - (this.lastWakeAt || this.startedAt)
      if (since >= this.config.heartbeatSec * 1000) {
        this.#inject(`【心跳｜已挂机 ${Math.round(since / 1000)}s】我还在 ${this.sess.bot.sub ?? '游戏'} 里，`
          + '没出什么事。你可以选择继续挂机（重新挂 mc_watch 或什么都不做），或主动做点什么。', 'heartbeat')
        this.lastWakeAt = now
        this.lastWakeKind = 'heartbeat'
        this.stats.fired++
      }
    }

    // 唤醒后等不到下文的补提醒
    if (this.config.followUpAfterSec > 0 && this.lastWakeAt > 0) {
      const since = now - this.lastWakeAt
      const due = this.config.followUpAfterSec * 1000
      if (since >= due && !this._followedUp) {
        this._followedUp = true
        this.#inject(`【提醒】距上次被叫醒已 ${Math.round(since / 1000)}s，对方没有再说话。`
          + '你可以：① 主动说点什么/做个动作；② 判断没事就继续挂机（不必回复）。', 'followUp')
      }
    }
  }

  /** 把观察到的事件合并成一条消息注入当前会话 */
  #flush (why) {
    if (!this.pending.length) return
    const now = Date.now()

    // 限流
    this.wakeTimes = this.wakeTimes.filter((t) => now - t < 60_000)
    if (this.wakeTimes.length >= this.config.maxWakePerMinute) {
      this.stats.dropped += this.pending.length
      this.pending = []
      this.#record('lifecycle', `唤醒被限流丢弃（每分钟上限 ${this.config.maxWakePerMinute}）`)
      return
    }

    const items = this.pending
    this.pending = []
    const allReasons = [...new Set(items.flatMap((i) => i.reasons))]
    const lines = items.map((i) => {
      const tags = i.reasons.map((r) => LABEL[r] ?? r).join('+')
      const extra = i.calledBy?.length ? `　← 命中叫法：${i.calledBy.join('/')}` : (i.near ? '　← 就在我旁边' : '')
      return `· [${tags}] ${i.text}${extra}`
    })
    const body = `【MC 看门狗｜${allReasons.map((r) => LABEL[r] ?? r).join(' + ')}】\n`
      + lines.join('\n')
      + `\n\n（这是同一个对话里的提醒。用 mc_events 可取完整事件队列；`
      + `需要回应就 mc_say，需要行动就 mc_move / mc_act / mc_build。）`

    this.#inject(body, allReasons.join('+'))
    this.lastWakeAt = now
    this.lastWakeKind = allReasons.join('+')
    this._followedUp = false
    this.wakeTimes.push(now)
    this.stats.fired++
  }

  /**
   * 把提醒注入当前会话（**提示词注入，不是模拟用户发言**）。
   *
   * 首选 `agent.steer(plugin 来源的 message)`：
   *   · 空闲 → **起一轮**（= 唤醒）；运行中 → 下一步插话（不打断）
   *   · source 是 `{kind:'plugin:whale_craft', form:'notice'}` → 宿主渲染成折叠的一行摘要，不是用户消息
   * 兜底才用 `sessionController.prompt`（那条必然是用户来源）。
   */
  #inject (text, kind) {
    // 🔴 模式闸门：会话已经不是 MC 模式了 → **绝不注入**（见 constructor 里 gate 的说明）。
    //    失败开放（gate 抛错时按"允许"处理）：宁可偶尔多注入一次，也别把真 MC 会话叫不醒。
    if (typeof this.gate === 'function') {
      let allowed = true
      try { allowed = this.gate() !== false } catch { allowed = true }
      if (!allowed) {
        this.stats.dropped++
        this.#record('lifecycle', `会话已不在 MC 模式 → 丢弃这次注入（${kind}）`)
        return
      }
    }
    const running = this.agent?.status === 'running'

    // 🔴 **注入之前先打断"正在等的工具调用"**（2026-09-19 用户实测：等到消息、提及了也没唤醒，
    //    空等特别久，等完之后看门狗才注入）。
    //    宿主把 steer 放在**下一个 step 边界**投递，而 step 边界要等当前这一步的工具返回 ⇒
    //    一个 `mc_events {waitSec:120}` 就能把唤醒压到等待结束。
    //    置个标记，等待循环（src/wait.mjs）见到就立刻收工 → 工具返回 → step 结束 → 这条文案当场投出去。
    //    所有注入都走这里（唤醒 / 关闭通知 / 补提醒 / 心跳），所以放在这一个口子上。
    try { this.sess?.interruptWait?.(kind ?? null) } catch { /* 打断失败不影响注入 */ }

    // ────────────────────────────────────────────────────────────────────────
    // 首选：agent.steer(plugin 来源的 message) —— 这才是"提示词注入"
    //
    // 为什么不用 sessionController.prompt({mode:'queue'})：
    //   那条路走的是 `agent.followup()`，宿主文档原话是
    //   "Queue an **ordinary follow-up turn** … becomes the **sole ordinary message**
    //    of its own turn" —— 即**往对话里插一条用户消息**（用户明确不要这个）。
    //   而且 commands.ts 里 source 被写死成 `{kind:'user'}`，怎么调都是用户消息。
    //
    // 为什么 steer 能"空闲也唤醒"：
    //   `steer` 的文档原话 "Submit steering for the nearest step.
    //    **An idle driver starts a turn**; a running driver consumes it at its
    //    next step boundary." —— 空闲起一轮、运行中插下一步，正是我们要的两用。
    //
    // source 走 `noticeSource()`（`{kind:'plugin:whale_craft', form:'notice', summary}`）：
    //   宿主把它渲染成**折叠的 notice 行**
    //   （"One-line account of what happened, shown without expanding the row"），
    //   不是用户发言。summary 就是那一行。
    // 🔴 kind 必须是 producer-owned —— 老写法 `{kind:'plugin', plugin:'whale_craft'}`
    //   在 v4 会话格式下会被准入拒绝，整个 step 直接失败（见 src/user-message.mjs 顶部）。
    // ────────────────────────────────────────────────────────────────────────
    const agent = this.agent
    if (agent && typeof agent.steer === 'function') {
      try {
        const message = userMessage({
          content: [{ type: 'text', text }],
          source: noticeSource(`MC 看门狗：${kind}`),
        })
        agent.steer(message)
        this.stats.injected++
        this.#record('lifecycle', `已注入 steer（${running ? '运行中→下一步插话' : '空闲→起一轮'}｜${kind}）`)
        return
      } catch (e) {
        this.#record('lifecycle', `steer 注入失败，回退 prompt：${e?.message ?? e}`)
      }
    }

    // 兜底：拿不到 agent（没有 steer）时才走 sessionController.prompt。
    // 🔴 2026-09-18 起这条**不再因为"拿不到 createUserMessage"而触发** ——
    //    消息构造已由 `src/user-message.mjs` 保证（宿主实现拿不到就用自带等价实现）。
    //    注意它必然是**用户来源**消息，且 @Remote 签名要第二个 signal 参数。
    const sc = this.ctx.get('sessionController')
    if (!sc || typeof sc.prompt !== 'function') {
      this.#record('lifecycle', `无法注入（没有 agent.steer，也没有 sessionController.prompt）：${text.slice(0, 60)}…`)
      return
    }
    const label = running ? '运行中→steer' : '空闲→拍一轮'
    try {
      const res = sc.prompt({
        requestId: `mc-wake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        sessionId: this.agent?.id ?? this.sess.agentId,
        mode: 'steer',
        content: [{ type: 'text', text }],
      }, this.promptSignal)
      this.stats.injected++
      this.#record('lifecycle', `已注入（回退 prompt｜${label}｜${kind}）`)
      if (res && typeof res.then === 'function') {
        res.catch((e) => {
          this.stats.injected--
          this.#record('lifecycle', `注入异步失败（${label}）：${e?.message ?? e}`)
        })
      }
    } catch (e) {
      this.#record('lifecycle', `注入失败（${label}）：${e?.message ?? e}`)
    }
  }
}
