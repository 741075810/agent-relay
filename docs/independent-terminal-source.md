# 独立终态来源：现在没有，什么样才算有

这一页回答 T227 的问题：AgentRelay 除了镜像 Bridge 台账之外，是否存在**真正独立、可信**的任务终态记录来源。
答案是目前**没有可证实的**；下面写清查了什么、为什么不成立、以及将来接进来必须满足的接口约束。

## 1. 现状：一个来源，两条运输

| 路径 | 读的是什么 | 代码 |
|---|---|---|
| Native（Chrome 原生消息 → `host.py`） | `%LOCALAPPDATA%\CodexBridgeService\service.sqlite` 的 `bridge_service_task_events` | `run_origin.py:79-96`，`_has_table(conn, 'bridge_service_task_events')` 在 `run_origin.py:286` |
| Relay（sidecar → service → 扩展） | 同一个 sidecar 拉起的同一个 `host.py`，同一张表 | `tools/service/host_mirror.mjs`、`terminal_source.py:951-1075` |

所以 relay 是**同一来源的第二条运输**：它保护的是"这条消息走不过去"（进程、套接字、鉴权、顺序），
不保护"这个事实根本没被写下来"。Bridge 没写 `task.completed` 时，两条路一起安静 —— 这正是不能把 relay 叫做
故障备用通路的原因。T224 的四源读数也印证了这一点：79 条 run 全部带 `bridge.task_events.*` 的来源，relay 侧
`relayOfferedIds` 为空。

## 2. 查过的候选，以及各自为什么还不成立

| 候选 | 是不是不同来源 | 结论 |
|---|---|---|
| Bridge 的 HTTP 监听（`127.0.0.1:49183`，pid 19080） | 不是。同一进程、同一份数据 | 而且**没有任务 API**：`GET /`、`/health`、`/api/tasks`、`/tasks` 全部 404（2026-11-04 只读探测）。连当第二运输都不行 |
| Bridge 的 tunnel client（`api.openai.com/v1/tunnels/<id>/poll`，见 `Logs\service-bootstrap.log`） | **是**。这是台账的上游，事件经它进入 Bridge | 需要 tunnel id 与凭据，都在 Bridge 进程内部；本仓库拿不到，也不该去拿。这是唯一"真独立"的方向 |
| `tunnel-client.exe` 的本地运行时目录（`TunnelRuntime`） | 待定 | 里面是 Bridge 自己写的中继状态，仍属 Bridge 的生产物，不是第三方记录 |
| DSH 自己的会话记录（`~/.dsh`） | 记录的是**DSH 的回合**结束，不是 Bridge 的 `tsk-…` 任务 | 没有权威的跨来源身份映射；按 AGENTS.md「绝不靠猜测推断身份」，不能用时间/文本去 join。缺映射就不能用 |
| Windows 事件日志 / 进程遥测 | 没有任务身份 | 只能证明"某个进程退出了"，无法证明"这个 run 完成了" |
| 扩展自己观察页面 | 那是**消费端**，不是来源 | 用它当来源就是把"我们发了"当成"任务完成了" |

一句话：**今晚能证实的独立来源数量是 0**；tunnel 上游是唯一下一步，且需要 Bridge 侧暴露一个只读接口或提供
凭据，这属于要用户/上游决定的边界，不在夜间自主范围。

## 3. 接口约束（接进来的那天必须满足）

写在 `tools/service/independent_terminal_source.py`，并被 18 项测试钉住：

1. **生产者不是 Bridge**：`produced_by` 不得以 `bridge` / `codex-bridge` 开头；
2. **证据不是 Bridge 台账**：`ended_at_source` 不得是 `bridge.*`（`is_independent()`，拒绝码走 `refused`，
   事件进 `independentDeferredIds` 而不是被当成候选）；
3. **身份可对齐**：事件必须携带扩展已经在用的 `runId`，禁止任何"看起来是同一条"的推断；
4. **时间自带出处**：`ended_at_ms` + `ended_at_source`，不得用秒级时间、开始时间、mtime、墙上时钟重建；
   缺了就 deferred，永不播；
5. **只追加、单调**：带 cursor，`new_cursor < cursor` 直接判 `independent_source_replay`；重启从存档 cursor 继续；
6. **失败要报名字**：`independent_source_unconfigured` / `_unavailable` / `_malformed` / `_replay`，
   绝不折叠成"没有新完成"。

同意边界沿用 `relay_merge` 的同一套函数（`history`、`plausible`、`CLOCK_SKEW_MS`），不复制一份：
两份规则就是两份会开始分歧的规则。`postArm` 只由 `armedAtMs` 严格小于 `ended_at_ms` 得出；同毫秒拒绝。

## 4. 这个适配器现在是什么状态

* `PRODUCTION_SOURCES = ()` —— 什么都没绑；CLI 跑起来只会打印 `independent_source_unconfigured`；
* `host.py`、`terminal_source.py`、`relay_merge.py`、`relay_supervisor.py`、三个 `.mjs`、`background.js`
  都不 import 它（测试 `test_no_production_entry_point_imports_the_adapter`）；
* 状态写 `independent-source.json`，与 `terminal-source.json` 分开，避免一次实验污染真实 journal。

要真正用上，还差两件**不属于夜间自主**的事：

1. 一个能满足 §3 的来源（tunnel 上游的只读视图，或别的真正独立系统）；
2. 扩展侧接受新的 `source` 取值（现在只认 native 与 `relay`）。这是用户可见行为变化，需要白天决定。

## 5. 关闭条件（与 switch-log §11 一致）

"Relay-only 页面送达"要标记为已验证，需要同时满足：扩展 journal 出现一条 `source` 非 native 的候选、
带可信的 `postArmEvidence`、`hostAck` 为 acked、且操作者在页面上确实看到那条通知。
在此之前，它一直是 UNKNOWN；独立来源缺失这件事，则按本页记为**不可行（有约束）**，而不是"还没跑够"。
