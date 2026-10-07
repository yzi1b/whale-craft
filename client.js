/**
 * whale_craft —— 浏览器半端（client bundle）
 * ============================================================================
 * 会话标题旁的状态条 + **一个**「强制停止」按钮 + 「MC设置」按钮与其模态框。
 *
 * 设计约束：
 *   1. **只在真正进了游戏的那个会话显示**（`/api/mc/status` 说 active 才渲染）；
 *      没连游戏时返回 null，完全不占位、不干扰其他会话。
 *   2. **只有强制停止**（用户 2026-09-16：移除普通停止）。点下去后端按这个顺序做：
 *        ① 先停 LLM（如果正在输出） ② 先尝试优雅退出游戏 ③ 再清空该会话全部后台任务
 *        ④ 最后再停一次 LLM（避免②③期间的事件/注入把会话留在异常状态）
 *   3. 插槽用 `conversation.session.header.actions`（list/session，增量安全），
 *      **不**替换 `conversation.session.header`（single，会 shadow 掉官方 UI）。
 *   4. 「MC设置」入口有**两个，按会话是否 blank 互斥**（任何时刻只有一个）：
 *      · **新会话页** → 插到 hero 行里**模式选择芯片的正右边**
 *        （锚点 `[data-slot="conversation.hero.agentPreset"]`，只在 hero 相位存在）；
 *      · **已有会话** → `conversation.session.header.actions`（order 45，状态条左边）。
 *      两者都**只在 MC 模式**渲染，判据是**本地的**会话 preset（见 useMcSettingsGate）。
 *
 * 🔴 2026-09-16 真机事故（别再犯）：早先为了在新对话页放按钮，用
 *    `MutationObserver(document.body)` + `[data-composer-card]` 往上找"卡片前面的兄弟"，
 *    于是**模型生成时**输入框那片 DOM 一变动，按钮就被插到输入框上方、渲染成**全宽长条**
 *    （位置全靠猜、时有时无，且普通会话也有）。
 *    ⇒ 结论：**锚点必须只在该出现的地方存在**，观察范围**只限作曲器卡片**，且必须**门控**。
 *      （现在唯一一处 DOM 注入就是 `mountHeroChipButton`，它满足这三条：
 *        锚点 `[data-slot="conversation.hero.agentPreset"]` 只在 hero 相位存在、
 *        观察范围限于 `[data-composer-card]`、并且只在"blank + MC 模式"时挂载。）
 *
 * 2026-09-16 改版（用户："UI 被你搞得乱七八糟" → 重构）：
 *   模态框从**一页长滚动**改成**两栏**：左侧竖排标签（账户 / 指令白名单 / 提示词），
 *   右侧**一次只渲染当前那一页**。旧版那一坨账户界面**原样搬进「账户」页**（字段/请求都没改）。
 *
 * 🔴 文案规矩（用户 2026-09-16）：**UI 里只写用户需要的信息**。
 *    不要出现实现细节/AI 味的话——例如"账号密码只保存在你本机的 DSH 凭据库里，AI 看不到"、
 *    "这个开关一拨就生效（即时保存）"、"当前来源：默认版"、凭据库/接口/令牌之类的词。
 *    那一页就叫**「提示词」**，不要叫"行事准则"（"行事准则"只是那份正文自己的标题）。
 *
 * 🔴 凭据边界：密码/token **只进宿主凭据库**。本文件的 password 输入框是**非受控**的，
 *    值从不进 props/state/data-*，也从不 console.log；接口响应里本来就没有密码。
 *
 * 这是手写 factory bundle：无需构建，`exports["./client"]` 直接指向本文件。
 * 改本文件后由 @deepseek-ai/dsh-client-hmr 自动热换，**不需要** pnpm run dev:web。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'whale_craft',
  factory(require) {
    const React = require('react')

    // 🔴 图标约定（2026-10-04 用户定）：**一律取自 DSH 官方的图标集**，不要自己画、
    //    也不要另引第三方图标库。DSH 把它的图标集（`IconSettingsOutlineRegular` 等）
    //    随 `@deepseek-ai/dsh-client-ui-primitives` 作为**平台内置模块**暴露给所有客户端插件
    //    （shell 的静态模块表里就有它，官方插件也是直接 require 的）——所以这里 require 即得
    //    "同源同款"，与原生「卸载」按钮的 `IconTrashOutlineRegular` 是同一套。
    //    命名：`…OutlineRegular` = 1px 描边（本文按钮用这个），`…OutlineMedium` = 1.3px。
    //    兜底：宿主万一没提供（理论上不该发生），退回"无图标"而不是让整个客户端半端挂掉。
    let IconSettingsOutlineRegular = null
    let IconFolderOpenRegular = null
    let IconCloseOutlineRegular = null
    let IconRunRegular = null
    let IconChevronDownOutlineRegular = null
    let TooltipPrimitive = null
    let createRoot = null
    try {
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
      IconSettingsOutlineRegular = primitives.IconSettingsOutlineRegular
      // 「创建MC+分支」按钮的 tooltip，与原生消息操作按钮同款。
      TooltipPrimitive = primitives.Tooltip
      // 工作区标记：native `WorkspaceChip` 同款文件夹图标（有 label 时就用它、size 16）。
      IconFolderOpenRegular = primitives.IconFolderOpenRegular
      // 弹窗右上角关闭按钮的叉图标（与 DSH 原生弹窗同款）。
      IconCloseOutlineRegular = primitives.IconCloseOutlineRegular
      // 「运行」图标 = **裸的实心向右三角**（不要外圈/描边）——「连接到MC」按钮与弹窗里的「连接」都用它。
      IconRunRegular = primitives.IconTriangleRightFillRegular
      IconChevronDownOutlineRegular = primitives.IconChevronDownOutlineRegular
      // hero 那个「设置」按钮是**纯 DOM**（不是 React 渲染的），拿不到 React 组件本身；
      // 借 react-dom 的一个小根把图标渲染进按钮，图标仍出自同一套官方图标集（不另画、不搬路径）。
      createRoot = require('react-dom/client').createRoot
    } catch (e) { /* 见上：只用图标，拿不到就退回文字，别让按钮变空白 */ }

    // apply() 时记下客户端 ctx：插槽组件拿不到 ctx，靠它取 uiWorkspace.openSession 打开新分支。
    let clientCtx = null

    const CSS = `
[data-mc-status]{display:inline-flex;align-items:center;gap:8px;height:28px;padding:0 6px 0 10px;
  border-radius:999px;background:var(--dsw-alias-bg-overlay);
  color:var(--dsw-alias-label-primary);font-size:12px;line-height:1;white-space:nowrap;
  box-shadow:var(--dsw-elevation-panel,0 1px 2px rgba(0,0,0,.12));}
[data-mc-status][data-mc-busy]{opacity:.6;pointer-events:none;}
[data-mc-dot]{width:7px;height:7px;border-radius:999px;background:var(--dsw-alias-state-success-primary);flex:none;}
[data-mc-dot][data-mc-warn]{background:var(--dsw-alias-state-warn-primary);}
[data-mc-text]{color:var(--dsw-alias-label-secondary);}
[data-mc-sub]{color:var(--dsw-alias-label-tertiary);max-width:24ch;overflow:hidden;text-overflow:ellipsis;}
[data-mc-btn]{display:inline-flex;align-items:center;justify-content:center;height:22px;padding:0 9px;
  border:0;border-radius:999px;background:transparent;cursor:pointer;font-size:12px;line-height:1;
  color:var(--dsw-alias-label-secondary);font-family:inherit;}
[data-mc-btn]:hover{background:var(--dsw-alias-border-inverted);color:var(--dsw-alias-label-primary);}
[data-mc-btn][data-mc-danger]{color:var(--dsw-alias-state-error-primary);}
[data-mc-btn][data-mc-danger]:hover{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground,#fff);}

/* ── 「MC设置」按钮：普通次级按钮（**不**照搬状态条药丸外形）──────────────────
   只由 React 插槽渲染（标题条），**没有任何 DOM 注入**。 */
[data-wc-btn]{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 12px;
  border:1px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2,rgba(128,128,128,.28)));
  border-radius:8px;background:transparent;cursor:pointer;font-size:12px;line-height:1;
  font-family:inherit;color:var(--dsw-alias-label-secondary);white-space:nowrap;}
[data-wc-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));
  color:var(--dsw-alias-label-primary);}
[data-wc-btn]:disabled{opacity:.5;cursor:default;}
[data-wc-btn][data-wc-primary]{border-color:transparent;background:var(--dsw-alias-button-info-fill);
  color:var(--dsw-alias-label-primary-foreground,#fff);}
[data-wc-btn][data-wc-primary]:hover{background:var(--dsw-alias-button-info-hover,var(--dsw-alias-button-info-fill));}
[data-wc-btn][data-wc-primary]:disabled{opacity:.5;}
[data-wc-btn][data-wc-danger]{color:var(--dsw-alias-state-error-primary);}
[data-wc-btn][data-wc-danger]:hover{background:var(--dsw-alias-state-error-primary);
  color:var(--dsw-alias-label-primary-foreground,#fff);}
[data-wc-btn][data-wc-tiny]{height:24px;padding:0 9px;font-size:11px;}
/* 只有图标的按钮：收成正方形（边长 = 高度） */
[data-wc-btn][data-wc-icon]{padding:0;width:28px;}
[data-wc-btn][data-wc-tiny][data-wc-icon]{width:24px;}
/* 新会话页那个按钮是插进 hero 行、贴在模式芯片右边的（那一行 gap:2px，这里再给点间距） */
[data-whale-craft-mc-settings]{margin-left:6px;}
[data-slot="conversation.session.header.actions"] [data-wc-btn]:first-child{margin-left:8px;}

/* ── 「创建MC+分支」：仿原生消息操作图标按钮（挂在 assistant-actions 插槽，只出图标）────── */
[data-wc-plus-branch]{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;
  padding:0;border:0;border-radius:6px;background:transparent;cursor:pointer;font-family:inherit;
  color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));}
[data-wc-plus-branch]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));
  color:var(--dsw-alias-label-primary);}
[data-wc-plus-branch]:disabled{opacity:.5;cursor:default;}

/* ── 模态框 ────────────────────────────────────────────────────────────── */
[data-wc-overlay]{position:fixed;inset:0;z-index:1000;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.45));
  display:flex;align-items:center;justify-content:center;padding:24px;}
/* 🔴 **固定尺寸**（用户 2026-09-16）：切换标签页时卡片不许忽大忽小——
   内容少了就下面留空（内容本身居上），内容多了由右侧内容区自己滚动。 */
[data-wc-card]{position:relative;display:flex;flex-direction:column;width:min(760px,100%);
  height:min(86vh,860px);overflow:hidden;border-radius:24px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1));
  color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.28));}
[data-wc-head]{display:flex;align-items:center;gap:12px;height:52px;flex:none;padding:0 16px 0 20px;
  border-bottom:1px solid var(--dsw-alias-border-l2,transparent);}
[data-wc-titlewrap]{display:flex;flex-direction:column;gap:3px;min-width:0;}
/* 标题那一行：标题 + （有工作区时）文件夹图标 + 灰色工作区名，小间隔 */
[data-wc-titleline]{display:flex;align-items:center;gap:8px;min-width:0;}
[data-wc-title]{font-size:14px;font-weight:600;line-height:1;}
/* 头部的工作区名（灰、次要色） */
[data-wc-wsname]{display:inline-flex;align-items:center;gap:4px;min-width:0;font-size:12px;
  font-weight:400;color:var(--dsw-alias-label-tertiary);}
[data-wc-wsname] > span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-wc-subhead]{font-size:11px;line-height:14px;color:var(--dsw-alias-label-tertiary);}
[data-wc-grow]{flex:1;min-width:0;}

/* —— 「属于本工作区」标记 + 无工作区提示 —— */
[data-wc-wsmark]{display:inline-flex;align-items:center;vertical-align:middle;margin-left:5px;
  color:var(--dsw-alias-label-tertiary);cursor:default;}
[data-wc-wsneed]{display:flex;justify-content:center;align-items:center;gap:6px;margin-top:16px;
  color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;}
[data-wc-dimmed]{opacity:.6;}
/* 弹窗右上角关闭：**叉图标**，与标题同色；hover 红；无边框、无底色（2026-10-04 定，其余弹窗照此） */
[data-wc-xbtn]{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;
  padding:0;border:0;background:transparent;border-radius:6px;cursor:pointer;font-family:inherit;
  color:var(--dsw-alias-label-primary);}
[data-wc-xbtn]:hover{color:var(--dsw-alias-state-error-primary);}
[data-wc-xbtn]:disabled{opacity:.5;cursor:default;}
/* ── 「连接到MC」弹窗（2026-10-04）────────────────────────────────────── */
[data-wc-cn-overlay]{position:fixed;inset:0;z-index:1000;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.45));
  display:flex;align-items:center;justify-content:center;padding:24px;}
/* 叠加在「连接到MC」之上的设置弹窗：更高一层 */
[data-wc-overlay][data-wc-nested]{z-index:1200;}
/* **固定窗口**（用户要求）：宽高定死；上方留白、底部 footer 贴底 */
[data-wc-cn-card]{position:relative;display:flex;flex-direction:column;width:min(760px,100%);
  height:min(82vh,600px);overflow:hidden;border-radius:20px;
  background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);
  box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.28));}
/* 内容整体垂直居中，再**上移约 10%**（用户要求）；顶部那点空给浮层错误提示 */
[data-wc-cn-body]{position:relative;flex:1;min-height:0;overflow:auto;padding:24px 52px 84px;
  display:flex;flex-direction:column;justify-content:center;gap:10px;}
[data-wc-cn-foot]{flex:none;padding:10px 24px 14px;
  border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));}
/* 连接出错：**浮在地址上方的留白里**，3s 自动消失（定时器见组件） */
[data-wc-cn-error]{position:absolute;top:7px;left:36px;right:36px;z-index:2;
  padding:5px 10px;border-radius:8px;font-size:12px;line-height:18px;word-break:break-word;
  background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground,#fff);}
/* 「运行」图标：DSH 裸三角几何 → **描边成空心**（不要实心、不要外圈）。
 * 🔴 那个三角在 16×16 viewBox 里只占中间一小块（约 5.7×8），所以默认渲染**又小、四周全是透明边**。
 *    → 用 transform-box:fill-box 按**图形自身**略微放大（**不能放太满**，否则比设置图标还大）。 */
.wc-runicon{overflow:visible;}
.wc-runicon path{fill:none;stroke:currentColor;stroke-width:1.1;stroke-linejoin:round;
  transform-box:fill-box;transform-origin:center;transform:scale(1.35);vector-effect:non-scaling-stroke;}
/* 三角在方框里左右还各留一截透明边 → 放在按钮里会把左边距撑大；用负外边距把它收回去 */
[data-wc-btn] .wc-runicon{margin-left:-4px;margin-right:-2px;}
[data-wc-cn-fieldlabel]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin-bottom:4px;}
[data-wc-cn-row]{display:flex;gap:8px;align-items:center;}
/* box-sizing:border-box —— 否则 1px 边框会让输入框比旁边的按钮**高一点点** */
[data-wc-cn-input]{box-sizing:border-box;flex:1;min-width:0;height:34px;padding:0 10px;border-radius:8px;font:inherit;font-size:13px;
  border:1px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2,rgba(128,128,128,.28)));
  background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary);outline:none;}
[data-wc-cn-input]:focus{border-color:var(--dsw-alias-state-business-primary,#4a8cff);}
/* 历史气泡行：**不换行、左右滚** */
[data-wc-cn-bubbles]{display:flex;flex-wrap:nowrap;gap:8px;overflow-x:auto;padding-bottom:2px;}
[data-wc-cn-bubble]{flex:none;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 6px 0 12px;
  border-radius:999px;background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));
  font-size:12px;white-space:nowrap;color:var(--dsw-alias-label-primary);cursor:pointer;
  transition:background .12s;}
[data-wc-cn-bubble]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.28));}
[data-wc-cn-bubblex]{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;
  border:0;background:transparent;border-radius:999px;cursor:pointer;color:var(--dsw-alias-label-tertiary);}
[data-wc-cn-bubblex]:hover{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground,#fff);}
/* 探测中：三方块一行、文案另起一行（**各占一行**，都水平居中） */
/* 🔴 探测区**定高**（min-height 容器 + 固定高的 probe）：探测动画消失（转空或转列表）时
 *    高度不塌，body 又是垂直居中，否则地址行会跟着往下跳。列表更高时正常往下撑。 */
[data-wc-cn-lanarea]{min-height:54px;display:flex;flex-direction:column;justify-content:center;}
[data-wc-cn-probe]{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;
  height:54px;box-sizing:border-box;padding:10px 0;line-height:18px;
  color:var(--dsw-alias-label-tertiary);font-size:12px;}
[data-wc-cn-dots]{display:flex;align-items:center;gap:8px;}
[data-wc-cn-dot]{width:8px;height:8px;border-radius:2px;background:currentColor;opacity:.2;
  animation:wc-breathe 1.4s ease-in-out infinite;}
[data-wc-cn-dot]:nth-child(2){animation-delay:.2s;}
[data-wc-cn-dot]:nth-child(3){animation-delay:.4s;}
@keyframes wc-breathe{0%,100%{opacity:.2;}50%{opacity:1;}}
/* 局域网行区：限高滚动，与下方「选项」栏留距 */
[data-wc-cn-lans]{max-height:200px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;margin-bottom:4px;}
/* 🔴 整张卡片**就是一个按钮**；运行图标**无缝嵌在里面**（不单独做按钮、没有自己的底色） */
[data-wc-cn-lan]{display:flex;align-items:center;gap:12px;width:100%;min-height:44px;padding:6px 12px;
  border:0;border-radius:10px;background:transparent;cursor:pointer;font:inherit;text-align:left;
  color:var(--dsw-alias-label-primary);transition:background .12s;}
[data-wc-cn-lan]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));}
[data-wc-cn-lan]:disabled{opacity:.6;cursor:default;}
[data-wc-cn-chip]{flex:none;font-size:11px;line-height:18px;padding:0 8px;border-radius:999px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.16));color:var(--dsw-alias-label-secondary);}
[data-wc-cn-addr]{flex:none;max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:13px;color:var(--dsw-alias-label-primary);}
/* MOTD：地址**右边**、灰色、**固定两行**。
 * 🔴 外层只负责"占两行高度 + **把文字垂直居中**"（否则单行 MOTD 会贴在 2 行框的顶部，看着比地址偏上） */
[data-wc-cn-motd]{flex:1;min-width:0;margin-left:14px;display:flex;align-items:center;
  min-height:32px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px;}
[data-wc-cn-motdtext]{width:100%;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;}
[data-wc-cn-count]{flex:none;font-size:12px;color:var(--dsw-alias-state-success-primary);}
/* 版本号（玩家数左边）：在支持范围内绿、超出红 */
[data-wc-cn-ver]{flex:none;font-size:12px;color:var(--dsw-alias-state-success-primary);}
[data-wc-cn-ver][data-wc-cn-bad],[data-wc-cn-count][data-wc-cn-bad]{color:var(--dsw-alias-state-error-primary);}
[data-wc-cn-run]{flex:none;display:inline-flex;align-items:center;color:var(--dsw-alias-label-secondary);}
[data-wc-cn-lan]:hover [data-wc-cn-run]{color:var(--dsw-alias-label-primary);}
/* 「连接」/ 局域网行的运行按钮：地址行那个与输入框**等高**（34px） */
[data-wc-cn-actions]{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;
  padding:0 12px;border:0;border-radius:8px;cursor:pointer;font-size:12px;font-family:inherit;line-height:1;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14));color:var(--dsw-alias-label-primary);white-space:nowrap;}
[data-wc-cn-actions]:hover{background:var(--dsw-alias-state-business-primary,#4a8cff);
  color:var(--dsw-alias-label-primary-foreground,#fff);}
[data-wc-cn-actions]:disabled{opacity:.5;cursor:default;}
/* 底部配置行 */
[data-wc-cn-config]{display:flex;gap:20px;align-items:flex-start;}
/* 账户名后面的「（来源）」要**灰** */
[data-wc-cn-src]{color:var(--dsw-alias-label-tertiary);}
[data-wc-cn-pick]{position:relative;min-width:200px;}
[data-wc-cn-pickbtn]{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;height:32px;
  padding:0 10px;border-radius:8px;font:inherit;font-size:13px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2,rgba(128,128,128,.28)));
  background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary);}
/* 下拉菜单**向上**展开：这一行在弹窗底部，向下会被卡片/滚动区裁掉 */
[data-wc-cn-menu]{position:absolute;left:0;right:0;bottom:calc(100% + 4px);z-index:5;max-height:240px;overflow:auto;
  border-radius:10px;padding:4px;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));
  box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.3));}
[data-wc-cn-item]{display:block;width:100%;text-align:left;padding:7px 10px;border:0;border-radius:6px;
  background:transparent;cursor:pointer;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);}
[data-wc-cn-item]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14));}
[data-wc-cn-item][data-wc-cn-manage]{color:var(--dsw-alias-label-tertiary);}
[data-wc-cn-extras]{flex:1;min-width:0;}

/* 注入开关 label 里的文件名：文件不存在 → 斜体灰删除线（hover 提示见 title） */
[data-wc-filename]{font-weight:400;}
[data-wc-filename][data-wc-missing]{font-style:italic;color:var(--dsw-alias-label-tertiary);
  text-decoration:line-through;cursor:default;}

/* —— 两栏：左标签页 + 右内容区（一次只渲染一页）—— */
[data-wc-panes]{display:flex;flex:1;min-height:0;}
[data-wc-side]{flex:none;width:132px;padding:12px 8px;overflow:auto;
  border-right:1px solid var(--dsw-alias-border-l2,transparent);
  background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-overlay));
  display:flex;flex-direction:column;gap:2px;}
[data-wc-tab]{display:block;width:100%;text-align:left;padding:8px 10px;border:0;border-radius:8px;
  background:transparent;cursor:pointer;font-family:inherit;font-size:12px;line-height:18px;
  color:var(--dsw-alias-label-secondary);}
[data-wc-tab]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));
  color:var(--dsw-alias-label-primary);}
[data-wc-tab][data-wc-tab-on]{background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-bg-overlay));
  color:var(--dsw-alias-label-primary);font-weight:600;}
[data-wc-pane]{flex:1;min-width:0;overflow:auto;padding:16px 20px 24px;}

[data-wc-sec]{margin-bottom:22px;}
[data-wc-sec]:last-child{margin-bottom:0;}
[data-wc-h]{margin:0 0 10px;font-size:12px;font-weight:600;line-height:1.4;
  color:var(--dsw-alias-label-secondary);}
[data-wc-note]{margin:0 0 12px;padding:8px 10px;border-radius:8px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.1));font-size:11px;line-height:16px;
  color:var(--dsw-alias-label-tertiary);}
[data-wc-alert]{margin:0 0 12px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:18px;
  word-break:break-word;background:var(--dsw-alias-state-error-primary);
  color:var(--dsw-alias-label-primary-foreground,#fff);}
[data-wc-ok]{margin:0 0 12px;padding:6px 10px;border-radius:8px;font-size:11px;line-height:16px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.1));color:var(--dsw-alias-label-tertiary);}
[data-wc-dim]{color:var(--dsw-alias-label-tertiary);}

/* ── 账户页：抬头（右上角「添加」）+ 横条 + 类型气泡 ─────────────────────── */
[data-wc-panehead]{display:flex;align-items:center;gap:10px;margin:0 0 12px;}
[data-wc-panehead] [data-wc-h]{margin:0;}
[data-wc-spacer]{flex:1;min-width:0;}
[data-wc-acct]{display:flex;align-items:center;gap:8px;height:44px;padding:0 8px 0 12px;margin-bottom:6px;
  border-radius:10px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-overlay));}
[data-wc-acct]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1));}
[data-wc-acctname]{font-size:13px;line-height:18px;min-width:0;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;color:var(--dsw-alias-label-primary);}
/* 第三方账户的服务器名（小字号灰字；没有名字就显示 url） */
/* 「提示词」页顶部的注入状态（2026-09-16）：一眼看出会不会注入、为什么不会 */
[data-wc-injectstatus]{font-size:12px;line-height:18px;color:var(--dsh-text-2,#9aa0a6);margin:0 0 8px;}
[data-wc-injectstatus] [data-wc-note]{font-size:11px;line-height:16px;color:var(--dsh-text-3,#7a8085);margin-top:2px;}
[data-wc-hint] strong{font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6);}
[data-wc-verprompt]{margin:0 0 10px;font-size:12px;color:var(--dsh-text-2,#9aa0a6);}
[data-wc-verprompt] summary{cursor:pointer;}
[data-wc-verprompt] pre{margin:6px 0 0;padding:8px 10px;border-radius:6px;white-space:pre-wrap;
  background:var(--dsw-alias-bg-overlay);color:var(--dsh-text-1,#e6e6e6);font:inherit;font-size:11px;line-height:16px;}
[data-wc-acctsub]{font-size:11px;line-height:16px;min-width:0;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;color:var(--dsw-alias-label-tertiary);}
[data-wc-acctacts]{flex:none;display:flex;align-items:center;gap:2px;}
[data-wc-chip]{display:inline-flex;align-items:center;flex:none;height:20px;padding:0 9px;border-radius:999px;
  font-size:11px;line-height:1;white-space:nowrap;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.16));color:var(--dsw-alias-label-secondary);}
[data-wc-chip][data-wc-chip-offline]{background:var(--dsw-alias-state-business-primary,rgba(64,128,255,.18));
  color:var(--dsw-alias-label-primary);}
[data-wc-chip][data-wc-chip-ygg]{background:var(--dsw-alias-state-success-primary,rgba(0,180,120,.18));
  color:var(--dsw-alias-label-primary);}
[data-wc-chip][data-wc-chip-ms]{background:var(--dsw-alias-state-warn-primary,rgba(255,180,0,.18));
  color:var(--dsw-alias-label-primary);}
[data-wc-chip][data-wc-chip-default]{background:transparent;
  border:1px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2,rgba(128,128,128,.3)));}

/* ── 新建/编辑：类型选择 / 字段 / 已缓存服务器标签 ─────────────────────── */
[data-wc-typelist]{display:flex;flex-direction:column;gap:8px;}
[data-wc-type]{display:flex;flex-direction:column;gap:3px;padding:12px 14px;border-radius:12px;text-align:left;
  cursor:pointer;font-family:inherit;border:1px solid transparent;
  background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-overlay));color:var(--dsw-alias-label-primary);}
[data-wc-type]:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary);}
[data-wc-type]:disabled{opacity:.5;cursor:not-allowed;}
[data-wc-typename]{font-size:13px;font-weight:600;line-height:18px;}
[data-wc-typedesc]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);}
[data-wc-field]{display:flex;flex-direction:column;gap:6px;margin:0 0 12px;}
[data-wc-label]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);}
[data-wc-field] [data-wc-in]{width:100%;height:32px;box-sizing:border-box;}
[data-wc-tags]{display:flex;flex-wrap:wrap;gap:6px;}
/* 拽托接受区（authlib-injector 卡片）：**要看得见**——老版有一块虚线区，别偷偷摸摸只挂在输入框上 */
[data-wc-drop]{display:flex;align-items:center;justify-content:center;height:36px;margin-top:6px;
  border-radius:8px;font-size:11px;line-height:16px;text-align:center;
  color:var(--dsw-alias-label-tertiary);
  border:1px dashed var(--dsw-alias-border-l3,var(--dsw-alias-border-l2,rgba(128,128,128,.4)));}
[data-wc-drop][data-wc-drag]{border-color:var(--dsw-alias-state-business-primary);
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08));
  color:var(--dsw-alias-label-primary);}
/* 开关放进动作行时不要它自带的下边距 */
[data-wc-acts] [data-wc-switchrow]{margin:0;}
[data-wc-tag]{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 4px 0 10px;border-radius:999px;
  font-size:12px;line-height:1;border:1px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2,rgba(128,128,128,.3)));
  background:transparent;color:var(--dsw-alias-label-secondary);}
[data-wc-tag][data-wc-tag-on]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary);}
[data-wc-tagpick]{display:inline-flex;align-items:center;height:24px;padding:0 2px;border:0;background:transparent;
  cursor:pointer;font-family:inherit;font-size:12px;line-height:1;color:inherit;max-width:190px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-wc-tagx]{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;
  border:0;border-radius:999px;background:transparent;cursor:pointer;font-family:inherit;font-size:12px;line-height:1;
  color:var(--dsw-alias-label-tertiary);}
[data-wc-tagx]:hover{background:var(--dsw-alias-state-error-primary);
  color:var(--dsw-alias-label-primary-foreground,#fff);}
[data-wc-acts]{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:10px;}
[data-wc-val]{word-break:break-all;user-select:text;}

/* ── 表单控件 ──────────────────────────────────────────────────────────── */
[data-wc-in]{height:28px;padding:0 9px;border-radius:8px;font-size:12px;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2,rgba(128,128,128,.28)));
  background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-1));
  color:var(--dsw-alias-label-primary);outline:none;min-width:0;}
[data-wc-in]:focus{border-color:var(--dsw-alias-state-business-primary);}
[data-wc-in]::placeholder{color:var(--dsw-alias-label-tertiary);}
select[data-wc-in]{appearance:none;padding-right:22px;
  background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);
  background-position:calc(100% - 14px) 12px,calc(100% - 9px) 12px;background-size:5px 5px,5px 5px;
  background-repeat:no-repeat;}
[data-wc-w-name]{width:130px;}
[data-wc-w-uuid]{width:250px;}
[data-wc-w-grow]{flex:1;min-width:150px;}
[data-wc-form]{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0 4px;}
[data-wc-textarea]{display:block;width:100%;min-height:150px;padding:10px;border-radius:8px;
  font-size:12px;line-height:18px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  resize:vertical;box-sizing:border-box;
  border:1px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2,rgba(128,128,128,.28)));
  background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-1));
  color:var(--dsw-alias-label-primary);outline:none;}
[data-wc-textarea]:focus{border-color:var(--dsw-alias-state-business-primary);}
[data-wc-textarea][data-wc-tall]{min-height:300px;}
/* 「已允许所有指令」时白名单框：仍可编辑，但灰掉表示暂不生效 */
[data-wc-textarea][data-wc-dimmed]{opacity:.45;cursor:not-allowed;}
[data-wc-hint]{margin:8px 0 0;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);}
[data-wc-hint][data-wc-dirty]{color:var(--dsw-alias-state-warn-primary,rgba(255,180,0,1));}
/* 出错提示（如分享端口被占用）—— 红字 */
[data-wc-hint][data-wc-error]{color:var(--dsw-alias-state-error-primary,#e5484d);}
[data-wc-code]{padding:0 4px;border-radius:4px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));}
[data-wc-warnnote]{margin:0 0 10px;padding:8px 10px;border-radius:8px;font-size:11px;line-height:16px;
  background:var(--dsw-alias-state-warn-primary,rgba(255,180,0,.18));
  color:var(--dsw-alias-label-primary);}
/* ── 开关（用于「允许所有指令」/「注入 AGENTS.md」）───────────────────── */
[data-wc-switchrow]{display:flex;align-items:flex-start;gap:10px;margin:0 0 12px;}
[data-wc-switchmain]{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;}
[data-wc-switchlabel]{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);}
[data-wc-switchdesc]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);}
[data-wc-switch]{flex:none;position:relative;width:34px;height:20px;margin-top:2px;padding:0;
  border:0;border-radius:999px;cursor:pointer;font:inherit;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.3));transition:background .15s ease;}
[data-wc-switch]:disabled{opacity:.4;cursor:not-allowed;}
[data-wc-knob]{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:999px;
  background:var(--dsw-alias-label-primary-foreground,#fff);transition:left .15s ease;}
[data-wc-switch][data-wc-on]{background:var(--dsw-alias-state-business-primary,#4a8cff);}
[data-wc-switch][data-wc-on] [data-wc-knob]{left:16px;}
`

    /* ==================================================================
     * 模块级事件总线
     * ----------------------------------------------------------------
     * hero 那个「MC设置」按钮是**纯 DOM**（宿主没暴露 react-dom，不能 createPortal），
     * 所以它没法直接 setState —— 它只 emit，由 React 侧的 McSettingsHost 订阅并开关模态框。
     * 总线**不传任何凭据**，只传一个空标记。
     * ================================================================== */
    const settingsBus = {
      listeners: new Set(),
      subscribe(fn) {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
      emit() {
        for (const fn of Array.from(this.listeners)) {
          try { fn() } catch (e) { /* 单个订阅者出错不影响别人 */ }
        }
      },
    }
    const openSettings = () => settingsBus.emit()
    /** 同款总线：「连接到MC」的 hero 按钮也是纯 DOM，用它叫醒 React 侧的模态框 */
    const connectBus = {
      listeners: new Set(),
      subscribe(fn) {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
      emit() {
        for (const fn of Array.from(this.listeners)) {
          try { fn() } catch (e) { /* 单个订阅者出错不影响别人 */ }
        }
      },
    }
    const openConnect = () => connectBus.emit()

    /* ==================================================================
     * 接口小工具（契约见 index.js 的 /api/mc/accounts 等路由）
     * ================================================================== */

    /** 统一的错误对象：带上后端的 needUserAction / hint，方便前端提示得具体些 */
    function apiError(payload, status) {
      const e = new Error(payload?.error || payload?.message || `请求失败（HTTP ${status}）`)
      if (payload?.needUserAction) e.needUserAction = true
      if (payload?.hint) e.hint = String(payload.hint)
      return e
    }

    /** 拼一行的调试文本（**只放状态码**，绝不回显请求体 —— 里面有密码） */
    const describe = (e, status) => `${e?.message ?? e}${status ? `（HTTP ${status}）` : ''}`

    async function apiFetch(path, opts) {
      const init = Object.assign({ headers: { accept: 'application/json' } }, opts)
      if (init.body !== undefined && init.body !== null) {
        init.method = init.method || 'POST'
        init.headers = Object.assign({}, init.headers, { 'content-type': 'application/json' })
        init.body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body)
      }
      let res
      try {
        res = await fetch(path, init)
      } catch (e) {
        throw new Error(`连不上后端：${e?.message ?? e}`)
      }
      let payload = null
      try { payload = await res.json() } catch (e) { payload = null }
      if (!res.ok || !payload || payload.ok !== true) throw apiError(payload, res.status)
      return payload
    }

    const apiGet = (path) => apiFetch(path, { method: 'GET' })
    const apiPost = (path, body) => apiFetch(path, { method: 'POST', body })
    const apiPatch = (path, body) => apiFetch(path, { method: 'PATCH', body })
    const apiPut = (path, body) => apiFetch(path, { method: 'PUT', body })
    const apiDelete = (path, body) => apiFetch(path, { method: 'DELETE', body })

    /** 把错误变成模态框顶部红条里的一行字 */
    const errorText = (e) => {
      if (!e) return ''
      const msg = String(e.message ?? e)
      return e.hint ? `${msg}｜${e.hint}` : msg
    }

    const whitelistToText = (arr) => (Array.isArray(arr) ? arr.join('\n') : '')
    const textToWhitelist = (text) =>
      String(text ?? '').split('\n').map((s) => s.trim()).filter(Boolean)

    /* ==================================================================
     * 现有：状态条（3s 轮询 /api/mc/status）
     * ================================================================== */

    /** 轮询本会话的 MC 状态；不在游戏里就不渲染 */
    function useMcStatus(sessionId) {
      const [state, setState] = React.useState(null)
      React.useEffect(() => {
        if (!sessionId) return undefined
        let alive = true
        const tick = () => {
          fetch('/api/mc/status?sessionId=' + encodeURIComponent(sessionId), {
            headers: { accept: 'application/json' },
          })
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => { if (alive) setState(j) })
            .catch(() => { if (alive) setState(null) })
        }
        tick()
        const timer = setInterval(tick, 3000)
        return () => { alive = false; clearInterval(timer) }
      }, [sessionId])
      return [state, setState]
    }

    /**
     * 状态条上要显示的**服务器地址**：`host[:port]`（非默认端口才带端口）。
     *
     * 🔴 用户 2026-09-16："状态条是不是只显示'在游戏中'？应该显示服务器地址，太长则截断。"
     *    地址由 `/api/mc/status` 的 `connection` 给（只有 host/port/version，**没有账号**）。
     * 🔴 2026-10-05：不再有 `subserver`（用户只填一个 address）——只显示 host[:port]。
     * @returns {string} 地址；没有就返回空串（此时状态条只显示"在游戏中"）
     */
    function mcAddress(state) {
      const conn = state?.connection ?? null
      const host = String(conn?.host ?? '').trim()
      const port = Number(conn?.port ?? 0) || 0
      if (!host) return ''
      return port && port !== 25565 ? host + ':' + port : host
    }

    function McStatusBar(props) {
      // session scope 的标准 props；兼容 session 对象形态
      const sessionId = props?.sessionId ?? props?.session?.id
      const [state, setState] = useMcStatus(sessionId)
      const [busy, setBusy] = React.useState(false)

      // 只有一个动作：强制停止（用户 2026-09-16："移除停止，只剩强行停止"）。
      // 后端顺序：停 LLM → 优雅退游戏 → 清该会话后台任务 → 再停一次 LLM。
      const stop = React.useCallback(() => {
        if (!sessionId) return
        setBusy(true)
        fetch('/api/mc/stop', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, reason: '用户强制停止' }),
        })
          .catch(() => {})
          .finally(() => { setBusy(false) })
      }, [sessionId])

      // 不在游戏里 → 不占位
      if (!sessionId || !state || state.active !== true) return null

      const online = state.online === true
      const address = mcAddress(state)
      // 太长就截断（完整地址留在 tooltip 里）
      const shown = address.length > 26 ? address.slice(0, 25) + '…' : address
      const timeouts = Number(state.timeouts ?? 0)
      const stale = timeouts > 0
      // 🔴 断线但正在自动重连（2026-09-19）：状态条要**说出**这件事，
      //    不能因为 online=false 就整个消失（用户会以为插件把状态忘了、AI 也以为还在游戏里）。
      const reconnecting = !online && state.reconnecting === true
      const label = online ? '在游戏中' : (reconnecting ? '重连中…' : '未上线')
      const tip = online
        ? `${address ? address + '：' : ''}在游戏中${stale ? `（有 ${timeouts} 次操作超时，可能已失步）` : ''}`
        : (reconnecting
          ? `连接断了${address ? '（' + address + '）' : ''}，插件正在自动重连…`
          : (address ? `已连接 ${address} 但角色不在线` : '已连接但角色不在线'))

      return React.createElement(
        'div',
        {
          'data-mc-status': '',
          ...(busy ? { 'data-mc-busy': '' } : {}),
          ...(reconnecting ? { 'data-mc-reconnecting': '' } : {}),
          title: tip,
        },
        React.createElement('span', { 'data-mc-dot': '', ...(online && !stale ? {} : { 'data-mc-warn': '' }) }),
        React.createElement('span', { 'data-mc-text': '' }, label),
        address ? React.createElement('span', { 'data-mc-sub': '', title: address }, shown) : null,
        React.createElement('button', {
          type: 'button', 'data-mc-btn': '', 'data-mc-danger': '',
          title: '强制停止：中断当前生成并让机器人退出游戏',
          onClick: () => stop(),
        }, '强制停止'),
      )
    }

    /* ==================================================================
     * 标题条上的「MC设置」按钮 + 模态框（同一个插槽条目）
     * ----------------------------------------------------------------
     * order 45 → 排在状态条（50）左边；官方预设标签是 -10，所以最终是
     *   预设标签 → MC设置 → 状态条
     * 按钮和模态框装在**同一个条目**里：列表插槽的每个条目各有一层
     * `display:contents` 包裹 + 错误边界（见 ui-renderer/scoped-slots.tsx），
     * 单独拿一个条目去渲染全屏遮罩会平白多一层无意义包裹；组件返回
     * Fragment（按钮 + 关闭时为 null 的遮罩），关闭状态下 DOM 里只剩按钮。
     *
     * 🔴 **判据必须是本地就有的**：读会话记录的 agent preset
     *    （`props.useSessions` 快照里的 `projectionValues.agentPreset`）——
     *    这正是标题条那个官方「MC模式」标签用的**同一个源**，所以"用户看到什么模式，
     *    按钮就按什么模式显示"，且**不受任何网络请求成败影响**。
     *
     * 🔴 2026-09-16 事故（别再犯）：第一版改成 `fetch('/api/mc/mode')` 问服务端。
     *    浏览器在**新接口上线之前**就通过 HMR 拿到了新客户端 → 那次请求 404 →
     *    组件把它当成"不是 MC 模式"，而且**只问一次、再不重试** ⇒ 重启之后
     *    MC 模式里也永远没有按钮（非得刷新页面）。**门控不许依赖一次性网络请求。**
     *
     * 名单（哪些 preset 算 MC 模式，含 MC+）取服务端 **`/api/mc/presets`**（专门给门控用的极小接口，
     * 不需要 sessionId / 工作区 —— `/api/mc/config` 现在要工作区，用它会被拒而静默退回兜底名单）；
     * 没回来之前先用插件默认值 `['minecraft','minecraft-plus','whale_craft']`（与后端默认一致）。
     * 服务端 `/api/mc/mode` 仍保留，供排查与测试用，前端不再依赖它。
     * ================================================================== */
    const MC_PRESETS_FALLBACK = ['minecraft', 'minecraft-plus', 'whale_craft']
    let mcPresetIds = MC_PRESETS_FALLBACK.slice()
    let mcPresetIdsAsked = false

    function loadMcPresetIds() {
      if (mcPresetIdsAsked) return
      mcPresetIdsAsked = true
      try {
        fetch('/api/mc/presets', { headers: { accept: 'application/json' } })
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => {
            const list = Array.isArray(j?.mcModePresets) ? j.mcModePresets.map(String).filter(Boolean) : []
            if (list.length) mcPresetIds = list
            else mcPresetIdsAsked = false
          })
          .catch(() => { mcPresetIdsAsked = false })   // 失败允许下次挂载再试
      } catch { mcPresetIdsAsked = false }
    }

    /**
     * 「MC设置」入口的**共用门控**。
     *
     * 判据完全本地：会话记录的 agent preset（`props.useSessions` 快照里的
     * `projectionValues.agentPreset`）——这正是标题条那个官方「MC模式」标签用的**同一个源**，
     * 所以"用户看到什么模式，入口就按什么模式出现"，且不受网络请求成败影响。
     *
     * @param props 插槽 props（宿主会给 session scope 注入 `sessionId` / `useSessions`）
     * @param wantBlank true = 只认**新会话页**（会话还是 blank），false = 只认已有会话
     * @returns 是否渲染入口
     */
    function useMcSettingsGate(props, wantBlank) {
      const sessionId = props?.sessionId ?? props?.session?.id
      const useSessions = props?.useSessions
      const [serverMode, setServerMode] = React.useState(null)

      React.useEffect(() => { loadMcPresetIds() }, [])

      // ⚠️ useSessions 是宿主注入的标准 prop（官方标签也用它），组件生命周期内恒定存在，
      //    所以这两个条件调用不会改变 hook 数量。选择器只返回**原始值**，避免每次渲染造新对象。
      const sess = typeof useSessions === 'function' ? useSessions : null
      const blank = sess
        ? sess((state) => {
          const s = state?.byId?.[sessionId]
          return s === undefined ? undefined : s.blank === true
        })
        : undefined
      const preset = sess
        ? sess((state) => {
          const value = state?.byId?.[sessionId]?.projectionValues?.agentPreset
          return typeof value === 'string' ? value : undefined
        })
        : undefined

      const known = blank !== undefined && preset !== undefined

      // 兜底：**只有本地判不了**（拿不到会话数据）时，且只让标题条那个入口去问服务端，
      // 而且**必须重试**——一次性请求失败 = 入口永久消失，这个坑 2026-09-16 刚踩过。
      const needServer = !known && !wantBlank
      React.useEffect(() => {
        if (!needServer || !sessionId) return undefined
        let alive = true
        let tries = 0
        let timer = null
        const tick = () => {
          fetch('/api/mc/mode?sessionId=' + encodeURIComponent(sessionId), {
            headers: { accept: 'application/json' },
          })
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => {
              if (!alive) return
              if (j?.mcMode === true) setServerMode(true)
              else if (++tries < 20) timer = setTimeout(tick, 3000)
            })
            .catch(() => { if (alive && ++tries < 20) timer = setTimeout(tick, 3000) })
        }
        tick()
        return () => { alive = false; if (timer) clearTimeout(timer) }
      }, [needServer, sessionId])

      const localShow = known && blank === wantBlank && mcPresetIds.includes(preset)

      /**
       * 🔴 2026-09-16 用户："没有选中工作区，则拒绝发起 MC 模式会话和设置。"
       *    当时的做法是"服务端说没工作区 ⇒ **本地 preset 再像 MC 模式也不显示入口**"。
       *
       * 🔴 2026-09-18 用户改口径：**有没有选工作区，只要选中了 MC 模式就显示按钮**，
       *    工作区改到**点按钮那一刻**再检查（没有就提示先选）—— 两个入口**统一**这么办：
       *      · 新对话页 hero 那个入口（`wantBlank`）；
       *      · 已有会话标题条那个入口。
       *    这样也顺手去掉了一条"服务端说不显示就不显示"的网络依赖（曾经让入口永久消失过）。
       *    服务端"没工作区就不套白名单/不注入/不建记忆目录"的行为没变，变的只是入口可见性。
       */
      if (localShow) return true
      if (known) return false
      return !wantBlank && serverMode === true
    }

    /* ==================================================================
     * 「MC设置」的**工作区检查**（2026-09-18 用户要求）
     * ----------------------------------------------------------------
     * 口径变了：**入口一律显示**（只要选中 MC 模式），**点了才检查工作区**。
     * 没选工作区 → 原生提示"先去选一个工作区"（不用自定义模态框：这件事一句话就说完）。
     * 判定取两处，互相兜底：
     *   · **本地**：`useWorkspaceCwd` 读会话的 `cwd`（新对话页工作区一选就落进 projection）；
     *   · **服务端**：`/api/mc/mode` 的 `hasWorkspace`（本地还没落盘时的权威值）。
     * 用三态：`true` 有 · `false` 明确没有 · `null` 还不知道（**拿不准就不拦**，让服务端去拒绝，
     * 免得"一次请求失败 = 用不了设置"这类老坑重演）。
     * ================================================================== */
    function useMcWorkspaceReady(props, active) {
      const sessionId = props?.sessionId ?? props?.session?.id
      const localCwd = useWorkspaceCwd(props)
      const [serverHas, setServerHas] = React.useState(null)
      React.useEffect(() => {
        if (!active || !sessionId) return undefined
        let alive = true
        fetch('/api/mc/mode?sessionId=' + encodeURIComponent(sessionId), { headers: { accept: 'application/json' } })
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => { if (alive && typeof j?.hasWorkspace === 'boolean') setServerHas(j.hasWorkspace) })
          .catch(() => { /* 拿不到就不下结论（返回 null ⇒ 不拦） */ })
        return () => { alive = false }
      }, [active, sessionId])
      if (typeof localCwd === 'string' && localCwd) return true
      return serverHas
    }

    /** 没选工作区时的提示（**优先原生**：用户要求） */
    const NO_WORKSPACE_TIP = '请先在这个对话里选择一个工作区，再打开「MC设置」。\n\n'
      + 'MC 模式的记忆与提示词都放在工作区的 .whale-craft 目录里，没有工作区就没有地方放。'

    /**
     * 当前会话（或新对话页那个 blank 会话）**选中的工作区**。
     * 🔴 2026-09-16：新对话页还没开聊时，会话在服务端可能还没落盘 ——
     *    但**工作区是已经选好了的**，所以把它一起报给服务端（`cwd` 兜底参数），
     *    免得"明明选了工作区却被拒绝"。服务端只认绝对路径且必须真实存在的目录。
     */
    function useWorkspaceCwd(props) {
      const sessionId = props?.sessionId ?? props?.session?.id
      const useSessions = props?.useSessions
      const sess = typeof useSessions === 'function' ? useSessions : null
      return sess && sessionId
        ? sess((state) => {
          const v = state?.byId?.[sessionId]?.cwd
          return typeof v === 'string' && v ? v : undefined
        })
        : undefined
    }

    /**
     * 标题条上的「MC设置」按钮（order 45，落在状态条左边）。
     * 只在**已有会话**里出现；新会话页那个是下面 `McSettingsDockEntry`。
     *
     * 按钮和模态框装在**同一个条目**里：列表插槽的每个条目各有一层
     * `display:contents` 包裹 + 错误边界（见 ui-renderer/scoped-slots.tsx），
     * 单独拿一个条目去渲染全屏遮罩会平白多一层无意义包裹。
     *
     * 🔴 两个入口靠 `blank` **互斥**，所以任何时刻只挂一个模态框。
     *    （模态框之间靠 `settingsBus` 广播打开——两个同时挂着会一起弹出来。）
     * ================================================================== */
    function McSettingsEntry(props) {
      const show = useMcSettingsGate(props, false)
      const wsCwd = useWorkspaceCwd(props)
      if (!show) return null

      return React.createElement(
        React.Fragment,
        null,
        React.createElement('button', {
          type: 'button',
          'data-wc-btn': '',
          'data-wc-icon': '',
          'data-wc-mc-settings': '',
          title: 'MC设置：账户、提示词与指令白名单',
          'aria-label': 'MC设置',
          onClick: openSettings,
        }, IconSettingsOutlineRegular ? React.createElement(IconSettingsOutlineRegular, { size: 16 }) : 'MC设置'),
        React.createElement(McSettingsModal, { ...props, wsCwd }),
      )
    }

    /* ==================================================================
     * 「连接到MC」入口①：**标题条**按钮（order 40，落在「设置」左边）
     * ----------------------------------------------------------------
     * 门控与「设置」一致（MC 模式，本地 preset 判定）；**在游戏中时隐藏**。
     * 按钮 = 运行图标 + 文字「连接到MC」。受控打开 `McConnectModal`。
     * ================================================================== */
    function McConnectEntry(props) {
      const sid = props?.sessionId ?? props?.session?.id ?? null
      const show = useMcSettingsGate(props, false)
      // 只在"要显示"时才轮询状态（非 MC 会话别白轮询）
      const [st] = useMcStatus(show ? sid : null)
      const [open, setOpen] = React.useState(false)
      if (!show) return null
      if (st?.active === true) return null          // 在游戏中 → 隐藏
      return React.createElement(
        React.Fragment,
        null,
        React.createElement('button', {
          type: 'button',
          'data-wc-btn': '',
          title: '连接到MC：填地址或选局域网服务器',
          onClick: () => setOpen(true),
        },
        React.createElement(RunIcon, { size: 15 }),
        '连接到MC'),
        React.createElement(McConnectModal, { open, onClose: () => setOpen(false), sessionId: sid, asUser: false }),
      )
    }

    /**
     * 「连接到MC」的 React 宿主：给 hero 的纯 DOM 按钮用（订阅 connectBus）。
     * 🔴 **新对话页**：提示词注入在新会话里不灵 → 改走"**模拟玩家发言**"（`asUser: true`，
     *    正文前加 `[system] `）；对话中（标题条那个）仍走插件提示行。
     */
    function McConnectHost(props) {
      const [open, setOpen] = React.useState(false)
      React.useEffect(() => connectBus.subscribe(() => setOpen(true)), [])
      const sessionId = props?.sessionId ?? props?.session?.id ?? null
      return React.createElement(McConnectModal, { open, onClose: () => setOpen(false), sessionId, asUser: true })
    }

    /* ==================================================================
     * 「MC设置」入口③：**插件页 → whale_craft 详情页**头部的按钮（2026-10-04，演示）
     * ----------------------------------------------------------------
     * 插件管理页的 `plugins.detail.actions` 插槽是 **root 作用域**（无会话、无工作区），
     * 所以这里**只渲染一个按钮**、不挂模态框（现有模态框依赖 sessionId / 工作区）。
     * 自过滤：只认 whale_craft 自己的 bundle 页（`subject.kind==='bundle'` 且包名匹配）；
     * 别的 bundle / row / item 一律返回 null（官方约定：对无关 subject 返回 null）。
     * ⚠️ 当前点击是**空操作** —— 只演示入口位置，后端解耦与面板接入待后续。
     * ================================================================== */
    const DETAIL_BUNDLE_NAME = 'whale_craft'
    /**
     * 「设置」入口③：**插件页 → whale_craft 详情页**头部的按钮（2026-10-04）。
     * 这个插槽是 **root 作用域**（无会话、无工作区），所以它打开的模态框天然走"无工作区"模式：
     * 全局项（账户 / 白名单 / 分享模式）照常，工作区项隐藏或只读。
     * 自过滤：只认 whale_craft 自己的 bundle 页（`subject.kind==='bundle'` 且包名匹配）；
     * 别的 bundle / row / item 一律返回 null（官方约定：对无关 subject 返回 null）。
     * ⚠️ `useState` 必须在早返回**之前**调用（hooks 规则）。
     */
    function McSettingsDetailEntry(props) {
      const subject = props?.subject
      const [open, setOpen] = React.useState(false)
      if (subject?.kind !== 'bundle' || subject?.pkg?.name !== DETAIL_BUNDLE_NAME) return null
      return React.createElement(
        React.Fragment,
        null,
        React.createElement('button', {
          type: 'button',
          'data-wc-btn': '',
          'data-wc-mc-settings-detail': '',
          title: '设置：账户、提示词与指令白名单',
          onClick: () => setOpen(true),
        },
          // 图标与原生「卸载」按钮同款（同为 DSH 图标集的 13px Regular；见文件头图标约定）
          IconSettingsOutlineRegular ? React.createElement(IconSettingsOutlineRegular, { size: 13 }) : null,
          '设置',
        ),
        // 受控打开：这个入口无 sessionId / 工作区（root 作用域）→ 模态框走"无工作区"模式
        React.createElement(McSettingsModal, { open, onClose: () => setOpen(false) }),
      )
    }

    /* ==================================================================
     * 「MC设置」入口②：**新会话页**，贴在**模式选择芯片的正右边**
     * ----------------------------------------------------------------
     * 为什么这里必须碰 DOM：新会话页那一行是宿主**写死的**标记
     * （`ConversationRoot.tsx` 的 `heroWorkspaceRow` = 官方 WorkspaceChip + 两个
     * **single/root** 插槽 `conversation.hero.workspace` / `.agentPreset`），
     * **没有任何 list 插槽**能塞进那一行；注册 single 槽会把官方模式芯片顶掉。
     * 所以只剩一条路：把按钮插到宿主给模式芯片的壳 `[data-slot="conversation.hero.agentPreset"]` 后面
     * （那个壳是宿主自己承诺的稳定锚点：`ui-renderer/.../scoped-slots.tsx` 里
     *   "every slot render site exposes a stable `[data-slot="<key>"]` wrapper"，
     *   且它是 `display:contents`，所以插进去就是那一行 flex 的下一个子项 = 芯片右边）。
     *
     * 🔴 与 2026-09-16 那个"生成时输入框上方冒出全宽长条"的老 bug 的本质区别：
     *    · **锚点只在新会话页存在**——hero 行只在 hero 相位渲染（`{hero && heroWorkspaceRow}`），
     *      普通对话里**根本插不进去**（老代码是从 `[data-composer-card]` 往上找兄弟，找错了行）；
     *    · **门控**：只有"会话 blank + preset ∈ mcModePresets"时这个 React 组件才挂载（见 useMcSettingsGate）；
     *    · **观察范围只在作曲器卡片内**，不是 `document.body`，而且随组件卸载一起消失；
     *    · 组件卸载立刻把按钮摘掉。
     * ================================================================== */
    const HERO_CHIP_ANCHOR = '[data-slot="conversation.hero.agentPreset"]'
    const HERO_BTN_ATTR = 'data-whale-craft-mc-settings'
    const HERO_CONNECT_ATTR = 'data-whale-craft-mc-connect'
    /** hero 行里我们注入的按钮：属性 → 排序（小的靠左）。锚点右边依次是 连接(40) → 设置(45)。 */
    const HERO_BTN_ORDER = { [HERO_CONNECT_ATTR]: 40, [HERO_BTN_ATTR]: 45 }

    /**
     * 把我们的按钮插到 hero 行里模式芯片（锚点）的**右边**，按 {@link HERO_BTN_ORDER} 升序。
     * @param {Array<{attr:string, label:string, title:string, icon?:Function, iconOnly?:boolean,
     *   onClick:()=>void, getDisabled?:()=>boolean, disabledTitle?:string}>} specs
     * @returns `{ dispose, refresh }`：dispose 断开观察者并摘掉按钮；refresh 重算禁用态（不重建 DOM）
     */
    function mountHeroButtons(specs) {
      const entries = specs.map((s) => {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.setAttribute(s.attr, '')
        btn.setAttribute('data-wc-btn', '')
        btn.setAttribute('data-wc-tiny', '')
        if (s.iconOnly) btn.setAttribute('data-wc-icon', '')   // 只有图标 → 收成正方形
        btn.title = s.title
        btn.setAttribute('aria-label', s.label ?? s.title)
        // 纯 DOM 按钮拿不到 React 组件，借 react-dom 的小根把内容渲染进去（图标 + 可选文字）；
        // 渲染不到（理论上不该发生）就退回纯文字，别让按钮变空白。
        let iconRoot = null
        if ((s.icon || s.label) && createRoot) {
          iconRoot = createRoot(btn)
          iconRoot.render(React.createElement(
            React.Fragment, null,
            s.icon ? React.createElement(s.icon, { size: 16 }) : null,
            (s.iconOnly || !s.label) ? null : React.createElement('span', null, s.label),
          ))
        } else {
          btn.textContent = s.label ?? ''
        }
        btn.addEventListener('click', s.onClick)
        // 禁用态：新会话页"只要是 MC/MC+ 就显示"，但**没选工作区时点不动**。
        // 三态由调用方判（`=== false` 才禁用；null = 还不知道，放行）。
        const refresh = () => {
          const off = typeof s.getDisabled === 'function' && s.getDisabled() === true
          btn.disabled = off
          btn.title = off ? (s.disabledTitle ?? s.title) : s.title
        }
        refresh()
        return { btn, attr: s.attr, refresh, iconRoot }
      })
      const ordered = entries.slice().sort((a, b) => (HERO_BTN_ORDER[a.attr] ?? 99) - (HERO_BTN_ORDER[b.attr] ?? 99))
      const refresh = () => { for (const e of entries) e.refresh() }

      /**
       * 幂等放置：按 order 依次**紧贴前一个**地排在锚点后面（每个按钮必须紧跟它的前驱）。
       * 🔴 只认**真 anchor 的直接父元素**作为落点（`HERO_CHIP_ANCHOR`），只用它比对身份。
       *    任何"往上找兄弟行"式的猜测都被 2026-09-16 的事故否掉了 —— 不重蹈。
       */
      const place = () => {
        const anchor = document.querySelector(HERO_CHIP_ANCHOR)
        const row = anchor === null ? null : anchor.parentElement
        if (anchor === null || row === null) return
        let prev = anchor
        for (const e of ordered) {
          if (e.btn.parentElement !== row || e.btn.previousElementSibling !== prev) {
            prev.insertAdjacentElement('afterend', e.btn)
          }
          prev = e.btn
        }
      }

      place()

      /* React 重渲染会把注入的节点冲掉 → 必须补回。观察范围是这里的关键：
       * 🔴 2026-09-18 真机 bug（"新会话 MC 模式没选工作区时没有按钮"）：原来只观察
       *    `[data-composer-card]`，而那个标记挂在**输入框自己**身上（`InputBar.tsx:429`），
       *    hero 行（含我们的锚点）是**它的兄弟**（`ConversationRoot.tsx:347-351`）——
       *    于是 hero 行一重渲染（切模式 / 切工作区正是这种情况），按钮被抹掉而**观察者看不见**，
       *    再也补不回来。症状取决于首帧锚点在不在：工作区已选时首帧就在（所以"看着正常"），
       *    没选工作区时锚点晚出现 ⇒ 一直没按钮。
       *    现在改成观察**两者共同的父容器**（`[data-composer-seat]`，退路是锚点当前所在的父元素），
       *    并且在锚点还没出现时先观察那个容器，等它出现再放。
       */
      let observed = null
      let queued = false
      const watchTarget = () => {
        const anchor = document.querySelector(HERO_CHIP_ANCHOR)
        // ① 锚点已在 DOM 里 → 观察它所在的父容器（hero 行的容器 = composerStack）
        if (anchor?.parentElement) return anchor.parentElement
        // ② 锚点还没出现（新会话页首帧、工作区栏还在变）→ 退到作曲器底座，
        //    它一定存在且包含将来会出现的那一行。
        return document.querySelector('[data-composer-seat]') ?? document.querySelector('[data-composer-card]')
      }
      const track = () => {
        const target = watchTarget()
        if (target === null || target === observed) return
        observer.disconnect()
        observer.observe(target, { childList: true, subtree: true })
        observed = target
      }
      const observer = new MutationObserver(() => {
        if (queued) return
        queued = true
        Promise.resolve().then(() => { queued = false; place(); track(); refresh() })
      })
      track()
      // 首帧锚点可能比本组件晚挂上（React 提交顺序不保证）→ 多补几次；有上限，别常驻空转。
      let tries = 0
      let retry = null
      const tick = () => {
        place()
        track()
        refresh()
        if (document.querySelector(HERO_CHIP_ANCHOR) !== null) return   // 已就位，收工
        if (++tries >= 10) return
        retry = setTimeout(tick, 300)
      }
      retry = setTimeout(tick, 120)

      const dispose = () => {
        if (retry) clearTimeout(retry)
        observer.disconnect()
        for (const e of entries) {
          if (e.iconRoot) e.iconRoot.unmount()
          e.btn.remove()
        }
      }
      return { dispose, refresh }
    }

    /**
     * **新会话页**的「MC设置」驱动组件。
     *
     * 它自己**不渲染任何可见元素**（`return null` / 只挂模态框）：按钮由
     * `mountHeroChipButton` 插到模式芯片右边——也就是用户要的"模式选择右边"。
     * 挂在 `conversation.input.right` 上只是为了拿一个**可靠的挂载时机**
     * （hero 与 composer 都会渲染它；配合 `blank` 门控 ⇒ 只在新会话页挂载）。
     * ⚠️ 它**只**在会话还是 `blank`（还没发过消息）时存在；一旦开聊，入口交给标题条那个。
     */
    function McSettingsDockEntry(props) {
      const show = useMcSettingsGate(props, true)
      const wsCwd = useWorkspaceCwd(props)
      // 🔴 2026-09-18：入口不再因"没工作区"**隐藏**；2026-10-04 改口径：
      //    **只要是 MC/MC+ 就显示**，没选工作区时**禁用**（见下 getDisabled）。
      const wsReady = useMcWorkspaceReady(props, show)
      // 点击回调 / 禁用判定只建一次（DOM 监听不改），所以用 ref 带出"最新"的工作区判定。
      const wsReadyRef = React.useRef(wsReady)
      wsReadyRef.current = wsReady
      const ctlRef = React.useRef(null)

      React.useEffect(() => {
        if (!show) return undefined
        // 兜底：拿不准（null）时按钮没禁用，点到这儿再拦一次。
        const guard = (fn) => () => {
          if (wsReadyRef.current === false) { window.alert(NO_WORKSPACE_TIP); return }
          fn()
        }
        const isOff = () => wsReadyRef.current === false
        // 两个按钮按 order 排在模式芯片右边：连接(40) 在左、设置(45) 在右
        const ctl = mountHeroButtons([
          {
            attr: HERO_CONNECT_ATTR, label: '连接到MC', title: '连接到MC：填地址或选局域网服务器',
            icon: RunIcon, disabledTitle: '请先选择工作区', getDisabled: isOff, onClick: guard(openConnect),
          },
          {
            attr: HERO_BTN_ATTR, label: 'MC设置', title: 'MC设置：账户、提示词与指令白名单',
            icon: IconSettingsOutlineRegular, iconOnly: true, disabledTitle: '请先选择工作区', getDisabled: isOff, onClick: guard(openSettings),
          },
        ])
        ctlRef.current = ctl
        return () => { ctlRef.current = null; ctl.dispose() }
      }, [show])

      // 工作区就绪状态一变就刷新禁用态（不重建 DOM、不重挂按钮）
      React.useEffect(() => { if (ctlRef.current) ctlRef.current.refresh() }, [wsReady, show])

      if (!show) return null
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(McSettingsModal, { ...props, wsCwd }),
        React.createElement(McConnectHost, props),
      )
    }

    /* ==================================================================
     * 历史残留清理（只为清掉老 bundle 留在页面上的按钮）
     * ----------------------------------------------------------------
     * 2026-09-16 那个把按钮插到"输入框上方全宽长条"的旧实现可能还在页面里留了节点
     * （改代码当天 HMR 换过好几版）。这里在 apply 时一次性把 `[data-whale-craft-mc-settings]`
     * 全摘掉；新实现自己会按需把按钮插回**正确的位置**（模式芯片右边）。
     * ================================================================== */
    function purgeLegacyInjectedButtons() {
      try {
        for (const el of document.querySelectorAll('[data-whale-craft-mc-settings],[data-whale-craft-mc-connect]')) el.remove()
      } catch (e) { /* 清理失败无所谓，不影响任何功能 */ }
    }

    /* ==================================================================
     * MC设置模态框（两栏：左标签页 + 右内容区）
     * ================================================================== */

    /** 简写：这一段组件比较多，用 h 比 React.createElement 好读 */
    const h = React.createElement

    /**
     * 「这一项属于本工作区」标记：灰色文件夹图标 + hover 提示。
     * 只挂在**工作区相关**的设置项/标题旁（有工作区时才挂）。
     */
    function WsMark() {
      return h('span', { 'data-wc-wsmark': '', title: '该设置项应用于本工作区' },
        IconFolderOpenRegular ? h(IconFolderOpenRegular, { size: 12 }) : null)
    }

    /** 无工作区时，子页面底部那行居中灰字（带文件夹图标）：告诉用户去哪儿编辑这些设置。 */
    function WsNeedHint() {
      return h('div', { 'data-wc-wsneed': '' },
        IconFolderOpenRegular ? h(IconFolderOpenRegular, { size: 13 }) : null,
        h('span', null, '在对话中打开设置，以编辑工作区详细设置'))
    }

    /**
     * 文件名（用在注入开关的 label 里）。文件不存在时：斜体 + 灰 + 删除线，hover 提示原因。
     * 只是**提示**，不影响开关可用性（开关始终用于改配置）。
     */
    /**
     * 「运行」图标 = DSH 裸三角（`IconTriangleRightFillRegular` 的几何）**描边成空心**
     * （用户 2026-10-04：要**空心三角**，不要带外圈的 play）。靠 `className` 覆盖 path 的 fill。
     */
    function RunIcon(props) {
      if (!IconRunRegular) return null
      return h(IconRunRegular, { size: props?.size ?? 16, className: 'wc-runicon' })
    }

    function FileName(props) {
      const missing = props.missing === true
      return h('span', missing
        ? { 'data-wc-filename': '', 'data-wc-missing': '', title: '目前没有这个文件' }
        : { 'data-wc-filename': '' }, props.name)
    }

    /**
     * 开关。受控：`on` = 当前值，`onToggle(next)` 由调用方决定发不发请求。
     * `disabled` 时按钮真的禁用（例如工作区没有 AGENTS.md 时）。
     * `mark` 为真时在 label 后挂「属于本工作区」标记（见 WsMark）。
     */
    function Switch(props) {
      return React.createElement(
        'div',
        { 'data-wc-switchrow': '' },
        React.createElement(
          'div',
          { 'data-wc-switchmain': '' },
          React.createElement('span', { 'data-wc-switchlabel': '' }, props.label, props.mark ? h(WsMark) : null),
          props.desc ? React.createElement('span', { 'data-wc-switchdesc': '' }, props.desc) : null,
        ),
        React.createElement('button', {
          type: 'button',
          'data-wc-switch': '',
          ...(props.on ? { 'data-wc-on': '' } : {}),
          role: 'switch',
          'aria-checked': props.on ? 'true' : 'false',
          disabled: props.disabled === true,
          // label 可能是节点（带文件名），那种情况不能拿去当 title（否则渲染成 [object Object]）
          title: props.title || (typeof props.label === 'string' ? props.label : undefined),
          onClick: () => { if (!props.disabled) props.onToggle(!props.on) },
        }, React.createElement('span', { 'data-wc-knob': '' })),
      )
    }

    /** 账号类型（气泡文案 + 配色） */
    const ACCT_TYPE = {
      offline: { label: '离线', chip: 'data-wc-chip-offline' },
      yggdrasil: { label: '第三方', chip: 'data-wc-chip-ygg' },
      microsoft: { label: '微软', chip: 'data-wc-chip-ms' },
    }

    /** 类型气泡 */
    function TypeChip(props) {
      const t = ACCT_TYPE[props.type] ?? { label: props.type || '?', chip: 'data-wc-chip' }
      return h('span', { 'data-wc-chip': '', [t.chip]: '' }, t.label)
    }

    /**
     * 账户**横条**：只有「类型气泡 + 名字」+ 右侧两个动作。
     * 细节（UUID / 服务器 / login / innerID）**都不在这里显示** —— 离线点「编辑」进去看。
     * 离线 = 编辑；其余（第三方 / 微软）= 刷新（用户 2026-09-16 定）。
     */
    function AccountRow(props) {
      const { account: acc, busyKey } = props
      const [pendingDelete, setPendingDelete] = React.useState(false)
      const rowBusy = typeof busyKey === 'string' && busyKey.startsWith('row:' + acc.innerID + ':')
      const offline = acc.type === 'offline'
      // 第三方的小灰字 = **「输入的账号（服务器名）」**。
      // 🔴 用户 2026-09-16：主文本是**游戏 ID**（第三方登录成功后回写的档案名），
      //    它跟你输入的账号通常不是一回事（输入的是邮箱，游戏里叫角色名）→ 两个都得看得见。
      //    两者相同时（登录名本身就是角色名）不重复写，只留服务器名。
      //    服务器名没了就退化成 url；都没有就只剩账号。
      const srvLabel = acc.server?.name || acc.server?.url || ''
      const login = String(acc.login ?? '').trim()
      const sub = offline ? '' : (login && login !== acc.name
        ? (srvLabel ? `${login}（${srvLabel}）` : login)
        : srvLabel)

      return h('div', { 'data-wc-acct': '', 'data-wc-account': acc.innerID },
        h(TypeChip, { type: acc.type }),
        h('span', { 'data-wc-acctname': '', title: acc.name }, acc.name || '(无名)'),
        sub ? h('span', { 'data-wc-acctsub': '', title: acc.server?.url || sub }, sub) : null,
        acc.default ? h('span', { 'data-wc-chip': '', 'data-wc-chip-default': '' }, '默认') : null,
        h('span', { 'data-wc-spacer': '' }),
        h('div', { 'data-wc-acctacts': '' },
          offline
            ? h('button', {
              type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', disabled: rowBusy,
              onClick: () => props.onEdit(acc),
            }, '编辑')
            : h('button', {
              type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', disabled: rowBusy,
              title: '刷新登录状态',
              onClick: () => props.onRefresh(acc),
            }, '刷新'),
          pendingDelete
            ? [
              h('button', {
                key: 'yes', type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', 'data-wc-danger': '',
                disabled: rowBusy, onClick: () => props.onDelete(acc),
              }, '确认删除'),
              h('button', {
                key: 'no', type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', disabled: rowBusy,
                onClick: () => setPendingDelete(false),
              }, '取消'),
            ]
            : h('button', {
              key: 'del', type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', 'data-wc-danger': '',
              disabled: rowBusy, onClick: () => setPendingDelete(true),
            }, '删除'),
        ),
      )
    }

    /** 表单里的一行（标签 + 控件） */
    function Field(props) {
      return h('div', { 'data-wc-field': '' },
        props.label ? h('span', { 'data-wc-label': '' }, props.label) : null,
        props.children,
      )
    }

    /** 新建账户第一步：选类型（三种账户 = 三个独立界面） */
    function TypePicker(props) {
      const types = [
        { k: 'new-offline', name: '离线账户', desc: '不需要密码，名字就是身份' },
        { k: 'new-yggdrasil', name: '第三方账户', desc: '皮肤站等外置登录' },
        { k: 'microsoft', name: '微软账户', desc: '未实现', off: true },
      ]
      return h('div', { 'data-wc-pane-page': 'accounts' },
        h('div', { 'data-wc-panehead': '' },
          h('button', { type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', onClick: props.onBack }, '← 返回'),
          h('div', { 'data-wc-h': '' }, '新建账户'),
        ),
        h('div', { 'data-wc-typelist': '' },
          types.map((t) => h('button', {
            key: t.k, type: 'button', 'data-wc-type': '',
            disabled: t.off === true,
            title: t.off === true ? '未实现' : undefined,
            onClick: () => { if (t.off !== true) props.onPick(t.k) },
          },
          h('span', { 'data-wc-typename': '' }, t.name),
          h('span', { 'data-wc-typedesc': '' }, t.desc))),
        ),
      )
    }

    /** 新建 / 编辑**离线**账户（同一个界面，mode 区分；UUID 这类细节在这里看） */
    function OfflineForm(props) {
      const { busyKey, mode = 'new', account } = props
      const editing = mode === 'edit'
      const [name, setName] = React.useState(editing ? (account?.name ?? '') : 'DeepSeek')
      // 只有在"自定义过 UUID"时才把值填出来；派生值不填（填了就等于把它钉成自定义）
      const [uuid, setUuid] = React.useState(editing && account?.uuidSource === 'custom' ? (account.uuid ?? '') : '')
      const [asDefault, setAsDefault] = React.useState(editing ? account?.default === true : false)
      const key = editing ? 'row:' + account.innerID + ':save' : 'new:offline'
      const busy = busyKey === key

      const submit = () => {
        const n = name.trim()
        if (!n) return
        if (editing) {
          props.onPatch(account.innerID, {
            name: n, uuid: uuid.trim() || null, ...(asDefault ? { default: true } : {}),
          }, key).then((ok) => { if (ok) props.onDone() })
        } else {
          props.onCreate({
            type: 'offline', name: n, uuid: uuid.trim() || undefined, default: asDefault,
          }, key).then((ok) => { if (ok) props.onDone() })
        }
      }

      return h('div', { 'data-wc-pane-page': 'accounts' },
        h('div', { 'data-wc-panehead': '' },
          h('button', { type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', onClick: props.onBack }, '← 返回'),
          h('div', { 'data-wc-h': '' }, editing ? '编辑离线账户' : '新建离线账户'),
        ),
        h(Field, { label: '游戏内名字' },
          h('input', {
            'data-wc-in': '', value: name, disabled: busy, autoFocus: true,
            onChange: (e) => setName(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') submit() },
          })),
        h(Field, { label: 'UUID（可留空，留空按名字派生）' },
          h('input', {
            'data-wc-in': '', value: uuid, disabled: busy, spellCheck: false,
            placeholder: editing ? (account?.uuid ?? '') : '',
            onChange: (e) => setUuid(e.target.value),
          })),
        h('div', { 'data-wc-acts': '' },
          h(Switch, { label: '设为默认账户', on: asDefault, onToggle: setAsDefault }),
          h('span', { 'data-wc-spacer': '' }),
          h('button', {
            type: 'button', 'data-wc-btn': '', 'data-wc-primary': '', disabled: busy || !name.trim(),
            onClick: submit,
          }, busy ? '保存中…' : (editing ? '保存' : '创建')),
        ),
      )
    }

    /**
     * 新建**第三方**账户（皮肤站）：**先填认证服务器，再填账号密码**。
     * 服务器那一块上面是**已缓存的**标签：点一下自动填进输入框，× 从缓存里删掉
     * （LittleSkin 也只是预置的缓存项，一样能删）。
     * 输入框下面有一块**看得见的虚线拽托区**：把 authlib-injector 卡片拖进来即可。
     * 手打一个新地址也行——建账户时后端会顺手把它记住。
     *
     * 🔴 2026-09-16 用户纠正：这里要问的是**认证服务器的名字**（缓存标签里显示它，才看得懂），
     *    **不是**"游戏内名字"——角色名是认证服返回的档案名，问用户填毫无意义（登录后被覆盖）。
     */
    function YggdrasilForm(props) {
      const { servers = [], busyKey } = props
      const [picked, setPicked] = React.useState(null)
      const [url, setUrl] = React.useState('')
      const [srvName, setSrvName] = React.useState('')
      const [login, setLogin] = React.useState('')
      const [asDefault, setAsDefault] = React.useState(false)
      const [dragging, setDragging] = React.useState(false)
      // 🔴 密码**不进 state**：非受控 input + ref，提交时读一次就丢；也不进任何 data-*
      const passRef = React.useRef(null)
      const busy = busyKey === 'new:yggdrasil'
      const pickedSrv = picked === null ? null : (servers.find((s) => s.id === picked) ?? null)

      /** 拖入 authlib-injector 卡片：交给后端解析、加进缓存，然后自动选中并填进输入框 */
      const onDropCard = (e) => {
        e.preventDefault()
        setDragging(false)
        const dt = e.dataTransfer
        const card = dt ? (dt.getData('text') || dt.getData('text/plain') || '') : ''
        if (!card.trim()) return
        Promise.resolve(props.onAddCard(card)).then((srv) => {
          if (srv?.url) { setUrl(srv.url); setPicked(srv.id ?? null); setSrvName(srv.name || '') }
        })
      }

      const submit = () => {
        const u = url.trim()
        const p = passRef.current ? passRef.current.value : ''
        if (!u || !login.trim() || !p) return
        const nm = srvName.trim()
        // 账户显示名：先按账号名兜一个（登录/刷新成功后会被档案名覆盖）
        const fallback = login.trim().split('@')[0].replace(/[^\w\u4e00-\u9fa5.]/g, '').slice(0, 32) || 'MC'
        props.onCreate({
          type: 'yggdrasil',
          name: fallback,
          login: login.trim(),
          password: p,
          default: asDefault,
          // 选中的就是缓存里那条 → 用 serverId（改了名字才带上 serverName，让后端改名）
          ...(pickedSrv && pickedSrv.url === u
            ? { serverId: pickedSrv.id, ...(nm && nm !== pickedSrv.name ? { serverName: nm } : {}) }
            : { serverUrl: u, ...(nm ? { serverName: nm } : {}) }),
        }, 'new:yggdrasil').then((ok) => { if (ok) props.onDone() })
      }

      return h('div', { 'data-wc-pane-page': 'accounts' },
        h('div', { 'data-wc-panehead': '' },
          h('button', { type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', onClick: props.onBack }, '← 返回'),
          h('div', { 'data-wc-h': '' }, '新建第三方账户'),
        ),
        h(Field, { label: '认证服务器' },
          servers.length
            ? h('div', { 'data-wc-tags': '' }, servers.map((s) => h('span', {
              key: s.id, 'data-wc-tag': '', ...(pickedSrv?.id === s.id ? { 'data-wc-tag-on': '' } : {}),
            },
            h('button', {
              type: 'button', 'data-wc-tagpick': '', title: s.url || s.name,
              onClick: () => { setPicked(s.id); setUrl(s.url); setSrvName(s.name || '') },
            }, s.name || s.url),
            h('button', {
              type: 'button', 'data-wc-tagx': '', title: '从缓存里删掉',
              disabled: busyKey === 'server:' + s.id,
              onClick: () => props.onRemoveServer(s),
            }, '×'))))
            : null,
          h('input', {
            'data-wc-in': '', value: url, disabled: busy, spellCheck: false,
            placeholder: 'https://example.com/api/yggdrasil',
            onChange: (e) => { setUrl(e.target.value); setPicked(null) },
            onDragOver: (e) => e.preventDefault(),
            onDrop: onDropCard,
          }),
          // 拽托接受区：老版有，别删（用户 2026-09-16 反馈"怎么没了"）
          h('div', {
            'data-wc-drop': '', ...(dragging ? { 'data-wc-drag': '' } : {}),
            onDragOver: (e) => { e.preventDefault(); if (!dragging) setDragging(true) },
            onDragLeave: () => setDragging(false),
            onDrop: onDropCard,
          }, busyKey === 'server:card' ? '正在解析卡片…' : '把 authlib-injector 卡片拖到这里')),
        // 服务器的**名字**紧随服务器那一栏：留空就用域名；填了它，缓存标签里才看得懂
        // （2026-09-16 用户纠正：这里**不是**"游戏内名字"——角色名由认证服返回，不用问用户）
        h(Field, { label: '服务器名字（留空就用域名）' },
          h('input', {
            'data-wc-in': '', value: srvName, disabled: busy, placeholder: '例如：LittleSkin',
            onChange: (e) => setSrvName(e.target.value),
          })),
        h(Field, { label: '账号（邮箱）' },
          h('input', {
            'data-wc-in': '', value: login, disabled: busy, autoComplete: 'off',
            onChange: (e) => setLogin(e.target.value),
          })),
        h(Field, { label: '密码' },
          h('input', {
            'data-wc-in': '', type: 'password', ref: passRef, disabled: busy, autoComplete: 'off',
            onKeyDown: (e) => { if (e.key === 'Enter') submit() },
          })),
        h('div', { 'data-wc-acts': '' },
          h(Switch, { label: '设为默认账户', on: asDefault, onToggle: setAsDefault }),
          h('span', { 'data-wc-spacer': '' }),
          h('button', {
            type: 'button', 'data-wc-btn': '', 'data-wc-primary': '',
            disabled: busy || !url.trim() || !login.trim(),
            onClick: submit,
          }, busy ? '创建中…' : '创建'),
        ),
      )
    }

    /**
     * 页 1：账户。**列表 + 三个独立的新建/编辑界面**：
     *   · 列表 = 横条（类型气泡 + 名字）+ 右侧「编辑/刷新」「删除」；不显示任何细节、不显示 innerID
     *   · 「添加」在右上角 → 先选类型 → 进对应界面
     *   · 离线能进「编辑」（UUID 等细节在那里看）；第三方只有「刷新」
     */
    function AccountsPane(props) {
      const { accounts = [], servers = [], busyKey } = props
      const [view, setView] = React.useState('list')
      const [editing, setEditing] = React.useState(null)
      const back = () => { setEditing(null); setView('list') }

      if (view === 'pick') return h(TypePicker, { onBack: back, onPick: (k) => setView(k) })
      if (view === 'new-offline' || view === 'edit-offline') {
        return h(OfflineForm, {
          mode: view === 'edit-offline' ? 'edit' : 'new', account: editing, busyKey,
          onBack: back, onDone: back, onPatch: props.onPatch, onCreate: props.onCreate,
        })
      }
      if (view === 'new-yggdrasil') {
        return h(YggdrasilForm, {
          servers, busyKey, onBack: back, onDone: back, onCreate: props.onCreate,
          onRemoveServer: props.onRemoveServer, onAddCard: props.onAddCard,
        })
      }

      return h('div', { 'data-wc-pane-page': 'accounts' },
        h('div', { 'data-wc-panehead': '' },
          h('div', { 'data-wc-h': '' }, `账户（${accounts.length}）`),
          h('span', { 'data-wc-spacer': '' }),
          h('button', {
            type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', 'data-wc-primary': '',
            onClick: () => setView('pick'),
          }, '＋ 添加'),
        ),
        accounts.length
          ? accounts.map((a) => h(AccountRow, {
            key: a.innerID, account: a, busyKey,
            onEdit: (acc) => { setEditing(acc); setView('edit-offline') },
            onRefresh: props.onRefresh, onDelete: props.onDelete,
          }))
          : h('div', { 'data-wc-dim': '' }, '还没有账户，点右上角「添加」。'),
      )
    }

    /* ---------------------------------------------------------- 页 2：指令白名单 */

    function WhitelistPane(props) {
      const { wlText, allowAll, busyKey, onWlText, onAllowAll, onSave } = props
      const busy = busyKey !== null
      const saveBusy = busyKey === 'wl:save'
      // 开关**一拨就存**（用户 2026-09-16 定）；下面那份白名单仍然要点「保存」
      const allowBusy = busyKey === 'cfg:allowAll'

      return React.createElement(
        'div',
        { 'data-wc-pane-page': 'whitelist' },
        React.createElement('div', { 'data-wc-sec': '' },
          React.createElement(Switch, {
            label: '允许所有指令',
            disabled: allowBusy,
            on: allowAll === true,
            onToggle: (next) => onAllowAll(next),
          }),
          React.createElement('div', { 'data-wc-h': '' }, '指令白名单（一行一条）'),
          allowAll
            ? React.createElement('div', { 'data-wc-warnnote': '' }, '已允许所有指令，白名单不再生效。')
            : null,
          React.createElement('textarea', {
            'data-wc-textarea': '',
            ...(allowAll ? { 'data-wc-dimmed': '', readOnly: true } : {}),
            value: wlText,
            spellCheck: false,
            disabled: busy && !allowAll,
            placeholder: 'tp\ngive\n/^gi.+/',
            title: allowAll ? '已允许所有指令，白名单暂不生效（关掉上面的开关才能编辑）' : '一行一条',
            onChange: (e) => { if (!allowAll) onWlText(e.target.value) },
          }),
          React.createElement(
            'p',
            { 'data-wc-hint': '' },
            '精确名 ', React.createElement('code', { 'data-wc-code': '' }, 'tp'),
            ' · 正则 ', React.createElement('code', { 'data-wc-code': '' }, '/^gi.+/'),
            ' · ', React.createElement('code', { 'data-wc-code': '' }, '*'),
            ' 全部放行',
          ),
          React.createElement(
            'div',
            { 'data-wc-acts': '' },
            React.createElement('button', {
              type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', 'data-wc-primary': '',
              disabled: busy, onClick: onSave,
            }, saveBusy ? '保存中…' : '保存'),
          ),
        ),
      )
    }

    /* ------------------------------------------------------------ 页 3：提示词 */

    function PromptPane(props) {
      const {
        mdText, wsExists, rulesExists, injectStatus,
        injectWc, injectWs, busyKey, onMdText, onSave, onReset, onInjectWc, onInjectWs,
        followVersion, rulesVersion, pluginVersion, versionPrompt, onFollowVersion, hasWorkspace,
      } = props
      const busy = busyKey !== null
      const [confirmReset, setConfirmReset] = React.useState(false)
      const saveBusy = busyKey === 'md:save'
      const resetBusy = busyKey === 'md:reset'
      const followBusy = busyKey === 'cfg:follow'
      const seg = injectStatus?.segments ?? {}
      const mark = (on) => (on ? '✓' : '✗')

      return React.createElement(
        'div',
        { 'data-wc-pane-page': 'prompt' },
        React.createElement('div', { 'data-wc-sec': '' },
          React.createElement('div', { 'data-wc-h': '' }, '提示词', hasWorkspace ? h(WsMark) : null),
          // 🔴 把"到底会不会注入"直接摆给用户看（2026-09-16：真机上反复出现"没注入"，
          //    原因可能有一堆 —— 不是 MC 模式 / 开关关了 / 文件不在 —— 与其让人猜，不如显示判据）
          injectStatus
            ? React.createElement('div', { 'data-wc-injectstatus': '' },
              `本会话注入：${injectStatus.mcPlus ? 'MC+模式' : 'MC模式'} ${mark(injectStatus.mcMode)} ｜ 本提示词 RULES.md ${mark(seg['agents-md'])} ｜ 工作区 AGENTS.md ${mark(seg['workspace-agents-md'])}`,
              injectStatus.notes?.length
                ? React.createElement('div', { 'data-wc-note': '' }, injectStatus.notes.join(' ｜ '))
                : null,
            )
            : null,
          // 无工作区：正文只读、展示内置默认提示词（服务端回的 text 就是默认那份）
          React.createElement('textarea', {
            'data-wc-textarea': '', 'data-wc-tall': '', value: mdText, spellCheck: false,
            disabled: busy,
            ...(hasWorkspace ? {} : { readOnly: true, 'data-wc-dimmed': '' }),
            onChange: (e) => { if (hasWorkspace) onMdText(e.target.value) },
          }),
          hasWorkspace
            ? React.createElement(
              'div',
              { 'data-wc-acts': '' },
              React.createElement('button', {
                type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', 'data-wc-primary': '',
                disabled: busy, onClick: onSave,
              }, saveBusy ? '保存中…' : '保存'),
              confirmReset
                ? React.createElement('button', {
                  type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', 'data-wc-danger': '', disabled: busy,
                  title: '再点一次确认',
                  onClick: () => { setConfirmReset(false); onReset() },
                }, resetBusy ? '恢复中…' : '确认恢复')
                : React.createElement('button', {
                  type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', 'data-wc-danger': '', disabled: busy,
                  title: '恢复默认提示词',
                  onClick: () => setConfirmReset(true),
                }, '恢复默认'),
              confirmReset
                ? React.createElement('button', {
                  type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', disabled: busy,
                  onClick: () => setConfirmReset(false),
                }, '取消')
                : null,
            )
            : null,
        ),
        React.createElement('div', { 'data-wc-sec': '' },
          React.createElement('div', { 'data-wc-h': '' }, '注入'),
          // 版本硬提示词：随插件版本发布、不可编辑，但用户有权知道它说了什么。
          // 🔴 **无工作区时照样显示**（它跟工作区无关），与前两个开关不同。
          versionPrompt
            ? React.createElement('details', { 'data-wc-verprompt': '' },
              React.createElement('summary', {},
                `本版本内置提示（随插件版本更新，不可编辑）：whale_craft v${versionPrompt.version}`),
              React.createElement('pre', {}, String(versionPrompt.text ?? '')))
            : null,
          // 三个开关只在**有工作区**时出现（它们的值按工作区存）
          hasWorkspace
            ? [
              // 「随版本更新」（默认开）：插件升级时用新版本默认准则替换当前这份（会覆盖你的修改）
              React.createElement(Switch, {
                key: 'follow', label: '随版本更新', mark: true,
                desc: followBusy ? '保存中…' : '插件升级时，用新版本的默认提示词替换当前内容（会覆盖你的修改）',
                disabled: busy,
                on: followVersion === true,
                onToggle: (next) => onFollowVersion(next),
              }),
              // 注入本提示词（`<工作区>/.whale-craft/RULES.md`）：版本行作为它的说明，不再单独一行
              React.createElement(Switch, {
                key: 'wc', mark: true, title: '注入本提示词 RULES.md',
                label: ['注入本提示词 ', h(FileName, { key: 'f', name: 'RULES.md', missing: rulesExists === false })],
                desc: `当前内容对应：${rulesVersion ? `v${rulesVersion}` : '未知（还没同步过）'}　·　本插件：v${pluginVersion || '?'}`,
                on: injectWc === true,
                onToggle: (next) => onInjectWc(next),
              }),
              // 注入工作区 AGENTS.md（`<工作区>/AGENTS.md`）：**不因文件缺失禁用**（开关始终用于改配置）
              React.createElement(Switch, {
                key: 'ws', mark: true, title: '注入工作区 AGENTS.md',
                label: ['注入工作区 ', h(FileName, { key: 'f', name: 'AGENTS.md', missing: wsExists === false })],
                desc: 'MC+模式下将固定注入，不受本设置影响',
                on: injectWs === true,
                onToggle: (next) => onInjectWs(next),
              }),
            ]
            : null,
        ),
        !hasWorkspace ? h(WsNeedHint) : null,
      )
    }

    /* ------------------------------------------------------------ 页 4：文件分享 */

    /** 桌面模式托管端口的默认值（须与 src/express.mjs `DEFAULT_EXPRESS_PORT` 一致） */
    const EXPRESS_DEFAULT_PORT = 16049

    /**
     * 「文件分享」页（用户 2026-09-17 定；2026-10-07 按宿主模式拆键）。
     * 视觉上仍是**一个**开关，但它按当前模式绑定到各自的配置键：
     *   · web 模式：开关 + base（回 `base + /api/whale-craft/express/…` 完整 URL）；
     *   · 桌面模式：开关 + **托管端口**（插件自起 localhost 服务，回 `http://localhost:<port>/<uuid>/<rel>`）。
     * 关闭（默认）：AI 只会把**绝对路径**告诉用户。
     */
    function SharePane(props) {
      const {
        on, base, mode, port, share, portStatus, busyKey, hasWorkspace,
        onToggle, onSaveBase, onUseCurrent, onClear, onSavePort, onResetPort, onCheckPort,
      } = props
      const busy = busyKey !== null
      const isDesktop = mode === 'desktop'
      const [baseText, setBaseText] = React.useState(base ?? '')
      const [portText, setPortText] = React.useState(port != null ? String(port) : '')
      const [portLive, setPortLive] = React.useState(null)   // { available, current, reason } | null
      const [confirmClear, setConfirmClear] = React.useState(false)
      React.useEffect(() => { setBaseText(base ?? '') }, [base])
      React.useEffect(() => { setPortText(port != null ? String(port) : '') }, [port])

      // 端口实时自检（防抖 300ms）：只在桌面模式 + 已开启时跑
      React.useEffect(() => {
        if (!isDesktop || !on) { setPortLive(null); return undefined }
        const text = String(portText ?? '').trim()
        const n = /^\d+$/.test(text) ? Number(text) : NaN
        if (!Number.isInteger(n) || n < 1 || n > 65535) {
          setPortLive(text ? { available: false, current: false, reason: 'invalid' } : null)
          return undefined
        }
        let alive = true
        const t = setTimeout(() => {
          Promise.resolve(onCheckPort ? onCheckPort(n) : null)
            .then((r) => { if (alive) setPortLive(r ?? null) })
            .catch(() => { if (alive) setPortLive(null) })
        }, 300)
        return () => { alive = false; clearTimeout(t) }
      }, [isDesktop, on, portText, onCheckPort])

      const baseBusy = busyKey === 'share:base'
      const portBusy = busyKey === 'share:port'
      const clearBusy = busyKey === 'share:clear'
      const dirty = (baseText ?? '') !== (base ?? '')
      const portDirty = String(portText ?? '') !== (port != null ? String(port) : '')
      const portIsDefault = /^\d+$/.test(String(portText).trim()) && Number(portText) === EXPRESS_DEFAULT_PORT

      // 端口错误（红字）：不合法 / 被占用
      const portError = (on && portLive && !portLive.available)
        ? (portLive.reason === 'invalid'
          ? '端口不合法：应为 1–65535 的整数。'
          : `端口 ${String(portText).trim()} 已被占用，请换一个。`)
        : ''
      // 服务端反馈：开关开着，但独立端口没起来（被占用 / 启动失败）
      const serverDown = isDesktop && on && portStatus && portStatus.listening === false
      const serverDownText = serverDown ? `端口服务未运行（${portStatus.portError || '未知原因'}）。` : ''
      const portHint = !on
        ? '开启文件分享后才能设置端口。'
        : (portError || serverDownText || `分享地址：http://localhost:${String(portText).trim() || EXPRESS_DEFAULT_PORT}`)

      return React.createElement(
        'div',
        { 'data-wc-pane-page': 'share' },
        React.createElement('div', { 'data-wc-sec': '' },
          React.createElement('div', { 'data-wc-h': '' }, '文件分享'),
          // 只有"开 / 关"（2026-10-04 用户定：不再有"模式"）——但开关按当前宿主模式绑定各自的配置键
          React.createElement(Switch, {
            label: '启用文件分享',
            desc: on
              ? (isDesktop
                ? '回完整 URL：从本机独立端口直接托管分享文件'
                : '回完整 URL：图片可以直接在对话里显示')
              : '不分享：AI 只会告诉你文件的绝对路径，让你自己打开',
            disabled: busy,
            on: on === true,
            onToggle: (next) => onToggle(next),
          }),
        ),
        // 地址设置只在「开启」时可用：关闭时**禁用**（但保留可见，别让人以为设置消失了）。
        // 桌面模式 = 托管端口；web 模式 = base。
        isDesktop
          ? React.createElement('div', { 'data-wc-sec': '' },
            React.createElement('div', { 'data-wc-h': '' }, '托管端口'),
            React.createElement('div', { 'data-wc-field': '' },
              React.createElement('input', {
                'data-wc-in': '', value: portText, spellCheck: false, disabled: busy || !on,
                inputMode: 'numeric', placeholder: String(EXPRESS_DEFAULT_PORT),
                onChange: (e) => setPortText(e.target.value.replace(/[^\d]/g, '')),
              }),
            ),
            React.createElement('p',
              { ...(on && (portError || serverDownText) ? { 'data-wc-hint': '', 'data-wc-error': '' } : { 'data-wc-hint': '' }) },
              portHint),
            React.createElement('div', { 'data-wc-acts': '' },
              React.createElement('button', {
                type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', 'data-wc-primary': '',
                disabled: busy || !on || !portDirty, onClick: () => onSavePort(String(portText).trim()),
              }, portBusy ? '保存中…' : '保存端口'),
              React.createElement('button', {
                type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '',
                disabled: busy || !on || portIsDefault, title: `恢复默认端口 ${EXPRESS_DEFAULT_PORT}`,
                onClick: onResetPort,
              }, '恢复默认')),
          )
          : React.createElement('div', { 'data-wc-sec': '' },
            React.createElement('div', { 'data-wc-h': '' }, 'base 地址'),
            React.createElement('div', { 'data-wc-field': '' },
              React.createElement('input', {
                'data-wc-in': '', value: baseText, spellCheck: false, disabled: busy || !on,
                placeholder: 'https://example.com（可以带路径前缀）',
                onChange: (e) => setBaseText(e.target.value),
              }),
            ),
            React.createElement('p', { ...(on && !base ? { 'data-wc-hint': '', 'data-wc-dirty': '' } : { 'data-wc-hint': '' }) },
              !on
                ? '开启文件分享后才能设置 base。'
                : (!base ? '还没填 base：AI 暂时只能让你去设置。' : '填你访问这台 DSH 用的地址。')),
            React.createElement('div', { 'data-wc-acts': '' },
              React.createElement('button', {
                type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', 'data-wc-primary': '',
                disabled: busy || !on || !dirty, onClick: () => onSaveBase(baseText.trim()),
              }, baseBusy ? '保存中…' : '保存 base'),
              React.createElement('button', {
                type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '',
                disabled: busy || !on, title: '用你现在访问这个页面的地址填好并保存',
                onClick: onUseCurrent,
              }, '获取当前')),
          ),
        hasWorkspace ? React.createElement('div', { 'data-wc-sec': '' },
          React.createElement('div', { 'data-wc-h': '' }, '分享数据', h(WsMark)),
          React.createElement('p', { 'data-wc-hint': '' },
            share?.dir
              ? `目录：${share.dir}${share.exists ? `　（${share.files} 个文件 / ${fmtBytes(share.bytes)}）` : '　（还没有这个目录）'}`
              : '目录：读取中…'),
          // 清除与分享模式无关：关闭模式下也一样能清（不然关掉分享就没法收拾旧文件）
          React.createElement('div', { 'data-wc-acts': '' },
            confirmClear
              ? [
                React.createElement('button', {
                  key: 'yes', type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', 'data-wc-danger': '',
                  disabled: busy, title: '再点一次确认',
                  onClick: () => { setConfirmClear(false); onClear() },
                }, clearBusy ? '清除中…' : '确认清除'),
                React.createElement('button', {
                  key: 'no', type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', disabled: busy,
                  onClick: () => setConfirmClear(false),
                }, '取消'),
              ]
              : React.createElement('button', {
                type: 'button', 'data-wc-btn': '', 'data-wc-tiny': '', 'data-wc-danger': '',
                disabled: busy,
                title: '删掉上面那个目录里的所有文件',
                onClick: () => setConfirmClear(true),
              }, '清除分享数据')),
          // ⚠️ 这里是 HTML（React 文本节点），不是 markdown —— 别再用 `**` 当粗体（用户指出过一次）
          React.createElement('p', { 'data-wc-hint': '' },
            '「清除分享数据」会把上面那个目录里的文件',
            React.createElement('strong', {}, '全部删掉'),
            '，不可撤销。'),
        ) : null,
        !hasWorkspace ? h(WsNeedHint) : null,
      )
    }

    function fmtBytes (n) {
      const v = Number(n ?? 0)
      if (!Number.isFinite(v) || v <= 0) return '0 B'
      if (v < 1024) return `${v} B`
      if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
      return `${(v / 1024 / 1024).toFixed(1)} MB`
    }

    /* ------------------------------------------------------------ 页 5：调试 */

    /**
     * 「调试」页：目前只有一个「开放助手调试工具」开关（工作区无关、落全局 config.json）——
     * 是否向助手暴露**调试用途的工具**供其调用。
     * 「一拨就存」：同「允许所有指令」那个开关（乐观更新，失败回滚）。
     */
    function DebugPane(props) {
      const { exposeDebugTools, busyKey, onToggle } = props
      const toggleBusy = busyKey === 'cfg:debug'
      return React.createElement(
        'div',
        { 'data-wc-pane-page': 'debug' },
        React.createElement('div', { 'data-wc-sec': '' },
          React.createElement(Switch, {
            label: '开放助手调试工具',
            desc: '允许助手调用调试用途的工具',
            disabled: toggleBusy,
            on: exposeDebugTools === true,
            onToggle: (next) => onToggle(next),
          }),
        ),
      )
    }

    const TABS = [
      { id: 'accounts', label: '账户' },
      { id: 'whitelist', label: '指令白名单' },
      { id: 'prompt', label: '提示词' },
      { id: 'share', label: '文件分享' },
      { id: 'debug', label: '调试' },
    ]

    /* ==================================================================
     * 「连接到MC」模态框（2026-10-04）
     * ----------------------------------------------------------------
     * 受控（`open` / `onClose`）。点「连接」或点局域网行 →
     *   `POST /api/mc/connect`：**插件注入提示词并让该会话跑一轮**（真正的连接由 LLM 去调
     *   `mc_connect`）；本组件**不自己连**。历史只记**手动输入**的地址，局域网直连不记。
     * 「添加/管理」→ 在**本弹窗之上**叠一个受控的设置弹窗（`initialTab='accounts'`）。
     * ================================================================== */
    function McConnectModal(props) {
      const open = props?.open === true
      const sessionId = props?.sessionId ?? null
      const [address, setAddress] = React.useState('')
      const [servers, setServers] = React.useState([])
      const [accts, setAccts] = React.useState([])
      const [accountId, setAccountId] = React.useState('')
      const [acctOpen, setAcctOpen] = React.useState(false)
      const [lan, setLan] = React.useState(null)          // null = 探测中
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [settingsOpen, setSettingsOpen] = React.useState(false)
      const pickRef = React.useRef(null)
      const inputRef = React.useRef(null)

      // 打开时：拉账户 + 历史，并发探测局域网（关闭就丢弃结果）
      React.useEffect(() => {
        if (!open) return undefined
        let alive = true
        setError(''); setLan(null)
        apiGet('/api/mc/accounts').then((a) => {
          if (!alive) return
          const list = Array.isArray(a.accounts) ? a.accounts : []
          setAccts(list)
          setAccountId((cur) => cur || a.defaultAccount || list[0]?.innerID || '')
        }).catch(() => { /* 账户拉不到就不显示账户选择 */ })
        apiGet('/api/mc/servers').then((s) => { if (alive) setServers(Array.isArray(s.servers) ? s.servers : []) }).catch(() => {})
        apiPost('/api/mc/lan', {}).then((r) => { if (alive) setLan(Array.isArray(r.servers) ? r.servers : []) })
          .catch(() => { if (alive) setLan([]) })
        return () => { alive = false }
      }, [open])

      // 账户下拉：点外面 / Esc 关掉
      React.useEffect(() => {
        if (!acctOpen) return undefined
        const onDown = (e) => { if (pickRef.current && !pickRef.current.contains(e.target)) setAcctOpen(false) }
        const onKey = (e) => { if (e.key === 'Escape') setAcctOpen(false) }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
      }, [acctOpen])

      // Esc 关弹窗（叠着设置弹窗时交给设置弹窗自己关）
      React.useEffect(() => {
        if (!open || settingsOpen) return undefined
        const onKey = (e) => { if (e.key === 'Escape') props.onClose?.() }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [open, settingsOpen, props?.onClose])

      // 出错提示：**3s 自动消失**（定时器随 error 变化 / 卸载清掉，别在关窗后到点报错）
      React.useEffect(() => {
        if (!error) return undefined
        const t = setTimeout(() => setError(''), 3000)
        return () => clearTimeout(t)
      }, [error])

      if (!open) return null

      const closeAll = () => { if (typeof props.onClose === 'function') props.onClose() }
      const refreshHistory = () => apiGet('/api/mc/servers')
        .then((s) => setServers(Array.isArray(s.servers) ? s.servers : [])).catch(() => {})
      const connect = (addr, via) => {
        const a = String(addr ?? '').trim()
        if (!a) { setError('请先填服务器地址'); return }
        setBusy(true); setError('')
        apiPost('/api/mc/connect', { sessionId, address: a, accountId, via, asUser: props?.asUser === true })
          .then(() => { if (via !== 'lan') refreshHistory(); closeAll() })
          .catch((e) => setError(errorText(e)))
          .finally(() => setBusy(false))
      }
      const removeServer = (addr) => apiDelete('/api/mc/servers', { address: addr })
        .then((r) => setServers(Array.isArray(r.servers) ? r.servers : []))
        .catch((e) => setError(errorText(e)))
      // 账户显示：`名字（来源）` —— **「（来源）」用灰色**（用户 2026-10-04）
      const acctLabelNode = (a) => h('span', null,
        a.name,
        h('span', { 'data-wc-cn-src': '' }, `（${(ACCT_TYPE[a.type] ?? {}).label ?? a.type}）`))
      const current = accts.find((x) => x.innerID === accountId)
      // 局域网行：满了 / 版本不支持 → 标红；点它**直接连接**（不填输入框、不记历史）
      // 版本支持与否由**后端**（probeLan → src/mcversion.mjs）算好，这里只读 `supported`：
      //   true=支持（绿）／false=不支持（红，快照也走这条）／null=未知（按支持处理）。
      const lanFull = (s) => Boolean(s?.players && s.players.max != null && s.players.online != null && s.players.online >= s.players.max)
      const lanVersionOk = (s) => s?.supported !== false
      const clickLan = (s) => {
        if (!lanVersionOk(s)) { setError(`版本不匹配：这台服务器是 ${s.version}，当前插件还不支持`); return }
        if (lanFull(s)) { setError(`服务器已满：${s.players.online}/${s.players.max}`); return }
        connect(s.address, 'lan')
      }

      return h(React.Fragment, null,
        h('div', {
          'data-wc-cn-overlay': '', role: 'presentation',
          onClick: closeAll,
          onMouseDown: (e) => { if (e.target === e.currentTarget) e.preventDefault() },
        },
        h('div', {
          'data-wc-cn-card': '', role: 'dialog', 'aria-modal': 'true', 'aria-label': '连接到MC',
          onClick: (e) => e.stopPropagation(),
        },
        h('div', { 'data-wc-head': '' },
          h('div', { 'data-wc-titlewrap': '' },
            h('div', { 'data-wc-titleline': '' }, h('span', { 'data-wc-title': '' }, '连接到MC'))),
          h('span', { 'data-wc-grow': '' }),
          h('button', {
            type: 'button', 'data-wc-xbtn': '', title: '关闭（Esc）', 'aria-label': '关闭', onClick: closeAll,
          }, IconCloseOutlineRegular ? h(IconCloseOutlineRegular, { size: 14 }) : '×'),
        ),
        h('div', { 'data-wc-cn-body': '' },
          // 顶部的**浮层错误提示**（落在地址上方的留白里；3s 自灭，见上面的 effect）
          error ? h('div', { 'data-wc-cn-error': '', role: 'alert' }, error) : null,
          // ① 地址行
          h('div', null,
            h('div', { 'data-wc-cn-fieldlabel': '' }, '服务器地址'),
            h('div', { 'data-wc-cn-row': '' },
              h('input', {
                'data-wc-cn-input': '', ref: inputRef, value: address, spellCheck: false, disabled: busy,
                placeholder: 'example.com 或 example.com:25565',
                onChange: (e) => setAddress(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') connect(address, 'manual') },
              }),
              h('button', {
                type: 'button', 'data-wc-cn-actions': '', disabled: busy,
                onClick: () => connect(address, 'manual'),
              }, h(RunIcon, { size: 14 }), '连接')),
          ),
          // ② 历史气泡行：点气泡**填入地址栏**（不直接连），× 移除（别冒泡到气泡）
          servers.length
            ? h('div', { 'data-wc-cn-bubbles': '' }, servers.map((addr) => h('span', {
              key: addr, 'data-wc-cn-bubble': '', role: 'button', tabIndex: 0, title: '点击填入地址',
              onClick: () => { setAddress(addr); inputRef.current?.focus() },
              onKeyDown: (e) => {
                if (e.target !== e.currentTarget) return
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setAddress(addr); inputRef.current?.focus() }
              },
            },
            h('span', null, addr),
            h('button', {
              type: 'button', 'data-wc-cn-bubblex': '', title: '移除这条历史', 'aria-label': '移除',
              onClick: (e) => { e.stopPropagation(); removeServer(addr) },
            }, IconCloseOutlineRegular ? h(IconCloseOutlineRegular, { size: 11 }) : '×'))))
            : null,
          // ③ 探测中 → ④ 局域网行（定高容器，见 CSS：转空/转列表时地址行不跳）
          h('div', { 'data-wc-cn-lanarea': '' },
          lan === null
            ? h('div', { 'data-wc-cn-probe': '' },
              h('div', { 'data-wc-cn-dots': '' },
                h('span', { 'data-wc-cn-dot': '' }), h('span', { 'data-wc-cn-dot': '' }), h('span', { 'data-wc-cn-dot': '' })),
              h('span', null, '正在寻找DSH所在局域网中的服务器'))
            : (lan.length
                ? h('div', { 'data-wc-cn-lans': '' }, lan.map((s) => h('button', {
                  key: s.address, type: 'button', 'data-wc-cn-lan': '', disabled: busy,
                  title: `直接连接 ${s.address}`,
                  onClick: () => clickLan(s),
                },
                h('span', { 'data-wc-cn-chip': '' }, '局域网'),
                h('span', { 'data-wc-cn-addr': '' }, s.address),
                // MOTD（地址右边）：灰色、固定两行、**垂直居中**
                s.motd ? h('span', { 'data-wc-cn-motd': '' }, h('span', { 'data-wc-cn-motdtext': '' }, s.motd)) : null,
                // 版本号（玩家数**左边**）：不支持 → 红
                s.version
                  ? h('span', { 'data-wc-cn-ver': '', ...(lanVersionOk(s) ? {} : { 'data-wc-cn-bad': '' }) }, String(s.version))
                  : null,
                // 在线人数：满了 → 红
                (s.players && s.players.online != null)
                  ? h('span', { 'data-wc-cn-count': '', ...(lanFull(s) ? { 'data-wc-cn-bad': '' } : {}) },
                    `${s.players.online}/${s.players.max ?? '?'}`)
                  : null,
                // 运行图标：**无缝嵌在卡片里**（不是独立按钮）
                h('span', { 'data-wc-cn-run': '' }, h(RunIcon, { size: 16 })))))
                : null)),
        ),
        // ⑤ 配置卡片行：**固定在底部的 footer**（与上方内容之间留白）
        h('div', { 'data-wc-cn-foot': '' },
          h('div', { 'data-wc-cn-config': '' },
            h('div', null,
              h('div', { 'data-wc-cn-fieldlabel': '' }, '账户'),
              h('div', { 'data-wc-cn-pick': '', ref: pickRef },
                h('button', {
                  type: 'button', 'data-wc-cn-pickbtn': '', 'aria-haspopup': 'listbox',
                  'aria-expanded': acctOpen ? 'true' : 'false',
                  onClick: () => setAcctOpen((v) => !v),
                },
                h('span', null, current ? acctLabelNode(current) : '（无账户）'),
                IconChevronDownOutlineRegular ? h(IconChevronDownOutlineRegular, { size: 14 }) : null),
                acctOpen
                  ? h('div', { 'data-wc-cn-menu': '', role: 'listbox' },
                    accts.map((a) => h('button', {
                      key: a.innerID, type: 'button', 'data-wc-cn-item': '', role: 'option',
                      'aria-selected': a.innerID === accountId ? 'true' : 'false',
                      onClick: () => { setAccountId(a.innerID); setAcctOpen(false) },
                    }, acctLabelNode(a))),
                    h('button', {
                      type: 'button', 'data-wc-cn-item': '', 'data-wc-cn-manage': '',
                      onClick: () => { setAcctOpen(false); setSettingsOpen(true) },
                    }, '添加/管理'))
                  : null)),
            // 预留：其余配置插槽
            h('div', { 'data-wc-cn-extras': '' }))),
        )),
      // 叠加在上层的设置弹窗（受控，直接落到「账户」页）——是**兄弟**节点（不嵌在遮罩里，
      // 否则点它会冒泡到连接弹窗的"点遮罩关闭"）
      h(McSettingsModal, {
        open: settingsOpen, initialTab: 'accounts', sessionId, nested: true,
        onClose: () => setSettingsOpen(false),
      }))
    }

    function McSettingsModal(props) {
      // 🔴 提示词是**按会话工作区**的（`.whale-craft/RULES.md`），所以要把会话 id / 工作区 cwd 带上。
      const sessionId = props?.sessionId ?? null
      const wsCwd = props?.wsCwd ?? null
      /**
       * 设置接口统一走 query 带 `sessionId` / `cwd`：服务端拿它定位**工作区**。
       * 两者都没有 = **无工作区模式**（从插件菜单等入口打开）：全局项照常，
       * 工作区项由服务端回 `null`（见 index.js `configView` / `cwdOf`）。
       */
      const withSid = (p) => {
        const q = []
        if (sessionId) q.push('sessionId=' + encodeURIComponent(sessionId))
        if (wsCwd) q.push('cwd=' + encodeURIComponent(wsCwd))
        return q.length ? p + (p.includes('?') ? '&' : '?') + q.join('&') : p
      }
      const agentsMdPath = withSid('/api/mc/agents-md')

      // 开关：**可选受控** —— 会话入口（标题条 / hero）走 settingsBus（非受控）；
      // 插件详情页那个 root 作用域入口自带 open / onClose（受控）。
      const controlled = props?.open !== undefined
      const [internalOpen, setInternalOpen] = React.useState(false)
      const open = controlled ? props.open === true : internalOpen
      // 初始标签页：受控入口可以指定（如「连接到MC」里的「添加/管理」直接落到「账户」）
      const [tab, setTab] = React.useState(props?.initialTab ?? 'accounts')
      // 组件跨开关复用 → 每次"打开"都回到指定标签页（没指定就不动）
      React.useEffect(() => {
        if (open && props?.initialTab) setTab(props.initialTab)
      }, [open, props?.initialTab])
      const [accounts, setAccounts] = React.useState([])
      const [servers, setServers] = React.useState([])
      const [defaultAccount, setDefaultAccount] = React.useState(null)
      const [wlText, setWlText] = React.useState('')
      const [allowAll, setAllowAll] = React.useState(false)
      const [mdText, setMdText] = React.useState('')
      const [mdSource, setMdSource] = React.useState('default')
      const [mdPath, setMdPath] = React.useState('')
      const [injectWc, setInjectWc] = React.useState(true)
      const [injectWs, setInjectWs] = React.useState(false)
      // 「提示词 → 随版本更新」（默认开）：开关与版本记录都**按工作区**存（.whale-craft/config.json）
      const [followVersion, setFollowVersion] = React.useState(true)
      const [rulesVersion, setRulesVersion] = React.useState(null)
      const [pluginVersion, setPluginVersion] = React.useState('')
      // 版本内置提示词（随版本发布、只读）——**无工作区时也要显示**，来自 agents-md 顶层字段
      const [versionPrompt, setVersionPrompt] = React.useState(null)
      // 「文件分享」：宿主模式（web/desktop）+ 当前模式的开关 + base(web) / port(desktop) + 发布区现状
      const [shareMode, setShareMode] = React.useState('web')
      const [shareOn, setShareOn] = React.useState(false)
      const [shareBase, setShareBase] = React.useState('')
      const [sharePort, setSharePort] = React.useState(null)
      const [sharePortStatus, setSharePortStatus] = React.useState(null)   // /api/mc/express 回的 { listening, port, portError }
      const [exposeDebugTools, setExposeDebugTools] = React.useState(false)
      const [shareInfo, setShareInfo] = React.useState(null)
      const [wsPath, setWsPath] = React.useState('')
      const [wsExists, setWsExists] = React.useState(false)
      // 本提示词那个文件（RULES.md）在不在 —— 给名字加"缺失"样式用
      const [rulesExists, setRulesExists] = React.useState(true)
      const [injectStatus, setInjectStatus] = React.useState(null)
      // 有没有工作区（服务端 config 回的权威值）；无则工作区项隐藏/只读
      const [hasWorkspace, setHasWorkspace] = React.useState(Boolean(wsCwd))
      const [workspaceName, setWorkspaceName] = React.useState('')
      const [loading, setLoading] = React.useState(false)
      const [loaded, setLoaded] = React.useState(false)
      const [loadError, setLoadError] = React.useState('')
      const [error, setError] = React.useState('')
      const [saved, setSaved] = React.useState('')
      const [busyKey, setBusyKey] = React.useState(null)

      // 关闭函数（点遮罩 / × / Esc 共用；也供下面的订阅使用）
      const close = React.useCallback(() => {
        setSaved('')          // 关掉时把顶部"已保存"提示也清掉（组件不卸载，别留着）
        if (controlled) { if (typeof props.onClose === 'function') props.onClose() } else { setInternalOpen(false) }
      }, [controlled, props.onClose])
      // 模块级总线订阅：hero 那个 DOM 按钮没有 React 上下文，只能靠它叫醒这里。
      // 受控模式（详情页入口）不开总线，直接由父组件开关。
      // 用 ref 存最新函数，订阅只建一次，避免重复订阅/闭包过期。
      const openRef = React.useRef(null)
      openRef.current = () => { setError(''); setSaved(''); setInternalOpen(true) }
      React.useEffect(() => {
        if (controlled) return undefined
        return settingsBus.subscribe(() => { openRef.current?.() })
      }, [controlled])

      /**
       * 一次读齐三页要的东西：账户 / 配置（白名单+注入开关）/ 提示词。
       * 账户接口是**必需**的（读不到就没法用）；config 与 agents-md 单独容错，
       * 免得一个接口挂了整页空掉。
       */
      const load = React.useCallback(() => {
        setLoading(true)
        setLoadError('')
        return Promise.all([
          apiGet(withSid('/api/mc/accounts')).then((a) => {
            setAccounts(Array.isArray(a.accounts) ? a.accounts : [])
            setServers(Array.isArray(a.authServers) ? a.authServers : [])
            setDefaultAccount(a.defaultAccount ?? null)
          }),
          apiGet(withSid('/api/mc/config')).then((c) => {
            const hasWs = c.hasWorkspace === true
            setHasWorkspace(hasWs)
            setWorkspaceName(String(c.workspaceName ?? ''))
            setWlText(whitelistToText(c.commandWhitelist))
            setAllowAll(c.allowAllCommands === true)
            setInjectWc(c.injectWhaleCraftAgentsMd !== false)
            setInjectWs(c.injectWorkspaceAgentsMd === true)
            // 文件分享按宿主模式各认一套键：web = enabled+base；desktop = enabled+port
            const mode = c.mode === 'desktop' ? 'desktop' : 'web'
            setShareMode(mode)
            setShareOn(mode === 'desktop' ? c.expressDesktopEnabled === true : c.expressWebEnabled === true)
            setShareBase(String(c.expressWebBase ?? ''))
            setSharePort(c.expressDesktopPort ?? null)
            setSharePortStatus({
              listening: c.expressDesktopListening === true,
              port: c.expressDesktopPort ?? null,
              portError: c.expressDesktopError ?? null,
            })
            setExposeDebugTools(c.exposeDebugTools === true)
            // 发布区是**按工作区**的：没有工作区时那个接口直接 400，别去碰它。
            if (!hasWs) { setShareInfo(null); return null }
            return apiGet(withSid('/api/mc/express')).then((s) => {
              setShareInfo(s ?? null)
            }).catch((e) => { setError(errorText(e)) })
          }).catch((e) => { setError(errorText(e)) }),
          apiGet(agentsMdPath).then((m) => {
            setMdText(String(m.text ?? ''))
            setMdSource(m.source === 'custom' ? 'custom' : 'default')
            setMdPath(String(m.path ?? ''))
            setWsPath(String(m.workspacePath ?? ''))
            setWsExists(m.workspaceExists === true)
            setRulesExists(m.rulesExists !== false)
            setVersionPrompt(m.versionPrompt ?? null)
            setInjectStatus(m.injection ?? null)
            setFollowVersion(m.followVersion !== false)
            setRulesVersion(m.rulesVersion ?? null)
            setPluginVersion(String(m.pluginVersion ?? ''))
          }).catch((e) => { setError(errorText(e)) }),
        ])
          .then(() => { setLoaded(true) })
          .catch((e) => { setLoaded(false); setLoadError(errorText(e)) })
          .finally(() => { setLoading(false) })
      }, [agentsMdPath])

      React.useEffect(() => { if (open) load() }, [open, load])

      // Esc 关闭 + 打开时锁住 body 滚动（关闭/卸载都还原）
      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (e) => { if (e.key === 'Escape') close() }
        document.addEventListener('keydown', onKey)
        const prev = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        return () => {
          document.removeEventListener('keydown', onKey)
          document.body.style.overflow = prev
        }
      }, [open, close])

      /**
       * 顶部「已保存」提示：**3 秒后自动消失**。
       * 🔴 定时器必须在 saved 变化 / 组件卸载时清掉 —— 否则清场后 3s 到点还会去 setState。
       * （窗口关闭不卸载本组件，所以 close 里也顺手清一次 saved。）
       */
      React.useEffect(() => {
        if (!saved) return undefined
        const t = setTimeout(() => setSaved(''), 3000)
        return () => clearTimeout(t)
      }, [saved])

      /** 所有动作的统一出口：置忙 → 跑 → 刷新 → 归一化错误 */
      const run = React.useCallback((key, fn, okMsg) => {
        setBusyKey(key)
        setError('')
        setSaved('')
        return Promise.resolve()
          .then(fn)
          .then(() => {
            setSaved(okMsg || '已保存')
            return load().then(() => true)
          })
          .catch((e) => {
            setError(errorText(e))
            // 出错时也刷新——后端可能已经改了一半（例如"设为默认"成功但回读失败）
            return load().then(() => false, () => false)
          })
          .finally(() => { setBusyKey(null) })
      }, [load])

      const patchAccount = React.useCallback((innerID, patch, key) =>
        run(key, () => apiPatch(withSid('/api/mc/accounts'), { innerID, ...patch }), '账户已更新'), [run])

      const refreshAccount = React.useCallback((acc) =>
        run('row:' + acc.innerID + ':refresh',
          () => apiPost(withSid('/api/mc/accounts/refresh'), { innerID: acc.innerID }),
          `「${acc.name}」刷新完成`), [run])

      const deleteAccount = React.useCallback((acc) =>
        run('row:' + acc.innerID + ':delete',
          () => apiDelete(withSid('/api/mc/accounts'), { innerID: acc.innerID }),
          `已删除「${acc.name}」`), [run])

      const createAccount = React.useCallback((body, key) =>
        run(key, () => apiPost(withSid('/api/mc/accounts'), body), '账户已新建'), [run])

      const addServer = React.useCallback((body) =>
        run('server:add', () => apiPost(withSid('/api/mc/authservers'), body), '认证服务器已添加'), [run])

      // 拖放来的卡片：原样把文本交给后端解析（前端不解析、不落任何副本）。
      // ⚠️ 要把**新加的服务器**回传给调用方（「新建第三方账户」拖完要自动选中 + 填进输入框）。
      const addServerCard = React.useCallback(async (card) => {
        let created = null
        await run('server:card',
          () => apiPost(withSid('/api/mc/authservers'), { card }).then((r) => { created = r?.server ?? null; return r }),
          '已从卡片解析并添加认证服务器')
        return created
      }, [run])

      const removeServer = React.useCallback((srv) =>
        run('server:' + srv.id, () => apiDelete(withSid('/api/mc/authservers'), { id: srv.id }), `已移除「${srv.name}」`), [run])

      /* ── 页 2：白名单 ──
       * 「允许所有指令」开关**一拨就存**（用户 2026-09-16 定），失败把开关拨回去；
       * 白名单文本仍由「保存」提交（只发 commandWhitelist）。 */
      const toggleAllowAll = React.useCallback((next) => {
        const prev = allowAll === true
        const want = next === true
        if (want === prev) return Promise.resolve(true)
        setAllowAll(want)                                    // 乐观更新，拨动立刻有反应
        return run('cfg:allowAll', () => apiPatch(withSid('/api/mc/config'), { allowAllCommands: want }),
          want ? '已打开：允许所有指令' : '已关闭：只放行白名单')
          .then((ok) => { if (!ok) setAllowAll(prev); return ok })   // 失败回滚
      }, [run, allowAll])

      const saveWhitelist = React.useCallback(() =>
        run('wl:save', () => apiPatch(withSid('/api/mc/config'), {
          commandWhitelist: textToWhitelist(wlText),
        }), '指令白名单已保存'), [run, wlText])

      /* ── 页 3：提示词：保存 / 恢复默认 / 两个注入开关 ── */
      const saveAgentsMd = React.useCallback(() =>
        run('md:save', () => apiPut('/api/mc/agents-md', { text: mdText, sessionId }), '已保存'), [run, mdText, sessionId])

      const resetAgentsMd = React.useCallback(() =>
        run('md:reset', () => apiDelete('/api/mc/agents-md', { sessionId }), '已恢复默认'), [run, sessionId])

      const toggleInjectWc = React.useCallback((next) =>
        run('cfg:wc', () => apiPatch(withSid('/api/mc/config'), { injectWhaleCraftAgentsMd: next === true }),
          next ? '已开启提示词注入' : '已关闭提示词注入'), [run])

      const toggleInjectWs = React.useCallback((next) =>
        run('cfg:ws', () => apiPatch(withSid('/api/mc/config'), { injectWorkspaceAgentsMd: next === true }),
          next ? '已开启工作区 AGENTS.md 注入' : '已关闭工作区 AGENTS.md 注入'), [run])

      /** 「随版本更新」：一拨就存；**打开时不会立刻覆盖**（只在插件版本变化时才替换） */
      const toggleFollowVersion = React.useCallback((next) => {
        const prev = followVersion
        setFollowVersion(next === true)
        return run('cfg:follow', () => apiPatch(withSid('/api/mc/config'), { rulesFollowVersion: next === true }),
          next ? '已开启：插件升级时用新版本默认提示词替换' : '已关闭：保留你自己改的内容')
          .then((ok) => { if (!ok) setFollowVersion(prev); return ok })
      }, [run, followVersion])

      /* ── 页 4：文件分享（2026-10-07 按宿主模式拆键）──
       * 开关**一拨就存**（同"允许所有指令"：错了回滚）——**视觉上一个开关**，但按 `shareMode` 发对应的
       * `expressWebEnabled` / `expressDesktopEnabled`（从哪种模式进来就认哪种）。
       * web：base 走「保存」按钮 +「获取当前」；desktop：端口走「保存端口」+「恢复默认」+ 防抖占用自检。
       * 🔴 web 模式**开启**而 base 还没设时，自动做一次"获取当前"（不然开启当场没用）；desktop 不自动填。
       * 清除分享数据**必须确认**（不可撤销）。
       * ⚠️ 输入框文本状态在 SharePane 内部（`baseText`/`portText`），这里**不能**去 set：
       *    保存完 `load()` 会刷新，pane 的 useEffect（+ key 变化）会自己同步回输入框。 */
      /** 向服务端要「当前地址」：把浏览器**自己正在用的** origin 一起报上去（最精准）。 */
      const fetchCurrentBase = React.useCallback(() => {
        const here = (typeof location !== 'undefined' && location.origin) ? location.origin : ''
        const q = here ? '&clientOrigin=' + encodeURIComponent(here) : ''
        return apiGet(withSid('/api/mc/express') + q).then((s) => String(s?.currentBase ?? ''))
      }, [withSid])

      const toggleShare = React.useCallback((next) => {
        const prev = shareOn
        if (next === prev) return Promise.resolve(true)
        setShareOn(next)                                             // 乐观更新
        const onKey = shareMode === 'desktop' ? 'expressDesktopEnabled' : 'expressWebEnabled'
        // web 且开启且还没 base → 顺手把当前地址一起保存（desktop 不自动填）
        const autoBase = shareMode !== 'desktop' && next === true && !shareBase
        return run('share:on', () => (autoBase
          ? fetchCurrentBase().then((cur) => apiPatch(withSid('/api/mc/config'),
            cur ? { expressWebEnabled: true, expressWebBase: cur } : { expressWebEnabled: true }))
          : apiPatch(withSid('/api/mc/config'), { [onKey]: next })),
        next
          ? (autoBase ? '文件分享已开启，base 用当前地址填好了' : '文件分享：已开启')
          : '文件分享：已关闭')
          .then((ok) => { if (!ok) setShareOn(prev); return ok })    // 失败回滚
      }, [run, shareOn, shareBase, shareMode, fetchCurrentBase])

      const saveShareBase = React.useCallback((text) =>
        run('share:base', () => apiPatch(withSid('/api/mc/config'), { expressWebBase: String(text ?? '') }),
          'base 已保存'), [run])

      /** 「获取当前」：填进输入框并立即保存（拿不到就明确报错，别存一个空值） */
      const useCurrentBase = React.useCallback(() =>
        run('share:base', () => fetchCurrentBase().then((cur) => {
          if (!cur) throw new Error('拿不到当前地址：请手动填写（例如 http://127.0.0.1:14640）')
          return apiPatch(withSid('/api/mc/config'), { expressWebBase: cur })
        }), '已用当前地址填好'), [run, fetchCurrentBase])

      /* desktop：保存端口 / 恢复默认端口 / 端口占用自检（SharePane 防抖调用）。
       * ⚠️ 服务端会在 PATCH 后立即尝试起服务，`load()` 再拉一次拿到 listening/portError。 */
      const saveSharePort = React.useCallback((text) =>
        run('share:port', () => apiPatch(withSid('/api/mc/config'), { expressDesktopPort: Number(text) }),
          '端口已保存'), [run])

      const resetSharePort = React.useCallback(() =>
        run('share:port', () => apiPatch(withSid('/api/mc/config'), { expressDesktopPort: EXPRESS_DEFAULT_PORT }),
          `已恢复默认端口 ${EXPRESS_DEFAULT_PORT}`), [run])

      const checkSharePort = React.useCallback((port) =>
        apiGet(`/api/mc/express/port?port=${encodeURIComponent(String(port))}`)
          .then((r) => ({ available: r?.available === true, current: r?.current === true, reason: String(r?.reason ?? '') }))
          .catch(() => null), [])

      const clearShare = React.useCallback(() =>
        run('share:clear', () => apiDelete(withSid('/api/mc/express')), '分享数据已清除'), [run])

      /* ── 页 5：调试 ──「开放助手调试工具」开关**一拨就存**（同"允许所有指令"：失败回滚）。 */
      const toggleExposeDebugTools = React.useCallback((next) => {
        const prev = exposeDebugTools === true
        const want = next === true
        if (want === prev) return Promise.resolve(true)
        setExposeDebugTools(want)                            // 乐观更新
        return run('cfg:debug', () => apiPatch(withSid('/api/mc/config'), { exposeDebugTools: want }),
          want ? '已开放助手调试工具' : '已关闭调试工具')
          .then((ok) => { if (!ok) setExposeDebugTools(prev); return ok })   // 失败回滚
      }, [run, exposeDebugTools])

      if (!open) return null

      const busy = busyKey !== null
      const stop = (e) => e.stopPropagation()

      const pane = tab === 'whitelist'
        ? React.createElement(WhitelistPane, {
          wlText, allowAll, busyKey,
          onWlText: setWlText, onAllowAll: toggleAllowAll, onSave: saveWhitelist,
        })
        : (tab === 'prompt'
          ? React.createElement(PromptPane, {
            key: 'prompt:' + mdSource + ':' + wsExists + ':' + (hasWorkspace ? 'ws' : 'nows'),
            mdText, mdSource, mdPath, wsPath, wsExists, rulesExists, injectStatus, injectWc, injectWs, busyKey,
            followVersion, rulesVersion, pluginVersion, versionPrompt, hasWorkspace,
            onMdText: setMdText, onSave: saveAgentsMd, onReset: resetAgentsMd,
            onInjectWc: toggleInjectWc, onInjectWs: toggleInjectWs, onFollowVersion: toggleFollowVersion,
          })
          : (tab === 'share'
            ? React.createElement(SharePane, {
              key: 'share:' + shareMode + ':' + (shareOn ? 'on' : 'off') + ':' + shareBase + ':' + sharePort,
              on: shareOn, base: shareBase, mode: shareMode, port: sharePort, share: shareInfo,
              portStatus: sharePortStatus, busyKey, hasWorkspace,
              onToggle: toggleShare, onSaveBase: saveShareBase, onUseCurrent: useCurrentBase, onClear: clearShare,
              onSavePort: saveSharePort, onResetPort: resetSharePort, onCheckPort: checkSharePort,
            })
            : (tab === 'debug'
              ? React.createElement(DebugPane, {
                exposeDebugTools, busyKey, onToggle: toggleExposeDebugTools,
              })
              : React.createElement(AccountsPane, {
            accounts, servers, defaultAccount, busyKey,
            onPatch: patchAccount, onRefresh: refreshAccount, onDelete: deleteAccount,
            onCreate: createAccount, onAddServer: addServer, onAddCard: addServerCard,
            onRemoveServer: removeServer,
              }))))

      // 头部显示的工作区名（仅"有工作区"时显示）：注册表 title → 回退路径尾段；default-workspace 给中文名
      const wsDisplayName = hasWorkspace
        ? (workspaceName === 'default-workspace'
            ? '默认工作区'
            : workspaceName || (wsCwd ? String(wsCwd).split(/[\\/]/).filter(Boolean).pop() : ''))
        : ''

      return React.createElement(
        'div',
        {
          'data-wc-overlay': '',
          // 叠在「连接到MC」弹窗之上时（「添加/管理」打开）→ 用更高 z-index
          ...(props?.nested ? { 'data-wc-nested': '' } : {}),
          role: 'presentation',
          onClick: close,               // 点遮罩关闭
          onMouseDown: (e) => { if (e.target === e.currentTarget) e.preventDefault() },
        },
        React.createElement(
          'div',
          {
            'data-wc-card': '', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'MC设置',
            onClick: stop,              // 卡片内部点击不关
            ...(busy ? { 'data-wc-busy': '' } : {}),
          },
          React.createElement(
            'div',
            { 'data-wc-head': '' },
            React.createElement(
              'div',
              { 'data-wc-titlewrap': '' },
              React.createElement(
                'div',
                { 'data-wc-titleline': '' },
                React.createElement('span', { 'data-wc-title': '' }, 'MC设置'),
                hasWorkspace
                  ? React.createElement('span', { 'data-wc-wsname': '', title: wsCwd || '' },
                    IconFolderOpenRegular ? React.createElement(IconFolderOpenRegular, { size: 16 }) : null,
                    React.createElement('span', null, wsDisplayName || '工作区'),
                  )
                  : null,
              ),
            ),
            React.createElement('span', { 'data-wc-grow': '' }),
            busy ? React.createElement('span', { 'data-wc-dim': '', style: { fontSize: '11px' } }, '处理中…') : null,
            React.createElement('button', {
              type: 'button', 'data-wc-xbtn': '', title: '关闭（Esc）', 'aria-label': '关闭',
              onClick: close,
            }, IconCloseOutlineRegular ? React.createElement(IconCloseOutlineRegular, { size: 14 }) : '×'),
          ),
          React.createElement(
            'div',
            { 'data-wc-panes': '' },
            React.createElement(
              'div',
              { 'data-wc-side': '', role: 'tablist' },
              TABS.map((t) => React.createElement('button', {
                key: t.id,
                type: 'button',
                'data-wc-tab': '',
                ...(tab === t.id ? { 'data-wc-tab-on': '' } : {}),
                role: 'tab',
                'aria-selected': tab === t.id ? 'true' : 'false',
                onClick: () => { setSaved(''); setTab(t.id) },   // 切标签页 → 顶部提示立刻消失
              }, t.label)),
            ),
            React.createElement(
              'div',
              { 'data-wc-pane': '' },
              error ? React.createElement('div', { 'data-wc-alert': '', role: 'alert' }, error) : null,
              saved ? React.createElement('div', { 'data-wc-ok': '' }, saved) : null,
              loadError ? React.createElement('div', { 'data-wc-alert': '', role: 'alert' }, `读取失败：${loadError}`) : null,
              loading && !loaded
                ? React.createElement('div', { 'data-wc-dim': '' }, '正在读取…')
                : pane,
            ),
          ),
        ),
      )
    }

    /* ==================================================================
     * 「创建MC+分支」：挂在原生「分支」旁边（conversation.chat.assistant-actions 插槽）
     * ----------------------------------------------------------------
     * 只在 **preset ∈ {standard, minecraft}**（标准模式 / MC模式）时出现；点它 = fork 一条分支，
     * 并把**新会话**改成 MC+ 模式。真正干活的是后端 `/api/mc/branch-plus`
     * （DSH 分支会**继承父 preset**、且 `agentPresets.select` 开了 turn 就锁，改模式只能绕锁 —— 见 index.js）。
     * 取的是**本地** preset（`props.useSessions` 快照，与官方模式标签同源），不受网络成败影响。
     * ================================================================== */
    const PLUS_BRANCH_FROM = ['standard', 'minecraft']

    function usePlusBranchGate(props) {
      const sessionId = props?.sessionId ?? props?.session?.id
      const useSessions = props?.useSessions
      const sess = typeof useSessions === 'function' ? useSessions : null
      const preset = sess
        ? sess((state) => {
          const v = state?.byId?.[sessionId]?.projectionValues?.agentPreset
          return typeof v === 'string' ? v : undefined
        })
        : undefined
      return typeof preset === 'string' && PLUS_BRANCH_FROM.includes(preset)
    }

    /**
     * 立方体图标：取自开源图标库 **Lucide** 的 `box`（ISC 许可，见 THIRD_PARTY_NOTICES.md）。
     * 🔴 这是本插件**唯一**一个非 DSH 官方图标 —— 官方图标集里没有立方体。本 bundle 无构建步骤、
     *    不引运行时依赖，所以按约定**内联它的 path 数据**（不改路径；只把 24×24 的 viewBox 配 1.5 描边，
     *    渲染到 16px 时约合官方 1px 观感）。
     */
    const CUBE_PATHS = [
      'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z',
      'm3.3 7 8.7 5 8.7-5',
      'M12 22V12',
    ]
    function CubeIcon({ size = 16 }) {
      return React.createElement('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
      }, CUBE_PATHS.map((d, i) => React.createElement('path', { key: i, d })))
    }

    function McPlusBranchAction(props) {
      const show = usePlusBranchGate(props)
      const [busy, setBusy] = React.useState(false)
      if (!show) return null
      const sessionId = props?.sessionId ?? props?.session?.id
      const label = '创建 MC+ 分支'
      const onClick = () => {
        if (busy || !sessionId) return
        setBusy(true)
        fetch('/api/mc/branch-plus', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ sessionId, messageId: props?.messageId }),
        })
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => {
            if (!j?.ok) {
              // 后端改模式失败会自动回撤刚建的分支；这里把原因告诉用户（别再给个"假 MC+ 分支"）。
              const msg = [j?.error, j?.hint].filter(Boolean).join('\n\n')
              if (msg) window.alert(msg)
              return
            }
            if (!j.sessionId) return
            const uiWorkspace = clientCtx?.get?.('uiWorkspace')
            if (uiWorkspace && typeof uiWorkspace.openSession === 'function') uiWorkspace.openSession(j.sessionId)
          })
          .catch(() => { window.alert('创建 MC+ 分支失败：请求未送达或被中断。') })
          .finally(() => setBusy(false))
      }
      const btn = React.createElement('button', {
        type: 'button',
        'data-wc-plus-branch': '',
        className: 'wc-plus-branch',
        'aria-label': label,
        title: label,
        disabled: busy || undefined,
        onClick,
      }, React.createElement(CubeIcon, { size: 16 }))
      return TooltipPrimitive ? React.createElement(TooltipPrimitive, { label, side: 'bottom' }, btn) : btn
    }

    /* ==================================================================
     * apply
     * ================================================================== */
    return {
      inject: ['slots'],
      apply(ctx) {
        clientCtx = ctx
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'whale_craft')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => { style.remove() }, 'whale_craft: status bar styles')

        // list/session 插槽：增量安全，不覆盖官方 header
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register(
          { name: 'conversation.session.header.actions', id: 'whale_craft-status', order: 50 },
          McStatusBar,
        ))

        // 「连接到MC」入口①：标题条（order 40 → 落在「设置」45 的**左边**）。
        // 门控同「设置」（MC 模式）；**在游戏中时隐藏**（见 McConnectEntry）。
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register(
          { name: 'conversation.session.header.actions', id: 'whale_craft-mc-connect', order: 40 },
          McConnectEntry,
        ))

        // 「MC设置」入口①：标题条（**已有会话**时才出现）。
        // 判据 = 会话记录的 agent preset ∈ mcModePresets（本地判定，见 useMcSettingsGate）。
        // order 45 < 50 → 落在状态条**左边**（官方预设标签 -10 更左）。
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register(
          { name: 'conversation.session.header.actions', id: 'whale_craft-mc-settings', order: 45 },
          McSettingsEntry,
        ))

        // 「MC设置 / 连接到MC」入口②：**新会话页**。注册在这里的组件只当"驱动器"
        // （它自己 return null，按钮由 mountHeroButtons 按 order 插到模式芯片右边）——
        // 借这个插槽拿一个可靠的挂载时机：hero 与 composer 都渲染它，配合 blank 门控
        // 就只在**新会话页**挂载。与入口①按 blank 互斥，所以页面上任何时候只有一套入口。
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register(
          { name: 'conversation.input.right', id: 'whale_craft-mc-settings-hero', order: 20 },
          McSettingsDockEntry,
        ))

        // 「MC设置」入口③：**插件页 → whale_craft 详情页**头部按钮（演示，暂无功能）。
        // root 作用域、无会话 —— 组件自己按 subject 过滤，只认 whale_craft 的 bundle 页。
        ctx.slots.inject('plugins.detail.actions', () => ctx.slots.register(
          { name: 'plugins.detail.actions', id: 'whale_craft-mc-settings-detail', order: 20 },
          McSettingsDetailEntry,
        ))

        // 「创建MC+分支」：挂在原生「分支」旁边的消息操作行（session 作用域）。
        // 门控 = 本地 preset ∈ {standard, minecraft}（见 usePlusBranchGate）。
        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register(
          { name: 'conversation.chat.assistant-actions', id: 'whale_craft-plus-branch', order: 10 },
          McPlusBranchAction,
        ))

        // 只做一次性清理：摘掉历史版本用 MutationObserver 注入的按钮。
        // 🔴 不要再挂 observer / 不要再往宿主 DOM 里插任何东西（见文件头事故记录）。
        purgeLegacyInjectedButtons()
      },
    }
  },
})
