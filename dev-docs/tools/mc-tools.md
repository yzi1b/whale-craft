# whale_craft 工具参考

> 快照 whale_craft 0.2.0。定义以 `index.js` 的 `apply()` 为准。
> 参数记法：`名:类型`，`*` = 必填，`=值` = 默认值。

## 模式与工具暴露范围


| 模式         | 暴露范围                                                                                                                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MC模式**   | 本插件：`mc_*` 除 `mc_admin_config` 外的 + `mc_kit_*` <br>宿主：文件工具 `read`/`write`/`edit`/`glob`/`grep`/`read_image` + `present` + `mcMode.allowOtherTools` 配置项<br>**不含** `mc_admin_config` |
| **MC+模式**  | 全部本插件工具（含`mc_admin_config`）；不套白名单，另见标准模式全量工具                                                                                                                                             |
| **其他模式** | 仅`mc_admin_config`（`mc_*` / `mc_kit_*` 全部隐藏，另有 guard 硬拒兜底）                                                                                                                                          |

    debug 工具，在设置后启用调试工具后，在且只在 MC / MC+ 模式下暴露与生效。

## 连接与会话

### `mc_capabilities`

- **描述**：能力/限制自述：支持版本、mineflayer 版本、登录方式、各项上限
- **参数**：无
- **超时**：默认

### `mc_accounts`

- **描述**：账户 list/search/refresh；永不返回密码/token
- **参数**：`action:string=list`、`innerID:string`、`query:string`
- **超时**：默认


    不再提供 use 子方法，其意义不大，应当移除

### `mc_lan`

- **描述**：只听局域网多播公告，找"对局域网开放"的房间（不扫端口，恒定 seconds 秒内返回）
- **参数**：`seconds:number=3`（≤15）
- **超时**：默认


    移除 mode，其没有作用

### `mc_ping`

- **描述**：对已知地址发一次 STATUS ping（不登录）：通不通/版本/协议号/MOTD/人数/延迟
- **参数**：`address:string*`、`timeoutMs:number=5000`（≤30000）
- **超时**：默认


    从现在开始不分 address（host） 和 subserver（fake host），MC客户端对于用户本来就只用填一个地址，实际上连到那个子服实际上看dns和velocity之类的配置。如果真的需要客户端处理，真的需要给mineflayer填这俩，应该是工具后面的逻辑自动处理，而非交给AI填这两个值。如果真的需要写这个逻辑，做成可复用。
    
    也就是说，现在无论是ping还是连接mc服务器，都只用填一个完整的address（包括IP/host+port），后面 mc_connect 同理。

### `mc_connect`

- **描述**：连接服务器（唯一连接入口）；账号来自「MC设置」，成功后等区块并自动挂看门狗。连接完成后返回mc_status作为返回。连接失败会有错误信息
- **参数**：`address:string`、`account:string`（填inner accountID）
- **超时**：默认

    不再填version，始终自动探测。而且版本不适配还要强制连接失败，断开连接并返回错误信息。

### `mc_status`

- **描述**：返回当前会话与连接有关的状态。游戏address、版本、连接状态。如果在游戏内，还要返回mc_context的内容。
- **参数**：无
- **超时**：默认

### `mc_disconnect`

- **描述**：从 MC 下线；看门狗自动关闭并提醒
- **参数**：`reason:string`
- **超时**：默认

### `mc_stop`

- **描述**：停本会话：优雅退游戏 + 清后台任务；不中断当前轮
- **参数**：`reason:string`
- **超时**：默认

## 观察

### `mc_context`

- **描述**：获取游戏上下文。游戏模式、所在维度、坐标、朝向。（survival系列的信息，默认在生存和冒险模式下显示，如果survival参数为true则固定输出）生命值、伤害吸收值、饱食度、饱和度、气泡值、装备值、经验等级、经验值。所有buff及其等级、时长。自己的坐骑、骑乘者。
- **参数**：`survival:bool=false`
- **超时**：默认

### `mc_players`

- **描述**：获取游在线玩家的tab栏名、档案名、uuid，包括自己的。
- **参数**：无
- **超时**：默认

### `mc_map`

- **描述**：看周围地形：chars 字符图 / image 俯视图
- **参数**：`radius:number=32`（≤96）、`glyphStep:number=2`、`yTop:number=10`、`yBottom:number=-24`、`format:string=chars`、`scale:number=4`、`reply:bool=true`、`dist:string`
- **超时**：默认


    reply默认为true，表示结果是否作为工具调用结果回复到上下文中。dsit为路径，表示将结果输出到文件，留空则不输出到文件。二者互不影响。这种布局还会使用在其他工具中。值得注意的是，如果工具调用结果中欲插入图片，则需先检查当前模型是否接受视觉。如果不接受，应该不返回图片，以警告消息代之，不要因报错打断循环。
    
    逐渐取缔.dist目录作为默认输出目录的存在。以后相关路径必须指定绝对路径。绝对路径允许，相对路径起始于工作区根目录。注意不是.whale-craft目录，因为要和其他工具保持一致，且我们有MC+模式存在允许访问外界。如果其他工具还用了相对路径且起始位置与这里有歧义，则也要逐渐取代。
    
    char形式的map保存的格式为.txt。

### `mc_height`

- **描述**：获取高度（地势）图
- **参数**：`radius:number=32`（≤96）、`glyphStep:number=2`、`startY:number`、`ignoreLiquid:bool=false`（true时将液体视为无方块）、`format:string=chars`、`scale:number=4`、`reply:bool=true`、`dist:string`
- **超时**：默认
- **详细**：半径与前文map一致。startY留空则为目前角色所在Y。扫描方式为，startY处如果没有方块，则向下找到第一个有方块的位置的Y坐标，直到世界底部；startY处如果有方块，则向上找到第一个没有方块的位置，取其Y坐标-1，直到世界顶部。按graphStep取样每个坐标Y值填入结果网格。输出方式有chars、image、full。image为分层设色等高图，chars为用字符模拟的image，full为完整绝对Y坐标的csv。scale只对image有效。chars导出扩展名为.txt，full为.csv。

### `mc_scan`

- **描述**：扫描周围方块：给 name 找位置，不给则统计
- **参数**：`radius:number=8`（≤24）、`height:number=4`（≤16）、`name:string`、`limit:number=10`
- **超时**：默认

### `mc_entities`

- **描述**：附近实体（玩家/生物/掉落物）及距离
- **参数**：`radius:number=24`
- **超时**：默认

### `mc_inventory`

- **描述**：背包与手持物品
- **参数**：无
- **超时**：默认

### `mc_events`

- **描述**：读/消费事件队列（聊天/系统/受伤/生死/断线）；peek 只看不清
- **参数**：`limit:number=20`（≤100）、`kind:string`、`peek:boolean`、`waitSec:number=0`（≤120，会被唤醒打断）
- **超时**：130s

## 看门狗控制

### `mc_watch`

- **描述**：看门狗控制（唯一唤醒通道）：status/arm/disarm/log
- **参数**：`action:string=status`、`reason:string`
- **超时**：默认

### `mc_config`

- **描述**：读写本会话看门狗配置（唤醒条件/近距半径/叫法等）
- **参数**：`patch:object`（点号键浅合并）、`reset:boolean`
- **超时**：默认

## 交互与动作

### `mc_say`

- **描述**：公屏说话（截 220 字）
- **参数**：`message:string*`
- **超时**：默认

### `mc_move`

- **描述**：移动：walk 走 / fly 直飞 / jump 原地跳
- **参数**：`x/y/z:number`、`mode:string`、`budgetMs:number=40000`（≤90000）
- **超时**：120s

### `mc_act`

- **描述**：单动作：look/toward/place/break/use/attack/equip/toss
- **参数**：`mode:string=look`、`who:string`、`x/y/z:number`、`name:string`、`count:number`、`approach:boolean=true`、`budgetMs:number`
- **超时**：120s

### `mc_dig`

- **描述**：挖方块：给 name 挖最近的，或给坐标
- **参数**：`name:string`、`x/y/z:number`、`maxDistance:number=6`、`count:number=1`（≤16）
- **超时**：120s

### `mc_build`

- **描述**：长方体批量搭建（会走近/垫脚）
- **参数**：`x1/y1/z1/x2/y2/z2:number*`、`name:string`、`max:number=64`（≤256）
- **超时**：180s

### `mc_give`

- **描述**：创造模式直接取物品（协议级，无需 OP）
- **参数**：`name:string`、`count:number=1`、`slot:number`（0-44）、`clearAll:boolean`
- **超时**：60s

### `mc_sequence`

- **描述**：按序执行一串世界交互（≤64 步）
- **参数**：`steps:array`、`stopOnError:boolean=true`、`budgetMs:number=300000`（≤570000）
- **超时**：600s

### `mc_command`

- **描述**：执行服务器指令（白名单，最后手段）
- **参数**：`command:string*`
- **超时**：默认

## 游戏外辅助（`mc_kit_*`）

### `mc_kit_image`

- **描述**：图像：info/embed/render（SVG→PNG）/grid/save
- **参数**：`action:string`、`path:string`、`out:string`、`svg:string`、`svgPath:string`、`width:number`、`height:number`、`scale:number`、`paths:array`、`cols:number`、`cell:number=256`、`gap:number=8`、`labels:array`、`title:string`
- **超时**：120s

### `mc_kit_express`

- **描述**：把发布区 `.whale-craft/.express/` 的文件换成给用户的一行（路径或 URL）。**按宿主模式**：web 模式回 `base + /api/whale-craft/express/<工作区uuid>/<rel>`；桌面模式回 `http://localhost:<port>/<工作区uuid>/<rel>`（独立端口，端口起不来则回占用文案）。关闭时恒回"文件分享已关闭…绝对路径…"。
- **参数**：`path:string*`
- **超时**：默认

### `mc_kit_fs`

- **描述**：操作文件系统。**MC模式**下只能操作 `.whale-craft/` 下，**MC+模式**按宿主设置（一般为工作区）。
- **参数**：`action:string*`（copy / move / delete / make_dir）、`from:string`（copy/move 必须）、`to:string`（copy/move 必须）、`path:string`（delete/make_dir 必须）
- **备注**：路径为绝对路径，或**相对于工作区目录**的相对路径。copy、move 的 `from` 与 delete 的 `path` 允许末尾通配符 `/*`（意为选中目录下所有**直接**子项）；此时 copy/move 的 `to` 必须是目录、**不存在会自动创建**。操作均递归；**符号链接一律按链接本身处理（不跟随其目标）**。**受保护文件（RULES.md/AGENTS.md/config.json）与凭据路径不可删改**（通配命中则跳过并报告）。

## 管理（`mc_admin_*`）

### `mc_admin_config`

- **描述**：全局配置读写（get/set/unset/reset/list）；MC 模式不可见也不可调
- **参数**：`action:string=get`、`path:string`、`value:json`
- **超时**：默认

## 调试（`mc_debug_*`）

### `mc_debug_sessions`

- **描述**：列出所有活跃 MC 会话实例（诊断）
- **参数**：无
- **超时**：默认

### `mc_debug_diag`

- **描述**：诊断快照：物理/控制位/收包/事件队列 + 提示词注入状态
- **参数**：无
- **超时**：默认
