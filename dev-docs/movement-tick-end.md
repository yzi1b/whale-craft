# 移动包 tick_end 兼容层

上游分析：https://github.com/PrismarineJS/mineflayer/issues/4189

`src/core.mjs` 的 `wrapMovementTickEnd(bot)` 在每次 `mineflayer.createBot()` 后安装到新 client：

- 原 `write` 成功返回后，针对 `position`、`position_look`、`look`、`flying` 追加 `tick_end` 空包；保留原返回值和原包异常。补包异常被兜底。
- 按发包时的 `client.version` 查询 mineflayer 同依赖树的 minecraft-data；自动探测完成后版本改变会重新判定，不在 createBot 返回时固定能力。
- 从版本元数据获取 1.21.2 的协议号作为下界，并核查当前 play/toServer 映射确有 `tick_end`。旧版及未知数据均不发包。部分数据版本按名称查 1.21.2 会回落至 1.21，因此先转协议号再取数据。
- 无定时器、无额外生命周期监听，不修改断线重连、强制停止或指令白名单。

## 回归

运行 `node tools/check-core.mjs` 和 `node selfcheck.mjs`。后者覆盖四类移动包、原包与补包顺序、返回值、this 绑定、原包失败不补发、补包异常、非移动包、旧版与未知版、自动协商版本改变、bot 重建及 minecraft-protocol 真序列化。

此层不补充上游缺失的版本数据。连接 Paper 26.3 仍需 mineflayer/minecraft-data 支持协商版本，或服务器经 Via 系列协商已有协议。

在线验收：在隔离 DSH_HOME/状态目录中连接，登录及切服后依次行走、目标导航、转头、静止各超过一分钟，记录断开原因及服务端日志。密码仅经运行环境传入，不写入源码、测试报告或日志。

## 2026-11-18 实测记录

- `node tools/check-core.mjs`：退出 0，全树语法、动态导入、私有字段一致性通过。
- `node selfcheck.mjs`：退出 0，1049 条通过行、0 条失败行；包含无宿主模拟与新增 tick_end 回归。
- 独立 McBot 连接 `metb.programcx.cn:25565`，账户 `CXBOTDS`；隔离 DSH_HOME 与锁/日志目录。仅此测试的 command allow 回调放开白名单，未改生产设置。先发送登录命令，再发送 `/server lobby`。
- Velocity STATUS 宣告 `Velocity 1.7.2-26.3`，实际协商协议 775（26.1）。本次证明指定服务端经 Via 的连接路径，不等于直接使用原生 26.3 协议。
- 时间：北京时间 23:13:21 起，测试结束后主动断开，未留下自动重连进程。

| 场景 | 持续时间 | 移动包总数 | tick_end | 结果 |
| --- | ---: | ---: | ---: | --- |
| 静止 | 62.199 秒 | 62 | 62 | 在线 |
| 转头 | 62.174 秒 | 286 | 286 | 在线 |
| 行走 | 62.071 秒 | 1812 | 1812 | 在线 |
| 目标导航（现有 McBot.walkTo） | 65.597 秒 | 1954 | 1954 | 在线 |

序列化入口实测总计 4114 个移动包与 4114 个 tick_end，涵盖全部四类包。期间无踢出或 Invalid move player packet received；目标导航部分短路径因地形未到达，但持续发包并保持在线。行走阶段被僵尸击杀一次，自动重生后继续完成测试（非协议断开）；最后位置约 (-74, 106, -53)。服务端控制台日志未取得，因此服务端日志验收项仍待管理员核对。

原始测试日志在本地 gitignored 的 logs/ 目录，不随插件包发布。
