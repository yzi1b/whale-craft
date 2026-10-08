// -*- coding: utf-8 -*-
/**
 * whale_craft / memory.mjs —— 麦块记忆（v3：固定 .whale-craft + AI 维护的 README.md 索引）
 * ============================================================================
 * 用户 2026-09-16 的要求：
 *   · 固定记录在**工作区下的 `.whale-craft` 文件夹**；
 *   · **仍是让 AI 用 `README.md` 记录索引**（插件不再自动生成索引文件）；
 *   · 建子文件夹记录各服务器相关文件；
 *   · MCAI 可以在记忆文件夹里**读写任何格式文件**（可以把自己读到的图片保存），
 *     但**不能运行脚本**之类（这个模块本身不执行任何东西：没有 spawn、没有 shell）。
 *
 * 目录结构（默认 `<工作区>/.whale-craft/`）：
 *
 *   .whale-craft/
 *   ├── README.md              ← **AI 维护**的总索引（插件只读它、不重写）
 *   ├── _global/               ← 通用记忆（不限服务器）
 *   └── mc.example.com/          ← 每个服务器一个文件夹
 *       ├── landmarks.md
 *       └── maps/town-plan.png ← 任何格式都行（图片、json、txt…）
 *
 * 索引文本 = README.md（AI 写的索引）+ **自动生成的目录树**（`indexText()`）。
 * ⚠️ 2026-10-07：`mc_kit_memory` 工具与 README 索引的**自动注入均已移除** —— `indexText()`/
 *    `renderTree()`/`list()` 不再有生产消费方，本模块保留为库（自检单元测试仍覆盖）。README 作为
 *    **目录约定**仍在：agent 按 RULES.md 的指示自行用宿主文件工具阅读/维护它，插件不注入。
 *
 * 安全：所有路径过 safePath()——拒绝绝对路径、`..`、超深路径，且解析后必须仍在
 * `.whale-craft/` 内。记忆工具**不是**通用文件编辑器的替身，边界就是这个文件夹。
 * 根级的受保护文件（RULES.md / AGENTS.md / config.json，见 src/protected.mjs）**可读不可写**：
 * safePath 放行（标记 protected），写类方法显式拒绝。
 * ============================================================================
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync, rmSync, openSync, readSync, closeSync } from 'node:fs'
import { join, resolve, dirname, sep, posix, extname, basename } from 'node:path'
import { isProtectedName, protectedWriteError } from './protected.mjs'

const MAX_FILES = 2000
const MAX_TEXT_BYTES = 256 * 1024          // 文本写入上限
const MAX_BLOB_BYTES = 16 * 1024 * 1024    // 任意文件（含图片）存入上限
const GLOBAL_DIR = '_global'
const README_FILE = 'README.md'
const MAX_DEPTH = 5

/** 目录/文件名允许的字符：中英文、数字、`._-`、空格（首尾空格与点会被拒）。 */
const SAFE_SEGMENT = /^[\w.\-\u4e00-\u9fa5 ]+$/

/** 按扩展名判断"这是文本"。判断不了的再按内容嗅探（见 sniffKind）。 */
const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.json', '.jsonc', '.yml', '.yaml', '.csv', '.tsv', '.log',
  '.ini', '.cfg', '.conf', '.toml', '.svg', '.html', '.htm', '.xml', '.js', '.mjs', '.cjs',
  '.ts', '.css', '.sh', '.ps1', '.py', '.java', '.sql', '.diff', '.patch',
])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif'])
const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif',
}

export class MemoryStore {
  /**
   * @param {string} root 记忆根目录（绝对路径，通常是 <工作区>/.whale-craft）
   * @param {{create?: boolean}} [opts] `create:false` = **只读**，不在构造时建目录。
   *   用户 2026-09-16：`.whale-craft/` 不该被"顺手建出来"——建它只发生在
   *   "首次发起 MC 模式会话"与"点开「MC设置」"这两个时机（见 index.js `ensureMemoryRoot`）。
   */
  constructor (root, { create = true } = {}) {
    this.root = resolve(root)
    this._textCache = { text: '', at: 0 }
    if (create) this.ensureRoot()
  }

  ensureRoot () {
    try { if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true }) } catch {}
  }

  get readmePath () { return join(this.root, README_FILE) }

  /** README.md 不存在时**只建一次**骨架（之后完全交给 AI 维护，插件不再动它） */
  ensureReadme () {
    if (existsSync(this.readmePath)) return false
    try {
      this.ensureRoot()
      writeFileSync(this.readmePath, [
        '# 麦块记忆 · 总索引（由 AI 维护）',
        '',
        '> 这个文件是**我**（AI）维护的索引，不是插件生成的——新增/改动了记忆文件就顺手更新它。',
        '> 每个服务器一个子文件夹；通用（不限服务器）的放 `_global/`。',
        '> 图片等非文本文件直接放对应文件夹里（例如 `mc.example.com/maps/xxx.png`）。',
        '',
        '## 通用（_global）',
        '',
        '_(待补充)_',
        '',
        '## 按服务器',
        '',
        '_(待补充)_',
        '',
      ].join('\n'), 'utf8')
      return true
    } catch { return false }
  }

  /* ─────────────── 路径安全 ─────────────── */

  /**
   * 相对路径 → 根目录下的绝对路径。
   * 拒绝：绝对路径、`.`/`..` 片段、超深、非法字符、越界。
   * **不限扩展名**（用户要求"读写任何格式文件"）。
   * 根级的受保护文件（RULES.md / AGENTS.md / config.json）在这里**放行**（读允许），
   * 结果带 `protected:true`，由写类方法（append/write/delete/put）显式拒绝。
   */
  safePath (rel) {
    const raw = String(rel ?? '').trim().replace(/\\/g, '/')
    if (!raw) throw new Error('path 不能为空')
    if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw new Error('path 必须是相对路径（如 mc.example.com/landmarks.md）')
    const parts = raw.split('/').filter((p) => p !== '')
    if (parts.length === 0) throw new Error('path 不能为空')
    if (parts.some((p) => p === '..' || p === '.')) throw new Error('path 不允许包含 . 或 ..')
    if (parts.length > MAX_DEPTH) throw new Error(`path 太深（最多 ${MAX_DEPTH} 层）`)
    for (const p of parts) {
      if (p.length > 96) throw new Error(`路径片段太长："${p.slice(0, 30)}…"`)
      if (!SAFE_SEGMENT.test(p)) throw new Error(`路径片段不合法："${p}"（只用中英文/数字/空格/._-）`)
      if (/^[.\s]|[.\s]$/.test(p)) throw new Error(`路径片段不能以点或空格开头/结尾："${p}"`)
    }
    const relFull = parts.join('/')
    const abs = resolve(this.root, ...parts)
    if (abs !== this.root && !abs.startsWith(this.root + sep)) throw new Error('path 越界')
    return {
      abs,
      rel: relFull,
      kind: kindOf(parts[parts.length - 1], abs),
      protected: parts.length === 1 && isProtectedName(parts[0]),
    }
  }

  /** 由 topic/server 拼路径：<server>/<topic>.md；server 省略则 _global */
  pathFor ({ topic, server = null } = {}) {
    const t = String(topic ?? '').trim()
    if (!t) throw new Error('需要 topic 或 path')
    const dir = server ? String(server).trim() : GLOBAL_DIR
    // 已经带扩展名就照用，否则补 .md（笔记）
    const file = /\.[A-Za-z0-9]+$/.test(t) ? t : `${t}.md`
    return this.safePath(posix.join(dir, file))
  }

  /* ─────────────── 列表 / 索引 ─────────────── */

  /** 遍历记忆树，返回全部文件（README 以外的都算记忆） */
  list () {
    const out = []
    if (!existsSync(this.root)) return out
    const walk = (dirAbs, dirRel) => {
      let names = []
      try { names = readdirSync(dirAbs) } catch { return }
      for (const name of names) {
        const abs = join(dirAbs, name)
        const rel = dirRel ? `${dirRel}/${name}` : name
        let st
        try { st = statSync(abs) } catch { continue }
        if (st.isDirectory()) { walk(abs, rel); continue }
        if (name === README_FILE && !dirRel) continue       // README 是索引本身，不算记忆条目
        if (!dirRel && isProtectedName(name)) continue      // 受保护文件（行事准则/工作区配置）也不算
        const kind = kindOf(name, abs)
        const group = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : GLOBAL_DIR
        const item = {
          rel,
          kind,
          group,
          topic: name.replace(/\.[^.]+$/, ''),
          title: name,
          bytes: st.size,
          mtime: st.mtimeMs,
          updatedAt: new Date(st.mtimeMs).toISOString(),
        }
        if (kind === 'text') {
          try {
            const text = readFileSync(abs, 'utf8')
            const lines = text.split('\n')
            const titleLine = lines.find((l) => /^#\s+/.test(l)) ?? ''
            item.title = titleLine.replace(/^#\s+/, '').trim() || item.title
            item.entries = (text.match(/^\s*[-*]\s+\S/gm) ?? []).length
            item.summary = summarize(lines)
            if (out.length < MAX_FILES) out.push(item)
            continue
          } catch { /* 读不了就当二进制 */ }
        }
        item.entries = 1
        item.summary = kind === 'image'
          ? `图片 ${(st.size / 1024).toFixed(0)}KB`
          : `文件 ${(st.size / 1024).toFixed(0)}KB`
        if (out.length < MAX_FILES) out.push(item)
      }
    }
    walk(this.root, '')
    return out.sort((a, b) => a.rel.localeCompare(b.rel))
  }

  /** 自动生成的目录树（注入文本的第二段；README 忘了更新也不会失真） */
  renderTree () {
    const files = this.list()
    if (!files.length) return '_(记忆库还是空的)_'
    const groups = new Map()
    for (const f of files) {
      if (!groups.has(f.group)) groups.set(f.group, [])
      groups.get(f.group).push(f)
    }
    const order = [...groups.keys()].sort((a, b) => (a === GLOBAL_DIR ? -1 : b === GLOBAL_DIR ? 1 : a.localeCompare(b)))
    const lines = ['| 文件 | 类型 | 最后更新 | 提示 |', '| --- | --- | --- | --- |']
    for (const g of order) {
      lines.push(`| **${g === GLOBAL_DIR ? '_global（通用）' : g}** | | | |`)
      for (const f of groups.get(g)) {
        const when = new Date(f.mtime).toISOString().slice(5, 16).replace('T', ' ')
        lines.push(`| \`${f.rel}\` | ${f.kind} | ${when} | ${f.summary || '—'} |`)
      }
    }
    lines.push('', `_共 ${files.length} 个文件_`)
    return lines.join('\n')
  }

  /**
   * 投递给模型的文本（5 秒缓存）：**README.md（AI 维护的索引）+ 自动目录树**。
   * 写操作会清掉缓存（见 append/write/delete），所以投递那一刻读到的总是最新的。
   */
  indexText () {
    if (Date.now() - this._textCache.at < 5000) return this._textCache.text
    let readme = ''
    try {
      this.ensureReadme()
      readme = existsSync(this.readmePath) ? readFileSync(this.readmePath, 'utf8').trim() : ''
    } catch { readme = '' }
    const tree = this.renderTree()
    const text = (readme ? readme + '\n\n' : '')
      + '### 记忆库实况（自动生成，永远准）\n\n' + tree
    this._textCache = { text, at: Date.now() }
    return text
  }

  /* ─────────────── 增删改查 ─────────────── */

  /** 读：文本返回内容；图片返回文件路径（工具层做成附件让模型直接看到）；其它二进制只给元信息 */
  read ({ path = null, topic = null, server = null } = {}) {
    const resolved = path ? this.safePath(path) : this.pathFor({ topic, server })
    const { abs, rel, kind } = resolved
    if (!existsSync(abs)) {
      const files = this.list().map((f) => f.rel)
      throw new Error(`没有这个记忆文件：${rel}。现有文件：${files.length ? files.slice(0, 40).join(', ') : '(空，先用 write/append 建一个)'}`)
    }
    const st = statSync(abs)
    if (st.isDirectory()) {
      const names = readdirSync(abs)
      return { path: rel, kind: 'dir', entries: names, bytes: 0 }
    }
    if (kind === 'image') {
      return {
        path: rel, kind: 'image', file: abs, bytes: st.size,
        mediaType: MIME_BY_EXT[extname(rel).toLowerCase()] ?? 'image/png',
        note: '这是记忆里的图片。工具层会把它作为附件返回，所以你能**直接看到**它。',
      }
    }
    if (kind === 'binary') {
      return {
        path: rel, kind: 'binary', file: abs, bytes: st.size,
        note: '这是二进制文件，不能当文本读（也不内联显示）。要看内容请用 read_image（图片）或在工作区里处理。',
      }
    }
    const content = readFileSync(abs, 'utf8')
    return { path: rel, kind: 'text', content, bytes: st.size }
  }

  /**
   * 存：把工作区里的**任意文件**复制进记忆（图片最常用）。
   * "MCAI 可以把自己读到的图片保存" —— 就是这个。
   */
  put ({ source, name = null, path = null, server = null } = {}) {
    if (!source) throw new Error('需要 source（要存入的文件路径）')
    if (!existsSync(source)) throw new Error(`源文件不存在：${source}`)
    const st = statSync(source)
    if (!st.isFile()) throw new Error(`不是文件：${source}`)
    if (st.size > MAX_BLOB_BYTES) {
      throw new Error(`文件太大（${(st.size / 1048576).toFixed(1)}MB），上限 ${MAX_BLOB_BYTES / 1048576}MB`)
    }
    let target
    if (path) {
      target = this.safePath(path)
    } else {
      const ext = extname(source)
      const base = String(name ?? basename(source).replace(/\.[^.]+$/, '')).replace(/[^\w.\-\u4e00-\u9fa5 ]/g, '_').trim() || 'file'
      const dir = server ? String(server).trim() : GLOBAL_DIR
      target = this.safePath(posix.join(dir, `${base}${ext}`))
    }
    if (target.protected) throw new Error(protectedWriteError(target.rel))
    if (!existsSync(dirname(target.abs))) mkdirSync(dirname(target.abs), { recursive: true })
    writeFileSync(target.abs, readFileSync(source))
    this._textCache = { text: '', at: 0 }
    return {
      saved: target.rel, bytes: st.size, kind: target.kind,
      note: `已存进记忆（${target.kind}）。想让以后找得到，在 \`README.md\` 的索引里加一行，`
        + `或写进对应服务器的笔记里引用：\`见 ${target.rel}\`。`,
    }
  }

  /** 增/改：追加一条 bullet（只对文本文件）；给 key 则覆盖同 key 的那条 */
  append ({ path = null, topic = null, server = null, text, key = null } = {}) {
    const body = String(text ?? '').trim()
    if (!body) throw new Error('text 不能为空——要记什么？')
    if (body.length > 4000) throw new Error(`一条记忆太长（${body.length} 字），上限 4000`)

    const target = path ? this.safePath(path) : this.pathFor({ topic, server })
    if (target.protected) throw new Error(protectedWriteError(target.rel))
    if (target.kind !== 'text') throw new Error(`append 只能用在文本文件上（${target.rel} 是 ${target.kind}）`)
    const files = this.list()
    if (!existsSync(target.abs) && files.length >= MAX_FILES) {
      throw new Error(`记忆文件数已达上限 ${MAX_FILES}，先整理或删掉一些`)
    }

    const bullet = key ? `- **${key}** — ${body}` : `- ${body}`
    let content
    if (existsSync(target.abs)) {
      content = readFileSync(target.abs, 'utf8')
      if (key) {
        const re = new RegExp(`^\\s*[-*]\\s+\\*\\*${escapeRe(key)}\\*\\*\\s*[—-]\\s*.*$`, 'm')
        if (re.test(content)) {
          const next = content.replace(re, bullet)
          if (Buffer.byteLength(next) > MAX_TEXT_BYTES) throw new Error(`文件超过 ${MAX_TEXT_BYTES / 1024}KB 上限`)
          writeFileSync(target.abs, next, 'utf8')
          this._textCache = { text: '', at: 0 }
          return { path: target.rel, replaced: true, entries: countBullets(next), content: next }
        }
      }
      content = content.replace(/\s*$/, '\n') + bullet + '\n'
    } else {
      const dir = dirname(target.abs)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const group = target.rel.includes('/') ? target.rel.slice(0, target.rel.indexOf('/')) : GLOBAL_DIR
      const topicName = target.rel.split('/').pop().replace(/\.[^.]+$/, '')
      content = `# ${group === GLOBAL_DIR ? '通用' : group} / ${topicName}\n\n${bullet}\n`
    }
    if (Buffer.byteLength(content) > MAX_TEXT_BYTES) {
      throw new Error(`文件超过 ${MAX_TEXT_BYTES / 1024}KB 上限，考虑拆成多个 topic`)
    }
    writeFileSync(target.abs, content, 'utf8')
    this._textCache = { text: '', at: 0 }
    return { path: target.rel, replaced: false, entries: countBullets(content), content }
  }

  /** 改：整文件覆盖（重组内容、写小标题/表格；任何文本扩展名都行） */
  write ({ path = null, topic = null, server = null, content } = {}) {
    const body = String(content ?? '')
    if (!body.trim()) throw new Error('content 不能为空（要删文件请用 action:"delete"）')
    if (Buffer.byteLength(body) > MAX_TEXT_BYTES) throw new Error(`内容超过 ${MAX_TEXT_BYTES / 1024}KB 上限`)
    const target = path ? this.safePath(path) : this.pathFor({ topic, server })
    if (target.protected) throw new Error(protectedWriteError(target.rel))
    if (target.kind === 'binary' || target.kind === 'image') {
      throw new Error(`${target.rel} 按二进制处理；要存文件请用 action:"put"（它会复制源文件）`)
    }
    const dir = dirname(target.abs)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(target.abs, body.endsWith('\n') ? body : body + '\n', 'utf8')
    this._textCache = { text: '', at: 0 }
    return { path: target.rel, bytes: Buffer.byteLength(body), entries: countBullets(body), created: true }
  }

  /** 删：删文件；path 指向目录时整目录删 */
  delete ({ path = null, topic = null, server = null } = {}) {
    const target = path ? this.safePath(path) : this.pathFor({ topic, server })
    if (target.protected) throw new Error(protectedWriteError(target.rel))
    if (!existsSync(target.abs)) throw new Error(`没有这个文件/目录：${target.rel}`)
    const st = statSync(target.abs)
    if (st.isDirectory()) {
      rmSync(target.abs, { recursive: true, force: true })
      this._textCache = { text: '', at: 0 }
      return { deleted: target.rel, wasDirectory: true }
    }
    unlinkSync(target.abs)
    this._textCache = { text: '', at: 0 }
    return { deleted: target.rel, wasDirectory: false, remaining: this.list().length }
  }

  /** 查：跨文本文件搜索（二进制自动跳过） */
  search ({ query, limit = 30 } = {}) {
    const q = String(query ?? '').trim().toLowerCase()
    if (!q) throw new Error('query 不能为空')
    const n = Math.min(Math.max(Number(limit) || 30, 1), 100)
    const hits = []
    for (const f of this.list()) {
      if (f.kind !== 'text') continue
      let text = ''
      try { text = readFileSync(join(this.root, ...f.rel.split('/')), 'utf8') } catch { continue }
      for (const [i, line] of text.split('\n').entries()) {
        if (line.toLowerCase().includes(q)) hits.push({ path: f.rel, line: i + 1, text: line.trim() })
        if (hits.length >= n) break
      }
      if (hits.length >= n) break
    }
    return { query, matched: hits.length, hits }
  }

  /** 总览（工具 action:"index" 用） */
  overview () {
    const files = this.list()
    const groups = new Map()
    for (const f of files) {
      if (!groups.has(f.group)) groups.set(f.group, [])
      groups.get(f.group).push(f)
    }
    let readme = ''
    try { readme = existsSync(this.readmePath) ? readFileSync(this.readmePath, 'utf8') : '' } catch {}
    return {
      root: this.root,
      readmePath: this.readmePath,
      totalFiles: files.length,
      totalEntries: files.reduce((n, f) => n + (f.entries ?? 0), 0),
      groups: [...groups.entries()].map(([group, list]) => ({
        group: group === GLOBAL_DIR ? '(通用)' : group,
        files: list.map((f) => ({ path: f.rel, kind: f.kind, entries: f.entries, updatedAt: f.updatedAt, summary: f.summary })),
      })),
      readme,
      tree: this.renderTree(),
    }
  }
}

/* ─────────────── 工具函数 ─────────────── */

/** 判定文件种类：text / image / binary */
function kindOf (name, abs) {
  const ext = extname(String(name)).toLowerCase()
  if (IMAGE_EXT.has(ext)) return 'image'
  if (TEXT_EXT.has(ext)) return 'text'
  // 扩展名不认识 → 嗅探前 8KB 有没有 NUL 字节（有 = 二进制）
  try {
    const fd = openSync(abs, 'r')
    try {
      const buf = Buffer.alloc(8192)
      const n = readSync(fd, buf, 0, 8192, 0)
      return buf.subarray(0, n).includes(0) ? 'binary' : 'text'
    } finally { closeSync(fd) }
  } catch { return 'binary' }
}

function summarize (lines) {
  const quote = lines.find((l) => /^>\s*\S/.test(l))
  const src = quote ?? lines.find((l) => /^\s*[-*]\s+\S/.test(l)) ?? ''
  return src.replace(/^[>\s\-*]+/, '').slice(0, 60)
}

const countBullets = (text) => (text.match(/^\s*[-*]\s+\S/gm) ?? []).length
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
