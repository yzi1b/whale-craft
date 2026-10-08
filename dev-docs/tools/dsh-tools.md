# MC 模式下的 DSH 官方工具暴露

> +：暴露，-：不暴露，?：另行说明
> 暴露采用白名单制，此处未提到的，均不暴露。
> 即使暴露，也按照宿主策略以及是否 MC 模式

## Shell（命令执行）

- **-** bash 执行 shell 命令（持久/非持久变体同 id）
- **-** pwsh 执行 PowerShell 命令（持久/非持久变体同 id）

## 文件系统（`dsh-tool-fs`）

- **+** read 读取文件（带行号）
- **+** read_image 读取图片
- **+** write 写入/覆盖文件
- **+** edit 字面量替换编辑

## 文件检索（`dsh-tool-fs-search`）

- **+** glob 按通配符查找文件
- **+** grep 正则搜索文件内容

## 后台任务（`dsh-tool-jobs`）

- **+** job_list 列出后台任务
- **+** job_output 读取后台任务输出
- **+** job_kill 终止后台任务

## 目标（`dsh-tool-goal`）

- **+** get_goal 读取当前目标
- **+** create_goal 创建目标
- **+** update_goal 更新目标

## 计划模式（`dsh-plan-mode`）

- **-** exit_plan_mode 提交计划并退出计划模式

## 子代理 / 委派

宿主设置中启用子代理，则MC模式子代理最多1层，MC+模式跟随宿主设置。宿主不启动子代理，则也不允许。限制方式同宿主。

- **+** subagent 派生子代理
- **+** subagent_fork 派生子代理（fork 变体）
- **-** subagent_codex 派生子代理（Codex 提供方；默认禁用）
- **-** subagent_claude_code 派生子代理（Claude Code 提供方；默认禁用）
- **-** list_subagent_models 列出可用子代理模型
- **+** list_agents 列出子代理
- **+** interrupt_agent 打断子代理
- **+** send_message 给子代理发消息

## 工作流 / Ralph

- **-** workflow 运行工作流
- **-** ralph Ralph 循环（多轮自动迭代；默认禁用）

## 技能 / 联网 / 交互 / 待办 / 交付

- **-** skill 加载技能  *以 mc_kit_skill 替代*
- **?** web_search 联网搜索 *MC 模式由「MC设置 → 联网搜索」的「允许联网搜索」（`allowWebSearch`，默认开）控制；MC+ 模式恒有*
- **-** web_fetch 抓取网页内容 *以 mc_kit_web_fetch 替代*（MC 模式 preset 挂 `tool-web` 时 `fetch: false`；MC+ 跟随标准全表）
- **-** ask_user_question 向用户提问
- **+** todo_write 维护待办清单
- **-** present 交付文件给用户

## 其它编辑 / 依赖

- **-** str_replace_editor 查看/创建/编辑文件（自定义编辑器）
- **-** load_workspace_dependencies 加载工作区依赖

## 开发 / 运行时

- **-** cordis_inspect_list 列出运行中的插件（插件开发用）
- **-** cordis_inspect_query 查询运行时 API（插件开发用）
- **-** run_code 执行生成的工具代码（PTC 模式）
- **-** plugin_manager 插件管理（默认禁用）

## 实验（`dsh-experimental-tool-agent-team`，需显式挂载）

- **-** spawn_teammate 派生 teammate
- **-** wait_agent 等待子代理
- **-** team_task_create 创建团队任务
- **-** team_task_get 读取团队任务
- **-** team_task_list 列出团队任务
- **-** team_task_update 更新团队任务
