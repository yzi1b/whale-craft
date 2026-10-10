// -*- coding: utf-8 -*-
/**
 * 插件自检：用假 ctx 加载 whale_craft 的 apply()，检查
 *   - Config schema 能否解析
 *   - 工具是否全部注册（名字/参数形态）
 *   - 🔴 **每会话实例分离**：两个不同 agent 拿到的 bot 必须是不同对象；
 *     同一 agent 反复调用必须复用同一个 bot。
 *   - 未连接时调工具应给出清晰错误而不是崩
 * 不连 MC、不动真实实例。
 *
 * 用法：node whale_craft/selfcheck.mjs
 */
import { fileURLToPath } from 'node:url'

// 自检不许污染生产状态：日志、记忆库、全局配置都改到自检专用位置
// 🔴 2026-09-24（GitHub issue #1 附带）：这里**不能用 `new URL(...).pathname`** ——
//    路径里有非 ASCII 字符（例如家目录是中文用户名）时，`.pathname` 会把它百分号编码成
//    `%E4%B8%80…`，那个目录不存在 ⇒ 自检在"每会话实例分离"处 `EPERM: mkdir` 崩掉。
//    运行时不受影响（它走 `homedir()`），只有自检会被卡住。
process.env.MC_LOG = fileURLToPath(new URL('./logs/selfcheck.log', import.meta.url))
/**
 * 自检专用**临时工作区**：记忆根现在只认 `<会话工作区>/.whale-craft`（2026-10-08 删掉了
 * `WHALE_CRAFT_MEMORY_DIR` 重定向），所以需要记忆的测试 agent 一律带这个 cwd。
 */
let checkWs
{
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const whaleTmp = mkdtempSync(join(tmpdir(), 'whale-craft-'))
  process.env.WHALE_CRAFT_DIR = whaleTmp                 // 全局配置（stateDir）的固定文件夹
  checkWs = mkdtempSync(join(tmpdir(), 'whale-ws-'))     // 测试用会话工作区
}

const tools = new Map()
const logs = []
const registeredRoutes = []
const archivedSessions = []
const injectedContexts = []
const injectedFibers = []
const guards = []              // ctx.tools.guard 注册的守卫（MC 模式硬拦截靠它）
const eventHandlers = []       // ctx.on 注册的事件（agent/created 等）
const presetByCtx = new Map()  // 模拟宿主 agentPresets：agent.ctx → preset id
const presetRows = ['minimal', 'standard', 'ptc']   // 模拟"现有哪些 preset"（官方随包那三个）
const presetCopyCalls = []     // 自动建 preset 时对宿主 copy() 的调用
const { mkdtempSync: mkTop, existsSync: exTop, readFileSync: rfTop } = await import('node:fs')
const { tmpdir: tdTop } = await import('node:os')
const { join: jnTop } = await import('node:path')
/** 假"用户可写 preset 根"：自动建 preset 时把目录 / preset.yml 真写在这里，好断言内容 */
const presetUserRoot = mkTop(jnTop(tdTop(), 'whale-presets-'))
/** 假"官方随包 preset 根"：`list()` 要给出**真实存在**的组成文件路径（否则读不到组成、hash 只能是 null） */
const shippedRoot = mkTop(jnTop(tdTop(), 'whale-shipped-'))
const SHIPPED_DESC = {
  minimal: '仅提供持久 shell 的单工具编码 Agent。',
  standard: '功能完整的编码 Agent，支持文件编辑、Shell、文件与网页检索、Skills、计划、目标、子代理和工作流。',
  ptc: '功能完整的编码 Agent，但默认不提供 workflow 工具。',
}
/** id → 组成文件真实路径（copy 之后指到用户根那份） */
const presetPaths = new Map()
{
  const { mkdirSync, writeFileSync } = await import('node:fs')
  for (const [id, d] of Object.entries(SHIPPED_DESC)) {
    const dir = jnTop(shippedRoot, id)
    mkdirSync(dir, { recursive: true })
    // ⚠️ `minimal` 要写成**像真的**那份：带 persona 行（含 `complete: true`）和一个持久 shell 组 ——
    //    不然"复制完要改 persona / 关 shell"那两条集成断言就是假绿（2026-09-16 吃过一次假绿的亏）
    const comp = id === 'minimal'
      ? [
        '# The `minimal` agent preset: a fixed-prompt, single-tool coding-agent composition.',
        '',
        '- id: persona',
        "  name: '@deepseek-ai/dsh-persona'",
        '  config:',
        '    prefix: You are a helpful software engineer assistant.',
        '    complete: true',
        '    includeRuntimeContext: false',
        '',
        '- id: persistent-shell',
        '  name: cordis:group',
        '  group: true',
        '  isolate:',
        '    terminals: true',
        '  config:',
        '    - id: pty',
        "      name: '@deepseek-ai/dsh-terminal'",
        '',
      ].join('\n')
      // 🔴 2026-09-24（issue #1）：其他随包 preset 里**必须真的引用那几个包**，否则
      //    "探针能不能发现它们"根本测不出来（旧夹具只有一行注释 → 探不动也照样"看起来对"）。
      //    真实部署里 standard/ptc/cordis 都引用了这几组，这里照实模拟。
      : [
        `# ${id} composition`,
        '',
        '- id: tool-fs',
        "  name: '@deepseek-ai/dsh-tool-fs'",
        '',
        '- id: tool-fs-search',
        "  name: '@deepseek-ai/dsh-tool-fs-search'",
        '  config:',
        '    sampleOverCapGlobResults: false',
        '',
        '- id: tool-jobs',
        "  name: '@deepseek-ai/dsh-tool-jobs'",
        '',
        '- id: tool-goal',
        "  name: '@deepseek-ai/dsh-tool-goal'",
        '',
        '- id: tool-todo',
        "  name: '@deepseek-ai/dsh-tool-todo'",
        '  config:',
        '    allowParallelInProgress: true',
        '',
        '- id: present',
        "  name: '@deepseek-ai/dsh-tool-present'",
        '',
        '- id: compaction',
        '  name: cordis:group',
        '  group: true',
        '  config:',
        '    - id: compaction-basic',
        "      name: '@deepseek-ai/dsh-compaction-basic'",
        '    - id: command-compact',
        "      name: '@deepseek-ai/dsh-command-compact'",
        '    - id: tool-result-pruner',
        "      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
        '',
      ].join('\n')
    writeFileSync(jnTop(dir, 'agent.cordis.yml'), comp, 'utf8')
    writeFileSync(jnTop(dir, 'preset.yml'), `name: ${id}\ndescription: ${JSON.stringify(d)}\n`, 'utf8')
    presetPaths.set(id, jnTop(dir, 'agent.cordis.yml'))
  }
}
/** 假宿主的"读元数据"：user 根里那份读 preset.yml，官方的读 SHIPPED_DESC */
const fakeDescriptionOf = (id) => {
  const p = jnTop(presetUserRoot, id, 'preset.yml')
  if (exTop(p)) {
    const m = /^description:\s*"?(.*?)"?\s*$/m.exec(rfTop(p, 'utf8'))
    if (m) return m[1]
  }
  return SHIPPED_DESC[id]
}

// ── 超时保护单元验证（"停不下来"根因修复的核心机制）──
console.log('--- withTimeout / raceAbort 单元验证 ---')
const { withTimeout, raceAbort } = await import('./src/core.mjs')

const never = new Promise(() => {})           // 永不 settle：模拟服务端不回 ack
const t0 = Date.now()
try {
  await withTimeout(never, 300, '永不返回的挖方块')
  console.log('  ❌ 竟然没超时')
} catch (e) {
  const ms = Date.now() - t0
  console.log(`  ✅ 永不 settle 的 promise ${ms}ms 后抛错：${e.message.slice(0, 60)}…`)
  console.log(`  ${e.mcTimeout === true ? '✅' : '❌'} 错误带 mcTimeout 标记（供 #t 松控制位用）`)
}

// 正常返回的 promise 必须原样透传，不能被误杀
const ok = await withTimeout(Promise.resolve({ placed: 'oak_planks' }), 300, '正常放置')
console.log(`  ${ok?.placed === 'oak_planks' ? '✅' : '❌'} 正常 promise 原样透传（不误杀）`)

// 业务错误不能被包装成超时
try {
  await withTimeout(Promise.reject(new Error('背包里没有 oak_planks')), 300, '缺物')
} catch (e) {
  console.log(`  ${e.mcTimeout ? '❌ 业务错误被误标为超时' : '✅ 业务错误原样透传'}：${e.message}`)
}

// raceAbort：用户按"停止"（signal abort）必须**立刻**结算，而不是等本地超时
{
  const ac = new AbortController()
  const t = Date.now()
  setTimeout(() => ac.abort({ kind: 'user' }), 120)
  try {
    await raceAbort(never, ac.signal, '走路')       // 本地超时远大于 120ms
    console.log('  ❌ abort 竟然没生效')
  } catch (e) {
    const ms = Date.now() - t
    console.log(`  ${e.mcAborted && ms < 1000 ? '✅' : '❌'} 停止信号 ${ms}ms 内中断（不等本地超时）：${e.message}`)
  }
}
// 已 abort 的 signal，调用时立即抛
{
  const ac = new AbortController(); ac.abort()
  try { await raceAbort(never, ac.signal, '已取消'); console.log('  ❌ 已 abort 未立即抛') }
  catch (e) { console.log(`  ${e.mcAborted ? '✅' : '❌'} 已 abort 的 signal 立即抛错（不产生悬空 await）`) }
}

const fakeCtx = {
  logger: {
    info: (m) => logs.push('[info] ' + m),
    warn: (m) => logs.push('[warn] ' + m),
    debug: (m) => logs.push('[debug] ' + m),
  },
  tools: {
    register: (def) => { tools.set(def.name, def); return () => {} },
    guard: (fn) => { guards.push(fn); return () => {} },
  },
  // 宿主 agentPresets 服务：判断"是不是 MC 模式"要用它；自动建 preset 也走它
  agentPresets: {
    composedPreset: (agentCtx) => presetByCtx.get(agentCtx),
    authorable: true,
    defaultId: 'standard',
    roots: [{ path: shippedRoot, trust: 'shipped' }, { path: presetUserRoot, trust: 'user' }],
    list: async () => [...presetPaths.keys()].map((id) => ({
      id,
      trust: presetPaths.get(id).startsWith(presetUserRoot) ? 'user' : 'shipped',
      path: presetPaths.get(id),
      description: fakeDescriptionOf(id),
    })),
    copy: async (from, id, name) => {
      presetCopyCalls.push([from, id, name])
      // 假宿主真的把目录复制出来（组成也从源拷一份），这样插件随后写 preset.yml/标记 才有地方落
      const { mkdirSync, writeFileSync, readFileSync } = await import('node:fs')
      const dir = jnTop(presetUserRoot, id)
      mkdirSync(dir, { recursive: true })
      const srcComp = presetPaths.get(from)
      const body = srcComp && exTop(srcComp) ? readFileSync(srcComp, 'utf8') : `# ${id} composition\n`
      const comp = jnTop(dir, 'agent.cordis.yml')
      writeFileSync(comp, body, 'utf8')
      presetPaths.set(id, comp)
      // 官方 copy() 的行为：只改 name、**保留源简介**（这正是那个 bug 的来源）
      writeFileSync(jnTop(dir, 'preset.yml'), `name: ${name ?? id}\ndescription: ${JSON.stringify(SHIPPED_DESC[from] ?? '')}\n`, 'utf8')
    },
  },
  webServer: { register: (route) => { registeredRoutes.push(route); return () => {} } },
  // 必须在 apply 之前就在，否则归档保护的包装装不上
  workspaceRegistry: { archiveSession: async (sid) => { archivedSessions.push(String(sid)) } },
  // 系统提示：收集插件注册的动态 context（本插件已不注册任何 systemPrompt 段）
  systemPrompt: {
    context: (c) => { injectedContexts.push(c); return () => {} },
    section: () => () => {},
    getContextOrder: () => 100,
    getSectionOrder: () => 100,
  },
  // 服务迟到时走这条路
  inject: (deps, cb) => { injectedFibers.push({ deps, cb }) },
  effect: (fn) => { try { fn() } catch (e) { logs.push('[effect error] ' + e.message) } },
  set: (k, v) => { fakeCtx[k] = v },
  // 没有 jobs 服务：验证看门狗在缺服务时报错清晰（不崩）
  get: (k) => (k === 'jobs' || k === 'sessionController' ? undefined : fakeCtx[k]),
  on: (ev, fn) => { eventHandlers.push({ ev, fn }); return () => {} },
}

const mod = await import('./index.js')
const toolDef = await import('./src/tool-def.mjs')
console.log('插件导出:', Object.keys(mod).join(', '))
console.log(`工具定义来源: toolDefKind()=${toolDef.toolDefKind()}${toolDef.loadNote ? '（' + toolDef.loadNote + '）' : ''}`)

const config = mod.Config ? mod.Config({}) : {}
console.log('Config 解析结果:', JSON.stringify(config, null, 1))

try {
  mod.apply(fakeCtx, config)
} catch (e) {
  console.error('❌ apply 抛错:', e.message)
  console.error(e.stack?.split('\n').slice(0, 5).join('\n'))
  process.exit(1)
}

console.log(`\n✅ 注册工具 ${tools.size} 个：`)
for (const [n, d] of tools) {
  const params = Object.keys(d.parameters ?? {})
  console.log(`  ${n}${params.length ? ' (' + params.join(', ') + ')' : ''} —— ${String(d.description ?? '').slice(0, 50)}`)
}

// 「无宿主模拟」子进程用：`WHALE_CRAFT_DUMP_TOOLS=<file>` 时把注册结果落盘（父/子两份逐字比对）。
// 只含**可序列化**的注册形状：参数 JSON Schema（宿主编译的）+ output schema + timeoutMs。
if (process.env.WHALE_CRAFT_DUMP_TOOLS) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(process.env.WHALE_CRAFT_DUMP_TOOLS, JSON.stringify({
    toolDefKind: toolDef.toolDefKind(),
    configPresent: Boolean(mod.Config),
    tools: [...tools.entries()].map(([name, d]) => ({
      name,
      parameters: d.parameters,
      outputSchema: d.output?.schema,
      timeoutMs: d.timeoutMs ?? null,
    })),
  }, null, 1), 'utf8')
}

// ── 工具面：mc_kit_share 已移除 / present 已接上（用户 2026-09-16）──
console.log('\n--- 工具面（share 移除 / present 接入）---')
{
  const { readFileSync } = await import('node:fs')
  const idx = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  console.log(`  ${!tools.has('mc_kit_share') ? '✅' : '❌'} 🔴 mc_kit_share 已移除（它只是在调宿主**另装**的 dsh-file-host，插件本身没有文件服务器）`)
  console.log(`  ${tools.size === 33 ? '✅' : '❌'} 工具数 33（实际 ${tools.size}）：mc_* 26 + mc_kit_* 4 + mc_admin_* 1 + mc_debug_* 2`)
  // 只看**代码**，不看注释：注释里留着"为什么删"的说明（那是要留的）
  const codeOnly = idx.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  console.log(`  ${!/uploadToFileHost|dsh-file-host|\/serve\/file-host|mc_kit_share/.test(codeOnly) ? '✅' : '❌'} 源码里没有上传/文件服务器残留（注释里保留"为什么删"的说明）`)
  console.log(`  ${tools.has('mc_kit_image') ? '✅' : '❌'} mc_kit_image 仍在（渲染 PNG）`)
  console.log(`  ${tools.has('mc_kit_fs') ? '✅' : '❌'} mc_kit_fs 新增（文件系统：copy/move/delete/make_dir，保留符号链接）`)
  // 2026-10-08：mc_kit_web_fetch（参数与宿主 web_fetch 一致：只有一个必填 url）
  {
    const wf = tools.get('mc_kit_web_fetch')
    const wfParams = wf?.parameters?.properties ?? {}
    const wfNames = Object.keys(wfParams)
    const wfRequired = wf?.parameters?.required ?? []
    console.log(`  ${!!wf ? '✅' : '❌'} mc_kit_web_fetch 已注册（抓网页转文本；宿主 web_fetch 在 MC 模式被我们关掉，这个补位）`)
    console.log(`  ${wfNames.length === 3 && wfNames[0] === 'url' && wfRequired.length === 1 && wfRequired[0] === 'url' && wfParams.url?.type === 'string' && wfParams.reply?.type === 'boolean' && wfParams.dist?.type === 'string' ? '✅' : '❌'} 🔴 参数 = 宿主的 url + 我们自己加的 reply/dist（实际 ${JSON.stringify(wfNames)}，required=${JSON.stringify(wfRequired)}）`)
  console.log(`  ${/MC_WEB_FETCH_TOOL = 'mc_kit_web_fetch'/.test(codeOnly) && /await fetchUrl\(raw, \{ signal: exec\?\.signal \}\)/.test(codeOnly) && !/ctx\.get\('web'\)/.test(codeOnly) ? '✅' : '❌'} 🔴 抓取**全自研**：只走自己的 fetchUrl，不经宿主 ctx.web（用户 2026-10-08 定）`)
  console.log(`  ${/renderFetchText\(\{/.test(codeOnly) && /WEB_FETCH_MAX_OUTPUT_CHARS\)/.test(codeOnly) && /from '\.\/src\/webfetch\.mjs'/.test(codeOnly) ? '✅' : '❌'} 输出交给 src/webfetch.mjs 渲染（形态照抄宿主 web_fetch）`)
    console.log(`  ${/n === MC_WEB_FETCH_TOOL && !pluginConfig\.webFetchEnabled/.test(codeOnly) && /name === MC_WEB_FETCH_TOOL/.test(codeOnly) && /webFetchAllowedFor/.test(codeOnly) ? '✅' : '❌'} 🔴 mc_kit_web_fetch 受 webFetchEnabled + 域名表门控（白名单 + guard 两处）`)
  }
  console.log(`  ${!tools.has('mc_kit_memory') ? '✅' : '❌'} 🔴 mc_kit_memory 已移除（长期记忆改走宿主文件工具；索引自动注入也已移除）`)
  // 2026-10-05：新增观察工具 + 诊断工具改名进 mc_debug_*
  console.log(`  ${tools.has('mc_context') && tools.has('mc_players') ? '✅' : '❌'} 新增观察工具 mc_context / mc_players`)
  console.log(`  ${tools.has('mc_debug_sessions') && tools.has('mc_debug_diag') && !tools.has('mc_sessions') && !tools.has('mc_diag') ? '✅' : '❌'} 🔴 mc_sessions/mc_diag 已改名 mc_debug_sessions / mc_debug_diag`)
  console.log(`  ${/startsWith\('mc_debug_'\)/.test(codeOnly) && /exposeDebugTools/.test(codeOnly) ? '✅' : '❌'} 🔴 调试工具受 exposeDebugTools 门控（白名单 / MC+ deny / guard 三处）`)
  // 2026-10-08：「允许联网搜索」开关（默认开）—— 白名单 + guard 两处按 allowWebSearch 收放 web_search
  console.log(`  ${/MC_WEB_SEARCH_TOOL = 'web_search'/.test(codeOnly) && /allowWebSearch \? \[MC_WEB_SEARCH_TOOL\] : \[\]/.test(codeOnly) && /name === MC_WEB_SEARCH_TOOL && !pluginConfig\.allowWebSearch/.test(codeOnly) ? '✅' : '❌'} 🔴 web_search 受 allowWebSearch 门控（白名单 + guard 两处；MC+ 不套白名单故不受影响）`)
  console.log(`  ${/MC_PRESENT_TOOL = 'present'/.test(idx) && !/^\s+MC_PRESENT_TOOL,$/m.test(idx) ? '✅' : '❌'} 🔴 present **不再**进 MC 模式白名单（交付走 mc_kit_express；判定保留供 guard 兜底）`)
  console.log(`  ${/MC_PRESET_TOOL_GROUPS/.test(idx) && /availableToolGroups\(\)/.test(idx) ? '✅' : '❌'} 复制/重建 preset 时会补齐 MC 模式需要的工具组（tool-fs / tool-fs-search / tool-jobs / tool-goal / tool-todo / compaction）`)
  console.log(`  ${/const ensureToolGroupsInPreset/.test(idx) && /ensureToolGroupsInPreset\(svc, existingId\)/.test(idx) ? '✅' : '❌'} 🔴 **已存在的** preset（含本机手写那份）也会被补齐那几组（不动别的行）`)
  console.log(`  ${/这些工具包在本部署的 preset 里没人引用/.test(idx) ? '✅' : '❌'} 加组之前先探"这个部署里有没有那个包"（免得把 preset 弄挂）`)
  // 🔴 2026-09-24（GitHub issue #1，用户 huohai2）：探针必须是**同步**的 —— 宿主
  //    `agentPreset.list()` 是 `async`，同步 `for...of` 迭代一个 Promise 会抛 TypeError、
  //    被 `catch` 吞掉 ⇒ 每一组都被判成"本部署没人引用"，自动建的 MC 模式**一组工具都补不上**。
  console.log(`  ${/readdirSync\(dir, \{ withFileTypes: true \}\)/.test(idx) && /join\(dir, ent\.name, 'agent\.cordis\.yml'\)/.test(idx) ? '✅' : '❌'} 🔴 探针扫 preset 根目录（同步 readdirSync），不再迭代 async 的 list()（issue #1 根因）`)
  console.log(`  ${!/of\s+agentPresetsSvc\?\.list\?\.\(\)/.test(idx) ? '✅' : '❌'} 🔴 没有把 async list() 丢进 for...of（旧写法必挂，且被 catch 吞成"没人引用"）`)
  console.log(`  ${/探"本部署有哪些 preset 工具包"失败/.test(idx) && /一个随附 preset 的组成都没扫到/.test(idx) ? '✅' : '❌'} 探针失败 / 一个 preset 都没扫到时**记一行日志**（判据失效不许伪装成"确实没有"）`)
  // 发布区（用户 2026-09-17 定稿：`/api/whale-craft/express/<工作区 uuid>/…`，自己一条前缀路由）
  console.log(`  ${/const outDir = outRootOf\(memoryRootFor/.test(idx) ? '✅' : '❌'} mc_kit_image 默认输出 .whale-craft/.out/（**不对外**）`)
  // 2026-10-05：mc_map/mc_height 改用 reply/dist（不再默认落 .out/；相对路径以工作区根为基准）
  console.log(`  ${/const outputPathFor = \(raw, agent\)/.test(idx) && /const modelAcceptsVision = async/.test(idx) ? '✅' : '❌'} mc_map/mc_height 输出布局（dist/reply + 视觉检查）就位`)
  console.log(`  ${/const serveSharedFile = \(req, res, hit\)/.test(idx) && /path: '\/api\/whale-craft'/.test(idx) && /isTrustedRequest\(req\.headers/.test(idx) ? '✅' : '❌'} 🔴 发布区有自己的前缀路由 /api/whale-craft（自己过信任栅栏）`)
  console.log(`  ${/const workspaceIdOfCwd = \(cwd\)/.test(idx) && /workspaceCwdById/.test(idx) ? '✅' : '❌'} 🔴 地址用**工作区 uuid**（查宿主 workspaceRegistry，不再用目录名）`)
  console.log(`  ${!/serveExpressFile/.test(idx) && !/knownWorkspaces/.test(idx) ? '✅' : '❌'} 🔴 旧的"目录名 + 进程内见过的工作区集合"那套已删干净`)
  console.log(`  ${/realpathSync\(target\)/.test(idx) && /拒绝越界（符号链接）/.test(idx) ? '✅' : '❌'} 🔴 防穿透：段级校验 + realpath 复查（符号链接也跳不出去）`)
  // 「随版本更新」（用户 2026-09-17）：在"备好记忆目录"那两个时机执行，版本变了才替换
  console.log(`  ${/syncRulesVersion\(root, PLUGIN_VERSION, \{ follow: workspaceConfigValues\(root\)\.rulesFollowVersion !== false \}\)/.test(idx) ? '✅' : '❌'} 🔴 「随版本更新」挂在"备好记忆目录"时机上（follow 来自**本工作区** config.json，默认开）`)
  console.log(`  ${/migrateWorkspaceConfig\(root, \{ seed: pluginConfig\.legacyPromptSwitches\(\) \}\)/.test(idx) ? '✅' : '❌'} 🔴 建档/迁移（旧 .rules-version 并入 config.json）**先于**版本同步（否则旧值这轮看不到）`)
  console.log(`  ${/行事准则已替换为新版本默认内容/.test(idx) ? '✅' : '❌'} 真替换时会写一行日志（便于排查"我的准则怎么变了"）`)
  console.log(`  ${!/read_image \{file_path/.test(codeOnly) && !/present \{files/.test(codeOnly) ? '✅' : '❌'} 🔴 旧的"用 read_image / present 发图"提示已清干净（注释里的历史说明不算）`)
  const vp = readFileSync(new URL('./src/version-prompt.mjs', import.meta.url), 'utf8')
  console.log(`  ${/mc_move/.test(vp) && /本版本对于生存、冒险能力的支持极弱/.test(vp) ? '✅' : '❌'} 版本提示写本版本的时效性事实（工具成熟度 + 能力短板；不再写交付流程——那归 mc_kit_express 工具说明）`)
  const cli = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
  console.log(`  ${/data-wc-verprompt/.test(cli) && /本版本内置提示/.test(cli) ? '✅' : '❌'} 「提示词」页只读展示版本内置提示（用户有权知道它说了什么）`)
}

/** 造一个假的 exec（带会话身份），工具靠它路由到各自的实例 */
const execAs = (id) => ({ agent: { id } })

// ── 实例分离验证：靠 mc_debug_diag 的 connection/stats 看不出来，改用 mc_debug_sessions 列实例 ──
console.log('\n--- 每会话实例分离 ---')
const A = execAs('sess-A')
const B = execAs('sess-B')

await tools.get('mc_status').execute({}, A)
await tools.get('mc_status').execute({}, A)   // 同一会话再来一次，应复用
await tools.get('mc_status').execute({}, B)

const sess = await tools.get('mc_debug_sessions').execute({}, A)
console.log('  活跃实例:', JSON.stringify(sess.sessions.map((s) => s.agentId)))
const ids = sess.sessions.map((s) => s.agentId).sort().join(',')
if (ids === 'sess-A,sess-B') console.log('  ✅ 两个会话各自一个独立实例（互不干扰）')
else console.log('  ❌ 实例隔离异常，期望 sess-A,sess-B，实际', ids)

// 没有 exec 时必须清晰报错（而不是静默用错实例）
try {
  await tools.get('mc_status').execute({})
  console.log('  ❌ 无 exec 竟然成功了（应报错）')
} catch (e) { console.log('  ✅ 无 exec 时清晰报错：', e.message) }

// ── 未连接时的行为 ──
console.log('\n--- 未连接时的行为 ---')
for (const n of ['mc_status', 'mc_map', 'mc_say', 'mc_connect']) {
  try {
    const r = await tools.get(n).execute(n === 'mc_say' ? { message: 'hi' } : {}, A)
    console.log(`  ${n} → ${JSON.stringify(r).slice(0, 140)}`)
  } catch (e) {
    console.log(`  ${n} → 抛错：${e.message}`)
  }
}

// ── 看门狗（v2）：挂载 / 配置 / 叫法 / 卸载 ──
console.log('\n--- 看门狗 v2 ---')
{
  // 没挂时：status 应是 armed:false，且能看清默认配置
  const s0 = await tools.get('mc_watch').execute({}, A)
  console.log(`  ${s0.armed === false ? '✅' : '❌'} 初始未挂载；配置项 ${Object.keys(s0.config ?? {}).length} 个`)

  // 唤醒矩阵默认值抽查（用户逐条问过的那些）
  const w = s0.config.wakeOn
  const want = {
    damage: true, death: true, teleport: true,   // 默认叫醒
    pushed: false, itemPickup: false,            // 默认只记档
  }
  const bad = Object.entries(want).filter(([k, v]) => w[k] !== v)
  console.log(bad.length
    ? `  ❌ 唤醒矩阵默认值不符：${bad.map(([k]) => k).join(', ')}`
    : `  ✅ 唤醒矩阵默认值正确（受击/死亡/被传送叫醒；被推/捡物只记档）`)
  console.log(`  ✅ 近距说话半径默认 ${s0.config.nearRadius} 格；观察窗口 ${s0.config.observeWindowMs}ms；限流 ${s0.config.maxWakePerMinute}/分`)

  // 挂载（宿主无 jobs → 降级为"无 job 模式"，但必须仍然武装成功）
  const s1 = await tools.get('mc_watch').execute({ action: 'arm' }, A)
  console.log(`  ${s1.armed === true ? '✅' : '❌'} arm 成功（无 jobs 服务时降级运行，不抛错）`)

  // 改配置：点号键 + 数组
  const c1 = await tools.get('mc_config').execute({
    patch: { 'wakeOn.itemPickup': true, nearRadius: 24, mentionPatterns: ['ds', '用户'] },
  }, A)
  const ok = c1.config.wakeOn.itemPickup === true && c1.config.nearRadius === 24
    && c1.config.mentionPatterns.length === 2 && c1.config.wakeOn.damage === true
  console.log(`  ${ok ? '✅' : '❌'} mc_config 点号键浅合并正确（未提及的项保持默认）`)

  // 叫法判定（**配置不是硬编码**）——直接构造 Watchdog 测，不依赖 registry
  const { Watchdog } = await import('./src/watchdog.mjs')
  const probe = new Watchdog({ ctx: fakeCtx, sess: { bot: {}, events: [], config: {} }, agent: A.agent })
  probe.updateConfig({ mentionPatterns: ['ds', '用户'] })
  const called = probe.calledBy('用户 你在吗')
  const notCalled = probe.calledBy('今天天气不错')
  console.log(`  ${called.includes('用户') && notCalled.length === 0 ? '✅' : '❌'} 动态叫法生效：命中 ${JSON.stringify(called)}，未命中 ${JSON.stringify(notCalled)}`)
  console.log(`  ${probe.config.wakeOn.damage && !probe.config.wakeOn.itemPickup ? '✅' : '❌'} 改叫法不影响唤醒矩阵默认值`)

  // ── 断线状态同步（2026-09-19 用户："连接断开了状态没有同步，AI 也以为连接还在"）──
  // 以前 core **根本不发**"断线"事件：看门狗还挂着、状态条照旧写"在游戏中"（配合旧的
  // online 只看 bot.entity）、AI 要等下次调工具才撞上"不在线"。这里把三处一起钉住。
  {
    const { Watchdog, WATCH_DEFAULTS } = await import('./src/watchdog.mjs')
    const { McBot } = await import('./src/core.mjs')
    const { EventEmitter } = await import('node:events')
    const { readFileSync } = await import('node:fs')

    console.log(`  ${WATCH_DEFAULTS.wakeOn.disconnect === true ? '✅' : '❌'} 🔴 唤醒矩阵新增 disconnect（断线默认叫醒 AI）`)

    // 会重连 → 排一次唤醒；不会重连 → 直接关掉看门狗（它的关闭通知就会告诉 AI 去 mc_connect）
    const wdA = new Watchdog({ ctx: fakeCtx, sess: { bot: new EventEmitter(), events: [], config: {} }, agent: A.agent, onFire: () => {} })
    wdA.arm()
    wdA.sess.bot.emit('offline', { reason: '被踢: 测试', willReconnect: true, sub: '' })
    const queued = wdA.pending?.[0]
    console.log(`  ${queued?.reasons?.includes('disconnect') && /正在自动重连/.test(String(queued?.text)) ? '✅' : '❌'} 🔴 断线（会重连）→ 排队唤醒 AI：「${String(queued?.text ?? '').slice(0, 34)}…」`)
    console.log(`  ${wdA.armed === true ? '✅' : '❌'} 会重连时看门狗继续挂着（重连成功后照常监听）`)
    console.log(`  ${wdA.log.some((e) => e.kind === 'offline') ? '✅' : '❌'} 断线进了看门狗事件留档（mc_watch log 看得到）`)

    const wdB = new Watchdog({ ctx: fakeCtx, sess: { bot: new EventEmitter(), events: [], config: {} }, agent: A.agent, onFire: () => {} })
    wdB.arm()
    wdB.sess.bot.emit('offline', { reason: '连接结束', willReconnect: false, sub: '' })
    console.log(`  ${wdB.armed === false ? '✅' : '❌'} 🔴 不会重连时看门狗自动关闭（关闭通知会告诉 AI"你已不在 MC 里、要 mc_connect"）`)
    try { wdA.disarm('自检结束', { notify: false }) } catch {}
    try { wdB.disarm('自检结束', { notify: false }) } catch {}

    // 真 socket 断开 → core 必须发出 offline（不是只在日志里写一行）
    {
      const { createServer } = await import('node:net')
      const { mkdtempSync } = await import('node:fs')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const tmpDir = mkdtempSync(join(tmpdir(), 'whale-offline-'))
      const srv = createServer((sock) => { sock.destroy() })      // 接受即掐断
      await new Promise((r) => srv.listen(0, '127.0.0.1', r))
      const port = srv.address().port
      const bot = new McBot({ instanceId: 'selftest-offline', connectTimeoutMs: 1500, lockDir: tmpDir, logFile: join(tmpDir, 'x.log') })
      const seen = []
      bot.on('offline', (e) => seen.push(e))
      let threw = null
      try { await bot.connect({ host: '127.0.0.1', port, version: '1.21.1', auth: { mode: 'offline', name: 'DeepSeek' } }) } catch (e) { threw = e.message }
      srv.close()
      console.log(`  ${seen.length >= 1 && seen[0].willReconnect === false ? '✅' : '❌'} 🔴 真 socket 断开 → core 发出 offline 事件（${seen.length} 次）`)
      console.log(`  ${String(threw ?? '').length > 0 ? '✅' : '❌'} 连不上时 connect() 以普通错误结束（不静默、不挂住）：${String(threw ?? '').slice(0, 26)}…`)
    }

    // 三处链路都得在（删掉任何一处就等于又把状态丢了）
    const idxSrc = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
    console.log(`  ${/bot\.on\('offline'/.test(idxSrc) && /连接断开：/.test(idxSrc) ? '✅' : '❌'} 会话把 offline 转进事件队列（mc_events 能看到）`)
    console.log(`  ${/reconnecting: Boolean\(this\.bot\.reconnecting \|\| this\.bot\.reconnectPending\)/.test(idxSrc) && /Boolean\(sess\.bot\.reconnecting \|\| sess\.bot\.reconnectPending\)/.test(idxSrc) ? '✅' : '❌'} 🔴 modeView 与 /api/mc/status 都带上"正在重连"（含"正在尝试连接"那段，否则状态条会中途退回"未上线"）`)
    const cliSrc = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
    console.log(`  ${/重连中/.test(cliSrc) && /data-mc-reconnecting/.test(cliSrc) ? '✅' : '❌'} 🔴 状态条会显示"重连中…"（不再假装在游戏中）`)
    // 「断线期」标记的生命周期：掉线时置位、**真重连成功**才清（只看 reconnecting 会在尝试连接的 45s 里退回"未上线"）
    const coreSrc3 = readFileSync(new URL('./src/core.mjs', import.meta.url), 'utf8')
    console.log(`  ${/if \(willReconnect\) this\.reconnectPending = true/.test(coreSrc3) && /this\.reconnectPending = false/.test(coreSrc3) ? '✅' : '❌'} 🔴 断线期标记：掉线置位 →（重连成功 / 手动进服）才清`)
  }

  // ── 等待会不会"堵住唤醒"（2026-09-19 用户实测：等到消息、提及了也没唤醒，空等特别久）──
  // 机制：宿主把 steer 放在**下一个 step 边界**投递，而 step 边界要等当前工具返回 ⇒
  //      `mc_events {waitSec:120}` 会把唤醒文案压在等待后面。修法：唤醒前先打断等待。
  {
    const { waitForEvents } = await import('./src/wait.mjs')
    const { Watchdog } = await import('./src/watchdog.mjs')
    const { EventEmitter } = await import('node:events')
    const { readFileSync } = await import('node:fs')

    // ① 等到事件 → 立刻回
    {
      const sess = { events: [] }
      const p = waitForEvents({ sess, from: 0, kind: 'chat', waitSec: 5, pollMs: 25 })
      setTimeout(() => sess.events.push({ kind: 'chat', text: 'hi' }), 120)
      const t0 = Date.now(); const r = await p; const dt = Date.now() - t0
      console.log(`  ${r.interrupted === false && r.reason === '有事件' && dt < 1000 ? '✅' : '❌'} 等到事件立刻回（${dt}ms，不等满 5s）`)
    }
    // ② 被唤醒打断 → 立刻回（这条就是修的东西）
    {
      const sess = { events: [], waitInterruptedAt: 0, waitInterruptReason: null }
      const p = waitForEvents({ sess, from: 0, waitSec: 30, pollMs: 25 })
      setTimeout(() => { sess.waitInterruptedAt = Date.now(); sess.waitInterruptReason = 'mention' }, 120)
      const t0 = Date.now(); const r = await p; const dt = Date.now() - t0
      console.log(`  ${r.interrupted === true && r.reason === 'mention' && dt < 1000 ? '✅' : '❌'} 🔴 被唤醒打断 → 立刻回（${dt}ms，而不是干等 30 秒）：reason=${r.reason}`)
    }
    // ③ 用户按停止 → 立刻回
    {
      const sess = { events: [] }
      const ac = new AbortController()
      const p = waitForEvents({ sess, from: 0, waitSec: 30, pollMs: 25, signal: ac.signal })
      setTimeout(() => ac.abort(), 100)
      const t0 = Date.now(); const r = await p; const dt = Date.now() - t0
      console.log(`  ${r.interrupted === false && r.reason === '用户停止' && dt < 1000 ? '✅' : '❌'} 用户停止 → 立刻回（${dt}ms，不空等）`)
    }
    // ④ 没人找它 → 到点才回
    {
      const sess = { events: [] }
      const t0 = Date.now()
      const r = await waitForEvents({ sess, from: 0, waitSec: 0.5, pollMs: 50 })
      const dt = Date.now() - t0
      console.log(`  ${!r.interrupted && dt >= 400 && dt < 1300 ? '✅' : '❌'} 没人找它就等到点（${dt}ms ≈ 500ms）`)
    }
    // ⑤ 看门狗注入前**真的**会打断（stub 会话记录调用）
    {
      let interruptedWith = null
      const stub = { bot: new EventEmitter(), events: [], config: {}, interruptWait: (r) => { interruptedWith = r } }
      const wd = new Watchdog({
        ctx: fakeCtx, sess: stub,
        agent: { id: 'w', status: 'running', steer: () => {} },
        onFire: () => {},
      })
      wd.arm()
      wd.updateConfig({ observeWindowMs: 100 })
      stub.bot.emit('chat', { who: 'someone', text: 'deepseek 在吗' })     // 命中叫法
      await new Promise((r) => setTimeout(r, 1400))                        // 观察窗口 + tick(1s)
      console.log(`  ${interruptedWith ? '✅' : '❌'} 🔴 看门狗注入前会打断等待（interruptWait("${interruptedWith ?? ''}")）`)
      try { wd.disarm('自检结束', { notify: false }) } catch {}
    }
    // ⑥ 接线不能丢（在 mc_events 的工具侧 + 看门狗的注入口）
    const idxSrc2 = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
    const wdSrc2 = readFileSync(new URL('./src/watchdog.mjs', import.meta.url), 'utf8')
    console.log(`  ${/await waitForEvents\(/.test(idxSrc2) && /interrupted: true/.test(idxSrc2) ? '✅' : '❌'} mc_events 用抽出来的等待逻辑，并把"被打断"告诉 AI`)
    console.log(`  ${/this\.sess\?\.interruptWait\?\./.test(wdSrc2) ? '✅' : '❌'} 🔴 看门狗在**所有**注入前都打断等待（一个口子覆盖唤醒/关闭通知/补提醒/心跳）`)
    console.log(`  ${/被传送 \/ 捡物 \/ 其他玩家上下线不在这里/.test(idxSrc2) ? '✅' : '❌'} 工具描述不再谎称"含被传送/捡物/上下线"（那些只在 mc_watch log 里）`)
  }

  // 非法配置项要清晰报错
  try {
    await tools.get('mc_config').execute({ patch: { 不存在的项: 1 } }, A)
    console.log('  ❌ 非法配置项竟然被接受')
  } catch (e) { console.log(`  ✅ 非法配置项清晰报错：${e.message.slice(0, 50)}…`) }

  // 恢复默认
  const c2 = await tools.get('mc_config').execute({ reset: true }, A)
  console.log(`  ${c2.config.nearRadius === 16 && c2.config.mentionPatterns.length > 2 ? '✅' : '❌'} reset 恢复默认`)

  // 卸载
  const s2 = await tools.get('mc_watch').execute({ action: 'disarm', reason: '自检' }, A)
  console.log(`  ${s2.armed === false ? '✅' : '❌'} disarm 成功`)
}

// ── 新工具：mc_act / mc_give / mc_sequence / mc_stop ──
console.log('\n--- 工具重整后的新能力 ---')

// mc_act：未知 mode 要清晰报错（不静默）
try {
  await tools.get('mc_act').execute({ mode: '飞' }, A)
  console.log('  ❌ 未知 mode 竟然被接受')
} catch (e) {
  const msg = e.message
  console.log(`  ${/未知 mode/.test(msg) ? '✅' : '❌'} mc_act 未知 mode 报错并列出可用值：${msg.slice(0, 70)}…`)
}

// mc_act：look 缺参数时提示怎么用
try {
  await tools.get('mc_act').execute({ mode: 'look' }, A)
  console.log('  ❌ look 缺参数竟然成功')
} catch (e) {
  console.log(`  ✅ mc_act{look} 缺参报错：${e.message.slice(0, 46)}…`)
}

// mc_give：非创造/不在线要有明确说明（不是崩溃）
try {
  await tools.get('mc_give').execute({ name: 'oak_planks' }, A)
  console.log('  ❌ mc_give 竟然成功')
} catch (e) {
  console.log(`  ✅ mc_give 未连服报错：${e.message.slice(0, 40)}…`)
}

// mc_sequence：参数校验
for (const [label, args, want] of [
  ['空 steps', { steps: [] }, /非空数组/],
  ['超长 steps', { steps: Array.from({ length: 65 }, () => ({ op: 'wait', sec: 0 })) }, /步骤太多/],
]) {
  try {
    await tools.get('mc_sequence').execute(args, A)
    console.log(`  ❌ ${label} 竟然通过`)
  } catch (e) {
    console.log(`  ${want.test(e.message) ? '✅' : '❌'} mc_sequence ${label} 校验：${e.message.slice(0, 40)}`)
  }
}

// mc_sequence：纯等待步骤不需要连服也能跑通引擎
{
  const r = await tools.get('mc_sequence').execute({ steps: [{ op: 'wait', sec: 0.05 }, { op: 'wait', ms: 50 }] }, A)
  const ok = r.succeeded === 2 && r.failed === 0
  console.log(`  ${ok ? '✅' : '❌'} 序列引擎可独立运行：${r.succeeded}/${r.requested} 步成功，耗时 ${r.elapsedMs}ms`)
}

// mc_sequence：未知 op 要报错并列出可用 op（且按 stopOnError 停下）
{
  const r = await tools.get('mc_sequence').execute({ steps: [{ op: '不存在的动作' }, { op: 'wait', sec: 0.01 }] }, A)
  const first = r.results[0]
  const stopped = r.results.length === 1
  console.log(`  ${first?.ok === false && /可用：/.test(first.error) && stopped ? '✅' : '❌'} 未知 op 报错+列可用值+遇错即停：${String(first?.error).slice(0, 60)}…`)
}

// ── 强制停止：语义与**顺序**（用户 2026-09-16：移除普通停止，只剩强制停止）──
console.log('\n--- 强制停止（顺序：停LLM → 优雅退游戏 → 清后台任务 → 再停LLM）---')
try {
  await tools.get('mc_stop').execute({})
  console.log('  ❌ mc_stop 无 exec 竟然成功')
} catch (e) {
  console.log(`  ${/拿不到当前会话/.test(e.message) ? '✅' : '❌'} mc_stop 无 exec 清晰报错：${e.message.slice(0, 30)}`)
}
{
  // 普通停止已移除：参数面只剩 reason（不再有 hard）
  // ⚠️ 注册表里的 `parameters` 是包好的 JSON schema，参数名在 .properties 下
  const params = Object.keys(tools.get('mc_stop').parameters?.properties ?? {})
  console.log(`  ${!params.includes('hard') && params.includes('reason') ? '✅' : '❌'} mc_stop 参数面已无 hard（普通停止移除）：[${params.join(', ')}]`)
  const r = await tools.get('mc_stop').execute({ reason: '自检' }, A)
  const ok = r && 'kicked' in r && 'killedJobs' in r && 'stoppedLLM' in r && 'finalStopLLM' in r && Array.isArray(r.order)
  console.log(`  ${ok ? '✅' : '❌'} mc_stop 返回结构完整（kicked/killedJobs/stoppedLLM/finalStopLLM/order）：${JSON.stringify(r).slice(0, 110)}`)
  console.log(`  ${r?.order?.join(' → ') === 'quit-game → kill-jobs' ? '✅' : '❌'} AI 自己调（cancelTurn:false）不动 LLM、顺序 = 退游戏 → 清任务：${r?.order?.join(' → ')}`)
}

// 🔴 强制停止的**后端顺序**：用第二套"服务齐全的假 ctx"跑一遍 apply()，
//    再走 UI 那条路（POST /api/mc/stop）——工具路径强制 cancelTurn:false，验不到"先停 LLM"。
console.log('\n--- 强制停止：UI 路径的真实顺序（停LLM → 退游戏 → 清任务 → 再停LLM）---')
{
  const { EventEmitter } = await import('node:events')
  const side = []                       // 副作用调用顺序（cancel / kill）
  const tools2 = new Map()
  let route2 = null
  const fakeAgent2 = { id: 'sess-STOP', status: 'running' }
  // 这第二套 ctx 的 agents 服务要**可替换**：下面的「MC设置」接口测试需要换成"带工作区的会话"
  let agents2 = { get: () => fakeAgent2 }
  // 🔴 2026-09-24：快照里要**带 owner 身份**（宿主 `JobSnapshot.ownerSession`）—— 宿主
  //    `list(caller)` 的口径是 `owner === undefined || owner.id === session`，也就是说它
  //    **还会把"无主 job"（宿主自己起的后台任务）列出来**，而 `assertAccess()` 对无主 job 不设防。
  //    旧代码"列出来就全杀"⇒ 点一次「强制停止」会顺手清掉跟本会话无关的宿主任务。
  const jobsCallers = []                 // 钉宿主契约：caller 必须是会话 id 字符串
  const jobs2 = {
    list: (caller) => { jobsCallers.push(caller); return [
      { id: 'job-watch', ownerSession: 'sess-STOP' },        // 本会话：该杀
      { id: 'job-other', ownerSession: 'sess-STOP' },        // 本会话：该杀
      { id: 'job-host', ownerSession: undefined },           // 宿主自己的无主 job：**不许动**
      { id: 'job-other-sess', ownerSession: 'sess-OTHER' },  // 别的会话的 job：**不许动**
    ] },
    kill: (id, caller) => { jobsCallers.push(caller); side.push(`kill:${id}`) },
  }
  const sc2 = { cancel: ({ sessionId }) => side.push(`cancel:${sessionId}`) }
  const ctx2 = {
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    tools: { register: (d) => { tools2.set(d.name, d); return () => {} }, guard: () => () => {} },
    // ⚠️ 现在插件会注册**两条**路由（/api/mc 与 /api/whale-craft），这里只要 /api/mc 那条
    webServer: { register: (r) => { if (r.path === '/api/mc') route2 = r; return () => {} }, port: 39999 },
    workspaceRegistry: { archiveSession: async () => {} },
    systemPrompt: { context: () => () => {}, section: () => () => {} },
    inject: () => {},
    effect: (fn) => { try { fn() } catch {} },
    on: () => () => {},
    get: (k) => (k === 'jobs' ? jobs2
      : k === 'sessionController' ? sc2
        : k === 'agents' ? agents2
          : undefined),
  }
  mod.apply(ctx2, mod.Config ? mod.Config({}) : {})

  // 先在这个会话上建出 McSession（UI 场景里它一定存在：那个会话正在玩）
  await tools2.get('mc_status').execute({}, { agent: { id: 'sess-STOP' } })

  const req = new EventEmitter()
  req.method = 'POST'
  req.url = '/api/mc/stop'
  req.headers = { host: '127.0.0.1:39999' }
  const res = { writeHead: () => {}, end: (body) => { res.body = String(body ?? '') } }
  const done = route2.handler(req, res)
  req.emit('data', JSON.stringify({ sessionId: 'sess-STOP' }))
  req.emit('end')
  await done
  const body = JSON.parse(res.body || '{}')

  console.log(`  ${route2?.path === '/api/mc' ? '✅' : '❌'} 路由注册为 ${route2?.path}（prefix）`)
  console.log(`  ${body.ok ? '✅' : '❌'} UI 路径返回 ok：${JSON.stringify(body).slice(0, 100)}`)
  const want = 'stop-llm → quit-game → kill-jobs → stop-llm-final'
  console.log(`  ${body.order?.join(' → ') === want ? '✅' : '❌'} 后端顺序 = ${want}${body.order?.join(' → ') === want ? '' : `｜实际：${body.order?.join(' → ')}`}`)
  console.log(`  ${body.stoppedLLM === true && body.finalStopLLM === true ? '✅' : '❌'} 停了两遍 LLM（首 + 尾，避免状态异常）：首=${body.stoppedLLM} 尾=${body.finalStopLLM}`)
  console.log(`  ${body.kicked === true ? '✅' : '❌'} 先尝试退出游戏（bot.disconnect 被调用）：${JSON.stringify(body.quit)}`)
  console.log(`  ${body.killedJobs?.length === 2 ? '✅' : '❌'} 该会话后台任务被清空：${JSON.stringify(body.killedJobs)}`)
  // 🔴 2026-09-24（PR #2 报的隐患）：**只准杀自己的** —— 无主 job 与别的会话的 job 一个都不许碰
  console.log(`  ${body.killedJobs?.includes('job-watch') && body.killedJobs?.includes('job-other') ? '✅' : '❌'} 自己的两个 job 都被清掉`)
  console.log(`  ${!body.killedJobs?.includes('job-host') && !body.killedJobs?.includes('job-other-sess') ? '✅' : '❌'} 🔴 宿主无主 job / 别的会话的 job **一个都没动**（旧代码会把它们一起杀掉）`)
  const sideWant = ['cancel:sess-STOP', 'kill:job-watch', 'kill:job-other', 'cancel:sess-STOP']
  console.log(`  ${side.join(' → ') === sideWant.join(' → ') ? '✅' : '❌'} 副作用真实顺序 = 先停LLM → 清任务 → 再停LLM：${side.join(' → ')}`)
  // 🔴 2026-10-04（PR #2 @swan3146）：caller 必须是**会话 id 字符串**——宿主 `list/kill/assertAccess`
  //    都按 `job.owner.id === caller` 比对；传 agent 对象 ⇒ "自己的 job 一个都列不出来、也杀不掉"。
  console.log(`  ${jobsCallers.length === 3 && jobsCallers.every((c) => c === 'sess-STOP') ? '✅' : '❌'} 🔴 list/kill 的 caller 都是**会话 id 字符串**（收到：${JSON.stringify(jobsCallers)}）`)

  // ── 「创建MC+分支」（2026-10-05）：fork 源会话 + 把**新会话**改成 minecraft-plus ──
  // 🔴 改模式必须绕开 `agentPresets.select` 的"已开聊就锁"（分支带继承历史必中锁）——
  //    走 select 内部同样的两步：recompose（重绑）+ 追加 agent-preset/selected 事件。
  // 🔴 改完要**复验**（composedPreset 必须真是 MC+）；不成则**回撤归档**刚建的分支 + ok:false。
  {
    const forkCalls = []
    const recomposeCalls = []
    const appendCalls = []
    const renameCalls = []
    const archived = []
    const dispose = []   // observeSession 是**可释放资源**，读到的要 dispose（验一句句柄不漏）
    let forkChildId = 'sess-CHILD1'
    let presetsMode = 'ok'
    sc2.fork = (req) => { forkCalls.push(req); return Promise.resolve({ sessionId: forkChildId }) }
    sc2.rename = (req) => { renameCalls.push(req); return Promise.resolve({ title: req.title, seq: 0 }) }
    const fakePresets = {
      recompose: (c, id) => {
        recomposeCalls.push([c, id])
        if (presetsMode === 'throw') return Promise.reject(new Error('agent-preset/not-found: Unknown agent preset: minecraft-plus'))
        return Promise.resolve({ id })
      },
      composedPreset: () => (presetsMode === 'wrong' ? 'standard' : 'minecraft-plus'),
    }
    const makeChild = (id) => ({
      id,
      session: { append: (type, data) => appendCalls.push([type, data]) },
      ctx: { get: (k) => (k === 'agentPresets' ? fakePresets : undefined) },
    })
    const fakeSessionQuery = { observeSession: () => Promise.resolve({ events: [{ seq: 5, type: 'assistant/message', data: { message: { id: 'msg-1' } } }], header: { title: '测试会话' }, [Symbol.dispose]() { dispose.push(true) } }) }
    const fakeWsReg = { archiveSession: (id) => { archived.push(String(id)); return Promise.resolve({ archivedSessionIds: [String(id)] }) } }
    const origGet = ctx2.get
    ctx2.get = (k) => (k === 'sessionQuery' ? fakeSessionQuery : k === 'workspaceRegistry' ? fakeWsReg : origGet(k))
    const post = async (body) => {
      const rq = new EventEmitter()
      rq.method = 'POST'; rq.url = '/api/mc/branch-plus'; rq.headers = { host: '127.0.0.1:39999' }
      const rs = { writeHead: () => {}, end: (b) => { rs.body = String(b ?? '') } }
      const p = route2.handler(rq, rs)
      rq.emit('data', JSON.stringify(body))
      rq.emit('end')
      await p
      try { return JSON.parse(rs.body || '{}') } catch { return {} }
    }
    try {
      // ① 成功路径
      agents2 = { get: (id) => (id === 'sess-CHILD1' ? makeChild(id) : undefined) }
      const okOut = await post({ sessionId: 'sess-API', messageId: 'msg-1' })
      console.log(`  ${okOut.ok === true && okOut.sessionId === 'sess-CHILD1' && okOut.presetApplied === true ? '✅' : '❌'} 「创建MC+分支」成功返回新会话且模式已改（${JSON.stringify(okOut).slice(0, 110)}）`)
      console.log(`  ${forkCalls.length === 1 && forkCalls[0].sessionId === 'sess-API' && forkCalls[0].atSeq === 5 ? '✅' : '❌'} 真的 fork 了源会话，且 atSeq 由 messageId 反查（${JSON.stringify(forkCalls)}）`)
      console.log(`  ${recomposeCalls.length === 1 && recomposeCalls[0][1] === 'minecraft-plus' ? '✅' : '❌'} 🔴 新会话 preset 被**重绑**为 minecraft-plus（recompose，绕过 select 的锁）`)
      console.log(`  ${appendCalls.length === 1 && appendCalls[0][0] === 'agent-preset/selected' && appendCalls[0][1]?.agentPreset === 'minecraft-plus' ? '✅' : '❌'} 🔴 追加 agent-preset/selected 事件（让投影/UI 看到 MC+）`)
      console.log(`  ${renameCalls.length === 1 && renameCalls[0].sessionId === 'sess-CHILD1' && renameCalls[0].title === '测试会话 (1)' ? '✅' : '❌'} 标题 +1（对齐原生分支）：${JSON.stringify(renameCalls[0]?.title)}`)
      console.log(`  ${dispose.length === 2 ? '✅' : '❌'} observeSession 的句柄读了就 dispose（2 次：解析 atSeq + 取标题，不漏）：${dispose.length}`)

      // ② 失败路径：preset 不存在（throw）或**复验不符**（wrong）→ 回撤归档 + ok:false，绝不给"假 MC+ 分支"
      for (const mode of ['throw', 'wrong']) {
        forkCalls.length = 0; recomposeCalls.length = 0; appendCalls.length = 0; archived.length = 0
        presetsMode = mode
        forkChildId = `sess-BAD-${mode}`
        agents2 = { get: (id) => (id === forkChildId ? makeChild(id) : undefined) }
        const bad = await post({ sessionId: 'sess-API', messageId: 'msg-1' })
        const good = bad.ok === false && typeof bad.error === 'string' && bad.error.length > 0 &&
          bad.rolledBack === true && bad.sessionId === undefined && archived.length === 1 && archived[0] === forkChildId
        console.log(`  ${good ? '✅' : '❌'} 🔴 改模式失败（${mode}）→ **回撤归档刚建的分支** + ok:false（不给"假 MC+ 分支"）：${JSON.stringify(bad).slice(0, 140)}`)
      }
      presetsMode = 'ok'
    } finally { ctx2.get = origGet }
  }

  // ── 「MC设置」HTTP 接口（锁住 E2E 抓到的真 bug：**DELETE 也带 body，必须读**）──
  // 🔴 2026-09-16：这组接口现在**必须有带工作区的 sessionId**（用户："没有选中工作区就拒绝设置"）。
  //    造一个带工作区的会话，下面所有设置调用都自动带上它。
  const apiWs = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'whale-apiws-'))
  const apiWs2 = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'whale-apiws2-'))
  const apiAgent = { id: 'sess-API', session: { header: { cwd: apiWs } } }
  const apiAgent2 = { id: 'sess-API2', session: { header: { cwd: apiWs2 } } }
  agents2 = { get: (id) => (id === 'sess-API' ? apiAgent : id === 'sess-API2' ? apiAgent2 : undefined) }   // ⚠️ 这是**第二套** ctx 的服务（route2 属于它）
  const callApi = async (method, url, payload, sid = 'sess-API') => {
    const rq = new EventEmitter()
    rq.method = method
    rq.url = url + (url.includes('?') ? '&' : '?') + `sessionId=${sid}`
    rq.headers = { host: '127.0.0.1:39999' }
    const rs = { writeHead: () => {}, end: (b) => { rs.body = String(b ?? '') } }
    const p = route2.handler(rq, rs)
    if (payload !== undefined) rq.emit('data', JSON.stringify(payload))
    rq.emit('end')
    await p
    try { return JSON.parse(rs.body || '{}') } catch { return {} }
  }
  const noSidApi = await (async () => {
    const rq = new EventEmitter()
    rq.method = 'GET'; rq.url = '/api/mc/config'; rq.headers = { host: '127.0.0.1:39999' }
    const rs = { writeHead: () => {}, end: (b) => { rs.body = String(b ?? '') } }
    const p = route2.handler(rq, rs); rq.emit('end'); await p
    try { return JSON.parse(rs.body || '{}') } catch { return {} }
  })()
  console.log(`  ${noSidApi.ok === true && noSidApi.hasWorkspace === false && noSidApi.injectWhaleCraftAgentsMd === null ? '✅' : '❌'} 设置接口不带 sessionId → **无工作区模式**：放行、只回全局项（工作区键为 null）`)
  const accApi = await callApi('GET', '/api/mc/accounts')
  if (!accApi.ok) console.log('    [debug] GET /accounts 返回：', JSON.stringify(accApi).slice(0, 240), '| agents 服务：', typeof fakeCtx.agents?.get, '| apiAgent.cwd =', apiAgent.session.header.cwd)
  console.log(`  ${accApi.ok && accApi.accounts?.some((a) => a.name === 'DeepSeek') && accApi.authServers?.some((s) => s.id === 'littleskin') ? '✅' : '❌'} 设置接口 GET /accounts（默认离线账户 + 内置认证服）`)
  const srvApi = await callApi('POST', '/api/mc/authservers', { card: 'authlib-injector:yggdrasil-server:https%3A%2F%2Fself.example%2Fyggdrasil' })
  const srvDel = await callApi('DELETE', '/api/mc/authservers', { id: srvApi.server?.id })
  console.log(`  ${srvApi.ok && srvDel.ok ? '✅' : '❌'} 认证服务器增/删（**DELETE 也要读 body**）：${String(srvApi.server?.url)}`)
  const accNew = await callApi('POST', '/api/mc/accounts', { type: 'offline', name: '自检账户' })
  const accDel = await callApi('DELETE', '/api/mc/accounts', { innerID: accNew.account?.innerID })
  console.log(`  ${accNew.ok && accDel.ok ? '✅' : '❌'} 账户增/删（DELETE 带 body）`)
  const cfgApi = await callApi('GET', '/api/mc/config')
  console.log(`  ${Array.isArray(cfgApi.commandWhitelist) ? '✅' : '❌'} 设置接口 GET /config（白名单 ${cfgApi.commandWhitelist?.length} 条）`)
  // 🔴 2026-09-17 隔离实例实测：`/api/mc/presets` 只在 handleSettingsApi 里判过、**没进分派名单** →
  //    真机上一律 404，前端只能靠兜底名单。这条断言直接打真路由，防止再漏。
  const presetRoute = await (async () => {
    const rq = new EventEmitter()
    rq.method = 'GET'; rq.url = '/api/mc/presets'; rq.headers = { host: '127.0.0.1:39999' }
    const rs = { writeHead: () => {}, end: (b) => { rs.body = String(b ?? '') } }
    const p = route2.handler(rq, rs); rq.emit('end'); await p
    try { return JSON.parse(rs.body || '{}') } catch { return {} }
  })()
  console.log(`  ${presetRoute.ok === true && Array.isArray(presetRoute.mcModePresets) ? '✅' : '❌'} 🔴 /api/mc/presets 真路由可达（不带 sessionId 也回名单）：${JSON.stringify(presetRoute.mcModePresets ?? presetRoute.error)}`)
  console.log(`  ${!/password|accessToken|clientToken/i.test(JSON.stringify([accApi, srvApi, accNew, cfgApi])) ? '✅' : '❌'} 🔴 设置接口响应里逐字查过：没有凭据字段`)
  console.log(`  ${typeof cfgApi.allowAllCommands === 'boolean' && typeof cfgApi.injectWorkspaceAgentsMd === 'boolean' ? '✅' : '❌'} 配置接口带上了新开关（allowAllCommands / injectWorkspaceAgentsMd）`)
  const cfgPatch = await callApi('PATCH', '/api/mc/config', { allowAllCommands: true })
  console.log(`  ${cfgPatch.ok && cfgPatch.allowAllCommands === true ? '✅' : '❌'} PATCH 打开"允许所有指令"`)
  await callApi('PATCH', '/api/mc/config', { allowAllCommands: false })
  const md0 = await callApi('GET', '/api/mc/agents-md')
  console.log(`  ${md0.ok && /行事准则/.test(String(md0.text)) ? '✅' : '❌'} 提示词接口能读准则（source=${md0.source}）`)
  console.log(`  ${md0.followVersion === true && typeof md0.pluginVersion === 'string' ? '✅' : '❌'} 提示词接口带「随版本更新」开关与插件版本（follow=${md0.followVersion} v${md0.pluginVersion}）`)
  const cfgFollow = await callApi('PATCH', '/api/mc/config', { rulesFollowVersion: false })
  const md3 = await callApi('GET', '/api/mc/agents-md')
  console.log(`  ${cfgFollow.ok && cfgFollow.rulesFollowVersion === false && md3.followVersion === false ? '✅' : '❌'} PATCH 能关掉「随版本更新」（配置里记着，页面也读得到）`)
  // 🔴 2026-10-03：三个提示词开关**按工作区**存（<工作区>/.whale-craft/config.json），不再写全局。
  //    2026-10-08：记忆根没有 env 重定向了，本来就跟着**会话工作区**走。
  {
    const { readFileSync: rf } = await import('node:fs')
    const { join: jn } = await import('node:path')
    const cfgFollowA = await callApi('PATCH', '/api/mc/config', { rulesFollowVersion: false })
    const cfgApi2 = await callApi('GET', '/api/mc/config')
    const wsCfgFile = jn(apiWs, '.whale-craft', 'config.json')
    let wsCfgRaw = null
    try { wsCfgRaw = JSON.parse(rf(wsCfgFile, 'utf8')) } catch { wsCfgRaw = null }
    console.log(`  ${cfgFollowA.ok && wsCfgRaw?.rulesFollowVersion === false && wsCfgRaw?.schema === 1 ? '✅' : '❌'} 🔴 开关落在**本工作区**的 .whale-craft/config.json（schema:1 + rulesFollowVersion:false）`)
    console.log(`  ${cfgApi2.workspaceConfigFile === wsCfgFile && cfgApi2.rulesFollowVersion === false ? '✅' : '❌'} 配置接口报出工作区配置文件路径并回读新值（${String(cfgApi2.workspaceConfigFile)}）`)
    const globalRaw = (() => { try { return JSON.parse(rf(cfgApi2.configFile, 'utf8')) } catch { return {} } })()
    console.log(`  ${globalRaw.rulesFollowVersion === undefined && globalRaw.injectWorkspaceAgentsMd === undefined ? '✅' : '❌'} 🔴 全局 config.json 里不再写这三个键（只留迁移 seed 语义）`)
    const cfgFollow2 = await callApi('PATCH', '/api/mc/config', { rulesFollowVersion: true, injectWorkspaceAgentsMd: true }, 'sess-API2')
    const mdWs1 = await callApi('GET', '/api/mc/agents-md')
    const mdWs2 = await callApi('GET', '/api/mc/agents-md', undefined, 'sess-API2')
    console.log(`  ${cfgFollow2.ok && cfgFollow2.injectWorkspaceAgentsMd === true && mdWs1.followVersion === false && mdWs2.followVersion === true ? '✅' : '❌'} 🔴 两个工作区互不影响（A 关随版本更新 / B 开 + 额外注入工作区 AGENTS.md）`)
    let wsCfgA2 = null
    let wsCfgB = null
    try { wsCfgA2 = JSON.parse(rf(wsCfgFile, 'utf8')) } catch {}
    try { wsCfgB = JSON.parse(rf(jn(apiWs2, '.whale-craft', 'config.json'), 'utf8')) } catch {}
    console.log(`  ${wsCfgB?.injectWorkspaceAgentsMd === true && wsCfgA2?.injectWorkspaceAgentsMd === undefined ? '✅' : '❌'} 🔴 B 的注入开关没有串到 A（文件级隔离）`)
  }
  const mdPut = await callApi('PUT', '/api/mc/agents-md', { text: '# 自检临时准则' })
  const md1 = await callApi('GET', '/api/mc/agents-md')
  console.log(`  ${mdPut.ok && md1.source === 'custom' && /自检临时准则/.test(md1.text) ? '✅' : '❌'} PUT 保存自定义准则后立刻生效`)
  const mdDel = await callApi('DELETE', '/api/mc/agents-md')
  const md2 = await callApi('GET', '/api/mc/agents-md')
  console.log(`  ${mdDel.ok && md2.source === 'default' ? '✅' : '❌'} DELETE 恢复默认（回到打包那份）`)
}

// McBot.disconnect 单元验证：**先优雅退出，走不掉才强断**
console.log('\n--- disconnect：优雅优先 / 强断兜底 ---')
{
  const { McBot } = await import('./src/core.mjs')
  const mk = (b) => { const bot = new McBot({ instanceId: 'sc-disc-' + Math.random().toString(36).slice(2, 7) }); bot.bot = b; return bot }

  // ① 优雅：quit 之后自己 emit('end')
  let forced1 = false
  const good = {
    entity: {},
    once: (ev, fn) => { if (ev === 'end') setTimeout(fn, 10) },
    quit: () => {},
    _client: { end: () => { forced1 = true } },
  }
  const r1 = await mk(good).disconnect('自检-优雅')
  console.log(`  ${r1.graceful && !r1.forced && !forced1 ? '✅' : '❌'} 优雅退出优先（${r1.ms}ms graceful=${r1.graceful} forced=${r1.forced}）`)

  // ② 走不掉：不 emit，且仍"在线"（有 entity）→ 必须强断兜底
  let forced2 = false
  const bad = { entity: {}, once: () => {}, quit: () => {}, _client: { end: () => { forced2 = true } } }
  const r2 = await mk(bad).disconnect('自检-强断', { graceMs: 150 })
  console.log(`  ${r2.forced && forced2 ? '✅' : '❌'} 走不掉时强断兜底（${r2.ms}ms forced=${r2.forced}）`)

  // ③ 本来就没连接：不吊死
  const r3 = await new McBot({ instanceId: 'sc-disc-null' }).disconnect('自检-未连接')
  console.log(`  ${!r3.graceful && !r3.forced ? '✅' : '❌'} 没连接时立刻返回（不吊死，${r3.ms}ms）`)
}

// 单实例锁文件不许写进插件包目录（与日志同一条理由：装进 node_modules 后可能只读、升级会被覆盖）
console.log('\n--- 会话锁文件落点 ---')
{
  const { McBot } = await import('./src/core.mjs')
  const { join } = await import('node:path')
  const lockDir = 'C:\\Users\\x\\.dsh\\whale_craft'
  const withDir = new McBot({ instanceId: 'sess-A', lockDir })
  console.log(`  ${withDir.lockFile === join(lockDir, '.instance.sess-A.json') ? '✅' : '❌'} 给了 lockDir → 锁文件落在插件的家：${withDir.lockFile}`)
  const noDir = new McBot({ instanceId: 'sess-A' })
  console.log(`  ${noDir.lockFile.includes('.instance.sess-A.json') ? '✅' : '❌'} 没给 lockDir 时仍能算出路径（退回包目录保底，不崩）`)
  const src = (await import('node:fs')).readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  console.log(`  ${/new McSession\(agentId, this\.config, this\.lockDir\)/.test(src) && /registry\.lockDir = stateDir/.test(src) ? '✅' : '❌'} index.js 把状态目录传下去了（不写插件包目录）`)
}

// ── 发布区（`.whale-craft/.express/`）：纯函数 + 真路由（用户 2026-09-16 的形态）──
console.log('\n--- 发布区：目录即白名单 / 不用 token / 必须防穿透 ---')
{
  const E = await import('./src/express.mjs')
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join, sep } = await import('node:path')
  const { EventEmitter } = await import('node:events')

  console.log(`  ${E.EXPRESS_DIR === '.express' && E.OUT_DIR === '.out' ? '✅' : '❌'} 目录名：发布区 .express / 默认输出 .out（都以点开头）`)
  const cwd = join(mkdtempSync(join(tmpdir(), 'whale-express-')), 'myproj')
  mkdirSync(cwd, { recursive: true })        // 工作区目录本身得存在（闸门会 statSync 它）
  // 记忆根 = <会话工作区>/.whale-craft（2026-10-08 起无 env 重定向）→ 发布区跟着它
  const memRoot = join(cwd, '.whale-craft')
  const exRoot = E.expressRootOf(memRoot)
  mkdirSync(join(exRoot, 'world1'), { recursive: true })
  writeFileSync(join(exRoot, 'world1', 'example.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  writeFileSync(join(exRoot, 'note.svg'), '<svg/>')

  // ① URL 形态（用户 2026-09-17 定稿：`<base>/api/whale-craft/express/<工作区 uuid>/<剩余路径>`）
  const WS_UUID = '11111111-2222-3333-4444-555555555555'
  const ref = E.expressRefFor(join(exRoot, 'world1', 'example.png'), memRoot, WS_UUID)
  const WANT_URL = `/api/whale-craft/express/${WS_UUID}/world1/example.png`
  console.log(`  ${ref?.url === WANT_URL ? '✅' : '❌'} URL 形态 = /api/whale-craft/express/<工作区 uuid>/<剩余路径>：${ref?.url}`)
  console.log(`  ${ref?.markdown === `![](${ref?.url})` ? '✅' : '❌'} 直接给现成 markdown：${ref?.markdown}`)
  console.log(`  ${E.expressRefFor(join(memRoot, '.out', 'x.png'), memRoot, WS_UUID) === null ? '✅' : '❌'} .out/ 里的文件**不给 URL**（不对外）`)
  console.log(`  ${E.expressRefFor(join(exRoot, 'world1', 'example.png'), memRoot, '') === null && E.expressRefFor(join(exRoot, 'world1', 'example.png'), memRoot, '../x') === null ? '✅' : '❌'} 🔴 没有合法 uuid 就不给 URL（不退回目录名）`)

  // ② 解析 + 段级防穿透
  const parse = E.parseExpressPath(WANT_URL)
  console.log(`  ${parse?.workspaceId === WS_UUID && parse.segments.join('/') === 'world1/example.png' ? '✅' : '❌'} 解析出工作区 uuid 与剩余路径（**子目录可以有**）`)
  console.log(`  ${E.parseExpressPath(`/api/whale-craft/express/${WS_UUID}`) === null && E.parseExpressPath('/api/whale-craft/express//x.png') === null ? '✅' : '❌'} 缺路径 / 空 uuid 段 → 不解析`)
  console.log(`  ${E.parseExpressPath('/api/mc/whale-craft/myproj/world1/example.png') === null ? '✅' : '❌'} 🔴 旧地址形态（/api/mc/whale-craft/<目录名>/…）不再认（已停用）`)
  const root = join(cwd, '.whale-craft', '.express')
  const bad = [
    ['..', ['..', 'secret.txt']],
    ['编码过的 ..', ['%2e%2e', 'secret.txt'].map(decodeURIComponent)],
    ['绝对路径味道', ['C:', 'windows', 'system32']],
    ['段里带分隔符', ['a/b.png']],
    ['反斜杠', ['a\\b.png']],
    ['空段', ['world1', '', 'x.png']],
    ['点段', ['.']],
    ['~ 开头', ['~/.ssh/id_rsa']],
  ]
  const leaked = bad.filter(([, segs]) => E.safeExpressTarget(root, segs) !== null)
  console.log(`  ${leaked.length === 0 ? '✅' : '❌'} 🔴 段级防穿透（${bad.length} 种）全拒：${leaked.map(([n]) => n).join(', ') || '无漏网'}`)
  console.log(`  ${E.safeExpressTarget(root, ['world1', 'example.png']) === join(root, 'world1', 'example.png') ? '✅' : '❌'} 正常路径（含子目录）放行`)

  // ②b 「文件分享」（2026-10-04 用户定：从"模式"改成**开关**；老 `expressMode` 的迁移见 config 段）
  //     base 归一化 / URL 拼法照旧：
  console.log(`  ${E.normalizeExpressBase(' https://a.example.com/ ') === 'https://a.example.com' && E.normalizeExpressBase('') === '' ? '✅' : '❌'} base 归一化：去空白与尾斜杠；空 = 未设置`)
  console.log(`  ${E.normalizeExpressBase('ftp://x') === null && E.normalizeExpressBase('a.example.com') === null ? '✅' : '❌'} base 必须是 http(s) 完整地址`)
  console.log(`  ${E.onlineUrlOf('https://a.example.com/', '/api/mc/x') === 'https://a.example.com/api/mc/x' && E.onlineUrlOf('', '/x') === null ? '✅' : '❌'} 在线 URL = base + 相对路径（base 空 → null）`)
  console.log(`  ${E.EXPRESS_OFF_TEXT === '文件分享已关闭，请告知用户文件绝对路径，让用户自行打开' ? '✅' : '❌'} 关闭模式那句话逐字固定：${E.EXPRESS_OFF_TEXT}`)

  // ②c 桌面模式（2026-10-07）：独立端口 URL 形态 + 端口工具（纯函数）
  console.log(`  ${E.DEFAULT_EXPRESS_PORT === 16049 && E.EXPRESS_HOST === '127.0.0.1' ? '✅' : '❌'} 桌面默认端口 16049；只绑回环 127.0.0.1`)
  console.log(`  ${E.isExpressPort(1) && E.isExpressPort(65535) && !E.isExpressPort(0) && !E.isExpressPort(65536) && !E.isExpressPort('x') && !E.isExpressPort(1.5) ? '✅' : '❌'} 端口合法域 = 整数 1–65535`)
  console.log(`  ${E.normalizeExpressPort('16049') === 16049 && E.normalizeExpressPort(0) === null ? '✅' : '❌'} 端口归一化：数字串→整数；非法→null`)
  {
    const lp = E.parseExpressLocalPath(`/${WS_UUID}/world1/example.png`)
    console.log(`  ${lp?.workspaceId === WS_UUID && lp?.segments.join('/') === 'world1/example.png' ? '✅' : '❌'} 桌面路径解析：/<uuid>/<rel>（无 /api 前缀）`)
    console.log(`  ${E.parseExpressLocalPath('') === null && E.parseExpressLocalPath('/') === null && E.parseExpressLocalPath(`/${WS_UUID}`) === null ? '✅' : '❌'} 桌面解析：空 / 只有 / / 缺剩余路径 → 不认`)
  }
  console.log(`  ${/端口 16049 无法监听/.test(E.EXPRESS_PORT_BUSY_TEXT(16049)) ? '✅' : '❌'} 端口起不来那句话带上端口号：${E.EXPRESS_PORT_BUSY_TEXT(16049).slice(0, 24)}…`)
  {
    const refL = E.expressRefFor(join(E.expressRootOf(memRoot), 'world1', 'example.png'), memRoot, WS_UUID)
    console.log(`  ${refL?.localPath === `/${WS_UUID}/world1/example.png` && refL?.url === `/api/whale-craft/express/${WS_UUID}/world1/example.png` ? '✅' : '❌'} expressRefFor 同时给 web url（带前缀）与 localPath（桌面用）：${refL?.localPath}`)
  }

  // ③ 真路由：设置接口走 `/api/mc`；**发布区走自己的 `/api/whale-craft` 前缀路由**
  const route = registeredRoutes.find((r) => r.path === '/api/mc')
  const fileRoute = registeredRoutes.find((r) => r.path === '/api/whale-craft')
  console.log(`  ${fileRoute ? '✅' : '❌'} 发布区有自己的前缀路由：${fileRoute?.path}（最长前缀优先，不会掉进 /api 的 RPC）`)
  const callOn = async (r, method, url, headers = {}, payload) => {
    const rq = new EventEmitter()
    rq.method = method
    rq.url = url
    rq.headers = { host: '127.0.0.1:39999', ...headers }
    const rs = {
      status: null, headers: null, body: null,
      writeHead: (code, h) => { rs.status = code; rs.headers = h ?? {} },
      end: (b) => { rs.body = b ?? null },
    }
    const p = r.handler(rq, rs)
    if (payload !== undefined) rq.emit('data', JSON.stringify(payload))
    rq.emit('end')
    await p
    return rs
  }
  const callRaw = (method, url, headers = {}, payload) => callOn(route, method, url, headers, payload)
  const callFile = (method, url, headers = {}) => callOn(fileRoute, method, url, headers)
  // 让服务端认得这个工作区（走真实路径：点开 MC设置 → settingsGate）
  await callRaw('GET', '/api/mc/accounts?cwd=' + encodeURIComponent(cwd))
  /** 改全局配置（分享模式/base）—— 走**本 ctx** 的路由，改完立即对工具与路由生效 */
  const patchCfg = (payload) => callRaw('PATCH', '/api/mc/config?cwd=' + encodeURIComponent(cwd), {}, payload)
  // 🔴 工作区 uuid 从**宿主注册表**来：自检里给这个 ctx 装一个（真机上由 DSH 维护）
  const realCwd = (await import('node:fs')).realpathSync(cwd)
  fakeCtx.workspaceRegistry.list = () => [{ id: WS_UUID, path: realCwd }]
  const expressUrl = `/api/whale-craft/express/${WS_UUID}/world1/example.png`

  /* 🔴 「文件分享」只有 **web 模式且已开启**才开这条服务（用户 2026-09-17；2026-10-07 按模式拆键）。
   * 默认是关闭 → 先验这条路由根本不开。 */
  const notOnline = await callFile('GET', expressUrl)
  console.log(`  ${notOnline.status === 404 ? '✅' : '❌'} 🔴 默认（关闭）模式下这条服务**不开**：${notOnline.status}`)

  // 切到在线模式（用户要自己填 base）后再验真路由
  await patchCfg({ expressWebEnabled: true, expressWebBase: 'https://share.example.com/' })
  const ok = await callFile('GET', expressUrl)
  console.log(`  ${ok.status === 200 && ok.headers?.['content-type'] === 'image/png' && ok.headers?.['x-content-type-options'] === 'nosniff' ? '✅' : '❌'} GET 正常出图：${ok.status} ${ok.headers?.['content-type']}（len=${ok.headers?.['content-length']}）`)
  console.log(`  ${ok.headers?.['cache-control'] === 'private, max-age=300' ? '✅' : '❌'} 缓存头 private（不给共享缓存）`)
  const svg = await callFile('GET', `/api/whale-craft/express/${WS_UUID}/note.svg`)
  console.log(`  ${svg.status === 200 && /sandbox/.test(String(svg.headers?.['content-security-policy'] ?? '')) ? '✅' : '❌'} 所有扩展名都放行；svg 只加一个 CSP sandbox 头（内联显示照旧、脚本跑不了）`)
  const trav = await callFile('GET', `/api/whale-craft/express/${WS_UUID}/..%2F..%2FAGENTS.md`)
  console.log(`  ${trav.status === 404 ? '✅' : '❌'} 🔴 穿透请求 404（实测）`)
  const trav2 = await callFile('GET', `/api/whale-craft/express/${WS_UUID}/world1/..%2F..%2F..%2FREADME.md`)
  console.log(`  ${trav2.status === 404 ? '✅' : '❌'} 🔴 子目录里的穿透也 404`)
  const missing = await callFile('GET', `/api/whale-craft/express/${WS_UUID}/nope.png`)
  console.log(`  ${missing.status === 404 ? '✅' : '❌'} 不存在的文件 404`)
  const otherWs = await callFile('GET', '/api/whale-craft/express/99999999-0000-0000-0000-000000000000/world1/example.png')
  console.log(`  ${otherWs.status === 404 ? '✅' : '❌'} 注册表里没有的 uuid 404（不是 500）`)
  const oldShape = await callRaw('GET', '/api/mc/whale-craft/myproj/world1/example.png')
  console.log(`  ${oldShape.status === 404 ? '✅' : '❌'} 🔴 旧地址（/api/mc/whale-craft/<目录名>/…）已停用：${oldShape.status}`)
  const foreign = await callFile('GET', `/api/whale-craft/express/${WS_UUID}/note.svg`, { host: 'evil.example.com' })
  console.log(`  ${foreign.status === 403 ? '✅' : '❌'} 外来 Host 仍被信任栅栏挡在门外（403）`)
  const head = await callFile('HEAD', expressUrl)
  console.log(`  ${head.status === 200 && head.body === null ? '✅' : '❌'} HEAD 只有头没有体`)
  const dirReq = await callFile('GET', `/api/whale-craft/express/${WS_UUID}`)
  console.log(`  ${dirReq.status !== 200 ? '✅' : '❌'} 目录请求不是 200（不列目录）：${dirReq.status}`)
  const dirReq2 = await callFile('GET', `/api/whale-craft/express/${WS_UUID}/world1`)
  console.log(`  ${dirReq2.status !== 200 ? '✅' : '❌'} 子目录请求也不是 200：${dirReq2.status}`)
  // 关掉分享 → 服务立刻停（不留"以为关了其实还能访问"的口子）
  await patchCfg({ expressWebEnabled: false })
  const inOff = await callFile('GET', expressUrl)
  console.log(`  ${inOff.status === 404 ? '✅' : '❌'} 从在线切回「关闭」→ 服务关闭（404）：${inOff.status}`)
  await patchCfg({ expressWebEnabled: true, expressWebBase: 'https://share.example.com/' })

  // ④ 专用工具 `mc_kit_express`：入参一个路径，**只回一行**；回什么由「文件分享」开关决定
  {
    const tool = tools.get('mc_kit_express')
    console.log(`  ${tool ? '✅' : '❌'} 工具已注册：mc_kit_express（参数 ${JSON.stringify(Object.keys(tool?.parameters ?? {}))}）`)
    // 记忆根就是 <工作区>/.whale-craft（2026-10-08 起无 env 重定向）
    try {
      const wsEx = join(cwd, '.whale-craft', E.EXPRESS_DIR, 'world1')
      mkdirSync(wsEx, { recursive: true })
      writeFileSync(join(wsEx, 'example.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      const ex = { agent: { id: 'sess-EX', session: { header: { cwd } } } }
      const rel = `/api/whale-craft/express/${WS_UUID}/world1/example.png`
      const line = (v) => tool.output?.render?.({}, v)?.map((b) => b.text).join('') ?? ''

      // ── 开启（块开头已设成 expressEnabled + base）→ 完整 URL ──
      const got = await tool.execute({ path: `.whale-craft/${E.EXPRESS_DIR}/world1/example.png` }, ex)
      const want = 'https://share.example.com' + rel
      console.log(`  ${got.url === want && got.enabled === true ? '✅' : '❌'} 🔴 开启：base + /api/whale-craft/express/<uuid>/… = 完整 URL：${got.url}`)
      console.log(`  ${line(got) === got.url ? '✅' : '❌'} 渲染给模型的**只有那一行**（不含 JSON 壳）：${JSON.stringify(line(got))}`)
      const memRel = await tool.execute({ path: join(E.EXPRESS_DIR, 'world1', 'example.png') }, ex)
      console.log(`  ${memRel.url === want ? '✅' : '❌'} 记忆根相对写法（.express/...）也认`)
      const absGot = await tool.execute({ path: join(wsEx, 'example.png') }, ex)
      console.log(`  ${absGot.url === want ? '✅' : '❌'} 绝对路径也认（三种写法给同一条 URL）`)

      // ── 工作区没登记进注册表 → **拒绝**（用户定的 (a)，不退回目录名） ──
      {
        const savedList = fakeCtx.workspaceRegistry.list
        fakeCtx.workspaceRegistry.list = () => []
        const unregistered = await tool.execute({ path: `.whale-craft/${E.EXPRESS_DIR}/world1/example.png` }, ex)
          .then(() => null).catch((e) => e.message)
        fakeCtx.workspaceRegistry.list = savedList
        console.log(`  ${/不在 DSH 的工作区注册表里/.test(String(unregistered)) ? '✅' : '❌'} 🔴 工作区没登记 → 拒绝（不退回目录名）：${String(unregistered).slice(0, 34)}…`)
        const back = await tool.execute({ path: `.whale-craft/${E.EXPRESS_DIR}/world1/example.png` }, ex)
        console.log(`  ${back.url === want ? '✅' : '❌'} 登记回来后照常给 URL`)
      }

      // ── 在线但没配 base → 不抛错，回"让用户去设置" ──
      await patchCfg({ expressWebBase: '' })
      const noBase = await tool.execute({ path: `.whale-craft/${E.EXPRESS_DIR}/world1/example.png` }, ex)
      console.log(`  ${noBase.url === E.EXPRESS_NEED_BASE_TEXT && /还没有设置 base/.test(line(noBase)) ? '✅' : '❌'} 在线但没 base → 提示去设置（不抛错）：${noBase.url.slice(0, 24)}…`)

      // ── 关闭（默认）→ 恒回那一句（并且依然要求文件在发布区里） ──
      await patchCfg({ expressWebEnabled: false })
      const offGot = await tool.execute({ path: `.whale-craft/${E.EXPRESS_DIR}/world1/example.png` }, ex)
      console.log(`  ${offGot.url === E.EXPRESS_OFF_TEXT && offGot.enabled === false ? '✅' : '❌'} 关闭：恒回那一句（逐字）：${offGot.url}`)
      console.log(`  ${line(offGot) === E.EXPRESS_OFF_TEXT ? '✅' : '❌'} 渲染出来就是那句话本身`)
      console.log(`  ${!/^https?:/.test(offGot.url) ? '✅' : '❌'} 关闭模式**不编造** http 链接`)
      console.log(`  ${typeof offGot.abs === 'string' && offGot.abs.endsWith('example.png') ? '✅' : '❌'} 值里仍带着真实绝对路径（渲染不给模型，留给以后用）：${offGot.abs}`)

      const missing = await tool.execute({ path: '.express/nope.png' }, ex).then(() => null).catch((e) => e.message)
      console.log(`  ${/找不到这个文件/.test(String(missing)) ? '✅' : '❌'} 文件不存在 → 报错清楚：${String(missing).slice(0, 40)}…`)
      const outDir2 = join(cwd, '.whale-craft', E.OUT_DIR)
      mkdirSync(outDir2, { recursive: true })
      writeFileSync(join(outDir2, 'draft.png'), Buffer.from([0x89]))
      const notInExpress = await tool.execute({ path: `.whale-craft/${E.OUT_DIR}/draft.png` }, ex).then(() => null).catch((e) => e.message)
      console.log(`  ${/不在发布区里/.test(String(notInExpress)) ? '✅' : '❌'} 🔴 关闭模式下 .out/ 里的文件照样拒绝（两种模式都只认发布区）：${String(notInExpress).slice(0, 24)}…`)
      const escape = await tool.execute({ path: '../../../etc/passwd' }, ex).then(() => null).catch((e) => e.message)
      console.log(`  ${escape ? '✅' : '❌'} 穿透路径也拿不到东西（报错）：${String(escape).slice(0, 30)}…`)

      /* ── ④b 桌面模式：按宿主模式拆键（用户 2026-10-07）──
       * 用 `fakeCtx.profileContext` 模拟桌面端。验证：独立端口 URL、只监听 localhost、端口占用文案、
       * `/api/mc/express/port` 自检、web/desktop 两套键互不串。 */
      {
        const ESrv = await import('./src/express-server.mjs')
        // 挑一个本机空闲端口（别用默认 16049，免与开发机真实占用撞车导致抖动）
        let freePort = null
        for (let p = 45000; p < 45064; p++) { if (await ESrv.portAvailable(p)) { freePort = p; break } }
        if (!freePort) console.log('  ❌ 找不到空闲端口做桌面测试（跳过后续桌面断言）')
        fakeCtx.profileContext = { name: 'desktop' }   // 模拟桌面端（hostMode 读它）
        try {
          const cfgD = JSON.parse(String((await callRaw('GET', '/api/mc/config?cwd=' + encodeURIComponent(cwd))).body ?? '{}'))
          console.log(`  ${cfgD.mode === 'desktop' ? '✅' : '❌'} profileContext.name=desktop ⇒ mode=desktop：${cfgD.mode}`)
          console.log(`  ${cfgD.expressDesktopPort === 16049 ? '✅' : '❌'} 桌面端口默认 16049：${cfgD.expressDesktopPort}`)

          // 未启用 → 工具恒回"已关闭"那句
          await patchCfg({ expressDesktopPort: freePort, expressDesktopEnabled: false })
          const offD = await tool.execute({ path: `.whale-craft/${E.EXPRESS_DIR}/world1/example.png` }, ex)
          console.log(`  ${offD.url === E.EXPRESS_OFF_TEXT && offD.enabled === false ? '✅' : '❌'} 桌面模式未启用 → 恒回关闭那一句`)

          // 启用 → 独立端口起来；工具回 http://localhost:<port>/<uuid>/<rel>
          await patchCfg({ expressDesktopEnabled: true })
          const st = JSON.parse(String((await callRaw('GET', '/api/mc/express?cwd=' + encodeURIComponent(cwd))).body ?? '{}'))
          console.log(`  ${st.mode === 'desktop' && st.port === freePort && st.listening === true ? '✅' : '❌'} 启用后独立端口在监听：port=${st.port} listening=${st.listening}`)
          const gotD = await tool.execute({ path: `.whale-craft/${E.EXPRESS_DIR}/world1/example.png` }, ex)
          const wantD = `http://localhost:${freePort}/${WS_UUID}/world1/example.png`
          console.log(`  ${gotD.url === wantD && gotD.enabled === true ? '✅' : '❌'} 🔴 桌面 URL = http://localhost:<port>/<uuid>/<rel>：${gotD.url}`)

          // 真取文件（本机直连独立端口）—— 只监听回环，GET 可得
          const fetched = await fetch(`http://127.0.0.1:${freePort}/${WS_UUID}/world1/example.png`)
          console.log(`  ${fetched.status === 200 && fetched.headers.get('content-type') === 'image/png' ? '✅' : '❌'} 独立端口真能取到文件：${fetched.status} ${fetched.headers.get('content-type')}`)
          const travD = await fetch(`http://127.0.0.1:${freePort}/${WS_UUID}/..%2F..%2FAGENTS.md`)
          console.log(`  ${travD.status === 404 ? '✅' : '❌'} 独立端口也防穿透（404）：${travD.status}`)
          const otherD = await fetch(`http://127.0.0.1:${freePort}/99999999-0000-0000-0000-000000000000/world1/example.png`)
          console.log(`  ${otherD.status === 404 ? '✅' : '❌'} 独立端口上未知 uuid 404：${otherD.status}`)
          const postD = await fetch(`http://127.0.0.1:${freePort}/${WS_UUID}/world1/example.png`, { method: 'POST' })
          console.log(`  ${postD.status === 404 ? '✅' : '❌'} 独立端口只认 GET/HEAD（POST 404）：${postD.status}`)
          // ⚠️ fetch 会**丢掉**自设的 Host 头（forbidden header）→ 得用原生 http 才能发外来 Host
          const httpMod = await import('node:http')
          const foreignD = await new Promise((resolve) => {
            const rq = httpMod.request(
              { host: '127.0.0.1', port: freePort, path: `/${WS_UUID}/world1/example.png`, headers: { Host: 'evil.example.com' } },
              (rs) => { rs.resume(); resolve(rs.statusCode) },
            )
            rq.on('error', () => resolve(0))
            rq.end()
          })
          console.log(`  ${foreignD === 403 ? '✅' : '❌'} 独立端口拒外来 Host（防 DNS-rebinding，403）：${foreignD}`)

          // /api/mc/express/port 自检：正在用的端口算可用；非法端口 invalid
          const pCur = JSON.parse(String((await callRaw('GET', `/api/mc/express/port?port=${freePort}`)).body ?? '{}'))
          console.log(`  ${pCur.available === true && pCur.current === true ? '✅' : '❌'} /port 自检：本插件正在用的端口算可用：${JSON.stringify(pCur)}`)
          const pBad = JSON.parse(String((await callRaw('GET', '/api/mc/express/port?port=0')).body ?? '{}'))
          console.log(`  ${pBad.available === false && pBad.reason === 'invalid' ? '✅' : '❌'} /port 自检：非法端口 invalid：${JSON.stringify(pBad)}`)

          // 换到被占用的端口 → 服务起不来，工具回占用文案，/port 报 inuse
          const busyPort = freePort + 1
          const blocker = (await import('node:net')).createServer()
          await new Promise((r) => blocker.listen(busyPort, '127.0.0.1', () => r()))
          try {
            await patchCfg({ expressDesktopPort: busyPort })
            const stBusy = JSON.parse(String((await callRaw('GET', '/api/mc/express?cwd=' + encodeURIComponent(cwd))).body ?? '{}'))
            console.log(`  ${stBusy.listening === false && String(stBusy.portError ?? '').includes('EADDRINUSE') ? '✅' : '❌'} 端口被占用 ⇒ 服务没起来（portError=${stBusy.portError}）`)
            const busyGot = await tool.execute({ path: `.whale-craft/${E.EXPRESS_DIR}/world1/example.png` }, ex)
            console.log(`  ${busyGot.url === E.EXPRESS_PORT_BUSY_TEXT(busyPort) ? '✅' : '❌'} 🔴 端口起不来 ⇒ 工具回占用文案：${busyGot.url.slice(0, 28)}…`)
            const pBusy = JSON.parse(String((await callRaw('GET', `/api/mc/express/port?port=${busyPort}`)).body ?? '{}'))
            console.log(`  ${pBusy.available === false && pBusy.reason === 'inuse' ? '✅' : '❌'} /port 自检：被占用 → inuse：${JSON.stringify(pBusy)}`)
          } finally { await new Promise((r) => blocker.close(() => r())) }

          // 🔴 两套键互不串：web 现在是关的（前段还原过），桌面改它不影响 web
          const cfgMix = JSON.parse(String((await callRaw('GET', '/api/mc/config?cwd=' + encodeURIComponent(cwd))).body ?? '{}'))
          console.log(`  ${cfgMix.expressWebEnabled === false && cfgMix.expressDesktopEnabled === true ? '✅' : '❌'} 🔴 两套键互不串：web=${cfgMix.expressWebEnabled} desktop=${cfgMix.expressDesktopEnabled}`)

          // 清理：关掉桌面分享（停掉独立端口，别留句柄）
          await patchCfg({ expressDesktopEnabled: false, expressDesktopPort: 16049 })
          const stOff = JSON.parse(String((await callRaw('GET', '/api/mc/express?cwd=' + encodeURIComponent(cwd))).body ?? '{}'))
          console.log(`  ${stOff.listening === false ? '✅' : '❌'} 关掉桌面分享 ⇒ 独立端口停掉：listening=${stOff.listening}`)
        } finally {
          delete fakeCtx.profileContext   // 还原成 web ctx，别污染后面的断言
        }
      }

      /* ── ⑤ 「清除分享数据」（`/api/mc/express`：看现状 / 清空）──
       * 只删发布区**里面**的东西；目录重建；返回删了几个文件、多少字节。 */
      const stat1 = await callRaw('GET', '/api/mc/express?cwd=' + encodeURIComponent(cwd))
      const s1 = JSON.parse(String(stat1.body ?? '{}'))
      console.log(`  ${s1.ok && s1.dir === join(cwd, '.whale-craft', E.EXPRESS_DIR) && s1.files >= 1 ? '✅' : '❌'} 分享数据现状：${s1.dir}（${s1.files} 个文件 / ${s1.bytes} 字节）`)
      // 「当前地址」（base 的「获取当前」/ 切在线时自动填）：从**这次请求**推出来
      console.log(`  ${s1.currentBase === 'http://127.0.0.1:39999' ? '✅' : '❌'} 「当前地址」从 Host 推出来：${s1.currentBase}`)
      // 🔴 最精准的那一档：浏览器把 `location.origin` 报上来（协议/域名/端口都是它真在用的）
      const withHint = await callRaw('GET', '/api/mc/express?cwd=' + encodeURIComponent(cwd) + '&clientOrigin=' + encodeURIComponent('https://127.0.0.1:39999'))
      const hintBody = JSON.parse(String(withHint.body ?? '{}'))
      console.log(`  ${hintBody.currentBase === 'https://127.0.0.1:39999' ? '✅' : '❌'} 🔴 浏览器报的 clientOrigin 优先（最准）：${hintBody.currentBase}`)
      const hintPath = await callRaw('GET', '/api/mc/express?cwd=' + encodeURIComponent(cwd) + '&clientOrigin=' + encodeURIComponent('https://127.0.0.1:39999/proxy'))
      const hintPathBody = JSON.parse(String(hintPath.body ?? '{}'))
      console.log(`  ${hintPathBody.currentBase === 'https://127.0.0.1:39999/proxy' ? '✅' : '❌'} 服务端不擅自裁剪 clientOrigin（真要带反代前缀时不会被吃掉；但 location.origin 本身不含路径）：${hintPathBody.currentBase}`)
      const badHint = await callRaw('GET', '/api/mc/express?cwd=' + encodeURIComponent(cwd) + '&clientOrigin=' + encodeURIComponent('https://evil.example.com'))
      const badHintBody = JSON.parse(String(badHint.body ?? '{}'))
      console.log(`  ${badHintBody.currentBase === 'http://127.0.0.1:39999' ? '✅' : '❌'} clientOrigin 的 host 与请求 Host 不一致 → 不认（退回 Host）：${badHintBody.currentBase}`)
      const fwd = await callRaw('GET', '/api/mc/express?cwd=' + encodeURIComponent(cwd), { 'x-forwarded-proto': 'https' })
      const fwdBody = JSON.parse(String(fwd.body ?? '{}'))
      console.log(`  ${fwdBody.currentBase === 'https://127.0.0.1:39999' ? '✅' : '❌'} 反代场景认 X-Forwarded-Proto：${fwdBody.currentBase}`)
      // Origin 只能与 Host 同 host:port（信任栅栏的要求），所以它带来的差别是**协议**
      const withOrigin = await callRaw('GET', '/api/mc/express?cwd=' + encodeURIComponent(cwd), { origin: 'https://127.0.0.1:39999' })
      const originBody = JSON.parse(String(withOrigin.body ?? '{}'))
      console.log(`  ${originBody.currentBase === 'https://127.0.0.1:39999' ? '✅' : '❌'} 有 Origin 时优先用它（协议最准）：${originBody.currentBase}`)
      // 🔴 反代终止 TLS 的场景：同源 GET 常常没有 Origin，但一般有 Referer —— 靠它拿到 https
      const withRef = await callRaw('GET', '/api/mc/express?cwd=' + encodeURIComponent(cwd), { referer: 'https://127.0.0.1:39999/chat/abc' })
      const refBody = JSON.parse(String(withRef.body ?? '{}'))
      console.log(`  ${refBody.currentBase === 'https://127.0.0.1:39999' ? '✅' : '❌'} 没有 Origin 时用**同源** Referer 的 origin：${refBody.currentBase}`)
      const badRef = await callRaw('GET', '/api/mc/express?cwd=' + encodeURIComponent(cwd), { referer: 'https://evil.example.com/x' })
      const badRefBody = JSON.parse(String(badRef.body ?? '{}'))
      console.log(`  ${badRefBody.currentBase === 'http://127.0.0.1:39999' ? '✅' : '❌'} 不同源的 Referer 一律不认（退回 Host 推导）：${badRefBody.currentBase}`)
      const cleared = await callRaw('DELETE', '/api/mc/express?cwd=' + encodeURIComponent(cwd))
      const c1 = JSON.parse(String(cleared.body ?? '{}'))
      const stat2 = await callRaw('GET', '/api/mc/express?cwd=' + encodeURIComponent(cwd))
      const s2 = JSON.parse(String(stat2.body ?? '{}'))
      console.log(`  ${c1.ok && c1.removed === s1.files ? '✅' : '❌'} 「清除分享数据」删掉 ${s1.files} 个文件（返回 removed=${c1.removed}）`)
      console.log(`  ${s2.ok && s2.files === 0 && s2.bytes === 0 ? '✅' : '❌'} 清完发布区是空的（files=${s2.files}）`)
      console.log(`  ${existsSync(join(cwd, '.whale-craft', E.EXPRESS_DIR)) ? '✅' : '❌'} 发布区目录**重建**（AI 不用再建）`)

      // 还原：回到关闭（默认），别把临时配置留给后面的断言
      await patchCfg({ expressWebEnabled: false, expressWebBase: '' })
      const backDefault = await callRaw('GET', '/api/mc/config?cwd=' + encodeURIComponent(cwd))
      const bd = JSON.parse(String(backDefault.body ?? '{}'))
      console.log(`  ${bd.expressWebEnabled === false && bd.expressWebBase === '' ? '✅' : '❌'} 还原成默认（关、无 base）：enabled=${bd.expressWebEnabled} base='${bd.expressWebBase}'`)
      // 模式字段：web ctx（无 profileContext）应报 web；四键齐全
      console.log(`  ${bd.mode === 'web' && 'expressDesktopEnabled' in bd && 'expressDesktopPort' in bd ? '✅' : '❌'} config 回 mode=web + web/desktop 两套键（desktop 默认端口 ${bd.expressDesktopPort}）`)
    } finally {
      /* 记忆根不再有 env 重定向（2026-10-08 删） */
    }
  }
}

// ── 玩家说话要能被认出来（2026-09-16 真机事故：LAN/离线服上"喊我不应，只能 tp 我"）──
// 根因：只有 player_chat（签名聊天包）才 emit('chat')；system_chat（未签名）被当 system 丢掉。
// 这条链路（说话 → chat 事件 → 看门狗 mention）必须断言在**真实实现**上，所以走公开的 wireChatEvents()。
console.log('\n--- 聊天识别（未签名 system_chat 也要算玩家说话）---')
{
  const { McBot } = await import('./src/core.mjs')
  const { EventEmitter } = await import('node:events')
  const mkChatBot = (username = 'Test_Bot') => {
    const bot = new EventEmitter()
    bot.username = username
    bot._client = new EventEmitter()
    return bot
  }
  // 服务端发来的 **未签名** 聊天（LAN 开放世界 / 离线服 / 1.19+）：translate = chat.type.text
  const sysChat = (who, body) => {
    const msg = {
      translate: 'chat.type.text',
      with: [{ text: who }, { text: body }],
      toString: () => `<${who}> ${body}`,
    }
    return [msg, undefined]        // position = undefined（mineflayer 对 positionId 0 就是这个）
  }
  const sysText = (text) => {
    const msg = { translate: 'multiplayer.player.joined', with: [{ text: 'x' }], toString: () => text }
    return [msg, 'system']
  }
  const whisper = (who, body) => {
    const msg = {
      translate: 'commands.message.display.incoming',
      with: [{ text: who }, { text: body }],
      toString: () => `${who} whispers to you: ${body}`,
    }
    return [msg, undefined]
  }
  /**
   * 🔴 实验体 2026-09-16 的证据：有的服务端把玩家聊天发在 **system 位置**（positionId 1），
   * translate 也可能是它自己那套；但渲染出来就是 `<<user>> tp我，ds。`。
   * 只按 position/translate 判会永远漏掉这类消息（事件队列里 kind 全是 system）。
   */
  const systemSlotChat = (who, body) => {
    const msg = { translate: 'chat.type.text', with: [{ text: who }, { text: body }], toString: () => `<${who}> ${body}` }
    return [msg, 'system']
  }

  const chats = []
  const systems = []
  const b1 = new McBot({ instanceId: 'sc-chat-' + Math.random().toString(36).slice(2, 7) })
  const fake = mkChatBot()
  b1.wireChatEvents(fake)
  b1.on('chat', (c) => chats.push(c))
  b1.on('system', (s) => systems.push(s))

  fake.emit('message', ...sysChat('Tester', '来我这。'))
  console.log(`  ${chats.length === 1 && chats[0].who === 'Tester' && chats[0].text === '来我这。' ? '✅' : '❌'} 🔴 未签名聊天（system_chat）被认成玩家说话：${JSON.stringify(chats[0] ?? null)}`)
  console.log(`  ${b1.stats.chats === 1 ? '✅' : '❌'} stats.chats 也涨了（以前这里是 0 —— 就是"喊我不应"的判据）`)
  fake.emit('message', ...sysChat('Tester', '来我这。'))
  console.log(`  ${chats.length === 1 ? '✅' : '❌'} 同一句短时间内重复只算一次（1.5s 去重）`)

  chats.length = 0
  fake.emit('message', ...sysChat('Test_Bot', '我自己说的话'))
  console.log(`  ${chats.length === 0 ? '✅' : '❌'} 自己说的话不触发 chat（不当成别人喊我）`)

  chats.length = 0
  fake.emit('message', ...sysText('Tester joined the game'))
  console.log(`  ${chats.length === 0 && systems.length === 1 ? '✅' : '❌'} 服务器系统消息仍然走 system（不会误当玩家说话）`)

  chats.length = 0
  fake.emit('message', ...whisper('Tester', '在吗'))
  console.log(`  ${chats.length === 1 && chats[0].who === 'Tester' && chats[0].text === '在吗' ? '✅' : '❌'} 私聊（/tell）也认（未签名时同样走这条路）`)

  // 🔴 实验体报的那一种：聊天被塞进 **system 位置**，渲染成 `<<user>> …`（kind 全是 system 的那个症状）
  chats.length = 0
  const sysBefore = systems.length
  fake.emit('message', ...systemSlotChat('Tester', 'tp我，ds。'))
  console.log(`  ${chats.length === 1 && chats[0].who === 'Tester' && /ds/.test(chats[0].text) ? '✅' : '❌'} 🔴 system 位置里的玩家聊天也认（"<Tester> tp我，ds。" → chat 事件，看门狗 mention 才打得中）`)
  console.log(`  ${systems.length === sysBefore ? '✅' : '❌'} 它**不会**同时进 system 桶（分类唯一）`)
  const bare = /^<([^<>]{1,32})>/.test('<Tester> tp我，ds。')
  console.log(`  ${bare ? '✅' : '❌'} 形状判据（"<名字> 正文"）就是实验体证据里那种文本`)

  // 签名聊天（player_chat）：走另一条路，且**不会**被 message 再算一遍
  chats.length = 0
  fake._client.emit('player_chat', { networkName: { value: '<user>' }, plainMessage: '签名的这句' })
  console.log(`  ${chats.length === 1 && chats[0].text === '签名的这句' ? '✅' : '❌'} 签名聊天（player_chat）照旧`)
  fake.emit('message', { translate: 'chat.type.text', with: [{ text: '<user>' }, { text: '签名的这句' }], toString: () => '<<user>> 签名的这句' }, 'chat')
  console.log(`  ${chats.length === 1 ? '✅' : '❌'} 签名聊天在 message 里的那条被跳过（不重复投递）`)

  // 看门狗：叫法命中（含"现学自己的名字"）
  const { Watchdog } = await import('./src/watchdog.mjs')
  const wd = new Watchdog({ ctx: fakeCtx, sess: { bot: { on: () => {}, off: () => {} }, events: [], config: {} }, agent: A.agent })
  // 🔴 默认叫法必须**逐字等于**这份通用清单：多一条都不行（曾经多过两条私人名字，跟着开源副本公开了）
  const genericMentions = ['deepseek', 'deep\\s*seek', '\\bds\\b', '\\bdsh\\b', '\\bai\\b', 'agent', '机器人', '麦块']
  const dflt = JSON.stringify(wd.config.mentionPatterns)
  console.log(`  ${dflt === JSON.stringify(genericMentions) ? '✅' : '❌'} 🔴 默认叫法就是这 ${genericMentions.length} 条通用词（没有任何私人名字）：${dflt}`)
  wd.learnName('Test_Bot')
  console.log(`  ${wd.calledBy('Test_Bot 你在吗').length > 0 ? '✅' : '❌'} 连接后现学自己的游戏名 → 别人喊名字能叫醒`)
  console.log(`  ${wd.learnName('Test_Bot') === false ? '✅' : '❌'} 同一个名字不会重复加（幂等）`)
  wd.learnName('a+b(c)')
  console.log(`  ${wd.calledBy('a+b(c) 来').length > 0 ? '✅' : '❌'} 名字里的正则特殊字符被转义（不会把正则写坏）`)
}

// McBot.status 要带上**连的哪个服**（用户 2026-09-16："状态条应该显示服务器地址，太长则截断"）
console.log('\n--- status：服务器地址 ---')
{
  const { McBot } = await import('./src/core.mjs')
  const b = new McBot({ instanceId: 'sc-status-' + Math.random().toString(36).slice(2, 7) })
  b._connectionProfile = { host: 'example.com', port: 25566, version: '1.21.4', authMode: 'offline', account: '<user>' }
  const offline = b.status()
  console.log(`  ${offline.online === false && offline.connection?.host === 'example.com' && offline.connection?.port === 25566 && offline.connection?.version === '1.21.4' ? '✅' : '❌'} 离线时也给地址（host/port/version）：${JSON.stringify(offline.connection ?? null)}`)
  console.log(`  ${!/account|authMode/.test(JSON.stringify(offline.connection ?? {})) ? '✅' : '❌'} 🔴 地址里**不带账号/认证模式**（凭据绝不外流）`)
  b.bot = { entity: { position: { x: 1, y: 2, z: 3 }, yaw: 0, pitch: 0, isInWater: false }, game: {}, time: {}, players: {}, health: 20, food: 20 }
  const online = b.status()
  console.log(`  ${online.online === true && online.connection?.host === 'example.com' ? '✅' : '❌'} 在线时同样带地址（前端据此显示）`)
  const noProfile = new McBot({ instanceId: 'sc-status-null' }).status()
  console.log(`  ${noProfile.connection === null ? '✅' : '❌'} 从没连过 → connection=null（前端只显示"在游戏中"，不瞎编）`)
}

// ── 文件系统操作（mc_kit_fs / src/fsops.mjs）用户 2026-10-08 ──
console.log('\n--- 文件系统操作（mc_kit_fs）---')
{
  const fsops = await import('./src/fsops.mjs')
  const { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, symlinkSync, lstatSync, readdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const base = mkdtempSync(join(tmpdir(), 'whale-fs-'))
  const root = join(base, 'sandbox')
  mkdirSync(root, { recursive: true })
  const R = (p) => join(root, p)

  fsops.makeDir(R('a/b/c'))
  console.log(`  ${existsSync(R('a/b/c')) ? '✅' : '❌'} make_dir 递归建目录`)

  writeFileSync(R('x.txt'), 'hello\n')
  fsops.copyEntry(R('x.txt'), R('y.txt'))
  console.log(`  ${readFileSync(R('y.txt'), 'utf8') === 'hello\n' ? '✅' : '❌'} copy 单文件`)

  mkdirSync(R('dir/sub'), { recursive: true })
  writeFileSync(R('dir/sub/deep.txt'), 'deep\n')
  fsops.copyEntry(R('dir'), R('dir2'))
  console.log(`  ${readFileSync(R('dir2/sub/deep.txt'), 'utf8') === 'deep\n' ? '✅' : '❌'} copy 目录递归`)

  fsops.moveEntry(R('y.txt'), R('z.txt'))
  console.log(`  ${!existsSync(R('y.txt')) && existsSync(R('z.txt')) ? '✅' : '❌'} move（源消失、目标出现）`)

  const exp = fsops.expand(root, base, 'sandbox/dir/*')
  console.log(`  ${exp.wildcard && exp.entries.length === 1 && exp.entries[0].endsWith('sub') ? '✅' : '❌'} expand 末尾 /* 只选直接子项（${exp.entries.length} 项）`)
  const badWild = (() => { try { fsops.expand(root, base, 'sandbox/dir/su*'); return '' } catch (e) { return e.message } })()
  console.log(`  ${/通配符只能写成末尾/.test(badWild) ? '✅' : '❌'} 内嵌/末尾之外的 * 被拒`)

  for (const e of fsops.expand(root, base, 'sandbox/dir2/*').entries) fsops.removeEntry(e)
  console.log(`  ${existsSync(R('dir2')) && readdirSync(R('dir2')).length === 0 ? '✅' : '❌'} delete /* 删光子项、保留目录本身`)

  fsops.removeEntry(R('z.txt'))
  console.log(`  ${!existsSync(R('z.txt')) ? '✅' : '❌'} delete 单文件`)

  // 符号链接：需要系统创建权限（Windows 非开发者模式会 EPERM）→ 拿不到就跳过该组
  const outside = mkdtempSync(join(tmpdir(), 'whale-fs-out-'))
  writeFileSync(join(outside, 'target.txt'), 'target\n')
  let canLink = true
  try { symlinkSync(join(outside, 'target.txt'), R('link.txt')) } catch { canLink = false }
  if (canLink) {
    fsops.copyEntry(R('link.txt'), R('link2.txt'))
    console.log(`  ${lstatSync(R('link2.txt')).isSymbolicLink() ? '✅' : '❌'} 🔴 符号链接复制后仍是链接（保留、不跟随）`)
    fsops.removeEntry(R('link.txt'))
    console.log(`  ${!existsSync(R('link.txt')) && existsSync(join(outside, 'target.txt')) ? '✅' : '❌'} 🔴 删链接不动其目标`)
    try { symlinkSync(outside, R('outlink')) } catch { /* 目录链接同样可能需要权限 */ }
    if (existsSync(R('outlink'))) {
      const linkEsc = (() => { try { fsops.resolveTarget(root, base, 'sandbox/outlink/f.txt'); return '' } catch (e) { return e.message } })()
      console.log(`  ${/越界/.test(linkEsc) ? '✅' : '❌'} 🔴 顺着越界符号链接往里走被拒`)
    }
  } else {
    console.log('  ✅ 符号链接用例跳过（本机无创建权限：Windows 需开发者模式/管理员）')
  }

  const outErr = (() => { try { fsops.resolveTarget(root, base, '../outside.txt'); return '' } catch (e) { return e.message } })()
  console.log(`  ${/工作区\/记忆文件夹内|路径必须/.test(outErr) ? '✅' : '❌'} 越界路径被拒：${String(outErr).slice(0, 30)}…`)
  const dotErr = (() => { try { fsops.resolveTarget(root, base, 'a/.'); return '' } catch (e) { return e.message } })()
  console.log(`  ${/\/\./.test(dotErr) ? '✅' : '❌'} 末尾 "/." 被拒`)

  writeFileSync(R('RULES.md'), 'x')
  console.log(`  ${fsops.forbiddenReason(root, R('RULES.md')) ? '✅' : '❌'} 受保护文件（根级 RULES.md）不可删改`)
  mkdirSync(R('_global'), { recursive: true })
  writeFileSync(R('_global/config.json'), '{}')
  console.log(`  ${fsops.forbiddenReason(root, R('_global/config.json')) === null ? '✅' : '❌'} 嵌套的 _global/config.json 不误伤`)
  console.log(`  ${fsops.forbiddenReason(root, R('secrets/x.md')) && fsops.forbiddenReason(root, R('.credentials.yaml')) ? '✅' : '❌'} 凭据 / secrets 路径不可删改`)
  console.log(`  ${fsops.forbiddenReason(root, root) ? '✅' : '❌'} 不能删根目录本身`)
  console.log(`  ${fsops.rootReason(root, [root, base]) ? '✅' : '❌'} rootReason 认出沙箱根/工作区根`)

  // 工具层：走真实注册（非 MC → 沙箱=工作区）
  const tool = tools.get('mc_kit_fs')
  const ex = { agent: { id: 'sess-FS', session: { header: { cwd: base } } } }
  await tool.execute({ action: 'make_dir', path: 'ws/notes' }, ex)
  writeFileSync(join(base, 'ws', 'notes', 'a.md'), 'hi\n')
  await tool.execute({ action: 'copy', from: 'ws/notes/a.md', to: 'ws/notes/b.md' }, ex)
  console.log(`  ${readFileSync(join(base, 'ws', 'notes', 'b.md'), 'utf8') === 'hi\n' ? '✅' : '❌'} 工具层 copy（相对工作区根）`)
  const delOut = await tool.execute({ action: 'delete', path: 'E:\\definitely\\outside' }, ex).then(() => null).catch((e) => e.message)
  console.log(`  ${/工作区|路径必须/.test(String(delOut)) ? '✅' : '❌'} 工具层：工作区之外拒删`)
  writeFileSync(join(base, 'RULES.md'), 'x')
  const delProt = await tool.execute({ action: 'delete', path: 'RULES.md' }, ex).then(() => null).catch((e) => e.message)
  console.log(`  ${/不可删改/.test(String(delProt)) ? '✅' : '❌'} 工具层：受保护文件拒删`)

  // to 以分隔符结尾 → 放进目录（修复 "copy x.md → dir/ 得到文件 dir"）
  await tool.execute({ action: 'make_dir', path: 'into' }, ex)
  await tool.execute({ action: 'copy', from: 'ws/notes/a.md', to: 'into/' }, ex)
  console.log(`  ${existsSync(join(base, 'into', 'a.md')) ? '✅' : '❌'} 🔴 to 以 "/" 结尾 → 放进该目录（into/a.md），不是造个叫 into 的文件`)

  // from 目录 / to 目录：不带分隔符 → 结果就是 to 本身；带分隔符 → to/from
  await tool.execute({ action: 'make_dir', path: 'srcDir' }, ex)
  writeFileSync(join(base, 'srcDir', 'f.txt'), 'f\n')
  await tool.execute({ action: 'copy', from: 'srcDir', to: 'dstDir' }, ex)          // dstDir 不存在
  console.log(`  ${existsSync(join(base, 'dstDir', 'f.txt')) && !existsSync(join(base, 'dstDir', 'srcDir')) ? '✅' : '❌'} 🔴 from 目录 / to 目录（不带分隔符）→ 结果**就是 to 本身**（dstDir/f.txt）`)
  await tool.execute({ action: 'copy', from: 'srcDir', to: 'dstDir2/' }, ex)         // 带分隔符 → to/from
  console.log(`  ${existsSync(join(base, 'dstDir2', 'srcDir', 'f.txt')) ? '✅' : '❌'} 🔴 from 目录 / to 目录/（带分隔符）→ to/from（dstDir2/srcDir/f.txt）`)

  // 「完成 N 个目标」口径写明：N = 直接选中目标数，不含目录内部条目
  const r1 = await tool.execute({ action: 'copy', from: 'srcDir', to: 'dstDir3' }, ex)
  console.log(`  ${/完成 1 个目标/.test(String(r1?.text)) && /内部/.test(String(r1?.text)) ? '✅' : '❌'} 🔴 「完成 N 个目标」口径写明（N=直接选中目标数，目录内部条目不计入）：${JSON.stringify(String(r1?.text).split('\n')[0])}`)

  // move 自动建目标父目录（修复"move 没有自动建目录"）
  await tool.execute({ action: 'move', from: 'into/a.md', to: 'deep/nest/a.md' }, ex)
  console.log(`  ${existsSync(join(base, 'deep', 'nest', 'a.md')) && !existsSync(join(base, 'into', 'a.md')) ? '✅' : '❌'} 🔴 move 自动创建目标父目录`)

  // overwrite：默认不覆盖；true 才覆盖
  writeFileSync(join(base, 'ws', 'notes', 'b.md'), 'CHANGED\n')
  const noOv = await tool.execute({ action: 'copy', from: 'ws/notes/a.md', to: 'ws/notes/b.md' }, ex).then(() => null).catch((e) => e.message)
  console.log(`  ${/目标已存在|overwrite/.test(String(noOv)) && readFileSync(join(base, 'ws', 'notes', 'b.md'), 'utf8') === 'CHANGED\n' ? '✅' : '❌'} 🔴 overwrite 默认 false：目标已存在 → 报错且**不改动**`)
  await tool.execute({ action: 'copy', from: 'ws/notes/a.md', to: 'ws/notes/b.md', overwrite: true }, ex)
  console.log(`  ${readFileSync(join(base, 'ws', 'notes', 'b.md'), 'utf8') === 'hi\n' ? '✅' : '❌'} overwrite:true 才覆盖`)

  // 失败零副作用：from 通配 + 其中一个目标已存在（未开 overwrite）→ 一个都不复制
  await tool.execute({ action: 'make_dir', path: 'many' }, ex)
  await tool.execute({ action: 'make_dir', path: 'manyOut' }, ex)
  writeFileSync(join(base, 'many', 'p.txt'), 'p\n'); writeFileSync(join(base, 'many', 'q.txt'), 'q\n')
  writeFileSync(join(base, 'manyOut', 'p.txt'), 'old\n')          // 与源 p.txt 同名 → 冲突
  const noSide = await tool.execute({ action: 'copy', from: 'many/*', to: 'manyOut/' }, ex).then(() => null).catch((e) => e.message)
  console.log(`  ${noSide && readFileSync(join(base, 'manyOut', 'p.txt'), 'utf8') === 'old\n' && !existsSync(join(base, 'manyOut', 'q.txt')) ? '✅' : '❌'} 🔴 预检失败 → 零副作用（q.txt 没被拷进去）`)

  // delete 不存在路径 → 友好中文（不是原始 ENOENT）
  const delNo = await tool.execute({ action: 'delete', path: 'nope/nothing.txt' }, ex).then(() => null).catch((e) => e.message)
  console.log(`  ${/不存在/.test(String(delNo)) && !/ENOENT/.test(String(delNo)) ? '✅' : '❌'} delete 不存在 → 友好中文、不透 ENOENT：${String(delNo).slice(0, 24)}…`)

  // make_dir 含 * → 明确报错（不是字面量建目录）
  const mkStar = await tool.execute({ action: 'make_dir', path: 'a/b*' }, ex).then(() => null).catch((e) => e.message)
  console.log(`  ${/不支持通配符/.test(String(mkStar)) && !existsSync(join(base, 'a', 'b*')) ? '✅' : '❌'} make_dir 含 * → 明确报错、不按字面量建`)

  // to 含 * → 明确报错
  const toStar = await tool.execute({ action: 'copy', from: 'ws/notes/a.md', to: 'out/*' }, ex).then(() => null).catch((e) => e.message)
  console.log(`  ${/to 不支持通配符/.test(String(toStar)) ? '✅' : '❌'} to 含 * → 明确报错（不是难懂的报错）`)

  // from 通配但没有末尾分隔符的 to → 明确报错
  const wildBadTo = await tool.execute({ action: 'copy', from: 'many/*', to: 'manyOutX' }, ex).then(() => null).catch((e) => e.message)
  console.log(`  ${/必须以路径分隔符结尾/.test(String(wildBadTo)) ? '✅' : '❌'} from 通配 + to 不以分隔符结尾 → 明确报错`)

  // 大小写不敏感（Windows）
  if (process.platform === 'win32') {
    const ci = await tool.execute({ action: 'delete', path: 'RULES.MD' }, ex).then(() => null).catch((e) => e.message)
    console.log(`  ${/不可删改/.test(String(ci)) ? '✅' : '❌'} 🔴 守卫/保护大小写不敏感（RULES.MD 也挡住）`)
  }
}

// ── 记忆（需求 6 v3）：固定 .whale-craft + AI 维护的 README 索引 + 任意格式 ──
console.log('\n--- 记忆能力（.whale-craft / README 索引 / 任意格式）---')
{
  const { MemoryStore } = await import('./src/memory.mjs')
  const { mkdtempSync, readFileSync, existsSync, readdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = join(mkdtempSync(join(tmpdir(), 'whale-mem-')), '.whale-craft')
  const mem = new MemoryStore(root)

  console.log(`  ${mem.list().length === 0 ? '✅' : '❌'} 新库为空（README 不算记忆条目）`)
  mem.ensureReadme()
  console.log(`  ${/由 AI 维护/.test(readFileSync(mem.readmePath, 'utf8')) ? '✅' : '❌'} README.md 骨架就位（写明由 AI 维护索引）`)

  // 通用（不给 server）→ _global/；指定服务器 → 独立文件夹
  mem.append({ topic: 'owner', text: '用户在游戏里叫 <user>' })
  mem.append({ topic: 'landmarks', server: 'mc.example.com', text: '出生点 (12,70,-4)' })
  mem.append({ topic: 'landmarks', server: 'mc.example.com', text: '某人的房子 (100,64,100)' })
  mem.append({ topic: 'notes', server: 'ih.example.com', text: 'ih 是生存服' })

  const dirs = readdirSync(root)
  const hasGlobal = dirs.includes('_global')
  const hasmc = dirs.includes('mc.example.com')
  const hasIh = dirs.includes('ih.example.com')
  console.log(`  ${hasGlobal && hasmc && hasIh ? '✅' : '❌'} 按服务器分独立文件夹：${dirs.join(' / ')}`)
  console.log(`  ${existsSync(join(root, 'mc.example.com', 'landmarks.md')) ? '✅' : '❌'} 文件落在对应服文件夹里`)

  // 同 key 覆盖（不堆积）
  mem.append({ topic: 'owner', text: '用户在游戏里叫 <user>（服主）', key: '名字' })
  const dup = mem.list().filter((f) => f.rel === '_global/owner.md')
  console.log(`  ${dup.length === 1 && dup[0].entries === 2 ? '✅' : '❌'} append 同 key 覆盖、不堆积（owner.md 仍 1 个文件 / ${dup[0]?.entries} 条）`)

  // 查：读；改：整文件覆盖
  const r = mem.read({ path: 'mc.example.com/landmarks.md' })
  console.log(`  ${/出生点/.test(r.content) && r.kind === 'text' ? '✅' : '❌'} read 返回文本内容`)
  try { mem.read({ path: 'mc.example.com/nope.md' }); console.log('  ❌ 读不存在的竟然成功') }
  catch (e) { console.log(`  ${/现有文件/.test(e.message) ? '✅' : '❌'} 读不存在的报错并列出已有文件`) }
  mem.write({ path: 'mc.example.com/landmarks.md', content: '# mc 地标\n\n## 出生点\n- (12,70,-4)\n\n## 建筑\n- 某人的房子 (100,64,100)\n' })
  console.log(`  ${/## 出生点/.test(mem.read({ path: 'mc.example.com/landmarks.md' }).content) ? '✅' : '❌'} write 整文件覆盖（可写小标题）`)

  // 🆕 任意格式：不再是"只收 md"
  mem.write({ path: 'mc.example.com/coords.json', content: '{"spawn":[12,70,-4]}' })
  mem.write({ path: 'mc.example.com/notes.txt', content: '随便一段纯文本' })
  const j = mem.read({ path: 'mc.example.com/coords.json' })
  const t2 = mem.read({ path: 'mc.example.com/notes.txt' })
  console.log(`  ${j.kind === 'text' && /spawn/.test(j.content) && t2.kind === 'text' ? '✅' : '❌'} 任意格式读写（.json / .txt 都行）`)

  // 🆕 图片/任意文件：put 进来 + read 出去
  const { encodePng } = await import('./src/png.mjs')
  const src = join(root, 'src.png')
  writeFileSync(src, encodePng(16, 16, new Uint8Array(16 * 16 * 4).fill(180)))
  const put = mem.put({ source: src, path: 'mc.example.com/maps/地标塔.png' })
  console.log(`  ${/maps\/地标塔\.png/.test(put.saved) && put.kind === 'image' ? '✅' : '❌'} put 把文件存进记忆（任意子目录）：${put.saved}`)
  const rd = mem.read({ path: put.saved })
  console.log(`  ${rd.kind === 'image' && rd.mediaType === 'image/png' && rd.bytes > 0 ? '✅' : '❌'} read 图片返回 image + mediaType（工具层做附件 → 模型能直接看到）`)

  // 🆕 二进制嗅探：不认识的扩展名也不当文本读
  writeFileSync(join(root, 'mc.example.com', 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 9]))
  console.log(`  ${mem.read({ path: 'mc.example.com/blob.bin' }).kind === 'binary' ? '✅' : '❌'} 二进制文件识别为 binary`)

  // 路径安全：穿越/绝对路径仍全拒（非 md 现在**允许**，这是行为变更）
  const bad = [
    ['../../etc/passwd', '上级穿越'],
    ['/abs/path.md', '绝对路径'],
    ['mc.example.com/../secret.md', '中间穿越'],
    ['a/b/c/d/e/f.md', '太深'],
  ]
  const escaped = bad.filter(([p]) => { try { mem.safePath(p); return true } catch { return false } })
  console.log(`  ${escaped.length === 0 ? '✅' : '❌'} 路径锁死在 .whale-craft 内（${bad.length} 个用例全被拒）`)
  console.log(`  ${mem.safePath('mc.example.com/地标.md').rel === 'mc.example.com/地标.md' ? '✅' : '❌'} 中文文件名可用`)

  // 注入文本 = README（AI 维护）+ 自动目录树
  mem.write({ path: 'README.md', content: '# 麦块记忆索引（自检）\n\n- 通用：_global/owner.md\n' })
  const idxText = mem.indexText()
  console.log(`  ${/麦块记忆索引/.test(idxText) && /coords\.json/.test(idxText) ? '✅' : '❌'} 注入文本 = README 正文 + 自动目录树（${idxText.length} 字）`)
  console.log(`  ${/动手前先读|自动生成/.test(idxText) ? '✅' : '❌'} 目录树带"自动生成、永远准"的说明`)

  // 搜（只搜文本）+ 删（文件 / 目录）
  const s = mem.search({ query: '某人的房子' })
  console.log(`  ${s.matched >= 1 && s.hits[0].path === 'mc.example.com/landmarks.md' ? '✅' : '❌'} search 跨文本文件命中并给出文件+行号`)
  mem.delete({ path: 'ih.example.com/notes.md' })
  console.log(`  ${!existsSync(join(root, 'ih.example.com', 'notes.md')) ? '✅' : '❌'} delete 删文件（服务器文件夹保留）`)
  mem.delete({ path: 'mc.example.com/maps' })
  console.log(`  ${!existsSync(join(root, 'mc.example.com', 'maps')) ? '✅' : '❌'} delete 可整目录删`)

}

// ── 图像地图（需求 7）──
console.log('\n--- 图像地图 ---')
{
  const { encodePng } = await import('./src/png.mjs')
  const w = 8, h = 6
  const rgba = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = 100; rgba[i * 4 + 1] = 150; rgba[i * 4 + 2] = 200; rgba[i * 4 + 3] = 255
  }
  const png = encodePng(w, h, rgba)
  const sigOk = png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  console.log(`  ${sigOk ? '✅' : '❌'} PNG 签名正确（${png.length} 字节，${w}x${h}）`)

  // IHDR 里的宽高要和我们给的一致
  const ihdrW = png.readUInt32BE(16), ihdrH = png.readUInt32BE(20)
  console.log(`  ${ihdrW === w && ihdrH === h ? '✅' : '❌'} IHDR 尺寸正确 ${ihdrW}x${ihdrH}`)
  console.log(`  ${png.includes(Buffer.from('IEND')) ? '✅' : '❌'} 含 IEND 块（结构完整）`)

  // 尺寸非法要拒
  try { encodePng(0, 5, new Uint8Array(0)); console.log('  ❌ 非法尺寸竟然通过') }
  catch { console.log('  ✅ 非法尺寸被拒') }

  // mc_map 参数面（2026-10-05 改版：+reply/dist，-out/both）
  const mp = Object.keys(tools.get('mc_map').parameters?.properties ?? {})
  console.log(`  ${['format', 'scale', 'reply', 'dist'].every((k) => mp.includes(k)) && !mp.includes('out') ? '✅' : '❌'} mc_map 支持 format/scale/reply/dist（无 out）：${mp.join(', ')}`)
  // output.render 必须能产出 image 块
  const blocks = tools.get('mc_map').output.render({}, { text: 'x', image: { attachment: { attachmentId: 'a' } } })
  console.log(`  ${Array.isArray(blocks) && blocks.some((b) => b.type === 'image') ? '✅' : '❌'} mc_map 能返回 image 内容块（宿主对纯文本模型会自动降级）`)

  // mc_height：新工具（高度/地势图）
  const hp = Object.keys(tools.get('mc_height').parameters?.properties ?? {})
  console.log(`  ${tools.has('mc_height') && ['radius', 'glyphStep', 'startY', 'ignoreLiquid', 'format', 'scale', 'reply', 'dist'].every((k) => hp.includes(k)) ? '✅' : '❌'} mc_height 就位（${hp.join(', ')}）`)
}

// ── 扩展点（需求 6 的另一半）──
console.log('\n--- 扩展点 ---')
{
  const { existsSync, readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const dir = fileURLToPath(new URL('./extensions/', import.meta.url))
  console.log(`  ${existsSync(dir) ? '✅' : '❌'} extensions/ 目录存在`)
  console.log(`  ${existsSync(dir + 'README.md') ? '✅' : '❌'} 扩展文档存在（其他 Agent 照它写）`)
  const tpl = readFileSync(dir + 'example.mjs.example', 'utf8')
  console.log(`  ${/export async function apply/.test(tpl) ? '✅' : '❌'} 模板符合契约（导出 apply(api)）`)
  const api = ['asTool', 'getSession', 'registry', 'memory', 'logLine']
  const missing = api.filter((k) => !tpl.includes(k) && !tpl.includes('api.'))
  console.log(`  ${missing.length ? '⚠️ ' : '✅'} 模板演示了关键 api（缺失项即使未演示也不影响加载）`)
}

// ── 归档保护（用户补充要求：归档前自动强行停止）──
console.log('\n--- 归档保护 ---')
{
  // 前置：给 sess-A 挂上看门狗
  await tools.get('mc_watch').execute({ action: 'arm' }, A)
  const armed = (await tools.get('mc_watch').execute({}, A)).armed

  // ① 无 MC 的会话：必须原样放行（不能把普通归档搞坏）
  await fakeCtx.workspaceRegistry.archiveSession('plain-session')
  console.log(`  ${archivedSessions.includes('plain-session') ? '✅' : '❌'} 无 MC 的会话正常放行归档`)

  // ② 有 MC（看门狗挂着）的会话：包装后的实现应先停掉再放行
  await fakeCtx.workspaceRegistry.archiveSession('sess-A')
  const armedAfter = (await tools.get('mc_watch').execute({}, A)).armed
  console.log(`  ${armed === true ? '✅' : '❌'} 前置条件：归档前看门狗挂着`)
  console.log(`  ${armedAfter === false ? '✅' : '❌'} 归档时看门狗被自动关闭（armed: ${armed} → ${armedAfter}）`)
  console.log(`  ${archivedSessions.includes('sess-A') ? '✅' : '❌'} 停止之后仍放行归档（选了"先停止"而非"阻止"）`)

  // ③ 原方法必须被调用（不是被我们吞掉）
  const calls = archivedSessions.filter((x) => x === 'sess-A').length
  console.log(`  ${calls === 1 ? '✅' : '❌'} 原 archiveSession 恰好被调用一次（未被吞/未重复）`)

  // ④ 回归：`apply()` 时 workspaceRegistry **还没就绪**（远端服务晚启动）——
  //    必须走 ctx.inject 等它就绪，而不是静默放弃。
  //    这是隔离实例实测抓到的真 bug（第一版直接 ctx.get 拿到 undefined 就放弃了）。
  {
    const mod3 = await import('./index.js')
    const pending = []
    const lateArchived = []
    let installRan = false
    const ctx3 = {
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
      tools: { register: () => {} },
      webServer: { register: () => () => {} },
      effect: (fn) => { try { fn() } catch {} },
      set: () => {}, on: () => {},
      // 初次 get 拿不到（模拟服务未就绪）
      get: (k) => (k === 'workspaceRegistry' || k === 'jobs' || k === 'sessionController' || k === 'attachments'
        ? undefined : ctx3[k]),
      inject: (deps, cb) => { pending.push({ deps, cb }) },
      logger2: null,
    }
    mod3.apply(ctx3, mod3.Config ? mod3.Config({}) : {})
    const registered = pending.some((p) => p.deps.includes('workspaceRegistry'))
    console.log(`  ${registered ? '✅' : '❌'} 服务未就绪时登记了 ctx.inject(['workspaceRegistry'])`)

    // 服务就绪 → 回调触发 → 应装上包装
    const scope = {
      get: () => ({ archiveSession: async (sid) => { lateArchived.push(String(sid)) } }),
      effect: (fn) => { try { fn() } catch {} },
      logger: { info: () => {} },
    }
    for (const p of pending) { if (p.deps.includes('workspaceRegistry')) { p.cb(scope); installRan = true } }
    const wrapped = typeof (await scope.get()).archiveSession === 'function'
    await scope.get().archiveSession('late-session')
    console.log(`  ${installRan && wrapped && lateArchived.includes('late-session') ? '✅' : '❌'} 服务迟到时归档保护仍能装上并放行`)
  }
}

// ── 提示词注入**只有一条通道**（用户 2026-09-16："系统提示词不用显式注入，设置好了会自动注入"）──
console.log('\n--- 提示词注入通道（插件提示行，不再碰 systemPrompt）---')
{
  const { readFileSync } = await import('node:fs')
  const idx = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  // ① 一句话：**不再往 systemPrompt 里塞任何东西**（那既冗余，又会被 persona 的
  //    complete / includeRuntimeContext 压掉 —— 2026-09-16 真机"设置页正常、AI 什么都没收到"）。
  const spFiber = injectedFibers.find((f) => f.deps.includes('systemPrompt'))
  console.log(`  ${!spFiber ? '✅' : '❌'} 不再 ctx.inject(['systemPrompt'])（系统提示词由 preset 交给宿主自动注入）`)
  console.log(`  ${injectedContexts.length === 0 ? '✅' : '❌'} 一个 systemPrompt.context() 段都没注册（${injectedContexts.length} 段）`)
  console.log(`  ${!/systemPrompt\.(context|section)\(/.test(idx) ? '✅' : '❌'} 源码里也搜不到任何 systemPrompt 段注册`)
  console.log(`  ${!/installAgentPrompts|whale_craft:memory-index|whale_craft:mode-guidance|MC_MODE_GUIDANCE/.test(idx) ? '✅' : '❌'} 旧的 installAgentPrompts / 记忆索引段 / 模式指导段 已整段删除`)
  // ② 🔴 2026-10-07：记忆索引的自动注入**也删了**（连 mc_kit_memory 一起移除后，用户要求去掉索引注入）
  console.log(`  ${!/memoryIndexText/.test(idx) && !/rel: '\.whale-craft\/README\.md'/.test(idx) ? '✅' : '❌'} 🔴 记忆索引（.whale-craft/README.md）**不再自动注入**（memoryIndexText 已删）`)
  console.log(`  ${/const noticeLedger = new WeakMap\(\)/.test(idx) && /const reconcileNotices = \(agent\)/.test(idx) ? '✅' : '❌'} 记下**实际投出去**的文件（投递台账 noticeLedger + reconcileNotices；状态页据此报真实投递，不是"打算投"）`)
  // ③ persona：MC 模式人设（与 presets/minecraft.patch.yml 的 persona.prefix 逐字一致）
  const persona = '你是一个 Minecraft Java 版游戏助理，由模型 {{model}} 驱动。你可以通过工具调用，使用无头机器人进入 MC 服务器中与世界和玩家互动。你应当专注于 MC 游戏，不过问交互原理和插件代码，除非收到明确调试指令。'
  const m = idx.match(/const MC_PERSONA_TEXT = '([^']*)'/)
  console.log(`  ${m?.[1] === persona ? '✅' : '❌'} 🔴 MC_PERSONA_TEXT 与 MC 模式 preset 的 persona 逐字一致${m?.[1] === persona ? '' : `（实际：${JSON.stringify(m?.[1] ?? null)}）`}`)
}

// ── 全局配置 + 管理工具 + MC 模式权限隔离（用户 2026-09-16 要求）──
console.log('\n--- 全局配置 / mc_admin_config / MC 模式隔离 ---')
{
  // 先让 agentPresets 的 inject 回调跑起来（插件靠它判断"是不是 MC 模式"）
  const apFiber = injectedFibers.find((f) => f.deps.includes('agentPresets'))
  console.log(`  ${apFiber ? '✅' : '❌'} 通过 ctx.inject(['agentPresets']) 等宿主服务就绪`)
  if (apFiber) {
    apFiber.cb({
      get: (k) => (k === 'agentPresets' ? fakeCtx.agentPresets : undefined),
      effect: (fn) => { try { fn() } catch {} },
      logger: fakeCtx.logger,
    })
  }

  // ① 配置存储本身
  const { PluginConfig, pickPresetTarget, pickPresetSource, isCopiedPresetDescription } = await import('./src/config.mjs')

  /* 🔴 2026-09-16 用户定：**没有 MC 模式 preset 就自动建一个**。
   * 起因：preset 属于用户的 $DSH_HOME/.agent-presets/，插件不塞目录 → 新机器上没人建过
   * → mcModePresets 一个都匹配不上 → "装了插件也没有 MC模式"。
   * 做法只能用宿主官方接口 `agentPresets.copy(源, 新id, 显示名)`
   * （官方 authoring 明令"只允许整目录复制已有 preset，调用方不得提供 composition 文本"）。 */
  await new Promise((r) => setTimeout(r, 0))          // ensureMcPresetIfMissing 是 async
  const cp = presetCopyCalls[0]
  console.log(`  ${cp?.[0] === 'minimal' && cp?.[1] === 'minecraft' && cp?.[2] === 'MC模式' ? '✅' : '❌'} 没有 MC 模式 preset → 自动建：复制 minimal → id=minecraft，名字「MC模式」（${JSON.stringify(presetCopyCalls)}）`)
  if (apFiber) {
    // 再触发一次：必须**不会**重复建（一次性）
    apFiber.cb({ get: (k) => (k === 'agentPresets' ? fakeCtx.agentPresets : undefined), effect: (fn) => { try { fn() } catch {} } })
    await new Promise((r) => setTimeout(r, 0))
  }
  console.log(`  ${presetCopyCalls.length === 1 ? '✅' : '❌'} 只建一次（重复触发不再复制）`)
  /* 🔴 2026-09-24：`ensureToolGroupsInPreset()` 会动**用户自己写的** composition
   *    （本机那份 `minecraft` 就是用户手写的），所以：
   *      ① 动之前必须留一份**原始副本**（`agent.cordis.yml.bak-whale-craft`，只留第一次那份）；
   *      ② 隔离实例里**一律不写**（`WHALE_CRAFT_NO_PRESET_WRITE`）—— 隔离实例的 preset 根
   *         与生产**共用**（`~/.dsh/.agent-presets` redirect 不了），写下去就是改生产文件。
   *         2026-09-24 实测踩到：隔离实例第一次跑就把压缩组加进了用户手写的那份。
   *    ⚠️ 上面那条自动建的路一辈子只跑一次（`presetEnsureTried`），所以这里**另起一棵树**：
   *    预先放一份"手写的 minecraft"（缺两组、没有自建标记），看插件会不会补、有没有留备份。 */
  {
    const fs = await import('node:fs')
    const { tmpdir: td3 } = await import('node:os')
    const { join: jn3 } = await import('node:path')
    const HANDWRITTEN = [
      '# 用户手写的 preset',
      '- id: persona',
      "  name: '@deepseek-ai/dsh-persona'",
      '  config:',
      '    prefix: |',
      '      手写的人设',
      '',
      '- id: tool-fs',
      "  name: '@deepseek-ai/dsh-tool-fs'",
      '',
    ].join('\n')

    /** 起第三棵树：预置一份手写 preset（root 里只有它），返回 apply 后的那套东西 */
    const bootWithHandwritten = async () => {
      const root = fs.mkdtempSync(jn3(td3(), 'whale-handwritten-'))
      const dir = jn3(root, 'minecraft')
      fs.mkdirSync(dir, { recursive: true })
      const compPath = jn3(dir, 'agent.cordis.yml')
      fs.writeFileSync(compPath, HANDWRITTEN, 'utf8')
      fs.writeFileSync(jn3(dir, 'preset.yml'), 'name: MC模式\ndescription: "手写的"\n', 'utf8')
      const fibers = []
      const tools3 = new Map()
      const svc3 = {
        composedPreset: () => undefined,
        authorable: true,
        defaultId: 'standard',
        roots: [{ path: shippedRoot, trust: 'shipped' }, { path: root, trust: 'user' }],
        list: async () => [{ id: 'minecraft', trust: 'user', path: compPath, description: '手写的' }],
        read: async () => fs.readFileSync(compPath, 'utf8'),
        copy: async () => { throw new Error('手写的那份已存在 → 不该走到复制') },
      }
      const ctx3 = {
        logger: { info: () => {}, warn: () => {}, debug: () => {} },
        tools: { register: (d) => { tools3.set(d.name, d); return () => {} }, guard: () => () => {} },
        webServer: { register: () => () => {}, port: 39998 },
        workspaceRegistry: { archiveSession: async () => {} },
        systemPrompt: { context: () => () => {}, section: () => () => {} },
        inject: (deps, cb) => { fibers.push({ deps, cb }) },
        effect: (fn) => { try { fn() } catch {} },
        on: () => () => {},
        get: (k) => (k === 'agentPresets' ? svc3 : undefined),
      }
      mod.apply(ctx3, mod.Config ? mod.Config({}) : {})
      const f = fibers.find((x) => x.deps.includes('agentPresets'))
      if (f) f.cb({ get: (k) => (k === 'agentPresets' ? svc3 : undefined), effect: (fn) => { try { fn() } catch {} }, logger: ctx3.logger })
      await new Promise((r) => setTimeout(r, 0))
      return { compPath, bakPath: `${compPath}.bak-whale-craft` }
    }

    // ① 正常启动：补组 + 留原始副本
    const one = await bootWithHandwritten()
    const after = fs.readFileSync(one.compPath, 'utf8')
    console.log(`  ${/dsh-tool-jobs/.test(after) && /dsh-compaction-basic/.test(after) ? '✅' : '❌'} 🔴 用户手写的 preset 缺组 → 补上（本机那份手写 preset 就是这条路）`)
    console.log(`  ${/用户手写的 preset/.test(after) && /手写的人设/.test(after) && /dsh-tool-fs/.test(after) ? '✅' : '❌'} 手写的内容一个字节没动（只在末尾追加缺的组）`)
    console.log(`  ${fs.existsSync(one.bakPath) && fs.readFileSync(one.bakPath, 'utf8') === HANDWRITTEN ? '✅' : '❌'} 🔴 动它之前留了**原始副本**（agent.cordis.yml.bak-whale-craft，只留第一次那份）`)

    // ② 隔离模式：一个字都不写
    process.env.WHALE_CRAFT_NO_PRESET_WRITE = '1'
    let two
    try { two = await bootWithHandwritten() } finally { delete process.env.WHALE_CRAFT_NO_PRESET_WRITE }
    console.log(`  ${fs.readFileSync(two.compPath, 'utf8') === HANDWRITTEN && !fs.existsSync(two.bakPath) ? '✅' : '❌'} 🔴 隔离模式（WHALE_CRAFT_NO_PRESET_WRITE）下**不写** preset（隔离实例与生产共用 preset 根）`)
  }
  // 🔴 用户 2026-09-16 报的 bug："MC 模式的简介变成了和极简模式一样" ——
  //    官方 copy() **只改 name、保留源 description**，所以复制完必须把 preset.yml 改回来。
  const presetMetaFile = jnTop(presetUserRoot, 'minecraft', 'preset.yml')
  const presetMeta = exTop(presetMetaFile) ? rfTop(presetMetaFile, 'utf8') : ''
  console.log(`  ${/name: "MC模式"/.test(presetMeta) ? '✅' : '❌'} 建出来的 preset 显示名 = MC模式`)
  console.log(`  ${/可以加入Minecraft Java版服务器/.test(presetMeta) ? '✅' : '❌'} 🔴 简介改回自己的（不再是"极简模式"那句）：${JSON.stringify((presetMeta.split('\n').find((l) => l.startsWith('description')) ?? '').slice(0, 60))}`)
  console.log(`  ${!/极简/.test(presetMeta) ? '✅' : '❌'} 简介里没有残留极简模式的文案`)
  // 🔴 用户 2026-09-16："默认系统提示词居然是 'You are a helpful software engineer assistant.'，太离谱了"
  //    —— 那句来自复制的 minimal，必须换成我们自己的；顺带把 minimal 的 `complete: true` 和 shell 处理掉
  {
    const compFile = presetPaths.get('minecraft')
    const comp = compFile && exTop(compFile) ? rfTop(compFile, 'utf8') : ''
    console.log(`  ${/Minecraft Java 版游戏助理/.test(comp) ? '✅' : '❌'} persona 换成我们自己的（MC 游戏助理）`)
    console.log(`  ${!/helpful software engineer assistant/.test(comp) ? '✅' : '❌'} 🔴 官方那句"软件助手"已不存在`)
    console.log(`  ${!/complete: true/.test(comp) && !/includeRuntimeContext: false/.test(comp) ? '✅' : '❌'} minimal 的 complete / includeRuntimeContext 已去掉（否则会压掉其它 section）`)
    console.log(`  ${/^-\s+id:\s*persistent-shell[\s\S]{0,120}disabled: true/m.test(comp) ? '✅' : '❌'} 🔴 持久 shell 已关掉（与"本模式没有 shell"的指导一致）`)
    console.log(`  ${/id: pty/.test(comp) ? '✅' : '❌'} 其余结构原样保留（pty 组还在，只是被 disabled）`)
    // 🔴 2026-09-24（GitHub issue #1）**端到端**：自动建出来的 preset 必须**真的**带上那几组。
    //    这条在旧代码上必挂 —— 探针同步迭代 `async list()` → TypeError 被 catch 吞掉
    //    → 每一组都被判成"本部署没人引用" → 这里一个包都找不到。
    console.log(`  ${/dsh-tool-fs/.test(comp) && /dsh-tool-jobs/.test(comp) && /dsh-tool-fs-search/.test(comp) && !/dsh-tool-present/.test(comp) ? '✅' : '❌'} 🔴 端到端：自动建的 preset 里补上了 tool-fs / tool-fs-search / tool-jobs，且**不含** present`)
    console.log(`  ${/dsh-compaction-basic/.test(comp) && /dsh-command-compact/.test(comp) && /dsh-compaction-tool-result-pruner/.test(comp) ? '✅' : '❌'} 🔴 端到端：压缩组也真的补上了（缺它 = 没有 /compact、也没有自动压缩）`)
    console.log(`  ${/^- id: compaction\n  name: cordis:group\n  group: true\n  isolate:\n    compaction: true\n    toolResultPruner: true\n/m.test(comp) ? '✅' : '❌'} 压缩组是整组（不是只加一个 command-compact）`)
  }
  // 纯函数：结构不认识时要返回 null（宁可不改也不写坏 composition）
  {
    const C = await import('./src/config.mjs')
    console.log(`  ${C.patchPersonaInComposition('# 没有 persona 行\n', 'x') === null ? '✅' : '❌'} 没有 persona 行 → 返回 null（不瞎改）`)

    /* 🔴 2026-09-17 真机事故：persona 的**正文键名跨版本不同**（新版 `prefix` / 老版 `text`），
     *    我们曾写死 `prefix` ⇒ 老环境自动建的 preset 加载失败（`$text missing required value`）
     *    → MC 模式直接切不进去。现在的规矩：**键名跟着源 preset**、只改值、不加键不删键。 */
    const OLD_MINIMAL = ['# old minimal', '- id: persona', "  name: '@deepseek-ai/dsh-persona'", '  config:', '    text: |', '      You are a helpful software engineer assistant.', ''].join('\n')
    const NEW_MINIMAL = ['# new minimal', '- id: persona', "  name: '@deepseek-ai/dsh-persona'", '  config:', '    prefix: You are a helpful software engineer assistant.', '    suffix: Your working directory is {{cwd}}.', '    complete: true', '    includeRuntimeContext: false', ''].join('\n')
    console.log(`  ${C.personaTextKeyOf(OLD_MINIMAL) === 'text' && C.personaTextKeyOf(NEW_MINIMAL) === 'prefix' ? '✅' : '❌'} 🔴 认得出两种版本的键名：老版 text / 新版 prefix`)
    const pOld = C.patchPersonaInComposition(OLD_MINIMAL, 'MC 人设', { key: C.personaTextKeyOf(OLD_MINIMAL) })
    const pNew = C.patchPersonaInComposition(NEW_MINIMAL, 'MC 人设', { key: C.personaTextKeyOf(NEW_MINIMAL) })
    console.log(`  ${/^\s+text: \|-$/m.test(pOld ?? '') && /MC 人设/.test(pOld ?? '') && !/prefix:/.test(pOld ?? '') ? '✅' : '❌'} 🔴 老版（text）：用 text 写正文，**不塞 prefix**`)
    console.log(`  ${!/complete|includeRuntimeContext/.test(pOld ?? '') ? '✅' : '❌'} 老版 schema 里没有的键，我们一个都不加（complete / includeRuntimeContext）`)
    console.log(`  ${/^\s+prefix: \|-$/m.test(pNew ?? '') && /MC 人设/.test(pNew ?? '') && !/^\s+text:/m.test(pNew ?? '') ? '✅' : '❌'} 新版（prefix）：用 prefix 写正文，**不塞 text**`)
    console.log(`  ${/complete: false/.test(pNew ?? '') && /includeRuntimeContext: true/.test(pNew ?? '') ? '✅' : '❌'} 新版里只**改值**：complete→false、includeRuntimeContext→true（键保留）`)
    console.log(`  ${/suffix: Your working directory/.test(pNew ?? '') ? '✅' : '❌'} 别的键（suffix）原样保留`)
    // 跨版本"自修"：一份用 prefix 写坏的老环境 preset + 源 preset 用 text → 按源的键修好
    const broken = C.patchPersonaInComposition(NEW_MINIMAL, '修好的人设', { key: 'text' })
    console.log(`  ${/^\s+text: \|-$/m.test(broken ?? '') && !/^\s+prefix:/m.test(broken ?? '') && /修好的人设/.test(broken ?? '') ? '✅' : '❌'} 🔴 跨版本自修：把写坏的 prefix 那份按**源的键**改成 text（启动自检走的就是这条）`)
    console.log(`  ${C.disableShellInComposition('# 没有 shell 组\n') === null ? '✅' : '❌'} 没有 shell 组 → 返回 null`)
    const twice = C.disableShellInComposition(C.disableShellInComposition('- id: persistent-shell\n  group: true\n', '') ?? '')
    console.log(`  ${(twice.match(/disabled: true/g) ?? []).length === 1 ? '✅' : '❌'} 关 shell 是幂等的（不会写两遍 disabled）`)
    // 工具组补丁（2026-09-16：MC 模式必须有 tool-fs / tool-jobs / … —— 官方 minimal 里一个都没有）
    const mini = "- id: persona\n  name: '@deepseek-ai/dsh-persona'\n"
    const added = C.patchToolGroupsIntoComposition(mini)
    console.log(`  ${added && C.MC_PRESET_TOOL_GROUPS.every((g) => added.includes(g.pkg)) ? '✅' : '❌'} 空壳 preset（像官方 minimal）→ 各组全补齐：${C.MC_PRESET_TOOL_GROUPS.map((g) => g.pkg.replace('@deepseek-ai/dsh-', '')).join(' / ')}`)
    console.log(`  ${added && /- id: tool-jobs\n  name: '@deepseek-ai\/dsh-tool-jobs'\n/.test(added) ? '✅' : '❌'} 🔴 其中含 tool-jobs（没有它，宿主就没有 job controller → 看门狗只能降级成"无 job 模式"）`)
    console.log(`  ${added && /- id: tool-fs\n  name: '@deepseek-ai\/dsh-tool-fs'\n/.test(added) ? '✅' : '❌'} 其中含 tool-fs（文件工具；官方 minimal 没有 → 不补的话 jail/白名单全落空）`)
    // 🔴 2026-09-24（PR #2 用户报）：压缩组**必须整组**写进去 —— 只补 `command-compact` 没用，
    //    服务本体在 `compaction-basic`，而 `isolate` 那两个键别处根本不存在。
    const cg = Boolean(added && /^- id: compaction$/m.test(added))
    console.log(`  ${cg && /^\s{2}name: cordis:group$/m.test(added) && /^\s{2}group: true$/m.test(added) && /^\s{4}compaction: true$/m.test(added) && /^\s{4}toolResultPruner: true$/m.test(added) ? '✅' : '❌'} 🔴 压缩组按"整组"写入（cordis:group + group + isolate: compaction/toolResultPruner）`)
    console.log(`  ${cg && /dsh-compaction-basic/.test(added) && /dsh-command-compact/.test(added) && /dsh-compaction-tool-result-pruner/.test(added) ? '✅' : '❌'} 压缩组三个条目齐全（压缩服务本体 + /compact 指令 + 工具结果裁剪）`)
    console.log(`  ${cg && /thresholdChars: 8192/.test(added) && /headChars: 4096/.test(added) && /tailChars: 1024/.test(added) ? '✅' : '❌'} 裁剪参数与官方 standard 一致（8192 / 4096 / 1024）`)
    console.log(`  ${added && C.patchToolGroupsIntoComposition(added) === null ? '✅' : '❌'} 幂等：再跑一次返回 null（不会加两遍）`)
    const partial = C.patchToolGroupsIntoComposition("- id: tool-fs\n  name: '@deepseek-ai/dsh-tool-fs'\n")
    // 只数**带闭合引号**的精确名 —— `dsh-tool-fs` 是 `dsh-tool-fs-search` 的子串，不能直接 match(/dsh-tool-fs/g)
    const fsExact = (partial?.match(/@deepseek-ai\/dsh-tool-fs'/g) ?? []).length
    console.log(`  ${partial && fsExact === 1 && partial.includes('dsh-tool-fs-search') && partial.includes('dsh-tool-jobs') ? '✅' : '❌'} 已经有的那组不会被重复加（只补缺的；tool-fs 不因 tool-fs-search 而误判）`)
    const oneOnly = C.patchToolGroupsIntoComposition(mini, [C.MC_PRESET_TOOL_GROUPS[0]])
    console.log(`  ${oneOnly && oneOnly.includes('dsh-tool-fs') && !oneOnly.includes('dsh-tool-jobs') ? '✅' : '❌'} 只把"部署里真的有的"那几组传进来时，只补那几组`)
    console.log(`  ${C.MC_PRESET_SPEC === 8 ? '✅' : '❌'} 🔴 MC_PRESET_SPEC=8（升到这一版会把 7 建的 preset 重建一遍 → 补上 tool-fs-search / tool-goal / tool-todo）`)
  }
  // 🔴 **已经建好的**那份也要能修（用户那台测试机上就是旧版建出来的）：
  //    只在"简介恰好等于某个官方 preset 的简介"（明显是复制残留）时才动，用户自己写的不碰。
  const SHIPPED = ['仅提供持久 shell 的单工具编码 Agent。', '功能完整的编码 Agent，支持文件编辑、Shell、文件与网页检索、Skills、计划、目标、子代理和工作流。']
  console.log(`  ${isCopiedPresetDescription(SHIPPED[0], SHIPPED) && isCopiedPresetDescription(SHIPPED[1], SHIPPED) ? '✅' : '❌'} 认得出"复制残留"的简介（等于某个官方简介）`)
  console.log(`  ${!isCopiedPresetDescription('Whale Craft插件提供加入MC Java版服务器模拟玩家交互的能力', SHIPPED) && !isCopiedPresetDescription('', SHIPPED) && !isCopiedPresetDescription(undefined, SHIPPED) ? '✅' : '❌'} 用户自己写的简介 / 空 / 缺省 → **不动**（不覆盖人家改过的）`)
  {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
    console.log(`  ${/planPresetAction\(\{/.test(src) && /shippedDescriptionMatch: isCopiedPresetDescription\(row\?\.description, shippedDescs\)/.test(src) ? '✅' : '❌'} 已有的 MC 模式 preset 也会走一次判定（旧版建出来的能被修好）`)
    console.log(`  ${/writeMcPresetMarker\(svc, target, \{/.test(src) && /MC_PRESET_MARKER = '\.whale-craft\.json'/.test(src) ? '✅' : '❌'} 建完留下"自建标记"（下次启动才知道这份是我们建的）`)
    // 🔴 2026-09-16 真机事故：复制 minimal 带来的 persona（含 complete:true / includeRuntimeContext:false）
    //    会让宿主把**我们注入的 context 段整个丢掉** → "设置页显示正常、AI 却什么都没收到"
    // 🔴 2026-09-17：新建/重建**必须把"本版本源 preset 的 persona 键名"传下去** ——
    //    写死 prefix 会把老版 DSH 的 preset 建坏（$text missing required value）。
    console.log(`  ${/patchMcPresetComposition\(svc, target, \{ key: personaTextKeyOf\(compositionOf\(rows\.get\(source\)\)\) \}\)/.test(src) && /patchMcPresetComposition\(svc, existingId, \{ key: personaTextKeyOf\(/.test(src) ? '✅' : '❌'} 新建/重建都会把 persona 换成我们的、并关掉 shell（且**带上本版本的键名**）`)
    console.log(`  ${/personaTextKeyOf\(composition\)/.test(src) && /已自动修正/.test(src) ? '✅' : '❌'} 🔴 启动自检：persona 键名与本版本不符 → **自动修正**（插件升级即修好老环境）`)
    console.log(`  ${/stillShippedPersona/.test(src) && /You are a helpful software engineer assistant/.test(src) ? '✅' : '❌'} 旧版（无标记）那份：只在"官方那句人设还在"时才动它`)
    console.log(`  ${/runtimeContextSuppressed \? \[\]/.test(src) ? '✅' : '❌'} 状态块注释里钉住了宿主那段 contexts: runtimeContextSuppressed ? [] （这是根因）`)
    console.log(`  ${/notices: sent/.test(src) && /segments: \{/.test(src) ? '✅' : '❌'} 状态块报的是**实际投出去的文件**（noticesSent，不许再撒谎）`)
    // 🔴 用户："我不要模拟用户发送啊！" —— 投递的那条必须标成 plugin/notice，且**不许** steer（空闲时会起一轮）
    console.log(`  ${/kind: 'plugin:whale_craft', form: 'notice'/.test(src) && !/kind: 'plugin',/.test(src) ? '✅' : '❌'} 投递的消息标成 plugin/notice —— kind 用 **v4 规范值** plugin:whale_craft（v4 拒绝裸露 'plugin'；不归到用户头上）`)
    // 🔴 2026-10-04：「连接到MC」是**用户点的**按钮 → 允许 steer（空闲起一轮）。
    //    除此之外 index.js 一律不许 steer —— 通知投递通道若 steer，空闲时会"起一轮"＝没问就替用户说话。
    const steerHits = (src.match(/agent\.steer\(/g) ?? []).length
    const steerOnlyInConnect = steerHits === 1 && /path === '\/api\/mc\/connect'[\s\S]{0,3200}?agent\.steer\(message\)/.test(src)
    console.log(`  ${steerOnlyInConnect ? '✅' : '❌'} 🔴 steer 只在「连接到MC」（**用户点的**）里；通知投递通道一律不 steer（实得 ${steerHits} 处）`)
  }

  // 🔴 用户问的："初始化时能不能检查是不是对的，不对也重新建吗？万一用户更新插件了呢。"
  //    → `planPresetAction()` 是那套判定的**纯函数**，每条分支都钉一遍。
  {
    const C = await import('./src/config.mjs')
    const plan = C.planPresetAction
    const ours = { createdBy: 'whale_craft', spec: C.MC_PRESET_SPEC, compositionHash: 'aaa' }
    const t = (label, got, want) => console.log(`  ${got === want ? '✅' : '❌'} ${label}（→ ${got}）`)
    t('没有 preset → 建', plan({ exists: false }).action, 'create')
    t('自建的 + 规格变了（插件更新）→ 重建', plan({ exists: true, marker: { ...ours, spec: 0 }, compositionHash: 'aaa', sourceHash: 'aaa' }).action, 'rebuild')
    t('🔴 自建的但**组成被用户改过** → 绝不动', plan({ exists: true, marker: ours, compositionHash: 'bbb', sourceHash: 'aaa' }).action, 'leave')
    t('自建的 + 官方源变了（DSH 更新）→ 重建', plan({ exists: true, marker: ours, compositionHash: 'aaa', sourceHash: 'ccc' }).action, 'rebuild')
    t('自建的 + 只是显示文本不对 → 只修元数据', plan({ exists: true, marker: ours, compositionHash: 'aaa', sourceHash: 'aaa', metaOk: false }).action, 'meta')
    t('自建的 + 都对 → 什么都不做', plan({ exists: true, marker: ours, compositionHash: 'aaa', sourceHash: 'aaa', metaOk: true }).action, 'leave')
    t('不是我们建的 + 简介是复制残留 → 只修元数据', plan({ exists: true, marker: null, shippedDescriptionMatch: true }).action, 'meta')
    t('不是我们建的 + 别的 → 一律不动（用户自己维护的）', plan({ exists: true, marker: null, shippedDescriptionMatch: false }).action, 'leave')
    // 🔴 读不到组成（没记下 hash）→ **没有依据判断用户改没改** → 只敢修显示文本，永不重建
    t('自建的但没记下组成 hash + 文本对 → 不动', plan({ exists: true, marker: { ...ours, compositionHash: null }, metaOk: true }).action, 'leave')
    t('自建的但没记下组成 hash + 文本不对 → 只修文本（不重建）', plan({ exists: true, marker: { ...ours, compositionHash: null }, metaOk: false }).action, 'meta')
  }
  // 自建标记真的落盘了吗（含规格与组成 hash）
  {
    const markerFile = jnTop(presetUserRoot, 'minecraft', '.whale-craft.json')
    const mk = exTop(markerFile) ? JSON.parse(rfTop(markerFile, 'utf8')) : null
    console.log(`  ${mk?.createdBy === 'whale_craft' && typeof mk?.compositionHash === 'string' && typeof mk?.spec === 'number' ? '✅' : '❌'} 自建标记落盘（createdBy/spec/compositionHash：${JSON.stringify(mk && { by: mk.createdBy, spec: mk.spec, hash: mk.compositionHash })})`)
  }
  console.log(`  ${pickPresetTarget(['minecraft', 'whale_craft']) === 'minecraft' ? '✅' : '❌'} 目标 id 取的是**合法目录名**（minecraft）`)
  console.log(`  ${pickPresetTarget(['whale_craft']) === null ? '✅' : '❌'} 🔴 \`whale_craft\` 带下划线、**不可能是 preset id** → 宁可不建也不硬来（null）`)
  console.log(`  ${pickPresetSource(['minimal', 'standard']) === 'minimal' && pickPresetSource(['ptc'], 'ptc') === 'ptc' && pickPresetSource([], 'standard') === null ? '✅' : '❌'} 复制源优先 minimal → standard → ptc，再退到宿主默认，都没有就 null`)
  {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
    console.log(`  ${/svc\.copy\(source, target, MC_PRESET_NAME\)/.test(src) ? '✅' : '❌'} 用的是宿主官方 \`copy()\`（不手搓 composition —— 官方 authoring 不允许）`)
    console.log(`  ${/svc\.authorable === false/.test(src) ? '✅' : '❌'} 这份部署没有可写 preset 根时优雅跳过（不是崩）`)
  }
  /* ①·2 🔴🔴 2026-10-04：DSH 0.2.0-rc.2+ 的 preset 是**声明式**的（`@deepseek-ai/dsh-agent-preset`
   *    行 + `dsh.bundle.patch` 数组）。「MC模式」/「MC+模式」两个 preset 由包内
   *    `presets/*.patch.yml` 直接声明 —— 旧目录式自举（copy/agent.cordis.yml/marker）
   *    在新宿主上是 no-op，只留给旧宿主。这里把"新宿主的那条路"钉死。 */
  {
    const { readFileSync, existsSync } = await import('node:fs')
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    const patches = pkg.dsh?.bundle?.patch
    console.log(`  ${Array.isArray(patches) && patches.includes('./presets/minecraft.patch.yml') && patches.includes('./presets/minecraft-plus.patch.yml') ? '✅' : '❌'} dsh.bundle.patch 是数组且含两个 preset 声明文件：${JSON.stringify(patches)}`)
    console.log(`  ${pkg.engines?.dsh === '>=0.2.0-rc.2 <0.3.0' ? '✅' : '❌'} engines.dsh 声明面向 0.2.0-rc.2+（只面向新宿主）`)
    const mcP = new URL('./presets/minecraft.patch.yml', import.meta.url)
    const plusP = new URL('./presets/minecraft-plus.patch.yml', import.meta.url)
    console.log(`  ${existsSync(mcP) && existsSync(plusP) ? '✅' : '❌'} 两个 preset 声明文件都在包里（files 已列 presets/）`)
    const mcSrc = readFileSync(mcP, 'utf8')
    const plusSrc = readFileSync(plusP, 'utf8')
    console.log(`  ${/name: '@deepseek-ai\/dsh-agent-preset'/.test(mcSrc) && /name: '@deepseek-ai\/dsh-agent-preset'/.test(plusSrc) ? '✅' : '❌'} 都是声明式 preset 行（@deepseek-ai/dsh-agent-preset）`)
    console.log(`  ${/\bid: minecraft\b/.test(mcSrc) && /\bid: minecraft-plus\b/.test(plusSrc) ? '✅' : '❌'} preset id = minecraft / minecraft-plus（^[a-z0-9][a-z0-9-]*$）`)
    console.log(`  ${/name: MC模式/.test(mcSrc) && /name: MC\+模式/.test(plusSrc) ? '✅' : '❌'} 显示名 = MC模式 / MC+模式`)
    console.log(`  ${/DSH加入Minecraft Java版服务器，像玩家一样游玩。只提供游玩MC相关工具，Agent更专注和高效。/.test(mcSrc) ? '✅' : '❌'} MC模式简介 = 用户给定原文（逐字）`)
    console.log(`  ${/在MC模式的基础上，提供标准模式全部工具，适合不局限于游戏内的任务和定制要求。/.test(plusSrc) ? '✅' : '❌'} MC+模式简介 = 用户给定原文（逐字）`)
    const MC_PREFIX = '你是一个 Minecraft Java 版游戏助理，由模型 {{model}} 驱动。你可以通过工具调用，使用无头机器人进入 MC 服务器中与世界和玩家互动。你应当专注于 MC 游戏，不过问交互原理和插件代码，除非收到明确调试指令。'
    const PLUS_PREFIX = '你是一个由 {{model}} 模型驱动的编程 agent。同时 whale_craft 插件赋予你使用无头机器人进入 Minecraft Java 版服务器的能力。你可以调用工具与世界和玩家互动。编程与系统操作相关的工具仍然暴露，用于扩展自身 MC 能力或进行调试研究。'
    const personaOk = mcSrc.includes(MC_PREFIX) && plusSrc.includes(PLUS_PREFIX)
    console.log(`  ${personaOk ? '✅' : '❌'} 🔴 两个 preset 的 persona 各自是我们的（MC 游戏助理 / 编程 agent；不复制官方那句）`)
    const mcNeeds = ['@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tool-fs-search', '@deepseek-ai/dsh-tool-jobs', '@deepseek-ai/dsh-tool-goal', '@deepseek-ai/dsh-tool-todo', '@deepseek-ai/dsh-tool-web', '@deepseek-ai/dsh-compaction-basic']
    console.log(`  ${mcNeeds.every((n) => mcSrc.includes(n)) && !mcSrc.includes('@deepseek-ai/dsh-tool-present') ? '✅' : '❌'} MC模式组成含 persona/tool-fs/tool-fs-search/tool-jobs/tool-goal/tool-todo/tool-web/compaction，且**不含** present`)
    // 🔴 2026-10-08：MC 模式挂 tool-web 只为 web_search —— fetch 必须关（网页抓取走 mc_kit_web_fetch）
    console.log(`  ${/name: '@deepseek-ai\/dsh-tool-web'\n\s+config:\n\s+fetch: false/.test(mcSrc) ? '✅' : '❌'} 🔴 MC模式只挂 search、不挂 fetch（tool-web 的 fetch: false）`)
    const plusNeeds = ['@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-agent-instructions', '@deepseek-ai/dsh-tool-pwsh', '@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-fs-search', '@deepseek-ai/dsh-skill-filesystem', '@deepseek-ai/dsh-plan-mode', '@deepseek-ai/dsh-tool-subagent', '@deepseek-ai/dsh-tool-web', '@deepseek-ai/dsh-plugin-manager/tools']
    console.log(`  ${plusNeeds.every((n) => plusSrc.includes(n)) ? '✅' : '❌'} MC+模式组成 = 标准模式全表（persona 除外）：${plusNeeds.filter((n) => !plusSrc.includes(n)).join(', ') || '无缺'}`)
    const mountsSelf = /\bname:\s*whale_craft\b/.test(mcSrc) || /\bname:\s*whale_craft\b/.test(plusSrc)
    console.log(`  ${!mcSrc.includes('@deepseek-ai/dsh-tool-pwsh') && !mountsSelf ? '✅' : '❌'} 🔴 MC模式**不挂**标准工具（唯一例外 = tool-web，只为 web_search）、preset 里**不挂**插件自己（工具走全局注册 + restrict/guard；persona 正文里出现 "whale_craft" 不算）`)
    console.log(`  ${pkg.files?.includes('presets') ? '✅' : '❌'} files 里列了 presets/（发布包才带得上声明）`)
  }
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const cfg = new PluginConfig(mkdtempSync(join(tmpdir(), 'whale-cfg-')))

  console.log(`  ${cfg.commandAllowed('tp') && !cfg.commandAllowed('op') ? '✅' : '❌'} 默认白名单：放行 tp、拒绝 op`)
  cfg.set('commandWhitelist', ['give', '/^ti/'])
  console.log(`  ${cfg.commandAllowed('time') && cfg.commandAllowed('give') && !cfg.commandAllowed('tp') ? '✅' : '❌'} 改白名单立即生效（正则 /^ti/ 命中 time，tp 被拒）`)
  cfg.set('commandWhitelist', ['*'])
  console.log(`  ${cfg.commandAllowed('随便什么') ? '✅' : '❌'} "*" = 全部放行`)
  const badType = await Promise.resolve().then(() => cfg.set('commandWhitelist', 'tp')).catch((e) => e.message)
  console.log(`  ${/必须是字符串数组/.test(String(badType)) ? '✅' : '❌'} 类型校验：${String(badType).slice(0, 40)}`)
  const badKey = await Promise.resolve().then(() => cfg.set('nope.x', 1)).catch((e) => e.message)
  console.log(`  ${/未知配置项/.test(String(badKey)) ? '✅' : '❌'} 未知键被拒：${String(badKey).slice(0, 40)}`)
  cfg.unset('commandWhitelist')
  console.log(`  ${cfg.commandAllowed('tp') ? '✅' : '❌'} unset 回到默认值`)
  cfg.reset()
  console.log(`  ${cfg.commandAllowed('tp') && cfg.get('mcMode.hideAdminTools') === true ? '✅' : '❌'} reset 全部恢复默认`)
  console.log(`  ${cfg.isMcModePreset('minecraft') && cfg.isMcModePreset('minecraft-plus') && !cfg.isMcModePreset('standard') ? '✅' : '❌'} MC 模式判定用可配置的 preset 名单（含 MC+）`)
  console.log(`  ${cfg.isMcPlusPreset('minecraft-plus') && !cfg.isMcPlusPreset('minecraft') && !cfg.isMcPlusPreset('standard') ? '✅' : '❌'} 🔴 MC+ 变体判定：minecraft-plus 是、minecraft/standard 不是`)
  const badPlus = await Promise.resolve().then(() => cfg.set('mcPlusPresets', 'minecraft-plus')).catch((e) => e.message)
  console.log(`  ${/必须是字符串数组/.test(String(badPlus)) ? '✅' : '❌'} mcPlusPresets 类型校验：${String(badPlus).slice(0, 40)}`)

  // ①b 插件状态目录：配置 / 账户**不在工作区**（用户 2026-09-16："dsh 没给插件专门记配置的目录吗"）
  {
    const { resolveStateDir } = await import('./src/config.mjs')
    const { readFileSync } = await import('node:fs')
    const fakeHome = 'C:\\Users\\x'
    const ws = 'E:\\ws\\.whale-craft'
    const viaSvc = resolveStateDir({ env: {}, dshHomePath: (n) => `C:\\Users\\x\\.dsh\\${n}`, whaleDir: ws, home: fakeHome })
    console.log(`  ${viaSvc === 'C:\\Users\\x\\.dsh\\whale_craft' ? '✅' : '❌'} 优先用宿主 dshHomePath('whale_craft')：${viaSvc}`)
    const viaEnv = resolveStateDir({ env: { DSH_HOME: 'D:\\dsh' }, whaleDir: ws, home: fakeHome })
    console.log(`  ${viaEnv === 'D:\\dsh\\whale_craft' ? '✅' : '❌'} 没有该服务时按 $DSH_HOME：${viaEnv}`)
    const viaHome = resolveStateDir({ env: {}, whaleDir: ws, home: fakeHome })
    console.log(`  ${viaHome === 'C:\\Users\\x\\.dsh\\whale_craft' ? '✅' : '❌'} 连 $DSH_HOME 也没有时用 ~/.dsh：${viaHome}`)
    console.log(`  ${!viaHome.includes('E:\\ws') ? '✅' : '❌'} 🔴 结果**不在工作区**里（这正是用户要的）`)
    const iso = resolveStateDir({ env: { WHALE_CRAFT_DIR: 'T:\\tmp' }, dshHomePath: () => 'C:\\x\\.dsh\\whale_craft', whaleDir: 'T:\\tmp', home: fakeHome })
    console.log(`  ${iso === 'T:\\tmp' ? '✅' : '❌'} 自检/隔离模式（WHALE_CRAFT_DIR）一切留在临时目录：${iso}`)
    // 🔴 2026-09-24（issue #1 附带）：日志路径走 `fileURLToPath`，别用 `new URL().pathname`
    //    （家目录含中文时会被百分号编码 → 自检在 mkdir 上 EPERM 崩掉）
    console.log(`  ${!/%[0-9A-Fa-f]{2}/.test(String(process.env.MC_LOG)) ? '✅' : '❌'} 自检日志路径没有被百分号编码（fileURLToPath；中文/空格家目录下也能跑）：${process.env.MC_LOG}`)
    const explicit = resolveStateDir({ env: { WHALE_CRAFT_STATE_DIR: 'S:\\s', WHALE_CRAFT_DIR: 'T:\\tmp' }, whaleDir: 'T:\\tmp', home: fakeHome })
    console.log(`  ${explicit === 'S:\\s' ? '✅' : '❌'} WHALE_CRAFT_STATE_DIR 优先级最高`)
    const idx = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
    console.log(`  ${/new PluginConfig\(stateDir\)/.test(idx) && /new AccountStore\(\{ dir: stateDir/.test(idx) ? '✅' : '❌'} index.js 里配置与账户都建在 stateDir 上（不是 whaleDir）`)
    console.log(`  ${/resolveStateDir\(\{ dshHomePath, whaleDir: process\.env\.WHALE_CRAFT_DIR \}\)/.test(idx) ? '✅' : '❌'} 状态目录走 resolveStateDir（拿不到就 /$DSH_HOME 兜底）`)
    console.log(`  ${/copyFileSync\(from, to\)/.test(idx) && /unlinkSync\(from\)/.test(idx) ? '✅' : '❌'} 老工作区文件有一次性的"搬出工作区"迁移`)
    // 🔴 2026-09-16 抽取成标准插件：记忆/提示词必须**按会话工作区**解析（插件装哪都行）
    console.log(`  ${/const workspaceOf = \(agent\) =>/.test(idx) && /agent\?\.session\?\.header\?\.cwd/.test(idx) ? '✅' : '❌'} 工作区取自 exec.agent.session.header.cwd（不再用"插件自己在哪"）`)
    console.log(`  ${/join\(cwd, '\.whale-craft'\)/.test(idx) ? '✅' : '❌'} 记忆根 = <会话工作区>/.whale-craft`)
    console.log(`  ${/const noticeLedger = new WeakMap\(\)/.test(idx) && /const pushNotice = \(inbox, message\)/.test(idx) ? '✅' : '❌'} 提示词按会话工作区投递到 agent.inbox（每个会话一份，插件不再碰 systemPrompt）`)
  // 🔴🔴 2026-09-18：npm 装的 0.1.3 在**别的机器**上提示词一条都没注入 —— 根因是
  //    `@deepseek-ai/dsh-llm` 没进依赖声明，本机靠 junction 侥幸解析到，别人解析不到 ⇒
  //    消息构造不出来。现在统一走 `src/user-message.mjs`（宿主实现优先 + 自带等价实现兜底）。
  const umSrc = (await import('node:fs')).readFileSync(new URL('./src/user-message.mjs', import.meta.url), 'utf8')
  const wdSrc = (await import('node:fs')).readFileSync(new URL('./src/watchdog.mjs', import.meta.url), 'utf8')
  const { messageFactoryKind } = await import('./src/user-message.mjs')
  console.log(`  ${/from '\.\/src\/user-message\.mjs'/.test(idx) ? '✅' : '❌'} 🔴 index.js 的消息构造走共用模块 src/user-message.mjs`)
  console.log(`  ${/export const builtinUserMessage/.test(umSrc) && /export const userMessage/.test(umSrc) ? '✅' : '❌'} 🔴 共用模块里有**自带等价实现**（不依赖任何宿主包也能注入）`)
  console.log(`  ${/role: 'user'/.test(umSrc) && /source: input\?\.source/.test(umSrc) && /crypto\.randomUUID/.test(umSrc) ? '✅' : '❌'} 兜底消息逐个对齐宿主 UserMessage 形状（role/content/source/id）`)
  console.log(`  ${/createRequire\(import\.meta\.url\)/.test(umSrc) && /req\('@deepseek-ai\/dsh-llm'\)/.test(umSrc) ? '✅' : '❌'} 仍然优先用宿主实现（形状跟得上宿主版本）`)
  console.log(`  ${/import \{ userMessage \} from '\.\/user-message\.mjs'/.test(wdSrc) && /userMessage\(\{/.test(wdSrc) ? '✅' : '❌'} 🔴 看门狗（同一次事故的第二处）也用同一个模块，不再退化成"用户来源"消息`)

  /* 🔴🔴 2026-09-18 **P0 事故**：0.1.4 把提示词投递挂到 `agent/pre-step`（cordis waterfall），
   *    但监听器只声明了一个形参、也没 `return next()` ⇒ **不交棒** = 否决整条链（含宿主内置行为），
   *    waterfall 返回 undefined ⇒ 宿主 `decision.kind` 抛
   *    `Cannot read properties of undefined (reading 'kind')` ⇒ **任意会话、任意模式、每一轮都失败**，
   *    装了插件就没法对话（真机标准模式与 MC 模式一视同仁）。
   *    下面这组断言就是为它立的：**横切**检查所有 waterfall 监听器都必须接 `next` 并交棒。 */
  const HOST_WATERFALL_EVENTS = [
    'agent/pre-step', 'agent/request', 'agent/request-error', 'approval/request',
    'fs/edit-intent', 'fs/write-intent', 'llm/stream', 'session-telemetry/record',
    'system-prompt/assemble', 'tools/execute', 'tools/post-execute', 'tools/pre-execute',
    'tools/ptc-dispatch-log', 'user-questions/request',
  ]
  {
    // 把源码里每个 `ctx.on('<事件>', <回调>)` 抠出来（回调到对应右括号为止，容忍嵌套括号）
    const registered = []
    for (const m of idx.matchAll(/ctx\.on\(\s*'([^']+)'\s*,/g)) {
      const name = m[1]
      let i = m.index + m[0].length
      let depth = 0
      const start = i
      for (; i < idx.length; i++) {
        const ch = idx[i]
        if (ch === '(' || ch === '{' || ch === '[') depth++
        else if (ch === ')' || ch === '}' || ch === ']') { if (depth === 0) break; depth-- }
      }
      registered.push({ name, body: idx.slice(start, i) })
    }
    const wf = registered.filter((r) => HOST_WATERFALL_EVENTS.includes(r.name))
    console.log(`  ${registered.length > 0 ? '✅' : '❌'} 源码里注册了 ${registered.length} 个事件监听器（其中 waterfall 事件 ${wf.length} 个）`)
    const bad = wf.filter((r) => !/\([^)]*,\s*next\s*\)/.test(r.body) || !/\bnext\s*\(/.test(r.body))
    console.log(`  ${bad.length === 0 ? '✅' : '❌'} 🔴🔴 每个 waterfall 监听器都接 next 且调用它（不交棒＝否决整条链 ⇒ 宿主 decision.kind 崩）${bad.length ? '：违规 ' + bad.map((b) => b.name).join(', ') : `（${wf.map((r) => r.name).join(', ') || '无'}）`}`)
    console.log(`  ${/if \(typeof next !== 'function'\)/.test(idx) && /const inner = next\(\)/.test(idx) ? '✅' : '❌'} pre-step 监听器：交棒拿回内层结果、原样返回（不改载荷），且对 next 缺失有兜底`)
    console.log(`  ${/return inner\.then\(\(decision\) => enterWithNotices/.test(idx) && /const inner = next\(\)/.test(idx) ? '✅' : '❌'} 🔴 交棒拿回 decision 后**当场改写本步消息**（enterWithNotices）—— 提示行与用户那句同批送出，不再晚一步`)
    console.log(`  ${/decision\.kind !== 'enter'/.test(idx) && /messages: \[\.\.\.noticeMessagesFor\(r\.todo\), \.\.\.msgs\]/.test(idx) ? '✅' : '❌'} 只对 enter 生效，且提示行排在本步消息**最前面**`)
    console.log(`  ${/todo: \[\]/.test(idx) ? '✅' : '❌'} 🔴 对账的每个提前返回都带 todo 字段（漏一个就是被 catch 吞掉的静默 TypeError）`)
    console.log(`  ${/since = Array\.isArray\(ev\) \? ev\.length : 0/.test(idx) && /events\.slice\(from\)/.test(idx) ? '✅' : '❌'} 🔴 切出模式时给日志划一条线（切出再切回能重投，不被旧记录误判）`)
    console.log(`  ${!/if \(removed > 0\) \{\s*const l = ledgerOf/.test(idx) ? '✅' : '❌'} 🔴 切出模式时**无条件**清台账（提示行已在本步送出、队列常为空，按"队列非空"判断会漏清 ⇒ 再也不投）`)
    // 反向证明：这些断言真的能拦住事故写法
    const buggy = `ctx.on('agent/pre-step', ({ agent } = {}) => { try { reconcileNotices(agent) } catch {} })`
    const buggyBad = !/\([^)]*,\s*next\s*\)/.test(buggy) || !/\bnext\s*\(/.test(buggy)
    console.log(`  ${buggyBad ? '✅' : '❌'} 负向验证：把 0.1.4 的事故写法喂给同一判据 → 判为违规（否则这套检查是假绿）`)
  }
  console.log(`  ℹ️ 本次跑的是：${messageFactoryKind() === 'host' ? '宿主 @deepseek-ai/dsh-llm 的 createUserMessage' : '插件自带等价实现（环境里没有宿主包 —— 正是 npm 装到别人机器上的情形）'}`)
    // 🔴 2026-09-18 挂载点：投递必须发生在 **agent/pre-step**（请求组装前），不能退回"会话开始那一刻"
    console.log(`  ${/ctx\.on\('agent\/pre-step'/.test(idx) ? '✅' : '❌'} 🔴 投递挂在 agent/pre-step（宿主"消息已领走 + 系统提示已装好"的那条瀑布）`)
    console.log(`  ${!/applyMcModePolicy[\s\S]{0,900}?injectAgentsMdNotices/.test(idx) ? '✅' : '❌'} applyMcModePolicy 里**不再**投提示词（模式在首次请求前还可能变）`)
  }

  // ② 管理工具（走真实插件实例，落盘在自检临时目录）
  const adminGet = await tools.get('mc_admin_config').execute({ action: 'get' }, A)
  console.log(`  ${adminGet.values && adminGet.file ? '✅' : '❌'} mc_admin_config{get} 可用（${adminGet.file.split(/[\\/]/).pop()}）`)
  const adminSet = await tools.get('mc_admin_config').execute(
    { action: 'set', path: 'commandWhitelist', value: ['op', 'tp'] }, A)
  console.log(`  ${Array.isArray(adminSet.value) && adminSet.value.includes('op') ? '✅' : '❌'} mc_admin_config{set} 改白名单成功`)

  // ③ 白名单立刻作用到 mc_command（改完不用重启）
  const wlErr = await tools.get('mc_command').execute({ command: '/give @s stone' }, A).catch((e) => e.message)
  console.log(`  ${/不在白名单/.test(String(wlErr)) ? '✅' : '❌'} 白名单外的指令被拒：${String(wlErr).slice(0, 46)}`)
  const wlOk = await tools.get('mc_command').execute({ command: '/op me' }, A).catch((e) => e.message)
  console.log(`  ${/不在线/.test(String(wlOk)) ? '✅' : '❌'} 白名单内的指令放行（只因未连服而报"不在线"）`)
  await tools.get('mc_admin_config').execute({ action: 'reset' }, A)

  // ④ guard：MC 模式调管理工具必须被硬拒；普通模式不被拒
  const mcCtxObj = {}; presetByCtx.set(mcCtxObj, 'minecraft')
  const plainCtxObj = {}; presetByCtx.set(plainCtxObj, 'standard')
  const mcExec = { name: 'mc_admin_config', agent: { id: 'sess-MC', ctx: mcCtxObj } }
  const plainExec = { name: 'mc_admin_config', agent: { id: 'sess-P', ctx: plainCtxObj } }
  const denied = guards.map((g) => { try { return g(mcExec) } catch { return undefined } }).find(Boolean)
  console.log(`  ${denied ? '✅' : '❌'} MC 模式调 mc_admin_config 被 guard 拒绝：${String(denied).slice(0, 42)}`)
  const plainDenied = guards.map((g) => { try { return g(plainExec) } catch { return undefined } }).find(Boolean)
  console.log(`  ${plainDenied === undefined ? '✅' : '❌'} 非 MC 模式不被拒（普通会话能改配置）`)
  const otherTool = guards.map((g) => { try { return g({ name: 'mc_status', agent: { id: 'sess-MC', ctx: mcCtxObj } }) } catch { return undefined } }).find(Boolean)
  console.log(`  ${otherTool === undefined ? '✅' : '❌'} guard 只管管理工具，不影响 mc_status 等游戏工具`)

  // guard 硬化：MC 模式不许用文件工具绕去读凭据 / 碰记忆文件夹以外的任何文件；
  // 受保护文件（RULES.md / AGENTS.md / config.json）**可读不可写**（用户 2026-10-03 定）
  const memRoot = join(checkWs, '.whale-craft')
  const callGuard = (spec) => guards.map((g) => { try { return g(spec) } catch { return undefined } }).find(Boolean)
  const mcGuardAgent = { id: 'sess-MC', ctx: mcCtxObj, session: { header: { cwd: checkWs } } }
  const credRead = callGuard({ name: 'read', arguments: { path: 'C:\\Users\\x\\.dsh\\.credentials.yaml' }, agent: mcGuardAgent })
  console.log(`  ${credRead ? '✅' : '❌'} MC 模式读 .credentials.yaml 被 guard 拒绝：${String(credRead).slice(0, 28)}`)
  const secretsRead = callGuard({ name: 'read', arguments: { path: 'E:\\x\\.agent-docs\\secrets\\example.md' }, agent: mcGuardAgent })
  console.log(`  ${secretsRead ? '✅' : '❌'} MC 模式读 secrets/ 明文凭据备忘也被拒：${String(secretsRead).slice(0, 28)}`)
  const credFsCopy = callGuard({ name: 'mc_kit_fs', arguments: { action: 'copy', from: 'C:\\Users\\x\\.dsh\\.credentials.yaml', to: 'x' }, agent: mcGuardAgent })
  console.log(`  ${credFsCopy ? '✅' : '❌'} 🔴 mc_kit_fs 碰凭据（copy）也被拒：${String(credFsCopy).slice(0, 24)}`)
  const mdRead = callGuard({ name: 'read', arguments: { path: 'RULES.md' }, agent: mcGuardAgent })
  console.log(`  ${mdRead === undefined ? '✅' : '❌'} 🔴 受保护文件 RULES.md **可读**（guard 放行 —— 可读不可写）`)
  const protectedWrites = [
    ['write', { path: 'RULES.md', content: '改' }],
    ['write', { path: 'AGENTS.md', content: '改' }],
    ['edit', { path: 'config.json' }],
    ['edit', { path: join(memRoot, 'config.json') }],
    ['edit', { path: 'AGENTS.md' }],
    ['mc_kit_fs', { action: 'delete', path: 'RULES.md' }],
    ['mc_kit_fs', { action: 'make_dir', path: 'config.json' }],
  ]
  const missedWrites = protectedWrites.filter(([name, args]) => callGuard({ name, arguments: args, agent: mcGuardAgent }) === undefined)
  console.log(`  ${missedWrites.length === 0 ? '✅' : '❌'} 🔴 受保护文件的各种写法**写全被拒**（${protectedWrites.length - missedWrites.length}/${protectedWrites.length}）：${missedWrites.map(([n]) => n).join(', ') || '无漏网'}`)
  const nestedOk = callGuard({ name: 'write', arguments: { path: '_global/config.json', content: 'x' }, agent: mcGuardAgent }) === undefined
  console.log(`  ${nestedOk ? '✅' : '❌'} 嵌套的普通记忆文件（_global/config.json）不受影响，照常可写`)
  // 🔴 用户 2026-09-16："读写文件都只能在记忆文件夹内！"
  const jail = [
    ['read', { path: 'E:\\x\\README.md' }],                                  // 工作区里、但不在记忆夹
    ['write', { path: 'E:\\x\\notes.md', content: 'x' }],
    ['edit', { path: '..\\..\\secret.txt' }],
    ['read_image', { path: 'E:\\<dsh-checkout>\\x.png' }],
    ['glob', { pattern: '**/*.mjs' }],                                       // 不给路径 = 扫整个工作区
    ['grep', { pattern: 'password', path: 'E:\\x' }],
    ['write', { file_path: 'E:\\x\\via-file_path.txt' }],                    // 兼容 file_path 参数名
    ['mc_kit_fs', { action: 'delete', path: 'E:\\x\\secret.txt' }],          // mc_kit_fs 也受同一把沙箱锁
    ['mc_kit_fs', { action: 'copy', from: 'ok.md', to: 'E:\\x\\out.md' }],  // to 在外 → 越界
  ]
  const escaped = jail.filter(([name, args]) => callGuard({ name, arguments: args, agent: mcGuardAgent }) === undefined)
  console.log(`  ${escaped.length === 0 ? '✅' : '❌'} 🔴 MC 模式的文件工具越界全被拒（${jail.length - escaped.length}/${jail.length}）：${escaped.map(([n]) => n).join(', ') || '无漏网'}`)
  const insideOk = [['read', { path: join(memRoot, 'notes.md') }], ['glob', { pattern: '*.md', path: memRoot }], ['write', { path: 'notes.md' }], ['mc_kit_fs', { action: 'make_dir', path: join(memRoot, 'newdir') }]]
    .every(([name, args]) => callGuard({ name, arguments: args, agent: mcGuardAgent }) === undefined)
  console.log(`  ${insideOk ? '✅' : '❌'} 记忆文件夹**内**的读写放行（绝对路径 + 相对路径都行）`)
  const plainExec3 = { name: 'pwsh', arguments: { command: 'whoami' }, agent: { id: 'sess-MC', ctx: mcCtxObj } }
  const plainRead = guards.every((g) => { try { return g(plainExec3) === undefined } catch { return true } })
  console.log(`  ${plainRead ? '✅' : '❌'} guard 不拦 pwsh（它靠白名单**看不见**，不是靠 guard）`)
  // `present`（显式文件交付）：允许交付**工作区内**的文件（out/ 与 .whale-craft/ 都在里面），外面一律拒
  const presentIn = callGuard({ name: 'present', arguments: { files: [{ path: 'out/map.png', description: '地图' }] }, agent: mcGuardAgent })
  console.log(`  ${presentIn === undefined ? '✅' : '❌'} present 交付工作区内的文件放行（out/x.png）`)
  const presentInMem = callGuard({ name: 'present', arguments: { files: [{ path: '.whale-craft/README.md' }] }, agent: mcGuardAgent })
  console.log(`  ${presentInMem === undefined ? '✅' : '❌'} present 交付记忆夹里的文件也放行`)
  const presentOut = callGuard({ name: 'present', arguments: { files: [{ path: 'E:\\<dsh-checkout>\\x.png' }] }, agent: mcGuardAgent })
  console.log(`  ${presentOut ? '✅' : '❌'} present 交付工作区外的文件被拒：${String(presentOut).slice(0, 34)}`)
  const presentNorm = guards.every((g) => { try { return g({ name: 'present', arguments: { files: [{ path: 'E:\\x\\y.png' }] }, agent: { id: 'sess-P', ctx: plainCtxObj } }) === undefined } catch { return true } })
  console.log(`  ${presentNorm ? '✅' : '❌'} 普通会话的 present 不受影响（隔离只管 MC 模式）`)
  const normRead = guards.every((g) => { try { return g({ name: 'read', arguments: { path: 'E:\\x\\README.md' }, agent: { id: 'sess-P', ctx: plainCtxObj } }) === undefined } catch { return true } })
  console.log(`  ${normRead ? '✅' : '❌'} 普通会话读工作区文件不受影响（隔离只管 MC 模式）`)

  // 网页抓取（mc_kit_web_fetch，2026-10-08）：guard 两档 —— 开关（默认关）+ 域名表；**MC 与 MC+ 都过**
  {
    const setCfg = (path, value) => tools.get('mc_admin_config').execute({ action: 'set', path, value }, A)
    const fetchCall = (url, ctxObj = mcCtxObj) => callGuard({ name: 'mc_kit_web_fetch', arguments: { url }, agent: { id: 'sess-MC', ctx: ctxObj } })
    const offMsg = fetchCall('https://minecraft.wiki/w/Diamond')
    console.log(`  ${/网页抓取未启用/.test(String(offMsg)) ? '✅' : '❌'} 🔴 抓取开关默认关 → guard 硬拒：${String(offMsg).slice(0, 24)}`)
    await setCfg('webFetchEnabled', true)
    const outsideMsg = fetchCall('https://example.com/x')
    console.log(`  ${/不在允许抓取的列表/.test(String(outsideMsg)) ? '✅' : '❌'} 开关开了但域名不在表里 → 拒：${String(outsideMsg).slice(0, 22)}`)
    const okApex = fetchCall('https://minecraft.wiki/w/Diamond')
    const okSub = fetchCall('https://zh.minecraft.wiki/w/%E9%92%BB%E7%9F%B3')
    console.log(`  ${okApex === undefined && okSub === undefined ? '✅' : '❌'} 🔴 默认域名表放行裸域 minecraft.wiki 与子域 *.minecraft.wiki（含编码路径）`)
    const badScheme = fetchCall('ftp://minecraft.wiki/x')
    console.log(`  ${badScheme ? '✅' : '❌'} 非 http(s) 抓不了（取不到主机名 → 拒）：${String(badScheme).slice(0, 22)}`)
    const plusCtxFetch = {}; presetByCtx.set(plusCtxFetch, 'minecraft-plus')
    const plusMsg = fetchCall('https://example.com', plusCtxFetch)
    console.log(`  ${/不在允许抓取的列表/.test(String(plusMsg)) ? '✅' : '❌'} 🔴 MC+ 也过这道闸（域名表对两档都生效）`)
    await setCfg('allowAllFetchDomains', true)
    console.log(`  ${fetchCall('https://example.com/x') === undefined ? '✅' : '❌'} 打开「允许所有域名」后任意公网域名放行`)
    await setCfg('allowAllFetchDomains', false)
    const plainMsg = fetchCall('https://example.com/x', plainCtxObj)
    console.log(`  ${/只在 MC模式/.test(String(plainMsg)) ? '✅' : '❌'} 普通会话调它走的是"mc_kit_* 不暴露"那条（不是抓取那条）`)
    // 「允许的内容类型」三个都关 = 什么都抓不了 → guard 直接拒（不白跑一次网络请求）
    await setCfg('webFetchAllowHtml', false)
    await setCfg('webFetchAllowText', false)
    await setCfg('webFetchAllowImage', false)
    const noTypeMsg = fetchCall('https://minecraft.wiki/x')
    console.log(`  ${/三个都关着/.test(String(noTypeMsg)) ? '✅' : '❌'} 🔴 内容类型三类都关时 guard 就拒（${String(noTypeMsg).slice(0, 22)}）`)
    await setCfg('webFetchAllowHtml', true)
    await setCfg('webFetchAllowText', true)
    await setCfg('webFetchAllowImage', true)
    console.log(`  ${fetchCall('https://minecraft.wiki/x') === undefined ? '✅' : '❌'} 三类都开回来后又放行`)
    await tools.get('mc_admin_config').execute({ action: 'reset' }, A)
  }

  // 🔴 2026-10-04 用户定：新增 **MC+ 变体**（在 MC 基础上开放标准全部工具）与
  //    "其他模式不再暴露 mc/mckit" —— guard 按三档分：
  //    MC（全部硬边界）/ MC+（只保留凭据）/ 其他（拒 mc_*、mc_kit_*；mc_admin_* 例外）
  {
    const plusCtxObj = {}; presetByCtx.set(plusCtxObj, 'minecraft-plus')
    const plusAgent = { id: 'sess-MCP', ctx: plusCtxObj }
    const plusAdmin = callGuard({ name: 'mc_admin_config', agent: plusAgent })
    console.log(`  ${plusAdmin === undefined ? '✅' : '❌'} 🔴 MC+ 模式**放行** mc_admin_config（用户定：MC+ 可见管理工具）`)
    const plusOutside = callGuard({ name: 'read', arguments: { path: 'E:\\x\\README.md' }, agent: plusAgent })
    console.log(`  ${plusOutside === undefined ? '✅' : '❌'} 🔴 MC+ 的文件工具**不受 .whale-craft/ 限制**（全工作区）`)
    const plusCred = callGuard({ name: 'read', arguments: { path: 'C:\\Users\\x\\.dsh\\.credentials.yaml' }, agent: plusAgent })
    const plusSecrets = callGuard({ name: 'read', arguments: { path: 'E:\\x\\secrets\\note.md' }, agent: plusAgent })
    console.log(`  ${plusCred && plusSecrets ? '✅' : '❌'} MC+ 仍然拒读凭据 / secrets（凭据不变式对两种 MC 模式都生效）`)
    const plusProtected = callGuard({ name: 'write', arguments: { path: 'RULES.md', content: 'x' }, agent: plusAgent })
    const plusPresent = callGuard({ name: 'present', arguments: { files: [{ path: 'E:\\x\\y.png' }] }, agent: plusAgent })
    console.log(`  ${plusProtected === undefined && plusPresent === undefined ? '✅' : '❌'} MC+ 的受保护文件/present **按宿主默认**（插件不再加只读/工作区 guard）`)
    const plusMc = callGuard({ name: 'mc_status', agent: plusAgent })
    console.log(`  ${plusMc === undefined ? '✅' : '❌'} MC+ 的 mc / mc_kit 工具照常放行（与 MC 模式行为一致）`)
    const plainMcDeny = callGuard({ name: 'mc_status', agent: { id: 'sess-P', ctx: plainCtxObj } })
    const plainKitDeny = callGuard({ name: 'mc_kit_express', arguments: { path: 'x.png' }, agent: { id: 'sess-P', ctx: plainCtxObj } })
    const plainAdminOk = callGuard({ name: 'mc_admin_config', agent: { id: 'sess-P', ctx: plainCtxObj } })
    console.log(`  ${plainMcDeny && plainKitDeny ? '✅' : '❌'} 🔴 其他模式调 mc_status / mc_kit_express 被 guard 硬拒（"不再暴露 mc 和 mckit"的第二道锁）`)
    console.log(`  ${plainAdminOk === undefined ? '✅' : '❌'} 其他模式**保留** mc_admin_config（它的用途就是在普通会话里管理）`)
  }

  // ⑤ 会话建立时应用策略：MC 模式 → 工具白名单；MC+ → 不套限制；其他模式 → deny 摘掉 mc/mckit；
  //    提示词投递与这些都解耦（挂在 agent/pre-step，见上面那块）
  const restrictCalls = []
  /** 被**撤销**的 restrict（宿主契约：`restrict()` 返回 disposer；我们切出 MC 模式时必须调它） */
  const restrictReleased = []
  const guidanceCtxs = []
  /**
   * 照抄宿主的 `tools.restrict()` 契约：**名字不认识就抛错**（错误里带 known global tools 清单）。
   * 🔴 这台 preset 只挂了 tool-fs（有 read/write/edit/read_image），**没有** tool-fs-search
   *    ⇒ `glob` / `grep` 不在场 —— 正是这个"在场名单"逼出了 index.js 里那次过滤重试。
   */
  const KNOWN_TOOLS = new Set([
    ...tools.keys(),
    'read', 'write', 'edit', 'read_image',
    'present',
    'job_list', 'job_output', 'job_kill', 'get_goal', 'create_goal', 'update_goal',
    'pwsh', 'subagent', 'workflow', 'web_search', 'todo_write', 'ask_user_question',
    'serve_deploy', 'serve_list', 'goal_write',
  ])
  const makeAgentCtx = (preset) => {
    const base = {}
    presetByCtx.set(base, preset)
    base.get = (k) => (k === 'tools'
      ? {
          restrict: (f) => {
            const names = [...(f.allow ?? []), ...(f.deny ?? [])]
            const unknown = names.filter((n) => !KNOWN_TOOLS.has(n))
            if (unknown.length) {
              throw new Error(`tools.restrict() names unknown global tool${unknown.length > 1 ? 's' : ''} `
                + `${unknown.map((n) => `"${n}"`).join(', ')}; known global tools: ${[...KNOWN_TOOLS].sort().join(', ')}`)
            }
            const call = { preset, f }
            restrictCalls.push(call)
            // 宿主契约：返回**撤销手柄**。切出 MC 模式时我们必须要用它（见 ⑦c）。
            return () => { restrictReleased.push(call) }
          },
        }
      : k === 'systemPrompt'
        ? { context: (c) => { guidanceCtxs.push({ preset, c }); return () => {} } }
        : undefined)
    return base
  }
  const fire = (ev, agent) => eventHandlers.filter((h) => h.ev === ev).forEach((h) => h.fn({ agent }))

  /**
   * 🔴 2026-09-18：提示词的挂载点是 `agent/pre-step`（宿主瀑布）。
   * 替身照抄宿主的调用形状：`(payload, next)`，payload 里带 `{agent, messages, turn, step, signal}`。
   * 返回一条"这个 step 真正交给模型的消息数组"（= claim 到的 + 我们的提示行），便于断言顺序。
   */
  const claimedInbox = (agent) => {
    const claimed = [...agent.inbox.nextStep]
    agent.inbox.nextStep.length = 0
    // 真宿主：claim 之后每条都会变成 `user/message` 事件落进会话日志（这里照抄那个形状）
    for (const m of claimed) (agent.session.events ??= []).push({ type: 'user/message', seq: (agent.session.events?.length ?? 0), data: m })
    return claimed
  }
  /**
   * 🔴 2026-09-18（两次事故）后的替身，**照抄宿主真实契约**：
   *   ① 先 `inbox.claim()` 把这一步的消息领走，**再**跑 `agent/pre-step` 瀑布
   *      （宿主 `agent.ts:244` → `:249`）—— 所以往队列里塞东西，这一步**用不上**；
   *   ② 监听器改写的 `decision.messages` 才是**这一步真正发给模型、并落成会话日志**的那批
   *      （宿主 `agent.ts:373-377`）—— 提示行必须走这里才"当场生效"；
   *   ③ waterfall 必须交棒（`next()`）：不交棒＝否决整条链 ⇒ 宿主 `decision.kind` 崩（P0 事故）；
   *   ④ 宿主给的 `next()` 返回 **Promise**，这里照抄。
   * @returns {Promise<{messages: object[], decision: object}>} 本步真正的消息 + 改写后的 decision
   */
  const firePreStep = async (agent, turn = 1, step = 1) => {
    const claimed = claimedInbox(agent)
    const payload = { agent, messages: claimed, turn, step, signal: new AbortController().signal }
    const inner = { kind: 'enter', messages: claimed }
    let handedOff = false
    let returned
    const next = () => { handedOff = true; return Promise.resolve(inner) }
    for (const h of preStepHandlers()) returned = h.fn(payload, next)
    if (!handedOff) {
      throw new Error('契约违规：agent/pre-step 监听器没有调用 next() —— cordis waterfall 会返回 undefined，'
        + '宿主下一行 decision.kind 直接 TypeError（P0 事故就是这个）')
    }
    const decision = await returned
    if (decision === undefined) {
      throw new Error('契约违规：agent/pre-step 监听器返回了 undefined（应当是 decision）')
    }
    const messages = Array.isArray(decision.messages) ? decision.messages : []
    // 真宿主：`step()` 把**本步消息逐条落成会话日志的 `user/message`**（`agent.ts:373-377`）。
    // 照抄这一步很关键 —— 插件"回读会话日志判已投递"（进程重启后不重复注入）就靠它。
    if (decision.kind === 'enter') {
      for (const m of messages) (agent.session.events ??= []).push({ type: 'user/message', seq: (agent.session.events?.length ?? 0), data: m })
    }
    return { messages, decision }
  }
  /** 只取"这一步真正发出去的消息"（大多数断言只关心这个） */
  const preStepMessages = async (agent, turn = 1, step = 1) => (await firePreStep(agent, turn, step)).messages
  const preStepHandlers = () => eventHandlers.filter((h) => h.ev === 'agent/pre-step')

  /** 忠实的 inbox 替身：照抄宿主 `ReactLoopInbox` 的 append/remove 契约（消息自带 id） */
  const mkInbox = () => {
    const box = {
      nextStep: [],
      append: (target, message) => { if (target === 'next-step') box.nextStep.push(message) },
      prepend: (target, message) => { if (target === 'next-step') box.nextStep.unshift(message) },
      remove: (id) => {
        const i = box.nextStep.findIndex((m) => m?.id === id)
        if (i < 0) return false
        box.nextStep.splice(i, 1)
        return true
      },
    }
    return box
  }
  /** 会话替身：`snapshotEvents()` 是插件回读"这个 preset 到底投过没有"的依据 */
  const mkSession = (prefix) => mkSession2(mkdtempSync(join(tmpdir(), prefix)))
  /** 同上，但用**指定的**工作区目录（自检里后面几段自己提前建好了目录） */
  const mkSession2 = (cwd) => ({
    header: { cwd },
    events: [],
    snapshotEvents() { return this.events },
  })
  const mcAgent = { id: 'sess-MC2', session: mkSession('whale-mc-'), ctx: makeAgentCtx('minecraft'), inbox: mkInbox(), steer: () => { throw new Error('不该走 steer！') } }
  const plainAgent = { id: 'sess-P2', session: mkSession('whale-pl-'), ctx: makeAgentCtx('standard'), inbox: mkInbox() }
  const plusAgent = { id: 'sess-MCP2', session: mkSession('whale-mcp-'), ctx: makeAgentCtx('minecraft-plus'), inbox: mkInbox() }
  fire('agent/created', mcAgent)
  fire('agent/created', plainAgent)
  fire('agent/created', plusAgent)

  const mcRestrict = restrictCalls.find((c) => c.preset === 'minecraft')
  // 🔴 2026-09-16 真机事故的正解：把提示词当**插件提示**投递（宿主自己注入 AGENTS.md 也走 `inbox.nextStep`）
  //    —— 必达（不过 systemPrompt 组装，persona 的 complete/includeRuntimeContext 压不到）
  // 🔴🔴 2026-09-18 挂载点两次改动的最终形态（用户："两个全都是 LLM 运行了一半才后知后觉地注入"）：
  //    投递**不发生在 agent/created**（模式还能改），也**不再塞 inbox 队列**（pre-step 在 claim 之后
  //    才跑，塞队列要等下一步 ⇒ 晚一步）。现在是：在 `agent/pre-step` 里**改写本步消息**
  //    （`decision.messages`），与用户那句**同一批**送出去、并落成会话日志。
  {
    console.log(`  ${mcAgent.inbox.nextStep.length === 0 ? '✅' : '❌'} 🔴 会话建立时**不预投**（队列 ${mcAgent.inbox.nextStep.length} 条）—— 模式在首次请求前还能改，预投就会串模式`)
    console.log(`  ${preStepHandlers().length === 1 ? '✅' : '❌'} 挂上了 agent/pre-step（宿主那条"消息已领走 + 系统提示已装好"的瀑布）`)
    const step1 = await preStepMessages(mcAgent)
    const msgs = step1.filter((m) => String(m?.source?.kind ?? '') === 'plugin:whale_craft')
    const queuedAfterStep1 = mcAgent.inbox.nextStep.filter((m) => String(m?.source?.kind ?? '') === 'plugin:whale_craft').length
    const first = msgs[0]
    const second = msgs[1]
    console.log(`  ${msgs.length === 2 ? '✅' : '❌'} 🔴 首次请求组装前投递 2 条（${msgs.length} 条：行事准则 + 版本提示）`)
    console.log(`  ${msgs.length === 2 && first === step1[0] ? '✅' : '❌'} 提示行排在本 step 消息的**最前面**（模型先看到规矩，再看用户那句）`)
    console.log(`  ${msgs.length === 2 && queuedAfterStep1 === 0 ? '✅' : '❌'} 🔴 提示行是**本步改写**送出去的（没有走"塞队列、下一步才领"那条晚一步的老路；队列残留 ${queuedAfterStep1} 条）`)
    console.log(`  ${first?.source?.kind === 'plugin:whale_craft' && first?.source?.plugin === undefined && first?.source?.form === 'notice' ? '✅' : '❌'} 🔴 来源是 plugin:whale_craft/notice（**不是**用户发言；v4 规范形态不带旧 plugin 字段）：${JSON.stringify(first?.source ?? null)}`)
    const body = (first?.content ?? []).map((c) => c.text ?? '').join('')
    console.log(`  ${/Whale Craft 行事准则/.test(body) && /Master/.test(body) ? '✅' : '❌'} 第 1 条 = 行事准则（${body.length} 字），首行写明文件：${JSON.stringify(body.split('\n')[0])}`)
    console.log(`  ${/^Instructions from: \.whale-craft\/RULES\.md$/.test(body.split('\n')[0] ?? '') ? '✅' : '❌'} 正文首行是 "Instructions from: .whale-craft/RULES.md"（与 DSH 原生同形状）`)
    // 第 2 条 = **版本硬提示词**（硬编码、随版本发布、无开关、排在行事准则之后）
    const bodyV = (second?.content ?? []).map((c) => c.text ?? '').join('')
    console.log(`  ${second?.source?.form === 'notice' && /^Instructions from: whale_craft@/.test(bodyV.split('\n')[0] ?? '') ? '✅' : '❌'} 第 2 条 = 版本提示（来源行 ${JSON.stringify((bodyV.split('\n')[0] ?? '').slice(0, 46))}…）`)
    console.log(`  ${/mc_move/.test(bodyV) && /mc_command/.test(bodyV) && /\/setblock/.test(bodyV) ? '✅' : '❌'} 版本提示正文点了工具名与指令名（mc_move / mc_command / /setblock）`)
    console.log(`  ${/可以先试一次/.test(bodyV) && /被白名单或权限拒绝/.test(bodyV) ? '✅' : '❌'} 第 1 条保留"先试一次、被拒再退"（不然模型有权限也不敢用指令）`)
    console.log(`  ${/生存、冒险/.test(bodyV) && /明确告知用户/.test(bodyV) ? '✅' : '❌'} 第 2 条讲清本版本能力短板（生存/冒险极弱，先告知用户再尽力）`)
    console.log(`  ${!/mc_kit_express/.test(bodyV) && !/\.whale-craft\/\.express\//.test(bodyV) ? '✅' : '❌'} 🔴 交付/文件分享流程已移出版本提示（归 mc_kit_express 工具说明）`)
    console.log(`  ${/^1\./m.test(bodyV) && /^2\./m.test(bodyV) && !/^3\./m.test(bodyV) ? '✅' : '❌'} 正文就是两条（用户："别的属实多余了"）`)
    // 选项 A（用户 2026-09-16 定）：**正文里不写版本号** —— 版本由来源行与折叠标题携带
    console.log(`  ${!/v\d+\.\d+\.\d+/.test(bodyV.replace(/^Instructions from: [^\n]*\n+/, '')) ? '✅' : '❌'} 🔴 正文里没有版本号（版本只在来源行与折叠标题里；哈希只标记正文本身）`)
    console.log(`  ${/^Instructions from: whale_craft@\d+\.\d+\.\d+/.test(bodyV) ? '✅' : '❌'} 版本由来源行携带：${JSON.stringify((bodyV.split('\n')[0] ?? '').slice(0, 44))}`)
    const vTitle = String(second?.source?.summary ?? '')
    console.log(`  ${/v\d+\.\d+\.\d+/.test(vTitle) && /（[0-9a-f]{8}）$/.test(vTitle) ? '✅' : '❌'} 折叠标题带版本号 + 短哈希：${vTitle}`)
    console.log(`  ${plainAgent.inbox.nextStep.length === 0 ? '✅' : '❌'} 普通会话**不投递**（只有 MC 模式才投）`)
    const plainStep = await preStepMessages(plainAgent)
    console.log(`  ${plainStep.filter((m) => m?.source?.kind === 'plugin:whale_craft').length === 0 ? '✅' : '❌'} 🔴 普通会话**走到请求组装前**也一条都不投（现场判 preset，不靠"当时是 MC 就永久算数"）`)
    const inboxBefore = mcAgent.inbox.nextStep.length
    fire('agent/session-start', mcAgent)
    console.log(`  ${mcAgent.inbox.nextStep.length === inboxBefore ? '✅' : '❌'} agent/session-start 不再重复入队（投递已不在这个时机）`)
    // 🔴 2026-10-06：删掉「MC+ 模式说明」——模式差异改由 persona 承载（声明式 preset），
    //    不再靠一条自造 notice。MC+ 会话与 MC 会话一样只投 2 条（行事准则 + 版本提示）。
    const plusStep = await preStepMessages(plusAgent)
    const plusMsgs = plusStep.filter((m) => m?.source?.kind === 'plugin:whale_craft')
    console.log(`  ${plusMsgs.length === 2 ? '✅' : '❌'} 🔴 MC+ 会话也只投 2 条（不再有「MC+ 模式说明」；实际 ${plusMsgs.length} 条）`)
    console.log(`  ${!plusMsgs.some((m) => /（MC\+ 模式说明）/.test(String(m?.source?.summary ?? ''))) ? '✅' : '❌'} 投递里不再出现「MC+ 模式说明」`)
    console.log(`  ${msgs.length === 2 ? '✅' : '❌'} MC 会话仍是 2 条`)
  }
  // 🔴🔴 用户 2026-09-16 真机投诉："这个 agent 怎么还能用 pwsh！不是只暴露我们指定的工具吗！"
  //    旧实现：allowOtherTools 默认为空 ⇒ 只 deny 了我们的管理工具，宿主那堆工具（pwsh/subagent/…）
  //    **全都还在**。现在**无条件白名单** —— 这条断言就是防它退回去。
  const allowList = mcRestrict?.f?.allow ?? null
  const denyList = mcRestrict?.f?.deny ?? []
  console.log(`  ${Array.isArray(allowList) ? '✅' : '❌'} MC 模式走的是**白名单**（restrict({allow})），不是"只藏自家工具"${allowList ? `（${allowList.length} 个）` : ''}`)
  console.log(`  ${allowList && !allowList.includes('pwsh') && !allowList.includes('subagent') && !allowList.includes('workflow') ? '✅' : '❌'} 🔴 白名单里**没有** pwsh / subagent / workflow：${JSON.stringify((allowList ?? []).slice(0, 6))}…`)
  console.log(`  ${allowList && allowList.includes('mc_status') && allowList.includes('mc_kit_image') && allowList.includes('mc_kit_fs') && allowList.includes('mc_build') ? '✅' : '❌'} 自己的工具还在（mc_status / mc_kit_image / mc_kit_fs / mc_build）`)
  console.log(`  ${allowList && allowList.every((n) => !n.startsWith('mc_admin_')) ? '✅' : '❌'} 管理工具不在白名单里（hideAdminTools 默认 true）`)
  console.log(`  ${allowList && ['read', 'write', 'edit', 'read_image'].every((n) => allowList.includes(n)) ? '✅' : '❌'} 在场的文件工具在白名单里（路径由 guard 限在 .whale-craft/）`)
  console.log(`  ${allowList && !allowList.includes('present') ? '✅' : '❌'} 🔴 present **不在**白名单里（MC 模式不暴露文件交付；走 mc_kit_express）`)
  console.log(`  ${allowList && ['job_list', 'job_output', 'job_kill', 'get_goal', 'create_goal', 'update_goal', 'todo_write'].every((n) => allowList.includes(n)) ? '✅' : '❌'} 🔴 后台任务/目标/待办（job_* / goal_* / todo_write）按 dsh-tools.md 进入了白名单`)
  // 🔴 2026-10-08「允许联网搜索」（默认开）：开 → web_search 进白名单；关 → 不进 + guard 硬拒
  console.log(`  ${allowList && allowList.includes('web_search') ? '✅' : '❌'} 🔴 默认（开关开）白名单**含** web_search`)
  {
    const before = restrictCalls.length
    await tools.get('mc_admin_config').execute({ action: 'set', path: 'allowWebSearch', value: false }, A)
    const offAgent = { id: 'sess-MC-NOWEB', session: mkSession('whale-mcnoweb-'), ctx: makeAgentCtx('minecraft'), inbox: mkInbox() }
    fire('agent/created', offAgent)
    const offAllow = restrictCalls.slice(before).find((c) => c.preset === 'minecraft')?.f?.allow ?? null
    console.log(`  ${Array.isArray(offAllow) && !offAllow.includes('web_search') ? '✅' : '❌'} 🔴 开关关掉后新建的 MC 会话白名单**不含** web_search${offAllow ? `（${offAllow.length} 个）` : ''}`)
    const offGuard = callGuard({ name: 'web_search', arguments: {}, agent: { id: 'sess-MC-NOWEB', ctx: makeAgentCtx('minecraft') } })
    console.log(`  ${/联网搜索未启用/.test(String(offGuard)) ? '✅' : '❌'} 🔴 开关关掉后 guard 硬拒 web_search：${String(offGuard).slice(0, 30)}`)
    const plainWeb = callGuard({ name: 'web_search', arguments: {}, agent: { id: 'sess-P3', ctx: makeAgentCtx('standard') } })
    console.log(`  ${plainWeb === undefined ? '✅' : '❌'} 联网搜索开关**不误伤普通会话**（标准模式的 web_search 照常）`)
    // MC+ 不受本开关影响（不套白名单 ⇒ 不经过这条 allow 列表）
    const plusOffAgent = { id: 'sess-MCP-NOWEB', session: mkSession('whale-mcpnoweb-'), ctx: makeAgentCtx('minecraft-plus'), inbox: mkInbox() }
    fire('agent/created', plusOffAgent)
    console.log(`  ${restrictCalls.slice(before).every((c) => !(c.preset === 'minecraft-plus' && Array.isArray(c.f?.allow))) ? '✅' : '❌'} 🔴 开关关掉后 MC+ 仍**不套白名单**（web_search 照常可见）`)
    await tools.get('mc_admin_config').execute({ action: 'unset', path: 'allowWebSearch' }, A)
  }
  // 🔴 2026-10-08「网页抓取」（默认关）：关 → 不进白名单；开 → 进
  console.log(`  ${allowList && !allowList.includes('mc_kit_web_fetch') ? '✅' : '❌'} 🔴 默认（抓取开关关）白名单**不含** mc_kit_web_fetch`)
  {
    const before = restrictCalls.length
    await tools.get('mc_admin_config').execute({ action: 'set', path: 'webFetchEnabled', value: true }, A)
    const onAgent = { id: 'sess-MC-FETCH', session: mkSession('whale-mcfetch-'), ctx: makeAgentCtx('minecraft'), inbox: mkInbox() }
    fire('agent/created', onAgent)
    const onAllow = restrictCalls.slice(before).find((c) => c.preset === 'minecraft')?.f?.allow ?? null
    console.log(`  ${Array.isArray(onAllow) && onAllow.includes('mc_kit_web_fetch') ? '✅' : '❌'} 🔴 抓取开关打开后新建的 MC 会话白名单**含** mc_kit_web_fetch`)
    await tools.get('mc_admin_config').execute({ action: 'unset', path: 'webFetchEnabled' }, A)
  }
  // 🔴 宿主对不认识的名字**抛错**；要是直接放弃，隔离就等于没做（pwsh 又回来了）
  console.log(`  ${allowList && !allowList.includes('glob') && !allowList.includes('grep') ? '✅' : '❌'} 🔴 不在场的工具（这台 preset 没挂 tool-fs-search ⇒ glob/grep）被过滤掉，**不是**整次白名单作废`)
  console.log(`  ${allowList && allowList.length > 5 ? '✅' : '❌'} 过滤后白名单仍然生效（${allowList?.length ?? 0} 个）`)
  console.log(`  ${denyList.length === 0 ? '✅' : '❌'} 不再用黑名单模式（deny=[]）`)
  // 🔴 2026-09-16：**一个 systemPrompt 段都不注册**了（用户："系统提示词不用显式注入"）。
  //    这条断言就是防回归：以后谁再往 systemPrompt 里塞东西，这里会红。
  console.log(`  ${guidanceCtxs.length === 0 ? '✅' : '❌'} MC 模式也不注册 systemPrompt 段（实际 ${guidanceCtxs.length} 段）—— 提示词只走插件提示行`)
  // 🔴 2026-10-04 用户定："除了 MC模式 和 MC+模式，不再给其他模式暴露 mc 和 mckit 工具" ——
  //    其他模式套 **deny**（摘掉 mc_* / mc_kit_*；mc_admin_* 例外，它的用途就是在普通会话里管理）。
  {
    const stdCalls = restrictCalls.filter((c) => c.preset === 'standard')
    const stdDeny = stdCalls.find((c) => Array.isArray(c.f?.deny))
    console.log(`  ${stdDeny && stdDeny.f.allow === undefined ? '✅' : '❌'} 非 MC 模式的会话套的是 **deny**（不是白名单）：宿主工具面不受影响`)
    console.log(`  ${stdDeny && stdDeny.f.deny.includes('mc_status') && stdDeny.f.deny.includes('mc_kit_image') && stdDeny.f.deny.includes('mc_kit_fs') ? '✅' : '❌'} deny 里含 mc_* / mc_kit_*（从可见面摘掉）`)
    console.log(`  ${stdDeny && !stdDeny.f.deny.includes('mc_admin_config') && stdDeny.f.deny.every((n) => n.startsWith('mc_')) ? '✅' : '❌'} 🔴 deny 里**不含** mc_admin_*、也不含任何非 mc 工具（不误伤普通会话）`)
    // 2026-10-05：MC+ 仍**不套白名单**（标准工具 + mc/mckit 全量）；只在调试开关关时 deny 掉 mc_debug_*
    const plusCalls = restrictCalls.filter((c) => c.preset === 'minecraft-plus')
    const plusAllow = plusCalls.some((c) => Array.isArray(c.f?.allow))
    const plusDeny = plusCalls.find((c) => Array.isArray(c.f?.deny))?.f?.deny ?? []
    console.log(`  ${!plusAllow ? '✅' : '❌'} 🔴 MC+ 模式**不套白名单**（标准工具全量 + mc/mckit 全量可见）`)
    console.log(`  ${plusDeny.length > 0 && plusDeny.every((n) => n.startsWith('mc_debug_')) ? '✅' : '❌'} 🔴 MC+ 只在「调试开关关」时 deny 调试工具（${plusDeny.join(', ') || '无'}）`)
  }
  // 🔴 2026-09-18 去重（新挂载点）：同一个 MC 会话**每一轮**都会走到 pre-step，
  //    但提示词只该进一次 —— 幂等靠"按 preset 记账 + 会话日志回读"。
  {
    // 第 1 步已经把它们与用户那句**同批**送出去了（上面 step1 那几条断言）；
    // 这一步验证"之后不再重复投"。
    const consumed = (await preStepMessages(mcAgent, 2, 1)).filter((m) => m?.source?.kind === 'plugin:whale_craft')
    console.log(`  ${consumed.length === 0 ? '✅' : '❌'} 🔴 第 2 轮**不再重复投递**（实际 ${consumed.length} 条）—— 按 preset 记账生效`)
    const again2 = (await preStepMessages(mcAgent, 2, 2)).filter((m) => m?.source?.kind === 'plugin:whale_craft')
    console.log(`  ${again2.length === 0 ? '✅' : '❌'} 同一轮的第 2 个 step 也不重复投（工具循环里不会刷屏）`)
    const queueLeft = mcAgent.inbox.nextStep.filter((m) => m?.source?.kind === 'plugin:whale_craft').length
    console.log(`  ${queueLeft === 0 ? '✅' : '❌'} 🔴 队列里**不留**我们的提示行（不留 = 不会晚一步再送一遍，也不会串到别的模式）`)
  }

  /* ⑦ 🔴🔴 2026-09-16 真机事故回归（两轮）：提示词必须**必达 + 看得见**。
   *    第一轮事故：段注册绑在"那一刻是 MC 模式"上 → preset 晚选上就永远不注册。
   *    第二轮事故（更狠）：只走 `systemPrompt.context()` —— 复制官方 `minimal` 带来的 persona
   *    （`complete: true` / `includeRuntimeContext: false`）会让宿主把 context 段**整个丢掉**
   *    → "设置页显示正常、AI 却什么都没收到"。现在照宿主的做法投**插件提示行**。 */
  const lateAgent = {
    id: 'sess-LATE',
    session: mkSession('whale-late-'),
    ctx: makeAgentCtx(undefined),
    inbox: mkInbox(),
  }
  fire('agent/created', lateAgent)                                  // 建的时候还没选 mode
  console.log(`  ${lateAgent.inbox.nextStep.length === 0 ? '✅' : '❌'} preset 未知时不投递（不误注入）`)
  presetByCtx.set(lateAgent.ctx, 'minecraft')                       // ← "用户选了 MC模式"
  fakeCtx.agents = { get: (id) => (id === 'sess-LATE' ? lateAgent : id === 'sess-MC2' ? mcAgent : id === 'sess-P2' ? plainAgent : undefined) }
  eventHandlers.filter((h) => h.ev === 'agent-preset/selected').forEach((h) => h.fn('sess-LATE', 'minecraft'))
  console.log(`  ${lateAgent.inbox.nextStep.length === 0 ? '✅' : '❌'} 🔴 切模式那一刻**不投**（此时用户可能又切走；投递点搬到请求组装前）`)
  const lateStep = await preStepMessages(lateAgent)
  const lateMsgs = lateStep.filter((m) => m?.source?.kind === 'plugin:whale_craft')
  const lateBody = (lateMsgs[0]?.content ?? []).map((c) => c.text ?? '').join('')
  console.log(`  ${/Whale Craft 行事准则/.test(lateBody) ? '✅' : '❌'} 🔴 模式晚选上后，**首次请求组装前**照样投得到（${lateMsgs.length} 条 / ${lateBody.length} 字）—— 就是那个 bug`)
  console.log(`  ${lateMsgs.length === 2 ? '✅' : '❌'} 补投递没有重复（行事准则 + 版本提示，各一条）`)
  // ⚠️ 2026-10-04：晚选之前它是"非 MC"档（先 deny 摘 mc/mckit），选上后换白名单 ——
  //    同一个 ctx 会有**两条** restrict 记录，这里挑带 allow 的那条。
  const lateCalls = restrictCalls.filter((c) => c.preset === undefined)
  const lateRestrict = lateCalls.find((c) => Array.isArray(c.f?.allow))
  console.log(`  ${!!lateRestrict && !lateRestrict.f.allow.includes('pwsh') ? '✅' : '❌'} 模式晚选上时工具白名单也补上了（allow 有 ${lateRestrict?.f?.allow?.length ?? 0} 个、无 pwsh）`)
  console.log(`  ${lateCalls.some((c) => Array.isArray(c.f?.deny)) ? '✅' : '❌'} 选模式之前它是"非 MC"档（先 deny 过 mc/mckit，选上后换白名单）`)
  console.log(`  ${eventHandlers.some((h) => h.ev === 'agent-preset/selected') ? '✅' : '❌'} 挂了宿主的 agent-preset/selected 事件（会话里切模式才生效）`)

  /* ⑦c 🔴🔴 2026-09-17 真机事故（用户报的"标准模式会话无法执行命令"）：**从 MC模式 切回普通模式时，
   *    工具白名单必须撤销**。`tools.restrict()` 是**黏**的（挂在 agent scope 上，会话不死就不消失），
   *    而老代码只"套用"、从不撤销（返回的 disposer 直接丢了）⇒ 切回标准模式的会话永久留在 MC 白名单里
   *    （没有 pwsh/bash，连 shell 都没有）。
   *    真机复现 `session-55d48701`：建会话 standard → 04:51:47 切 minecraft（白名单生效）
   *    → 06:34:20 切回 standard → 之后那个"标准模式"会话还是 mc_* + read/write/edit/read_image，
   *    它在记录里写"My list definitely has no bash. So how do I run commands?"，只能让子代理替它跑命令。 */
  {
    const switchTo = (preset, agent = lateAgent) => {
      presetByCtx.set(agent.ctx, preset)
      eventHandlers.filter((h) => h.ev === 'agent-preset/selected').forEach((h) => h.fn(agent.id, preset))
    }
    const applied = restrictCalls.at(-1)                 // ⑦ 里那次"晚选上 MC模式"套的白名单
    const releasedBefore = restrictReleased.length
    switchTo('standard')
    console.log(`  ${restrictReleased.length === releasedBefore + 1 && restrictReleased.at(-1) === applied ? '✅' : '❌'} 🔴 切回普通模式**撤销**了工具白名单（pwsh/命令工具回来了）`)
    console.log(`  ${lateAgent.inbox.nextStep.length === 0 ? '✅' : '❌'} 🔴 切回普通模式后队列里没有我们的提示词（${lateAgent.inbox.nextStep.length} 条）`)
    const afterSwitchOut = (await preStepMessages(lateAgent, 3, 1)).filter((m) => m?.source?.kind === 'plugin:whale_craft')
    console.log(`  ${afterSwitchOut.length === 0 ? '✅' : '❌'} 🔴🔴 切回普通模式后**走到请求组装前也一条都不投**（${afterSwitchOut.length} 条）—— "标准模式里冒出 MC 提示词"从根上不可能`)
    const callsBefore = restrictCalls.length
    switchTo('minecraft')
    const reapplied = restrictCalls.at(-1)
    console.log(`  ${restrictCalls.length === callsBefore + 1 ? '✅' : '❌'} 再切回 MC模式 重新套上白名单（撤销 ≠ 以后不再管）：allow ${reapplied?.f?.allow?.length ?? 0} 个`)
    console.log(`  ${Array.isArray(reapplied?.f?.allow) && !reapplied.f.allow.includes('pwsh') ? '✅' : '❌'} 重新套上的仍然是白名单（没有 pwsh）`)
    const backToMc = (await preStepMessages(lateAgent, 4, 1)).filter((m) => m?.source?.kind === 'plugin:whale_craft')
    console.log(`  ${backToMc.length === 2 ? '✅' : '❌'} 再切回 MC模式 后**请求前重新投递**提示词（实际 ${backToMc.length} 条；队列里那批已被切出时清掉，所以必须重投）`)
    await preStepMessages(lateAgent, 5, 1)                                    // 宿主领走
    const backToMcAgain = (await preStepMessages(lateAgent, 6, 1)).filter((m) => m?.source?.kind === 'plugin:whale_craft')
    console.log(`  ${backToMcAgain.length === 0 ? '✅' : '❌'} 重投之后又是幂等的（第 6 轮 ${backToMcAgain.length} 条，没刷屏）`)
    switchTo('standard')                                 // 收尾：留成普通模式
    console.log(`  ${restrictReleased.at(-1) === reapplied ? '✅' : '❌'} 套用与撤销一一对应（每次套的都撤掉了）`)
    console.log(`  ${lateAgent.inbox.nextStep.length === 0 ? '✅' : '❌'} 再切出也把待投递提示词清干净（${lateAgent.inbox.nextStep.length} 条）`)

    /* 已经**投递过**的（进了对话历史、摘不掉）在**重启后**也不能重投：
     * 台账是进程内的，宿主一重启就没了 —— 靠**回读会话日志**认出来。（老代码在这里会重复注入。） */
    const deliverAgent = { id: 'sess-DELIVERED', session: mkSession('whale-dlv-'), ctx: makeAgentCtx('minecraft'), inbox: mkInbox() }
    fakeCtx.agents = { get: (id) => (id === 'sess-DELIVERED' ? deliverAgent : id === 'sess-LATE' ? lateAgent : undefined) }
    fire('agent/created', deliverAgent)
    const firstRound = (await preStepMessages(deliverAgent, 1, 1)).filter((m) => m?.source?.kind === 'plugin:whale_craft')
    console.log(`  ${firstRound.length === 2 ? '✅' : '❌'} （前置）首次请求投了 2 条（实际 ${firstRound.length}）`)
    // 宿主把队列领走 → 这 2 条进了**会话日志**（之后台账丢掉也不该重投）
    await preStepMessages(deliverAgent, 2, 1)
    // 模拟"宿主重启 / 插件重载"：台账随进程消失，只剩会话日志
    const reborn = {
      id: deliverAgent.id,
      session: { header: deliverAgent.session.header, events: deliverAgent.session.events, snapshotEvents() { return this.events } },
      ctx: makeAgentCtx('minecraft'),
      inbox: mkInbox(),
    }
    fakeCtx.agents = { get: (id) => (id === 'sess-DELIVERED' ? reborn : undefined) }
    fire('agent/created', reborn)
    const afterRestart = (await preStepMessages(reborn, 1, 1)).filter((m) => m?.source?.kind === 'plugin:whale_craft')
    console.log(`  ${afterRestart.length === 0 ? '✅' : '❌'} 🔴 进程重启后**不重复投递**（回读会话日志认出已投过；实际 ${afterRestart.length} 条）`)
    // 静态防回归：撤销路径的三块拼图必须在源码里（谁删了这里就红）
    const srcIdx = (await import('node:fs')).readFileSync(new URL('./index.js', import.meta.url), 'utf8')
    console.log(`  ${/const mcRestrictRelease = new WeakMap\(\)/.test(srcIdx) && /const liftMcModePolicy = \(agent\)/.test(srcIdx) ? '✅' : '❌'} 源码里有撤销路径（mcRestrictRelease + liftMcModePolicy）`)
    console.log(`  ${/if \(isMcModeAgent\(agent\)\) applyMcModePolicy\(agent\)[\s\S]{0,80}else liftMcModePolicy\(agent\)/.test(srcIdx) ? '✅' : '❌'} touch() 是**双向**的（是 MC 就套、不是就撤）`)
    console.log(`  ${/mcRestrictRelease\.set\(agent, release\)/.test(srcIdx) ? '✅' : '❌'} 套用时**存下** disposer（不存就没法撤）`)
    console.log(`  ${/const deliveredRelsFor = \(agent, rels\)/.test(srcIdx) ? '✅' : '❌'} 源码里有"回读会话日志判已投递"（deliveredRelsFor）`)
  }

  /* ⑦d 🔴🔴 2026-09-18 **P0**：连一个不存在的服务器 → `Unhandled 'error' event` → **整个 DSH 进程死**。
   *    事故原文：`Error: connect ECONNREFUSED 127.0.0.1:61631` / `Emitted 'error' event on McBot instance
   *    at: src/core.mjs:671` / `node:events:486 throw er; // Unhandled 'error' event`。
   *    根因：`McBot extends EventEmitter`，而 **emit('error') 没监听者时 EventEmitter 自己就 throw**
   *    —— 老写法 `b.on('error', e => this.emit('error', e))` 把 bot 的网络错误转发到没人听的 McBot 上。
   *    另一处 `try { this.emit('error', err) } catch {}` 是**假保护**（抛的就是这次 emit）。
   *    这里做**真连接**验证（子进程里跑，连一个必然被拒的端口），断言进程不被带走。 */
  {
    const { readFileSync: rd } = await import('node:fs')
    const coreSrc = rd(new URL('./src/core.mjs', import.meta.url), 'utf8')
    console.log(`  ${/if \(this\.listenerCount\('error'\) > 0\) this\.emit\('error', err\)/.test(coreSrc) ? '✅' : '❌'} 🔴 上报错误前先看有没有监听者（EventEmitter 无监听者时 emit('error') 会直接 throw）`)
    console.log(`  ${/#reportError \(e\)/.test(coreSrc) ? '✅' : '❌'} 有统一错误上报口 #reportError（lastError + 日志 + 受保护的 emit）`)
    // 找"代码里"的裸 emit：排除注释（注释里会引用事故原文，那是记录不是代码）
    const codeOnly = coreSrc.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    const bareEmits = (codeOnly.match(/this\.emit\('error'/g) ?? []).length
    const guarded = (codeOnly.match(/if \(this\.listenerCount\('error'\) > 0\) this\.emit\('error', err\)/g) ?? []).length
    console.log(`  ${bareEmits === guarded && bareEmits > 0 ? '✅' : '❌'} 🔴 代码里每一处 this.emit('error') 都带"有监听者才发"的保护（emit ${bareEmits} 处 / 受保护 ${guarded} 处）`)

    // 真连接：连一个刚关掉的端口（必然 ECONNREFUSED），**故意不订阅 'error'**（真实工具路径就是这样）
    const { createServer } = await import('node:net')
    const probeSrv = createServer()
    await new Promise((r) => probeSrv.listen(0, '127.0.0.1', r))
    const deadPort = probeSrv.address().port
    await new Promise((r) => probeSrv.close(r))
    const { McBot } = await import('./src/core.mjs')
    const probeBot = new McBot({ instanceId: 'selftest-refused' })
    let refusedErr = null
    try {
      await probeBot.connect({ host: '127.0.0.1', port: deadPort, version: '1.20.4', auth: { mode: 'offline', name: 'ProbeBot' } })
    } catch (e) { refusedErr = e }
    await new Promise((r) => setTimeout(r, 600))     // 给 socket error 冒出来的时间（事故里它是延迟 emit 的）
    console.log(`  ${refusedErr !== null ? '✅' : '❌'} 连不存在的服务器：以**普通错误**结束（工具能返回给模型）`)
    console.log(`  ${/ECONNREFUSED|连接|refused|超时/i.test(String(refusedErr?.message ?? '') + String(probeBot.lastError ?? '')) ? '✅' : '❌'} 错误文本能说清（${String(probeBot.lastError ?? refusedErr?.message ?? '').slice(0, 48)}）`)
    try { probeBot.stop?.('自检结束') } catch { /* 收尾失败无所谓 */ }
    console.log('  ✅ 🔴 走到这里就说明**进程没被 Unhandled \'error\' 带走**（否则自检当场崩，后面的断言一条都不会跑）')
  }


  /* ⑧ 🔴 用户："插件初始化就要检查 `.whale-craft` 是否存在，不存在则建立；README.md 是否存在，
   *    不存在则写入默认值。"（AGENTS.md 同理：提示词页编辑的就是这个文件，文件必须先在） */
  /** 没工作区的 MC 会话替身：在块外声明，好让后面的 `/api/mc/mode` agent 替身能引用到 */
  let noWs
  {
    const { mkdtempSync, existsSync, readFileSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const ws = mkdtempSync(join(tmpdir(), 'whale-ws-'))
    const seedAgent = { id: 'sess-SEED', session: mkSession2(ws), ctx: makeAgentCtx('minecraft'), inbox: mkInbox() }
    fire('agent/created', seedAgent)
    const wsRoot = join(ws, '.whale-craft')
    const wsAgents = join(wsRoot, 'RULES.md')
    const wsReadme = join(wsRoot, 'README.md')
    console.log(`  ${existsSync(wsRoot) ? '✅' : '❌'} 初始化就建出 <工作区>/.whale-craft/（${wsRoot}）`)
    console.log(`  ${existsSync(wsAgents) ? '✅' : '❌'} 顺手把 RULES.md 建出来（「提示词」页编辑的就是它）`)
    console.log(`  ${existsSync(wsReadme) ? '✅' : '❌'} README.md 不存在则写入默认骨架`)
    const seeded = existsSync(wsAgents) ? readFileSync(wsAgents, 'utf8') : ''
    console.log(`  ${/Whale Craft 行事准则/.test(seeded) && /mc_capabilities/.test(seeded) ? '✅' : '❌'} 建出来的 RULES.md = 内置默认全文（${seeded.length} 字）`)
    // 🔴 2026-10-03：同一时机也备好工作区 config.json（schema:1 + 版本同步落进去）
    const wsCfgPath0 = join(wsRoot, 'config.json')
    const wsCfg0 = existsSync(wsCfgPath0) ? JSON.parse(readFileSync(wsCfgPath0, 'utf8')) : null
    console.log(`  ${wsCfg0?.schema === 1 && typeof wsCfg0.rulesVersion === 'string' && wsCfg0.rulesVersion.length > 0 ? '✅' : '❌'} 🔴 同时建出工作区 config.json（schema:1 + rulesVersion=当前版本）`)
    writeFileSync(wsAgents, 'Master 手工改过的内容\n', 'utf8')
    fire('agent/session-start', seedAgent)
    console.log(`  ${/Master 手工改过的内容/.test(readFileSync(wsAgents, 'utf8')) ? '✅' : '❌'} 已存在的 RULES.md 不会被初始化覆盖`)
    // 🔴 用户 2026-09-16："如果启动对话时设置要求注入，但是找不到文件，那就注入默认，同时重建文件。"
    //    现在这条发生在**投递时**（inbox 提示）：删掉文件、再起一个新会话 → 文件被重建 + 投递默认全文
    const { unlinkSync } = await import('node:fs')
    unlinkSync(wsAgents)
    const seedAgent2 = { id: 'sess-SEED2', session: mkSession2(ws), ctx: makeAgentCtx('minecraft'), inbox: mkInbox() }
    fire('agent/created', seedAgent2)
    const rebuiltBody = ((await preStepMessages(seedAgent2)).filter((m) => m?.source?.kind === 'plugin:whale_craft')[0]?.content ?? [])
      .map((c) => c.text ?? '').join('')
    console.log(`  ${existsSync(wsAgents) ? '✅' : '❌'} 投递时发现文件不在 → **重建**了文件`)
    console.log(`  ${/Whale Craft 行事准则/.test(rebuiltBody) ? '✅' : '❌'} 同时投递默认全文（${rebuiltBody.length} 字）—— 不允许"要求注入却什么都没有"`)

    // 🔴 2026-10-03 迁移走完整 ensure 流程：旧 `.rules-version` 并入 config.json 后删除；
    //    版本=当前（from==to）时不动 RULES.md（版本不同要替换的语义由上面的单元用例覆盖）
    {
      const { mkdirSync, renameSync } = await import('node:fs')
      const wsMig = mkdtempSync(join(tmpdir(), 'whale-wsmig-'))
      mkdirSync(join(wsMig, '.whale-craft'), { recursive: true })
      writeFileSync(join(wsMig, '.whale-craft', 'RULES.md'), '# 老工作区自定义准则\n', 'utf8')
      const curVer = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
      writeFileSync(join(wsMig, '.whale-craft', '.rules-version'), curVer + '\n', 'utf8')
      const migAgent = { id: 'sess-MIG', session: mkSession2(wsMig), ctx: makeAgentCtx('minecraft'), inbox: mkInbox() }
      fire('agent/created', migAgent)
      const migCfg = JSON.parse(readFileSync(join(wsMig, '.whale-craft', 'config.json'), 'utf8'))
      console.log(`  ${migCfg.rulesVersion === curVer && !existsSync(join(wsMig, '.whale-craft', '.rules-version')) ? '✅' : '❌'} 🔴 旧 .rules-version 已迁入 config.json 并删除（完整 ensure 流程）`)
      console.log(`  ${/老工作区自定义准则/.test(readFileSync(join(wsMig, '.whale-craft', 'RULES.md'), 'utf8')) ? '✅' : '❌'} 版本一致 → 迁移不动既有 RULES.md`)

      // 🔴 migrateWorkspaceState 判别：按工作区的**新格式** config.json 不该被当 ≤0.3.x 遗留搬走
      const stateCfg = join(process.env.WHALE_CRAFT_DIR, 'config.json')
      const stateBak = stateCfg + '.selfcheck-bak'
      const hadState = existsSync(stateCfg)
      if (hadState) renameSync(stateCfg, stateBak)      // 制造"stateDir 还没有全局配置"的条件（遗留判定才可能触发）
      try {
        const wsNew = mkdtempSync(join(tmpdir(), 'whale-mignew-'))
        mkdirSync(join(wsNew, '.whale-craft'), { recursive: true })
        writeFileSync(join(wsNew, '.whale-craft', 'config.json'), '{"schema":1,"rulesVersion":"9.0.0"}\n', 'utf8')
        const newAgent = { id: 'sess-MIGNEW', session: mkSession2(wsNew), ctx: makeAgentCtx('minecraft'), inbox: mkInbox() }
        fire('agent/created', newAgent)
        const notMoved = existsSync(join(wsNew, '.whale-craft', 'config.json')) && !existsSync(stateCfg)
        console.log(`  ${notMoved ? '✅' : '❌'} 🔴 新格式的工作区 config.json 不会被打扫遗留的迁移搬走（防再犯：它在旧逻辑下会被搬空）`)
      } finally {
        if (hadState) renameSync(stateBak, stateCfg)
        else { try { const { unlinkSync: ul } = await import('node:fs'); ul(stateCfg) } catch { /* 没被误建 */ } }
      }
    }

    // 🔴 用户 2026-09-16 改的**时机**：不是"启动时对每个会话建"，而是
    //    ① 首次发起 MC 模式会话 ② 点开「MC设置」——**别的时候（比如普通会话）不许建**。
    const ws2 = mkdtempSync(join(tmpdir(), 'whale-ws2-'))
    const plainWithWs = { id: 'sess-PLAINWS', session: { header: { cwd: ws2 } }, ctx: makeAgentCtx('standard') }
    fire('agent/created', plainWithWs)
    fire('agent/session-start', plainWithWs)
    console.log(`  ${!existsSync(join(ws2, '.whale-craft')) ? '✅' : '❌'} 🔴 普通会话**不会**被建 .whale-craft/（时机：只在 MC 模式会话/点开设置）`)

    // 🔴 没有选中工作区 → **拒绝发起 MC 模式会话**（不套隔离、不建文件）
    // ⚠️ `noWs` 在**块外**声明（见下面那条 `let noWs`）：`/api/mc/mode` 的 agent 替身要在闭包里引用它，
    //    留在块内会让闭包抛 ReferenceError → 被 handler 的 try/catch 吞掉 → 断言变成假绿。
    noWs = { id: 'sess-NOWS', session: { header: {} }, ctx: makeAgentCtx('minecraft') }
    const restrictBefore = restrictCalls.length
    fire('agent/created', noWs)
    console.log(`  ${restrictCalls.length === restrictBefore ? '✅' : '❌'} 没工作区的 MC 会话**不套权限策略**（拒绝进入 MC 模式）`)
  }

  // ⑥ 「MC设置」入口的模式门控接口（2026-09-16 真机事故：普通会话也显示了设置按钮）
  const { EventEmitter } = await import('node:events')
  const routeMc = registeredRoutes.find((r) => r.path === '/api/mc')
  const callMc = async (url) => {
    const rq = new EventEmitter()
    rq.method = 'GET'
    rq.url = url
    rq.headers = { host: '127.0.0.1:39999' }
    const rs = { writeHead: () => {}, end: (b) => { rs.body = String(b ?? '') } }
    const p = routeMc.handler(rq, rs)
    rq.emit('end')
    await p
    try { return JSON.parse(rs.body || '{}') } catch { return {} }
  }
  // agent 服务替身：**必须在第一组模式断言之前就位** ——
  // 否则 `/api/mc/mode` 拿到的是 `undefined`，那几条断言会"恰好因为期望 false 而通过"（假绿）。
  fakeCtx.agents = {
    get: (id) => (id === 'sess-MC2' ? mcAgent
      : id === 'sess-P2' ? plainAgent
        : id === 'sess-NOWS' ? noWs
          : undefined),
  }
  const modeMc = await callMc('/api/mc/mode?sessionId=sess-MC2')
  const modePlain = await callMc('/api/mc/mode?sessionId=sess-P2')
  const modeNoId = await callMc('/api/mc/mode')
  console.log(`  ${modeMc.mcMode === true ? '✅' : '❌'} /api/mc/mode：MC 模式会话 → true（才显示「MC设置」）`)
  console.log(`  ${modePlain.mcMode === false ? '✅' : '❌'} /api/mc/mode：普通会话 → false（标题条不出现入口）`)
  console.log(`  ${modeNoId.mcMode === false ? '✅' : '❌'} /api/mc/mode：没给 sessionId → false（保守，宁可不显示）`)

  // agent 服务在场时现场问 agentPresets；**把模式切回普通要立刻变 false**（不残留按钮）
  const liveMc = await callMc('/api/mc/mode?sessionId=sess-MC2')
  presetByCtx.set(mcAgent.ctx, 'standard')
  const afterSwitch = await callMc('/api/mc/mode?sessionId=sess-MC2')
  presetByCtx.set(mcAgent.ctx, 'minecraft')
  console.log(`  ${liveMc.mcMode === true ? '✅' : '❌'} 有 agent 服务时现场判定（不是只看历史记录）`)
  console.log(`  ${afterSwitch.mcMode === false ? '✅' : '❌'} 🔴 模式切成普通后立刻变 false（按钮不会残留）`)

  /* ⑨ 🔴 用户 2026-09-16："没有选中工作区，则拒绝发起 MC 模式会话**和设置**"。
   *    · 设置接口：没有 sessionId / 会话没有工作区 → **400 拒绝**（这条没变）
   *    · 有工作区 → 放行，并且**在这个时机**把该工作区的 `.whale-craft/` 备好（"点开设置即建"）。
   *
   *    🔴 2026-09-18 用户改口径：**有没有工作区，只要新对话选中了 MC 模式就显示按钮**，
   *       工作区改到**点按钮那一刻**检查。所以模式接口**不再**把 mcMode 压成 false
   *       （那正是前端藏入口的依据），改成额外报 `hasWorkspace` + `diag.reason='no-workspace'`。 */
  const modeNoWs = await callMc('/api/mc/mode?sessionId=sess-NOWS')
  console.log(`  ${modeNoWs.mcMode === true ? '✅' : '❌'} 🔴 没工作区的 MC 会话：mcMode 仍为 **true**（入口照常显示，不再藏按钮）`)
  console.log(`  ${modeNoWs.hasWorkspace === false ? '✅' : '❌'} 同时报出 hasWorkspace=false（前端点击时据此提示"先选工作区"）`)
  console.log(`  ${modeNoWs.diag?.reason === 'no-workspace' ? '✅' : '❌'} 诊断里仍写清原因 reason=no-workspace（排查用）`)
  console.log(`  ${modeNoWs.diag?.workspace === null || modeNoWs.diag?.workspace === undefined ? '✅' : '❌'} 诊断里明确报"没有工作区"（${JSON.stringify(modeNoWs.diag?.workspace ?? null)}）`)

  const callMc2 = async (method, url, body) => {
    const { EventEmitter } = await import('node:events')
    const rq = new EventEmitter()
    rq.method = method
    rq.url = url
    rq.headers = { host: '127.0.0.1:39999' }
    const rs = { writeHead: (code) => { rs.statusCode = code }, end: (b) => { rs.body = String(b ?? '') } }
    const p = routeMc.handler(rq, rs)
    if (body !== undefined) rq.emit('data', Buffer.from(JSON.stringify(body)))
    rq.emit('end')
    await p
    try { return { status: rs.statusCode ?? 200, json: JSON.parse(rs.body || '{}') } } catch { return { status: 0, json: {} } }
  }
  const noSid = await callMc2('GET', '/api/mc/config')
  console.log(`  ${noSid.json?.ok === true && noSid.json?.hasWorkspace === false ? '✅' : '❌'} 设置接口没带 sessionId → 无工作区模式（放行、只回全局项；hasWorkspace=false）`)
  const noWsAgent2 = { id: 'sess-NOWS', session: { header: {} }, ctx: makeAgentCtx('minecraft') }   // 有 MC preset、没工作区
  fakeCtx.agents = { get: (id) => (id === 'sess-NOWS' ? noWsAgent2 : undefined) }
  const noWsCfg = await callMc2('GET', '/api/mc/config?sessionId=sess-NOWS')
  console.log(`  ${noWsCfg.json?.ok === true && noWsCfg.json?.hasWorkspace === false ? '✅' : '❌'} 会话没工作区 → 无工作区模式（放行；工作区键为 null）`)

  // 反面：有工作区 → 放行，并且**在这个时机**把 `.whale-craft/` 备好（"点开设置即建"）
  const ws3 = (await import('node:fs')).mkdtempSync(join((await import('node:os')).tmpdir(), 'whale-ws3-'))
  const wsAgent = { id: 'sess-WSOK', session: { header: { cwd: ws3 } }, ctx: makeAgentCtx('minecraft') }
  fakeCtx.agents = { get: (id) => (id === 'sess-WSOK' ? wsAgent : id === 'sess-NOWS' ? noWsAgent2 : undefined) }
  const okCfg = await callMc2('GET', '/api/mc/config?sessionId=sess-WSOK')
  console.log(`  ${okCfg.json?.ok === true ? '✅' : '❌'} 有工作区 → 设置接口放行`)
  console.log(`  ${(await import('node:fs')).existsSync((await import('node:path')).join(ws3, '.whale-craft', 'RULES.md')) ? '✅' : '❌'} 🔴 **点开设置**这个时机就把该工作区的 .whale-craft/RULES.md 备好了`)
  console.log(`  ${(await import('node:fs')).existsSync((await import('node:path')).join(ws3, '.whale-craft', 'config.json')) ? '✅' : '❌'} 🔴 工作区 config.json 也在这个时机备好（两个时机 = 首次 MC 会话 / 点开设置）`)

  // 🔴 2026-09-16 真机反馈："新对话还没开始（服务端还没这个会话），可工作区明明选了"——
  //    所以允许客户端**直接报工作区**（只认绝对路径 + 真实存在的目录）。
  const hintWs = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'whale-hint-'))
  const hintOk = await callMc2('GET', '/api/mc/config?sessionId=sess-UNKNOWN&cwd=' + encodeURIComponent(hintWs))
  console.log(`  ${hintOk.json?.ok === true ? '✅' : '❌'} 新对话页：会话还没落盘、但客户端报了对的工作区 → **放行**`)
  const hintAbs = await callMc2('GET', '/api/mc/config?sessionId=sess-UNKNOWN&cwd=' + encodeURIComponent('relative/dir'))
  console.log(`  ${hintAbs.json?.ok === true && hintAbs.json?.hasWorkspace === false ? '✅' : '❌'} 报的不是绝对路径 → 不认（当没工作区，全局项照常）`)
  const hintGone = await callMc2('GET', '/api/mc/config?sessionId=sess-UNKNOWN&cwd=' + encodeURIComponent(jnTop(tdTop(), 'definitely-not-here-xyz')))
  console.log(`  ${hintGone.json?.ok === true && hintGone.json?.hasWorkspace === false ? '✅' : '❌'} 报的目录不存在 → 不认（当没工作区）`)

  // 无工作区模式（从插件菜单打开设置）：提示词只读回默认；发布区仍拒绝
  const nowsMd = await callMc2('GET', '/api/mc/agents-md')
  console.log(`  ${nowsMd.json?.ok === true && nowsMd.json?.readOnly === true && nowsMd.json?.hasWorkspace === false && typeof nowsMd.json?.text === 'string' && nowsMd.json.text.length > 0 && nowsMd.json?.rulesVersion === null ? '✅' : '❌'} 无工作区 → 提示词**只读**返回内置默认（readOnly / rulesVersion=null）`)
  const nowsEx = await callMc2('GET', '/api/mc/express')
  console.log(`  ${nowsEx.json?.ok === false ? '✅' : '❌'} 无工作区 → 发布区接口仍拒绝（分享发布区无工作区不可用）`)
}

// ── MC账户体系（元数据 / 凭据分离；LLM 只能看基本信息）──
console.log('\n--- MC账户：账户库 / 凭据隔离 / 工具 ---')
{
  const { AccountStore, offlineUuid, parseAuthlibCard } = await import('./src/accounts.mjs')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  // 假凭据服务：内存 key→record，形状照 ctx.credentials
  const recs = new Map()
  const fakeCred = {
    listRecords: async () => [...recs.entries()].map(([key, r]) => ({ key, kind: r.kind })),
    readRecord: async (key) => recs.get(key),
    modifyRecord: async (key, fn) => { const r = await fn(recs.get(key)); recs.set(key, r); return r },
    deleteRecord: async (key) => { recs.delete(key) },
  }
  const store = new AccountStore({ dir: mkdtempSync(join(tmpdir(), 'whale-acc-')), credentials: fakeCred })
  store.ensureDefaults()
  await store.refreshCredentialIndex()

  const def = store.list()[0]
  console.log(`  ${def?.type === 'offline' && def?.name === 'DeepSeek' && def?.default ? '✅' : '❌'} 默认账户 = 离线 DeepSeek（且是默认）`)
  console.log(`  ${def?.uuid === offlineUuid('DeepSeek') && def?.uuidSource === 'derived-from-name' ? '✅' : '❌'} 离线 UUID 按名字派生（Java 同款）：${def?.uuid}`)
  console.log(`  ${store.listAuthServers().some((s) => s.id === 'littleskin') ? '✅' : '❌'} 默认带 LittleSkin 认证服务器`)

  const renamed = store.update(def.innerID, { name: '用户', uuid: '0123456789abcdef0123456789abcdef' })
  console.log(`  ${renamed.name === '用户' && renamed.uuid === '01234567-89ab-cdef-0123-456789abcdef' && renamed.uuidSource === 'custom' ? '✅' : '❌'} 离线账户可改名 + 可自定义 UUID`)
  const badUuid = await Promise.resolve().then(() => store.update(def.innerID, { uuid: 'zzz' })).catch((e) => e.message)
  console.log(`  ${/UUID 格式不对/.test(String(badUuid)) ? '✅' : '❌'} 非法 UUID 被拒`)

  const srv = store.addAuthServer({ name: '认证服务器', url: 'https://auth.example.com/yggdrasil/' })
  console.log(`  ${srv.url === 'https://auth.example.com/yggdrasil' ? '✅' : '❌'} 认证服务器地址归一化（去尾斜杠）`)
  const dup = await Promise.resolve().then(() => store.addAuthServer({ url: 'https://auth.example.com/yggdrasil' })).catch((e) => e.message)
  console.log(`  ${/已经加过/.test(String(dup)) ? '✅' : '❌'} 重复地址被拒：${String(dup).slice(0, 26)}`)
  console.log(`  ${store.listAuthServers().length === 2 ? '✅' : '❌'} 已添加的服务器被记住：${store.listAuthServers().map((s) => s.name).join(' / ')}`)
  // 🔴 用户 2026-09-16：认证服务器的**名字**是给人看的（缓存标签里显示它），要能改；
  //    `addAuthServer` 不给名字时默认拿**域名**当名字，所以"建完再改名"是必须的。
  const renamedSrv = store.renameAuthServer(srv.id, '认证服务器')
  console.log(`  ${renamedSrv.name === '认证服务器' && renamedSrv.id === srv.id && renamedSrv.url === srv.url ? '✅' : '❌'} 认证服务器可改名，且 **id 不变**（账户是引用 id 的）`)
  const dupName = await Promise.resolve().then(() => store.renameAuthServer(srv.id, 'LittleSkin')).catch((e) => e.message)
  console.log(`  ${/已经有同名/.test(String(dupName)) ? '✅' : '❌'} 改成已存在的名字被拒：${String(dupName).slice(0, 30)}`)
  const emptyName = await Promise.resolve().then(() => store.renameAuthServer(srv.id, '   ')).catch((e) => e.message)
  console.log(`  ${/名字不能为空/.test(String(emptyName)) ? '✅' : '❌'} 空名字被拒`)
  const sameName = store.renameAuthServer(srv.id, '认证服务器')
  console.log(`  ${sameName.name === '认证服务器' ? '✅' : '❌'} 名字没变时是幂等的（不抛错）`)

  // 接口层：建账户时把 serverName 落到认证服务器（新建给名字 / 选中已有但改了名 → 改名）
  {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const idx = readFileSync(fileURLToPath(new URL('./index.js', import.meta.url)), 'utf8')
    const at = idx.indexOf("path === '/api/mc/accounts' && req.method === 'POST'")
    const seg = at >= 0 ? idx.slice(at, at + 2000) : ''
    console.log(`  ${/body\.serverName/.test(seg) && /renameAuthServer/.test(seg) ? '✅' : '❌'} 建账户接口把 serverName 落进认证服务器（含改名）`)
  }
  // 🔴 用户 2026-09-16：LittleSkin 只是**预置**（不是"内置"）——**能删**，而且删了不会被 ensureDefaults 复活
  const delPreset = await Promise.resolve().then(() => store.removeAuthServer('littleskin')).catch((e) => ({ error: e.message }))
  console.log(`  ${delPreset?.removed === 'littleskin' ? '✅' : '❌'} 预置的 LittleSkin 也能删（没有"内置不可删"这回事）`)
  const nSrv = store.listAuthServers().length
  store.ensureDefaults()
  console.log(`  ${store.listAuthServers().length === nSrv ? '✅' : '❌'} 删掉之后 ensureDefaults **不会**把它长回来（seeded 标记）`)

  const card = parseAuthlibCard('authlib-injector:yggdrasil-server:https%3A%2F%2Fauth.example.com%2Fyggdrasil')
  console.log(`  ${card === 'https://auth.example.com/yggdrasil' ? '✅' : '❌'} 解析 authlib-injector 卡片：${card}`)
  console.log(`  ${parseAuthlibCard('https://example.com/api/yggdrasil') === 'https://example.com/api/yggdrasil' && parseAuthlibCard('不是网址') === null ? '✅' : '❌'} 裸网址也认 / 垃圾文本返回 null`)

  const acc2 = store.add({ type: 'yggdrasil', name: '用户皮肤站号', serverId: srv.id, login: 'owner@example.com' })
  await store.setCredential(acc2.innerID, { password: 'p@ssw0rd', accessToken: 'tok-1', clientToken: 'ct-1' })
  await store.refreshCredentialIndex()
  const viewJson = JSON.stringify(store.list())
  const view2 = store.list().find((a) => a.innerID === acc2.innerID)
  console.log(`  ${view2?.server?.url === 'https://auth.example.com/yggdrasil' && view2?.hasCredential ? '✅' : '❌'} 皮肤站账户带服务器信息 + hasCredential 标记`)
  // 🔴 列表小灰字要显示"输入的账号"→ 视图必须把它带给 UI（离线/正版没有 login，为 null）
  console.log(`  ${view2?.login === 'owner@example.com' && store.list().find((a) => a.type === 'offline')?.login === null ? '✅' : '❌'} 视图带 login（皮肤站=输入的账号，离线=None）`)
  const delUsed = await Promise.resolve().then(() => store.removeAuthServer(srv.id)).catch((e) => e.message)
  console.log(`  ${/还有账户在用/.test(String(delUsed)) ? '✅' : '❌'} 被账户占用的服务器不许删：${String(delUsed).slice(0, 34)}`)
  console.log(`  ${!/p@ssw0rd|tok-1|ct-1/.test(viewJson) ? '✅' : '❌'} 🔴 公开视图里逐字查过：**没有**密码/token`)
  console.log(`  ${recs.has(`whale-craft/${acc2.innerID}`) ? '✅' : '❌'} 凭据落在宿主凭据服务（key = whale-craft/<innerID>）`)
  const noCred = new AccountStore({ dir: mkdtempSync(join(tmpdir(), 'whale-acc2-')) })
  noCred.ensureDefaults()
  const refuse = await noCred.setCredential(noCred.list()[0].innerID, { password: 'x' }).catch((e) => e.message)
  console.log(`  ${/拒绝把密码写进工作区/.test(String(refuse)) ? '✅' : '❌'} 凭据服务不可用时**拒绝降级写明文**`)
  const removed = await store.remove(acc2.innerID)
  console.log(`  ${removed.removed === acc2.innerID && !recs.has(`whale-craft/${acc2.innerID}`) ? '✅' : '❌'} 删账户连带删凭据`)
  console.log(`  ${store.search('用户').matched === 1 ? '✅' : '❌'} 按指令搜索（名字）`)

  // 工具层（跑在插件的真实实例上，账户库落在 WHALE_CRAFT_DIR 临时目录）
  const accList = await tools.get('mc_accounts').execute({ action: 'list' }, A)
  console.log(`  ${Array.isArray(accList.accounts) && accList.accounts.length >= 1 ? '✅' : '❌'} mc_accounts{list} 可用（${accList.accounts?.length} 个账户，凭据服务 ${accList.credentialsReady ? '可用' : '不可用'}）`)
  console.log(`  ${!/password|authPass|accessToken|clientToken|"token"/i.test(JSON.stringify(accList)) ? '✅' : '❌'} 🔴 mc_accounts 返回里没有任何凭据字段`)
  const chosen = await tools.get('mc_accounts').execute({ action: 'use', innerID: accList.accounts[0].innerID }, A).catch((e) => e.message)
  console.log(`  ${/未知 action/.test(String(chosen)) ? '✅' : '❌'} 🔴 mc_accounts{use} 已移除（未知 action 报错；用户 2026-10-05）`)
  const searchTool = await tools.get('mc_accounts').execute({ action: 'search', query: 'DeepSeek' }, A)
  console.log(`  ${searchTool.matched >= 1 ? '✅' : '❌'} mc_accounts{search} 可用（命中 ${searchTool.matched}）`)
  const refreshOffline = await tools.get('mc_accounts').execute({ action: 'refresh' }, A)
  console.log(`  ${/离线/.test(String(refreshOffline.note ?? '')) ? '✅' : '❌'} 离线账户"刷新"= 说明不需要认证`)
  const ghost = await tools.get('mc_connect').execute({ address: 'mc.example', account: 'acc-00000000' }, A).catch((e) => e.message)
  console.log(`  ${/没有这个账户/.test(String(ghost)) ? '✅' : '❌'} mc_connect 指名不存在的账户报错清晰`)
}

// ── 行事准则 RULES.md / 新开关 / 边界信息工具 ──
console.log('\n--- 行事准则 RULES.md / 新开关 / 边界信息 ---')
{
  const { DEFAULT_AGENTS_MD, agentsMdPath, readAgentsMd, writeAgentsMd, resetAgentsMd } = await import('./src/agentsmd.mjs')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  console.log(`  ${/Whale Craft 行事准则/.test(DEFAULT_AGENTS_MD) && /DeepSeek/.test(DEFAULT_AGENTS_MD) && /Master/.test(DEFAULT_AGENTS_MD) ? '✅' : '❌'} 默认准则像样（标题 / 称呼都在）`)
  console.log(`  ${/mc_accounts/.test(DEFAULT_AGENTS_MD) && /mc_capabilities/.test(DEFAULT_AGENTS_MD) && /mc_watch/.test(DEFAULT_AGENTS_MD) && /README\.md/.test(DEFAULT_AGENTS_MD) ? '✅' : '❌'} 默认准则里的关键工具/索引名都在`)
  console.log(`  ${!/xxx/.test(DEFAULT_AGENTS_MD) ? '✅' : '❌'} 草稿里的 "xxx" 占位符已全部替换`)
  // 🔴 凭据边界：默认准则**不得**再指路到明文凭据文件、也不得出现已删除的连接参数
  console.log(`  ${!/mc-servers\.md/.test(DEFAULT_AGENTS_MD) ? '✅' : '❌'} 默认准则不再指路 .agent-docs/mc-servers.md（那里曾有明文密码）`)
  console.log(`  ${!/authPass|authUrl|authUser/.test(DEFAULT_AGENTS_MD) ? '✅' : '❌'} 默认准则不含已删除的 mc_connect 凭据参数`)
  console.log(`  ${/重新登录或刷新/.test(DEFAULT_AGENTS_MD) ? '✅' : '❌'} 「进入服务器」在登录失败时引导用户重新登录 / 刷新`)
  {
    const secs = ['宗旨', '称呼', '记忆', '兼容性', '进入服务器', '看门狗', '聊天', '建筑须知', '其他']
    const missing = secs.filter((s) => !DEFAULT_AGENTS_MD.includes(`## ${s}`))
    console.log(`  ${missing.length === 0 ? '✅' : '❌'} 🔴 九个分节都在（缺：${missing.join('、') || '无'}）`)
    const steps = ['mc_accounts', 'mc_lan', 'mc_ping', 'mc_connect']
    const lackSteps = steps.filter((k) => !DEFAULT_AGENTS_MD.includes(k))
    console.log(`  ${lackSteps.length === 0 ? '✅' : '❌'} 🔴「进入服务器」用到 mc_accounts / mc_lan / mc_ping / mc_connect（缺：${lackSteps.join('、') || '无'}）`)
    const house = ['环境', 'NBT', '楼梯', '复盘', '功能性']
    const lack = house.filter((k) => !DEFAULT_AGENTS_MD.includes(k))
    console.log(`  ${lack.length === 0 ? '✅' : '❌'} 🔴「建筑须知」讲到了关键点（环境协调 / 方块属性与 NBT / 多部分方块 / 细节 / 复盘；缺：${lack.join('、') || '无'}）`)
    const houseNew = ['先将建筑大体结构完成', '每阶段完成要给用户响应', '建造完成后，需要复盘']
    const lack2 = houseNew.filter((k) => !DEFAULT_AGENTS_MD.includes(k))
    console.log(`  ${lack2.length === 0 ? '✅' : '❌'} 🔴「建筑须知」补的三条也在（先大体结构 / 每阶段回话 / 完工复盘；缺：${lack2.join('、') || '无'}）`)
    console.log(`  ${/第一时间回复/.test(DEFAULT_AGENTS_MD) ? '✅' : '❌'} 「聊天」有"第一时间回复用户"`)
  }

  const dir = mkdtempSync(join(tmpdir(), 'whale-md-'))
  console.log(`  ${readAgentsMd(dir).source === 'default' ? '✅' : '❌'} 没有自定义文件时用默认`)
  writeAgentsMd(dir, '# 我的准则\n\n- 一句话')
  const custom = readAgentsMd(dir)
  console.log(`  ${custom.source === 'custom' && /我的准则/.test(custom.text) ? '✅' : '❌'} 写入后读回自定义版（${agentsMdPath(dir).split(/[\\/]/).pop()}）`)
  resetAgentsMd(dir)
  // 🔴 2026-09-16 用户纠正："AGENTS.md 就是单纯地编辑这个文件" →
  //    恢复默认 = 把**默认内容写回文件**（不是删掉文件让代码兜底）；source 由内容判定。
  const { existsSync: existsSyncMd, readFileSync: readFileSyncMd } = await import('node:fs')
  const backDefault = readAgentsMd(dir)
  console.log(`  ${existsSyncMd(agentsMdPath(dir)) && backDefault.source === 'default' ? '✅' : '❌'} 「恢复默认」= 把默认写回文件（文件仍在，source 按内容判定）`)
  console.log(`  ${backDefault.text === DEFAULT_AGENTS_MD ? '✅' : '❌'} 恢复后的内容逐字等于内置默认（${backDefault.text.length} 字）`)
  const emptyDir = mkdtempSync(join(tmpdir(), 'whale-md-none-'))
  const noFile = readAgentsMd(emptyDir)
  console.log(`  ${noFile.source === 'default' && noFile.text.length > 100 ? '✅' : '❌'} 文件不存在时也返回默认**全文**（绝不返回空串 → 提示词不会因此消失）`)
  writeAgentsMd(dir, DEFAULT_AGENTS_MD)
  console.log(`  ${readAgentsMd(dir).source === 'default' ? '✅' : '❌'} 就算文件在、只要内容等于默认 → 仍算"默认版"（标签不说谎）`)
  writeAgentsMd(dir, '# 我的准则\n\n- 一句话')
  console.log(`  ${readAgentsMd(dir).source === 'custom' ? '✅' : '❌'} 改过内容 → 算"自定义版"`)
  const tooBig = await Promise.resolve().then(() => writeAgentsMd(dir, 'x'.repeat(200 * 1024))).catch((e) => e.message)
  console.log(`  ${/太大/.test(String(tooBig)) ? '✅' : '❌'} 超大内容被拒`)
  // 受保护文件的统一判定（src/protected.mjs）：RULES.md / AGENTS.md / config.json
  {
    const { isProtectedPathArg, isProtectedName } = await import('./src/protected.mjs')
    console.log(`  ${isProtectedPathArg('E:\\x\\.whale-craft\\AGENTS.md') && isProtectedPathArg('E:/x/whale_craft/RULES.md') && isProtectedPathArg('config.json') && !isProtectedPathArg('E:/x/README.md') ? '✅' : '❌'} 受保护判定认得本文件（含老名/裸名/config.json）、不误伤别的`)
    console.log(`  ${isProtectedName('RULES.md') && isProtectedName('Config.JSON') && isProtectedName('agents.md') && !isProtectedName('_global') ? '✅' : '❌'} 受保护文件名大小写不敏感`)
    console.log(`  ${!isProtectedPathArg('_global/config.json') && !isProtectedPathArg('notes/RULES.md') && !isProtectedPathArg('') ? '✅' : '❌'} 嵌套的记忆文件（_global/config.json）不算受保护，照常可读写`)
  }

  /* 🔴 改名（2026-09-16 致命 bug）：行事准则从 `.whale-craft/AGENTS.md` → `.whale-craft/RULES.md`。
   *    原因：宿主的 agent-instructions 把 `AGENTS.md` 当候选指令文件 —— 任何会话只要 read/write/edit 过
   *    `.whale-craft/` 下的文件，宿主就把那份当**工作区指令**注入（非 MC 会话也被污染、MC 会话投两遍、
   *    而且我们的注入开关关不掉它）。新名字不在宿主候选里，注入只剩我们这一条通道。 */
  {
    const { mkdtempSync: mkTmp, writeFileSync: writeTmp, existsSync: ex, readFileSync: rd } = await import('node:fs')
    const { tmpdir: td } = await import('node:os')
    const { join: jn } = await import('node:path')
    const { agentsMdPath: aPath, legacyAgentsMdPath: lPath, migrateLegacyAgentsMd } = await import('./src/agentsmd.mjs')
    const { isProtectedPathArg: isIt } = await import('./src/protected.mjs')

    console.log(`  ${aPath('/d').endsWith('RULES.md') && !aPath('/d').endsWith('AGENTS.md') ? '✅' : '❌'} 存储文件名是 RULES.md：${aPath('/d')}`)
    console.log(`  ${isIt('E:/x/.whale-craft/RULES.md') && isIt('E:\\x\\.whale-craft\\RULES.md') && isIt('RULES.md') ? '✅' : '❌'} 守卫认得新名字（绝对/Windows/裸名）`)
    console.log(`  ${isIt('E:/x/.whale-craft/AGENTS.md') && isIt('AGENTS.md') ? '✅' : '❌'} 🔴 守卫**也认老名字**（迁移前/用户手放的都要挡住，否则 AI 又造出一个宿主会认的文件）`)
    console.log(`  ${!isIt('E:/x/.whale-craft/README.md') && !isIt('E:/x/.whale-craft/my-notes.md') ? '✅' : '❌'} 不误伤 README.md / 别的记忆文件`)

    // 迁移：老文件在、新文件不在 → 内容搬过去 + 老文件改名备份
    const d1 = mkTmp(jn(td(), 'whale-rules-mig1-'))
    writeTmp(jn(d1, 'AGENTS.md'), '# 我自己写的准则\n\n- 一条\n', 'utf8')
    const m1 = migrateLegacyAgentsMd(d1)
    console.log(`  ${m1.migrated && ex(aPath(d1)) && rd(aPath(d1), 'utf8').includes('我自己写的准则') ? '✅' : '❌'} 迁移：老 AGENTS.md 的内容搬进 RULES.md`)
    console.log(`  ${!ex(lPath(d1)) && ex(m1.backup ?? '') ? '✅' : '❌'} 🔴 老文件名**被改名为带时间戳的备份**（它只要还在，宿主就还会把它当工作区指令注入）`)
    console.log(`  ${migrateLegacyAgentsMd(d1).migrated === false ? '✅' : '❌'} 迁移是幂等的（第二次什么都不做）`)

    // 两个都在 → 以新文件为准，老文件照样备份改名
    const d2 = mkTmp(jn(td(), 'whale-rules-mig2-'))
    writeTmp(jn(d2, 'AGENTS.md'), '老内容\n', 'utf8')
    writeTmp(jn(d2, 'RULES.md'), '新内容\n', 'utf8')
    const m2 = migrateLegacyAgentsMd(d2)
    console.log(`  ${m2.migrated && rd(aPath(d2), 'utf8').trim() === '新内容' && !ex(lPath(d2)) ? '✅' : '❌'} 两个都在 → **以新文件为准**，老文件备份改名（不覆盖新内容）`)

    // 宿主候选名红线：我们生成的任何文件都不许叫这几个名字
    const { DEFAULT_AGENTS_MD: def } = await import('./src/agentsmd.mjs')
    console.log(`  ${!/\.whale-craft\/AGENTS\.md/.test(def) && /\.whale-craft\/RULES\.md/.test(def) ? '✅' : '❌'} 默认行事准则正文里自指的文件名也是 RULES.md（否则等于教它去读一个不存在的文件）`)
  }

  /* ── 「随版本更新」（用户 2026-09-17）────────────────────────────────────────
   * 插件版本一变 → 用新版本默认准则替换 `.whale-craft/RULES.md`；
   * 版本记在本工作区的 config.json（`rulesVersion` 字段）。
   * 默认**开**；第一次遇到（没记录）只记版本不覆盖；关着时也只记版本（以后打开不翻旧账）。 */
  {
    const { mkdtempSync, writeFileSync, readFileSync, existsSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { syncRulesVersion, agentsMdPath, DEFAULT_AGENTS_MD } = await import('./src/agentsmd.mjs')
    const { readRulesVersion, setRulesVersion, wsConfigPath } = await import('./src/wsconfig.mjs')
    const mk = () => mkdtempSync(join(tmpdir(), 'whale-rules-ver-'))
    const rd = (d) => { try { return readFileSync(agentsMdPath(d), 'utf8') } catch { return '' } }

    // ① 没文件 → 建默认 + 记版本（版本落进 config.json）
    const a = mk()
    const r1 = syncRulesVersion(a, '1.2.3')
    console.log(`  ${r1.action === 'created' && rd(a).trim() === DEFAULT_AGENTS_MD.trim() && readRulesVersion(a) === '1.2.3' ? '✅' : '❌'} 没文件 → 写默认 + 记版本（${r1.action}）`)
    const cfgA = JSON.parse(readFileSync(wsConfigPath(a), 'utf8'))
    console.log(`  ${cfgA.schema === 1 && cfgA.rulesVersion === '1.2.3' ? '✅' : '❌'} 版本记在工作区 config.json 的 rulesVersion 字段（schema:1）`)
    console.log(`  ${!existsSync(join(a, '.rules-version')) ? '✅' : '❌'} 不再产生 .rules-version 独立标记文件`)

    // ② 版本没变 → 什么都不做
    const r2 = syncRulesVersion(a, '1.2.3')
    console.log(`  ${r2.action === 'kept' && readRulesVersion(a) === '1.2.3' ? '✅' : '❌'} 版本没变 → kept（不做任何写操作）`)

    // ③ 版本变了 + 开关开（默认）→ **替换**成新默认（用户改过的也换）
    const b = mk()
    writeFileSync(agentsMdPath(b), '# 我自己改过的准则\n', 'utf8')
    setRulesVersion(b, '0.1.0')
    const r3 = syncRulesVersion(b, '0.1.1')
    console.log(`  ${r3.action === 'replaced' && r3.from === '0.1.0' && r3.to === '0.1.1' && rd(b).trim() === DEFAULT_AGENTS_MD.trim() ? '✅' : '❌'} 🔴 版本变了 + 开关开 → 用新默认**替换**（from=${r3.from} → ${r3.to}）`)
    console.log(`  ${readRulesVersion(b) === '0.1.1' ? '✅' : '❌'} 替换后版本记录更新到新版本`)

    // ④ 版本变了但开关关 → 只记版本，内容原样
    const c = mk()
    writeFileSync(agentsMdPath(c), '# 我自己改过的准则\n', 'utf8')
    setRulesVersion(c, '0.1.0')
    const r4 = syncRulesVersion(c, '0.1.1', { follow: false })
    console.log(`  ${r4.action === 'kept' && rd(c).includes('我自己改过的') && readRulesVersion(c) === '0.1.1' ? '✅' : '❌'} 开关关 → 保留用户内容，只把版本推到当前（以后打开**不翻旧账**）`)
    const r5 = syncRulesVersion(c, '0.1.1', { follow: true })
    console.log(`  ${r5.action === 'kept' && rd(c).includes('我自己改过的') ? '✅' : '❌'} 紧接着打开开关：同一版本内**不会**再覆盖`)

    // ⑤ 第一次遇到（有文件、没版本记录）→ 只记版本，**不覆盖**
    const d = mk()
    writeFileSync(agentsMdPath(d), '# 老工作区里的自定义准则\n', 'utf8')
    const r6 = syncRulesVersion(d, '0.1.1')
    console.log(`  ${r6.action === 'marked' && r6.from === null && rd(d).includes('老工作区里的自定义准则') && readRulesVersion(d) === '0.1.1' ? '✅' : '❌'} 🔴 第一次遇到（没记录）→ 只记版本、**不覆盖**（免得插件一升级就冲掉人家改的准则）`)
    const r7 = syncRulesVersion(d, '0.2.0')
    console.log(`  ${r7.action === 'replaced' && rd(d).trim() === DEFAULT_AGENTS_MD.trim() ? '✅' : '❌'} 之后再更新版本 → 正常替换`)

    /* ── 迁移 + 建档（src/wsconfig.mjs）：旧 .rules-version 并入 config.json 后删除 ── */
    const { migrate: migrateWs, load: wsLoad, patch: wsPatch } = await import('./src/wsconfig.mjs')
    const e = mk()
    writeFileSync(join(e, '.rules-version'), '0.0.9\n', 'utf8')
    const mg1 = migrateWs(e, { seed: { injectWorkspaceAgentsMd: true, rulesFollowVersion: false } })
    const cfgE = JSON.parse(readFileSync(wsConfigPath(e), 'utf8'))
    console.log(`  ${mg1.created && cfgE.rulesVersion === '0.0.9' && !existsSync(join(e, '.rules-version')) ? '✅' : '❌'} 🔴 建档迁移：旧 .rules-version 的值并入 config.json，旧文件删除`)
    console.log(`  ${cfgE.injectWorkspaceAgentsMd === true && cfgE.rulesFollowVersion === false && cfgE.injectWhaleCraftAgentsMd === undefined ? '✅' : '❌'} seed 只写**显式设过**的旧全局值（没设过的不落盘，走默认）`)
    // seed 的来源：旧全局 config.json 里"用户显式设过"的那几个键（坏值不取）
    {
      const { PluginConfig } = await import('./src/config.mjs')
      const hDir = mk()
      writeFileSync(join(hDir, 'config.json'), '{"injectWorkspaceAgentsMd":true,"rulesFollowVersion":false,"rulesFollowVersionX":1,"injectWhaleCraftAgentsMd":"yes"}\n', 'utf8')
      const legacySw = new PluginConfig(hDir).legacyPromptSwitches()
      console.log(`  ${legacySw.injectWorkspaceAgentsMd === true && legacySw.rulesFollowVersion === false && !('injectWhaleCraftAgentsMd' in legacySw) && !('rulesFollowVersionX' in legacySw) ? '✅' : '❌'} 旧全局值快照只取显式设过且类型合法的三键（seed 来源：不吃错值/别的键）`)
    }
    const mg2 = migrateWs(e, { seed: { injectWorkspaceAgentsMd: false } })
    console.log(`  ${!mg2.created && !mg2.markerRemoved && wsLoad(e).values.injectWorkspaceAgentsMd === true ? '✅' : '❌'} 迁移幂等：二次调用不重建、不吃掉已有值`)
    console.log(`  ${wsLoad(e).values.rulesFollowVersion === false && wsLoad(e).values.injectWhaleCraftAgentsMd === true ? '✅' : '❌'} 缺省键按默认值补齐（config.json 里没写也算生效）`)
    const f = mk()
    writeFileSync(join(f, 'config.json'), '{"schema":1,"rulesVersion":"1.0.0","未来的键":"保留"}\n', 'utf8')
    wsPatch(f, { rulesFollowVersion: false })
    const cfgF = JSON.parse(readFileSync(join(f, 'config.json'), 'utf8'))
    console.log(`  ${cfgF.rulesVersion === '1.0.0' && cfgF['未来的键'] === '保留' ? '✅' : '❌'} patch 保留 rulesVersion 与未知键（前向兼容，不吞数据）`)
    const g = mk()
    writeFileSync(join(g, 'config.json'), '{坏 JSON', 'utf8')
    const badPatch = (() => { try { wsPatch(g, { rulesFollowVersion: false }); return null } catch (err) { return err.message } })()
    console.log(`  ${badPatch && /未写入/.test(badPatch) && readFileSync(join(g, 'config.json'), 'utf8') === '{坏 JSON' ? '✅' : '❌'} 🔴 坏 JSON = 只读不写：patch 拒绝覆盖、原文件一字不动`)
  }

  // 开关：允许所有指令
  await tools.get('mc_admin_config').execute({ action: 'set', path: 'allowAllCommands', value: true }, A)
  const anyCmd = await tools.get('mc_command').execute({ command: '/definitely-not-whitelisted' }, A).catch((e) => e.message)
  console.log(`  ${/不在线/.test(String(anyCmd)) ? '✅' : '❌'} 「允许所有指令」打开后任意指令都过白名单（只因未连服报不在线）`)
  const badBool = await tools.get('mc_admin_config').execute({ action: 'set', path: 'allowAllCommands', value: 'yes' }, A).catch((e) => e.message)
  console.log(`  ${/必须是 true\/false/.test(String(badBool)) ? '✅' : '❌'} 开关类型校验`)
  await tools.get('mc_admin_config').execute({ action: 'reset' }, A)
  const afterReset = await tools.get('mc_admin_config').execute({ action: 'get', path: 'allowAllCommands' }, A)
  console.log(`  ${afterReset.value === false ? '✅' : '❌'} 默认关（reset 后为 false）`)
  // 🔴 2026-10-03：三个提示词开关下放为**按工作区**后，全局管理工具不再认识它们（报未知配置项）
  const wsSet = await tools.get('mc_admin_config').execute({ action: 'set', path: 'injectWorkspaceAgentsMd', value: true }, A).catch((e) => e.message)
  const followSet = await tools.get('mc_admin_config').execute({ action: 'set', path: 'rulesFollowVersion', value: 'yes' }, A).catch((e) => e.message)
  console.log(`  ${/未知配置项/.test(String(wsSet)) && /未知配置项/.test(String(followSet)) ? '✅' : '❌'} 🔴 三个提示词开关已不在全局配置（mc_admin_config 报未知项）：${String(wsSet).slice(0, 34)}…`)
  const { WS_DEFAULTS } = await import('./src/wsconfig.mjs')
  console.log(`  ${WS_DEFAULTS.injectWorkspaceAgentsMd === false && WS_DEFAULTS.injectWhaleCraftAgentsMd === true && WS_DEFAULTS.rulesFollowVersion === true ? '✅' : '❌'} 🔴 按工作区开关的默认值 = 下放前的全局默认（注入准则开 / 注入工作区关 / 随版本更新开）`)

  /* 「文件分享」（2026-10-07 按宿主模式拆键）：四键都能设 / 类型校验 / base 归一化 / 端口范围 */
  const setShare = (value, path = 'expressWebEnabled') =>
    tools.get('mc_admin_config').execute({ action: 'set', path, value }, A).catch((e) => e.message)
  await setShare(true)
  const shareOn = await tools.get('mc_admin_config').execute({ action: 'get', path: 'expressWebEnabled' }, A)
  console.log(`  ${shareOn.value === true ? '✅' : '❌'} 管理员工具能设 expressWebEnabled（当前 ${shareOn.value}）`)
  const badMode = await setShare('随便')
  console.log(`  ${/expressWebEnabled 必须是/.test(String(badMode)) ? '✅' : '❌'} 非布尔被拒：${String(badMode).slice(0, 40)}…`)
  const badBase = await setShare('ftp://x', 'expressWebBase')
  console.log(`  ${/expressWebBase 必须是/.test(String(badBase)) ? '✅' : '❌'} 非法 base 被拒：${String(badBase).slice(0, 40)}…`)
  await setShare('https://share.example.com/', 'expressWebBase')
  const baseOn = await tools.get('mc_admin_config').execute({ action: 'get', path: 'expressWebBase' }, A)
  console.log(`  ${baseOn.value === 'https://share.example.com' ? '✅' : '❌'} base 存下来是归一化的（尾斜杠已去）：${baseOn.value}`)
  await setShare(true, 'expressDesktopEnabled')
  const deskOn = await tools.get('mc_admin_config').execute({ action: 'get', path: 'expressDesktopEnabled' }, A)
  console.log(`  ${deskOn.value === true ? '✅' : '❌'} 管理员工具能设 expressDesktopEnabled（当前 ${deskOn.value}）`)
  const badPort = await setShare(70000, 'expressDesktopPort')
  console.log(`  ${/expressDesktopPort 必须是/.test(String(badPort)) ? '✅' : '❌'} 超范围端口被拒：${String(badPort).slice(0, 40)}…`)
  await setShare(16050, 'expressDesktopPort')
  const portOn = await tools.get('mc_admin_config').execute({ action: 'get', path: 'expressDesktopPort' }, A)
  console.log(`  ${portOn.value === 16050 ? '✅' : '❌'} 端口存整数：${portOn.value}`)
  await tools.get('mc_admin_config').execute({ action: 'reset' }, A)
  const shareReset = await tools.get('mc_admin_config').execute({ action: 'get', path: 'expressWebEnabled' }, A)
  const portReset = await tools.get('mc_admin_config').execute({ action: 'get', path: 'expressDesktopPort' }, A)
  console.log(`  ${shareReset.value === false && portReset.value === 16049 ? '✅' : '❌'} reset 后回到默认（web 关、桌面端口 16049）：${shareReset.value}/${portReset.value}`)

  /* 「开放助手调试工具」开关（2026-10-05）：全局配置键、默认关、有类型校验 */
  const debugDefault = await tools.get('mc_admin_config').execute({ action: 'get', path: 'exposeDebugTools' }, A)
  console.log(`  ${debugDefault.value === false ? '✅' : '❌'} exposeDebugTools 默认关（${debugDefault.value}）`)
  await tools.get('mc_admin_config').execute({ action: 'set', path: 'exposeDebugTools', value: true }, A)
  const debugOn = await tools.get('mc_admin_config').execute({ action: 'get', path: 'exposeDebugTools' }, A)
  console.log(`  ${debugOn.value === true ? '✅' : '❌'} 管理员工具能设 exposeDebugTools（当前 ${debugOn.value}）`)
  const debugBad = await tools.get('mc_admin_config').execute({ action: 'set', path: 'exposeDebugTools', value: 'yes' }, A).catch((e) => e.message)
  console.log(`  ${/exposeDebugTools 必须是/.test(String(debugBad)) ? '✅' : '❌'} 非布尔被拒：${String(debugBad).slice(0, 40)}…`)
  await tools.get('mc_admin_config').execute({ action: 'reset' }, A)

  /* 「允许联网搜索」开关（2026-10-08）：全局配置键、**默认开**、有类型校验 */
  const webDefault = await tools.get('mc_admin_config').execute({ action: 'get', path: 'allowWebSearch' }, A)
  console.log(`  ${webDefault.value === true ? '✅' : '❌'} 🔴 allowWebSearch 默认**开**（${webDefault.value}）`)
  await tools.get('mc_admin_config').execute({ action: 'set', path: 'allowWebSearch', value: false }, A)
  const webOff = await tools.get('mc_admin_config').execute({ action: 'get', path: 'allowWebSearch' }, A)
  console.log(`  ${webOff.value === false ? '✅' : '❌'} 管理员工具能关掉 allowWebSearch（当前 ${webOff.value}）`)
  const webBad = await tools.get('mc_admin_config').execute({ action: 'set', path: 'allowWebSearch', value: 1 }, A).catch((e) => e.message)
  console.log(`  ${/allowWebSearch 必须是/.test(String(webBad)) ? '✅' : '❌'} 非布尔被拒：${String(webBad).slice(0, 40)}…`)
  await tools.get('mc_admin_config').execute({ action: 'reset' }, A)

  /* 「网页抓取」三键（2026-10-08）：开关默认关 + 域名表默认 minecraft.wiki / *.minecraft.wiki + 允许所有默认关 */
  {
    const get = (path) => tools.get('mc_admin_config').execute({ action: 'get', path }, A)
    const set = (path, value) => tools.get('mc_admin_config').execute({ action: 'set', path, value }, A).catch((e) => e.message)
    const def = await get('webFetchEnabled')
    console.log(`  ${def.value === false ? '✅' : '❌'} 🔴 webFetchEnabled 默认**关**（${def.value}）`)
    const domDef = await get('webFetchDomains')
    console.log(`  ${Array.isArray(domDef.value) && domDef.value.length === 2 && domDef.value.includes('minecraft.wiki') && domDef.value.includes('*.minecraft.wiki') ? '✅' : '❌'} 默认域名表 = minecraft.wiki / *.minecraft.wiki（${JSON.stringify(domDef.value)}）`)
    const allDef = await get('allowAllFetchDomains')
    console.log(`  ${allDef.value === false ? '✅' : '❌'} allowAllFetchDomains 默认**关**（${allDef.value}）`)
    await set('webFetchEnabled', true)
    await set('webFetchDomains', ['example.com', '*.example.org'])
    await set('allowAllFetchDomains', true)
    const on = await get('webFetchEnabled'); const domOn = await get('webFetchDomains'); const allOn = await get('allowAllFetchDomains')
    console.log(`  ${on.value === true && allOn.value === true && Array.isArray(domOn.value) && domOn.value.includes('*.example.org') ? '✅' : '❌'} 三键都能被管理员工具改（${on.value}/${allOn.value}/${JSON.stringify(domOn.value)}）`)
    const badBool = await set('webFetchEnabled', 'yes')
    console.log(`  ${/webFetchEnabled 必须是 true\/false/.test(String(badBool)) ? '✅' : '❌'} 非布尔被拒：${String(badBool).slice(0, 40)}…`)
    const badList = await set('webFetchDomains', 'minecraft.wiki')
    console.log(`  ${/webFetchDomains 必须是字符串数组/.test(String(badList)) ? '✅' : '❌'} 域名表非数组被拒：${String(badList).slice(0, 40)}…`)
    // 「允许的内容类型」两键（默认都开）
    const htmlDef = await get('webFetchAllowHtml')
    const textDef = await get('webFetchAllowText')
    console.log(`  ${htmlDef.value === true && textDef.value === true ? '✅' : '❌'} 🔴 内容类型两个开关默认都**开**（${htmlDef.value}/${textDef.value}）`)
    const badType = await set('webFetchAllowHtml', 'yes')
    console.log(`  ${/webFetchAllowHtml 必须是 true\/false/.test(String(badType)) ? '✅' : '❌'} 非布尔被拒：${String(badType).slice(0, 40)}…`)
    // 「图片」开关（默认开；**格式是内置名单、不可配** —— 用户 2026-10-08 定）
    const imgDef = await get('webFetchAllowImage')
    console.log(`  ${imgDef.value === true ? '✅' : '❌'} 🔴 webFetchAllowImage 默认**开**（${imgDef.value}）`)
    const badImg = await set('webFetchAllowImage', 'yes')
    console.log(`  ${/webFetchAllowImage 必须是 true\/false/.test(String(badImg)) ? '✅' : '❌'} 非布尔被拒：${String(badImg).slice(0, 40)}…`)
    const goneFmt = await set('webFetchImageFormats', ['png'])
    console.log(`  ${/未知配置项/.test(String(goneFmt)) ? '✅' : '❌'} 🔴 图片格式表已不是配置键（改也没用，报未知项）`)
    await tools.get('mc_admin_config').execute({ action: 'reset' }, A)
  }

console.log('\n--- 认证请求 URL（真机 bug 回归）---')
{
  const { McBot } = await import('./src/core.mjs')
  const realFetch = globalThis.fetch
  const captured = []

  // 桩：记下请求，返回**形状不对**的 session，让流程在认证后立刻停住（不会真去连服）
  globalThis.fetch = async (url, opts) => {
    captured.push({ url: String(url), body: opts?.body })
    return { ok: true, status: 200, json: async () => ({}) }
  }
  const yggAuth = (authUrl, authUser = 'u1', authPass = 'p1') => ({ mode: 'yggdrasil', authUrl, authUser, authPass })

  const cases = [
    ['标准', 'https://auth.example/yggdrasil', 'https://auth.example/yggdrasil/authserver/authenticate'],
    ['结尾带斜杠', 'https://auth.example/yggdrasil/', 'https://auth.example/yggdrasil/authserver/authenticate'],
    ['结尾多个斜杠', 'https://auth.example/yggdrasil///', 'https://auth.example/yggdrasil/authserver/authenticate'],
  ]
  for (const [label, authUrl, want] of cases) {
    const bot = new McBot({ instanceId: 'selftest-auth' })
    captured.length = 0
    let err = null
    try { await bot.connect({ host: 'mc.example', auth: yggAuth(authUrl) }) } catch (e) { err = e }
    const got = captured[0]?.url
    const okUrl = got === want
    const okStop = /认证返回异常/.test(String(err?.message))
    console.log(`  ${okUrl && okStop ? '✅' : '❌'} ${label}：发出 ${got ?? '(没发请求)'}`)
    if (!okUrl) console.log(`      期望 ${want}`)
    if (!okStop) console.log(`      错误停在：${err?.message}`)
  }

  // 凭据确实进了请求体（不是只拼 URL）
  {
    const bot = new McBot({ instanceId: 'selftest-auth' })
    captured.length = 0
    try { await bot.connect({ host: 'mc.example', auth: yggAuth('https://auth.example/yggdrasil', 'user-x', 'pass-y') }) } catch {}
    const body = String(captured[0]?.body ?? '')
    console.log(`  ${body.includes('user-x') && body.includes('pass-y') ? '✅' : '❌'} 凭据进了请求体（不是只拼 URL）`)
  }

  // body 里必须有 `agent`（Yggdrasil 必填）——2026-09-19 真机：LittleSkin 换成新实现
  // (`Yggdrasil Connect 0.0.8`) 后**缺 agent 直接回 400**，而认证服务器那种老实现容忍缺省。
  // 实测对照（真发一次）：LittleSkin 缺→400 / 带→403；认证服务器 缺→403 / 带→401。
  {
    const bot = new McBot({ instanceId: 'selftest-auth' })
    captured.length = 0
    try { await bot.connect({ host: 'mc.example', auth: yggAuth('https://auth.example/yggdrasil', 'user-x', 'pass-y') }) } catch {}
    let parsed = null
    try { parsed = JSON.parse(String(captured[0]?.body ?? '{}')) } catch { parsed = null }
    const okAgent = parsed?.agent?.name === 'Minecraft' && parsed?.agent?.version === 1
    const okRest = parsed?.username === 'user-x' && parsed?.password === 'pass-y' && parsed?.requestUser === true
    console.log(`  ${okAgent && okRest ? '✅' : '❌'} 🔴 authenticate 请求体带 agent（Yggdrasil 必填；缺了 LittleSkin 会回 400）：agent=${JSON.stringify(parsed?.agent)}`)
    const coreSrc = (await import('node:fs')).readFileSync(new URL('./src/core.mjs', import.meta.url), 'utf8')
    console.log(`  ${/Yggdrasil Connect/.test(coreSrc) && /缺 agent 直接回 \*\*400\*\*/.test(coreSrc) ? '✅' : '❌'} 代码里留了这条事故的说明（免得后人又把 agent 删掉）`)
  }

  // ── 按键上报兼容层（player_input，为 26.2 加的）已整体移除（2026-10-02 用户决策）──
  // 原因：上游还连不了 26.2——mineflayer 4.39.0 的 testedVersions 只到 26.1；minecraft-data
  //   3.117.0 只收了 26.2 的**元数据**、没有数据目录（`minecraft-data('26.2')` 为 null）。
  //   半吊子支持先撤；将来上游真支持 26.2，再按 CHANGELOG 0.1.7 的方案（先查后发）重建。
  {
    const { McBot } = await import('./src/core.mjs')
    const coreSrc2 = (await import('node:fs')).readFileSync(new URL('./src/core.mjs', import.meta.url), 'utf8')
    // 只看**代码**，不看注释：注释里留着"为什么删 / 怎么重建"的说明（那是要留的）
    const protoCode = coreSrc2.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    console.log(`  ${!/player_input|inputPacket|startInputPackets|stopInputPackets|_packetSupport/.test(protoCode) ? '✅' : '❌'} 🔴 按键上报兼容层已移除（26.2 尚无上游数据；残代码会让人误以为 26.2 能用）`)

    // ── 幽灵在线：socket 结束就不算在线 ──
    const g = new McBot({ instanceId: 'selftest-ghost' })
    g.bot = { entity: {}, _client: { ended: false } }
    const liveOk = g.online === true
    g.bot._client.ended = true
    const deadOffline = g.online === false
    let threw = null
    try { g.requireBot() } catch (e) { threw = e.message }
    const st = g.status()
    console.log(`  ${liveOk && deadOffline ? '✅' : '❌'} 🔴 幽灵在线：socket 结束后 online 变 false（改前会因为 bot.entity 残留而报"在线"）`)
    console.log(`  ${st?.ghost === true && st?.online === false && /连接已经结束/.test(String(st?.hint)) ? '✅' : '❌'} status() 明确标 ghost + 告诉 AI 要重连`)
    console.log(`  ${/连接已结束/.test(String(threw)) ? '✅' : '❌'} requireBot() 明确报"连接已结束"而不是对着死连接干等（${String(threw).slice(0, 30)}…）`)
  }
  // 空 authUrl 必须在**发请求之前**就被拦下（不能退化成相对路径）
  {
    const bot = new McBot({ instanceId: 'selftest-auth' })
    captured.length = 0
    let err = null
    try { await bot.connect({ host: 'mc.example', auth: { mode: 'yggdrasil', authUrl: '', authUser: 'u', authPass: 'p' } }) } catch (e) { err = e }
    console.log(`  ${captured.length === 0 && /认证端点为空/.test(String(err?.message)) ? '✅' : '❌'} 空 authUrl 在发请求前拦下（绝不发相对 URL）：${String(err?.message).slice(0, 40)}`)
  }

  // 没给账户 → 明确报错（凭据不再从 connect 参数来）
  {
    const bot = new McBot({ instanceId: 'selftest-auth' })
    captured.length = 0
    let err = null
    try { await bot.connect({ host: 'mc.example' }) } catch (e) { err = e }
    console.log(`  ${captured.length === 0 && /缺少登录账户/.test(String(err?.message)) ? '✅' : '❌'} 不带账户直接连 → 报"缺账户"而不是偷偷用旧凭据`)
  }

  globalThis.fetch = realFetch
}

/* ── 🔴 2026-09-17 真机致命事故：未处理的 Promise 拒绝把**整个 DSH** 干掉了 ──────────────
 * 事故链（用户贴的真机栈）：
 *   minecraft-protocol/src/client/encrypt.js:41  yggdrasilServer.join(..., cb)   ← 老式回调
 *   yggdrasil/src/Server.js:20                   join 是 async，**不调那个 cb**
 *   yggdrasil/src/utils.js:35                    皮肤站令牌失效 → throw ForbiddenOperationException
 *   ⇒ 这个 rejection 无人接管 → 宿主的 `installFailLoud`（未处理拒绝=致命）打印
 *     `dsh: fatal load failure` 并 **exit(1)**。
 * 这里锁死两件事：① yggdrasil 的 join 兼容层（回调照调 + 不产生悬空拒绝）；
 *               ② 我们自己代码里**不许**再有 `void x.then(...)` 这种没 catch 的火忘式 promise。 */
console.log('\n--- 未处理拒绝（fail-loud → 整个 DSH exit(1)）防护 ---')
{
  const { wrapYggdrasilServer, takeAuthJoinError, friendlyAuthError } = await import('./src/core.mjs')

  // ① 回调式调用（minecraft-protocol 就是这么用的）：错误必须进回调，而且不能有未处理拒绝
  const rejections = []
  const onUnhandled = (e) => rejections.push(String(e?.message ?? e))
  process.on('unhandledRejection', onUnhandled)
  const boom = new Error('ForbiddenOperationException')
  const fakeServer = {
    __calls: 0,
    async join (...args) { fakeServer.__calls++; throw boom },
  }
  const wrapped = wrapYggdrasilServer(fakeServer)
  const got = await new Promise((resolve) => { wrapped.join('tok', 'pid', 'sid', 'sec', 'key', (err, res) => resolve({ err, res })) })
  console.log(`  ${got.err === boom && got.res === undefined ? '✅' : '❌'} 🔴 回调式调用：错误被**回调**接住（新版库自己不会调它）：${String(got.err?.message)}`)
  // ② 没有回调时也不能悬空
  const p = wrapped.join('tok', 'pid', 'sid', 'sec', 'key')
  await p.catch(() => {})
  // ③ 失败被记下来（给上层翻译成人话）
  const recorded = takeAuthJoinError()
  console.log(`  ${recorded === boom ? '✅' : '❌'} 失败被记进 takeAuthJoinError()（供上层转成"去 MC设置重新登录"）`)
  await new Promise((r) => setTimeout(r, 20))
  process.removeListener('unhandledRejection', onUnhandled)
  console.log(`  ${rejections.length === 0 ? '✅' : '❌'} 🔴 全程**零**未处理拒绝（这就是当初 exit(1) 的根因）：${rejections.join(' | ') || '无'}`)
  console.log(`  ${wrapped.__wcJoinWrapped === true && fakeServer.__calls >= 1 ? '✅' : '❌'} 补丁只包一次（幂等标记 __wcJoinWrapped）`)

  // ④ 认证类错误 → 可执行的用户指引
  const friendly = friendlyAuthError(boom)
  console.log(`  ${/皮肤站认证被拒/.test(friendly.message) && friendly.needUserAction === true && /「MC设置」/.test(friendly.hint ?? '') ? '✅' : '❌'} 🔴 ForbiddenOperationException → needUserAction + "去 MC设置重新登录"指引`)
  const other = friendlyAuthError(new Error('连接 mc.example 超时'))
  console.log(`  ${other.message === '连接 mc.example 超时' && !other.needUserAction ? '✅' : '❌'} 其它错误原样透传（不乱贴"重新登录"标签）`)

  // ⑤ 源码卫生：`void …then(…)` 必须带 catch（我们自己的火忘式 promise）
  const { readFileSync: rf } = await import('node:fs')
  const files = ['index.js', 'src/core.mjs', 'src/watchdog.mjs', 'src/memory.mjs', 'src/accounts.mjs']
  const dangling = []
  for (const f of files) {
    const text = rf(new URL('./' + f, import.meta.url), 'utf8')
    for (const m of text.matchAll(/\bvoid\s+[^\n;]*/g)) {
      if (!/\.then\(/.test(m[0])) continue
      // ⚠️ `.catch()` 常在后续几行（多行链）——要往后看一段，别只盯这一行（否则自己误报）
      const window = text.slice(m.index, m.index + 600)
      if (!/\.catch\(/.test(window)) dangling.push(`${f}: ${m[0].trim().slice(0, 70)}…`)
    }
  }
  console.log(`  ${dangling.length === 0 ? '✅' : '❌'} 🔴 源码里没有"没 catch 的 fire-and-forget then"：${dangling.join(' ｜ ') || '无'}`)
  const info = (await import('./src/core.mjs')).libraryInfo()
  console.log(`  ${typeof info.yggdrasilCompat === 'string' ? '✅' : '❌'} libraryInfo 报出 yggdrasil 兼容层状态：${info.yggdrasilCompat}`)

  /* ⑥ 离线账户**不许**走 session join（2026-09-17 事故的另一半：我们把 haveCredentials 无条件设 true，
   *    离线账户于是拿假 token 去 sessionserver.mojang.com → ForbiddenOperationException → 悬空拒绝 → exit(1)） */
  const { sessionFlags } = await import('./src/core.mjs')
  const off = sessionFlags('offline')
  const ygg = sessionFlags('yggdrasil')
  console.log(`  ${off.haveCredentials === false && off.useAccessToken === false ? '✅' : '❌'} 🔴 离线账户：haveCredentials=false（不走 session join，不递假 token）`)
  console.log(`  ${ygg.haveCredentials === true && ygg.useAccessToken === true ? '✅' : '❌'} 皮肤站账户：haveCredentials=true + 带 accessToken（要跟 session server 报备）`)
  const idxSrc = rf(new URL('./index.js', import.meta.url), 'utf8')
  const coreSrc = rf(new URL('./src/core.mjs', import.meta.url), 'utf8')
  console.log(`  ${/const flags = sessionFlags\(auth\.mode\)/.test(coreSrc) && !/options\.haveCredentials = true/.test(coreSrc) ? '✅' : '❌'} 🔴 连接时按账户类型取开关（没有"无条件 true"了）`)
  console.log(`  ${/process\.on\('unhandledRejection'/.test(idxSrc) ? '✅' : '❌'} 装上了"遗言"记录器（宿主 exit(1) 之前把栈写进插件日志）`)
}

// ── 看门狗唤醒投递（2026-09-15 真机 bug 回归：喊我没反应）──
// 真机症状：看门狗检测正常（woke:true）、但注入报
//   `Cannot read properties of undefined (reading 'throwIfAborted')`
// 根因：sessionController.prompt 是 @Remote 方法，签名 (request, signal)，
//   内部第一行就是 signal.throwIfAborted() —— 我只传了 1 个参数。
// 这条路径是**空闲时唯一的叫醒通道**，一炸就等于永远叫不醒。
// 本测试用**忠实模拟宿主契约**的桩：prompt 真的调 throwIfAborted，不给 signal 必炸。
console.log('\n--- 看门狗唤醒投递（真机 bug 回归）---')
{
  const { Watchdog } = await import('./src/watchdog.mjs')
  const { EventEmitter } = await import('node:events')

  const deliver = []
  const hostLike = {
    // 照抄 api/session-controller/src/index.ts:346 的行为
    prompt: (request, signal) => { signal.throwIfAborted(); deliver.push(request); return Promise.resolve({ accepted: true }) },
    cancel: () => ({ accepted: true }),
  }
  const wdCtx = {
    logger: { info: () => {}, warn: () => {} },
    get: (k) => (k === 'sessionController' ? hostLike : undefined),
  }
  const bot = new EventEmitter()
  const wd = new Watchdog({
    ctx: wdCtx,
    sess: { bot, events: [], agentId: 'sess-w', config: {} },
    agent: { id: 'sess-w', status: 'idle' },
    onFire: () => {},
    promptSignal: new AbortController().signal,
  })
  wd.updateConfig({ observeWindowMs: 100, maxWakePerMinute: 100 })
  wd.arm()

  // 空闲状态下命中叫法 → 走 'queue'（= followup，开新一轮）
  bot.emit('chat', { who: '<user>', text: 'deepseek，你在这里建一座地标塔' })
  await new Promise((r) => setTimeout(r, 1400))

  const got = deliver[0]
  console.log(`  ${got ? '✅' : '❌'} 空闲时能真正投递出去（${deliver.length} 次）`)
  console.log(`  ${got?.mode === 'steer' ? '✅' : '❌'} 空闲也走 steer（宿主语义：idle 会起一轮=唤醒）：mode=${got?.mode}`)
  console.log(`  ${/deepseek/.test(got?.content?.[0]?.text ?? '') ? '✅' : '❌'} 注入正文带上原始消息`)
  console.log(`  ${got?.sessionId === 'sess-w' ? '✅' : '❌'} 绑定到正确会话`)

  // 运行中也必须投得出去，且走 steer（插下一步，不打断）
  deliver.length = 0
  wd.agent = { id: 'sess-w', status: 'running' }
  bot.emit('chat', { who: '<user>', text: 'deepseek 在吗' })
  await new Promise((r) => setTimeout(r, 1400))
  console.log(`  ${deliver[0]?.mode === 'steer' ? '✅' : '❌'} 运行中走 steer=插话不打断：mode=${deliver[0]?.mode}`)
  console.log(`  ${wd.stats.injected >= 1 ? '✅' : '❌'} 注入计数已累加（${wd.stats.injected}）`)

  // 🔴 2026-09-17：**模式闸门** —— 会话切出 MC 模式后，看门狗不许再往会话里注入（同类残留）
  deliver.length = 0
  const droppedBefore = wd.stats.dropped
  wd.gate = () => false
  bot.emit('chat', { who: '<user>', text: 'deepseek 又在吗' })
  await new Promise((r) => setTimeout(r, 1400))
  console.log(`  ${deliver.length === 0 ? '✅' : '❌'} 🔴 闸门关着（已退出 MC 模式）→ **一次都不注入**（实际 ${deliver.length} 次）`)
  console.log(`  ${wd.stats.dropped > droppedBefore ? '✅' : '❌'} 被丢弃的注入记进 stats.dropped（${wd.stats.dropped}）`)
  wd.gate = () => true
  bot.emit('chat', { who: '<user>', text: 'deepseek 回来了吗' })
  await new Promise((r) => setTimeout(r, 1400))
  console.log(`  ${deliver.length >= 1 ? '✅' : '❌'} 闸门打开（切回 MC 模式）→ 立刻恢复注入（${deliver.length} 次；不用重新 arm）`)

  wd.disarm('自检结束')
  console.log(`  ${wd.armed === false ? '✅' : '❌'} disarm 后停止监听`)
}

// ── 看门狗 job 必须能结算（隐患：job 卡在 stopping）──
// 根因：_resolveJob 存了但从没调用 → done 永不 resolve → job_list 里永远挂着
console.log('\n--- 看门狗 job 结算 ---')
{
  const { Watchdog } = await import('./src/watchdog.mjs')
  const { EventEmitter } = await import('node:events')
  let hooks = null
  let startSpec = null
  const kills = []
  const killCallers = []
  const wdCtx = {
    logger: { info: () => {}, warn: () => {} },
    get: (k) => (k === 'jobs'
      ? {
          start: (spec) => { startSpec = spec; hooks = spec.run(); return 'job-1' },
          kill: (id, caller) => { killCallers.push(caller); kills.push(id) },
        }
      : undefined),
  }
  const mk = () => new Watchdog({
    ctx: wdCtx,
    sess: { bot: new EventEmitter(), events: [], agentId: 's', config: {} },
    agent: { id: 's' },
    onFire: () => {},
  })

  const wd = mk()
  wd.arm()
  console.log(`  ${hooks ? '✅' : '❌'} job 已挂上（${wd.jobId}）`)
  // 🔴 2026-10-04（PR #2 @swan3146）：owner 必须是**会话 id 字符串**。宿主 `resolveOwner()`
  //    拿它查 agents 注册表（`agents.get(session)`，按 id 索引）——传 agent 对象必炸
  //    `session "[object Object]" has no live agent`，job 挂不上、静默降级成"无 job 模式"。
  console.log(`  ${typeof startSpec?.owner === 'string' && startSpec.owner === 's' ? '✅' : '❌'} 🔴 start 的 owner 是会话 id 字符串（收到：${JSON.stringify(startSpec?.owner)}）`)

  // 宿主 kill job → 我们的 cancel → 必须结算 done，且不回头再 kill 自己
  let settled = null
  hooks.done.then((v) => { settled = v })
  hooks.cancel('宿主取消')
  await new Promise((r) => setTimeout(r, 30))
  console.log(`  ${settled ? '✅' : '❌'} done 被结算（不再永远挂在 stopping）：status=${settled?.status}`)
  console.log(`  ${kills.length === 0 ? '✅' : '❌'} 不回头 kill 自己（避免自我递归）：kill 调用 ${kills.length} 次`)
  console.log(`  ${wd.armed === false ? '✅' : '❌'} job 被取消后看门狗也已停`)

  // 反向：AI 主动 disarm → 应该真去 kill 那个 job **并且把 done 结算掉**
  // 🔴 2026-09-16 真机 bug：原来只断言了"会去 kill job"，没断言结算 →
  //    于是"强制关闭后 UI 一直显示还有 1 个后台任务 / 正在停止"漏了过去。
  const wd2 = mk()
  wd2.arm()
  const hooks2 = hooks
  let settled2 = null
  hooks2.done.then((v) => { settled2 = v })
  kills.length = 0
  wd2.disarm('AI 主动关闭')
  await new Promise((r) => setTimeout(r, 30))
  console.log(`  ${kills.includes('job-1') ? '✅' : '❌'} AI 主动 disarm 会去 kill job（${kills.join(',') || '没调'}）`)
  console.log(`  ${settled2 ? '✅' : '❌'} 🔴 **主动** disarm 也结算了 done（否则宿主的 job 永远停在 stopping）：status=${settled2?.status}`)

  // 宿主随后回调 cancel()（我们 kill 之后宿主一定会走这一步）→ 幂等，不能报错也不能重复结算
  let secondSettle = 0
  hooks2.done.then(() => { secondSettle++ })
  let cancelThrew = null
  try { hooks2.cancel('宿主随后取消') } catch (e) { cancelThrew = e }
  await new Promise((r) => setTimeout(r, 30))
  console.log(`  ${!cancelThrew ? '✅' : '❌'} 再次进 disarm（已停用状态）不抛错：${cancelThrew ? cancelThrew.message : 'ok'}`)
  console.log(`  ${kills.length === 1 ? '✅' : '❌'} 已停用后不再重复 kill（kill 调用仍 ${kills.length} 次）`)

  // 极端：没 arm 过就直接 disarm（例如重复点"强制停止"）也不能抛
  const wd3 = mk()
  let threw = null
  try { wd3.disarm('没在跑也要能调') } catch (e) { threw = e }
  console.log(`  ${!threw ? '✅' : '❌'} 未启动时 disarm 幂等不抛错`)

  // 🔴 2026-10-04（PR #2 @swan3146）：kill 的 caller 也必须是会话 id 字符串
  //    （宿主 `assertAccess`：`job.owner.id !== caller → throw "belongs to another session"`）。
  console.log(`  ${killCallers.every((c) => c === 's') && killCallers.length > 0 ? '✅' : '❌'} 🔴 kill 的 caller 是会话 id 字符串（收到：${JSON.stringify(killCallers)}）`)

  // 🔴 拿不到会话 id → **不许挂"无主 job"**（无主 job 对**所有会话**可见）：降级 + 留档
  const wdNoId = new Watchdog({ ctx: wdCtx, sess: { bot: new EventEmitter(), events: [], config: {} }, onFire: () => {} })
  wdNoId.arm()
  const degraded = wdNoId.jobId === null && (wdNoId.log ?? []).some((e) => /拿不到会话 id/.test(e.text))
  console.log(`  ${degraded ? '✅' : '❌'} 拿不到会话 id：不挂无主 job（降级 + 留档）`)
  wdNoId.disarm('自检结束')
}

// ── 结构不变量：会话事件队列只能有一个写入方 ──
// 曾经的真 bug：McSession.ensureWired 与看门狗 onFire **都**往 sess.events 写，
// 于是同一句聊天进队列两遍（chat/damage/death 三类）。修法是删掉看门狗那一路。
// 这条测试锁死"别再加回来"——重复事件会让 AI 误判"对方说了两遍"。
console.log('\n--- 结构不变量：事件队列单一写入方 ---')
{
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const wdSrc = readFileSync(fileURLToPath(new URL('./src/watchdog.mjs', import.meta.url)), 'utf8')
  const idxSrc = readFileSync(fileURLToPath(new URL('./index.js', import.meta.url)), 'utf8')

  // 看门狗不得调用 onFire（那正是"第二个写入方"）
  const wdPushes = /this\.onFire\s*\(/.test(wdSrc)
  console.log(`  ${!wdPushes ? '✅' : '❌'} 看门狗不写会话事件队列（无 this.onFire 调用）`)

  // 看门狗不得直接 push 到 sess.events
  const wdSessPush = /sess\.events\.push|this\.sess\.events\.push/.test(wdSrc)
  console.log(`  ${!wdSessPush ? '✅' : '❌'} 看门狗不直接 push sess.events`)

  // index.js 里 ensureWired 必须仍然是写入方（别把它也删了，否则 mc_events 空了）
  const wired = /this\.bot\.on\('chat',[\s\S]{0,120}#pushEvent\('chat'/.test(idxSrc)
  console.log(`  ${wired ? '✅' : '❌'} ensureWired 仍是唯一写入方（mc_events 事件来源）`)

  // 看门狗构造签名里不该再收 onFire
  const ctorTakesOnFire = /constructor \(\{ ctx, sess, agent, onFire/.test(wdSrc)
  console.log(`  ${!ctorTakesOnFire ? '✅' : '❌'} 看门狗构造签名已不含 onFire`)
}

// ── 无 OP 也能建造：创造模式自动取物（真机 mc 就是 creative）──
// 关键事实：mc_give 走 set_creative_slot **协议包**，只要求创造模式，**不要求 OP**。
// 之前 placeBlock 在背包为空时会直接失败（要 AI 先想起调 mc_give），这里补了自动取物。
// 用假 bot 真跑一遍 placeBlock，验证"给个方块名就能建"确实成立。
console.log('\n--- 无 OP 建造（创造模式自动取物）---')
{
  const { McBot } = await import('./src/core.mjs')
  // vec3 的导出形态跟 core.mjs 保持一致（默认导出可能是 {Vec3} 也可能是类本身）
  const vec3mod = await import('vec3')
  const Vec3 = vec3mod.Vec3 ?? vec3mod.default?.Vec3 ?? vec3mod.default ?? vec3mod
  if (typeof Vec3 !== 'function') { console.log('  ⚠️ Vec3 拿不到，跳过这组（不影响其他检查）') }
  else {

  const mkFakeBot = ({ gameMode = 'creative', inventory = [], slots = null } = {}) => {
    const state = { setCalls: [], placed: [], equipped: [] }
    // 有状态的世界：placeBlock 后目标格要真的变成该方块。
    // 因为 placeBlock 现在**会校验结果**（旧版不管成没成都报 placed），假 bot 不更新状态就会被正确判失败。
    const world = new Map()
    const key = (p) => `${p.x},${p.y},${p.z}`
    const fake = {
      username: 'Test_Bot',
      game: { gameMode },
      entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
      players: {},
      controlState: {},
      quickBarSlot: 0,
      inventory: {
        slots: slots ?? new Array(45).fill(null),
        items () { return this.slots.filter(Boolean) },
      },
      blockAt: (pos) => {
        const k = key(pos)
        if (world.has(k)) return { name: world.get(k), boundingBox: 'block', position: pos }
        // 目标格是空气（否则 placeBlock 会报"已被占住"），其余是实心（#placeRef 才找得到依附面）
        if (pos.x === 1 && pos.y === 64 && pos.z === 0) return { name: 'air', boundingBox: 'empty', position: pos }
        return { name: 'stone', boundingBox: 'block', position: pos }
      },
      registry: {
        itemsByName: { oak_planks: { id: 5, stackSize: 64 } },
        items: { 5: { id: 5, name: 'oak_planks', stackSize: 64 } },
        itemsArray: [{ id: 5, name: 'oak_planks', stackSize: 64 }],
        supportFeature: () => false,
        version: { majorVersion: '26', minorVersion: '2' },
      },
      creative: {
        flyTo: async () => {},
        startFlying: () => {},
        stopFlying: () => {},
        setInventorySlot: async (slot, item) => {
          state.setCalls.push({ slot, name: item?.name, count: item?.count })
          if (item) fake.inventory.slots[slot] = { name: item.name, count: item.count, type: item.type }
          else fake.inventory.slots[slot] = null
        },
        clearInventory: async () => {},
      },
      physics: { gravity: 0.08, velocity: new Vec3(0, 0, 0) },
      equip: async (it) => { state.equipped.push(it.name); fake.heldItem = it },
      lookAt: async () => {},
      placeBlock: async (ref) => {
        state.placed.push({ x: ref.position.x, y: ref.position.y, z: ref.position.z })
        // 模拟服务端接受：把"被依附方块相邻的那格"变成新方块。
        // 我们的调用是 placeBlock(ref, face)，目标是 ref+face —— 简化成记录依附点即可，
        // 真正的目标格由测试自己按 (1,64,0) 预置。
        world.set('1,64,0', 'oak_planks')
      },
      setControlState: () => {},
      dig: async () => {},
    }
    return { fake, state }
  }

  // ① 创造 + 背包空 + 指定方块名 → 必须自动取物并放下
  {
    const { fake, state } = mkFakeBot({ gameMode: 'creative', inventory: [] })
    const bot = new McBot({ instanceId: 'selftest-nop' })
    bot.bot = fake
    fake.entity.position = new Vec3(0, 64, 0)
    const r = await bot.placeBlock({ x: 1, y: 64, z: 0, name: 'oak_planks' })
    console.log(`  ${state.setCalls.length === 1 && state.setCalls[0].name === 'oak_planks' ? '✅' : '❌'} 背包空时自动取物（set_creative_slot ${JSON.stringify(state.setCalls)}）`)
    console.log(`  ${state.placed.length === 1 && /oak_planks/.test(String(r.placed ?? '')) ? '✅' : '❌'} 取完就直接放下了（placed=${r.placed}）`)
  }

  // ② 生存模式不该有这福利（不能凭空变东西）
  {
    const { fake, state } = mkFakeBot({ gameMode: 'survival', inventory: [] })
    const bot = new McBot({ instanceId: 'selftest-nop2' })
    bot.bot = fake
    let err = null
    try { await bot.placeBlock({ x: 1, y: 64, z: 0, name: 'oak_planks' }) } catch (e) { err = e }
    console.log(`  ${state.setCalls.length === 0 && /背包里没有/.test(String(err?.message)) ? '✅' : '❌'} 生存模式不自动取物（报错：${String(err?.message).slice(0, 28)}…）`)
  }

  // ③ 不给方块名 + 背包空 → 报错要指导性（告诉它给 name 就能自动取）
  {
    const { fake } = mkFakeBot({ gameMode: 'creative', inventory: [] })
    const bot = new McBot({ instanceId: 'selftest-nop3' })
    bot.bot = fake
    let err = null
    try { await bot.placeBlock({ x: 1, y: 64, z: 0 }) } catch (e) { err = e }
    console.log(`  ${/给 name 指定/.test(String(err?.message)) ? '✅' : '❌'} 没给方块名时报错有指导性`)
  }

  // ④ 槽位选择：已有同款就复用，不占新格、不覆盖别的
  {
    const slots = new Array(45).fill(null)
    slots[36] = { name: 'oak_planks', count: 64 }
    slots[37] = { name: 'stone', count: 64 }
    const { fake, state } = mkFakeBot({ gameMode: 'creative', slots })
    const bot = new McBot({ instanceId: 'selftest-nop4' })
    bot.bot = fake
    await bot.giveItem({ name: 'oak_planks', count: 1 })
    const used = state.setCalls[0]?.slot
    console.log(`  ${used === 36 ? '✅' : '❌'} 同款复用原槽位（用了 ${used}，而不是空槽 38）`)
    console.log(`  ${fake.inventory.slots[37]?.name === 'stone' ? '✅' : '❌'} 没有覆盖掉别的方块（stone 还在 37）`)
  }
  }
}

// ── 看门狗唤醒投递：必须是**提示词注入**，不是模拟用户发言 ──
// 用户要求：不要 followup（那会给对话插一条用户消息），要 steer + plugin 来源。
// `steer` 的宿主文档："An idle driver starts a turn" —— 空闲也能唤醒，正合用。
console.log('\n--- 看门狗唤醒投递（提示词注入，非用户消息）---')
{
  const { Watchdog } = await import('./src/watchdog.mjs')
  const { EventEmitter } = await import('node:events')

  const steerCalls = []
  const promptCalls = []
  const fakeAgent = { id: 'sess-w', status: 'idle', steer: (msg) => { steerCalls.push(msg) } }
  const wdCtx = {
    logger: { info: () => {}, warn: () => {} },
    get: (k) => (k === 'sessionController'
      ? { prompt: (req, sig) => { sig.throwIfAborted(); promptCalls.push(req); return Promise.resolve({}) } }
      : undefined),
  }
  const bot = new EventEmitter()
  const wd = new Watchdog({
    ctx: wdCtx,
    sess: { bot, events: [], agentId: 'sess-w', config: {} },
    agent: fakeAgent,
    promptSignal: new AbortController().signal,
  })
  wd.updateConfig({ observeWindowMs: 100, maxWakePerMinute: 100 })
  wd.arm()

  bot.emit('chat', { who: '<user>', text: 'deepseek，你在这里建一座地标塔' })
  await new Promise((r) => setTimeout(r, 1400))

  const msg = steerCalls[0]
  console.log(`  ${steerCalls.length === 1 ? '✅' : '❌'} 走 agent.steer（${steerCalls.length} 次）`)
  console.log(`  ${promptCalls.length === 0 ? '✅' : '❌'} **没有**走 sessionController.prompt/followup（${promptCalls.length} 次）`)
  console.log(`  ${msg?.source?.kind === 'plugin:whale_craft' ? '✅' : '❌'} 来源是 plugin:whale_craft（不是 user）：kind=${msg?.source?.kind}`)
  console.log(`  ${msg?.source?.form === 'notice' ? '✅' : '❌'} form=notice（渲染成折叠摘要行）`)
  console.log(`  ${msg?.source?.kind === 'plugin:whale_craft' && msg?.source?.plugin === undefined ? '✅' : '❌'} kind 是 v4 规范值（且不带旧 plugin 字段）`)
  console.log(`  ${/deepseek/.test(msg?.content?.[0]?.text ?? '') ? '✅' : '❌'} 正文带上原始消息`)
  console.log(`  ${/MC 看门狗/.test(String(msg?.source?.summary ?? '')) ? '✅' : '❌'} 有单行摘要`)
  console.log(`  ${typeof msg?.id === 'string' && msg.id.length > 8 ? '✅' : '❌'} 是合法的 UserMessage（有 id）`)

  steerCalls.length = 0
  fakeAgent.status = 'running'
  bot.emit('chat', { who: '<user>', text: 'deepseek 在吗' })
  await new Promise((r) => setTimeout(r, 1400))
  console.log(`  ${steerCalls.length === 1 && promptCalls.length === 0 ? '✅' : '❌'} 运行中也用 steer（不分叉成 followup）`)

  wd.disarm('自检结束')
}

// ── 放置可行性判据（用户问：洞穴空气？液体？）──
console.log('\n--- 放置可行性判据 ---')
{
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const src = readFileSync(fileURLToPath(new URL('./src/core.mjs', import.meta.url)), 'utf8')

  console.log(`  ${/boundingBox === 'empty'/.test(src) ? '✅' : '❌'} 判据用 boundingBox==='empty'（不占空间 = 可放）`)
  console.log(`  ${/isLiquid/.test(src) ? '✅' : '❌'} 液体被认作可放 —— 旧版只认 air，水里建不了（码头/桥全废）`)
  console.log(`  ${/canPlaceInto/.test(src) ? '✅' : '❌'} canPlaceInto 已就位`)
  console.log(`  ${/未加载（区块还没到）/.test(src) ? '✅' : '❌'} 未加载的坐标明确拒绝（不盲放）`)
  console.log(`  ${/占住，放不进去/.test(src) ? '✅' : '❌'} 被占住时报错说清是哪个方块`)

  // 从**解析到的** mineflayer 位置取它的依赖树（与插件里 requireFromMineflayer 同一手法）
  const requireHere = (await import('node:module')).createRequire(import.meta.url)
  const req = (await import('node:module')).createRequire(requireHere.resolve('mineflayer'))
  // ⚠️ **不许写死 '26.2'**（2026-09-16 第八轮：干净环境里 mcData 为 null → 整个自检崩在这里，
  //    后面 3 个分节全没跑）。26.2 只有本机那份打过补丁的 minecraft-data 才有；
  //    官方版没有 → 从**实际装的那份**里挑一个真有数据的版本。
  const mcDataPkg = req('minecraft-data')
  const pcVersions = (mcDataPkg.versions?.pc ?? []).map((v) => v.minecraftVersion)
  let version = null
  let mcData = null
  for (const v of ['26.2', ...pcVersions]) {
    const d = mcDataPkg(v)
    if (d?.blocksByName) { version = v; mcData = d; break }
  }
  if (!mcData) {
    console.log(`  ⏭ 真值表跳过：这份 minecraft-data 里找不到有方块数据的版本（${pcVersions.length} 个候选）`)
  } else {
    const shape = (n) => mcData.blocksByName[n]?.boundingBox
    const want = {
      air: 'empty', cave_air: 'empty', void_air: 'empty',
      water: 'empty', lava: 'empty',
      short_grass: 'empty', seagrass: 'empty', torch: 'empty',
      stone: 'block', oak_planks: 'block',
    }
    // 老版本没有某个方块（void_air / short_grass 之类）→ 跳过而不是判错
    const present = Object.entries(want).filter(([n]) => mcData.blocksByName[n])
    const skipped = Object.keys(want).length - present.length
    const bad = present.filter(([n, s]) => shape(n) !== s)
    console.log(bad.length
      ? `  ❌ 与 minecraft-data(${version}) 不符：${bad.map(([n, s]) => `${n}(期望${s} 实际${shape(n)})`).join(', ')}`
      : `  ✅ 真值表与 minecraft-data(${version}) 一致（${present.length} 个方块${skipped ? `，另有 ${skipped} 个该版本没有、已跳过` : ''}）`)
  }
}

// ── mc_connect 必须接受全部连接参数（工具化，不再强绑服务器）──
console.log('\n--- mc_connect 参数面 ---')
// defineTool 会把 parameters 归一成 JSON Schema，真正的参数在 .properties 里
// 2026-10-05（用户定）：凭据参数早已移除；连接参数收成单一 `address` + `account`
// （host/port/subserver/version 全部移除——地址自带端口，版本永远自动探测，无子服概念）
const raw = tools.get('mc_connect').parameters ?? {}
const cp = Object.keys(raw.properties ?? raw)
const need = ['address', 'account']
const gone = ['authUrl', 'authUser', 'authPass', 'host', 'port', 'subserver', 'version']
const missing = need.filter((k) => !cp.includes(k))
const leaked = gone.filter((k) => cp.includes(k))
console.log(missing.length ? `  ❌ 缺少参数：${missing.join(', ')}` : `  ✅ 连接参数齐全：${cp.join(', ')}`)
console.log(leaked.length ? `  ❌ 已移除的参数又回来了：${leaked.join(', ')}` : '  ✅ mc_connect 只有 address/account（无凭据、无 host/port/subserver/version）')
{
  // 🔴 2026-10-05：版本不受支持时 mineflayer 在 spawn 前 async 抛 "No data available for version X"，
  //    必须快速失败并映射成明确错误——否则表层报成误导性的"连接超时"（真机 26.2 服务器）。
  const { readFileSync } = await import('node:fs')
  const coreSrc = readFileSync(new URL('./src/core.mjs', import.meta.url), 'utf8')
  const fastFail = /b\.on\('error', onErr\)/.test(coreSrc) && /b\.on\('end', onEnd\)/.test(coreSrc)
  const mapped = /No data available for version/.test(coreSrc)
  console.log(`  ${fastFail && mapped ? '✅' : '❌'} 🔴 版本不受支持：建连期间快速失败 + 映射为明确版本错误（不是"连接超时"）`)
}

// ── 客户端 bundle 静态断言（防误删/防回退；真机渲染仍要浏览器里看）──
// ── 局域网探测（mc_lan）：纯函数 + **真在回环上跑一遍协议** ──
console.log('\n--- 局域网探测（mc_lan）---')
{
  const L = await import('./src/lan.mjs')
  const { readFileSync } = await import('node:fs')

  // ① 广播文本解析（Minecraft "对局域网开放" 的格式）
  const b1 = L.parseLanBroadcast('[MOTD]A Minecraft Server[/MOTD][AD]25565[/AD]')
  console.log(`  ${b1?.port === 25565 && b1?.motd === 'A Minecraft Server' ? '✅' : '❌'} 解析局域网广播（MOTD + 端口）`)
  console.log(`  ${L.parseLanBroadcast('乱七八糟') === null && L.parseLanBroadcast('[AD]0[/AD]') === null ? '✅' : '❌'} 垃圾文本/非法端口 → null`)

  // ② 提示词里说的机制（多播组 + 端口）必须是真代码里那一个
  console.log(`  ${L.LAN_BROADCAST?.group === '224.0.2.60' && L.LAN_BROADCAST?.port === 4445 ? '✅' : '❌'} 多播组是原版那个 224.0.2.60:4445（${L.LAN_BROADCAST?.group}:${L.LAN_BROADCAST?.port}）`)

  // ③ 扫描那半边必须**真的没了**（用户 2026-09-18 砍的：原版都不扫）
  const scanGone = ['scanSubnet', 'hostsOf', 'probePort', 'statusPing', 'isPrivateIPv4', 'localSubnets', 'localAddresses']
    .filter((k) => k in L)
  console.log(`  ${scanGone.length === 0 ? '✅' : '❌'} 扫段已彻底移除（${scanGone.length ? '还在：' + scanGone.join(', ') : '7 个导出全没了'}）`)
  const lanSource = readFileSync(new URL('./src/lan.mjs', import.meta.url), 'utf8')
  const danger = ['node:net', 'scanSubnet', 'statusPing', 'probePort'].filter((k) => lanSource.includes(k))
  console.log(`  ${danger.length === 0 ? '✅' : '❌'} lan.mjs 连 TCP 都不再 import（${danger.length ? '命中：' + danger.join(', ') : '只有 node:dgram'}）`)

  // ④ 真在回环上发一条公告，听得到、且只听到合法的
  //    ⚠️ 用固定端口。曾经用 `bind(0)` 的临时端口，结果**发件 socket 自己**占着那个端口
  //    （reuseAddr 下同端口重复 bind 会成功），包被发件方收走，监听方一条都收不到 → 假红。
  {
    const { createSocket } = await import('node:dgram')
    const listenPort = 45551
    const srv = createSocket({ type: 'udp4' })
    await new Promise((r) => srv.bind(0, '127.0.0.1', r))
    const wait = L.listenLanBroadcast({ seconds: 2, port: listenPort })
    await new Promise((r) => setTimeout(r, 150))
    const send = (s) => new Promise((r) => srv.send(Buffer.from(s, 'utf8'), listenPort, '127.0.0.1', r))
    await send('[MOTD]A Minecraft Server[/MOTD][AD]25565[/AD]')
    await send('乱七八糟')                                   // 非公告 → 必须被丢掉
    await send('[MOTD]重复发[/MOTD][AD]25565[/AD]')            // 同 host+port 重复 → 只留一条
    const heard = await wait
    srv.close()
    const hit = heard.find((h) => h.host === '127.0.0.1' && h.port === 25565)
    console.log(`  ${hit && hit.motd === 'A Minecraft Server' && hit.source === 'broadcast' ? '✅' : '❌'} 听到局域网公告（host + 端口 + MOTD，source=broadcast）`)
    console.log(`  ${heard.length === 1 ? '✅' : '❌'} 垃圾包被丢、同 host+port 去重（听到 ${heard.length} 条）`)
  }

  // ⑤ 到点必须收工（别把工具调用挂住），且写死的 15s 上限还在
  {
    const t0 = Date.now()
    const heard = await L.listenLanBroadcast({ seconds: 1 })
    const dt = Date.now() - t0
    console.log(`  ${dt >= 900 && dt < 2500 && Array.isArray(heard) ? '✅' : '❌'} seconds=1 到点就返回（实测 ${dt}ms，没人公告也返回空数组）`)
    const t1 = Date.now()
    await L.listenLanBroadcast({ seconds: 999 })
    const dt1 = Date.now() - t1
    console.log(`  ${dt1 < 16000 ? '✅' : '❌'} seconds 再大也被夹到 15 秒上限（实测 ${dt1}ms）`)
  }

  // ⑥ 工具面：注册了、参数只剩 seconds（`mode` 已于 2026-10-05 移除）
  const lanDef = tools.get('mc_lan')
  console.log(`  ${lanDef ? '✅' : '❌'} 注册了 mc_lan 工具`)
  const lanParams = Object.keys(lanDef?.parameters?.properties ?? lanDef?.parameters ?? {})   // defineTool 归一成 JSON Schema，真参数在 .properties
  console.log(`  ${lanParams.length === 1 && lanParams.includes('seconds') ? '✅' : '❌'} 参数只剩 seconds（${lanParams.join(', ')}）`)
  const scanParams = ['subnet', 'ports', 'timeoutMs', 'pingTimeoutMs', 'includeSelf'].filter((k) => lanParams.includes(k))
  console.log(`  ${scanParams.length === 0 ? '✅' : '❌'} 扫段参数已从工具面移除（${scanParams.length ? '还在：' + scanParams.join(', ') : '没有 subnet/ports/timeoutMs/pingTimeoutMs/includeSelf'}）`)
  const lanDefault = await tools.get('mc_lan').execute({ seconds: 1 }, A)
  console.log(`  ${lanDefault?.mode === 'broadcast' && !('scanned' in (lanDefault ?? {})) ? '✅' : '❌'} 默认就是纯广播：mode=broadcast、没有 scanned 字段（听到 ${lanDefault?.count ?? '?'} 个）`)
}

// ── 单地址探测（mc_ping）：纯函数 + **真起一个 MC 服务端 ping 它** ──
console.log('\n--- 单地址探测（mc_ping）---')
{
  const P = await import('./src/ping.mjs')

  // ① 地址解析：这几种写法都必须认，含糊的必须拒绝
  const forms = [
    ['example.com', { host: 'example.com', port: 25565 }],
    ['example.com:25566', { host: 'example.com', port: 25566 }],
    ['127.0.0.1:1', { host: '127.0.0.1', port: 1 }],
    ['[::1]:25570', { host: '::1', port: 25570 }],
  ]
  const parsedOk = forms.every(([in_, want]) => JSON.stringify(P.parseAddress(in_)) === JSON.stringify(want))
  console.log(`  ${parsedOk ? '✅' : '❌'} 地址解析（域名 / 域名:端口 / IP:端口 / [IPv6]:端口）`)
  const throws = ['', 'a:b:c', 'x:99999', 'x:0']
  const throwOk = throws.every((s) => { try { P.parseAddress(s); return false } catch { return true } })
  console.log(`  ${throwOk ? '✅' : '❌'} 空地址 / 多个冒号 / 端口越界 → 抛错（${throws.length} 种）`)
  console.log(`  ${P.parseAddress('example.com', 25570).port === 25570 ? '✅' : '❌'} port 参数作默认值（address 里带端口时以 address 为准）`)

  // ② MOTD 拍平（颜色码要去掉）——与 mc_connect 进服后看到的是同一份文本
  console.log(`  ${P.flattenMotd({ text: 'A ', extra: [{ text: '§aFake' }, { text: ' §rServer' }] }) === 'A Fake Server' ? '✅' : '❌'} MOTD 组件拍平 + 去掉 § 颜色码`)

  // ③ 错误要说人话（不然 LLM 得自己猜一轮）
  const friendly = [
    ['ECONNREFUSED', /没人听/],
    ['ENOTFOUND', /解析不了/],
    ['ETIMEDOUT', /没回应/],
  ]
  const friendlyOk = friendly.every(([code, re]) => re.test(P.friendlyNetError({ code })))
  console.log(`  ${friendlyOk ? '✅' : '❌'} 常见网络错误 → 人话（${friendly.map(([c]) => c).join(' / ')}）`)

  // ④ 🔴 没人听的端口：必须**立刻**返回 ECONNREFUSED（不是等超时、更不能把进程带走）
  const refused = await P.statusPing({ host: '127.0.0.1', port: 1, timeoutMs: 3000 })
  console.log(`  ${refused.ok === false && refused.code === 'ECONNREFUSED' && refused.elapsedMs < 3000 ? '✅' : '❌'} 端口没人听 → 立刻 ok:false + ECONNREFUSED（${refused.elapsedMs}ms｜${refused.hint}）`)

  // ⑤ 域名解析不了 → 指向 DNS。
  // 🔴 用**纯函数**断言，不拿真网络测：DNS 行为依环境而异（有的解析器把不存在的域名挂到连接超时，
  //    而不是回 NXDOMAIN，于是走不到"解析不了"这条 hint —— 本机就是这样，那条 live 断言是假红）。
  const dnsHint = /解析/.test(P.friendlyNetError({ code: 'ENOTFOUND' })) && /解析|DNS/.test(P.friendlyNetError({ code: 'EAI_AGAIN' }))
  console.log(`  ${dnsHint ? '✅' : '❌'} 域名解析不了 / 解析超时 → 指向 DNS（纯函数：ENOTFOUND / EAI_AGAIN）`)

  // ⑥ 黑洞（只 accept 不回包）：必须被**自己的硬超时**掐掉（上游默认是 120 秒，不能等它）
  const { createServer: tcpServer } = await import('node:net')
  const blackhole = tcpServer(() => { /* 收下连接，什么都不回 */ })
  await new Promise((r) => blackhole.listen(0, '127.0.0.1', r))
  const t0 = Date.now()
  const silent = await P.statusPing({ host: '127.0.0.1', port: blackhole.address().port, timeoutMs: 1200 })
  const wall = Date.now() - t0
  blackhole.close()
  console.log(`  ${silent.ok === false && wall < 3000 ? '✅' : '❌'} 黑洞连接 → ${wall}ms 就被硬超时掐掉（不是等上游 120 秒）`)

  // ⑦ 🔴 真起一个 MC 服务端，把整条 STATUS 路跑通
  {
    const { createRequire } = await import('node:module')
    const req = createRequire(createRequire(import.meta.url).resolve('mineflayer'))
    let srv = null
    try {
      srv = req('minecraft-protocol').createServer({
        'online-mode': false, port: 0, host: '127.0.0.1', version: '1.21.4',
        motd: '§a探针服务端 §r| §bhello', maxPlayers: 7,
      })
      await new Promise((r) => srv.once('listening', r))
      const port = srv.socketServer.address().port
      const up = await P.statusPing({ host: '127.0.0.1', port, timeoutMs: 5000 })
      console.log(`  ${up.ok === true && Number.isFinite(up.elapsedMs) ? '✅' : '❌'} 真 MC 服务端 STATUS ping 跑通（${up.ok ? `${up.elapsedMs}ms` : up.error}）`)
      console.log(`  ${up.version === '1.21.4' && up.protocol === 769 ? '✅' : '❌'} 读到版本 ${up.version}（协议 ${up.protocol}）＝ mc_connect 会用的那个版本`)
      console.log(`  ${up.players?.online === 0 && up.players?.max === 7 ? '✅' : '❌'} 读到人数 ${up.players?.online}/${up.players?.max}`)
      console.log(`  ${up.motd === '探针服务端 | hello' ? '✅' : '❌'} 读到 MOTD（颜色码已去）：${JSON.stringify(up.motd)}`)
      console.log(`  ${Number.isFinite(up.latencyMs) && up.latencyMs >= 0 ? '✅' : '❌'} 读到延迟 ${up.latencyMs}ms`)
    } catch (e) {
      console.log(`  ❌ 真 MC 服务端那段没跑起来：${e?.message ?? e}`)
    } finally {
      try { srv?.close() } catch { /* 没起来就算了 */ }
    }
  }

  // ⑧ 工具面：注册了、参数齐、**不需要账户**（不传 exec 里的账户解析也能跑）
  const pingDef = tools.get('mc_ping')
  console.log(`  ${pingDef ? '✅' : '❌'} 注册了 mc_ping 工具`)
  const pingParams = Object.keys(pingDef?.parameters?.properties ?? pingDef?.parameters ?? {})
  const wantParams = ['address', 'timeoutMs']
  console.log(`  ${wantParams.every((k) => pingParams.includes(k)) ? '✅' : '❌'} 参数齐（${pingParams.join(', ')}）`)
  const pingOut = await tools.get('mc_ping').execute({ address: '127.0.0.1:1', timeoutMs: 2000 }, A)
  console.log(`  ${pingOut?.ok === false && pingOut?.code === 'ECONNREFUSED' ? '✅' : '❌'} 工具路径也不抛异常、原样回 ok:false（${pingOut?.code}）`)
}

console.log('\n--- MC 版本范围判定（src/mcversion.mjs）---')
{
  const { isVersionSupported, parseRelease, classifyVersion, supportedRange } = await import('./src/mcversion.mjs')
  // 显式区间：**不依赖本机 mineflayer**；覆盖经典 1.x、新 26.x 规则、快照三族、未知三态
  const range = { oldest: '1.8.8', latest: '26.1' }
  const cases = [
    ['1.8.8', true], ['1.8.7', false], ['1.7.10', false],           // 下界
    ['1.19', true], ['1.21.7', true], ['1.21.11', true],           // 区间内（含清单外的 1.21.7）
    ['26.1', true], ['26.2', false], ['26.3', false],              // 新 26.x 规则 / 上界
    ['25w46a', false], ['26.3-snapshot-10', false], ['26.3-pre-2', false],
    ['1.21.4-pre1', false], ['1.21.2-rc1', false],                 // 快照/预发布一律不支持
    ['', null], [null, null], ['weird-ver', null],                 // 未知 → null（按支持处理）
  ]
  const bad = cases.filter(([v, exp]) => isVersionSupported(v, range) !== exp)
  console.log(`  ${bad.length === 0 ? '✅' : '❌'} isVersionSupported（新 26.x 规则 + 快照一律 false + 未知 null）：${bad.map(([v, e]) => `${JSON.stringify(v)}期望${e}实际${isVersionSupported(v, range)}`).join(', ') || `${cases.length} 例全过`}`)
  const live = supportedRange()
  console.log(`  ${live && live.oldest && live.latest && live.tested.length ? '✅' : '❌'} supportedRange() 读 mineflayer testedVersions 上下界：${live ? `${live.oldest} .. ${live.latest}（${live.tested.length} 项）` : 'null'}`)
  console.log(`  ${classifyVersion('26.1') === 'release' && classifyVersion('25w46a') === 'snapshot' && classifyVersion('x') === 'unknown' ? '✅' : '❌'} classifyVersion 三态（release / snapshot / unknown）`)
  console.log(`  ${JSON.stringify(parseRelease('1.19')) === '[1,19,0]' && JSON.stringify(parseRelease('26.1')) === '[26,1,0]' ? '✅' : '❌'} parseRelease 缺段补 0（1.19→1.19.0；26.1→26.1.0）`)
}

console.log('\n--- 网页抓取：域名表匹配 + 输出渲染（src/config.mjs hostAllowed / src/webfetch.mjs）---')
{
  const { hostAllowed } = await import('./src/config.mjs')
  const { htmlToMarkdown, renderFetchText, EXTERNAL_WEB_CONTENT_NOTICE, WEB_FETCH_MAX_OUTPUT_CHARS } = await import('./src/webfetch.mjs')
  const def = ['minecraft.wiki', '*.minecraft.wiki']
  const domainCases = [
    // [主机名, 表, allowAll, 期望]
    ['minecraft.wiki', def, false, true],
    ['zh.minecraft.wiki', def, false, true],
    ['a.b.minecraft.wiki', def, false, true],          // 通配 * = 任意字符（多级子域也中）
    ['MINECRAFT.WIKI', def, false, true],              // 大小写不敏感
    ['minecraft.wiki:443', def, false, true],          // 带端口（hostAllowed 直接收 host，端口也容错）
    ['evilminecraft.wiki', def, false, false],         // 通配要求 `*.` 前面有点 → 不中
    ['wiki', def, false, false],
    ['', def, false, false],
    ['example.com', def, false, false],
    ['example.com', [], false, false],                 // 空表 = 一个都不允许
    ['example.com', [], true, true],                   // 允许所有
    ['anything.test', ['*'], false, true],             // `*` = 全部放行
    ['sub.example.com', ['*.example.com'], false, true],
    ['example.com', ['*.example.com'], false, false],  // 裸域不中通配（默认表就是靠这个分开的）
    ['api.example.com', ['/^api\\./'], false, true],   // 正则
    ['web.example.com', ['/^api\\./'], false, false],
  ]
  const wrong = domainCases.filter(([host, list, all, exp]) => hostAllowed(host, { allowAll: all, list }) !== exp)
  console.log(`  ${wrong.length === 0 ? '✅' : '❌'} hostAllowed：精确 / 通配 / 正则 / 星号 / 空表 / 大小写（${domainCases.length} 例）${wrong.length ? '：' + wrong.map(([h, , a, e]) => `${h}(期望${e})`).join(', ') : ''}`)
  const badRe = hostAllowed('x.test', { list: ['/[unclosed/'] })
  console.log(`  ${badRe === false ? '✅' : '❌'} 坏正则不炸（忽略该条，按不命中算）`)

  const html = '<h1>钻石</h1><p>钻石是<strong>很硬</strong>的。</p>'
    + '<ul><li>用铁镐</li><li>Y=-59</li></ul>'
    + '<p>见 <a href="https://minecraft.wiki/w/Diamond">Diamond</a>。</p>'
    + '<script>alert(1)</script><style>p{}</style><img src="/a.png" alt="图">'
  const md = htmlToMarkdown(html)
  console.log(`  ${md.includes('# 钻石') && md.includes('- 用铁镐') && md.includes('[Diamond](https://minecraft.wiki/w/Diamond)') ? '✅' : '❌'} 轻量 HTML→markdown：标题/列表/链接（\n${JSON.stringify(md.slice(0, 90))}…）`)
  console.log(`  ${!md.includes('alert(1)') && !md.includes('p{}') ? '✅' : '❌'} 🔴 script/style 的内容被整段丢掉（不把脚本喂给模型）`)
  console.log(`  ${md.includes('![图](/a.png)') ? '✅' : '❌'} img → markdown 图片语法`)
  console.log(`  ${htmlToMarkdown('a &amp; b &lt;x&gt; &#65; &nbsp;') === 'a & b <x> A' ? '✅' : '❌'} 实体解码（命名 / 十进制 / nbsp）`)
  console.log(`  ${htmlToMarkdown('') === '' && !/<[a-z]/i.test(htmlToMarkdown('<div>a</div>')) ? '✅' : '❌'} 剥完标签不留裸尖括号（空输入也不炸）`)

  const textRes = { url: 'https://minecraft.wiki/w/X', statusCode: 200, body: { kind: 'text', content: 'plain body' }, truncated: false }
  const textOut = renderFetchText(textRes)
  const lines2 = textOut.split('\n')
  console.log(`  ${lines2[0] === 'Fetched https://minecraft.wiki/w/X (HTTP 200)' ? '✅' : '❌'} 🔴 首行与宿主同形：Fetched <url> (HTTP <status>)（${JSON.stringify(lines2[0])}）`)
  console.log(`  ${textOut.includes(EXTERNAL_WEB_CONTENT_NOTICE) ? '✅' : '❌'} 正文前带反注入声明（外部内容当数据、不当指令）`)
  console.log(`  ${textOut.includes('plain body') && !textOut.includes('Content truncated') ? '✅' : '❌'} 纯文本正文原样透传、没截断就不加尾注`)
  const cutRes = renderFetchText({ ...textRes, body: { kind: 'text', content: 'x'.repeat(500) } }, 200)
  console.log(`  ${cutRes.length <= 200 && cutRes.endsWith('full text.)') ? '✅' : '❌'} 🔴 超上限时保住尾部那句"换个更具体的 URL"（总长 ${cutRes.length} ≤ 200）`)
  const provTrunc = renderFetchText({ ...textRes, truncated: true }, 10_000)
  console.log(`  ${provTrunc.includes('Content truncated') ? '✅' : '❌'} 抓取侧截断过（truncated:true）也补尾注`)
  console.log(`  ${renderFetchText({ ...textRes, body: { kind: 'text', content: 'x'.repeat(300_000) } }).length >= WEB_FETCH_MAX_OUTPUT_CHARS - 100 ? '✅' : '❌'} 默认上限 ${WEB_FETCH_MAX_OUTPUT_CHARS}（与宿主 tool-web 的 fetchMaxOutputChars 一致）`)
  console.log(`  ${!/friendlyFetchError/.test((await import('node:fs')).readFileSync(new URL('./src/webfetch.mjs', import.meta.url), 'utf8')) ? '✅' : '❌'} 🔴 src/webfetch.mjs 里没有"宿主错误翻译"残留（不再走宿主）`)
}

console.log('\n--- 公网抓取（src/webget.mjs：唯一出网口；文本 + 图片一套逻辑）---')
{
  const { isPublicIp, classifyContentType, contentTypeAllowed, decodeBodyText, charsetOf, supportedImageFormat, fetchUrl, WEB_IMAGE_FORMATS, WEB_GET_MAX_BODY_CHARS } = await import('./src/webget.mjs')
  const { createServer } = await import('node:http')
  const { gzipSync, brotliCompressSync } = await import('node:zlib')
  const idxSrc = (await import('node:fs')).readFileSync(new URL('./index.js', import.meta.url), 'utf8')

  // ① 公网地址判定（照宿主规则自己实现的那份；比宿主更严：tunnelling/转换前缀按内嵌 IPv4 复核）
  const ipCases = [
    ['8.8.8.8', true], ['1.2.3.4', true], ['172.32.0.1', true], ['100.63.0.1', true],
    ['127.0.0.1', false], ['10.1.2.3', false], ['172.16.0.1', false], ['192.168.1.1', false],
    ['169.254.1.1', false], ['100.64.0.1', false], ['0.0.0.0', false], ['224.0.0.1', false],
    ['255.255.255.255', false], ['192.0.2.1', false], ['198.51.100.7', false], ['203.0.113.9', false],
    ['198.18.0.1', false], ['192.88.99.1', false],
    ['::1', false], ['::', false], ['fd00::1', false], ['fe80::1', false], ['ff02::1', false],
    ['2001:db8::1', false], ['2001:0:0:0:0:0:0:1', false], ['2606:4700::1111', true],
    ['2001:4860:4860::8888', true], ['::ffff:127.0.0.1', false], ['::ffff:8.8.8.8', true],
    ['64:ff9b::10.0.0.1', false], ['64:ff9b::8.8.8.8', true], ['2002:0a00:0001::1', false],
    ['2002:0808:0808::1', true], ['3fff::1', false], ['not-an-ip', false], ['', false],
  ]
  const ipBad = ipCases.filter(([ip, exp]) => isPublicIp(ip) !== exp)
  console.log(`  ${ipBad.length === 0 ? '✅' : '❌'} 🔴 公网地址判定（私网/回环/链路本地/CGNAT/保留/多播/文档段 + IPv6 映射·NAT64·6to4·Teredo 的内嵌 IPv4 复核）：${ipBad.length ? ipBad.map(([ip, e]) => `${ip}期望${e}`).join(', ') : `${ipCases.length} 例全过`}`)

  // ② 内容类型判定（**只有内置的格式和未知的格式**：没有"是图片但不在名单"这一档）
  const ctCases = [
    ['text/html', 'html'], ['text/html; charset=UTF-8', 'html'], ['application/xhtml+xml', 'html'],
    ['text/plain', 'text'], ['application/json', 'text'], ['application/ld+json', 'text'],
    ['application/xml', 'text'], ['application/rss+xml', 'text'], ['image/svg+xml', 'text'],
    ['image/png', 'image'], ['image/jpeg', 'image'], ['image/jpg', 'image'], ['image/gif', 'image'], ['image/webp', 'image'],
    ['image/bmp', null], ['image/avif', null], ['image/tiff', null], ['application/pdf', null],
    ['text', null], ['', null], [undefined, null],
  ]
  const ctBad = ctCases.filter(([ct, kind]) => (classifyContentType(ct)?.kind ?? null) !== kind)
  console.log(`  ${ctBad.length === 0 ? '✅' : '❌'} 🔴 classifyContentType：html / text（含 JSON/XML/加号后缀 xml/svg+xml）/ 内置四种图片 / 其余 null（${ctCases.length} 例）${ctBad.length ? '：' + ctBad.map(([ct]) => ct).join(', ') : ''}`)
  console.log(`  ${classifyContentType('image/jpg')?.format === 'jpeg' && classifyContentType('image/svg+xml')?.kind === 'text' ? '✅' : '❌'} jpg 归一成 jpeg；image/svg+xml 算**文本**（宿主同款分类顺序）`)
  console.log(`  ${supportedImageFormat('image/png') === 'png' && supportedImageFormat('image/bmp') === null && WEB_IMAGE_FORMATS.length === 4 ? '✅' : '❌'} supportedImageFormat 只认内置四种（${WEB_IMAGE_FORMATS.join('/')}）`)
  const allowCases = [
    ['html', { html: true, text: false, image: false }, true],
    ['html', { html: false, text: true, image: true }, false],
    ['text', { html: true, text: false, image: true }, false],
    ['image', { html: true, text: true, image: true }, true],
    ['image', { html: true, text: true, image: false }, false],
    ['other', { html: true, text: true, image: true }, false],
  ]
  const allowBad = allowCases.filter(([kind, allow, exp]) => contentTypeAllowed(kind, allow) !== exp)
  console.log(`  ${allowBad.length === 0 ? '✅' : '❌'} contentTypeAllowed 三开关精确判定（${allowCases.length} 例）`)

  // ③ charset 解码（声明了就用它；不认识的直接报错，不吐乱码）
  console.log(`  ${charsetOf('text/html; charset=GBK') === 'gbk' && charsetOf('text/html') === undefined ? '✅' : '❌'} charsetOf 取声明编码（小写）`)
  console.log(`  ${decodeBodyText(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), 'gbk').text === '中文' ? '✅' : '❌'} 🔴 按 GBK 解码（不是硬套 utf-8，页面不吐乱码）`)
  const longText = decodeBodyText(Buffer.alloc(WEB_GET_MAX_BODY_CHARS + 5, 0x61), undefined)
  console.log(`  ${longText.text.length === WEB_GET_MAX_BODY_CHARS && longText.truncated === true ? '✅' : '❌'} 正文超过 ${WEB_GET_MAX_BODY_CHARS} 字符 → 截断并标记`)
  const badCs = (() => { try { decodeBodyText(Buffer.from('x'), 'nope-9') } catch (e) { return e.message } })()
  console.log(`  ${/不认识/.test(String(badCs)) ? '✅' : '❌'} 不认识的 charset 直接报错：${String(badCs).slice(0, 20)}…`)

  // ④ 真链路：对着**本机 http 服务**跑（注入 lookup/assertPublic —— 本机是私网地址，正常路径会拒）
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  const PAGE = '<h1>标题</h1><p>正文</p>'
  const serve = (handler) => new Promise((resolve) => {
    const s = createServer(handler)
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }))
  })
  const a = await serve((req, res) => {
    if (req.url === '/page.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); return }
    if (req.url === '/api.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"a":1}'); return }
    if (req.url === '/ok.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); return }
    if (req.url === '/gbk.html') { res.writeHead(200, { 'content-type': 'text/html; charset=gbk' }); res.end(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])); return }
    if (req.url === '/gzip.html') { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }); res.end(gzipSync(Buffer.from(PAGE))); return }
    if (req.url === '/br.json') { res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'br' }); res.end(brotliCompressSync(Buffer.from('{"b":2}'))); return }
    if (req.url === '/weird.html') { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'zstd' }); res.end(PAGE); return }
    if (req.url === '/bmp.png') { res.writeHead(200, { 'content-type': 'image/bmp' }); res.end(PNG); return }
    if (req.url === '/noct') { res.writeHead(200, {}); res.end('x'); return }
    if (req.url === '/big.txt') { res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '4096' }); res.end(Buffer.alloc(4096, 0x61)); return }
    if (req.url === '/chunked.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(Buffer.alloc(4096, 0x61)); return }
    if (req.url === '/big.png') { res.writeHead(200, { 'content-type': 'image/png', 'content-length': '4096' }); res.end(Buffer.alloc(4096, 1)); return }
    if (req.url === '/redir.html') { res.writeHead(302, { location: '/page.html' }); res.end(); return }
    if (req.url === '/cross.html') { res.writeHead(302, { location: `http://127.0.0.1:${b.port}/page.html` }); res.end(); return }
    if (req.url === '/404') { res.writeHead(404); res.end('nope'); return }
    res.writeHead(404); res.end()
  })
  const b = await serve((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<p>x</p>') })
  const local = (path) => `http://127.0.0.1:${a.port}${path}`
  const seams = { lookup: async () => [{ address: '127.0.0.1', family: 4 }], assertPublic: () => true, timeoutMs: 5000 }
  try {
    const html = await fetchUrl(local('/page.html'), seams)
    console.log(`  ${html.kind === 'html' && html.statusCode === 200 && html.body.toString() === PAGE && html.charset === 'utf-8' ? '✅' : '❌'} 🔴 抓到 HTML：kind=html + 正文 + charset（${html.mediaType}）`)
    const json = await fetchUrl(local('/api.json'), seams)
    console.log(`  ${json.kind === 'text' && json.body.toString() === '{"a":1}' ? '✅' : '❌'} JSON 归 text（宿主同款分类）`)
    const png = await fetchUrl(local('/ok.png'), seams)
    console.log(`  ${png.kind === 'image' && png.format === 'png' && Buffer.compare(png.body, PNG) === 0 ? '✅' : '❌'} 🔴 抓到图片：kind=image + format + 原始字节（${png.body.length} 字节）`)
    const gbk = await fetchUrl(local('/gbk.html'), seams)
    console.log(`  ${gbk.charset === 'gbk' && decodeBodyText(gbk.body, gbk.charset).text === '中文' ? '✅' : '❌'} 端到端 GBK：声明 + 解码都对`)
    const gz = await fetchUrl(local('/gzip.html'), seams)
    console.log(`  ${gz.body.toString() === PAGE ? '✅' : '❌'} 🔴 gzip 响应自动解压（我们没声明 accept-encoding，服务器硬压也认）`)
    const br = await fetchUrl(local('/br.json'), seams)
    console.log(`  ${br.body.toString() === '{"b":2}' ? '✅' : '❌'} brotli 也解`)
    const weird = await fetchUrl(local('/weird.html'), seams).catch((e) => e.message)
    console.log(`  ${/不支持的压缩方式/.test(String(weird)) ? '✅' : '❌'} 不认识的 content-encoding 明确报错（不吐二进制垃圾）`)
    const bmp = await fetchUrl(local('/bmp.png'), seams).catch((e) => e.message)
    console.log(`  ${/不受支持/.test(String(bmp)) && /image\/bmp/.test(String(bmp)) ? '✅' : '❌'} 🔴 image/bmp（是图片但没内置）也算不支持，且**在读 body 之前**就拒`)
    const noct = await fetchUrl(local('/noct'), seams).catch((e) => e.message)
    console.log(`  ${/未知类型/.test(String(noct)) ? '✅' : '❌'} 没有 Content-Type 也拒（不猜）`)
    const bigTxt = await fetchUrl(local('/big.txt'), { ...seams, maxBytes: 64 }).catch((e) => e.message)
    console.log(`  ${/响应太大/.test(String(bigTxt)) ? '✅' : '❌'} 🔴 声明了 Content-Length 且超上限 → 直接报错（与宿主 provider 同款）：${String(bigTxt).slice(0, 22)}`)
    const chunked = await fetchUrl(local('/chunked.txt'), { ...seams, maxBytes: 64 })
    console.log(`  ${chunked.truncatedByBytes === true && chunked.body.length === 64 ? '✅' : '❌'} 🔴 没声明长度、边下边超上限 → **截断**（不算错，body=${chunked.body.length}）`)
    const bigImg = await fetchUrl(local('/big.png'), { ...seams, maxBytes: 64 }).catch((e) => e.message)
    console.log(`  ${/太大/.test(String(bigImg)) ? '✅' : '❌'} 🔴 图片超上限 → **报错**（截一半的图是坏图）：${String(bigImg).slice(0, 20)}`)
    const redir = await fetchUrl(local('/redir.html'), seams)
    console.log(`  ${redir.kind === 'html' && redir.url.endsWith('/page.html') ? '✅' : '❌'} 同源跳转照跟（最终 ${new URL(redir.url).pathname}）`)
    const cross = await fetchUrl(local('/cross.html'), seams).catch((e) => e.message)
    console.log(`  ${/跨域跳转/.test(String(cross)) ? '✅' : '❌'} 🔴 跨域跳转不跟（要用户直接抓最终地址）`)
    const nf = await fetchUrl(local('/404'), seams).catch((e) => e.message)
    console.log(`  ${/HTTP 404/.test(String(nf)) ? '✅' : '❌'} 非 2xx 报错带状态码：${String(nf).slice(0, 20)}`)
    // 默认参数（不注入）：127.0.0.1 必须被"只允许公网"挡下 —— 这条不发任何请求
    const blocked = await fetchUrl(local('/page.html')).catch((e) => e.message)
    console.log(`  ${/非公网地址/.test(String(blocked)) ? '✅' : '❌'} 🔴 默认参数下私网地址直连被拒（只允许公网）`)
    const fileScheme = await fetchUrl('file:///etc/passwd', seams).catch((e) => e.message)
    console.log(`  ${/只支持 http\/https/.test(String(fileScheme)) ? '✅' : '❌'} 非 http(s) 拒`)
    const creds = await fetchUrl('http://u:p@127.0.0.1/x.png', seams).catch((e) => e.message)
    console.log(`  ${/不允许带用户名\/密码/.test(String(creds)) ? '✅' : '❌'} 🔴 URL 带凭据拒（别把用户名密码发出去）`)
  } finally {
    a.server.close(); b.server.close()
  }
  console.log(`  ${/fetchUrl\(raw, \{ signal: exec\?\.signal \}\)/.test(idxSrc) && /from '\.\/src\/webget\.mjs'/.test(idxSrc) ? '✅' : '❌'} 工具接上了 webget（一次请求、文本与图片同一套）`)
}
}

console.log('\n--- 客户端 bundle（client.js 静态检查）---')
{
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
  // 只看**代码**，不看注释：事故记录里会提到 data-composer-card 这些词，但它们不在代码路径上。
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
  const checks = [
    ['注册 id 仍是 whale_craft', /id:\s*'whale_craft'/.test(src)],
    ['mc-agent 兼容壳已删除（宿主已冷启动、图里只有 whale_craft）', !/id:\s*'mc-agent'/.test(src)],
    ["状态条插槽 id/order='whale_craft-status'/50", /'whale_craft-status'[\s\S]{0,80}order:\s*50/.test(src)],
    ["MC设置按钮 order=45（排在状态条左边）", /whale_craft-mc-settings[\s\S]{0,200}order:\s*45/.test(src)],
    // 🔴 2026-09-16 事故：DOM 注入 + 全域 Observer 会把「MC设置」插到输入框上方（生成时尤其明显）。
    //    现在只允许**一处**、**有门控**、**锚点只在 hero 相位存在**、**观察范围只限卡片**的注入。
    ['不做 document.body 级观察（老 bug 的根源）', !/observe\(document\.body/.test(code)],
    ['不做"卡片前面的兄弟"式位置猜测', !/findHeroRow/.test(code) && !/appendChild\(btn\)/.test(code)],
    ['注入锚点用宿主的稳定壳 data-slot=conversation.hero.agentPreset', /HERO_CHIP_ANCHOR = '\[data-slot="conversation\.hero\.agentPreset"\]'/.test(code)],
    ['按钮插在模式芯片**右边**（afterend）', /insertAdjacentElement\('afterend', e\.btn\)/.test(code)],
    ['放置是幂等的（按 order 紧贴前驱，不自己触发自己）', /e\.btn\.previousElementSibling !== prev/.test(code) && /HERO_BTN_ORDER/.test(code)],
    // 🔴 2026-09-18 真机 bug：原来只观察 `[data-composer-card]`，而那个标记在**输入框自己**身上
    //    （`InputBar.tsx:429`），hero 行是它的**兄弟** ⇒ hero 行重渲染把按钮抹掉、观察者看不见
    //    ⇒ 再也补不回来（症状：工作区已选时首帧就在，所以"看着正常"；没选工作区时锚点晚出现 ⇒ 没按钮）。
    //    现在观察**两者共同的父容器**（锚点父元素 → 退路 `[data-composer-seat]`）。
    ['观察目标是锚点所在父容器（hero 行与输入框的共同祖先）', /anchor\?\.parentElement\) return anchor\.parentElement/.test(code) && /querySelector\('\[data-composer-seat\]'\)/.test(code)],
    ['锚点晚出现时有上限重试（首帧拿不到也能补上）', /tries >= 10/.test(code) && /setTimeout\(tick, 300\)/.test(code)],
    ['观察真的挂上了', /observer\.observe\(target, \{ childList: true, subtree: true \}\)/.test(code)],
    ['组件卸载就摘掉按钮', /e\.btn\.remove\(\)/.test(code)],
    ['注入由门控驱动（只有 show 为真才挂）', /if \(!show\) return undefined/.test(code) && /mountHeroButtons\(/.test(code) && /ctl\.dispose\(\)/.test(code)],
    // 🔴 2026-09-16 二轮事故：门控**不许依赖一次性网络请求**。
    //    第一版问 `/api/mc/mode`，浏览器在新接口上线前 HMR 拿到新客户端 → 404 →
    //    永久当成"非 MC 模式" → MC 模式里也没有按钮。
    //    现在：主判据是**本地的会话 preset**（不等网络），服务端只做兜底且**必带重试**。
    ['MC设置按会话 preset 本地门控（useSessions）', /useSessions/.test(code) && /projectionValues\?\.agentPreset/.test(code)],
    ['新会话页入口走正经插槽（conversation.input.right）', /conversation\.input\.right/.test(code) && /whale_craft-mc-settings-hero/.test(code)],
    ['两个入口按 blank 互斥（不会同时挂两个模态框）', /useMcSettingsGate\(props, false\)/.test(code) && /useMcSettingsGate\(props, true\)/.test(code) && /s\.blank === true/.test(code)],
    ['本地 preset 是主判据（不必等网络）', /const localShow = known && blank === wantBlank && mcPresetIds\.includes\(preset\)/.test(code)],
    // 🔴 2026-09-18 用户改口径：**有没有工作区，只要新对话选中了 MC 模式就显示按钮**；
    //    工作区改到**点击那一刻**再检查，没有就用**原生**提示让用户先选。
    ['新对话入口不再因"没工作区"隐藏（wantBlank 分支恒真）', /if \(localShow\) return true/.test(code) && !/return wantBlank \? true/.test(code)],
    ['两个入口口径统一：选中 MC 模式就显示（标题条那个也一样）', /useMcSettingsGate\(props, false\)/.test(code) && /useMcSettingsGate\(props, true\)/.test(code) && !/deniedNoWorkspace/.test(code)],
    ['点击时才检查工作区（三态：拿不准就不拦）', /function useMcWorkspaceReady\(props, active\)/.test(code) && /if \(wsReadyRef\.current === false\) \{ window\.alert\(NO_WORKSPACE_TIP\); return \}/.test(code)],
    ['工作区判定本地+服务端两处兜底（hasWorkspace）', /useWorkspaceCwd\(props\)/.test(code) && /typeof j\?\.hasWorkspace === 'boolean'/.test(code)],
    ['提示优先用原生 alert（不做自定义模态框）', /window\.alert\(NO_WORKSPACE_TIP\)/.test(code) && /NO_WORKSPACE_TIP\s*=\s*'/.test(code) && !/data-wc-noworkspace/.test(code)],
    // ── 设置两态（2026-10-04）：有/无工作区 —— 无工作区时账户/白名单照常，提示词只读默认，发布区隐藏 ──
    ['无工作区提示用 data-wc-wsneed（不是 data-wc-noworkspace）', /data-wc-wsneed/.test(code) && /在对话中打开设置/.test(code)],
    ['工作区项标记用官方文件夹图标（IconFolderOpenRegular）+ data-wc-wsmark', /IconFolderOpenRegular/.test(code) && /data-wc-wsmark/.test(code) && /该设置项应用于本工作区/.test(code)],
    ['头部显示工作区名（hasWorkspace → data-wc-wsname）', /data-wc-wsname/.test(code) && /workspaceName/.test(code) && /default-workspace/.test(code)],
    ['无工作区读服务端 hasWorkspace（config 回值），发布区按它决定要不要拉', /setHasWorkspace\(hasWs\)/.test(code) && /hasWorkspace === true/.test(code)],
    ['提示词：无工作区隐藏三开关/版本、正文只读', /hasWorkspace \? h\(WsMark\)/.test(code) && /readOnly: true/.test(code) && /h\(WsNeedHint\)/.test(code)],
    ['hero 按钮按工作区就绪禁用（getDisabled + refresh，不重建 DOM）', /getDisabled/.test(code) && /btn\.disabled = off/.test(code) && /ctlRef\.current\.refresh\(\)/.test(code)],
    ['详情页入口用受控 open 打开模态框（root 作用域 = 无工作区）', /React\.createElement\(McSettingsModal, \{ open, onClose/.test(code)],
    // ── 提示词页「注入」区（2026-10-04 改版）──
    ['注入开关 label 带文件名 + 缺失样式（FileName：data-wc-filename/missing）', /function FileName/.test(code) && /data-wc-filename/.test(code) && /data-wc-missing/.test(code) && /目前没有这个文件/.test(code)],
    ['注入工作区开关不再因文件缺失禁用（开关始终改配置）', /h\(FileName, \{ key: 'f', name: 'AGENTS\.md'/.test(code) && !/disabled: !wsExists/.test(code)],
    ['版本行并入「注入本提示词」说明（不再是独立一行）', /desc: `当前内容对应：/.test(code) && /h\(FileName, \{ key: 'f', name: 'RULES\.md'/.test(code)],
    ['RULES.md/AGENTS.md 缺失标记来自服务端（rulesExists / wsExists）', /rulesExists/.test(code) && /m\.workspaceExists === true/.test(code)],
    ['弹窗关闭按钮 = 叉图标（data-wc-xbtn + IconCloseOutlineRegular；与标题同色、hover 红、无边框）', /data-wc-xbtn/.test(code) && /IconCloseOutlineRegular/.test(code) && !/'data-wc-tiny': '', title: '关闭/.test(code)],
    ['Switch 不拿节点 label 当 title（防 [object Object]）', /typeof props\.label === 'string' \? props\.label : undefined/.test(code)],
    ['版本内置提示来自顶层 versionPrompt（无工作区也显示）', /versionPrompt, hasWorkspace,/.test(code) && /setVersionPrompt\(m\.versionPrompt/.test(code) && /本版本内置提示/.test(code)],
    // 🔴 「已保存」气泡：3s 自动消失、切标签页消失、关闭时清掉，且定时器清场（别在关窗后到点报错）
    ['已保存提示 3s 自动消失 + 定时器清场', /setTimeout\(\(\) => setSaved\(''\), 3000\)/.test(code) && /clearTimeout\(t\)/.test(code) && /setSaved\(''\); setTab\(t\.id\)/.test(code)],
    // ── 「连接到MC」（2026-10-04）──
    ['「连接到MC」标题条入口：order 40（在「设置」45 左边）+ 运行图标 + 文字', /'whale_craft-mc-connect', order: 40/.test(code) && /IconRunRegular/.test(code) && /'连接到MC'/.test(code)],
    ['🔴 运行图标是**裸三角**（IconTriangleRightFillRegular，不要带圈的 play）', /IconRunRegular = primitives\.IconTriangleRightFillRegular/.test(code)],
    ['账户「（来源）」用灰色渲染（data-wc-cn-src）', /data-wc-cn-src/.test(code) && /acctLabelNode/.test(code)],
    ['弹窗**固定尺寸**（定死宽高）+ 底部 footer 贴底', /\[data-wc-cn-card\]\{[^}]*height:min\(82vh,600px\)/.test(code) && /data-wc-cn-foot/.test(code)],
    ['🔴 运行图标是**空心**三角（DSH 裸三角几何 + CSS 描边覆盖 fill）', /\.wc-runicon path\{fill:none;stroke:currentColor/.test(code) && /function RunIcon/.test(code)],
    ['窗口固定 760×600、内容垂直居中并**上移 10%**（padding 24/52/84）', /\[data-wc-cn-card\]\{[^}]*width:min\(760px,100%\)/.test(code) && /\[data-wc-cn-body\]\{position:relative;[^}]*padding:24px 52px 84px/.test(code) && /justify-content:center/.test(code)],
    ['🔴 运行图标按**图形自身**略微放大（transform-box:fill-box + scale(1.35)）——不放满，免得太粗大', /transform-box:fill-box;transform-origin:center;transform:scale\(1\.35\)/.test(code)],
    ['探测中：方块一行、文案一行（各占一行、水平居中）', /\[data-wc-cn-probe\]\{display:flex;flex-direction:column/.test(code) && /data-wc-cn-dots/.test(code)],
    ['局域网卡显示 **MOTD**（地址右边、灰、固定两行、**文字垂直居中**）', /data-wc-cn-motd/.test(code) && /data-wc-cn-motdtext/.test(code) && /-webkit-line-clamp:2/.test(code) && /\[data-wc-cn-motd\]\{[^}]*display:flex;align-items:center/.test(code)],
    ['按钮里的运行图标用**负外边距**收掉方框透明边（不然左边距看着很大）', /\[data-wc-btn\] \.wc-runicon\{margin-left:-4px/.test(code)],
    ['🔴 局域网卡片整体是按钮，运行图标**无缝嵌入**（不再是独立按钮）', /'data-wc-cn-lan': ''/.test(code) && /data-wc-cn-run/.test(code) && !/\['data-wc-cn-lan'\] \[data-wc-cn-actions\]/.test(code)],
    ['局域网行：**版本号在人数左边**，各自可标红（data-wc-cn-bad）', /data-wc-cn-ver/.test(code) && /data-wc-cn-count/.test(code) && /data-wc-cn-bad/.test(code)],
    ['版本支持由后端 `supported` 决定（占位 MC_VERSION_IN_RANGE 已删）', !/MC_VERSION_IN_RANGE/.test(code) && /lanVersionOk = \(s\) => s\?\.supported !== false/.test(code)],
    ['probeLan 每行带 supported（isVersionSupported 算好给前端）', /supported: isVersionSupported\(ok \? ping\.version : null\)/.test(readFileSync(new URL('./index.js', import.meta.url), 'utf8'))],
    ['版本不符 / 人满 → 点它弹错误框且**不发起连接**', /const clickLan/.test(code) && /版本不匹配/.test(code) && /服务器已满/.test(code)],
    ['🔴 新对话页走**模拟玩家发言**（asUser + `[system] `）；对话中仍用插件提示行', /asUser: true/.test(code) && /asUser: false/.test(code) && /asUser: props\?\.asUser === true/.test(code)],
    ['输入框 box-sizing:border-box（否则比按钮高一点点）', /\[data-wc-cn-input\]\{box-sizing:border-box/.test(code)],
    ['地址行输入框与「连接」按钮**等高**（34px）', /\[data-wc-cn-input\]\{[^}]*height:34px/.test(code) && /\[data-wc-cn-actions\]\{[^}]*height:34px/.test(code)],
    ['错误提示**浮在地址上方留白**且 3s 自动消失', /data-wc-cn-error/.test(code) && /setTimeout\(\(\) => setError\(''\), 3000\)/.test(code)],
    ['标题条入口：MC 模式门控 + **在游戏中隐藏**', /function McConnectEntry/.test(code) && /useMcSettingsGate\(props, false\)/.test(code) && /st\?\.active === true\) return null/.test(code)],
    ['hero 两个按钮按 order 排（连接 40 在左、设置 45 在右；设置只有图标）', /HERO_CONNECT_ATTR\]: 40/.test(code) && /HERO_BTN_ATTR\]: 45/.test(code) && /iconOnly: true/.test(code) && /getDisabled: isOff/.test(code)],
    ['连接弹窗：历史气泡横滚 + 局域网行 + 账户下拉 + 预留选项区', /data-wc-cn-bubbles/.test(code) && /data-wc-cn-lan\b/.test(code) && /data-wc-cn-pick/.test(code) && /data-wc-cn-extras/.test(code) && /添加\/管理/.test(code)],
    ['探测动画三方块**只动 opacity**（呼吸灯，非形变）', /@keyframes wc-breathe\{0%,100%\{opacity:\.2;\}50%\{opacity:1;\}\}/.test(code) && /data-wc-cn-dot/.test(code) && /animation:wc-breathe 1\.4s/.test(code)],
    ['局域网行直连不填输入框、不记历史（via:\'lan\'）', /connect\(s\.address, 'lan'\)/.test(code)],
    ['「添加/管理」→ 叠加受控设置弹窗并落到「账户」页', /setSettingsOpen\(true\)/.test(code) && /initialTab: 'accounts'/.test(code) && /nested: true/.test(code) && /data-wc-nested/.test(code)],
    // 服务端口径（读 index.js，别拿 client 的 src 判）
    ['服务端不再因没工作区把 mcMode 压成 false（改报 hasWorkspace）', (() => {
      const isrc = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
      return /hasWorkspace = Boolean\(workspaceOf\(agent\)\)/.test(isrc)
        && /sendJson\(res, 200, \{ ok: true, sessionId, mcMode, mcPlus, hasWorkspace, diag \}\)/.test(isrc)
        && !/if \(agent && !workspaceOf\(agent\) && isMcModeAgent\(agent\)\) \{ mcMode = false/.test(isrc)
    })()],
    ['设置接口全都带上 sessionId（服务端要用它定位工作区）', /const withSid = \(p\) =>/.test(code) && /apiGet\(withSid\('\/api\/mc\/accounts'\)\)/.test(code) && /apiPatch\(withSid\('\/api\/mc\/config'\)/.test(code) && !/api(Get|Patch|Post|Delete)\('\/api\/mc\/(config|authservers)'/.test(code)],
    // 🔴 门控名单走**专门的小接口**（不需要工作区）：用 /api/mc/config 会被闸门拒 → 静默退回兜底名单
    ['前端门控名单取 /api/mc/presets（不带 sessionId）', /fetch\('\/api\/mc\/presets'/.test(code) && !/fetch\('\/api\/mc\/config'/.test(code)],
    // 🔴 2026-09-16 真机 bug：两个入口都把模态框写成 `createElement(McSettingsModal, null)`
    //    → sessionId 永远是 undefined → 点开设置就报"缺少 sessionId"。
    ['模态框真的拿到了 props（不是 null）', !/React\.createElement\(McSettingsModal, null\)/.test(code) && /React\.createElement\(McSettingsModal, \{ \.\.\.props, wsCwd \}\)/.test(code)],
    ['新对话页会把已知工作区一起报上去（cwd 兜底）', /function useWorkspaceCwd\(props\)/.test(code) && /q\.push\('cwd=' \+ encodeURIComponent\(wsCwd\)\)/.test(code)],
    // 🔴 2026-09-16：真机上反复"没注入"却查不出原因 → 「提示词」页直接把判据摆出来
    ['「提示词」页显示注入状态（会不会注入 + 为什么不会）', /data-wc-injectstatus/.test(code) && /injectStatus\?\.segments/.test(code) && /data-wc-note/.test(code)],
    ['服务端兜底只给标题条且带重试（不是一次性请求）', /const needServer = !known && !wantBlank/.test(code) && /\+\+tries < 20/.test(code) && /setTimeout\(tick, 3000\)/.test(code)],
    ['名单来自 /api/mc/presets 的 mcModePresets（带默认值兜底；含 MC+）', /mcModePresets/.test(code) && /MC_PRESETS_FALLBACK = \['minecraft', 'minecraft-plus', 'whale_craft'\]/.test(code)],
    ['/api/mc/presets 不带闸门（门控名单不能被"没工作区"挡住）', /path === '\/api\/mc\/presets'[\s\S]{0,220}return ok\(\{ mcModePresets/.test(readFileSync(new URL('./index.js', import.meta.url), 'utf8'))],
    ['判不了就不渲染（return null）', /if \(!show\) return null/.test(code)],
    ['调用 /api/mc/accounts', src.includes('/api/mc/accounts')],
    ['调用 /api/mc/authservers', src.includes('/api/mc/authservers')],
    ['调用 /api/mc/config', src.includes('/api/mc/config')],
    ['普通停止按钮已移除（没有 }, \'停止\') 这种按钮）', !/\}\s*,\s*'停止'\s*\)/.test(src) && !/stop\(false\)/.test(src)],
    ['微软账户那项标"未实现"', /未实现/.test(code)],
    ['拖卡片能读 dataTransfer', /dataTransfer/.test(src)],
    // ── 账户页 UI（用户 2026-09-16 重做）：横条 + 类型气泡 + 独立新建/编辑界面 ──
    ['账户列表是横条 + 类型气泡', /data-wc-acct/.test(code) && /function TypeChip/.test(code)],
    ['列表里不再展示细节（innerID / UUID / 服务器）', !/innerID：/.test(code) && !/UUID：/.test(code) && !/服务器：/.test(code)],
    ['离线 = 编辑，其余 = 刷新', /disabled: rowBusy,\s*onClick: \(\) => props\.onEdit/.test(code) && /'刷新'/.test(code)],
    ['「添加」在右上角（panehead + spacer）', /data-wc-panehead/.test(code) && /data-wc-spacer/.test(code) && /＋ 添加/.test(code)],
    ['三种账户各有独立界面', /function TypePicker/.test(code) && /function OfflineForm/.test(code) && /function YggdrasilForm/.test(code)],
    ['第三方新建：服务器 → 名字 → 账号 → 密码', (() => {
      const a = code.indexOf("label: '认证服务器'")
      const b = code.indexOf("label: '服务器名字（留空就用域名）'")
      const c = code.indexOf("label: '账号（邮箱）'")
      const d = code.indexOf("label: '密码'")
      return a > 0 && a < b && b < c && c < d
    })()],
    // 🔴 用户 2026-09-16 纠正：第三方表单问的必须是**认证服务器的名字**（缓存标签要看得懂），
    //    不是"游戏内名字"——角色名由认证服返回，问用户填没有意义（登录后必被覆盖）。
    ['第三方表单只问"服务器名字"，不问"游戏内名字"', (() => {
      const a = code.indexOf('function YggdrasilForm')
      const b = code.indexOf('function AccountsPane')
      const seg = a >= 0 && b > a ? code.slice(a, b) : ''
      return /服务器名字/.test(seg) && !/游戏内名字/.test(seg)
    })()],
    ['服务器名字会随账户一起提交（serverName）', /serverName/.test(code)],
    ['改过名字才带 serverName（没改就别无谓地改名请求）', /nm !== pickedSrv\.name \? \{ serverName: nm \}/.test(code)],
    ['第三方新建有**看得见的**拽托接受区', /data-wc-drop/.test(code) && /把 authlib-injector 卡片拖到这里/.test(code)],
    ['拖卡片后自动选中并填进输入框', /onAddCard\(card\)[\s\S]{0,160}setUrl\(srv\.url\)/.test(code)],
    ['已缓存服务器 = 可点填充 + × 删除的标签', /data-wc-tagpick/.test(code) && /data-wc-tagx/.test(code)],
    ['第三方横条带小灰字服务器名（无名字退 url）', /data-wc-acctsub/.test(code) && /acc\.server\?\.name \|\| acc\.server\?\.url/.test(code)],
    // 🔴 用户 2026-09-16：主文本是**游戏 ID**（档案名），小灰字要写成「输入的账号（服务器名）」——
    //    输入的账号和游戏里的 ID 往往不是一回事，两个都得看得见；相同时不重复写。
    ['第三方小灰字 = 「账号（服务器名）」（两者不同时才带账号）', /\$\{login\}（\$\{srvLabel\}）/.test(code) && /login !== acc\.name/.test(code)],
    ['设置卡片**固定尺寸**（切页不跳大小：height 而非 max-height）', /\[data-wc-card\][\s\S]{0,220}height:min\(86vh,860px\)/.test(code) && !/\[data-wc-card\][\s\S]{0,220}max-height:min\(86vh,860px\)/.test(code)],
    ['不再有"内置不可删"的 UI 痕迹', !/data-wc-srv-builtin/.test(code) && !/data-wc-badge/.test(code)],
    // 🔴 文案规矩（用户 2026-09-16）：UI 里只写用户需要的信息——不许实现细节/AI 味的话
    ['UI 无"凭据库 / AI 看不到"之类', !/DSH 凭据库|AI 看不到|AI 不能读写|凭据库/.test(code)],
    ['UI 无"一拨就生效 / 即时保存"之类', !/一拨就生效|即时保存/.test(code)],
    ['UI 无"当前来源 / 默认版"之类', !/当前来源|默认版/.test(code)],
    ['提示词那页就叫「提示词」（不写"行事准则"）', /label: '提示词'/.test(code) && !/行事准则/.test(code)],
    ['强制停止的 tooltip 说人话（不写四步实现）', !/先停 LLM/.test(code)],
    // 🔴 用户 2026-09-16："状态条是不是只显示'在游戏中'？应该显示服务器地址，太长则截断。"
    // 🔴 2026-10-05：不再有 subserver（用户只填一个 address）——只显示 host[:port]
    ['状态条显示服务器地址（host[:port]）', /function mcAddress\(state\)/.test(code) && /conn\?\.host/.test(code) && !/subserver/.test(code)],
    ['地址太长就截断（完整地址留在 tooltip）', /address\.length > 26 \? address\.slice\(0, 25\) \+ '…'/.test(code) && /'data-mc-sub': '', title: address/.test(code)],
    ['CSS 也兜一层截断（max-width + ellipsis）', /\[data-mc-sub\]\{[^}]*max-width:24ch[^}]*text-overflow:ellipsis/.test(code)],
    ['拿不到地址就只显示"在游戏中"（不硬编造一个"—"）', /address \? React\.createElement\('span', \{ 'data-mc-sub'/.test(code)],
    // ── 「文件分享」页（用户 2026-09-17）：两模式 + 在线 base（获取当前）+ 清除分享数据（要确认）──
    ['「文件分享」页存在（开关式；不再有 mode 的 off/online/local 取值）', /function SharePane/.test(code) && /label: '启用文件分享'/.test(code) && !/id: 'local'/.test(code) && !/'data-wc-mode'/.test(code)],
    ['标签页叫「文件分享」', /label: '文件分享'/.test(code)],
    ['文件分享是**开关**一拨就存（乐观更新 + 失败回滚）', /setShareOn\(next\)/.test(code) && /if \(!ok\) setShareOn\(prev\)/.test(code)],
    // 🔴 2026-10-04：不再有"模式"（在线是唯一方式）→ 等宽按钮那一套整个删掉
    ['不再是"模式"按钮（mode 那一套已删）', /label: '启用文件分享'/.test(code) && !/data-wc-modes/.test(code) && !/data-wc-mode-on/.test(code)],
    ['🔴 关闭时 base 那块**禁用**（输入框 + 两个按钮）', /disabled: busy \|\| !on/.test(code) && /开启文件分享后才能设置 base/.test(code)],
    ['「获取当前」按钮：用当前地址填好并保存', /'获取当前'/.test(code) && /onClick: onUseCurrent/.test(code) && /拿不到当前地址/.test(code)],
    ['🔴 开启且没 base → 自动"获取当前"并一起保存（仅 web 模式）', /shareMode !== 'desktop' && next === true && !shareBase/.test(code) && /cur \? \{ expressWebEnabled: true, expressWebBase: cur \}/.test(code)],
    ['🔴 不去调就不写：不开/不点按钮时不动 base', /: apiPatch\(withSid\('\/api\/mc\/config'\), \{ \[onKey\]: next \}\)\)/.test(code)],
    ['🔴 开关按宿主模式绑定各自的键', /shareMode === 'desktop' \? 'expressDesktopEnabled' : 'expressWebEnabled'/.test(code)],
    // 🔴 2026-09-17 真机：模态框里调 setBaseText（它在 SharePane 内部）→ 点「在线」弹
    //    "setBaseText is not defined"。保存后靠 load() 刷新 base → pane 的 useEffect 自己同步。
    ['🔴 模态框不许碰 pane 内部的输入框状态（setBaseText）', !/setBaseText\(cur\)/.test(code) && /setBaseText\(base \?\? ''\)/.test(code)],
    ['base 单独用「保存」提交（不是边打字边存）', /apiPatch\(withSid\('\/api\/mc\/config'\), \{ expressWebBase: String\(text \?\? ''\) \}\)/.test(code)],
    // 🔴 2026-10-07：桌面模式改用独立端口（默认 16049）
    ['🔴 桌面模式：托管端口那块（保存端口 / 恢复默认）', /'data-wc-h': '' \}, '托管端口'/.test(code) && /onClick: \(\) => onSavePort\(String\(portText\)\.trim\(\)\)/.test(code) && /onClick: onResetPort/.test(code)],
    ['🔴 桌面默认端口 16049（与 src/express.mjs 一致）', /const EXPRESS_DEFAULT_PORT = 16049/.test(code)],
    ['🔴 端口占用 → 输入框附近红字（防抖 300ms 自检）', /onCheckPort/.test(code) && /setTimeout\(\(\) => \{/.test(code) && /已被占用，请换一个/.test(code)],
    ['🔴 端口红字样式（data-wc-error → 错误色）', /\[data-wc-hint\]\[data-wc-error\]\{color:var\(--dsw-alias-state-error-primary/.test(code)],
    ['桌面模式按 mode 分支渲染（托管端口 / base 二选一）', /const isDesktop = mode === 'desktop'/.test(code)],
    ['在线模式却没填 base → 页面上直接说清', /还没填 base：AI 暂时只能让你去设置/.test(code)],
    ['🔴 base 那一块**始终渲染**（关闭时禁用而非消失）', /'data-wc-h': '' \}, 'base 地址'/.test(code)],
    ['「清除分享数据」必须二次确认（确认后才真删）', /onClick: \(\) => setConfirmClear\(true\)/.test(code) && /onClick: \(\) => \{ setConfirmClear\(false\); onClear\(\) \}/.test(code)],
    ['🔴 清除与模式无关（关闭模式下也能点，不因没文件而禁用）', !/disabled: busy \|\| !share\?\.files/.test(code)],
    ['不可撤销那句用 <strong>（HTML 不认 markdown 的 **）', /React\.createElement\('strong', \{\}, '全部删掉'\)/.test(code)],
    ['UI 里没有 markdown 式 `**`（渲染出来是字面星号）', !/'[^'\n]*\*\*[^'\n]*'/.test(code)],
    ['清除走 DELETE /api/mc/express', /apiDelete\(withSid\('\/api\/mc\/express'\)\)/.test(code)],
    // ── 「联网搜索」页（2026-10-08）：工作区无关的「允许联网搜索」开关（默认开）──
    ['「联网搜索」页存在（WebSearchPane + data-wc-pane-page:websearch）', /function WebSearchPane/.test(code) && /'data-wc-pane-page': 'websearch'/.test(code)],
    ['标签页叫「联网搜索」，排在「调试」之前', /label: '联网搜索'/.test(code) && code.indexOf("label: '联网搜索'") < code.indexOf("label: '调试'")],
    ['开关叫「允许联网搜索」，描述逐字（MC+ 不受限）', /label: '允许联网搜索'/.test(code) && /允许MC模式下的助手联网搜索内容，MC\+模式不受限制/.test(code)],
    ['「允许联网搜索」开关一拨就存（乐观更新 + 失败回滚）', /setAllowWebSearch\(want\)/.test(code) && /allowWebSearch: want/.test(code) && /if \(!ok\) setAllowWebSearch\(prev\)/.test(code)],
    ['前端把服务端值按"默认开"读（!== false）', /setAllowWebSearch\(c\.allowWebSearch !== false\)/.test(code)],
    // ── 「联网搜索」页 → 「网页抓取」组（2026-10-08）：开关（默认关）+ 允许所有域名 + 域名表（一行一条）──
    ['「网页抓取」组：开关「允许网页抓取」+ 「允许所有域名」', /label: '允许网页抓取'/.test(code) && /label: '允许所有域名'/.test(code)],
    ['🔴 抓取开关的小字是定稿原文（MC+ 的 web_fetch 归宿主管）', /desc: '允许助手抓取网页完整内容。MC\+模式的web_fetch工具受宿主管理不受本开关限制'/.test(code)],
    ['抓取开关一拨就存（乐观更新 + 失败回滚）', /setWebFetchOn\(want\)/.test(code) && /webFetchEnabled: want/.test(code) && /if \(!ok\) setWebFetchOn\(prev\)/.test(code)],
    ['「允许所有域名」一拨就存（乐观更新 + 失败回滚）', /setFetchAllDomains\(want\)/.test(code) && /allowAllFetchDomains: want/.test(code) && /if \(!ok\) setFetchAllDomains\(prev\)/.test(code)],
    ['域名表：一行一条 + 保存按钮 + 写法提示（精确/通配/正则/*）', /允许抓取的域名（一行一条）/.test(code) && /webFetchDomains: textToWhitelist\(fetchDomainsText\)/.test(code) && /\*\.minecraft\.wiki/.test(code)],
    ['🔴 布局照「指令白名单」：「允许所有域名」排在域名表**之前**', code.indexOf("label: '允许所有域名'") > 0 && code.indexOf("label: '允许所有域名'") < code.indexOf('允许抓取的域名（一行一条）')],
    ['🔴 「允许所有域名」打开时域名表**变灰只读**（并说明不再生效）', /已允许所有域名，域名表不再生效/.test(code) && /if \(!fetchAllDomains\) onFetchDomainsText/.test(code)],
    ['域名表按"默认关"读（=== true）', /setWebFetchOn\(c\.webFetchEnabled === true\)/.test(code) && /setFetchAllDomains\(c\.allowAllFetchDomains === true\)/.test(code)],
    // 「允许的内容类型」（2026-10-08）：两个开关，默认都开（宿主只回 html / text 两类，粒度只能到这）
    ['「允许的内容类型」两个开关：网页 HTML / 文本', /'允许的内容类型'/.test(code) && /label: '网页 HTML'/.test(code) && /label: '文本'/.test(code)],
    ['两个开关默认**开**（!== false）＋一拨就存 + 失败回滚', /setFetchAllowHtml\(c\.webFetchAllowHtml !== false\)/.test(code) && /setFetchAllowText\(c\.webFetchAllowText !== false\)/.test(code) && /setFetchAllowHtml\(want\)/.test(code) && /if \(!ok\) setFetchAllowHtml\(prev\)/.test(code) && /setFetchAllowText\(want\)/.test(code) && /if \(!ok\) setFetchAllowText\(prev\)/.test(code)],
    ['「允许的内容类型」第三个开关：图片（内置 png/jpeg/gif/webp）', /label: '图片'/.test(code) && /png \/ jpeg \/ gif \/ webp/.test(code)],
    ['图片开关一拨就存（乐观更新 + 失败回滚）', /setFetchAllowImage\(want\)/.test(code) && /webFetchAllowImage: want/.test(code) && /if \(!ok\) setFetchAllowImage\(prev\)/.test(code)],
    ['🔴 没有可配置的图片格式表（内置四种，页面只说明）', !/允许的图片格式/.test(code) && !/webFetchImageFormats/.test(code)],
    ['图片开关的说明里写出内置四种格式（不再是单独的提示行）', /label: '图片'/.test(code) && /png \/ jpeg \/ gif \/ webp/.test(code) && !/只支持上面那四种格式/.test(code)],
    ['🔴 三类都关时页面明说"什么都抓不了"', /三类都关着，助手什么都抓不了/.test(code) && /!fetchAllowHtml && !fetchAllowText && !fetchAllowImage/.test(code)],
    // ── 「调试」页（2026-10-05）：工作区无关的「开放助手调试工具」开关 ──
    ['「调试」页存在（DebugPane + data-wc-pane-page:debug）', /function DebugPane/.test(code) && /'data-wc-pane-page': 'debug'/.test(code)],
    ['标签页叫「调试」，开关叫「开放助手调试工具」', /label: '调试'/.test(code) && /label: '开放助手调试工具'/.test(code)],
    ['「开放助手调试工具」开关一拨就存（乐观更新 + 失败回滚）', /setExposeDebugTools\(want\)/.test(code) && /exposeDebugTools: want/.test(code) && /if \(!ok\) setExposeDebugTools\(prev\)/.test(code)],
    // 「随版本更新」（提示词页）：开关 + 版本提示行 + 一拨就存 + 失败回滚
    ['「提示词」页有「随版本更新」开关', /label: '随版本更新'/.test(code) && /onToggle: \(next\) => onFollowVersion\(next\)/.test(code)],
    ['开关说明写清"会覆盖你的修改"', /用新版本的默认提示词替换当前内容（会覆盖你的修改）/.test(code)],
    ['页面显示"当前内容对应哪个版本"', /当前内容对应：\$\{rulesVersion \? `v\$\{rulesVersion\}` : '未知（还没同步过）'\}/.test(code)],
    ['开关一拨就存（乐观更新 + 失败回滚）', /run\('cfg:follow', \(\) => apiPatch\(withSid\('\/api\/mc\/config'\), \{ rulesFollowVersion: next === true \}\)/.test(code) && /if \(!ok\) setFollowVersion\(prev\)/.test(code)],
    ['页面上能看见发布区目录与大小', /data-wc-hint/.test(code) && /share\.files\} 个文件/.test(code) && /fmtBytes/.test(code)],
    // 地址只能走 connectionView()（host/port/version）；`_connectionProfile` 还带账号名，别发到浏览器
    ['后端只把 connectionView() 发给前端（不发含账号的 _connectionProfile）', !/connection: (sess|this)\.bot\._connectionProfile/.test(readFileSync(new URL('./index.js', import.meta.url), 'utf8'))],
  ]
  // ── 「创建MC+分支」（2026-10-05）：消息操作行加一个立方体按钮 → fork + 把新会话改成 MC+ ──
  {
    const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    const idx = stripComments(readFileSync(new URL('./index.js', import.meta.url), 'utf8'))
    const notices = readFileSync(new URL('./THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8')
    checks.push(
      ['「创建MC+分支」挂到原生消息操作槽 conversation.chat.assistant-actions', /conversation\.chat\.assistant-actions/.test(code) && /whale_craft-plus-branch/.test(code)],
      ['门控 = 本地 preset ∈ {standard, minecraft}（useSessions，不等网络）', /PLUS_BRANCH_FROM = \['standard', 'minecraft'\]/.test(code) && /usePlusBranchGate/.test(code) && /projectionValues\?\.agentPreset/.test(code)],
      ['图标是**内联的 Lucide box（立方体）**，3 条 path（官方图标集没有立方体）', /function CubeIcon/.test(code) && /M21 8a2 2 0 0 0-1-1\.73l-7-4/.test(code) && /'m3\.3 7 8\.7 5 8\.7-5'/.test(code) && /'M12 22V12'/.test(code)],
      ['按钮点击 POST /api/mc/branch-plus，成功后用 uiWorkspace.openSession 打开新会话', /'\/api\/mc\/branch-plus'/.test(code) && /uiWorkspace\.openSession\(j\.sessionId\)/.test(code)],
      ['后端有 /api/mc/branch-plus 路由（POST）', /path === '\/api\/mc\/branch-plus'/.test(idx)],
      ['🔴 改模式走 recompose + 追加 agent-preset/selected（绕开 select 的"已开聊"锁）', /presets\.recompose\(child\.ctx, target\)/.test(idx) && /append\('agent-preset\/selected'/.test(idx)],
      ['atSeq 由 messageId 反查（对齐原生分支的落点）', /data\?\.message\?\.id === messageId/.test(idx)],
      ['🔴 改模式后**复验**（composedPreset 必须真是 MC+，只 catch 不够）', /presets\.composedPreset\(child\.ctx\)/.test(idx) && /presetApplied = got === resolved/.test(idx)],
      ['🔴 失败**自动回撤**（archiveSession 收走刚建的分支，不留"假 MC+ 分支"）', /wsReg\.archiveSession\(childId\)/.test(idx) && /rolledBack/.test(idx)],
      ['前端失败弹错（error + hint，不静默）', /window\.alert\(msg\)/.test(code) && /filter\(Boolean\)\.join\('\\n\\n'\)/.test(code)],
      ['第三方声明写了 Lucide（ISC 全文）', /Lucide/.test(notices) && /ISC License/.test(notices) && /box\.svg/.test(notices)],
    )
  }
  for (const [label, passed] of checks) console.log(`  ${passed ? '✅' : '❌'} ${label}`)
}

console.log('\n--- 依赖面 + 打包完整性（mineflayer 是**依赖**不是"你自己装"；用户 2026-09-16 定）---')
{
  const { readFileSync } = await import('node:fs')
  const { createRequire } = await import('node:module')
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
  const deps = pkg.dependencies ?? {}
  const opt = pkg.optionalDependencies ?? {}
  const peer = pkg.peerDependencies ?? {}
  const peerMeta = pkg.peerDependenciesMeta ?? {}
  const devDeps = pkg.devDependencies ?? {}
  const req = createRequire(new URL('./index.js', import.meta.url))
  // 🔴 2026-10-02：支持的 DSH **运行时**范围（engines.dsh 只是声明；真正强制的是 peer，
  //    宿主 dsh-app-boot 拿它和运行时版本做 semver.satisfies(..., {includePrerelease:true})）。
  //    预发布必须显式写进下限——`^0.2.0` 匹配不了 `0.2.0-rc.2`（低于下限）。
  // 🔴 2026-10-04：下限抬到 rc.2 —— 插件已转向面向 0.2.0-rc.2+ 开发（声明式 preset / 注册表）。
  const DSH_RANGE = '>=0.2.0-rc.2 <0.3.0'

  // mineflayer 自己声明的 vec3 范围：我们必须跟它**同一条线**，否则会装出两份 vec3 → instanceof 失效
  let mfVec3Range = null
  let mfVersion = null
  let sameVec3 = false
  try {
    const reqMf = createRequire(req.resolve('mineflayer'))
    mfVec3Range = reqMf('mineflayer/package.json').dependencies?.vec3 ?? null
    mfVersion = reqMf('mineflayer/package.json').version
    sameVec3 = req.resolve('vec3') === reqMf.resolve('vec3')
  } catch {
    // 依赖没装：下面几项会 ❌ —— 那正是我们要的信号，不是崩溃
  }
  const lineOf = (r) => String(r ?? '').replace(/^[\^~>=<\s]+/, '').split('.').slice(0, 2).join('.')
  // ⚠️ 别拿"同 minor"当"相容"（2026-09-16 第八轮踩过：CI 里装到 4.39.0，被误判 ❌）。
  //    `^4.37.1` 的语义是"同大版本内可升"：4.37.1 → 4.39.0 合法。
  const caretOk = (range, version) => {
    const m = /^\^(\d+)\.(\d+)\.(\d+)/.exec(String(range ?? ''))
    if (!m) return true
    const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])]
    const v = String(version ?? '').split('.').map(Number)
    if (v[0] !== maj) return false
    if (maj === 0) return v[1] === min && v[2] >= pat     // 0.x：caret 只允许 patch 级
    return v[1] > min || (v[1] === min && v[2] >= pat)
  }

  const checks = [
    ['mineflayer 是**直接依赖**（装上插件就有机器人，不用用户自己补）', typeof deps.mineflayer === 'string'],
    ['vec3 也是直接依赖（pnpm 严格布局下，不声明就 import 不到传递依赖）', typeof deps.vec3 === 'string'],
    ['vec3 与 mineflayer 要的是**同一条线**（防两份 vec3 → instanceof 命门）', !!mfVec3Range && lineOf(deps.vec3) === lineOf(mfVec3Range)],
    ['运行时 vec3 与 mineflayer 解析到**同一个文件**', sameVec3],
    ['解析到的 mineflayer 版本满足声明范围（`^4.37.1` 允许 4.39.0）', !!mfVersion && caretOk(deps.mineflayer, mfVersion)],
    ['sharp 放 optionalDependencies（原生模块装不上也不该让整个安装失败）', typeof opt.sharp === 'string' && deps.sharp === undefined],
    ['宿主包走 peerDependencies（@deepseek-ai/dsh-llm / dsh-tools / schemastery）', typeof peer['@deepseek-ai/dsh-llm'] === 'string' && typeof peer['@deepseek-ai/dsh-tools'] === 'string' && typeof peer['@deepseek-ai/schemastery'] === 'string'],
    ['dsh peer 范围 = 支持的运行时范围（schemastery 不是 dsh-* 名字，宿主不查，保持 *）', peer['@deepseek-ai/dsh-llm'] === DSH_RANGE && peer['@deepseek-ai/dsh-tools'] === DSH_RANGE && peer['@deepseek-ai/schemastery'] === '*'],
    ['engines.dsh 与 peer 范围一致（engines.dsh 是官方声明字段，当前宿主不强制）', pkg.engines?.dsh === DSH_RANGE],
    // 🔴 2026-09-16 第八轮：单纯写成 peer 不够 —— npm/pnpm 会**自动去 npm 装一份** 0.0.1-rc.1，
    //    和宿主那份（本机是源码树的 0.1.5-rc.2）变成**两个 Tool 类**。声明成 optional peer 才不装。
    ['宿主包是 **optional** peer（否则包管理器会装出第二份 Tool 类）', peerMeta['@deepseek-ai/dsh-llm']?.optional === true && peerMeta['@deepseek-ai/dsh-tools']?.optional === true && peerMeta['@deepseek-ai/schemastery']?.optional === true],
    // 但本地跑自检/CI 时没有宿主，得靠 devDependencies 顶上（devDeps 不会发给用户）
    ['devDependencies 里有宿主包（干净环境/CI 里自检才跑得起来）', typeof devDeps['@deepseek-ai/dsh-llm'] === 'string' && typeof devDeps['@deepseek-ai/dsh-tools'] === 'string' && typeof devDeps['@deepseek-ai/schemastery'] === 'string'],
    // 🔴🔴 2026-09-18 真机事故（npm 装的 0.1.3 在**别的机器**上提示词一条都没注入）：
    //    `@deepseek-ai/dsh-llm` 当时**根本没进依赖声明** —— 本机靠 junction 侥幸 require 得到，
    //    别人的 npm 布局解析不到 ⇒ createUserMessage 为 null ⇒ 提示行一条都建不出来。
    //    工具白名单/guard 只用 ctx，所以症状精确地是"工具都在、提示词全无"。
    ['🔴 dsh-llm 在依赖里声明了（就是那次"提示词没注入"的根因）', typeof peer['@deepseek-ai/dsh-llm'] === 'string' && typeof devDeps['@deepseek-ai/dsh-llm'] === 'string'],
  ]
  for (const [label, passed] of checks) console.log(`  ${passed ? '✅' : '❌'} ${label}`)
  if (!mfVersion) console.log('  ⚠️ 依赖没解析到（先 npm install / pnpm install 再跑自检）')

  // ── 打包完整性：`files` 白名单差点把 selfcheck.mjs 漏出包（2026-09-16 真事：README 让人跑它，包里却根本没有）──
  const { readdirSync, existsSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { join } = await import('node:path')
  const root = fileURLToPath(new URL('./', import.meta.url))
  const files = pkg.files ?? []
  const covered = (rel) => files.some((f) => String(f) === rel || rel.startsWith(String(f).replace(/\/$/, '') + '/'))
  const srcFiles = readdirSync(join(root, 'src')).filter((n) => n.endsWith('.mjs')).map((n) => `src/${n}`)
  // 插件页本地化（2026-10-02）：宿主 readPluginMeta 读 locale/<语言>.json 的 meta.title/description。
  // 🔴 两条硬约束：① 文件名用**语言 id**——内置语言就是 zh / en（resolveText 按小写键查），
  //    写成 zh-CN.json 会得到永不命中的键 'zh-cn'；② en.json 是**触发条件**（先解析它才会读整个目录）。
  const locEn = (() => { try { return JSON.parse(readFileSync(join(root, 'locale/en.json'), 'utf8')) } catch { return null } })()
  const locZh = (() => { try { return JSON.parse(readFileSync(join(root, 'locale/zh.json'), 'utf8')) } catch { return null } })()
  const localeFiles = (() => { try { return readdirSync(join(root, 'locale')).filter((n) => n.endsWith('.json')).sort() } catch { return [] } })()

  const packChecks = [
    ['files 覆盖运行入口（index.js / client.js / cordis.patch.yml）', ['index.js', 'client.js', 'cordis.patch.yml'].every(covered)],
    ['files 覆盖 selfcheck.mjs（README 让人跑它，就必须在包里）', covered('selfcheck.mjs')],
    [`files 覆盖 src/ 下每个 .mjs（现 ${srcFiles.length} 个；新增文件忘了加会当场红）`, srcFiles.every(covered)],
    ['files 覆盖 tools/check-core.mjs 与 extensions/', covered('tools/check-core.mjs') && covered('extensions')],
    ['files 里没有运行期产物（node_modules / logs / config / accounts）', !files.some((f) => /node_modules|^logs|config\.json|accounts\.json/.test(String(f)))],
    ['files 里每个条目都真实存在', files.every((f) => existsSync(join(root, String(f))))],
    // ── 插件页本地化（见上方 locale 注释）──
    // 🔴 exports 必须**逐文件**导出：试过模式写法 `"./locale/*": "./locale/*.json"`——'*' 会把
    //    'en.json' 整体吞掉，映射成 en.json.json（2026-10-02 实测踩到，且是静默失效，
    //    字符串形式的断言还会假绿）。这里按目录里的每个文件逐一对账。
    ['🔴 exports 逐文件导出 locale/*.json（宿主按 <包名>/locale/en.json 解析；漏一个=静默回退成包名）', localeFiles.length > 0 && localeFiles.every((f) => pkg.exports?.[`./locale/${f}`] === `./locale/${f}`)],
    ['files 覆盖 locale/ 里每个文件（npm 包里要带上本地化文件）', localeFiles.every((f) => covered(`locale/${f}`))],
    ['插件页本地化文件齐全：en/zh 的 meta.title + meta.description 都非空', !!locEn?.meta?.title && !!locEn?.meta?.description && !!locZh?.meta?.title && !!locZh?.meta?.description],
    ['插件页显示名：en=Whale Craft / zh=鲸鱼工艺', locEn?.meta?.title === 'Whale Craft' && locZh?.meta?.title === '鲸鱼工艺'],
  ]
  for (const [label, passed] of packChecks) console.log(`  ${passed ? '✅' : '❌'} ${label}`)

  /* ── 开源副本专有的发版工具（线上插件里没有 scripts/，所以缺失时算"不适用"）─────────
   * 用户 2026-09-17：CI 里那步 npm publish 删掉（红叉来源），npm 改成在本机手动发；
   * 修复靠 scripts/release.workflow.yml 这个**普通文件**分发（推工作流文件需要 workflow scope）。 */
  const scriptsDir = join(root, 'scripts')
  if (!existsSync(scriptsDir)) {
    console.log('  ✅ 发版工具（scripts/）：线上插件没有这层，跳过（开源副本专有）')
  } else {
    const rd = (p) => { try { return readFileSync(join(scriptsDir, p), 'utf8') } catch { return null } }
    const pub = rd('publish-npm.mjs')
    const tpl = rd('release.workflow.yml')
    // ⚠️ 断言前先剥掉 YAML 注释：模板注释里**故意**写了 "npm publish" / "--generate-notes"
    //    （说明为什么删掉它们），不剥就会被自己的注释骗到（2026-09-17 真踩：两条假红）。
    const tplCode = (tpl ?? '').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
    // 发布流程文档已从 根 RELEASING.md 并入 agent-docs/release.md（根只留随包发布的文档）
    const releasing = (() => { try { return readFileSync(join(root, 'agent-docs', 'release.md'), 'utf8') } catch { return null } })()
    const rootAgents = (() => { try { return readFileSync(join(root, 'AGENTS.md'), 'utf8') } catch { return null } })()
    const toolChecks = [
      ['本机发 npm 的脚本在（带前置校验/确认/dry-run）', !!pub && /--dry/.test(pub) && /whoami/.test(pub) && /CHANGELOG\.md/.test(pub) && /npm publish/.test(pub)],
      ['脚本会在"版本已发过 / 树不干净 / token 不可用"时**停下**', /已经发布过了/.test(pub ?? '') && /工作树不干净/.test(pub ?? '') && /npm whoami 失败/.test(pub ?? '')],
      ['工作流修复以**普通文件**分发（scripts/release.workflow.yml）', !!tpl && /gh release create/.test(tpl)],
      ['模板工作流用 CHANGELOG 当正文（不 --generate-notes）', /notes-file notes\.md/.test(tplCode) && !/generate-notes/.test(tplCode)],
      ['模板里取正文的脚本用 .cjs（"type": "module" 下 .js 会被当 ESM 而炸）', !!tpl && /\.notes\.cjs/.test(tpl)],
      ['publishConfig 钉死官方 registry（防止发到镜像）', pkg.publishConfig?.registry === 'https://registry.npmjs.org/' && pkg.publishConfig?.access === 'public'],
      ['npm 脚本入口在（publish:npm / release:workflow-fix）', pkg.scripts?.['publish:npm'] === 'node scripts/publish-npm.mjs' && pkg.scripts?.['release:workflow-fix'] === 'node scripts/land-workflow-fix.mjs'],
      ['发布流程文档（agent-docs/release.md）写清两条渠道与红叉排障', !!releasing && /发 npm/.test(releasing) && /workflow.*scope/.test(releasing) && /Full Changelog/.test(releasing)],
      ['根 RELEASING.md 已并入 agent-docs/release.md（根不留非随包文档）', !existsSync(join(root, 'RELEASING.md'))],
      ['根 AGENTS.md 指向 agent-docs/README.md（引导接手 agent 先读地图）', !!rootAgents && /agent-docs\/README\.md/.test(rootAgents)],
      ['.gitignore 挡住了 .npmrc 与 zip（token / 产物别提交）', (() => { try { const gi = readFileSync(join(root, '.gitignore'), 'utf8'); return /^\.npmrc$/m.test(gi) && /\*\.zip/.test(gi) } catch { return false } })()],
    ]
    for (const [label, passed] of toolChecks) console.log(`  ${passed ? '✅' : '❌'} ${label}`)
  }
}

/* ── 宿主包缺省（src/tool-def.mjs 的内置兜底）──────────────────────────────────
 * 背景（GitHub issue #5）：index.js 顶层曾静态 import 两个 optional peer ⇒ 干净安装 /
 * 官方 dsh-desktop 上模块链接期失败，宿主只报 `failed to import`。这里钉住两条路：
 *   A. 内置 defineTool 与宿主编译/校验逐字一致（本环境有宿主时直接对拍；没有则 ℹ️ 跳过）；
 *   B. "两个包都拿不到"的整树模拟（子进程 + 解析钩子）：apply 不抛、工具面完整、注册形状逐字一致。 */
console.log('\n--- 宿主包缺省：内置 defineTool（tool-def.mjs）---')
{
  console.log(`  ℹ️ 工具定义来源 kind=${toolDef.toolDefKind()}${toolDef.loadNote ? '（' + toolDef.loadNote + '）' : ''}`)

  // A1：与宿主编译器逐字对拍（代表性 spec 覆盖 31 个工具实际用到的全部形态）
  const hostMod = toolDef.hostDefineTool ? await import('@deepseek-ai/dsh-tools') : null
  const repSpec = {
    mode: { type: 'string', description: '模式' },
    count: { type: 'number' },
    flag: { type: 'boolean' },
    patch: { type: 'object', additionalProperties: true, description: '补丁' },
    steps: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '步骤' },
    names: { type: 'array', items: { type: 'string' } },
    value: { type: 'json', description: '任意值' },
    must: { type: 'string', required: true },
  }
  const textOut = { type: 'object', properties: {}, additionalProperties: true }
  if (!hostMod) {
    console.log('  ℹ️ 本环境没有宿主 @deepseek-ai/dsh-tools，跳过逐字对拍（开发机/CI 有宿主，会实际比对）')
  } else {
    const sameParams = JSON.stringify(hostMod.parameterSchemaSpecToJsonSchema(repSpec)) === JSON.stringify(toolDef.parameterSchemaSpecToJsonSchema(repSpec))
    console.log(`  ${sameParams ? '✅' : '❌'} 内置编译器的 parameters JSON Schema 与宿主**逐字一致**（含 key 顺序）`)
    const sameOut = JSON.stringify(hostMod.valueSchemaSpecToJsonSchema(textOut)) === JSON.stringify(toolDef.valueSchemaSpecToJsonSchema(textOut))
    console.log(`  ${sameOut ? '✅' : '❌'} output.schema 走同一编译（text() 的形态逐字一致）`)
    const schemaH = hostMod.parameterSchemaSpecToJsonSchema(repSpec)
    const schemaB = toolDef.parameterSchemaSpecToJsonSchema(repSpec)
    const badArgs = [{}, { must: 'x', count: 'no' }, { must: 'x', patch: 123 }, { must: 'x', patch: { k: {} }, value: new Date() }, { must: 'x', steps: 'nope' }, { must: 'x', names: ['a', 2] }]
    const vSame = badArgs.every((a) => JSON.stringify(hostMod.validateJsonSchemaValue(schemaH, a, '')) === JSON.stringify(toolDef.validateJsonSchemaValue(schemaB, a, '')))
    console.log(`  ${vSame ? '✅' : '❌'} 内置校验的违规文案/路径与宿主**逐字一致**（${badArgs.length} 组坏入参）`)
  }

  // A2：内置 defineTool 行为（不依赖宿主，任何环境都跑）
  const def = toolDef.builtinDefineTool({
    name: 't_def', description: 'd', parameters: repSpec, output: { schema: textOut, render: () => [] }, timeoutMs: 5000,
    async execute (args) { return { got: args.must } },
  })
  console.log(`  ${def.timeoutMs === 5000 ? '✅' : '❌'} timeoutMs 透传（host defineTool 同款）`)
  const bad = await def.execute({}).then(() => null, (e) => e)
  console.log(`  ${bad && bad.name === 'ToolArgsError' && bad.code === 'INVALID_ARGS' && bad.message === 'invalid arguments: missing required property "must"' ? '✅' : '❌'} 坏入参抛 ToolArgsError/INVALID_ARGS，文案与宿主逐字一致（实际：${bad ? JSON.stringify(bad.message) : '没抛'}）`)
  const good = await def.execute({ must: 'hi' }).then((r) => r, () => null)
  console.log(`  ${good && good.got === 'hi' ? '✅' : '❌'} 合法入参放行到用户实现`)
  const threw = (fn) => { try { fn(); return false } catch { return true } }
  console.log(`  ${threw(() => toolDef.parameterSchemaSpecToJsonSchema({ x: { oneOf: [{ type: 'string' }] } })) ? '✅' : '❌'} 未支持形态（oneOf）抛错（防静默走样）`)
  console.log(`  ${threw(() => toolDef.parameterSchemaSpecToJsonSchema({ x: { type: 'object' } })) ? '✅' : '❌'} object 不写 additionalProperties 抛错（宿主同款约束）`)
  console.log(`  ${threw(() => toolDef.builtinDefineTool({ name: 't', description: 'd', parameters: {}, output: { schema: textOut, render: () => [] }, finalizeContent: () => {}, execute: async () => ({}) })) ? '✅' : '❌'} 未支持选项（finalizeContent）抛错（将来真要用会当场红）`)
  console.log(`  ${threw(() => toolDef.builtinDefineTool({ name: 't', description: 'd', parameters: {}, output: { schema: textOut, render: () => [] }, timeoutMs: 0, execute: async () => ({}) })) ? '✅' : '❌'} 非法 timeoutMs 抛错（宿主同款）`)
}

console.log('\n--- 无宿主模拟：屏蔽两个宿主包，整树自检 + 注册形状逐字比对（子进程）---')
if (process.env.WHALE_CRAFT_NO_HOST_SIM === '1') {
  console.log('  ℹ️ 本进程就是"无宿主模拟"子进程（整段跳过，防递归）')
} else if (toolDef.toolDefKind() !== 'host') {
  console.log('  ℹ️ 本环境没有宿主 @deepseek-ai/dsh-tools（kind=builtin）——没有比对参照系，跳过')
} else {
  const { execFileSync } = await import('node:child_process')
  const { pathToFileURL, fileURLToPath } = await import('node:url')
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'whale-craft-nohost-'))
  const dumpPath = join(dir, 'child-tools.json')
  let childFail = null
  let childDump = null
  try {
    execFileSync(process.execPath, [
      '--import', pathToFileURL(fileURLToPath(new URL('./tools/no-host-init.mjs', import.meta.url))).href,
      fileURLToPath(new URL('./selfcheck.mjs', import.meta.url)),
    ], {
      cwd: fileURLToPath(new URL('./', import.meta.url)),
      env: { ...process.env, WHALE_CRAFT_NO_HOST_SIM: '1', WHALE_CRAFT_DUMP_TOOLS: dumpPath, NODE_NO_WARNINGS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    childDump = JSON.parse(readFileSync(dumpPath, 'utf8'))
  } catch (e) { childFail = e }

  const childOut = String(childFail?.stdout ?? '')
  // 只认**行首**的 ❌（断言状态位）；文案里出现的 ❌ 字面（如本行的"0 ❌"）不算
  const failLines = childOut.split('\n').filter((l) => /^[ \t]*❌/.test(l))
  const okRun = !childFail && failLines.length === 0
  console.log(`  ${okRun ? '✅' : '❌'} 无宿主环境下整树自检子进程跑通（exit 0 且 0 ❌；实际 ${childFail ? '退出码非 0' : `${failLines.length} 个 ❌`}）`)
  if (!okRun) {
    console.log(failLines.slice(0, 5).map((l) => '     ' + l.trim()).join('\n') || `     ${String(childFail?.message ?? '').split('\n')[0]}`)
  }
  console.log(`  ${childDump?.toolDefKind === 'builtin' ? '✅' : '❌'} 子进程确实走了内置路（kind=${childDump?.toolDefKind}；屏蔽失败的话这里会是 host）`)
  console.log(`  ${childDump?.configPresent === false ? '✅' : '❌'} 子进程里 Config === undefined（schemastery 拿不到 ⇒ 不导出 schema、apply 自己兜默认值）`)

  const parentList = [...tools.entries()].map(([name, d]) => ({ name, parameters: d.parameters, outputSchema: d.output?.schema, timeoutMs: d.timeoutMs ?? null }))
  const childList = childDump?.tools ?? []
  const same = JSON.stringify(parentList) === JSON.stringify(childList)
  console.log(`  ${same ? '✅' : '❌'} 🔴 ${tools.size} 个工具的 parameters / output.schema / timeoutMs 与宿主编译结果**逐字一致**`)
  if (!same) {
    for (let i = 0; i < Math.max(parentList.length, childList.length); i++) {
      const p = JSON.stringify(parentList[i] ?? null)
      const c = JSON.stringify(childList[i] ?? null)
      if (p !== c) { console.log(`     首个不一致 #${i}：\n       父=${p.slice(0, 200)}\n       子=${c.slice(0, 200)}`); break }
    }
  }
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log('\n日志:', logs.slice(0, 6).join(' | ') || '(无)')
process.exit(0)

