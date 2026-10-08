// -*- coding: utf-8 -*-
/**
 * whale_craft / express.mjs —— 「把产出文件端给浏览器」的那条最小通道
 * ============================================================================
 * 用户 2026-09-16 定的形态：
 *   · **目录即白名单**：只服务 `<工作区>/.whale-craft/.express/` 里的文件
 *     （放进这个目录 = 同意被访问；`.out/` 是默认输出，不对外）；
 *   · 地址形态（2026-09-17 定稿）：`<base>/api/whale-craft/express/<工作区 uuid>/<剩余路径>`
 *     例：`/api/whale-craft/express/3f1c…/world1/example.png` → `.whale-craft/.express/world1/example.png`；
 *   · **不用 token**（用户：DSH 本身禁止公网访问；真要架公网，架的人自己加代理与鉴权）；
 *   · 下面**可以有子目录**；
 *   · **所有扩展名都放行**（用户自己把握）；但**必须防穿透**。
 *
 * 本模块是**纯函数**（不碰 fs），好测；真正的读写与 404 判定在 index.js 的路由里。
 * ============================================================================
 */
import { join, sep } from 'node:path'

/** 「发布区」目录名（在 `<工作区>/.whale-craft/` 下） */
export const EXPRESS_DIR = '.express'
/** 默认工作输出目录名（**不对外**）——点开头，与 AI/用户的内容分开 */
export const OUT_DIR = '.out'
/**
 * 发布区 URL 前缀（用户 2026-09-17 定稿）：
 *
 *   `<base>/api/whale-craft/express/<工作区 uuid>/<相对于 .express 的路径>`
 *
 * 为什么是这个形状：
 *   · **放在 `/api` 后面**（用户要求）：跟 DSH 自己的接口同一层，反代/网关能按 `/api` 统一处理；
 *   · **用工作区 uuid**（`ctx.workspaceRegistry` 里那个 `randomUUID`）而不是目录名：
 *     不同父目录下的同名工作区不会撞、**目录改名链接也不失效**、URL 里不暴露目录名；
 *   · 它挂在插件自己的前缀路由 `/api/whale-craft` 上（`/api/mc` 那条只服务设置接口）。
 */
export const EXPRESS_URL_PREFIX = '/api/whale-craft/express'

/** 工作区 uuid 的形态（正式是标准 UUID；放宽一点，规则同 preset id 那种保守写法） */
export const WORKSPACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/* ── 桌面模式的"独立托管端口"（用户 2026-10-07 定）────────────────────────────
 * 桌面版没有稳定可配的 base ⇒ 插件**自起一个只监听 localhost 的 http 服务**，
 * 直接托管 `.express/` 文件，地址固定为 `http://localhost:<port>/<工作区uuid>/<剩余路径>`
 * （**不带** `/api/whale-craft/express` 前缀 —— 已是我们自己的专用端口）。
 * ────────────────────────────────────────────────────────────────────────── */
export const DEFAULT_EXPRESS_PORT = 16049
/** 只绑回环：绝不开 LAN（用户："我们的 express 要有只监听 localhost 的策略"）。 */
export const EXPRESS_HOST = '127.0.0.1'

/** 合法端口（整数 1–65535） */
export function isExpressPort (v) {
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= 65535
}

/** 归一化成端口整数；非法/超范围 → null（调用方据此拒绝或回退默认） */
export function normalizeExpressPort (v) {
  if (!isExpressPort(v)) return null
  return Number(v)
}

/**
 * 解析桌面托管的路径 `/<工作区 uuid>/<剩余路径>`（**无** `/api/whale-craft/express` 前缀）。
 * 与 {@link parseExpressPath} 同规矩：只认首段合法 uuid、其后 ≥1 段非空。
 * @param {string} pathname `url.pathname`（**已解码**）
 * @returns {{workspaceId:string, segments:string[]}|null}
 */
export function parseExpressLocalPath (pathname) {
  const raw = String(pathname ?? '')
  if (!raw.startsWith('/')) return null
  const rest = raw.slice(1)
  if (!rest) return null
  const parts = rest.split('/')
  const workspaceId = parts.shift() ?? ''
  if (!WORKSPACE_ID_RE.test(workspaceId)) return null
  if (!parts.length) return null
  return { workspaceId, segments: parts }
}

/** 发布区根目录（给 fs 用） */
export const expressRootOf = (memoryRoot) => join(memoryRoot, EXPRESS_DIR)

/** 默认输出根目录（不对外） */
export const outRootOf = (memoryRoot) => join(memoryRoot, OUT_DIR)

/**
 * 解析 `/api/whale-craft/express/<工作区 uuid>/<剩余路径>`。
 *
 * ⚠️ 传入的应当是 `url.pathname`（**已解码**）：`new URL()` 会把 `%2e%2e` 还原成 `..`，
 *    所以下面的校验看得见真正的点段 —— 这正是"必须防穿透"的第一道。
 * @returns {{workspaceId:string, segments:string[]}|null}
 */
export function parseExpressPath (pathname) {
  const raw = String(pathname ?? '')
  const prefix = `${EXPRESS_URL_PREFIX}/`
  if (!raw.startsWith(prefix)) return null
  const rest = raw.slice(prefix.length)
  if (!rest) return null
  const parts = rest.split('/')
  const workspaceId = parts.shift() ?? ''
  if (!WORKSPACE_ID_RE.test(workspaceId)) return null
  if (!parts.length) return null
  return { workspaceId, segments: parts }
}

/**
 * 段级校验 + 拼绝对路径。**任何一段**不合格就返回 null（宁可不服务）：
 *   · 空段（连续 `/`、结尾 `/`）· `.` / `..` · 含 `/` `\`（编码过的分隔符）
 *   · 盘符/绝对路径味道（`C:`）· 控制字符 · 开头的 `~`
 * 另外做一次"拼完仍在 root 里面"的复查（纵深防御；真正的兜底是路由里的 realpath 检查）。
 * @returns {string|null} 绝对路径
 */
export function safeExpressTarget (root, segments) {
  const rootAbs = String(root ?? '')
  if (!rootAbs) return null
  const list = Array.isArray(segments) ? segments : []
  if (!list.length) return null
  for (const raw of list) {
    const s = String(raw ?? '')
    if (!s) return null
    if (s === '.' || s === '..') return null
    if (/[/\\]/.test(s)) return null
    if (/^[A-Za-z]:/.test(s)) return null
    if (s.startsWith('~')) return null
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(s)) return null
    if (s.length > 255) return null
  }
  const abs = join(rootAbs, ...list)
  const prefix = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep
  if (abs !== rootAbs && !abs.startsWith(prefix)) return null
  return abs
}

/** 扩展名 → Content-Type（**所有扩展名都放行**；不认识的按二进制流走） */
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.zip': 'application/zip', '.glb': 'model/gltf-binary', '.schem': 'application/octet-stream',
}
export function mimeOf (file) {
  const s = String(file ?? '')
  const i = s.lastIndexOf('.')
  if (i < 0) return 'application/octet-stream'
  return MIME[s.slice(i).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * 这些类型**被浏览器当文档打开时会执行脚本**（同源风险）→ 只加一个 CSP sandbox 头：
 * 内联 `<img>` 显示不受影响（图片上下文里脚本本来就不跑），但直接导航过去也跑不起来。
 */
export const SANDBOX_TYPES = /^(?:image\/svg\+xml|text\/html|text\/xml|application\/xml|text\/javascript|application\/javascript)/

/* ── 「文件分享」（用户 2026-09-17 定；2026-10-04 改开关；2026-10-07 按宿主模式拆键）──────────
 * 开关决定 `mc_kit_express` **回什么**、服务**开不开**；**按宿主模式分两套键、相互独立**：
 *   · web（`expressWebEnabled` + `expressWebBase`）：回 `base + /api/whale-craft/express/<uuid>/<rel>`，
 *     文件走宿主 webServer 的 `/api/whale-craft/…` 路由（本模块的 `EXPRESS_URL_PREFIX`）；
 *   · desktop（`expressDesktopEnabled` + `expressDesktopPort`）：回 `http://localhost:<port>/<uuid>/<rel>`，
 *     插件**自起一个只监听 localhost 的独立端口**直接托管（见 src/express-server.mjs）。
 * 关（默认）：只回 {@link EXPRESS_OFF_TEXT}，让 AI 把**绝对路径**告诉用户；地址/端口没配好 → {@link EXPRESS_NEED_BASE_TEXT}
 * 或 {@link EXPRESS_PORT_BUSY_TEXT}（**都不抛错**）。
 * 🔴 历史：更早是 `off | online` 两模式（曾含 `local`）→ 2026-10-04 降成单开关 → 2026-10-07 拆成上面四键
 *    （老键迁移见 src/config.mjs `PluginConfig.migrate`）。
 * 🔴 两种模式都**只认发布区**里的文件 —— "目录即白名单"不变。
 * ────────────────────────────────────────────────────────────────────────── */

/** 关闭时**恒回**的这句话（用户定稿，逐字照抄） */
export const EXPRESS_OFF_TEXT = '文件分享已关闭，请告知用户文件绝对路径，让用户自行打开'

/** 开启但没配 base 时回的话（**不抛错**：让 AI 直接转达用户去设置） */
export const EXPRESS_NEED_BASE_TEXT
  = '文件分享还没有设置 base：请让用户在「MC设置 → 文件分享」里填写 base。'

/**
 * 桌面模式：已启用、但托管端口没起来（被占用 / 启动失败）时回的话（**不抛错**）。
 * @param {number|string} port 用户配置的端口
 */
export function EXPRESS_PORT_BUSY_TEXT (port) {
  return `文件分享已开启，但端口 ${String(port ?? '')} 无法监听（被占用或启动失败）：请让用户在「MC设置 → 文件分享」里换一个端口。`
}

/**
 * 归一化 base。空 = 未设置（返回 `''`）；非法（不是 http/https 完整地址）返回 `null`。
 * 去掉尾斜杠 —— 相对路径本身以 `/api/mc/…` 开头。
 * @returns {string|null}
 */
export function normalizeExpressBase (raw) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  if (!/^https?:\/\//i.test(s)) return null
  try { new URL(s) } catch { return null }
  return s.replace(/\/+$/, '')
}

/** 在线模式：`base + 相对路径`；base 为空/非法 → null（调用方改回"请设置 base"） */
export function onlineUrlOf (base, relUrl) {
  const b = normalizeExpressBase(base)
  if (!b) return null
  const u = String(relUrl ?? '')
  return u ? b + u : null
}

/**
 * 一个绝对路径在发布区里时，给出**现成可粘贴的**相对 URL 与 markdown；不在就返回 null。
 * URL 是 `/api/whale-craft/express/<工作区 uuid>/<剩余路径>`：它是"在线"模式拼 base 的后半截，
 * 也是唯一与访问方式无关的形态（`127.0.0.1` / 受信域名 / 反代前缀下都同源可用，不碰混合内容）。
 * @param {string} absPath 文件绝对路径
 * @param {string} memoryRoot 记忆根（`<工作区>/.whale-craft`）
 * @param {string} workspaceId 工作区 uuid（**必须来自 `workspaceRegistry`**；非法/缺失 → null）
 * @returns {{rel:string, url:string, localPath:string, markdown:string}|null}
 */
export function expressRefFor (absPath, memoryRoot, workspaceId) {
  const id = String(workspaceId ?? '').trim()
  if (!WORKSPACE_ID_RE.test(id)) return null
  const root = expressRootOf(memoryRoot)
  const p = String(absPath ?? '')
  const prefix = root.endsWith(sep) ? root : root + sep
  if (!p.startsWith(prefix)) return null
  const rel = p.slice(prefix.length)
  if (!rel) return null
  const parts = rel.split(/[/\\]+/).filter(Boolean)
  if (!parts.length) return null
  // `localPath` = `/工作区uuid/剩余路径`：web 拼在 base 后（见 url），desktop 拼在 `http://localhost:<port>` 后
  const localPath = `/${encodeURIComponent(id)}/${parts.map(encodeURIComponent).join('/')}`
  const url = `${EXPRESS_URL_PREFIX}${localPath}`
  return { rel, url, localPath, markdown: `![](${url})` }
}
