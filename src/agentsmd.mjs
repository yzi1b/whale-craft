// -*- coding: utf-8 -*-
/**
 * whale_craft / agentsmd.mjs —— 本模式的「行事准则」RULES.md
 * ============================================================================
 * 用户 2026-09-16 的要求：
 *   · 不再注入工作区的 AGENTS.md，改为注入 **`.whale-craft/RULES.md`**（本文件就是它的默认内容）
 *   · Master 可以在「MC设置 → 提示词」页里编辑它，并有**恢复默认**
 *   · **MCAI 不能读写它**（它是给 AI 看的规矩，不是给 AI 改的）
 *
 * 两份内容：
 *   · **默认**：打包在插件里的这份（`DEFAULT_AGENTS_MD`）
 *   · **自定义**：`<工作区>/.whale-craft/RULES.md` —— 存在就用它，删掉就回到默认
 * ============================================================================
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { readRulesVersion, setRulesVersion } from './wsconfig.mjs'

const FILE = 'RULES.md'
/**
 * 老名字。
 *
 * 🔴 2026-09-16 改名原因（用户抓到的致命 bug）：文件名原来叫 `AGENTS.md`，而**宿主的
 *    `@deepseek-ai/dsh-agent-instructions` 恰好把 `AGENTS.md` 当候选指令文件**
 *    （`DEFAULT_INSTRUCTION_FILE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md']`）：
 *    任何会话只要 `read`/`write`/`edit` 过 `.whale-craft/` 下的文件，宿主就会把这个目录里的
 *    `AGENTS.md` 当**工作区指令**注入**那个会话** —— MC 会话被投两遍，非 MC 会话也被污染，
 *    而且我们那个"注入本提示词"的开关**关不掉**它。
 *    改叫 `RULES.md`（不在宿主候选名里）之后，注入只剩我们这一条通道。
 *    老文件见到就**搬内容 + 备份改名**（见 `migrateLegacyAgentsMd`），否则宿主照旧会认它。
 */
const LEGACY_FILE = 'AGENTS.md'
const MAX_BYTES = 128 * 1024

/** 默认「行事准则」（2026-09-18 第五版：用户给的全文 —— 在上一版「建筑须知」之上新增「较长思考」整节；「建筑须知」补"先大体结构 / 每阶段回话 / 完工复盘"） */
export const DEFAULT_AGENTS_MD = `# Whale Craft 行事准则

## 宗旨

遵从用户指令，合理调用工具，扮演好共事玩家的角色，完成用户下达的指令。

## 称呼

用户称呼你为 DeepSeek，你应当对相关简称诸如 ds 敏感，同时也对 DSH（DeepSeek Harness）、AI 相关称呼敏感。

你默认称呼用户为 Master，如果用户指定了称呼，优先使用用户指定的称呼。

如果用户后续提要求让你们如何互相称呼，请记忆，并以记忆为准。而且对你的称呼同样应该发展相关简称，并对其保持敏感。

## 记忆

你可以在 .whale-craft/ 文件夹（即本 RULES.md 文件所在文件夹）下记录文档、svg图像等文件来留存记忆。在必要时你需要手动阅读 .whale-craft/README.md 来跟进对所有 Whale Craft 实例重要的信息。同理，这类信息你也应当记录在该 README.md 文件中。

一般地，你需要分门别类地整理信息，将不同分组的信息放在 .whale-craft/ 的不同子文件夹下。比如，按照用户让你进入的不同服务器分组。分组的索引同样要记录在 .whale-craft/README.md 中。

你不能修改 .whale-craft/RULES.md，即本文件。

## 兼容性

插件对MC版本的支持有限。调用 \`mc_capabilities\` 工具来查看插件支持的范围。如果不支持需要告知用户，并给予可能的解决方案。

## 进入服务器

进入服务器的需求来源于用户发送的消息、\`[system]\`开头的快速指令或提示词注入。通过以下流程进入服务器：

1.  **选定游戏账户。** 若用户没有指定账户，使用 \`mc_accounts {action:list}\` 列出所有账户。如果有默认账户，则使用默认账户。如果没有默认账户或没有任何账户，则询问用户。记住选中账户的 ID。若用户指定了账户没有告知 ID，则使用 \`mc_accounts {action:search}\` 搜索这个账户名，记住 ID。搜索不到，则询问用户。若已告知 ID，则搜索此 ID，验证账户是否存在，记住账户类型。如果有记忆，记忆优先。
2. **刷新游戏账户。** 类型为皮肤站、官方的账户需要刷新。使用 \`mc_accounts {action:refresh}\` 刷新账户。刷新失败代表账户过期，提醒用户重新登录或刷新。
3. **选定服务器。** 若用户指定了服务器地址，则就是这个地址。用户说明服务器名字，则在记忆中搜索，找到地址。如果用户没有提供任何信息，或者要求加入局域网服务器，则调用 \`mc_lan\` 工具扫描局域网服务器并得到地址。有多个时询问用户。局域网服务器地址不固定，记忆时不要用地址作为目录或文件名。
4. **测试服务器。** 使用 \`mc_ping\` 工具测试服务器连通性，关注版本、人数。如果无法连接、版本不在支持范围内、人数超出，拒绝进入服务器，告知用户具体原因，并提出可能的解决方案。
5. **进入服务器。** 使用 \`mc_connect\` 工具，传入服务器地址和账户 ID，进入服务器。如有报错，则告知用户，并提出可能的解决方案。

## 看门狗

看门狗监听游戏内事件，适时**唤醒**你，或在当前生成中**插话**（以提示词注入的形式，不是用户发言）。

看门狗随游戏会话同步建立和关闭，不能单独启停。用 \`mc_status\` 查看连接与游戏会话状态，用 \`mc_watchdog_queue\` 读取结构化事件。用 \`mc_watchdog_info\` 查询事件目录，\`mc_watchdog_config\` 配置 base / scene / effective，\`mc_watchdog_global_settings\` 配置提醒间隔，\`mc_watchdog_focus\` 管理注意配置。

在进入游戏前，你需要先配置看门狗，设置唤醒条件。你需要把你的名字以及缩写等相关联想词都传入看门狗，以便在用户提到你时能将你唤醒。根据实际情况设置相关触发条件，保证需要时能唤醒，又不会频繁意外唤醒浪费算力。

**只走这一条通知通道**：不要另开会话、不要轮询、不要跨会话推送。

## 聊天

进游戏后，确认用户是否也在游戏内，如果在，尽量在游戏和用户说话（使用 \`mc_say\` 工具）。游戏时用户大多盯着游戏聊天，不一定看会话窗口。

用户在游戏中与你聊天时，你应当在第一时间回复其，以免用户等太久。用户在游戏中下达指令，请先回复收到，之后再思考、行动，最后还要答复。

如果用户直接在会话窗口里发消息，就在会话窗口里恢复；最初让他进服的请求除外，进服后应该通过两种方式告知其。 

在游戏中聊天，不要使用任何 markdown 标记符号，而是模拟玩家日常交流。尽量不要在游戏中发送 URL，发送图片应该回到会话窗口进行。

## 建筑须知

建筑时，不仅仅要考虑由你放置或编辑的方块，还要考虑与环境的相互影响。你的建筑行为是否会对已有环境造成割裂，是否需要适当避让或改造环境。以及你的建筑相对于环境来说是否显得突兀，有没有考虑称重、道路连接等。

方块属性和NBT是需要专门考虑的，尤其是你在放置或编辑有多种形态的方块时。你需要考虑楼梯的方向、台阶的上下格，以及火把、灯笼等附着方块的附着位置。这里只是列举其中一小部分，你始终应该重视这些影响表现的属性，实体同理。

多部分方块比如门、床的放置是需要格外注意的。你要考虑你的放置方式（build工具或指令执行）是否会自动部署多部分方块，是否需要自行设置标识多部分方块“部分”的NBT或属性。

在放置、克隆栅栏、栏杆、墙等受连接影响的方块时，你同样需要根据你的放置方式决定是否需要和如何自行设置NBT或属性。

用户对建造的要求一般较高，因此，你不能止步于完成简单的外形建造，应当适当增加细节，比如建筑结构、外饰、内饰、指引等。没有特殊要求时，建筑要保证其功能性、连通性，“生存模式下可以步行通达各功能区”。

先将建筑大体结构完成，再处理细节。每阶段完成要给用户响应，并表明自己还在继续进行任务。

建造完成后，需要复盘。建筑是否完整、美观，是否能完美融入环境。复盘发现问题后要及时修正，再认定任务完成。

## 其他

如果工具调用出现报错，尝试自己解决问题。无法解决也不要退出，而是告知用户，继续游玩。

严格在用户授权范围内建造和破坏，以免造成损失。
`

export function agentsMdPath (dir) { return join(dir, FILE) }

/** 老名字的路径（`AGENTS.md`）：只用于迁移与守卫，不再作为存储位置 */
export function legacyAgentsMdPath (dir) { return join(dir, LEGACY_FILE) }

/**
 * 「随版本更新」的**版本标记**：原来是一枚独立文件 `.rules-version`，
 * 2026-10-03 起收进按工作区的 `config.json` 的 `rulesVersion` 字段（读写见 src/wsconfig.mjs，
 * 迁移会把老工作区里的旧标记文件并进来并删除）。
 */

/**
 * 「随版本更新」（用户 2026-09-17 定，**默认启用**）：插件版本一变，就用**本版本的默认准则**
 * 替换 `.whale-craft/RULES.md` 里那份（用户自己改过的也换掉 —— 这正是这个开关要的语义）。
 *
 * 四种情形：
 *   · `RULES.md` 不存在 → 建默认 + 记版本（`created`）；
 *   · 有文件、**没有标记**（老工作区第一次遇到这个功能，或刚被迁移进来）→ **只记版本，不动内容**（`marked`）——
 *     "更新版本时才替换"，第一次遇到不算更新，免得插件一升级就把人家改的准则冲掉；
 *   · 标记 ≠ 当前版本 且开关**开** → 覆盖成默认 + 记版本（`replaced`）；
 *   · 标记 ≠ 当前版本 但开关**关** → 只把标记更新到当前版本（`kept`）——
 *     这样以后再把开关打开也**不会翻旧账**。
 *   · 标记 = 当前版本 → 什么都不做（`kept`）。
 * @param {string} dir 记忆根（`<工作区>/.whale-craft`）
 * @param {string} version 当前插件版本
 * @param {{follow?:boolean}} [opts] `follow` = 「随版本更新」开关（缺省视为开；来自该工作区的 config.json）
 * @returns {{action:'created'|'replaced'|'kept'|'marked', from:string|null, to:string, error?:string}}
 */
export function syncRulesVersion (dir, version, { follow = true } = {}) {
  const to = String(version ?? '').trim() || 'unknown'
  const p = agentsMdPath(dir)
  if (!existsSync(p)) {
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(p, DEFAULT_AGENTS_MD, 'utf8')
      setRulesVersion(dir, to)
      return { action: 'created', from: null, to }
    } catch (e) {
      return { action: 'kept', from: null, to, error: e.message }
    }
  }
  const from = readRulesVersion(dir)
  if (from === to) return { action: 'kept', from, to }
  if (from === null || follow !== true) {           // 第一次遇到 / 开关关着：只记版本，不动内容
    setRulesVersion(dir, to)
    return { action: from === null ? 'marked' : 'kept', from, to }
  }
  try {
    writeFileSync(p, DEFAULT_AGENTS_MD, 'utf8')
    setRulesVersion(dir, to)
    return { action: 'replaced', from, to }
  } catch (e) {
    return { action: 'kept', from, to, error: e.message }
  }
}

/**
 * 把老的 `.whale-craft/AGENTS.md` 迁到新名字（**幂等**，只在需要时动）。
 *
 * 规则（用户 2026-09-16）：
 *   · 新文件不存在、老文件在 → 把老内容写进 `RULES.md`，再把老文件**改名为带时间戳的备份**
 *     （改名而不是删除：内容不丢；而且那个名字只要还在，宿主就还会把它当工作区指令注入）；
 *   · 新文件在、老文件也在 → **以新文件为准**，老的照样备份改名（同样是为了不让宿主认它）；
 *   · 只有老的、内容为空 → 仍然按上面处理（新文件会拿到默认内容，因为 readAgentsMd 对空文件回退默认）。
 * @returns {{migrated:boolean, backup?:string, reason?:string}}
 */
export function migrateLegacyAgentsMd (dir) {
  const legacy = legacyAgentsMdPath(dir)
  const next = agentsMdPath(dir)
  try {
    if (!existsSync(legacy)) return { migrated: false }
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const backup = `${legacy}.bak-${stamp}`
    if (!existsSync(next)) {
      const raw = readFileSync(legacy, 'utf8')
      const text = raw.trim() ? raw : DEFAULT_AGENTS_MD
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(next, text.endsWith('\n') ? text : text + '\n', 'utf8')
    }
    renameSync(legacy, backup)
    return { migrated: true, backup }
  } catch (e) {
    return { migrated: false, reason: e.message }
  }
}

/**
 * 读当前准则。
 *
 * 🔴 2026-09-16 用户纠正："AGENTS.md 本身不在配置中，不在内存中，就是单纯地编辑这个文件。"
 *    所以 **`source` 由内容判定**（与内置默认逐字相同 = 默认），不再由"文件在不在"判定——
 *    插件初始化会把文件建出来（内容就是默认），那时它不该被标成"Master 自定义版"。
 */
export function readAgentsMd (dir) {
  const p = agentsMdPath(dir)
  try {
    if (existsSync(p)) {
      const raw = readFileSync(p, 'utf8')
      const text = raw.trim() ? raw : DEFAULT_AGENTS_MD
      return { text, source: text.trim() === DEFAULT_AGENTS_MD.trim() ? 'default' : 'custom', path: p }
    }
  } catch { /* 读不了就当没有 */ }
  return { text: DEFAULT_AGENTS_MD, source: 'default', path: p }
}

/** 写入自定义准则（Master 在设置页改） */
export function writeAgentsMd (dir, text) {
  const body = String(text ?? '')
  if (!body.trim()) throw new Error('内容不能为空——想恢复默认请用「恢复默认」')
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error(`内容太大（上限 ${MAX_BYTES / 1024}KB）`)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(agentsMdPath(dir), body.endsWith('\n') ? body : body + '\n', 'utf8')
  return { saved: true, path: agentsMdPath(dir), bytes: Buffer.byteLength(body) }
}

/**
 * 恢复默认：把**默认内容写回文件**（不是删文件）。
 * 🔴 2026-09-16 用户纠正："就是单纯地编辑这个文件" —— 删了文件会让「提示词」页变成
 *    "没有文件、由代码兜底"那套本末倒置的状态；文件永远在，才算真的在编辑一个文件。
 */
export function resetAgentsMd (dir) {
  const p = agentsMdPath(dir)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(p, DEFAULT_AGENTS_MD, 'utf8')
  return { reset: true, path: p, source: 'default', defaultBytes: Buffer.byteLength(DEFAULT_AGENTS_MD) }
}
