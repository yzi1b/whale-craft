// TypeScript 渐进迁移构建：只编译已出现的 TS 模块，旧 JS/MJS 保持原运行路径。
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const dist = join(root, 'dist')
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')

if (existsSync(dist)) rmSync(dist, { recursive: true, force: true })
execFileSync(process.execPath, [tsc, '--project', join(root, 'tsconfig.build.json')], { cwd: root, stdio: 'inherit' })

const smoke = join(dist, 'src', 'ts-platform.js')
if (!existsSync(smoke)) throw new Error('TypeScript 构建未生成 dist/src/ts-platform.js')
const built = await import(`${pathToFileURL(smoke).href}?built=${Date.now()}`)
if (built.TS_PLATFORM?.nativeTypeStripping !== true) throw new Error('TypeScript 构建产物无法加载或内容错误')

console.log('✅ TypeScript 构建完成：类型检查、JS、声明文件与 source map 均已生成')
