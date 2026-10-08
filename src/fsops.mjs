// -*- coding: utf-8 -*-
/**
 * whale_craft / fsops.mjs —— `mc_kit_fs` 的文件系统操作（**纯函数、只吃路径**，便于自检单测）
 * ============================================================================
 * 用户 2026-10-08 定的语义（见 dev-docs/tools/mc-tools.md / prompt/tool_descriptions.md）：
 *   · action：copy / move / delete / make_dir，**都递归**；
 *   · 末尾 `/*` 通配：选中该目录下的**直接**子项（不是深层 glob）；
 *   · `to`：**以路径分隔符结尾 = 放进这个目录**；不以分隔符结尾 = 作为目标文件/目录（若它已是目录则合并进去）。
 *     `from` 用了通配符时 `to` 必须以分隔符结尾；
 *   · **目标父目录不存在会自动创建**（copy / move 都是）；
 *   · **保留符号链接（不跟随）**：copy 把链接原样复制成链接，delete 删链接本身；
 *   · `overwrite=false`（默认）：目标已存在 → 报错，不覆盖；
 *   · 沙箱：`root`（MC=.whale-craft，MC+=工作区）；相对路径以 `base`（工作区根）为基准；
 *     沙箱根与工作区根**本身**不能被 move 的 from / delete 选中；
 *   · 受保护文件（RULES.md/AGENTS.md/config.json）与凭据路径**不可删改**；
 *   · **失败在动手前停止**（预检由调用方逐项做完才执行）；错误一律**中文**、不透出 Node/系统本地化文案。
 *
 * 安全：本模块**不跟随**符号链接，但仍防"路径中途经过越界符号链接"——
 *   `root/link -> /etc` 这类，取**父目录的 realpath** 复查（与发布区 index.js 的 realpath 复查同风格）。
 * ============================================================================
 */
import { readdirSync, lstatSync, statSync, mkdirSync, renameSync, rmSync, unlinkSync, cpSync, realpathSync } from 'node:fs'
import { resolve, join, dirname, sep, isAbsolute, basename } from 'node:path'
import { isProtectedName, CREDENTIAL_PATH_RE, SECRETS_DIR_RE } from './protected.mjs'

const trim = (v) => String(v ?? '').trim()
const IS_WIN = process.platform === 'win32'

/** 路径比较键：Windows 上大小写不敏感（用户 2026-10-08：守卫不区分大小写） */
const key = (p) => (IS_WIN ? String(p).toLowerCase() : String(p))
const withSep = (p) => (p.endsWith(sep) ? p : p + sep)
const ENDS_SEP = /[/\\]$/
const ENDS_DOT = /[/\\]\.$/
const HAS_STAR = /\*/

/** abs 是否在 root 之内（或就是 root）——大小写按平台归一 */
const contains = (root, abs) => {
  const r = key(root); const a = key(abs)
  return a === r || a.startsWith(withSep(r))
}

/** 两个路径是不是同一个（大小写按平台归一） */
export const samePath = (a, b) => key(resolve(a)) === key(resolve(b))
/** 路径末尾是不是分隔符（决定 copy/move 的 to 是"放进目录"还是"目标名"） */
export const hasTrailingSep = (raw) => ENDS_SEP.test(trim(raw))
export const hasStar = (raw) => HAS_STAR.test(trim(raw))

/** 存在？（lstat，不跟随链接） */
export const pathExists = (abs) => { try { lstatSync(abs); return true } catch { return false } }
/** 是目录？（不跟随链接：目录链接算 false，与"不跟随"一致） */
export const isDir = (abs) => { try { return lstatSync(abs).isDirectory() } catch { return false } }

/** 系统错误码 → 中文（**不透出本地化原文**，用户 2026-10-08） */
const CODE_ZH = {
  ENOENT: '不存在', EEXIST: '已存在', EACCES: '没有权限', EPERM: '被系统拒绝（权限/只读）',
  ENOTDIR: '路径里有一段不是目录', EISDIR: '目标是目录', ENOTEMPTY: '目标目录非空',
  EXDEV: '跨盘', EBUSY: '被占用', EINVAL: '参数不合法', ENAMETOOLONG: '路径过长', ELOOP: '符号链接成环',
}
const describeErr = (e) => { const c = e?.code; return c ? `（${c}：${CODE_ZH[c] ?? '系统错误'}）` : '' }
const fail = (what, abs, e) => { throw new Error(`${what}失败：${abs}${describeErr(e)}`) }

/** root 的 realpath（拿不到就退回原路径：后续操作会自己报错） */
const realOf = (p) => { try { return realpathSync(p) } catch { return p } }

/**
 * 防"路径中途经过越界符号链接"：取 **dirname(abs) 的最近存在祖先** realpath 复查。
 * 只看父链、不看 abs 自身 —— 因为本模块**不跟随**操作数（那可能正是要删的链接）。
 */
const assertParentInside = (root, abs) => {
  let cur = dirname(abs)
  for (;;) {
    if (pathExists(cur)) break
    const parent = dirname(cur)
    if (parent === cur) { cur = null; break }
    cur = parent
  }
  if (!cur) return
  const real = realOf(cur)
  if (!contains(realOf(root), real)) throw new Error(`路径越界（符号链接）：${abs}`)
}

/** 解析单个路径到沙箱内绝对路径；越界/非法抛错。绝对路径照用；相对路径按 base 解析。 */
export function resolveTarget (root, base, raw) {
  const p = trim(raw)
  if (!p) throw new Error('路径不能为空')
  if (ENDS_DOT.test(p)) throw new Error(`路径不能以 "/." 结尾：${p}`)
  const abs = isAbsolute(p) ? resolve(p) : resolve(base, p)
  if (!contains(root, abs)) throw new Error(`路径必须在工作区/记忆文件夹内（${root}）：${p}`)
  assertParentInside(root, abs)
  return abs
}

/**
 * 展开 from/path：末尾 `/*` → 该目录下的**直接**子项；否则单个目标。
 * @returns {{wildcard: boolean, dir: string|null, entries: string[]}}
 */
export function expand (root, base, raw) {
  const p = trim(raw)
  if (!p) throw new Error('路径不能为空')
  if (HAS_STAR.test(p)) {
    if (!/[/\\]\*$/.test(p)) throw new Error(`通配符只能写成末尾的 "/*"（选中该目录下的直接子项）：${p}`)
    const dirRaw = p.replace(/[/\\]\*$/, '')
    const dir = resolveTarget(root, base, dirRaw)
    let st
    try { st = statSync(dir) } catch (e) { fail('读取目录', dirRaw, e) }
    if (!st.isDirectory()) throw new Error(`通配符只能用在目录上：${dirRaw}`)
    let names
    try { names = readdirSync(dir) } catch (e) { fail('读取目录', dirRaw, e) }
    return { wildcard: true, dir, entries: names.map((n) => join(dir, n)) }
  }
  return { wildcard: false, dir: null, entries: [resolveTarget(root, base, p)] }
}

/** 复制（递归；**保留符号链接**）。dst 由调用方定好（是最终名字）；父目录请先备好。 */
export function copyEntry (src, dst) {
  try { cpSync(src, dst, { recursive: true, dereference: false, verbatimSymlinks: true, force: true, errorOnExist: false }) } catch (e) { fail('复制', src, e) }
}

/** 移动：先 rename，跨盘（EXDEV）再退回 复制+删除。 */
export function moveEntry (src, dst) {
  try { renameSync(src, dst) } catch (e) {
    if (e?.code !== 'EXDEV') fail('移动', src, e)
    copyEntry(src, dst)
    removeEntry(src)
  }
}

/** 删除：lstat（**不跟随**）——链接/文件 unlinkSync，目录 rmSync 递归。 */
export function removeEntry (abs) {
  let st
  try { st = lstatSync(abs) } catch (e) { fail('删除', abs, e) }
  try {
    if (st.isDirectory()) rmSync(abs, { recursive: true, force: true })
    else unlinkSync(abs)
  } catch (e) { fail('删除', abs, e) }
}

/** 建目录（递归）。 */
export function makeDir (abs) {
  try { mkdirSync(abs, { recursive: true }) } catch (e) { fail('创建目录', abs, e) }
}

/** 备好 dst 的父目录（不存在就递归建）——copy/move 目标父目录自动创建。 */
export function ensureParentDir (dst) {
  const d = dirname(dst)
  if (!isDir(d)) makeDir(d)
}

/**
 * 命中"受保护/凭据/沙箱根"时返回人话原因，否则 null。
 * 受保护只认**沙箱根级**的那几个（`_global/config.json` 这种嵌套的照常可写）。
 */
export function forbiddenReason (root, abs) {
  const p = String(abs ?? '')
  if (CREDENTIAL_PATH_RE.test(p) || SECRETS_DIR_RE.test(p)) {
    return '凭据 / 凭据备忘目录不可删改（账号密码在「MC设置」里维护）。'
  }
  if (samePath(abs, root)) return '不能删除或移动根目录本身。'
  if (samePath(dirname(abs), root) && isProtectedName(basename(abs))) {
    return `受保护文件（${basename(abs)}）不可删改。`
  }
  return null
}

/** abs 是不是某个"根目录本身"（工作区根 / 记忆根）——move 的 from、delete 都不许选中它们。 */
export function rootReason (abs, roots) {
  for (const r of roots ?? []) {
    if (r && samePath(abs, r)) return '工作区目录 / 记忆目录本身不能被移动或删除。'
  }
  return null
}

/** a 是不是在 b 目录**里面**（用于"不能把目录拷进它自己"） */
export function isInside (a, b) {
  const bk = key(resolve(b)); const ak = key(resolve(a))
  return ak !== bk && ak.startsWith(withSep(bk))
}
