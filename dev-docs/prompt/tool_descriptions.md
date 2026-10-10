# 工具说明

## mc_*

### mc_status

当前会话的连接状态：游戏 address、版本、连接状态；在游戏内时附 `mc_context` 的内容。

### mc_lan

- seconds：听多久（默认 3 秒，上限 15）

探测**局域网里的 Minecraft 服务器**（只读：不连接、不进服）。
原理就是**原版那一件事**：谁是"对局域网开放"的，谁就会往多播 `224.0.2.60:4445` 上周期性发
`[MOTD]…[/MOTD][AD]端口[/AD]`（重发周期 1.5 秒）。**只听这个公告**，听到就拿到对方地址+端口+MOTD；
🔴 不扫端口、不发任何探测包（原版客户端也不扫），所以**恒定在 `seconds` 秒内返回**（默认 3，上限 15）。
拿到 host/port 后用 `mc_connect` 进服（版本 / 人数那些进服后自然知道）。
没听到时：确认对方真的开了"对局域网开放"（或服务端开了 `enable-lan-visibility`）；
有些网络（部分 WiFi / VPN / 容器）会挡多播，那种情况原版客户端自己也看不到——请直接问对方地址。

### mc_ping

- address：地址，认 `example.com` / `example.com:25566` / `[::1]:25565`（必填；端口写在 address 里，默认 25565）
- timeoutMs：超时（默认 5000，上限 30000）——超时就是这个工具的硬顶，不会更久

【单地址探测】**已知地址**时，先问一句"你是谁、通不通"——发一次 Minecraft STATUS ping：
拿 **通不通**（能不能拿到状态响应）/ **版本** / **协议号** / **MOTD** / **人数** / **延迟**。
🔴 **不登录、不用账户、不进服**，拿到就断；超时由自己兜（默认 5 秒，上限 30 秒），**不会挂住**。
和 `mc_connect` 的分工：先用 `mc_ping` 确认地址与版本（**推荐**），再 `mc_connect` 真进服；
连不上时它会把原因说成人话（ECONNREFUSED=端口没人听 / ENOTFOUND=域名拼错 / 超时=防火墙或 enable-status=false）。
和 `mc_lan` 的分工：`mc_lan` 是"不知道地址"时听局域网公告；`mc_ping` 是"知道地址"时主动探一次。

### mc_connect

- address：服务器地址（如 example.com / example.com:25566；端口默认 25565）
- account：（可选）用哪个账户：innerID（mc_accounts 里能看到）；不传就用本会话选定的/默认账户

连接到 MC 服务器（**唯一连接入口**）。这里没有账号密码——用哪个账户由「MC设置」里维护的账户决定：
先用 `mc_accounts` 看有哪些账户（或用本工具的 `account` 参数指名 innerID）。
地址只填一个 `address`（host[:port]，端口默认 25565）——版本**自动探测**，不用传。
连接成功后会等区块加载完成，返回 `mc_status` 的内容；连不上或版本不受支持会报错。

### mc_accounts

- action：list（默认）/ search / refresh
- innerID：账户内部 id（list 里能看到，形如 acc-xxxxxxxx）
- query：search 的关键词

【账户】列出 / 搜索 / 刷新 MC 账户。**永远拿不到密码或 token**——只有基本信息。
action：
· list（默认）列出所有账户：innerID / ID / 游戏名 / UUID / 类型（离线或皮肤站）/ 服务器名与地址 / 是否已存凭据
· search  按指令搜（名字、UUID、服务器名、登录账号都行）：给 query
· refresh 刷新某个账户的登录状态（皮肤站会去认证服换新令牌）：innerID 不传就用当前选定/默认的
⚠️ 刷新或登录失败时会带 needUserAction——**这时候要明确告诉用户**：请到「MC设置」里重新登录该账户，或点它的「刷新」按钮（密码只有用户能填，你拿不到）。

### mc_stop

- reason：原因（写进日志）

停止本会话的 Minecraft：**先尝试优雅退出游戏，再清空本会话全部后台任务（看门狗在里面）**。
⚠️ 它**不会中断你自己当前这一轮**（你正跑在这轮里，自我 abort 会表现为 "tool call aborted"）。所以它适合"我不想玩了，下线"——想停掉自己正在跑的动作，直接别再调工具就行。
页面上标题旁只剩一个「强制停止」按钮，它比这个工具更狠：**先停 LLM → 再优雅退游戏 → 再清后台任务 → 最后再停一次 LLM**（那是给人按的）。

### mc_disconnect

- reason：

从 MC 下线（当前会话的机器人退出游戏）。不影响其他会话的机器人。看门狗会自动关闭并提醒你。

### mc_say

- message：要说的话（单行，会被截断到 220 字）

在 MC 公屏说话（游戏里所有玩家能看到）。

### mc_watch

- action：status（默认）/ arm / disarm / log
- reason：disarm 时的原因（会写进日志）

看门狗控制（**唯一**的事件通知通道）。看门狗在**进服时自动挂载、退服时自动卸载**，整局游戏期间持续运行：记录所有事件，命中唤醒条件就在**同一个对话里**提醒你——你空闲时开新一轮；你正在跑时在下一步插话（不打断）。action="status"（默认）看状态与配置；"arm" 手动挂载；"disarm" 关闭；"log" 看最近事件留档。唤醒条件/近距半径/心跳/观察窗口等一律用 mc_config 调（有默认值）。

### mc_config

- patch：要改的配置项（浅合并）；不传=只读
- reset：true=恢复默认配置

读写本会话的 MC 配置（看门狗唤醒条件、近距半径、心跳间隔、观察窗口、叫法等）。不传参数 = 看当前配置 + 默认值。改配置传 patch；嵌套项用点号键，如 {"wakeOn.itemPickup":true,"nearRadius":24,"mentionPatterns":["ds","用户"]}。叫法是**配置不是硬编码**——学到玩家的新称呼就加进 mentionPatterns。

### mc_capabilities

【边界信息】这个插件能做什么、边界在哪：**支持的 MC 版本范围**（testedVersions）、底层 mineflayer 版本、支持的登录方式、工具命名空间、各种上限（序列步数/记忆大小/事件队列）以及当前配置要点。
**进服前不确定版本能不能连时先看它**；确实不支持就如实告诉 Master，别硬试。

### mc_events

- limit：最多取几条（默认 20）
- kind：只看某类：chat / system / damage / lifecycle
- peek：true=只看不消费
- waitSec：先等最多几秒（默认 0=不等，上限 120）。⚠️ 会被看门狗唤醒打断，别长等

读取/消费当前会话的 MC 事件队列（**看门狗记下来的**：聊天、系统消息、受伤、上线/死亡/重连/断线）。默认消费掉；`peek=true` 只看不清。
⚠️ **被传送 / 捡物 / 其他玩家上下线不在这里**（那些只在看门狗的留档里，用 `mc_watch {action:"log"}` 看）。
⚠️ `waitSec` 是**兜底**，别用它长时间空等：有人叫你（mention）/ 受击 / 死亡 / 断线时，**看门狗会主动叫醒你**，而且**会打断这个等待**（返回里 `interrupted:true` 就是在告诉你"有人找你了，唤醒内容马上会作为提示注入进来"）。真需要盯着某一类事件时才给 waitSec（建议 ≤30）。

### mc_context

- survival：true = 强制返回 survival 段（默认按游戏模式决定：生存/冒险给，其余不给）

获取游戏上下文：游戏模式、所在维度、坐标、朝向。survival 段（生命值/伤害吸收/饱食度/饱和度/气泡值/装备/经验等级与经验值、所有 buff 及等级与时长、坐骑/骑乘者）在生存/冒险模式默认返回；`survival:true` 可强制返回。

### mc_players

获取在线玩家的 tab 栏名、档案名、uuid（包括自己）。

### mc_scan

- radius：水平半径（默认 8，上限 24）
- height：垂直范围 ±（默认 4，上限 16）
- name：可选：只找这种方块（如 oak_log）
- limit：name 模式下最多返回几个（默认 10）

扫描我周围方块：给 name 就找这种方块的位置；不给就返回方块统计。

### mc_map

- radius：半径（默认 32，上限 96）
- glyphStep：字符图抽稀步长（默认 2；1 最细）
- yTop：地表搜索起始高度偏移（默认 +10）
- yBottom：向下搜索深度（默认 -24）
- format：chars（默认）/ image
- scale：图像每格放大倍数（默认 4，1–16）
- reply：true（默认）= 结果回复到上下文；false = 只写文件、回一行 stub
- dist：输出文件路径（可空）；绝对路径或相对工作区根。chars→.txt、image→.png

看周围地形。format="chars"（默认）返回**字符地形图**（无视觉也能读：@ 是我 · ~ 水 · . 沙 · " 草木 · T 木构 · : 石/建筑 · _ 土/农田 · # 白 · ? 未加载）；format="image" 生成**真彩俯视图**（模型有视觉时直接能看）。`reply`（默认 true）= 结果是否回复到上下文；`dist` = 结果写到的文件路径（可空，写文件与 reply 互不影响）。路径：绝对照用，相对以**工作区根**为基准。字符图存 .txt、图像存 .png。网格方向**上北下南 · 左西右东**。要让 **Master** 看到图：先 dist 写到发布区（`.whale-craft/undefined/<子目录>/x.png`），再用 `mc_kit_express` 取链接。

### mc_height

- radius：半径（默认 32，上限 96）
- glyphStep：抽样步长（默认 2）
- startY：起始 Y（留空 = 当前所在 Y）
- ignoreLiquid：true = 把液体视为无方块（水面/岩浆下的地面才算地表）
- format：chars（默认）/ image / full
- scale：图像放大倍数（默认 4，1–16，仅 image）
- reply：true（默认）= 结果回复到上下文；false = 只写文件、回一行 stub
- dist：输出文件路径（可空）；绝对路径或相对工作区根。chars→.txt、image→.png、full→.csv

获取高度（地势）图：每列取一个"地表 Y"——`startY` 处无方块则向下找第一个方块取 Y，有方块则向上找第一个空格取 Y−1。`startY` 留空 = 当前所在 Y。按 `glyphStep` 抽样（省算力）；`ignoreLiquid:true` 把液体当空气。format="chars"（默认）用字符模拟（低→高）；"image" 分层设色等高图；"full" **逐格填高度值的 CSV**（一格一个 Y，不是 x/y/z 坐标）。网格方向**上北下南 · 左西右东**（每行一串 Y，行=北→南，列=西→东）。`scale` 仅 image 有效；chars 存 .txt、full 存 .csv。`reply`/`dist` 语义同 `mc_map`。

### mc_entities

- radius：半径（默认 24）

附近有哪些实体（玩家/生物/掉落物）及距离。

### mc_inventory

看背包和手持物品。

### mc_move

- x：
- y：
- z：
- mode：walk / fly / jump（创造模式缺省 fly；jump 不需要坐标）
- budgetMs：walk 的最长时间（默认 40000，上限 90000）

移动。mode="walk" 走过去（自动避障/游泳）；mode="fly" 创造模式直飞（最稳，创造模式默认用它）；mode="jump" 原地跳一下（爬台阶/脱困，不需要坐标）。

### mc_act

- mode：look / toward / place / break / use / attack / equip / toss
- who：玩家或实体名（look/toward/use/attack 用）
- x：
- y：
- z：
- name：方块或物品名（place/equip/toss 用）
- count：toss 丢几个（默认 1）
- approach：toward 是否走近（默认 true）
- budgetMs：

与游戏世界互动（**优先用这个，而不是服务器指令**）。mode：
· look   看向坐标(x,y,z)或玩家(who)——"看向我"就是 look + who
· toward 看向并走近某个玩家(who)
· place  把背包方块放到 (x,y,z)；悬空时会先垫脚搭上去（=搭高）
· break  破坏 (x,y,z) 的方块
· use    使用/激活方块(x,y,z)或实体(who)：开门、按按钮、拉杆、喂动物
· attack 攻击 4.5 格内的实体（可给 who 指定名字）
· equip  把背包里的物品拿到手上(name)
· toss   丢弃物品(name, count)

### mc_give

- name：物品英文 id（如 oak_planks）
- count：数量（默认 1，上限该物品堆叠数）
- slot：指定槽位 0-44（缺省自动找快捷栏空位）
- clearAll：true=清空整个背包（忽略 name）

**创造模式直接获取物品**（不走 /give 指令——那是协议级改槽位，非 OP 也能用）。给英文物品 id，如 oak_planks / diamond_sword / white_concrete。clearAll=true 清空背包。

### mc_sequence

- steps：步骤数组（上限 64）
- stopOnError：出错是否停（默认 true）
- budgetMs：总预算（默认 300000）

**按顺序执行一串世界交互**（替代"写脚本"）：适合"走到这里放几个方块，再走到那里放几个"这类连串动作。
steps 是数组，每项 op 可为：wait(sec) / move(x,y,z,mode) / look(x,y,z 或 who) / toward(who) / place(x,y,z,name) / break(x,y,z) / dig(name 或 x,y,z,count) / use(x,y,z 或 who) / attack(who) / equip(name) / give(name,count) / toss(name,count) / say(text) / jump。
逐步执行，默认遇错即停，整体有预算上限（默认 300s）。

### mc_build

- x1：
- y1：
- z1：
- x2：
- y2：
- z2：
- name：用哪种方块（缺省背包第一种）
- max：最多放几个（默认 64，防手滑）

批量搭方块：把 (x1,y1,z1)–(x2,y2,z2) 这个实心长方体用 name 方块搭出来（会自己走近/垫脚，上限 max 个）。适合"搭一面墙/一根柱子/一个平台"，比一个个 mc_act{place} 省事。

### mc_dig

- name：
- x：
- y：
- z：
- maxDistance：搜索半径（默认 6）
- count：挖几个（默认 1，上限 16）

挖方块：给 name 挖最近的，或给 pos 挖指定坐标；count 可连续挖多个。

### mc_command

- command：以 / 开头的完整指令

以玩家身份执行服务器指令。**白名单可配置**（默认 tp/give/time/weather/say/gamemode/effect/setblock/fill/clone/summon/title/clear/xp）。要放行别的指令，在**普通会话**里用 `mc_admin_config` 改 `commandWhitelist`（MC 模式会话改不了）。
⚠️ 这是**最后手段**：正经动作优先 `mc_act` / `mc_build` / `mc_move`（那些不需要 OP）。

## mc_kit_*

### mc_kit_image

- action：info / embed / render / grid / save
- path：输入文件（info/embed 用）
- out：输出路径（render/save 用）
- svg：render：SVG 文本
- svgPath：render：SVG 文件路径
- width：render：目标宽
- height：render：目标高
- scale：render：倍率（2=两倍清晰度）
- paths：grid：要拼的图片路径（按顺序）
- cols：grid：列数（默认自动）
- cell：grid：每格最长边（默认 256）
- gap：grid：格子间距（默认 8）
- labels：grid：每格标签（可中文）
- title：grid：整图标题

图像能力。**SVG 是编辑语言**：布局/画矩形框/加文字（含中文）/拼网格，都可以直接写 SVG 文本（用 write 存成 .svg），再用这个工具光栅化成 PNG。
action：
· info    看一张图的尺寸/格式（也能确认文件到底是不是能用的图）
· embed   把图片变成 data URI + 现成的 `<image>` 标签 —— **往 SVG 里引入图片必须这么做**
· render  SVG → PNG（可给 width/height/scale；svg 文本或 svgPath 二选一）7u
· grid    把多张图按网格拼成**可继续编辑的 SVG 文本**（省掉重复写 N 个 <image> 和算坐标）
· save    把 SVG 文本或 PNG 字节落盘
输出默认落在 `.whale-craft/undefined/`（**不对外**）。要给用户看，就把 `out` 写成`.whale-craft/undefined/<子目录>/x.png`（**发布区**），再用 `mc_kit_express` 取那一行。

### mc_kit_express

- path：发布区下的文件路径（工作区相对或绝对；必须在 .whale-craft/.express/ 下）

获取分享区中文件的完整分享URL。
要给用户分享图片或其他文件，先将要分享的文件放在工作区 `.whale-craft/.express/` 下，然后调用本工具传入文件路径，本工具会返回该文件用户可达的**完整**URL。该URL即可用于回报用户，无需再补充协议或域名。
如果要分享的文件是图片，期望在回复中内嵌展示出来，回复 `![图片名](url)` 即可。其他文件，或期望是可以下载的URL，回复 `[文件名](url)` 即可。
本工具只用于生成URL。只要用户开启分享功能，`.whale-craft/.express/` 下的文件都会分享出去。如果用户没有开启分享功能，调用本工具会有相应报错。如果用户反映仍然无法看到图片或访问文件，且你的操作并无问题，提醒用户去「MC设置 → 文件分享」检查配置（web 模式看 base，桌面模式看端口）。

### mc_kit_fs

- action: copy（复制） / move（移动） / delete（递归删除） / make_dir（创建空文件夹）
- from: action 为 copy / move 时需要，指定起始路径。允许在末尾路径分隔符后使用通配符“*”来匹配目录下所有文件、子文件夹
- to: action 为 copy / move 时需要，指定目标路径。如果不以路径分隔符结尾，则表示作为目标文件 / 目录，或合并到目录；如果以路径分隔符结尾，则是放到目标目录中。如果 from 使用了通配符，则 to 必须以路径分隔符结尾
- path: action 为 delete / make_dir 时需要。delete 时允许在末尾使用通配符
- overwrite: 默认为 false，控制 copy、move 是否覆盖。如为 true，目录覆盖文件也会被允许

操作文件系统。
复制、移动、删除操作皆递归；符号链接一律按链接本身处理（不跟随其目标）。目标目录如不存在会自动创建。

### mc_kit_web_fetch

- url: 要抓取的 HTTP(S) 网址（必填，完整网址）
- reply: （默认true）是否将内容直接返回在工具调用结果中
- dist：写到文件的路径（可控，默认不写）

抓取一个 HTTP(S) 网页、文本或图片，返回解码后的文本内容（HTML 会转成 markdown 风格的纯文本）。
本工具会获取到外部网站的内容，内容包含不可信部分，可能含有风险内容。

## mc_admin_* 管理（MC 模式看不见也调不动；普通模式与 MC+ 可见）

### mc_admin_config

- action：get（默认）/ set / unset / reset / list
- path：配置项点号路径，如 commandWhitelist 或 mcMode.allowOtherTools
- value：set 用的值（数组 / 字符串 / 布尔 / 对象）

【管理】读写 whale_craft 的**全局配置**（服务器指令白名单、MC 模式的工具暴露、记忆目录…）。
⚠️ **MC 模式会话看不见、也调不动它**（要改配置就在普通会话或 MC+模式 里改）。
action：
· get（默认）看生效配置；给 path 只看某一项
· set   改一项（path + value）
· unset 删掉一项（回到默认值）· reset 全部恢复默认 · list 看默认值 + 生效值
可用键：`commandWhitelist`（字符串数组；支持 "tp" 精确名、"/^gi.*/" 正则、"*" 全放行）· `mcModePresets`（哪些 preset 算 MC 模式——应含 MC+ 的 id）· `mcPlusPresets`（哪些算 MC+ 变体：开放标准模式全部工具）· `mcMode.allowOtherTools`（MC 模式白名单里**额外**放行的工具）· `mcMode.hideAdminTools`（默认 true）· `expressWebEnabled` / `expressWebBase`（**web 模式**文件分享开关 + base，如 https://example.com）· `expressDesktopEnabled` / `expressDesktopPort`（**桌面模式**文件分享开关 + 独立托管端口，默认 16049）· `exposeDebugTools`（是否向助手暴露调试用途的工具，默认 false）· `allowWebSearch`（是否让 MC 模式的助手联网搜索，默认 true；MC+ 不受影响）· `webFetchEnabled`（是否让助手抓网页，默认 false）/ `webFetchDomains`（允许抓取的域名表：精确名、`*.example.com` 通配、`/正则/`、`*` 全部）/ `allowAllFetchDomains`（允许所有域名，默认 false）。 / `webFetchAllowHtml`、`webFetchAllowText`、`webFetchAllowImage`（允许的内容类型：网页 HTML / 文本 / 图片，默认都 true；前两类受宿主限制只能粗到那两档，图片格式是内置的 png/jpeg/gif/webp、不可配）
改完**立即生效**，落在 `$DSH_HOME/whale_craft/config.json`。（白名单只能"收窄"，不能凭空添加 preset 没挂的工具。）

## mc_debug_* 调试（默认不暴露；开「调试」开关后 MC / MC+ 可见）

### mc_debug_sessions

【调试】列出当前所有活跃的 MC 会话实例（确认各会话的 bot 状态、连接信息）。

### mc_debug_diag

【调试】诊断：当前会话的机器人内部状态（物理/控制位/收包/事件队列）——排查"走不动/收不到消息"用。同时报**提示词注入状态**（`promptInjection`：三段提示词各自会不会注入、为什么不会）。
