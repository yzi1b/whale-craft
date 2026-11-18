## PTC 调用

所有工具都可以直接调用，其中的一部分支持 PTC 调用。PTC 调用依托于 `mc_ptc` 工具。

要进行 PTC 调用，你需要生成一段 ts 代码。其类型声明如下：

```typescript
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

interface ToolArgsMap {
  // 按工具名列出参数类型
}

interface ToolOutputMap {
  // 按工具名列出返回值类型
}

type ToolName = keyof ToolOutputMap & keyof ToolArgsMap

declare class ToolCallError extends Error {
  readonly name: "ToolCallError"
  readonly toolName: ToolName
}

declare const tools: {
  [K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]>
}
```

其中，工具相关的部分，在支持PTC调用的工具之描述中会指明。

你需要完成的 code 为如下函数的函数体：

```typescript
async function __ptc_program__(
  tools: typeof globalThis.tools,
  ToolCallError: typeof globalThis.ToolCallError,
  console: Console,
): Promise<unknown> {
  // code
}
```

运行时会按照你指定的逻辑调用相关工具。运行途中出错会抛出相关错误，成功后会在返回值中包含你在 code 逻辑中返回的值。
