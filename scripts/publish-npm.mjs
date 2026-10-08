/**
 * whale_craft · 本机发布 npm（`npm run publish:npm`）
 * ============================================================================
 * 为什么要有它（用户 2026-09-17）：
 *   · CI 里那步 `npm publish` 已经**删掉**了（token 一失效就红叉，而发布其实早就成功）；
 *   · 想发 npm 时，**在本机 IDE 的终端里手动发**：全流程带前置校验、失败就停、默认要确认。
 *
 * 它做的事（顺序）：
 *   ① 工作树必须干净（发出去的东西要能对上某个提交）；
 *   ② 版本一致性：package.json 的 version 必须在 CHANGELOG.md 里有一节；
 *   ③ 跑 `tools/check-core.mjs` + `selfcheck.mjs`（除非 --skip-checks）；
 *   ④ `npm whoami` 确认 token 可用（拿不到就停，别等 publish 才 404）；
 *   ⑤ 该版本**必须还没发过**（`npm view <name>@<version>` 查得到就停）；
 *   ⑥ `npm pack --dry-run` 打出清单（顺带核对没混进 logs/账户/配置）；
 *   ⑦ 提醒 GitHub Release 有没有对应 tag/Release（只是提醒，不拦）；
 *   ⑧ `npm publish --access public --ignore-scripts`（除非 --dry）—— ③ 已经跑过同一套检查，
 *      所以发布时跳过 lifecycle，不让 `prepublishOnly` 再跑第二遍。
 *
 * 用法：
 *   node scripts/publish-npm.mjs                 # 真发（会先让你确认）
 *   node scripts/publish-npm.mjs --dry           # 只走到 pack 清单，不发
 *   node scripts/publish-npm.mjs --yes           # 跳过确认（IDE 终端里方便）
 *   node scripts/publish-npm.mjs --skip-checks   # 跳过 ③（不推荐；发布时也不再触发 prepublishOnly）
 *   node scripts/publish-npm.mjs --otp 123456    # 有 2FA 时带上一次性码
 *   node scripts/publish-npm.mjs --tag next      # 发到某个 dist-tag（默认 latest）
 *   node scripts/publish-npm.mjs --dry --skip-auth   # 没配 token 时也能把前置检查跑完（试跑用）
 *
 * Token 放哪（**别写进仓库**）：`npm login`，或环境变量 `NODE_AUTH_TOKEN`，
 * 或 `~/.npmrc` 里 `//registry.npmjs.org/:_authToken=...`。仓库里的 .npmrc 只写了 registry。
 * ============================================================================
 */
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const valueOf = (flag, fallback = null) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const DRY = has('--dry')
const YES = has('--yes')
const SKIP_CHECKS = has('--skip-checks')
const SKIP_AUTH = has('--skip-auth')
const OTP = valueOf('--otp')
const DIST_TAG = valueOf('--tag', 'latest')

const step = (n, text) => console.log(`\n[${n}] ${text}`)
const ok = (text) => console.log(`  ✅ ${text}`)
const warn = (text) => console.log(`  ⚠️  ${text}`)
const die = (text) => { console.error(`\n❌ ${text}\n`); process.exit(1) }

/**
 * 跑一个命令并把输出接过来（stdio inherit：npm 的彩色/进度照常显示）。
 * ⚠️ Windows 上 `npm` 是 `npm.cmd`，只能经 cmd 跑；但**不能**用 `shell: true`
 *   （Node 会警告 DEP0190，而且 `node.exe` 的路径 `D:\Program Files\…` 会被拆开 —— 2026-09-17 真踩过）。
 *   所以显式走 `cmd.exe /c npm …`，其它命令一律直接 spawn。
 */
const spawnFor = (cmd, args) =>
  process.platform === 'win32' && cmd === 'npm' ? ['cmd.exe', ['/c', 'npm', ...args]] : [cmd, args]
const run = (cmd, args, opts = {}) => {
  const [c, a] = spawnFor(cmd, args)
  return execFileSync(c, a, { cwd: ROOT, stdio: 'inherit', ...opts })
}
/** 跑一个命令只取输出（用于判断，不打印） */
const capture = (cmd, args, opts = {}) => {
  const [c, a] = spawnFor(cmd, args)
  try {
    return { code: 0, out: execFileSync(c, a, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', ...opts }).trim() }
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout ?? '').trim(), err: String(e.stderr ?? '').trim() }
  }
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const name = pkg.name
const version = pkg.version
console.log(`whale_craft · 本机发布 npm${DRY ? '（dry-run：最后一步不会真发）' : ''}`)
console.log(`  包：${name}@${version}｜dist-tag：${DIST_TAG}`)

step(1, '工作树干净？')
{
  const st = capture('git', ['status', '--porcelain'])
  if (st.code !== 0) warn('不是 git 仓库 / 拿不到状态，跳过这项检查')
  else if (st.out) die(`工作树不干净（先提交或 stash）：\n${st.out}`)
  else ok('干净')
}

step(2, 'CHANGELOG.md 里有这个版本的一节？')
{
  const p = join(ROOT, 'CHANGELOG.md')
  if (!existsSync(p)) die('没有 CHANGELOG.md —— 发布必须写明这一版改了什么')
  const text = readFileSync(p, 'utf8')
  if (!text.includes(`## [${version}]`)) die(`CHANGELOG.md 里找不到 "## [${version}]" 这一节`)
  ok(`有 ## [${version}]`)
}

step(3, '离线自检（check-core + selfcheck）')
if (SKIP_CHECKS) warn('--skip-checks：跳过了')
else {
  run(process.execPath, ['tools/check-core.mjs'])
  run(process.execPath, ['selfcheck.mjs'])
  ok('全绿')
}

step(4, 'npm token 可用？（npm whoami）')
if (SKIP_AUTH) warn('--skip-auth：跳过了（只有试跑才该这么用）')
else {
  const who = capture('npm', ['whoami'])
  if (who.code !== 0) die(`npm whoami 失败 —— 先 \`npm login\` 或设好 NODE_AUTH_TOKEN。原始输出：\n${who.out || who.err}`)
  ok(`已登录：${who.out}`)
  const reg = capture('npm', ['config', 'get', 'registry'])
  ok(`registry = ${reg.out}`)
  if (!/registry\.npmjs\.org/.test(reg.out)) warn('不是官方 registry：确认你真的要往这里发')
}

step(5, `npm 上 ${name}@${version} 还没被占？`)
{
  const seen = capture('npm', ['view', `${name}@${version}`, 'version'])
  if (seen.code === 0 && seen.out.includes(version)) die(`${name}@${version} 已经发布过了（npm 不允许覆盖同版本）`)
  ok('没发过')
  const latest = capture('npm', ['view', name, 'dist-tags.latest'])
  ok(`当前 latest = ${latest.code === 0 && latest.out ? latest.out : '(还没有任何版本)'}`)
}

step(6, 'npm pack 清单（不该有 logs / 账户 / 配置）')
{
  const packed = capture('npm', ['pack', '--dry-run', '--json'])
  if (packed.code !== 0) die(`npm pack --dry-run 失败：${packed.out || packed.err}`)
  const info = JSON.parse(packed.out)[0]
  const files = info.files.map((f) => f.path)
  console.log(`  ${info.entryCount} 个文件 / ${(info.size / 1024).toFixed(1)} KB：`)
  for (const f of files) console.log(`    ${f}`)
  const forbidden = files.filter((f) => /(^|\/)(node_modules|logs)\/|accounts\.json$|config\.json$|\.whale-craft/.test(f))
  if (forbidden.length) die(`清单里混进了运行期产物：${forbidden.join(', ')}`)
  ok('清单干净')
}

step(7, 'GitHub 那边有对应的 tag / Release 吗？（只提醒）')
{
  const tag = `v${version}`
  const t = capture('git', ['tag', '--list', tag])
  if (t.out === tag) ok(`本地有 tag ${tag}`)
  else warn(`本地没有 tag ${tag}（npm 与 GitHub 版本会对不上，建议先发 Release）`)
}

// --ignore-scripts：③ 已经把 prepublishOnly 那套（check-core + selfcheck）跑过了，不加会被
// lifecycle 再跑一遍 —— 重复又慢。prepublishOnly 留着拦"裸跑 npm publish"的人。
const cmdArgs = ['publish', '--access', 'public', '--ignore-scripts', '--tag', DIST_TAG, ...(OTP ? ['--otp', OTP] : [])]
step(8, DRY ? '（dry-run 到此为止，没有发布）' : `npm ${cmdArgs.join(' ')}`)
if (DRY) {
  console.log('  想真发就去掉 --dry。')
} else {
  if (!YES) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question(`\n要发布 ${name}@${version} 到 npm（dist-tag ${DIST_TAG}）吗？输入 yes 继续：`)
    rl.close()
    if (answer.trim().toLowerCase() !== 'yes') die('已取消')
  }
  run('npm', cmdArgs)
  ok(`已发布：https://www.npmjs.com/package/${name}/v/${version}`)
  console.log(`\n提示：npm 上的版本不会自动更新，下次发之前记得先 bump package.json + 写 CHANGELOG。`)
}
