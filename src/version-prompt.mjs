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
 *   · 走**插件提示行**注入（本步 `decision.messages` + `source:noticeSource(...)`
 *     = `{kind:'plugin:whale_craft', form:'notice'}`；🔴 kind 不能是 V3 的 `'plugin'`，
 *     v4 会话格式会拒），**不碰系统提示词**；
 *   · 排在 `.whale-craft/RULES.md` **之后**、记忆索引之前 —— 读起来就是"对本版本规则的补充"；
 *   · **不加开关**：它是随版本走的常量，用户不需要也不该改；
 *   · 正文里写清交付流程（发布区 → `mc_kit_express` → 按「文件分享」模式拿到 URL/绝对路径/一句提示，
 *     自己拼 markdown 或原样转达用户）；**不写版本号**（版本由来源行/标题携带）。
 *     否则会和用户的偏好打架（例如他的偏好文件里写着"不要用指令"）。
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
    '',
    '2. 要给用户发送图片等文件，你需要先把要分享的文件放在 `.whale-craft/.express/` 或其子目录下'
      + '（出图时把工具的 `out` 写成 `.whale-craft/.express/<子目录>/x.png`，'
      + '或用 `mc_kit_memory {action:"put"}` 复制过去），然后调用 `mc_kit_express` 工具传入这个文件的路径'
      + '（工作区相对或绝对都行）。它**只回一行**，回什么由用户在「MC设置 → 文件分享」里选的模式决定：'
      + '（a）**关闭**（默认）—— 回一句"文件分享已关闭…"，那就把文件的**绝对路径**告诉用户，'
      + '让用户自己打开，不要再去试别的办法、也不要编造链接；'
      + '（b）**在线** —— 回**完整 URL**（`base` + 路径），把它嵌进回复：图片（内联显示）`![图片名](url)`，'
      + '任意文件（可点开／下载）`[文件名](url)`，**原样使用**，不要补 `http://…` 或域名。'
      + '没有放在 `.whale-craft/.express/` 下的文件无法分享；游戏公屏/私聊里看不到图，'
      + '只能说"图发到会话窗口了"。',
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
