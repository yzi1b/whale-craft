# 全方位可扩展可配置可复用灵活注意自合并自适应可追溯看门狗事件列表

## 通用

### 命名规则

事件事实和事件修饰按照点分节点命名。每个节点可用大小写字母、数字、`-`、`_`命名，且只能以字母开头，字母或数字结尾。其中 `_` 是特殊的，用来表示命名空间。简易使用小驼峰命名法。

如消息类的玩家聊天事实，可以这样命名：`message.chat`。它的命中提到某关键词的修饰，可以命名为 `mention`，也可以命名为 `content.includes`。如果其他插件扩展了本插件，加入了“基于语义分析的精准关键词检测”，可以命名为 `smartContent_mention`。一个节点本身可以是一个事件事实或修饰，也可以只是用以分类的语义节点。比如有 `content.includes` 事实，也可以有 `content` 事实。

同理，如果其他插件扩展了本插件，加入了“TrChat聊天事件”，可以将聊天事实命名为 `message.trChat_chat`。加入了“机械动力多方快结构散架”事实，可命名为 `create_multiblockStructure.boom`。

注意，命名空间应当是 Whale Craft 附属插件相关的，比如其去掉“dsh-”前缀的包名的剩余部分，而非单纯的某个 MC 插件或模组。

### 共有配置项

每个事件和事件修饰都固有配置项：

- record: (boolean) 是否记入事件列表。【敏感：true】
- wake: (boolean) 是否唤醒助理。【敏感：true】
- delay: (number) 延迟。事件事实必须大于等于 0，事件修饰可以小于零，常用 -1。【敏感：更小值】

### 如何生成提示词

“>” 开头的行，“【】”，“**” 标注的片段，都只是人类阅读的设计说明，不进入提示词。

AI 调用工具获得看门狗事件全面概述，获得的格式为：

```markdown
- harness.heartbeat：设定时间间隔循环触发。
- message.chat：服务器中的玩家聊天信息。(4修饰)
- message.system：其他系统消息。(4修饰)
  - playerConnection：分析发现系统消息符合玩家进入离开的格式，可视为玩家进入或离开服务器。
  - playerConnection.player：关注的玩家进入或离开服务器。
  - playerDeath：分析发现系统消息符合玩家死亡的格式，可视为某个玩家死亡。
  - playerDeath.player：关注的玩家死亡。
```

只显示描述的第一有效行作为简介，详情需要 AI 获得具体事件事实的概述。有修饰的事实要标注修饰数量。有特殊要求的事实还要列出修饰及其简介（描述的第一有效行）。

AI 调用工具获得指定事实的全面概述。获得的格式为：

```markdown
## `message.chat` 事件事实

服务器中的玩家聊天信息。

假如还有第二个有效行，那么就是详细说明，后面更多的有效行也一样，这里要显示出来。

**配置：**

这就是和后文一样的。

**载荷：**

这就是和后文一样的。

**事件修饰：**

- mention：玩家的消息中包含了某字符串。
- nearby：玩家说话时人在附近。
- solo：服务器中人数较少时有人说话。
- player：关注的特定玩家说话。

```

如果 AI 同时获取一个事件事实和它的全部修饰：

```markdown
## `message.chat` 事件事实

...

**配置：**

...

**载荷：**

...

### `mention` 事件修饰

**不可精简**【不可精简的属性声明不是有效行，不会取代概述的正文。但是这行文字在查详情的时候会注入。】

概述和事件事实结构相似。

```

AI 调用工具获得指定修饰的全面概述：

```markdown
## `message.chat/mention` 事件修饰

...
```

## 框架 `harness`

### 心跳 `heartbeat` 事件事实

设定时间间隔循环触发。

**配置：**

- interval: (number) 间隔时间，单位毫秒。必须大于等于10_000或小于等于0。若小于等于零，则视为关闭。默认 `600_000`。【敏感：更小值】
- record: true
- wake: true
- delay: 0

**载荷：**

- interval: (number) 间隔时间。

## 消息 `message`

### 聊天 `chat` 事件事实

服务器中的玩家聊天信息。

**配置：**

- includeSelf: (boolean) 观测自己发送的消息。【一般情况下 chat 不会直接唤醒机器人，记录其有利于维持事件队列的完整性和便于助理检查消息是否发出。不因为自己发出的消息唤醒助理依托于事件修饰。后文的事件修饰都会自动排除自己的话。】默认 `true`。【敏感无关，true 优先级更高】
- treatSystemAsChat: (boolean) 将形如 `<name> message` 的系统信息也视为聊天。【某些服务器上可能直接用系统消息来模拟玩家聊天，此机制可保证聊天信息不丢失。】默认 `true`。【敏感无关，true 优先级更高】
- record: `true`
- wake: `false`
- delay: `10_000`

**载荷：**

- player 【敏感：并集，钝感：交集，后略】
  - name: (string) 玩家名
  - uuid: (string?) 玩家UUID，带连字符。如果不包含则为 `null`。
- isSystem: (boolean) 是否为系统消息符合格式而归类的聊天。
- type: (string?) 聊天类型。如果没有则为 `null`。
- content: (string) 聊天的内容。

#### 提及 `mention` 事件修饰

玩家的消息中包含了某字符串。

**配置：**

- keywords: (string[]) 要检测的内容。判断时模糊大小写。助理在修改时应当先读再写，以免覆盖已有内容。如果为空，则关闭。默认 `["deepseek", "ds", "harness", "whale", "ai", "agent"]`【敏感：并集，钝感：交集】
- players: (string[]) 通过玩家名筛选。判断时模糊大小写。如果为空，则不筛选。默认 `[]`
- record: `true`
- wake: `true`
- delay: `-1`

**载荷：**

- keyword: (string) 最先命中到的关键词。

#### 附近 `nearby` 事件修饰

玩家说话时人在附近。

**配置：**

- distance: (number) 要检测的最远距离。大于等于0。检测时实际值向下取整。小于0则关闭。默认 `32`。【敏感：更大值】
- players: `[]`
- record: `true`
- wake: `true`
- delay: `-1`

**载荷：**

- distance: 触发记录的实际距离。

#### 独聊 `solo` 事件修饰

服务器中人数较少时有人说话。

**配置：**

- count: (number) 当服务器在线玩家数小于等于此值时，每次聊天都触发。应当大于等于2。小于等于0则关闭。默认 `2`。【敏感：更大值】
- players: `[]`
- record: `true`
- wake: `true`
- delay: `-1`

**载荷：**

- count: (number) 触发时服务器的实际在线人数。

#### 特定玩家 `player` 事件修饰

关注的特定玩家说话。

**配置：**

- players: (string[]) 关注的玩家名数组，为空则不关注。默认为 `[]`。
- record: `true`
- wake: `true`
- delay: `-1`

**载荷：**

`true`

### 系统消息 `system` 事件事实

*本事实的修饰应当在提示词中列举。*

其他系统消息。

任何相关事件进入本事件事实的优先级极低。如果被导向聊天等，则不会再被作为此事件处理。所以，此事件只处理“没人要的”。【应当保留这样的能力，让附属插件可以注册生产线的处理函数，判断某个系统消息符合条件则拿走自己处理。】

**配置：**

- record: `true`
- wake: `false`
- delay: `10_000`

**载荷：**

- content: (string) 消息文本。

#### 玩家连接 `playerConnection` 事件修饰

分析发现系统消息符合玩家进入离开的格式，可视为玩家进入或离开服务器。

**配置：**

- record: `true`
- wake: `false`
- delay: `10_000`

**载荷：**

- player: (string) 玩家名。
- kind: ("join" | "leave") 进入还是离开。

#### 指定玩家连接 `playerConnection.player` 事件修饰

关注的玩家进入或离开服务器。

**配置：**

- player: (string[]) 关注的玩家列表，为空则不启用。
- record: `true`
- wake: `false`
- delay: `10_000`

**载荷：**

- player: (string) 玩家名。
- kind: ("join" | "leave") 进入还是离开。

#### 玩家死亡 `playerDeath` 事件修饰

分析发现系统消息符合玩家死亡的格式，可视为玩家死亡。

**配置：**

- record: `true`
- wake: `false`
- delay: `10_000`

**载荷：**

- player: (string) 玩家名。
- message: (string) 死亡信息。

#### 指定玩家死亡 `playerDeath.player` 事件修饰

关注的玩家死亡。

**配置：**

- player: (string[]) 关注的玩家列表，为空则不启用。
- record: `true`
- wake: `false`
- delay: `10_000`

**载荷：**

- player: (string) 玩家名。
- message: (string) 死亡信息。

## 连接 `connection`

### 建立 `spawn` 事件事实

成功进入服务器时触发；自动重连成功也会触发。

**配置：**

- record: `true`
- wake: `false`
- delay: `0`

**载荷：**

- sub: (string) 服务器地址 / 子服务器标识。
- gameMode: (string) 游戏模式。
- position: ({x,y,z} | null ) 玩家的位置。
- isReconnect: (boolean) 是否是自动重连触发的事件。

### 断开 `disconnect` 事件事实

连接结束时触发。

**配置：**

- record: `true`
- wake: `true`
- delay: `0`

**载荷：**

- sub: (string) 服务器地址 / 子服务器标识。
- reason: (string) 断开原因（含“被踢: …”）。
- willReconnect: (boolean) 是否会自动重连。
- at: (number) 断开时间戳。

> 当前实现：`willReconnect === true` 时游戏会话与看门狗保持运行并提醒“正在自动重连”；`false` 时游戏会话管理器同步关闭二者，并统一投放游戏会话结束提示词。

## 自身 `self`

### 死亡 `death` 事件事实

自己死亡。

**配置：**
- record: `true`
- wake: `true`
- delay: `0`

**载荷：**

- message: (string) 死亡信息。
- position: ({x,y,z} | null) 死亡位置。
- allowRespawn: (boolean) 是否可重生。

### 受伤 `damage` 事件事实

自己受到伤害。

**配置：**

- record: `true`
- wake: `false`
- delay: `0`

**载荷：**

- damage: (number) 受到的伤害值。
- type: (string | null) 伤害类型的注册名，如 `minecraft:mob_attack`、`minecraft:on_fire`。协议无法提供或注册表解析失败时为 null。
- source: (string | null) 伤害来源描述。
- health: (number) 当前血量。
- position: ({x,y,z} | null) 受到伤害的位置。

#### 伤害类型 `type` 事件修饰

伤害的类型为指定类型。

为了防止持续发生的伤害，如 `minecraft:in_fire`，过量记录和频繁唤醒，初始情况下未配置命中任何类型的伤害。助理可根据需要在全局中加入需要关注的非持续、高频伤害，如非 PVP 情景下的 `minecraft:player_attack`。

**配置：**

- types: (string[]) 要命中的伤害类型注册名，支持 `"*"` 表示全部伤害类型。默认 `[]`。
- record: `true`
- wake: `true`
- delay: `-1`

**载荷：**

- type: (string) 命中的伤害类型注册名。

#### 首次经历伤害类型 `type.once` 事件修饰

**不可精简**

伤害的类型为指定类型。此修饰在命中后一段时间会冷却，直到冷却时间结束才能再次命中，可防止持续性伤害过量记录和频繁唤醒。

如果一个伤害被 type 命中，则不会再被此修饰命中。前者优先级更高。

【在 resetAfterMs 后没有再受到同种伤害，会清除上次伤害记录。】

**配置：**

- types: (string[]) 按上述规则去重的伤害类型注册名。支持 `"*"` 表示全部伤害类型。默认 `["*"]`。
- resetAfterMs: (number) 同类型连续伤害静默多久后视为新一轮，必须大于等于 1_000。默认 `4_000`。
- record: `true`
- wake: `true`
- delay: `-1`

**载荷：**

- type: (string) 本轮首次命中的伤害类型注册名。
- count: (number) 自上次命中之后到现在，总计受到同种伤害的数量。如果没有上次的记录，则为 -1。
- damageSum: (number) 自上次命中之后到现在，总计受到同种伤害的伤害值总计。如果没有上次的记录，则为 -1。

### 传送 `self.teleport` 事件事实

服务器强制改变了机器人的位置。

当前实现直接使用 mineflayer 的 `forcedMove` 事件判断，`/tp` 属于传送。普通行走、飞行和水流推动不会产生该事件。

**配置：**

- record: `true`
- wake: `true`
- delay: `0`

**载荷：**

- from: ({x,y,z}) 变化前位置。
- to: ({x,y,z}) 变化后位置。
- distance: (number) 位移距离，保留一位小数。
- serverForced: `true`

### 推动 `self.pushed` 事件事实

被水流、其他实体等推动。

当前实现：位置发生变化，且自己没有按移动键。

**配置：**

- minDistance: (number) 引发该事件的最小移动距离，默认 0.2
- record: `false`
- wake: `false`
- delay: `0`

**载荷：**

- from: ({x,y,z}) 变化前位置。
- to: ({x,y,z}) 变化后位置。
- distance: (number) 位移距离，保留一位小数。

#### 首次推动 `self.pushed.once` 事件修饰

**不可精简**

一轮连续推动中首次被推动时命中。此修饰在命中后一段时间会冷却，直到持续未被推动达到冷却时间，下一次推动才会再次命中，可防止水流、拥挤实体等造成过量记录和频繁唤醒。

每次推动都会延后当前轮次的结束时间。新一轮命中时，会在载荷中附带上一轮连续推动的次数和累计位移；首次命中时没有上一轮数据，以 `-1` 表示。

**配置：**

- resetAfterMs: (number) 连续推动静默多久后视为新一轮，必须大于等于 1_000。默认 `4_000`。
- record: `true`
- wake: `true`
- delay: `-1` 

**载荷：**

- count: (number) 上一轮连续推动的次数。如果没有上一轮记录，则为 `-1`。
- distanceSum: (number) 上一轮连续推动的累计位移距离。如果没有上一轮记录，则为 `-1`。
- from: ({x,y,z} | null) 上一轮连续推动的起始位置。如果没有上一轮记录，则为 `null`。

### 拾取 `self.pickup` 事件事实

背包物品总数增加。当前实现：每秒对比一次背包快照。

**配置：**

- record: `true`
- wake: `false`
- delay: `0`

**载荷：**

- items: (string[]) 新增物品，格式为 `名称*数量`，如 `stone*3`。
