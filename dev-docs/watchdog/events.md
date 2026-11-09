# 全方位可扩展可配置可复用灵活注意自合并自适应可追溯看门狗事件列表

## 框架 `harness`

### 心跳 `heartbeat` 事件事实

在设定事件后循环触发。

**配置：**

- interval: (number) 间隔时间，单位毫秒。必须大于等于10_000或小于等于0。若小于等于零，则视为关闭。默认 `600_000`。
- record: true
- wake: true
- delay: 0

**载荷：**

- interval: (number) 间隔时间

### 消息 `message`

## 聊天 `chat` 事件事实

服务器中的玩家聊天信息。

**配置：**

- includeSelf: (boolean) 观测自己发送的消息。【一般情况下 chat 不会直接唤醒机器人，记录其有利于维持事件队列的完整性和便于助理检查消息是否发出。不因为自己发出的消息唤醒助理依托于事件修饰。后文的事件修饰都会自动排除自己的话。】默认 `true`。
- treatSystemAsChat: (boolean) 将形如 `<name> message` 的系统信息也视为聊天。【某些服务器上可能直接用系统消息来模拟玩家聊天，此机制可保证聊天信息不丢失。】默认 `true`。
- record: `true`
- wake: `false`
- delay: `10_000`

**载荷：**

- player
  - name: (string) 玩家名
  - uuid: (string?) 玩家UUID，带连字符。如果不包含则为 `null`。
- isSystem: (boolean) 是否为系统消息符合格式而归类的聊天。
- type: (string?) 聊天类型。如果没有则为 `null`。
- content: (string) 聊天的内容。

### 提及 `mention` 事件修饰

玩家的消息中包含了某字符串。

**配置：**

- keywords: (string[]) 要检测的内容。判断时模糊大小写。助理在修改时应当先读再写，以免覆盖已有内容。如果为空，则关闭。默认 `["deepseek", "ds", "harness", "whale", "ai", "agent"]`
- players: (string[]) 通过玩家名筛选。判断时模糊大小写。如果为空，则不筛选。默认 `[]`
- record: `true`
- wake: `true`
- delay: `-1`

**载荷：**

- keyword: (string) 最先命中到的关键词。

### 附近 `nearby` 事件修饰

玩家说话时人在附近。

**配置：**

- distance: (number) 要检测的最远距离。大于等于0。检测时实际值向下取整。小于0则关闭。默认 `32`。
- players: `[]`
- record: `true`
- wake: `true`
- delay: `-1`

**载荷：**

- distance: 触发记录的实际距离。

### 独聊 `solo` 事件修饰

- count: (number) 当服务器在线玩家数小于等于此值时，每次聊天都触发。应当大于等于2。小于等于0则关闭。默认 `2`。
- players: `[]`
- record: `true`
- wake: `true`
- delay: `-1`

**载荷：**

- count: (number) 触发时服务器的实际在线人数。

### 特定玩家 `player` 事件修饰

**配置：**

- players: `[]`
- record: `true`
- wake: `true`
- delay: `-1`

**载荷：**

`true`
