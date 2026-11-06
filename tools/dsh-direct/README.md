# dsh-direct — ChatGPT → 自研 MCP → 既有 DSH 会话

**目标**：把「向已存在的 DSH 会话派一个任务」这件事，从 Codex Bridge 上摘下来，改成我们自己的 MCP Server + loopback 桥。
**不做**：不碰任何 DSH→ChatGPT 完成通知、Chrome 扩展、生产 Native/Relay、Swift/Bridge、原页面；不新建会话；不开公网端口。

## 1. 数据流

```
MCP client (ChatGPT connector / 本地 MCP 客户端)
   │  stdio JSON-RPC 2.0   （mcp_server.mjs）
   ▼
dsh-direct MCP Server ── 校验 / 幂等 / 单会话占用 / 只读工作树预检
   │  HTTP 127.0.0.1:<port>  +  Authorization: Bearer <token file>
   ▼
Host bridge（host_bridge.mjs）—— 只绑 loopback，只认令牌
   │  进程内调用
   ▼
Adapter（adapters.mjs）
   ├─ createSessionControllerAdapter(ctx.sessionController)   ← Cordis Desktop 插件里可用的那条
   └─ createFakeHost()                                        ← 离线测试用，永远自称 offline_fake
```

**Bridge 不在链路里**：本模块从 MCP 到 Host 桥没有任何 Codex Bridge 依赖；`relay_service.mjs`、`host.py`、扩展都不参与。

## 2. 工具面（`mcp_server.mjs` + `protocol.mjs`）

| 工具 | 作用 | 关键约束 |
|---|---|---|
| `list_sessions` | 列出**已绑定**的会话 | 只返回 `boundSessionIds` 命中的；可选 `projectId` 过滤；不建会话 |
| `submit_task` | 向**既有**会话投递一个 turn | `requestId` 幂等；同一会话同时只允许一个活跃任务；`createSession` 出现即拒（`not_bound`） |
| `get_task` | 读任务状态与阶段 | 只读 |
| `get_result` | 读已结束任务的结果 | 未结束返回 `task_not_finished` |

错误一律结构化：`{ ok:false, code, message, details }`。码表见 `protocol.mjs` 的 `CODES`：
`invalid_arguments` / `unknown_tool` / `unauthenticated` / `not_bound` / `session_not_found` / `project_mismatch` /
`request_conflict` / `session_busy` / `task_not_found` / `task_not_finished` / `host_unreachable` /
`host_capability_missing` / `worktree_dirty` / `state_unreadable` / `internal`。

**幂等**：同一 `requestId` + 同一 `(sessionId, prompt)` → 返回原任务（`duplicate:true`，任务 id 不变）；
同一 `requestId` + 不同载荷 → `request_conflict` 并给出 `existingTaskId`（不静默改指向）。

**单会话占用**：`accepted`/`running` 期间对同一 `sessionId` 再提交 → `session_busy`（fail-closed，带 `activeTaskId`）。

**工作树只读预检**：`worktree.mjs` 用 `git --no-optional-locks status --porcelain=v2` + `rev-parse HEAD`，
不取索引锁、不改任何文件；读到脏树 → `worktree_dirty` 并列出前 50 条；**读不到仓库也算不干净**（`not_a_repository`）。
`allowDirtyWorktree: true` 才能放行。

**重启诚实性**：台账 `state/tasks.json` 里处于 `accepted`/`running` 的任务，进程重启后一律变 `unknown`
（`unknownReason: "process_restart"` + 阶段 `recovered_as_unknown`），**不会**被当成功。

## 3. 安全边界

- 桥**只能**绑 `127.0.0.1`（`startHostBridge({host:'0.0.0.0'})` 直接抛错）；非 loopback 对端在路由前就 403 `loopback_only`。
- 令牌从文件读（`readToken`，<32 字符即拒），`timingSafeEqual` 比较；MCP 侧客户端**调用时**才读令牌文件，不经 argv、不进进程列表。
- `/health` 无令牌可读——只暴露「这是哪种 Host、能力齐不齐、是否只 loopback」，便于操作者判断证据等级；不泄露会话内容。
- 不读 Chrome token、不连私有 WebSocket、不绕过任何认证。

## 4. 三个验收等级（不要混淆）

| 等级 | 含义 | 当前状态 |
|---|---|---|
| **A. scaffolded / mock passed** | 代码与测试就绪：真实 MCP stdio 子进程 + 真实 loopback HTTP 桥 + 真实台账；Host 是离线 fake，结果里 `host: "offline_fake"` | **已达成**：`test_t271_dsh_direct.mjs` 7/7 + `test_t271_dsh_direct_hardening.mjs` 9/9（共 16 例） |
| **B. Desktop real registered** | 一个 Cordis Desktop 插件被装进现有 Desktop Host 进程，`ctx.sessionController` 真的提供 `listSessions/prompt/getEvents`，桥以 `host: "cordis_session_controller"` 应答 | **未达成**（需要操作者安装插件；本轮禁止自动安装） |
| **C. same-session real prompt executed** | 对**已有的那个**会话真的投递了一个 turn，并从 Host 事件流读到该 turn 的回答 | **未达成**（依赖 B；本轮明令不向真实 DSH 提交测试任务） |

任何用 A 的收据冒充 B/C 的说法都是错的。测试里 fake 的标签一路传到 MCP 结果：

```
"host": "offline_fake"        ← 离线
"host": "cordis_session_controller"  ← 真适配器（仍需 B 的注册才可能出现）
```

## 5. 本机权威依据（以及没能证明的部分）

本机安装的官方包（只读核对，未改动）：

- `@deepseek-ai/dsh-desktop` **0.2.0-rc.2**，`dshBuildCommit 04f392c9ddd144fa426da2045178797da6db6c11`
  （`<install>\resources\app\package.json`）。
- `@deepseek-ai/dsh-api-gateway` **0.2.0-rc.2**，随包 README（105 行）说明：Host 侧 `ctx.typertGateway`、
  Client 侧 `ctx.remote`、Connection 共享的认证 `/api` FetchHandler、Gateway 自有 `/api/remote.mux` WebSocket、
  以及 `./stream-protocol`「为原生桌面调用方提供共享的 Remote 流帧格式和解析器，与浏览器客户端使用同一个经过认证的 WebSocket 端点」。
  证据文件：`<install>\resources\app\node_modules\@deepseek-ai\dsh-api-gateway\README.zh.md`。

**没能证明的**：`packages/api/session-controller` 的 `ctx.sessionController` 与 `session/prompt|list|follow`
方法名。原因有两条，都属于「无法读取」，不是「不存在」：

1. 本机网络把 `github.com` / `raw.githubusercontent.com` 解析到非公网地址，官方 README 取不回来；
2. 在已安装的 Electron 主进程 `resources\app\lib\main.js` 与 `lib\preload-app.cjs` 里对
   `sessionController`、`session/prompt` 做**计数检索为 0 命中**——所以「Desktop 同进程里有这个服务」这件事
   无法从安装产物证明，只能等插件在应用内运行时由 `describeCapabilities()` 报出来。

因此本模块**不假设**该服务的形状：`createSessionControllerAdapter()` 先探针，缺方法就
`host_capability_missing` 并列出 `missing` / `required` / `available`。

## 6. 剩下的阻塞清单（唯一的操作者动作）

1. **安装并启用一个 Cordis Desktop 插件**（操作者手动：退出 DSH Desktop → 用自带 `dsh` CLI 安装插件 →
   重新打开 app）。插件要做的就是：在 Host 进程里 `ctx.sessionController` 存在时，用本模块的
   `createSessionControllerAdapter(ctx.sessionController)` 起 `startHostBridge()`，监听 `127.0.0.1`，
   令牌写到只有本人可读的文件。**这一步本轮未做，也不应由代理自动做。**
2. **ChatGPT 侧注册自定义 MCP connector** 并按需把请求路由到本机（需要安全的出网/隧道授权）。
   在那之前，本 MCP Server 只能在本地被真实 MCP 客户端（stdio）调用；**本会话的工具列表里并不包含它**。
3. 在 B 成立之后，才能做 C：向**指定的那个既有会话**（不是新建）投递一次真实 turn，并把 `get_result` 的
   回答与 Host 事件流一起留证。

第 1 步完成后，验证顺序建议：`GET /health` 看 `capabilities.missing == []` → `list_sessions` 里出现目标会话
→ `submit_task` 一次（用独立 `requestId`，工作树必须干净）→ `get_result`。

## 7. 运行

```bash
# 1) 生成令牌（只有本人可读）
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" > host.token

# 2) 配置（示例见 config.example.json；路径、令牌文件、绑定清单都是本机的，不入库）
# 3) 起 Host 桥（在插件进程里由插件调用 startHostBridge；离线自测可用 fake）
# 4) 起 MCP Server
node tools/dsh-direct/mcp_server.mjs --config /path/to/dsh-direct.config.json
```

`config.example.json` 里的字段全是占位符；`boundSessionIds` / `boundProjectIds` 必须显式给出，
否则服务拒绝启动（`not_bound`）——不允许「无绑定随便打」。

## 8. 已知边界

- 轮询是**有界**的（`maxPolls`，默认 3），没有定时器、没有常驻轮询进程；一个任务超过预算就停在 `running`，
  由 `get_task` 继续观察，**不会被谎报为成功**。
- 台账只存 prompt 的 SHA-256 与长度，不存原文（Host 的回答可能回显 prompt，那是 Host 的产物，不是本地副本）。
- 会话列表来自 Host 的 `listSessions()`；本模块不维护自己的会话表，也不根据 prompt 文本猜测会话身份。
