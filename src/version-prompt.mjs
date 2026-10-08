// -*- coding: utf-8 -*-
/**
 * whale_craft / version-prompt.mjs —— **版本硬提示词**（随版本发布，用户在界面上改不了）
 * ============================================================================
 * 用户 2026-09-16 定的：
 *   "我们应该加入'版本硬提示词'，是我们硬编码的、随版本发布的提示词，在行事准则之后
 *    注入后固定注入。"
 *
 * 它和另外两份东西的分工：
 *   · `.whale-craft/RULES.md` —— **Master 维护**的长期规矩（可编辑、可恢复默认）；
 *   · 本条 —— **这个版本**的时效性事实与劝告（工具成熟度、临时取舍），改版本才改它；
 *   · 记忆（`.whale-craft/README.md` 等）—— 玩出来的经验。
 *
 * 规矩（照用户一贯的要求）：
 *   · 走**插件提示行**注入（`agent.inbox.nextStep` + `source:{kind:'plugin',form:'notice'}`），
 *     **不碰系统提示词**；
 *   · 排在 `.whale-craft/RULES.md` **之后** —— 读起来就是"对本版本规则的补充"；
 *   · **不加开关**：它是随版本走的常量，用户不需要也不该改；
 *   · 正文写**本版本的时效性事实与劝告**（哪些工具还不成熟、这个版本能力上的短板）；
 *     **不写版本号**（版本由来源行/标题携带）——正文跨版本保持稳定，哈希只标记这段文字本身。
 * ============================================================================
 */
import { createHash } from 'node:crypto'

/**
 * 生成本版本的硬提示词**正文**。
 *
 * 🔴 用户 2026-09-16 定：**正文里不写版本号**（选项 A）。版本由两条自动生成的行携带 ——
 *    · 模型看得见的来源行：`Instructions from: whale_craft@<版本>（内置版本提示，随插件版本更新）`；
 *    · 用户看得见的折叠标题：`提示词注入：whale_craft v<版本> 版本提示（<正文短哈希>）`。
 *    正文写死版本号会变成第三遍，还会让人误以为"改版本就得改正文"。
 *    所以：**正文跨版本保持不变，哈希只标记这段文字本身**。
 * @returns {string}
 */
export function versionPromptText () {
  return [
    '1. 在本版本中，`mc_move`（walk/fly）、`mc_act`、`mc_build` 这些"自己动手"的工具还不成熟，'
      + '容易操作失败、耗费太多时间。需要移动、建造等时，可以先试一次：用 `mc_command` 发 `/tp`、'
      + '`/setblock`、`/fill`、`/clone` 这类指令；被白名单或权限拒绝时，再改用 `mc_move` / `mc_act` / '
      + '`mc_build`，或者向用户申请。如果你不确定有没有权限、或不知道用户允不允许使用，无须犹豫，先询问；'
      + '如果已有相关记忆，优先按记忆行事。',
    '2. 本版本对于生存、冒险能力的支持极弱。如果收到相关指令，请先明确告知用户，再尽力而为。'
      + '如果遇到明确缺失的能力，向用户列出。',
  ].join('\n')
}

/** 正文的短哈希（写进折叠标题；**只标记正文本身**，与版本号无关）。 */
export function versionPromptHash () {
  return createHash('sha256').update(versionPromptText()).digest('hex').slice(0, 8)
}

/** 折叠标题：`提示词注入：whale_craft v0.1.0 版本提示（a1b2c3d4）` */
export function versionPromptTitle (version) {
  return `提示词注入：whale_craft v${String(version ?? '').trim() || 'unknown'} 版本提示（${versionPromptHash()}）`
}

/** 正文首行那行"来源"（照 DSH 原生 `Instructions from: …` 的形状） */
export function versionPromptSource (version) {
  return `whale_craft@${String(version ?? '').trim() || 'unknown'}（内置版本提示，随插件版本更新）`
}
