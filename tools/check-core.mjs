// 全树语法验证器（2026-09-16 扩写；原版只查 core.mjs，漏过 config.mjs 的语法错）
//   用法：node whale_craft/tools/check-core.mjs
//
//   背景（两个真实事故）：
//   ① core.mjs 里少一个换行 → V8 提前结束 class 解析 → `#私有方法` 全失联 →
//      报的却是 "Private field '#authenticate' must be declared in an enclosing class"，
//      插件整树加载失败、主实例起不来。
//   ② config.mjs 里两行粘成一行（`…DEFAULT_CONFIG))const SECRET_KEYS…`）→ 只有 import 到它才会炸；
//      而当时这个脚本**只查 core.mjs**，于是它在"上主实例之前"什么都没说。
//   → 现在：src/*.{mjs,ts} + index.js + client.js + selfcheck.mjs + tools/*.{mjs,ts} **全部** --check，
//     再把"纯模块"逐个真 import 一遍（抓坏导出/循环引用这类 --check 看不出的问题）。
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const core = join(root, 'src', 'core.mjs')

const listOf = (dir, extensions = ['.mjs', '.ts']) => {
  const out = []
  const visit = (relativeDir) => {
    for (const entry of readdirSync(join(root, relativeDir), { withFileTypes: true })) {
      const relative = `${relativeDir}/${entry.name}`
      if (entry.isDirectory()) visit(relative)
      else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(relative)
    }
  }
  try { visit(dir); return out } catch { return [] }
}
/** 全部要语法检查的文件（相对包根）。
 * ⚠️ `scripts/` 只在开源副本里有（发版工具：本机发 npm / 落地工作流修复），缺失不算错 */
const TARGETS = [
  'index.js', 'client.js', 'selfcheck.mjs',
  ...listOf('src'),
  ...listOf('tools'),
  ...listOf('scripts'),
]
/** 真去 import 一遍的"纯模块"（不碰网络/文件系统副作用；core.mjs 单独处理） */
const IMPORTABLE = listOf('src').filter((f) => !f.endsWith('/core.mjs') && !f.endsWith('/types.ts'))

let failed = false
function step (name, fn) {
  try {
    fn()
    console.log(`✅ ${name}`)
  } catch (e) {
    failed = true
    console.log(`❌ ${name}`)
    console.log(String(e.stdout ?? e.stderr ?? e.message).split('\n').slice(0, 8).map((l) => '   ' + l).join('\n'))
  }
}

step(`node --check 语法（${TARGETS.length} 个文件：${TARGETS.length > 6 ? TARGETS.slice(0, 3).join(', ') + ' … ' + TARGETS.at(-1) : TARGETS.join(', ')}）`, () => {
  for (const rel of TARGETS) execFileSync(process.execPath, ['--check', join(root, rel)], { stdio: 'pipe' })
})

step('动态 import core.mjs（真实加载路径，能抓住私有方法失联）', () => {
  // 同步 step 里没法 await：用子进程执行
  execFileSync(process.execPath, ['-e', `import(${JSON.stringify(pathToFileURL(core).href)}).then(m=>{if(!m.McBot) throw new Error('McBot 未导出'); console.log('exports ok')})`], { stdio: 'pipe' })
})

step(`动态 import 其余模块（${IMPORTABLE.length} 个，抓坏导出）`, () => {
  const urls = IMPORTABLE.map((rel) => pathToFileURL(join(root, rel)).href)
  const code = `Promise.all(${JSON.stringify(urls)}.map(u=>import(u))).then(()=>console.log('ok'))`
  execFileSync(process.execPath, ['-e', code], { stdio: 'pipe' })
})

// 统计私有字段声明与引用，做一致性自检（引用里的名字必须在类体里有声明）
const src = readFileSync(core, 'utf8')
const declared = new Set([...src.matchAll(/^\s*(?:static\s+)?(?:async\s+)?(#[A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]))
const used = new Set([...src.matchAll(/this\.(#[A-Za-z_$][\w$]*)/g)].map((m) => m[1]))
step(`私有字段一致性（声明 ${declared.size} 个 / 引用 ${used.size} 个）`, () => {
  const missing = [...used].filter((u) => !declared.has(u))
  if (missing.length) throw new Error(`引用了但没声明（V8 会报 enclosing class 错）：${missing.join(', ')}`)
})

console.log(failed ? '\n结论：❌ 不要上主实例，先修上面报错的文件' : '\n结论：✅ 全树语法与模块加载都正常（仍建议按铁律起隔离实例验证整树）')
process.exit(failed ? 1 : 0)
