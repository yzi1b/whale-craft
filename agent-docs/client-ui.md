# 浏览器半端（client.js）与 UI 约定

> 面向接手本仓库的 AI agent 与开发者。讲 `client.js` 挂到 DSH Web 前端的**插槽扩展点**、
> **图标约定**，以及"哪些入口属于 root 作用域、哪些属于会话"。
> 快照：whale_craft **0.2.0**（开发中，未发布；含插件详情页「设置」入口、两态设置、「连接到MC」弹窗），2026-10-04。

## 一句话

`client.js` 是**手写 factory bundle**（无构建步骤，`exports["./client"]` 直接指向它；
改完由 `@deepseek-ai/dsh-client-hmr` 热换，**不需要**重启实例，刷新页面即可）。
它做几件事：会话状态条 / 强制停止、**「设置」与「连接到MC」两个模态框**、以及往宿主插槽注册入口。

## 插槽扩展点清单

| 插槽 | kind | 作用域 | 入口 | 何时出现 |
| --- | --- | --- | --- | --- |
| `conversation.session.header.actions` | list | **session** | 状态条 / 强制停止（order 50）、「设置」（order 45）、**「连接到MC」（order 40，在设置左边）** | 进了游戏的会话 |
| `conversation.input.right` | list | **session** | 新会话页 hero 的 **「连接到MC」+「设置」**（**驱动器**，本身 return null，按钮靠 DOM 按 order 插到模式芯片右边） | 新会话页 + MC 模式 |
| `conversation.chat.assistant-actions` | list | **session** | **「创建MC+分支」**（order 10；立方体图标，见下） | 助手轮末消息 + 会话 preset ∈ `{standard, minecraft}` |
| `plugins.detail.actions` | list | **root** | 插件页 → **whale_craft 详情页**头部的「设置」按钮（order 20） | 打开 whale_craft 的 bundle 详情页时 |

- **会话插槽**（前两个）由宿主注入 `sessionId` / `useSessions` / 会话 cwd，能做"按会话/工作区"的判定与请求。
- **root 插槽**（`plugins.detail.actions` 等）**没有会话、没有工作区**。宿主对这些 list 插槽的约定是：
  每个条目都拿到该页的 `subject`（`{kind:'bundle',pkg}` / `{kind:'row',pkg,row}` / `{kind:'item',id}`），
  **对无关的 subject 返回 `null`** 即可（页面按 `order` 排序，条目自绘 chrome）。
  详见 `@deepseek-ai/dsh-client-ui-plugin-manager` README 的 "Detail page extension points"。
- 我们靠 `subject.kind==='bundle' && subject.pkg.name==='whale_craft'` 自过滤，因此按钮**只**出现在
  whale_craft 自己的详情页，不会污染别的插件页。**不要**往 `plugins.item` 注册——那一组卡片会被列在
  「官方」分组下，把我们标成"官方"语义不对；whale_craft 的包卡片本来就在「已安装」里。

## 🔴 图标约定（2026-10-04 用户定）

**所有 UI 图标一律取自 DSH 官方图标集，不要自己画、也不要另引第三方图标库。**

- 图标集随 `@deepseek-ai/dsh-client-ui-primitives` 分发，而该包是宿主 shell 的**平台内置模块**
  （静态模块表里就有它：`react` / `react-dom` / `@deepseek-ai/cordis` / `dsh-client-store` /
  `dsh-client-ui-slots` / `dsh-client-ui-primitives` / `dsh-client-ui-dockkit`）。官方插件（如
  插件管理器）也是直接 `require` 它。**因此我们 `require` 即得"同源同款"，无需在 package.json 声明。**
- 用法：`require('@deepseek-ai/dsh-client-ui-primitives').IconSettingsOutlineRegular`（本文件顶部有
  **兜底 require**：宿主万一没提供就退回无图标，别让整个客户端半端挂掉）。
- **纯 DOM 按钮**（hero 那个靠 `mountHeroChipButton` 注入的）：拿不到 React 组件，所以借
  `require('react-dom/client').createRoot` 把图标渲染进按钮（图标仍是同一套，不另画/不搬路径），
  dispose 时 `unmount()`。React 渲染的按钮（标题条、插件详情页）直接用组件即可。
- 命名规律：`Icon<名字>OutlineRegular` = **1px 描边**（常规）；`…OutlineMedium` = **1.3px**（强调）。
  `size` 是 prop（默认 16）。原生「卸载」按钮用的是 `IconTrashOutlineRegular`（size 13），
  我们的「设置」按钮就用 `IconSettingsOutlineRegular`（size 13）与之对齐。
- 图标集是 DSH **自家设计**（16px 网格、1px 描边），**不是**某个开源图标库 ⇒ "官方同款"只能靠
  这个平台模块；若以后需要它没有的图形，才考虑引第三方开源图标库，并在 `THIRD_PARTY_NOTICES.md` 记一笔。
- **🔴 迄今唯一一处例外**：「创建MC+分支」的**立方体**图标（见下）——官方图标集里没有立方体，
  经用户 2026-10-05 拍板引了开源库 **Lucide** 的 `box`。本 bundle 无构建步骤、不引运行时依赖，
  所以只把该图标的 **path 数据原样内联**（`client.js` 的 `CUBE_PATHS`），**不改路径**；ISC 许可全文记在
  `THIRD_PARTY_NOTICES.md`。除此之外**仍一律用官方图标**。

## 「创建MC+分支」（2026-10-05）

助手轮末的消息操作行（原生「复制」「在新对话中分支」那一排）里，原生分支图标的旁边，多一个
**立方体图标**按钮：只在会话 preset ∈ `{standard, minecraft}`（标准模式 / MC模式）时出现
（判据是**本地** preset，走 `props.useSessions` 快照的 `projectionValues.agentPreset`，与官方模式标签同源）。
点击 = **fork 一条分支 + 把新会话的模式改成 MC+**，然后打开新会话。

- **挂载**：`conversation.chat.assistant-actions` 插槽（list/session，order 10）——它会渲染进原生
  `MessageIconActions` 的 `extraActions` 位（**在原生分支图标左边**）；这是 DSH 提供**唯一**的消息操作扩展点
  （当年想放"分支右边"只能 DOM 注入，用户选了官方插槽、接受位置在左）。
- **后端**：`POST /api/mc/branch-plus {sessionId, messageId}`（见 architecture.md §9）。
- 🔴 **失败自动回撤 + 弹错**：后端改模式后会**复验**（`composedPreset` 必须真是 MC+），不成就把刚建的分支
  **归档收走**并回 `{ok:false, error, hint}`；前端弹 `window.alert(error + hint)`、**不打开**该会话。
  所以用户要么拿到一个真的 MC+ 分支，要么什么也不多出来（源会话不受影响）。
- 🔴 **为什么不能在客户端改模式**：DSH 的分支**继承父 preset**（宿主 fork 内
  `composeAgent(presetForObservation(source))`），而 `agentPresets.select` 一开会话就跑过 turn 就锁
  （`agent-preset/locked`）；分支子会话带着继承历史，正好命中锁。所以改模式只能在**宿主侧**绕过那道锁
  （`recompose` + 追加 `agent-preset/selected`）——细节见 architecture.md §9 与 index.js 的 `forkMcPlusBranch`。

## 设置的两态：「有工作区 / 无工作区」（2026-10-04）

`McSettingsModal` 按**有没有工作区**呈现两套形态，判据是服务端 `/api/mc/config` 回的 `hasWorkspace`
（`wsCwd` 只是兜底初值）：

- **有工作区**（会话标题条 / 新会话页入口）：标题右边加**小间隔 + 文件夹图标 + 灰色工作区名**
  （`IconFolderOpenRegular` + registry 的 `title`；`default-workspace` 显示为「默认工作区」）。
  每个**工作区相关设置项**的标题旁挂 `WsMark`（灰色文件夹图标，hover「该设置项应用于本工作区」）。
- **无工作区**（插件详情页入口，root 作用域）：提示词三开关 / 版本标记 / 发布区**隐藏**，提示词正文
  **只读**且显示内置默认；账户 / 指令白名单**照常可用**。受影响子页面底部居中出现 `WsNeedHint`
  （文件夹图标 +「在对话中打开设置，以编辑工作区详细设置」）。
- **「联网搜索」页**（2026-10-08，标签页排在「调试」**之前**）：**工作区无关**，两态都可用。两组设置：
  ① 「允许联网搜索」开关（`allowWebSearch`，**默认开**）→ MC 模式下是否暴露宿主 `web_search`（**MC+ 不受此开关影响**）；
  ② 「网页抓取」组（布局照「指令白名单」页）：`webFetchEnabled` 开关（**默认关**）；**再下面**是
  「允许所有域名」（`allowAllFetchDomains`，默认关；打开时域名表变灰只读并提示不再生效）；接着是
  **允许抓取的域名表**（textarea「一行一条」+ 保存，写法同「指令白名单」：精确名 / `*.example.com` 通配 / `/正则/` / `*`）；
  最后是「**允许的内容类型**」三个开关（`webFetchAllowHtml` / `webFetchAllowText` / `webFetchAllowImage`，默认都开；
  图片只支持内置四种格式、**没有格式表可配**（说法写在「图片」开关的说明里；用户 2026-10-08 要求删掉那行单独的提示）。
  开关一律**一拨就存**（失败回滚），域名表点「保存」提交。
  ⚠️ CSS 有一条 `[data-wc-acts]+[data-wc-h]{margin-top:18px}`：动作行后面的小标题要留出空隙（用户 2026-10-08 指出"保存按钮和标题太近"）。
- **「调试」页**（2026-10-05）：**工作区无关**，两态都可用；目前只有一个「开放助手调试工具」开关
  （`exposeDebugTools`，默认关，落全局 `config.json`），决定是否向助手暴露调试用途的工具。开关**一拨就存**（同「允许所有指令」，失败回滚）。

请求统一走 `withSid()` 带 `sessionId`/`cwd`；服务端 **`resolveWorkspaceCwd` 可空**（不 400、不建档），
`configView(cwd)` 在无 cwd 时工作区键回 `null`，`agents-md` GET 无 cwd 时只读回 `DEFAULT_AGENTS_MD`。
🔴 无工作区时**绝不能**把 `null` 喂给 `wsCfgValues` / `memoryRootFor`（后者会兜底到全局
`stateDir(/memory)` 目录）。

入口细节：**插件详情页**那个按钮（`plugins.detail.actions`）用**受控** `open`/`onClose` 打开模态框；
会话两入口仍是非受控（`settingsBus`）。**新会话页**按钮只要是 MC/MC+ 就显示，**没选工作区时禁用**
（`mountHeroChipButton` 的 `getDisabled` + `refresh`，不重建 DOM）。详见 [architecture.md](architecture.md)。

提示词页「注入」区的两个文件名（`RULES.md` / `AGENTS.md`）用 `FileName` 渲染：文件不存在时**斜体灰删除线**
+ hover「目前没有这个文件」（`data-wc-missing`），但**不禁用**开关——开关始终用于改配置。

## 「连接到MC」按钮 + 弹窗（2026-10-04）

两个入口（与「设置」**同一套 MC 模式门控**，无工作区时**禁用**）：标题条（order 40）与
新会话页 hero（DOM 注入，按 `HERO_BTN_ORDER` 排在「设置」**左边**）。**标题条那个在游戏中隐藏**
（`useMcStatus(sid).active === true`）。按钮 = **运行图标 + 文字「连接到MC」**；
🔴 运行图标用 **`IconTriangleRightFillRegular` 的几何 + CSS 描边成「空心三角」**（`RunIcon` + `.wc-runicon path{fill:none;stroke:currentColor}`）——
**不要带外圈的 play，也不要实心**。
⚠️ **为什么默认看着特别小**：那个三角在 16×16 viewBox 里只画在中间一小块（约 5.7×8），四周全是透明边
（视觉上"又小、左右间隔又大"）。所以 `RunIcon` 的 CSS 用 `transform-box:fill-box; transform-origin:center;
transform:scale(1.35)` **按图形自身**略微放大（**别放满**，放满反而比设置图标还显大），
再配 `vector-effect:non-scaling-stroke` 让描边不跟着变粗。

弹窗 `McConnectModal`（受控 `open`/`onClose`；hero 走 `connectBus`）。**固定窗口尺寸**
（`width:min(760px,100%); height:min(82vh,600px)`），内容靠上、**配置行做贴底 footer**（中间留白）：
1. 服务器地址输入 + 「连接」按钮（运行图标；两者**等高 34px**——输入框必须 `box-sizing:border-box`）。
2. **历史气泡行**：`overflow-x:auto; flex-wrap:nowrap`（不换行左右滚），气泡可 × 移除。
   **历史是全局的**（`$DSH_HOME/whale_craft/servers.json`），**只记手动点「连接」的地址**，局域网直连不记。
3. **局域网探测**（后端 `probeLan`：多播监听 + 逐个 `statusPing` 拿人数/版本/MOTD）：探测中是
   **方块一行、文案一行**（各占一行、水平居中），方块只动 opacity 的呼吸动画；出结果后**整张卡片就是
   一个按钮**（`<button data-wc-cn-lan>`），运行图标**无缝嵌在卡片里**（`data-wc-cn-run`，不是独立按钮）。
   行内容 =「局域网」chip + 地址 + **MOTD** + **版本号（人数左边）** + 在线人数 + ▶。
   · 🔴 **版本支持判定由后端算**（2026-10-05 接线）：`probeLan` 每行带 `supported`
     （`src/mcversion.mjs` 的 `isVersionSupported`）——前端只读 `s.supported`（client.js `lanVersionOk`）。
     `true`=支持（绿）／`false`=不支持（红，**快照一律 false**）／`null`=未知（按支持处理）。
     范围 = mineflayer `testedVersions` 的上下界，中间版本按数值比；认 `1.x` 与**新 26.x 规则**。
   · **MOTD**（`data-wc-cn-motd`）：地址**右边**、灰色、**固定两行**（`-webkit-line-clamp:2`）；
     后端已 `flattenMotd` 剥颜色码 **并把换行符换成空格**（`.replace(/[\r\n]+/g,' ')`），前端只按宽度折行。
   · **版本号**：在插件支持范围内**绿**、超出**红**（`data-wc-cn-bad`，读后端的 `supported`）；
     · **人数**：未满**绿**、满/超**红**（`data-wc-cn-bad`）。
   · **版本不符或人满**：点它**弹错误框且不发起连接**。版本支持 = 不填输入框、不记历史。
4. 分隔线 + 配置行：**账户下拉**（选项 `名字（来源）`——**「（来源）」是灰的**，`data-wc-cn-src`；
   默认选中默认账户；末尾灰色**「添加/管理」**）+ 预留的「选项」区（`data-wc-cn-extras`）。

**错误提示**：`data-wc-cn-error` **浮在地址上方的留白里**（`position:absolute`，不挤内容），**3s 自动消失**
（定时器随 `error` 变化 / 卸载清掉）。

**「添加/管理」→ 打开「设置」弹窗落到「账户」页**：`McSettingsModal` 加了 `initialTab` prop
（受控打开时生效），并以 `nested: true` 渲染 → 遮罩加 `data-wc-nested`（z-index 1200）**叠在连接弹窗之上**；
**必须是兄弟节点**（不能嵌在连接弹窗的遮罩里，否则点它会冒泡触发"点遮罩关闭"）。

**点击「连接」/ 局域网卡片 → `POST /api/mc/connect`**：**注入 + 让该会话跑一轮**，
真正的连接由 LLM 调 `mc_connect` 完成（见 architecture.md；提示词在 `src/connect-prompt.mjs`，
追加插槽 `CONNECT_PROMPT_APPENDERS`）。**两种投递方式**：
- **对话中**（标题条入口）：插件提示行（`source.kind='plugin:whale_craft'`, notice）。
- **新对话页**（hero 入口，`asUser: true`）：插件提示行在新会话里不灵（实测）⇒ **模拟玩家发言**
  ——`source.kind='user'`，正文前加 **`[system] `**。⚠️ 这是**用户明确要求的**例外。

## 🔴 弹窗约定：右上角关闭按钮（2026-10-04 用户定，其余弹窗照此）

关闭按钮 = **叉图标**（`IconCloseOutlineRegular`），`data-wc-xbtn`：**与标题同色**（`--dsw-alias-label-primary`）、
**无边框、无底色**、hover 变**红**（`--dsw-alias-state-error-primary`）。**不要**再用 `data-wc-btn` 那种带边框的
文字按钮（旧版是 `data-wc-btn data-wc-tiny` + 文本 `×`）。

## 快速验证

```bash
node tools/check-core.mjs     # 覆盖 client.js 的语法/动态加载
npm run dev:web               # 隔离调试实例；改 client.js 只需刷新浏览器
```

> 改 `client.js` 的结构约定（新增插槽入口、换图标库）后，**同步更新本页**。
