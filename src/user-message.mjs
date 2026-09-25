/**
 * 构造"非用户发言"的消息（宿主 `UserMessage` 形状）—— 提示词注入与看门狗唤醒共用。
 * ============================================================================
 * 🔴🔴 2026-09-18 真机事故（用户在**另一台设备**上 npm 装了 0.1.3）：
 *     **提示词一条都没注入**，而工具一切正常；AI 自己都说"没看到"。
 *     根因：构造消息要宿主 `createUserMessage()`，它来自 `@deepseek-ai/dsh-llm`，
 *     而这个包**从来没写进依赖声明**。开发机上碰巧解析得到（那份 node_modules 里有指向
 *     宿主源码的链接），别人正常 `npm i` 装出来的插件目录里没有、往上也找不到 ⇒
 *     函数拿不到 ⇒ 提示行一条都建不出来；而"工具白名单/文件边界"只用 ctx、不碰宿主包，
 *     所以症状精确地是"**工具都在、提示词全无**"。
 *
 *     同一次事故还有**第二处**：`src/watchdog.mjs` 用同一招，拿不到就退到
 *     `sessionController.prompt` —— 那条是**用户来源**消息，会在对话里冒充用户说话。
 *
 * 所以这里统一成一条路：**优先宿主实现，拿不到就用自带等价实现**（纯对象，字段逐个对齐
 * 宿主的 `createUserMessage`：`role` / `content` / `source` / `id`），
 * 让"能不能注入"与运行环境无关。解析失败会**记一行日志**（不再静默）。
 *
 * 🔴🔴 2026-09-22 真机事故（用户："mc模式发消息提示 本轮运行失败 format v4 message
 *     requires a producer-owned source kind"）：
 *     宿主 **DSH 0.1.7 的会话格式是 v4**，而 v4 的准入检查**明确拒绝** V3 的包装 kind
 *     `'plugin'`（见 `@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js:126`：
 *     `... || value["kind"] === "plugin"` → throw）。我们以前写死 `{kind:'plugin',
 *     plugin:'whale_craft'}`，于是**提示词一投递，整个 step 就炸**（工具全正常，
 *     只有注入那条通道死 —— 症状与"插件没装提示词"很像，别搞混）。
 *
 *     正解：`kind` 必须是 **producer-owned**（非空、且不是 `'plugin'`）。宿主的
 *     `producerKind()`（同上 :87-93）对**不在** `RELEASED_SAME_NAME_PRODUCERS`
 *     名单里的第三方插件给的规范值是 `` `plugin:${plugin}` `` ⇒ 我们是
 *     **`plugin:whale_craft`**。宿主迁移老 V3 记录时把 `kind` 换成的也正是这个值
 *     （`rewritePluginSource()` :101-107；它顺带丢掉 `plugin` 字段，我们留着当身份标记
 *     —— 宿主只校验 `kind`，其余自有字段原样保留）。`form:'notice'` + `summary` 不变。
 * ============================================================================
 */
import { createRequire } from 'node:module'

/** 生成消息 id（宿主用 uuid；拿不到 Web Crypto 就退到时间戳+随机） */
export const newMessageId = () => {
  try { return globalThis.crypto.randomUUID() } catch { /* 老 runtime 走下面 */ }
  return 'msg-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

/**
 * 插件提示行的 `source.kind` —— **producer-owned**，v4 会话格式的硬要求。
 * 🔴 不许再写 `'plugin'`（那是 V3 的包装值，v4 准入直接抛错）。
 * 值与宿主 `producerKind('whale_craft')` 的算法一致：`plugin:<插件名>`。
 */
export const PLUGIN_SOURCE_KIND = 'plugin:whale_craft'

/**
 * 造一条"插件提示行"的 `source`：宿主渲染成**折叠的一行 notice**（不是用户发言）。
 * `kind` 是 producer-owned（v4 硬要求）；`plugin` 是本插件自己的身份标记 ——
 * 宿主只校验 `kind`，其余自有字段**原样保留**（宿主自己的 `webhook` 也这么干：
 * `{kind:'webhook', provider, deliveryId, ruleId, form, summary}`），所以留着无害，
 * 且自检里那十几处 `m?.source?.plugin === 'whale_craft'` 的筛选照旧能用。
 * @param {string} summary 那一行摘要（宿主 `CONTEXT_SUMMARY_MAX_CHARS = 120`）
 * @returns {{kind:string, plugin:string, form:'notice', summary:string}}
 */
export const noticeSource = (summary) => ({
  kind: PLUGIN_SOURCE_KIND,
  plugin: 'whale_craft',
  form: 'notice',
  summary: String(summary ?? '').slice(0, 120),
})

/**
 * 自带等价实现：不依赖任何宿主包。
 * @param {{content?: unknown[], source?: object, id?: string}} input
 * @returns {{role:'user', content:unknown[], source:object, id:string}}
 */
export const builtinUserMessage = (input) => ({
  role: 'user',
  content: Array.isArray(input?.content) ? input.content : [],
  source: input?.source ?? { kind: PLUGIN_SOURCE_KIND },
  id: input?.id ?? newMessageId(),
})

/** 宿主那份 `createUserMessage`（解析不到就是 null）；`pluginLoadNote` 供调用方记日志 */
export let hostCreateUserMessage = null
export let pluginLoadNote = ''
try {
  const req = createRequire(import.meta.url)
  const mod = req('@deepseek-ai/dsh-llm')
  hostCreateUserMessage = typeof mod?.createUserMessage === 'function' ? mod.createUserMessage : null
  if (!hostCreateUserMessage) pluginLoadNote = '包里没有 createUserMessage 导出'
} catch (e) {
  pluginLoadNote = `解析不到 @deepseek-ai/dsh-llm（${e?.code ?? e?.message ?? e}）`
}

/**
 * 造一条消息：**优先宿主实现**（形状永远跟得上宿主），拿不到/抛错时用自带等价实现。
 * 两条路产出的字段完全一致，调用方不必关心走了哪条。
 * @param {{content?: unknown[], source?: object, id?: string}} input
 */
export const userMessage = (input) => {
  if (typeof hostCreateUserMessage === 'function') {
    try { return hostCreateUserMessage(input) } catch { /* 宿主实现异常 → 用自带 */ }
  }
  return builtinUserMessage(input)
}

/** 诊断用：现在走的是哪条路（状态页/自检会报） */
export const messageFactoryKind = () => (typeof hostCreateUserMessage === 'function' ? 'host' : 'builtin')
