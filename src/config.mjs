// -*- coding: utf-8 -*-
/**
 * whale_craft / config.mjs —— 插件全局配置（可配置、落盘、改完立即生效）
 * ============================================================================
 * 用户 2026-09-16 的要求：
 *   · **服务器指令白名单可配置**（原来是写死的正则）
 *   · **可配置向 MC 模式的 Agent 暴露哪些其它工具**
 *   · 非 MC 模式的 agent 有个工具能**直接改**这些配置；MC 模式的**不能用不能改**
 *
 * 落盘位置：**`$DSH_HOME/whale_craft/config.json`**（插件自己的家，见 {@link resolveStateDir}）。
 * 🔴 2026-09-16 用户要求：**配置与账户不该躺在工作区里** —— 工作区是某个项目的家，
 *    插件有插件自己的家。宿主在 app-boot 里 `ctx.provide('dshHomePath', …)`，
 *    与 `$DSH_HOME/skills`、`$DSH_HOME/.agent-presets`、`$DSH_HOME/storages`、`$DSH_HOME/attachments` 同一套规矩。
 *
 * 为什么不放在 cordis.patch.yml：那份配置要重启宿主才生效，而这里的键要**当场生效**。
 * 环境变量：`WHALE_CRAFT_STATE_DIR` 直接指定状态目录；`WHALE_CRAFT_DIR`（自检/隔离用）
 * 一给就表示"所有状态都留在那个临时目录里"。
 * ============================================================================
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { EXPRESS_MODES, normalizeExpressBase, resolveExpressMode } from './express.mjs'

/** 插件在 `$DSH_HOME` 下的目录名 */
export const STATE_DIR_NAME = 'whale_craft'

/**
 * 解析**插件状态目录**（配置 + 账户库放这里，**不放工作区**）。
 *
 * 优先级：`WHALE_CRAFT_STATE_DIR` → （自检/隔离）`WHALE_CRAFT_DIR` →
 * 宿主给的 `dshHomePath('whale_craft')` → `$DSH_HOME/whale_craft` → `~/.dsh/whale_craft`。
 * @param {{env?: Record<string,string|undefined>, dshHomePath?: Function, whaleDir?: string, home?: string}} [opts]
 * @returns {string} 绝对路径
 */
export function resolveStateDir ({ env = process.env, dshHomePath, whaleDir, home } = {}) {
  const explicit = String(env.WHALE_CRAFT_STATE_DIR ?? '').trim()
  if (explicit) return explicit
  // 自检 / 隔离实例：WHALE_CRAFT_DIR 一给，所有状态都留在那个临时目录（搬迁前的行为不变）
  if (String(env.WHALE_CRAFT_DIR ?? '').trim() && whaleDir) return whaleDir
  if (typeof dshHomePath === 'function') {
    try {
      const p = dshHomePath(STATE_DIR_NAME)
      if (p) return p
    } catch { /* 拿到不就用下面的兜底 */ }
  }
  const base = String(env.DSH_HOME ?? '').trim() || join(home ?? homedir(), '.dsh')
  return join(base, STATE_DIR_NAME)
}

/** 默认值 = 老行为（现有 mc_command 的白名单原样搬过来） */
export const DEFAULT_CONFIG = {
  /**
   * mc_command 允许的服务器指令名。支持三种写法：
   * 精确名（`"tp"`）· 正则（斜杠包裹，如 `^gi.+`）· `"*"` = 全部放行
   */
  commandWhitelist: [
    'tp', 'teleport', 'give', 'time', 'weather', 'say', 'tell', 'msg',
    'gamemode', 'effect', 'enchant', 'setblock', 'fill', 'clone', 'summon',
    'title', 'spawnpoint', 'difficulty', 'kill', 'clear', 'xp', 'experience',
  ],
  /** 哪些 agent preset 算"MC 模式"（用来做权限隔离：MC 模式不能用管理工具） */
  mcModePresets: ['minecraft', 'whale_craft'],
  mcMode: {
    /**
     * **额外**允许 MC 模式会话使用的其它工具（whale_craft 自己的工具与文件工具永远在白名单里）。
     *
     * MC 模式是**无条件白名单**：默认只给 `mc_*` / `mc_kit_*` + 文件工具（`read/write/edit/glob/grep/read_image`），
     * 宿主的 `pwsh` / `subagent` / `workflow` / `serve_*` 之类一律看不见。想额外开哪个就写在这里。
     * ⚠️ 只能"收窄"，不能凭空添加 preset 没挂的工具。
     *
     * （2026-09-16 修：以前 `allowOtherTools` 为空就退化成"只 deny 自家管理工具"的黑名单，
     *   结果 MC 模式里 pwsh 照样能用 —— 用户真机投诉"不是只暴露我们指定的工具吗！"。
     *   同时删掉了 `denyOtherTools`：白名单之外本来就看不见，那个开关没有意义了。）
     */
    allowOtherTools: [],
    /** 是否把 mc_admin_* 也放进白名单（默认 false = 隐藏；隐藏之外 guard 仍会硬拒） */
    hideAdminTools: true,
  },
  /** 记忆根目录；null = `<工作区>/.whale-craft` */
  memoryDir: null,
  /** 「MC设置 → 指令白名单」页的开关：允许所有服务器指令（默认关 = 只放行白名单里的） */
  allowAllCommands: false,
  /** 是否把 **whale-craft 自己的**行事准则（`.whale-craft/RULES.md`）注入给 MC 模式的 agent */
  injectWhaleCraftAgentsMd: true,
  /**
   * 是否**额外**注入**工作区**的 `AGENTS.md`（默认关）。
   * 2026-09-16 实测：MC 模式下宿主本来就没注入它（会话日志里 0 次），所以这里控制的是
   * "我们插件再补一份"，打开即恢复"工作区 AGENTS.md 也在场"。
   */
  injectWorkspaceAgentsMd: false,
  /**
   * 「提示词」页的「随版本更新」（用户 2026-09-17 定，**默认开**）：
   * 插件版本一变，就用**新版本的默认行事准则**替换 `<工作区>/.whale-craft/RULES.md`
   * （用户改过的也会被换掉 —— 这就是这个开关的语义）。
   *
   * 判定靠记忆目录里的 `.rules-version` 标记（记"当前内容对应哪个插件版本"）：
   *   · 第一次遇到这个功能（没有标记）→ 只记版本、**不覆盖**（免得插件一升级就冲掉用户改的准则）；
   *   · 关掉时只把标记更新到当前版本 ⇒ 以后打开也**不翻旧账**。
   */
  rulesFollowVersion: true,
  /**
   * 启动时若 `mcModePresets` 里**一个都不存在**，就自动建一个「MC模式」preset。
   *
   * 2026-09-16 用户定的：插件**不塞** preset 目录，但"没有 preset 就没有 MC 模式"这件事必须自己解决
   * —— preset 属于用户的 `$DSH_HOME/.agent-presets/`，新机器上没人建过，插件就永远认不出 MC 会话。
   *
   * 做法**只能用宿主官方接口**：`agentPresets.copy(源, 新id, 显示名)`（官方 authoring 明令
   * "只允许整目录复制已有 preset、调用方不得提供 composition 文本"）。默认复制官方的 `minimal`
   * （极简工具面）；**已存在就绝不动**。关掉它就回到"要自己建 preset"。
   */
  ensureMcPreset: true,
  /**
   * 「文件分享」模式（用户 2026-09-17 定）：`off` 关闭（默认） / `online` 在线。
   *
   *   · `off`    关闭：`mc_kit_express` 只回一句话（"文件分享已关闭，请告知用户文件绝对路径…"），
   *              让 AI 把**绝对路径**告诉用户，用户自己打开；`/api/mc/whale-craft/…` 服务**不开**；
   *   · `online` 在线：回 `expressBase + 相对路径` 的**完整 URL**；**只有这个模式**才开那条服务。
   *
   * 🔴 用户 2026-09-17 砍掉了原先的"Windows 本地"模式（"Windows 很鸡肋"）：它只是把绝对路径
   *    原样回给 AI，而 DSH 前端不认相对/本地路径 —— 点不开也内联不了，不如只留"关"和"在线"两种。
   * ⚠️ 老配置里可能还留着 `local`：{@link resolveExpressMode} 一律当 `off`（不会再开服务）。
   * 两种模式都仍然**只认发布区**（`.whale-craft/.express/`）。
   */
  expressMode: 'off',
  /** 在线模式的 base（如 `https://dsh.example.com`，可带路径前缀）；空 = 还没配 */
  expressBase: '',

}

/**
 * preset id 必须是**目录名**：与宿主 `agent-presets/src/preset.ts` 的 `PRESET_ID` 同规则。
 * 🔴 这条很要命：默认名单里的 `whale_craft` **带下划线，永远不可能是 preset id**
 * （所以"自动建 MC 模式 preset"只能建 `minecraft` 那种）。
 */
export const PRESET_ID_RE = /^[a-z0-9][a-z0-9-]*$/

/** 从 `mcModePresets` 里挑一个**能当目录名**的 id；都不合法就 null */
export function pickPresetTarget (wanted) {
  const list = Array.isArray(wanted) ? wanted : []
  return list.map((x) => String(x ?? '').trim()).find((id) => PRESET_ID_RE.test(id)) ?? null
}

/** 复制源的优先级：越简的工具面越适合 MC 模式（MC 的 persona/指导由插件注入） */
export const PREFERRED_PRESET_SOURCES = ['minimal', 'standard', 'ptc']

/**
 * 这个简介是不是"复制来的"？（等于某个官方 preset 的简介）
 *
 * 官方 `copy()` **只改 name、保留源 preset 的 description**（见 `agent-presets/src/authoring.ts`），
 * 所以自动建出来的 MC 模式会带一句极简模式/标准模式的简介 —— 用户 2026-09-16 报的正是这个。
 * 只在**明显是复制残留**时才修：用户自己写过的简介（不等于任何官方简介）一律不碰。
 */
export function isCopiedPresetDescription (desc, shippedDescriptions) {
  const d = String(desc ?? '').trim()
  if (!d) return false
  return (shippedDescriptions ?? []).some((x) => String(x ?? '').trim() === d)
}

/**
 * 自动建 preset 的"规格版本"。**改这个数字 = 下次启动会把我们自己建的那份刷新一遍。**
 * （用来解决用户问的："初始化时能不能检查是不是对的，不对也重新建吗？万一用户更新插件了呢。"）
 *
 * 历史：1 = 复制官方 minimal；**2 = 顺手把 persona 换成我们自己的 + 关掉那个 shell**
 *      （复制 minimal 会把"极简模式"的 persona（You are a helpful software engineer assistant.）
 *      和它的持久 shell 一起带过来，而 MC 模式的指导里明写"本模式没有 shell" —— 自相矛盾）；
 *      **3 = persona 换成用户定稿的那一句**（"你在一台真实的 Minecraft Java 版服务器里扮演一名玩家…"）；
 *      **4 = 补上 `present`（显式文件交付）组** —— 删掉 mc_kit_share 之后，"让用户看到文件"改走宿主自带机制；
 *      **5 = 补齐 MC 模式需要的**那几组（tool-fs / tool-jobs / present）—— 官方 minimal 里一个都没有，
 *      不补的话复制出来的 preset 既没有文件工具、也没有 job controller（看门狗只能降级成"无 job 模式"）；
 *      **6 = persona 键名跨版本跟随源 preset**（新版要 `prefix`、老版要 `text`）——
 *      升级到这一版会把 5 建的那些 preset **重建一遍**，顺手修好老环境里"键名写坏、加载失败"的那份；
 *      **7 = 补上压缩组（compaction）** —— 官方 minimal 同样没有它，于是照 minimal 建的 MC 模式
 *      **既没有 `/compact` 指令、也没有自动压缩**（2026-09-22 用户真机投诉："mc模式 /compact
 *      压缩上下文没了，无法压缩"）。这是"工具组"之外的第二个必补组。
 */
export const MC_PRESET_SPEC = 7

/**
 * persona 段里"人设正文"用的键名。**跨 DSH 版本有两种**：
 *   · 新版 `prefix`（`z.string().required()`）； · 老版 `text`（同样是 required）。
 * 2026-09-17 真机事故就是因为这里**写死了 `prefix`**：老环境自动建出来的 preset 加载直接失败
 * （`persona (@deepseek-ai/dsh-persona): invalid config: - $text missing required value`）→ 切不进 MC 模式。
 */
export const PERSONA_TEXT_KEYS = ['prefix', 'text']

/** 取出 `- id: persona` 那一段（找不到返回 null） */
function personaRow (text) {
  const lines = String(text ?? '').split('\n')
  const start = lines.findIndex((l) => /^-\s+id:\s*persona\s*$/.test(l))
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^-\s/.test(lines[i])) { end = i; break }
  }
  return { lines, start, end, seg: lines.slice(start, end) }
}

/** 这段 composition 里 persona 拿哪个键写正文（`prefix` / `text`；都没有 → null） */
export function personaTextKeyOf (text) {
  const row = personaRow(text)
  if (!row) return null
  for (const key of PERSONA_TEXT_KEYS) {
    if (row.seg.some((l) => new RegExp(`^\\s{2,}${key}\\s*:`).test(l))) return key
  }
  return null
}

/** 从段里删掉某个键**以及它的块标量值行**（返回新数组） */
function dropKeyFromSegment (seg, key) {
  const re = new RegExp(`^(\\s*)${key}\\s*:`)
  const out = []
  for (let i = 0; i < seg.length; i++) {
    const m = re.exec(seg[i])
    if (!m) { out.push(seg[i]); continue }
    const base = m[1].length
    let j = i + 1
    while (j < seg.length) {
      const line = seg[j]
      if (/^\s*$/.test(line)) { j++; continue }                    // 块标量里的空行
      if (/^\s*/.exec(line)[0].length > base) { j++; continue }     // 值行（缩进更深）
      break
    }
    i = j - 1                                                      // 连值一起丢掉
  }
  return out
}

/**
 * 把 composition 里 persona 段的**人设正文**换成我们的（纯函数，自检直接测）。
 *
 * 规矩（用户 2026-09-17："同时支持两者"）：
 *   · **键名跟着源 preset**（`opts.key` 优先；没有就用文件里现成的 `prefix`/`text`）—— 不假设版本；
 *   · **只改值、不加键、不删键**：`complete:` / `includeRuntimeContext:` 只把值改成安全值
 *     （老版本 schema 里没有的键，我们绝不会凭空写进去）；
 *   · 找不到 persona 段 / 找不到 config 段 / 两种键都认不出 → 返回 `null`（调用方保持原样并记日志）。
 *
 * @param {string} text composition 文本（`agent.cordis.yml`）
 * @param {string} personaText 我们的人设正文
 * @param {{key?: 'prefix'|'text'|null}} [opts] `key` = 源 preset 用的那个键（版本判据）
 * @returns {string|null}
 */
export function patchPersonaInComposition (text, personaText, opts = {}) {
  const row = personaRow(text)
  if (!row) return null
  const { lines, start, end } = row
  const wanted = PERSONA_TEXT_KEYS.includes(String(opts?.key ?? '')) ? String(opts.key) : null
  const fileKey = PERSONA_TEXT_KEYS.find((k) => row.seg.some((l) => new RegExp(`^\\s{2,}${k}\\s*:`).test(l))) ?? null
  const key = wanted ?? fileKey
  if (!key) return null

  // ① 先把**两个键**都摘掉（含块标量值行）——免得 prefix/text 同时在场打架
  let seg = row.seg
  for (const k of PERSONA_TEXT_KEYS) seg = dropKeyFromSegment(seg, k)

  // ② 把我们的正文插回 `config:` 之后（没有 config 段就不猜，保持原样）
  const body = String(personaText).replace(/\s+$/, '').split('\n')
  let ci = seg.findIndex((l) => /^\s{2,}config\s*:/.test(l))
  if (ci < 0) {
    const ni = seg.findIndex((l) => /^\s+name\s*:/.test(l))
    if (ni < 0) return null
    const indent = (/^(\s*)/.exec(seg[ni])[1]) + '  '
    seg = [...seg.slice(0, ni + 1), `${indent}config:`, `${indent}  ${key}: |-`, ...body.map((l) => `${indent}    ${l}`), ...seg.slice(ni + 1)]
    ci = ni + 1
  } else {
    const indent = (/^(\s*)/.exec(seg[ci])[1]) + '  '
    seg = [...seg.slice(0, ci + 1), `${indent}${key}: |-`, ...body.map((l) => `${indent}  ${l}`), ...seg.slice(ci + 1)]
  }

  // ③ **只改值**：complete → false；includeRuntimeContext → true（键在才改）
  seg = seg.map((l) => {
    if (/^\s{2,}complete\s*:\s*true\s*$/.test(l)) return l.replace(/true\s*$/, 'false')
    if (/^\s{2,}includeRuntimeContext\s*:\s*false\s*$/.test(l)) return l.replace(/false\s*$/, 'true')
    return l
  })

  return [...lines.slice(0, start), ...seg, ...lines.slice(end)].join('\n')
}

/**
 * 把 composition 里那个"持久 shell"组分**关掉**（纯函数）。
 *
 * 为什么：官方 `minimal` 的全部意义就是"给一个持久 shell"，复制它会让 MC 模式的模型
 * 看到 `pwsh`/`bash` 工具；而 MC 模式的专属指导写着"本模式没有 shell，也别指望跑脚本"。
 * 两者必须一致 —— 我们选择关掉 shell（MC 模式只玩游戏）。
 * 已经写着 `disabled:` 的就不动。
 */
export function disableShellInComposition (text) {
  const lines = String(text ?? '').split('\n')
  const start = lines.findIndex((l) => /^-\s+id:\s*persistent-shell\s*$/.test(l))
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^-\s/.test(lines[i])) { end = i; break }
  }
  for (let i = start; i < end; i++) if (/^\s+disabled:/.test(lines[i])) return lines.join('\n')   // 已经有了
  lines.splice(start + 1, 0, '  disabled: true')
  return lines.join('\n')
}

/**
 * MC 模式 preset 需要**具备**的几组工具（宿主注册、preset 按需挂载）。
 *
 * 🔴 为什么必须由我们补：官方 `minimal` 只有 persona + 一个持久 shell（别的什么都没有），
 *    而我们自动建的「MC模式」正是复制它 —— 于是那份 preset 里的 agent：
 *      · 没有 `read`/`write`/`edit`（我们的记忆-jail 与白名单就落空）；
 *      · 没有 `present`（发不了产出文件）；
 *      · **没有 `tool-jobs`** ⇒ 宿主没有 job controller ⇒ 看门狗只能降级成"无 job 模式"
 *        （实验体 2026-09-16 的日志：`no job controller … load @deepseek-ai/dsh-tool-jobs`，
 *         `jobId: null`。降级后仍能唤醒，但 UI 看不到这个任务、强制停止也管不到它）。
 */
export const MC_PRESET_TOOL_GROUPS = [
  { id: 'tool-fs', pkg: '@deepseek-ai/dsh-tool-fs', note: '文件工具（read/write/edit/read_image）' },
  { id: 'tool-jobs', pkg: '@deepseek-ai/dsh-tool-jobs', note: '后台任务 controller（看门狗要挂 job）' },
  { id: 'present', pkg: '@deepseek-ai/dsh-tool-present', note: '显式文件交付（轮末文件卡片）' },
  {
    // 🔴 2026-09-22：官方 minimal 也没有这一组 ⇒ 照 minimal 建的 MC 模式里
    //    **既没有 `/compact` 指令、也没有自动压缩**（用户真机投诉）。
    id: 'compaction',
    pkg: '@deepseek-ai/dsh-command-compact',
    note: '压缩组（`/compact` 指令 + 自动压缩 + 超长工具结果裁剪）',
    // 这一组**必须整组加**（`cordis:group` + `isolate`），只补 `command-compact` 是没用的：
    // 压缩服务本体在 `compaction-basic`，而 `isolate` 那两个键在别处根本不存在。
    // 内容逐字对齐官方 standard / ptc / cordis 三个 preset 里的那一块（`cordis:group` 是宿主内置组类型）。
    block: [
      '- id: compaction',
      '  name: cordis:group',
      '  group: true',
      '  isolate:',
      '    compaction: true',
      '    toolResultPruner: true',
      '  config:',
      '    - id: compaction-basic',
      "      name: '@deepseek-ai/dsh-compaction-basic'",
      '    - id: command-compact',
      "      name: '@deepseek-ai/dsh-command-compact'",
      '    - id: tool-result-pruner',
      "      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
      '      config:',
      '        thresholdChars: 8192',
      '        headChars: 4096',
      '        tailChars: 1024',
    ].join('\n'),
  },
]

/**
 * 把缺的工具组补进 composition（纯函数，好测）。
 *
 * 只做"没有才加"：`pkg` 已经在文件里（不管是哪来的、哪个 id）就跳过；一个都不用加 → 返回 null。
 * @param {string} text composition 文本（`agent.cordis.yml`）
 * @param {Array<{id:string, pkg:string, note?:string, block?:string}>} [groups]
 *   要确保存在的组（默认 MC_PRESET_TOOL_GROUPS）。
 *   `block` = 直接追加的 YAML 片段（顶层组用，如压缩组要带 `cordis:group` + `isolate`）；
 *   不给 `block` 就走"一行 `- id` + 一行 `name`"的简单形式。
 * @returns {string|null} 改好的文本；无需改动 → null
 */
export function patchToolGroupsIntoComposition (text, groups = MC_PRESET_TOOL_GROUPS) {
  const src = String(text ?? '')
  const missing = (groups ?? []).filter((g) => g?.pkg && !src.includes(g.pkg))
  if (!missing.length) return null
  let out = src.endsWith('\n') ? src : src + '\n'
  for (const g of missing) {
    out += `\n# ── ${g.note ?? g.pkg}（whale_craft 2026-09-16 加）──\n`
      + (g.block ? `\n${g.block}\n` : `\n- id: ${g.id}\n  name: '${g.pkg}'\n`)
  }
  return out
}

/**
 * 初始化时该对 MC 模式 preset 做什么 —— **纯函数**，好测。
 *
 * 判定顺序（每一条都有理由，乱动别人的 preset 比不修更糟）：
 *   ① 不存在 → 建
 *   ② 有我们写的**标记**（marker）说明这份是我们自建的：
 *        · 规格版本变了（插件更新了）→ **重建**（重新从官方源复制一遍）
 *        · 组成被改过（hash 对不上标记）→ **不动**（用户改过的东西不许碰）
 *        · 官方源变了（源组成 hash ≠ 我们当初记的）→ **重建**（把新版工具面带过来）
 *        · 只是显示名/简介/排序不对 → 修**元数据**（composition 不动）
 *        · 都对 → 什么都不做
 *   ③ 没有标记（不是我们建的）：只有"简介明显是复制残留"才修元数据，其余一律不动。
 *
 * @param {{exists:boolean, marker:object|null, compositionHash:string|null,
 *          sourceHash:string|null, metaOk:boolean, shippedDescriptionMatch:boolean,
 *          spec?:number}} input
 * @returns {{action:'create'|'rebuild'|'meta'|'leave', reason:string}}
 */
export function planPresetAction ({
  exists, marker = null, compositionHash = null, sourceHash = null,
  metaOk = true, shippedDescriptionMatch = false, spec = MC_PRESET_SPEC,
} = {}) {
  if (!exists) return { action: 'create', reason: '还没有 MC 模式的 preset' }
  const ours = marker?.createdBy === 'whale_craft'
  if (!ours) {
    return shippedDescriptionMatch
      ? { action: 'meta', reason: '不是我们建的，但简介明显是复制残留（旧版建出来的）→ 只修显示文本' }
      : { action: 'leave', reason: '不是我们建的（或用户自己维护的）→ 一律不动' }
  }
  // 🔴 没记下组成 hash（当初读不到组成）：**没有依据判断用户改没改** → 只敢修显示文本，永不重建。
  if (!marker.compositionHash) {
    return metaOk
      ? { action: 'leave', reason: '自建的，但没记下组成 hash（无法确认有没有被改过）→ 不动' }
      : { action: 'meta', reason: '自建的，但没记下组成 hash → 只修显示文本，不敢重建' }
  }
  if (Number(marker.spec) !== Number(spec)) {
    return { action: 'rebuild', reason: `自建规格从 ${marker.spec} 变成 ${spec}（插件更新了）→ 重新复制一遍` }
  }
  if (compositionHash && marker.compositionHash && compositionHash !== marker.compositionHash) {
    return { action: 'leave', reason: '组成被改过（不是我们当初复制的那份）→ 不动它' }
  }
  if (sourceHash && marker.compositionHash && sourceHash !== marker.compositionHash) {
    return { action: 'rebuild', reason: '官方源 preset 变了（DSH 更新了）→ 把新版工具面复制过来' }
  }
  if (!metaOk) return { action: 'meta', reason: '显示名/简介/排序不对 → 只修元数据' }
  return { action: 'leave', reason: '自建的，且组成与元数据都对' }
}

/** 从现有 preset 里挑复制源：先按优先级，再退到宿主的默认 preset；都没有就 null */
export function pickPresetSource (ids, defaultId = null) {
  const set = new Set((ids ?? []).map((x) => String(x ?? '')))
  for (const id of PREFERRED_PRESET_SOURCES) if (set.has(id)) return id
  const d = String(defaultId ?? '')
  return set.has(d) ? d : null
}

const TOP_KEYS = new Set(Object.keys(DEFAULT_CONFIG))
const SECRET_KEYS = new Set()   // 目前没有敏感键；留个位置

export class PluginConfig {
  /** @param {string} dir 状态目录（`$DSH_HOME/whale_craft`；自检里是临时目录） */
  constructor (dir) {
    this.dir = dir
    this.file = join(dir, 'config.json')
    this.data = {}
    this.lastError = null
    this.load()
  }

  load () {
    try {
      if (!existsSync(this.file)) { this.data = {}; return }
      const raw = readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      this.data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch (e) {
      // 配置坏了不能让插件起不来：记下错误，用默认值继续
      this.data = {}
      this.lastError = `配置读取失败（已按默认值运行）：${e.message}`
    }
  }

  save () {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.data, null, 2) + '\n', 'utf8')
      return true
    } catch (e) {
      throw new Error(`配置写入失败：${e.message}`)
    }
  }

  /** 生效值 = 默认值 + 文件值（深合并，只并对象；数组整体覆盖） */
  values () { return deepMerge(clone(DEFAULT_CONFIG), this.data) }

  /** 点号路径读取（如 `mcMode.hideAdminTools`） */
  get (path) {
    if (!path) return this.values()
    return readPath(this.values(), String(path))
  }

  /** 点号路径写入；只允许已知顶层键，且做类型校验（免得手滑把插件搞崩） */
  set (path, value) {
    const p = String(path ?? '').trim()
    if (!p) throw new Error('path 不能为空（如 commandWhitelist 或 mcMode.allowOtherTools）')
    const [top, ...rest] = p.split('.')
    if (!TOP_KEYS.has(top)) {
      throw new Error(`未知配置项 "${top}"；可用：${[...TOP_KEYS].join(', ')}`)
    }
    if (SECRET_KEYS.has(top)) throw new Error('这一项不允许通过工具修改')
    validate(top, rest, value)
    // 落盘前归一化（存的永远是规范形态：模式小写、base 去尾斜杠）
    if (top === 'expressMode') value = String(value).trim().toLowerCase()
    if (top === 'expressBase') value = normalizeExpressBase(value) ?? ''
    writePath(this.data, p.split('.'), value)
    this.save()
    return { path: p, value: this.get(p), file: this.file }
  }

  /** 删掉某一项（回到默认值） */
  unset (path) {
    const p = String(path ?? '').trim()
    if (!p) throw new Error('path 不能为空')
    const parts = p.split('.')
    const container = parts.length === 1 ? this.data : readPath(this.data, parts.slice(0, -1).join('.'))
    if (container && typeof container === 'object') delete container[parts[parts.length - 1]]
    this.save()
    return { path: p, value: this.get(p), file: this.file }
  }

  /** 全部恢复默认（把文件写成 {}） */
  reset () {
    this.data = {}
    this.save()
    return { reset: true, file: this.file, values: this.values() }
  }

  /* ── 语义化读取 ── */

  get mcModePresets () {
    const v = this.get('mcModePresets')
    return Array.isArray(v) ? v.map(String) : []
  }

  get mcMode () {
    const v = this.get('mcMode')
    return {
      allowOtherTools: Array.isArray(v?.allowOtherTools) ? v.allowOtherTools.map(String) : [],
      hideAdminTools: v?.hideAdminTools !== false,
    }
  }

  get memoryDir () {
    const v = this.get('memoryDir')
    return typeof v === 'string' && v.trim() ? v.trim() : null
  }

  /** 「文件分享」模式：只有 `online` 是开，其余（含老配置里的 `local`）一律 `off` */
  get expressMode () {
    return resolveExpressMode(this.get('expressMode'))
  }

  /** 在线模式的 base（归一化：去尾斜杠；非法/空 = `''`） */
  get expressBase () {
    return normalizeExpressBase(this.get('expressBase')) ?? ''
  }

  /** 这个 preset id 算不算 MC 模式 */
  isMcModePreset (presetId) {
    if (!presetId) return false
    return this.mcModePresets.includes(String(presetId))
  }

  /**
   * 服务器指令是否放行。
   * 输入可以是 `/tp x y z` 或 `tp`；只按**指令名**判定。
   */
  commandAllowed (command) {
    // 「MC设置 → 指令白名单」页的开关：允许所有指令
    if (this.get('allowAllCommands') === true) return true
    const wl = this.get('commandWhitelist')
    if (!Array.isArray(wl)) return false
    const name = String(command ?? '').trim().replace(/^\//, '').split(/\s+/)[0].toLowerCase()
    if (!name) return false
    for (const entry of wl) {
      const e = String(entry).trim()
      if (!e) continue
      if (e === '*') return true
      if (e.startsWith('/') && e.lastIndexOf('/') > 0) {
        const end = e.lastIndexOf('/')
        try {
          if (new RegExp(e.slice(1, end), e.slice(end + 1) || 'i').test(name)) return true
        } catch { /* 坏正则忽略 */ }
        continue
      }
      if (e.toLowerCase() === name) return true
    }
    return false
  }
}

/* ─────────────── 内部工具 ─────────────── */

function validate (top, rest, value) {
  const key = [top, ...rest].join('.')
  const isStrArray = Array.isArray(value) && value.every((x) => typeof x === 'string')
  if (top === 'commandWhitelist') {
    if (!isStrArray) throw new Error('commandWhitelist 必须是字符串数组（如 ["tp","give","/^gi.*/"]）')
    return
  }
  if (top === 'mcModePresets') {
    if (!isStrArray) throw new Error('mcModePresets 必须是字符串数组（如 ["minecraft","whale_craft"]）')
    return
  }
  if (top === 'memoryDir') {
    if (value !== null && typeof value !== 'string') throw new Error('memoryDir 必须是字符串（绝对路径）或 null')
    return
  }
  if (top === 'allowAllCommands' || top === 'injectWhaleCraftAgentsMd' || top === 'injectWorkspaceAgentsMd' || top === 'ensureMcPreset' || top === 'rulesFollowVersion') {
    if (typeof value !== 'boolean') throw new Error(`${top} 必须是 true/false`)
    return
  }
  if (top === 'expressMode') {
    const v = String(value ?? '').trim().toLowerCase()
    if (!EXPRESS_MODES.includes(v)) {
      throw new Error(`expressMode 必须是 ${EXPRESS_MODES.join(' / ')} 之一`)
    }
    return
  }
  if (top === 'expressBase') {
    if (typeof value !== 'string') throw new Error('expressBase 必须是字符串（如 https://example.com；空 = 未设置）')
    if (value.trim() && normalizeExpressBase(value) === null) {
      throw new Error('expressBase 必须是 http(s) 开头的完整地址（如 https://example.com，可带路径前缀）')
    }
    return
  }
  if (top === 'mcMode') {
    if (key === 'mcMode.allowOtherTools') {
      if (!isStrArray) throw new Error(`${key} 必须是字符串数组（工具名，精确匹配）`)
      return
    }
    if (key === 'mcMode.hideAdminTools') {
      if (typeof value !== 'boolean') throw new Error('mcMode.hideAdminTools 必须是 true/false')
      return
    }
    if (key !== 'mcMode') throw new Error(`未知配置项 "${key}"；mcMode 下可用：allowOtherTools / hideAdminTools`)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('mcMode 必须是对象，如 {"allowOtherTools":[],"hideAdminTools":true}')
    }
  }
}

function readPath (obj, path) {
  let cur = obj
  for (const k of String(path).split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = cur[k]
  }
  return cur
}

function writePath (obj, parts, value) {
  let cur = obj
  for (const k of parts.slice(0, -1)) {
    if (cur[k] === null || typeof cur[k] !== 'object' || Array.isArray(cur[k])) cur[k] = {}
    cur = cur[k]
  }
  cur[parts[parts.length - 1]] = value
}

function clone (v) {
  if (Array.isArray(v)) return v.map(clone)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]))
  return v
}

function deepMerge (base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return base
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      base[k] = deepMerge(base[k], v)
    } else if (v !== undefined) {
      base[k] = clone(v)
    }
  }
  return base
}
