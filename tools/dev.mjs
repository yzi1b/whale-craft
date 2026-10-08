// -*- coding: utf-8 -*-
/**
 * 本地开发一键启动器 —— 把本仓库作为 whale_craft 的 **link 安装** 接进一个**独立**的
 * DSH_HOME（`.dev/home`，仓库内、已 gitignore），再按目标起调试实例：
 *
 *   npm run dev:web              # web 调试实例（浏览器 UI；Ctrl+C 停）
 *   npm run dev:web -- --watch   # 上面这个 + 改服务端代码自动重启
 *   npm run dev:desktop          # 桌面调试实例（DeepSeek Harness 桌面应用）
 *   npm run dev:link             # 只装/更新 link 与 profile，不启动
 *   npm run dev:status           # 看调试环境状态
 *   npm run dev:stop             # 停掉记录在案的 web 调试实例
 *
 * 隔离边界（对齐 tools/isolate.mjs 的既有约定）：
 *   · DSH_HOME=仓库内 .dev/home —— 账户库/配置/会话/预设/插件状态全在里面，随便造，删了重来。
 *   · 首次从 ~/.dsh 拷一份 `.credentials.yaml`（模型 key）与 whale_craft 的
 *     accounts.json / config.json 当底子；之后两边互不影响，**绝不写回生产**。
 *   · 记忆跟**会话工作区**走（`<工作区>/.whale-craft`，与生产完全一致，不再有任何重定向）：
 *     请用一个**专门的调试工作区**开会话，别拿真实工作区 —— 否则 `.whale-craft/` 会写进那边。
 *
 * 🔴 为什么必须走 link 安装：DSH 的运行时解析只认 profile 目录内的包，仓库在 profile 之外，
 *    靠 profile 里一条 cordis.patch.yml 是接不进去的 —— 必须 `dsh plugin add link:<仓库>`。
 *
 * 🔴 运行时分两套（见「运行时定位」）：
 *   · web / link：优先用 npm 全局的 dsh（只要求装过 @deepseek-ai/dsh），没有才退回桌面安装。
 *     **web 不该被那几百 MB 的桌面应用绑架。**
 *   · desktop：非桌面安装不可 —— `desktop` profile 被 Electron 应用独占（CLI 拒绝启动它），
 *     只能用桌面安装自带的 dsh 命令去管理插件。
 *
 * 🔴 desktop 的另一个硬约束：Electron 单实例锁按 userData 走，与 DSH_HOME 无关：想在调试
 *    实例里跑桌面应用，**必须先完全退出正在用的那个桌面应用**，否则新进程只会把旧窗口
 *    切到前台然后自己退出。
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, watch, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import net from 'node:net'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')
const DEV_DIR = join(PKG, '.dev')
const DEV_HOME = join(DEV_DIR, 'home')
const PIDFILE = join(DEV_DIR, 'web-instance.json')
const LINK_SPEC = 'link:' + PKG.split(sep).join('/')
/** 生产 DSH_HOME（只读，用于首次取证）。 */
const PROD_HOME = resolve(join(homedir(), '.dsh'))
/** 严禁占用的已登记端口（与 tools/isolate.mjs 同一份约定）。 */
const FORBIDDEN = [14640, 14651, 14652, 10811, 10820, 10840, 10842, 10850, 23333, 24444, 25565, 25576]
const START_PORT = Number(process.env.DEV_PORT ?? process.env.ISOLATE_PORT ?? 39901)
const PORT_RANGE = Number(process.env.DEV_PORT_RANGE ?? process.env.ISOLATE_PORT_RANGE ?? 20)
/** 改这些才需要重启服务端；client.js 是浏览器半端，客户端 HMR 管，不用重启。 */
const WATCH_FILES = ['index.js']
const WATCH_DIRS = ['src']

// ---------------------------------------------------------------------------
// 运行时定位
// ---------------------------------------------------------------------------

const pathDirs = () => String(process.env.PATH ?? '').split(';').map((d) => d.trim()).filter(Boolean)

/** 桌面安装自带的 CLI 形如 `<root>/resources/runtime/cli/bin/dsh.cmd`，据此反推安装根。 */
const installRootFromCli = (cli) => resolve(dirname(cli), '..', '..', '..', '..')

/** 校验一个「安装根」是不是可用的桌面安装；不是就返回 null。 */
function desktopInstallAt (root) {
  if (!root) return null
  root = resolve(root)
  const exe = join(root, 'DeepSeek Harness.exe')
  const archive = join(root, 'resources', 'app.asar')
  // host CLI 在 app.asar 里：普通 Node 的 existsSync 看不见它（只有 Electron 能读），
  // 所以这里只校验得到 exe 与归档本体，路径本身照 dsh.cmd 的写法拼。
  if (!existsSync(exe) || !existsSync(archive)) return null
  const hostCli = join(archive, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
  return { root, exe, hostCli }
}

/**
 * 从注册表卸载项里捞安装根目录 —— 装在非 C: 盘（如 `D:\Program Files\DeepSeek Harness`）时
 * 唯一靠谱的线索。只看 ProgramFiles / LOCALAPPDATA 两个环境变量是找不到的（真实坑：
 * 装在 D: 上就一路报"没有 exe / app.asar"）。
 */
function registryInstallRoots () {
  const keys = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ]
  const roots = []
  for (const key of keys) {
    let out
    try { out = execFileSync('reg', ['query', key, '/s'], { encoding: 'latin1', timeout: 20000 }) } catch { continue }
    // /s 按空行分块（子键一块一表）；只在提到 DeepSeek Harness 的块里取 InstallLocation，
    // 免得把别的软件的位置也捞进来。用 latin1 只为让 ASCII 行不被中文代码页弄乱。
    for (const block of out.split(/\r?\n\s*\r?\n/)) {
      if (!/DeepSeek\s+Harness/i.test(block)) continue
      const m = block.match(/InstallLocation\s+REG_SZ\s+(.+)/i)
      if (m) roots.push(m[1].trim())
    }
  }
  return roots
}

/**
 * 找桌面安装（Electron）。顺序：DSH_CLI 显式指定 → 注册表（能认非 C: 盘）→ PATH 上的
 * dsh.cmd（只认确实落在桌面安装布局里的）→ 两个常规安装位。找不到返回 null。
 */
function findDesktopInstall () {
  const roots = []
  if (process.env.DSH_CLI) roots.push(installRootFromCli(process.env.DSH_CLI))
  roots.push(...registryInstallRoots())
  for (const dir of pathDirs()) {
    const shim = join(dir, 'dsh.cmd')
    if (existsSync(shim)) roots.push(installRootFromCli(shim))
  }
  roots.push(join(process.env['ProgramFiles'] ?? 'C:/Program Files', 'DeepSeek Harness'))
  roots.push(join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness'))
  for (const root of roots) {
    const install = desktopInstallAt(root)
    if (install) return install
  }
  return null
}

/** 找 npm 全局装的 dsh（PATH 上的 shim + 同级的 @deepseek-ai/dsh/lib/bin.js）。 */
function findNpmCli () {
  for (const dir of pathDirs()) {
    if (!existsSync(join(dir, 'dsh.cmd'))) continue
    const bin = join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (existsSync(bin)) return { dir, bin }
  }
  return null
}

/**
 * 一个「能跑 dsh 命令」的运行时。web 与 desktop 各用各的：
 * · desktop：Electron exe + app.asar 里的 host CLI（desktop profile 只有这个管得了）。
 * · npm：普通 node 跑 npm 包里的 bin.js；web 够用，且不必装那几百 MB 的桌面应用。
 */
const desktopRuntime = (install) => ({
  label: `桌面安装（${install.root}）`,
  spawn: (args) => ({ cmd: install.exe, args: ['--expose-internals', install.hostCli, ...args] }),
})
const npmRuntime = (npm) => ({
  label: `npm 全局 dsh（${npm.dir}）`,
  spawn: (args) => ({ cmd: process.execPath, args: [npm.bin, ...args] }),
})

/**
 * web / link 用哪个运行时：优先 npm 全局 dsh，没有才退回桌面安装。DSH_CLI 显式指了的话
 * 就听它的（跳过 npm）—— 那是个明确的手动覆盖。
 */
function webCliRuntime () {
  if (!process.env.DSH_CLI) {
    const npm = findNpmCli()
    if (npm) return npmRuntime(npm)
  }
  const install = findDesktopInstall()
  if (install) return desktopRuntime(install)
  console.error('找不到任何可用的 dsh —— npm 没全局装 @deepseek-ai/dsh，桌面版 DeepSeek Harness 也没装。')
  console.error('装一个（npm i -g @deepseek-ai/dsh）或用 DSH_CLI=<桌面安装里的 dsh.cmd> 指一下。')
  process.exit(2)
}

/** desktop 目标非桌面安装不可，找不到直接退出。 */
function requireDesktopInstall () {
  const install = findDesktopInstall()
  if (install) return install
  console.error('找不到桌面版 DeepSeek Harness 的安装 —— desktop profile 只有桌面应用管得了，非它不可。')
  console.error('装了的话用 DSH_CLI=<桌面安装里的 dsh.cmd> 指一下（装在 D: 等非 C: 盘也认）。')
  process.exit(2)
}

/**
 * 跑一条 dsh 命令（Node 模式直接起 exe，绕开 .cmd 的引号问题）。
 * 🔴 DSH_HOME 必须显式给成 DEV_HOME：漏了就会去操作生产 home（真实事故：第一版漏了，
 *    一条 `plugin add link:` 把生产 web profile 的 whale_craft 换成了本地 link）。
 */
function runDsh (runtime, args) {
  return new Promise((res, rej) => {
    const { cmd, args: argv } = runtime.spawn(args)
    const child = spawn(cmd, argv, { cwd: PKG, env: childEnv(), stdio: 'inherit', windowsHide: true })
    child.on('error', rej)
    child.on('exit', (code) => code === 0 ? res() : rej(new Error(`dsh ${args.join(' ')} 退出码 ${code}`)))
  })
}

// ---------------------------------------------------------------------------
// 调试环境准备
// ---------------------------------------------------------------------------

/** 首次把生产那份"底子"拷进调试 home：模型凭据 + 插件自己的账户/配置。 */
function seedDevHome () {
  mkdirSync(DEV_HOME, { recursive: true })
  const seeds = [
    [join(PROD_HOME, '.credentials.yaml'), join(DEV_HOME, '.credentials.yaml')],
    [join(PROD_HOME, 'whale_craft', 'accounts.json'), join(DEV_HOME, 'whale_craft', 'accounts.json')],
    [join(PROD_HOME, 'whale_craft', 'config.json'), join(DEV_HOME, 'whale_craft', 'config.json')],
  ]
  const copied = []
  for (const [src, dst] of seeds) {
    if (existsSync(dst) || !existsSync(src)) continue
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(src, dst)
    copied.push(dst.slice(DEV_HOME.length + 1).split(sep).join('/'))
  }
  if (copied.length) console.log(`首次初始化调试 home：从 ${PROD_HOME} 拷了 ${copied.join('、')}（副本，改不到生产）`)
}

/** 插件依赖没装的话先装（link 安装要靠仓库自己的 node_modules 解析 mineflayer）。 */
function ensureRepoDeps () {
  if (existsSync(join(PKG, 'node_modules', 'mineflayer'))) return
  console.log('仓库还没装依赖，先跑 npm install …')
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: PKG, stdio: 'inherit', shell: true })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

const norm = (p) => resolve(p).toLowerCase()

/** profile 是否已经是"指向本仓库"的 link 安装（清单 + 软链落地都对才算）。 */
function isLinked (profile) {
  const dir = join(DEV_HOME, 'profiles', profile)
  const manifest = join(dir, 'package.json')
  if (!existsSync(manifest)) return false
  try {
    if (JSON.parse(readFileSync(manifest, 'utf8')).dependencies?.whale_craft !== LINK_SPEC) return false
  } catch { return false }
  try {
    return norm(realpathSync(join(dir, 'node_modules', 'whale_craft'))) === norm(PKG)
  } catch { return false }
}

/** 把本仓库 link 进调试 home 的 profile（web 会自动从随附模板初始化；desktop 得先让应用建）。 */
async function linkProfile (profile, runtime) {
  if (isLinked(profile)) {
    console.log(`profile ${profile}：已 link 到 ${PKG}`)
    return
  }
  console.log(`profile ${profile}：装 link（${LINK_SPEC}）…`)
  // Windows 上 pnpm 没法直接 rename 覆盖已存在的目录软链（EPERM），旧 link 先摘掉再装。
  // 只摘软链：真目录（npm 装的包）交给 pnpm 自己换，绝不 rm 真实目录。
  const landed = join(DEV_HOME, 'profiles', profile, 'node_modules', 'whale_craft')
  try {
    if (lstatSync(landed).isSymbolicLink()) { unlinkSync(landed); console.log(`   （先摘掉旧的软链 ${landed}）`) }
  } catch {}
  await runDsh(runtime, ['plugin', '--profile', profile, 'add', LINK_SPEC])
  if (!isLinked(profile)) {
    console.error(`装完了，但 ${profile} profile 没对上（清单或软链不符），去看 ${join(DEV_HOME, 'profiles', profile)}`)
    process.exit(1)
  }
  console.log(`profile ${profile}：✅ 已 link（DSH 重启后生效）`)
}

const freePort = (p) => new Promise((res) => {
  const s = net.createServer()
  s.once('error', () => res(false))
  s.listen(p, '127.0.0.1', () => s.close(() => res(true)))
})

async function pickPort (wanted) {
  if (wanted) {
    if (FORBIDDEN.includes(wanted)) throw new Error(`端口 ${wanted} 是已登记端口，禁止占用`)
    if (!(await freePort(wanted))) throw new Error(`端口 ${wanted} 被占用`)
    return wanted
  }
  for (let p = START_PORT; p < START_PORT + PORT_RANGE; p++) {
    if (FORBIDDEN.includes(p)) continue
    if (await freePort(p)) return p
  }
  throw new Error(`${START_PORT}-${START_PORT + PORT_RANGE - 1} 都不可用，用 --port 指定别的`)
}

/**
 * 子进程环境：DSH_HOME 钉在调试 home（记忆根跟会话工作区走，见文件头）。
 * 🔴 ELECTRON_RUN_AS_NODE 必须带上 —— 少它的话那个 exe 会以**桌面应用本体**启动
 *    （真实事故：bootWeb 漏了它，`dev:web` 拉起的是 GUI 窗口 + desktop profile）。
 *    只有 launchDesktop 那个真正要开窗口的地方才把它摘掉。
 */
function childEnv () {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME: DEV_HOME,
  }
}

// ---------------------------------------------------------------------------
// web 目标
// ---------------------------------------------------------------------------

async function startWeb (opts) {
  const running = readPidfile()
  if (running) {
    // 两个实例共用一个 DSH_HOME（会话/存储/插件状态）会互相打架，别放它过去
    console.error(`已经有一个 web 调试实例在跑（pid=${running.pid} port=${running.port}）。`)
    console.error('先 `npm run dev:stop` 停掉它，或者 `npm run dev:status` 看看情况。')
    process.exit(1)
  }
  const runtime = webCliRuntime()
  ensureRepoDeps()
  seedDevHome()
  await linkProfile('web', runtime)
  const port = await pickPort(opts.port)
  say([
    'whale_craft 调试实例（web）',
    `  地址   下面那行「dsh web: http://…」就是（带 token，直接点开）`,
    `  home   ${DEV_HOME}`,
    `  插件   ${PKG}（link）`,
    `  运行时 ${runtime.label}`,
    `  热更   改 ${WATCH_FILES.join('/')}、${WATCH_DIRS.join('/')}/ 要重启${opts.watch ? ' —— --watch 已开，自动重启' : '，加 --watch 让它自己重启'}；改 client.js 只需刷新浏览器`,
    '  记忆   跟会话工作区走：<工作区>/.whale-craft（与生产一致；请用专门的调试工作区）',
    '  停止   Ctrl+C',
  ])
  bootWeb(port, opts, opts.open, runtime)
}

let webWatchers = []
let restarting = false
let restartTimer = null

function closeWatchers () {
  for (const w of webWatchers) { try { w.close() } catch {} }
  webWatchers = []
}

function bootWeb (port, opts, open, runtime) {
  const args = ['web', '--port', String(port)]
  if (!open) args.push('--no-open')
  const { cmd, args: argv } = runtime.spawn(args)
  const child = spawn(cmd, argv, {
    cwd: PKG,
    env: childEnv(opts),
    stdio: 'inherit',
    windowsHide: true,
  })
  writeFileSync(PIDFILE, JSON.stringify({ pid: child.pid, port, at: new Date().toISOString() }, null, 2))
  child.on('exit', (code, signal) => {
    clearPidfile(child.pid)
    if (restarting) return
    closeWatchers()
    process.exit(signal ? 0 : (code ?? 0))
  })
  if (opts.watch) attachWatcher(child, port, opts, runtime)
}

/** 看门狗：服务端代码一动就重启；client.js 只提示（浏览器半端是客户端 HMR 管的）。 */
function attachWatcher (child, port, opts, runtime) {
  const onChange = (relPath) => {
    if (/(^|\/)client\.js$/i.test(relPath)) {
      console.log(`\n[dev] 改了 ${relPath}：浏览器半端热重载，刷新页面即可`)
      return
    }
    clearTimeout(restartTimer)
    restartTimer = setTimeout(async () => {
      console.log(`\n[dev] 改了 ${relPath} → 重启调试实例…`)
      restarting = true
      try { child.kill() } catch {}
      // 等旧进程真正退出、端口放开（Windows 上退出到端口释放有几百 ms 的滞后）
      for (let i = 0; i < 40; i++) {
        if (child.exitCode !== null || child.signalCode !== null) break
        await sleep(100)
      }
      for (let i = 0; i < 40 && !(await freePort(port)); i++) await sleep(100)
      restarting = false
      closeWatchers()
      bootWeb(port, opts, false, runtime)
    }, 400)
  }
  for (const rel of WATCH_FILES) {
    const p = join(PKG, rel)
    if (!existsSync(p)) continue
    webWatchers.push(watch(p, () => onChange(rel)))
  }
  for (const rel of WATCH_DIRS) {
    const p = join(PKG, rel)
    if (!existsSync(p)) continue
    webWatchers.push(watch(p, { recursive: true }, (event, file) => {
      const path = (file ?? '').split(sep).join('/').toLowerCase()
      if (/\.(mjs|js|cjs)$/.test(path) && !path.includes('node_modules') && !/(^|\/)\./.test(path)) onChange(`${rel}/${path}`)
    }))
  }
  for (const w of webWatchers) w.on('error', (e) => console.log(`[dev] watch 出错（不影响实例）：${e.message}`))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// desktop 目标
// ---------------------------------------------------------------------------

/**
 * 桌面应用（GUI）在不在跑 —— Electron 单实例锁：它开着就轮不到调试实例。
 * 🔴 不能只看进程名：Node 模式的 CLI 与 web 调试实例**也叫** DeepSeek Harness.exe。
 *    判据是命令行里有没有 `--expose-internals`（Node 模式带、GUI 主进程不带）。
 */
function desktopAppRunning () {
  if (process.platform !== 'win32') return false
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='DeepSeek Harness.exe'\" | ForEach-Object { $_.CommandLine }",
    ], { encoding: 'utf8', timeout: 20000 })
    return out.split(/\r?\n/).some((line) => line.trim() && !line.includes('--expose-internals'))
  } catch {
    try {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'], { encoding: 'utf8' })
      return /DeepSeek Harness\.exe/i.test(out)
    } catch { return false }
  }
}

function launchDesktop (install) {
  const env = childEnv()
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(install.exe, [], { env, detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
}

const desktopManifest = () => join(DEV_HOME, 'profiles', 'desktop', 'package.json')

async function startDesktop () {
  const install = requireDesktopInstall()
  ensureRepoDeps()
  seedDevHome()
  if (!existsSync(desktopManifest())) {
    if (desktopAppRunning()) {
      console.error('桌面应用正在跑，但它连着的是**生产 home**（~/.dsh），不会去建调试 home 里的 desktop profile。')
      console.error('先完全退出那个桌面应用，再重新跑一次 npm run dev:desktop。')
      process.exit(1)
    }
    say([
      '首次：先让桌面应用自己把调试 home 的 desktop profile 建出来',
      `  home   ${DEV_HOME}`,
      '  即将启动桌面应用（这个实例还没接上插件，只是去初始化）',
      '  等它完全起来后 —— 不用在里面做任何事 —— 退出应用即可',
      '  我会盯着 profile 出现，出现后提示你下一步',
    ])
    launchDesktop(install)
    process.stdout.write('  等待 desktop profile 出现')
    for (let i = 0; i < 90; i++) {
      await sleep(2000)
      if (existsSync(desktopManifest())) {
        process.stdout.write('\n')
        say([
          'desktop profile 建好了',
          '  现在**完全退出**那个桌面应用，再跑一次 npm run dev:desktop',
          '  这次它会先把本仓库 link 进去，然后用调试 home 打开应用',
        ])
        return
      }
      process.stdout.write('.')
    }
    process.stdout.write('\n')
    console.log('  等了 3 分钟还没见到 profile —— 确认桌面应用起来了的话，退出它后重跑本命令即可。')
    return
  }
  if (desktopAppRunning()) {
    console.error('桌面应用正在运行 —— Electron 单实例锁会让新进程只把旧窗口切到前台（而那个窗口不是调试 home）。')
    console.error('先完全退出桌面应用，再跑 npm run dev:desktop。')
    process.exit(1)
  }
  await linkProfile('desktop', desktopRuntime(install))
  say([
    'whale_craft 调试实例（desktop）',
    `  home   ${DEV_HOME}`,
    `  插件   ${PKG}（link）`,
    `  运行时 桌面安装（${install.root}）`,
    '  热更   改服务端代码要退出应用重开（桌面端没有自动重启）',
    `  日志   ${join(DEV_HOME, 'whale_craft', 'logs', 'whale-craft.log')}`,
  ])
  launchDesktop(install)
}

// ---------------------------------------------------------------------------
// status / stop
// ---------------------------------------------------------------------------

const pidAlive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

function readPidfile () {
  if (!existsSync(PIDFILE)) return null
  try {
    const info = JSON.parse(readFileSync(PIDFILE, 'utf8'))
    return pidAlive(info.pid) ? info : null
  } catch { return null }
}

function clearPidfile (pid) {
  try {
    if (JSON.parse(readFileSync(PIDFILE, 'utf8')).pid === pid) unlinkSync(PIDFILE)
  } catch {}
}

function profileState (profile) {
  if (!existsSync(join(DEV_HOME, 'profiles', profile, 'package.json'))) {
    return profile === 'desktop'
      ? '未初始化（跑 npm run dev:desktop，首次会引导桌面应用去建）'
      : '未初始化（跑 npm run dev:web 会自动建）'
  }
  return isLinked(profile) ? `link → ${PKG}` : '已初始化，但 whale_craft 不是本仓库的 link'
}

function status () {
  const running = readPidfile()
  const install = findDesktopInstall()
  const npm = findNpmCli()
  console.log('whale_craft 调试环境')
  console.log(`  桌面安装  ${install ? install.root : '没找到（dev:desktop 用不了）'}`)
  console.log(`  npm dsh   ${npm ? npm.dir : '没找到'}`)
  console.log(`  web 运行时 ${npm ? 'npm 全局 dsh' : install ? '桌面安装（没装 npm 全局 dsh）' : '无 —— dev:web 用不了'}`)
  console.log(`  调试 home  ${DEV_HOME}${existsSync(DEV_HOME) ? '' : '（还没有，首次启动时建）'}`)
  console.log(`  生产 home  ${PROD_HOME}（只在首次拷一份底子，之后互不影响）`)
  console.log(`  web        ${profileState('web')}`)
  console.log(`  desktop    ${profileState('desktop')}`)
  console.log('  记忆       跟会话工作区走：<工作区>/.whale-craft（请用专门的调试工作区）')
  console.log(`  web 实例   ${running ? `在跑 pid=${running.pid} port=${running.port}（${running.at}）` : '没在跑'}`)
  console.log(`  桌面应用   ${desktopAppRunning() ? '在跑（⚠️ 与 desktop 调试实例互斥，先退出它）' : '没在跑'}`)
}

function stop () {
  const running = readPidfile()
  if (!running) { console.log('没有记录在案的 web 调试实例'); return }
  try { process.kill(running.pid); console.log(`已结束 web 调试实例 pid=${running.pid}`) } catch (e) { console.log(`结束失败：${e.message}`) }
  clearPidfile(running.pid)
}

// ---------------------------------------------------------------------------

const say = (lines) => { for (const l of lines) console.log(l) }

function parseArgs (argv) {
  const opts = { port: null, open: true, watch: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--port') opts.port = Number(argv[++i]) || null
    else if (a.startsWith('--port=')) opts.port = Number(a.slice(7)) || null
    else if (a === '--no-open') opts.open = false
    else if (a === '--open') opts.open = true
    else if (a === '--watch') opts.watch = true
    else { console.error(`不认识的参数：${a}`); process.exit(2) }
  }
  return opts
}

const [cmd = 'status', ...rest] = process.argv.slice(2)

if (cmd === 'web') await startWeb(parseArgs(rest))
else if (cmd === 'desktop') await startDesktop()
else if (cmd === 'link') {
  ensureRepoDeps()
  seedDevHome()
  await linkProfile('web', webCliRuntime())
  if (existsSync(desktopManifest())) await linkProfile('desktop', desktopRuntime(requireDesktopInstall()))
  else console.log('profile desktop：未初始化 —— 先跑 npm run dev:desktop，按提示让桌面应用把它建出来')
  console.log('接好了。web 跑 npm run dev:web；desktop 跑 npm run dev:desktop（记得先退出正在用的桌面应用）。')
} else if (cmd === 'status') status()
else if (cmd === 'stop') stop()
else {
  console.error('用法: node tools/dev.mjs [web|desktop|link|status|stop] [--port N] [--no-open] [--watch]')
  process.exit(2)
}
