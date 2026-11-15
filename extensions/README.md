# whale_craft 扩展点

**给其他 Agent 用**：想给麦块模式加能力，不必改 `index.js` —— 往这个目录丢一个 `.mjs` 文件即可。

## 契约

文件导出 `apply(api)`（可选导出 `name` 作为日志标签）：

```js
export const name = 'my-extension'

export async function apply(api) {
  const { ctx, config, asTool, getSession, registry, memory, logLine, Watchdog } = api
  // 注册你的工具
  ctx.tools.register(asTool({
    name: 'mc_my_tool',
    description: '……',
    parameters: { foo: { type: 'string' } },
    output: { schema: { type: 'object', properties: {}, additionalProperties: true },
              render: (a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    async execute(args, exec) {
      const sess = getSession(exec)      // 当前会话的 McSession（拿 bot）
      return { echo: args.foo, online: sess.bot.online }
    },
  }))
}
```

## api 里有什么

| 字段 | 说明 |
| --- | --- |
| `ctx` | 宿主 Cordis 上下文（`ctx.get('jobs')` / `sessionController` / `logger` …） |
| `config` | 插件的 Config（行为配置；连接参数不在这里） |
| `asTool(spec)` | **必须用它注册**——它负责返回值无损化和注入 `exec.signal` |
| `getSession(exec)` | 按 `exec.agent.id` 路由到当前会话的 `McSession`（含 `bot` / `events` / `watchdog`） |
| `registry` | `McRegistry`：`peek(id)` / `listSessions()` / `destroy(id)` |
| `memory` | `MemoryStore`：记忆树增删改查（`list` / `read` / `write` / `append` / `put` / `delete` / `search`），根目录 `.whale-craft/` |
| `logLine(...)` | 写 `whale_craft/logs/whale-craft.log`（插件加载期也能用） |
| `Watchdog` | 看门狗类（要自己造一个时用） |

## 规矩

1. **必须用 `asTool` 注册**，否则返回值里的 mineflayer `Vec3` 类实例会让宿主报
   `value is not lossless JSON`，整条工具直接失败。
2. **任何可能永不 settle 的 await 都要套超时**。宿主没有硬中断能力
   （`tools/index.ts:219` 原话 "cannot hard-kill same-process code"），
   一个卡住的工具会让整轮 turn / 停止按钮 / 插话全部失效。用 `src/core.mjs` 导出的
   `withTimeout` / `raceAbort`。
3. **不要另开会话**（单脑约束）。要通知当前会话就用看门狗或 `sessionController.prompt`。
4. 加完跑 `node whale_craft/tools/check-core.mjs` + `node whale_craft/selfcheck.mjs`，
   再按铁律起隔离实例验整树。

## 模板

见 `example.mjs.example`（把后缀改成 `.mjs` 就会自动加载）。
