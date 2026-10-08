// -*- coding: utf-8 -*-
/**
 * whale_craft / fsops.mjs —— `mc_kit_fs` 的文件系统操作（**纯函数、只吃路径**，便于自检单测）
 * ============================================================================
 * 用户 2026-10-08 定的语义（见 dev-docs/tools/mc-tools.md「mc_kit_fs」）：
 *   · action：copy / move / delete / make_dir，**都递归**；
 *   · 末尾 `/*` 通配：选中该目录下**直接**子项（不是深层 glob）；
 *   · **保留符号链接（不跟随）**：copy 把链接原样复制成链接，delete 删链接本身；
 *   · 沙箱：调用方传入 `root`（MC=.whale-craft，MC+=工作区）；相对路径以 `base`（工作区根）为基准；
 *   · 受保护文件（RULES.md/AGENTS.md/config.json）与凭据路径**不可删改**。
 *
 * 安全：本模块**不跟随**符号链接，但仍防"路径中途经过越界符号链接"——
 *   `root/link -> /etc` 这类，取**父目录的 realpath** 复查（与发布区 index.js 的 realpath 复查同风格）。
 *   这样"操作 root 内的 symlink 本身"仍然允许（我们要删的就是那个链接），
 *   而"顺着越界链接往里走"会被拒。
 * ============================================================================
 */
import { existsSync, readdirSync, lstatSync, statSync, mkdirSync, renameSync, rmSync, unlinkSync, cpSync, realpathSync } from 'node:fs'
import { resolve, join, dirname, sep, isAbsolute, basename } from 'node:path'
import { isProtectedName, CREDENTIAL_PATH_RE, SECRETS_DIR_RE } from './protected.mjs'

const trim = (v) => String(v ?? '').trim()
const withSep = (p) => (p.endsWith(sep) ? p : p + sep)

/** abs 是否在 root 之内（或就是 root） */
const contains = (root, abs) => abs === root || abs.startsWith(withSep(root))

/** root 的 realpath（拿不到就退回原路径：后续操作会自己报错） */
const realOf = (p) => { try { return realpathSync(p) } catch { return p } }

/**
 * 防"路径中途经过越界符号链接"：取 **dirname(abs) 的最近存在祖先** realpath 复查。
 * 只看父链、不看 abs 自身 —— 因为本模块**不跟随**操作数（那可能正是要删的链接）。
 */
const assertParentInside = (root, abs) => {
  let cur = dirname(abs)
  for (;;) {
    if (existsSync(cur)) break
    const parent = dirname(cur)
    if (parent === cur) { cur = null; break }
    cur = parent
  }
  if (!cur) return
  const real = realOf(cur)
  if (!contains(realOf(root), real)) throw new Error(`路径越界（符号链接）：${abs}`)
}

/** 解析单个路径到沙箱内绝对路径；越界抛错。绝对路径照用；相对路径按 base 解析。 */
export function resolveTarget (root, base, raw) {
  const p = trim(raw)
  if (!p) throw new Error('路径不能为空')
  const abs = isAbsolute(p) ? resolve(p) : resolve(base, p)
  if (!contains(root, abs)) throw new Error(`路径必须在沙箱内（${root}）：${p}`)
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
  if (/\*$/.test(p)) {
    if (!/[/\\]\*$/.test(p)) throw new Error(`通配符只能写成末尾的 "/*"：${p}`)
    const dirRaw = p.replace(/[/\\]\*$/, '')
    const dir = resolveTarget(root, base, dirRaw)
    let st
    try { st = statSync(dir) } catch { throw new Error(`目录不存在：${dirRaw}`) }
    if (!st.isDirectory()) throw new Error(`通配符只能用在目录上：${dirRaw}`)
    return { wildcard: true, dir, entries: readdirSync(dir).map((n) => join(dir, n)) }
  }
  return { wildcard: false, dir: null, entries: [resolveTarget(root, base, p)] }
}

/** 复制（递归；**保留符号链接**）。dst 由调用方定好（是最终名字）。 */
export function copyEntry (src, dst) {
  cpSync(src, dst, { recursive: true, dereference: false, verbatimSymlinks: true, force: true, errorOnExist: false })
}

/** 移动：先 rename，跨盘（EXDEV）再退回 复制+删除。 */
export function moveEntry (src, dst) {
  try { renameSync(src, dst) } catch (e) {
    if (e?.code !== 'EXDEV') throw e
    copyEntry(src, dst)
    removeEntry(src)
  }
}

/** 删除：lstat（**不跟随**）——链接/文件 unlinkSync，目录 rmSync 递归。 */
export function removeEntry (abs) {
  const st = lstatSync(abs)
  if (st.isDirectory()) rmSync(abs, { recursive: true, force: true })
  else unlinkSync(abs)
}

/** 建目录（递归）。 */
export function makeDir (abs) {
  mkdirSync(abs, { recursive: true })
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
  if (abs === root) return '不能删除或移动沙箱根目录本身。'
  if (dirname(abs) === root && isProtectedName(basename(abs))) {
    return `受保护文件（${basename(abs)}）不可删改。`
  }
  return null
}
