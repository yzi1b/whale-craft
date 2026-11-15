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
 *     同一次事故还有**第二处**：旧看门狗投递器用同一招，拿不到就退到
 *     `sessionController.prompt` —— 那条是**用户来源**消息，会在对话里冒充用户说话。
 *
 * 所以这里统一成一条路：**优先宿主实现，拿不到就用自带等价实现**（纯对象，字段逐个对齐
 * 宿主的 `createUserMessage`：`role` / `content` / `source` / `id`），
 * 让"能不能注入"与运行环境无关。解析失败会**记一行日志**（不再静默）。
 *
 * 🔴 2026-10-04：`source.kind` 必须是 **v4 规范值 `plugin:whale_craft`**——
 *    v4 会话格式**拒绝**裸露的 `kind:'plugin'`（"format v4 message requires a producer-owned
 *    source kind"），而且宿主 `createUserMessage` 对传进来的 source **原样透传**、不会帮我们修正。
 *    规范形态 = 宿主 v3→v4 迁移的产出：`{ kind: 'plugin:<插件名>', form, summary }`（`plugin` 字段随之去掉）。
 *    来源：issue #5 附带 PR #2（@swan3146）在真机上的实验 + 宿主 `dsh-session-format-v3-to-v4` 源码。
 * ============================================================================
 */
import { createRequire } from 'node:module'

/** 生成消息 id（宿主用 uuid；拿不到 Web Crypto 就退到时间戳+随机） */
export const newMessageId = () => {
  try { return globalThis.crypto.randomUUID() } catch { /* 老 runtime 走下面 */ }
  return 'msg-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

/**
 * 自带等价实现：不依赖任何宿主包。
 * @param {{content?: unknown[], source?: object, id?: string}} input
 * @returns {{role:'user', content:unknown[], source:object, id:string}}
 */
export const builtinUserMessage = (input) => ({
  role: 'user',
  content: Array.isArray(input?.content) ? input.content : [],
  source: input?.source ?? { kind: 'plugin:whale_craft' },
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
