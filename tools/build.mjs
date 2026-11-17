// 发布构建：保留源码目录结构，将根入口、TS 与旧 MJS 一并发射到 dist/。
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const dist = join(root, 'dist')
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')

if (existsSync(dist)) rmSync(dist, { recursive: true, force: true })
execFileSync(process.execPath, [tsc, '--project', join(root, 'tsconfig.build.json')], { cwd: root, stdio: 'inherit' })

// 发布入口位于 dist/，保留与源码入口相同的相对目录结构；版本读取也应落在构建树内。
mkdirSync(dist, { recursive: true })
copyFileSync(join(root, 'package.json'), join(dist, 'package.json'))

const smoke = join(dist, 'src', 'ts-platform.js')
if (!existsSync(smoke)) throw new Error('TypeScript 构建未生成 dist/src/ts-platform.js')
if (!existsSync(join(dist, 'index.js'))) throw new Error('TypeScript 构建未生成发布入口 dist/index.js')
const built = await import(`${pathToFileURL(smoke).href}?built=${Date.now()}`)
if (built.TS_PLATFORM?.nativeTypeStripping !== true) throw new Error('TypeScript 构建产物无法加载或内容错误')

console.log('✅ 发布构建完成：dist/ 入口、运行模块、声明文件与 source map 均已生成')
