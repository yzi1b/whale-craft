// -*- coding: utf-8 -*-
/**
 * 隔离实例工具（遵守 2026-09-14 立的操作边界）：
 *   - 只用**高位未登记端口**（默认在 39901 起，自动找空闲口）
 *   - 起之前先探测端口是否空闲，**绝不碰** 14640/14651/108xx 等已登记端口
 *   - 用脱离进程启动，**记录自己 spawn 的 pid**；清理时**只按这个 pid 杀**（不用 taskkill /T）
 *
 * 用法：
 *   node tools/isolate.mjs start   [--port 39901]
 *   node tools/isolate.mjs status
 *   node tools/isolate.mjs stop
 */
import { spawn, execFileSync } from 'node:child_process'
import { openSync, writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync, copyFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const LOGS = join(PKG, 'logs')
const PIDFILE = join(LOGS, 'isolate-pid.json')
/** 隔离实例**自己的**状态目录（配置 + 账户库）——🔴 绝不能让隔离实例写到生产状态上
 *  （真实事故：e2e 的清场步骤把用户刚加的认证服务器删了）。 */
const STATE_DIR = join(LOGS, 'isolate-state')
/**
 * 跑隔离实例需要一个 **DSH checkout**（要 `apps/cli/src/bin.ts`）与一个 node 可执行文件。
 * 两者都**不再写死**：checkout 走 `DSH_ROOT` 环境变量（或 `--dsh-root <dir>`），node 用当前进程自己的。
 */
const DSH_ROOT = process.env.DSH_ROOT
  ?? (() => {
    const i = process.argv.indexOf('--dsh-root')
    const raw = i >= 0 ? process.argv[i + 1] : ''
    if (!raw) return ''
    // ð´ æ¥æ¶ç¬¬ä¸æ¹è¾å¥åé¿æ¢æ§å¶å­ç¦/Shell åè§å­ç¦æ³é²ç«¯å£æ³¨å¥ï¼å¹¶å½ä¸åä¸ºç»å¯¹è·¯å¾ã
    if (/[\0\r\n;&|`$]/.test(raw)) throw new Error('--dsh-root åå«éæ³å­ç¦')
    return resolve(raw)
  })()
const NODE = process.execPath
/** 严禁占用的已登记端口（示例：这几个端口上跑着别的服务）。可用 `ISOLATE_FORBIDDEN=1,2,3` 覆盖。 */
const FORBIDDEN = (process.env.ISOLATE_FORBIDDEN
  ? String(process.env.ISOLATE_FORBIDDEN).split(',').map((n) => Number(n.trim())).filter(Boolean)
  : [14640, 14651, 14652, 10811, 10820, 10840, 10842, 10850, 23333, 24444, 25565, 25576])
const ISOLATE_START_PORT = Number(process.env.ISOLATE_PORT ?? 39901)
const ISOLATE_PORT_RANGE = Number(process.env.ISOLATE_PORT_RANGE ?? 20)

/** 生产状态目录（与插件里的 resolveStateDir 同一套规矩：$DSH_HOME → ~/.dsh） */
const prodStateDir = () => join(String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh'), 'whale_craft')

/**
 * 给隔离实例**拷一份**当前状态当底子（这样它有真实的默认账户，但改动只落在副本上）。
 * 优先取生产状态目录；生产还没搬过去（老版本）就取工作区 `.whale-craft/`。
 */
function seedStateDir () {
  mkdirSync(STATE_DIR, { recursive: true })
  for (const f of ['config.json', 'accounts.json']) {
    const dst = join(STATE_DIR, f)
    if (existsSync(dst)) continue
    for (const src of [join(prodStateDir(), f), join(PKG, '..', '.whale-craft', f)]) {
      if (existsSync(src)) { copyFileSync(src, dst); break }
    }
  }
  return STATE_DIR
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
  for (let p = ISOLATE_START_PORT; p < ISOLATE_START_PORT + ISOLATE_PORT_RANGE; p++) {
    if (FORBIDDEN.includes(p)) continue
    if (await freePort(p)) return p
  }
  throw new Error(`${ISOLATE_START_PORT}-${ISOLATE_START_PORT + ISOLATE_PORT_RANGE - 1} 都不可用`)
}

const pidAlive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

const cmd = process.argv[2] ?? 'status'
const portArg = Number((process.argv.find((a) => a.startsWith('--port=')) ?? '').split('=')[1] || process.argv[process.argv.indexOf('--port') + 1]) || null

if (cmd === 'start') {
  if (existsSync(PIDFILE)) {
    const old = JSON.parse(readFileSync(PIDFILE, 'utf8'))
    if (pidAlive(old.pid)) {
      console.log(`已有隔离实例在跑：pid=${old.pid} port=${old.port}（先 stop，或复用）`)
      process.exit(0)
    }
    console.log(`发现过期记录（pid=${old.pid} 已退出），清理后继续`)
    unlinkSync(PIDFILE)
  }
  mkdirSync(LOGS, { recursive: true })
  if (!DSH_ROOT || !existsSync(join(DSH_ROOT, 'apps', 'cli', 'src', 'bin.ts'))) {
    console.error('需要一个 DSH checkout 才能起隔离实例：设 DSH_ROOT=<dsh 仓库目录>（要含 apps/cli/src/bin.ts），或用 --dsh-root <目录>')
    process.exit(2)
  }
  const port = await pickPort(portArg)
  const out = openSync(join(LOGS, `isolate-${port}-out.log`), 'a')
  const err = openSync(join(LOGS, `isolate-${port}-err.log`), 'a')
  const stateDir = seedStateDir()
  const child = spawn(NODE, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--port', String(port), '--trusted-host', '127.0.0.1', '--no-open'], {
    cwd: DSH_ROOT,
    detached: true,
    stdio: ['ignore', out, err],
    windowsHide: true,
    // 🔴 隔离实例有**自己的**状态目录：配置/账户改动只落副本，绝不碰生产。
    // 🔴 记忆根也钉在副本里：否则"进 MC 模式会话 / 点开 MC设置"会按会话工作区去建 `.whale-craft/`，
    //    而那些会话的工作区是**生产工作区** → 隔离实例会往生产里写文件。
    // 🔴 preset 根目录**没法 redirect**（它在 DSH 的 agent-presets 配置里），也就是
    //    `~/.dsh/.agent-presets` 与本机生产共用 —— 插件"给已存在的 preset 补工具组"会直接改
    //    用户手写的那份。所以隔离实例一律禁止写 preset（插件认这个开关，只记日志）。
    env: { ...process.env, WHALE_CRAFT_STATE_DIR: stateDir, WHALE_CRAFT_MEMORY_DIR: join(stateDir, 'memory'), WHALE_CRAFT_NO_PRESET_WRITE: '1' },
  })
  child.unref()
  writeFileSync(PIDFILE, JSON.stringify({ pid: child.pid, port, stateDir, at: new Date().toISOString() }, null, 2))
  console.log(`已起隔离实例：pid=${child.pid} port=${port}`)
  console.log('  状态目录（副本）：' + stateDir)
  console.log('  ⚠️ preset 根目录与生产共用 → 已用 WHALE_CRAFT_NO_PRESET_WRITE=1 禁掉写 preset')
  console.log(`  日志：whale_craft/logs/isolate-${port}-out.log`)
  console.log('  等 ~40 秒后跑 `node whale_craft/tools/isolate.mjs status` 看整树是否加载成功')
  process.exit(0)
}

if (cmd === 'status') {
  if (!existsSync(PIDFILE)) { console.log('没有隔离实例记录'); process.exit(0) }
  const info = JSON.parse(readFileSync(PIDFILE, 'utf8'))
  const alive = pidAlive(info.pid)
  let listening = ''
  try {
    listening = execFileSync('cmd', ['/c', `netstat -ano | findstr :${info.port}`], { encoding: 'utf8' }).trim()
  } catch { listening = '' }
  const hasListen = /LISTENING/.test(listening)
  console.log(`隔离实例 pid=${info.pid}（${alive ? '活着' : '已退出'}）port=${info.port}`)
  console.log(hasListen ? `✅ 端口 ${info.port} 在监听 → 整树加载成功` : `⚠️ 端口 ${info.port} 没人听 → 整树可能加载失败，看日志`)
  try {
    const out = readFileSync(join(LOGS, `isolate-${info.port}-out.log`), 'utf8').trim().split('\n').slice(-3).join('\n')
    const err = readFileSync(join(LOGS, `isolate-${info.port}-err.log`), 'utf8').trim().split('\n').slice(-6).join('\n')
    console.log('--- 最近 out ---\n' + out)
    if (err) console.log('--- 最近 err ---\n' + err)
  } catch {}
  process.exit(0)
}

if (cmd === 'stop') {
  if (!existsSync(PIDFILE)) { console.log('没有隔离实例记录，无需清理'); process.exit(0) }
  const info = JSON.parse(readFileSync(PIDFILE, 'utf8'))
  if (pidAlive(info.pid)) {
    // 只按自己记录的 pid 杀，不用 /T（避免连带别人的进程树）
    try { process.kill(info.pid, 'SIGKILL'); console.log(`已结束隔离实例 pid=${info.pid}`) }
    catch (e) { console.log(`结束失败：${e.message}`) }
  } else console.log(`pid=${info.pid} 已不在`)
  unlinkSync(PIDFILE)
  process.exit(0)
}

console.error('用法: node tools/isolate.mjs [start|status|stop] [--port N]')
process.exit(2)
