# Bridge 连续闭环验收（T261 离线证据契约）

**T261 扩展的是离线输入契约，不是生产导出接口。** 目标会话、适用的发送尝试 epoch、精确页面消息审核引用和审核到新任务引用均是 required-for-PASS；旧收据缺失时判 UNKNOWN。本轮没有新增任何连接器、采集器、页面读取、生产字段或通知。

这份文档规定一件事：**怎样才算"没有人手动敲完成了"的自动循环真的跑过一轮。**
它不描述愿景，只规定可核对的证据字段，以及缺了哪个字段时结论必须是什么。

检查器：`tools/continuation/bridge_loop_acceptance.mjs`（离线、只读）。
它不是"证明循环可用"的工具，而是**判定一份记录是否足以支撑该主张**的工具；
PASS 的含义是"记录完整且自洽"，**不是**"本程序观测到了循环"。

```powershell
node tools/continuation/bridge_loop_acceptance.mjs record.json          # 人读
node tools/continuation/bridge_loop_acceptance.mjs record.json --json   # 机器读
# 退出码 0 = 全部 PASS，1 = 有 FAIL，2 = 无 FAIL 但有 UNKNOWN
```

## 一轮的五段链路

| 阶段 | 含义 | 唯一合格的证据来源 |
|---|---|---|
| `taskCompleted` | Bridge 台账记录 DSH 任务**成功**完成 | `bridge_ledger`，且**必须**带 `status`（须为 `completed`）、`taskId`、`runId` |
| `extensionSubmitted` | 适配器接受通知（写入 + 点击 + 提交） | `extension_diagnostic`，`status:submitted`、本轮 `runId`、适用 `bindingEpoch`；已知 blocked/refused/binding_invalidated 等为 FAIL，unconfirmed/ambiguous 为 UNKNOWN |
| `noticeVisible` | **通知确实进入了目标 ChatGPT 会话** | `chatgpt_visible_message` / `chatgpt_conversation_message`（人确认也接受），message/conversation/run 关联；目标 `conversationId` 由记录头提供 |
| `reviewed` | ChatGPT 独立复核该任务结果 | `chatgpt_review`，`reviewId` 或 `turnId`、task/run；`messageId`/`conversationId` 必须指向本轮页面消息 |
| `redispatched` | 从这次复核里创建了**新**任务 | `bridge_ledger`，新 `taskId` 与下一轮一致；`reviewId`→审核的 `reviewId` 或 `reviewTurnId`→审核的 `turnId`，两个命名空间分开比较 |

**目标状态是无人值守，所以 `noticeVisible` 不要求有人在场。** 可接受的到达证据是"该消息出现在目标会话里"：
`chatgpt_visible_message`（会话视图里可观察到）或 `chatgpt_conversation_message`（能读到这条消息本身，
带 `messageId`/`conversationId`）；`chatgpt_operator_confirmation` 依然接受，但它只是若干有效观测之一，
不是通过条件。

仍然禁止的是"发送侧冒充到达"：`host_ack`（Chrome 报"已持久化"）、`chrome_persisted`、
`extension_diagnostic` 的 `submitted`（适配器接受了消息）、`dsh_summary` / `dsh_completion_report`
（工人自述）。这些来源出现在 `noticeVisible` 上时判 FAIL，并写入
`noticeVisible:wrong_source(<来源>):sending_side_is_not_arrival`。

到达证据还必须**点名**：`messageId`、`conversationId`，以及与本次运行绑定的 `runId`（或发送方分配的
`eventId`/`bindingId`）。`eventId` 仅和发送回执的 `eventId` 比较，`bindingId` 仅和发送回执的 `bindingId` 比较；发送回执必须点名本轮 run。只有任意事件字符串、没有同键关联回执时为 UNKNOWN，已知不同值为 FAIL；两个命名空间不互相替代。只有"消息出现在某个会话"而不指向这条 run 的记录判 `UNKNOWN`（`noticeVisible:run_binding_absent`）；
指向了别的 run 判 FAIL（`noticeVisible:run_mismatch(...)`）。

消息进入会话之后，**该会话里 ChatGPT 那一 turn 的复核与再派单动作**才是"消息被真正消费"的证据；
`reviewed` 仍只接受 `chatgpt_review`，`redispatched` 仍只接受 `bridge_ledger` 且必须指向下一轮 `taskId`。
以上三者不要求人工参与。`recordSupportsUnattended:true` 仅表示给定记录完整且自洽；旧 `unattended` 字段弃用并恒为 `null`，`liveObserved:false`、`evidenceScope:supplied_record_only`。任何 offline PASS 都不构成实际无人值守执行的观测。

## 记录格式（脱敏，无正文）

```json
{
  "providerSessionId": "session-<本轮派单时的真实 id，不写入仓库>",
  "conversationId": "<独立确认的目标会话 id>",
  "bindingEpoch": "<适用于本发送尝试的 lowercase UUID；不是推测的最新 epoch>",
  "rounds": [
    {
      "round": 190,
      "providerSessionId": "session-<本轮派单时的真实 id，不写入仓库>",
      "taskId": "tsk-<bridge task id>",
      "runId": "<run uuid>",
      "startedAt": "2026-11-02T10:00:00Z",
      "completedAt": "2026-11-02T10:30:00Z",
      "states": {
        "taskCompleted":       { "observed": true, "source": "bridge_ledger", "at": "2026-11-02T10:30:00Z", "status": "completed", "taskId": "tsk-<本轮>", "runId": "<本轮run>" },
        "extensionSubmitted":  { "observed": true, "source": "extension_diagnostic", "at": "2026-11-02T10:30:05Z", "status": "submitted", "runId": "<本轮run>", "bindingEpoch": "<同适用epoch>" },
        "noticeVisible":       { "observed": true, "source": "chatgpt_conversation_message", "at": "2026-11-02T10:30:30Z", "messageId": "<独立页面消息>", "conversationId": "<目标会话>", "runId": "<本轮run>" },
        "reviewed":            { "observed": true, "source": "chatgpt_review", "at": "2026-11-02T10:35:00Z", "reviewId": "<独立审核>", "taskId": "tsk-<本轮>", "runId": "<本轮run>", "messageId": "<同页面消息>", "conversationId": "<同目标会话>" },
        "redispatched":        { "observed": true, "source": "bridge_ledger", "at": "2026-11-02T10:36:00Z", "taskId": "tsk-<下一轮>", "reviewId": "<同独立审核>" }
      }
    }
  ]
}
```

禁止入内：消息正文、草稿、会话内容、URL、cookie、token、凭据、扩展 id。`runId` 与 `taskId` 是标识符，
不是内容。

## 本检查器能做什么、不能做什么

它只核对**你提供的记录**自身的字段是否互相咬合：每个阶段是否点明了它作为证据所关于的那个对象，时间是否
成链，身份是否一致，是否重复或并发。

它**没有**连接器签名校验能力，也不访问 Bridge、Chrome、ChatGPT 或 Host：一份格式自洽的**离线 fixture**
拿到 PASS，只证明判定算法按规则工作，**不证明实机闭环跑通过**。要证明实机，需要真实记录的字段来自真实
事件，而这必须由派单方与观测方各自保证——本工具无法替他们担保。

## 判定规则（全部为 FAIL，除注明外）

- `taskCompleted.status` 不是 `completed`（`failed`/`timeout`/`cancelled`…）→ FAIL
  （`taskCompleted:status_not_completed(...)` 且 `round:not_a_successful_completion`）：**失败轮可以收到真实通知，
  但永远不算成功的开发回合**，即便 `reviewed` 与 `redispatched` 都写了 `observed: true`。
- 任一阶段 `observed: false` → FAIL（`<stage>:reported_false`）。
- 来源不在该阶段的允许集合 → FAIL（`<stage>:wrong_source(...)`）。
- 阶段时间戳倒序 → FAIL（`chain:out_of_order`）。
- `providerSessionId` 与记录头不一致 → FAIL（`session:mismatch(...)`）；**缺失**则是
  `UNKNOWN`（`session:absent`）——缺证据和自相矛盾不是一回事，不许合并。
- `runId` / `taskId` 重复 → FAIL（`duplicate_run:` / `duplicate_task:`）。
- 同一条 `noticeVisible.messageId` 出现在两轮 → FAIL（`duplicate_notice:<messageId>`）；同一个 `reviewId` 或同一个 `turnId`（各自命名空间分别检查，两个都提供时两个都检查）出现在两轮 → FAIL（`duplicate_review:<id>`）。一条页面消息只能是一次完成的通知，一次复核只能复核一个 run；重复记账等于把同一个环节算给两轮。
- 两轮时间窗重叠 → FAIL（`overlap:190/191`）：闭环一次只应有一条在跑。
- `redispatched.taskId` 指向本轮或此前任一轮已完成任务 → FAIL（`redispatch:reuses_completed_task:<taskId>`），**末轮没有下一条记录也必须检查**。
- `redispatched.taskId` 不指向下一轮的实际 `taskId` → FAIL（`redispatch:does_not_lead_to_round_N`）。
- 任一阶段 `observed` 缺失/`null` → `UNKNOWN`（`<stage>:not_observed`）。
- 阶段缺"点名"字段 → `UNKNOWN`，绝不填默认值：`taskCompleted:status_absent` / `task_id_absent` /
  `run_id_absent`、`extensionSubmitted:run_id_absent`、`noticeVisible:message_id_absent` /
  `conversation_id_absent` / `run_binding_absent`、`reviewed:review_id_absent` / `task_id_absent` /
  `run_id_absent`。**T190 及更早格式的记录因此只能判 `UNKNOWN`**，不会被默认值凑成 PASS。
- 来源是 `fixture` / `mock` / `test` / `synthetic` / `replay` → **`UNKNOWN`**，不是 PASS：
  模拟数据永远不能充当实机证据。

## T261 严格状态与外部回执边界

- `record.bindingEpoch` 或 `round.bindingEpoch` 是**适用于该发送尝试**的预期grant快照，不是审核时的“最新epoch”。两者都提供时必须相同；两个目标conversation上下文都提供时也必须相同，不静默覆盖。
- `extensionSubmitted.bindingEpoch` 必须是lowercase UUID并与预期相同。缺失/无效为 UNKNOWN；已知不同为 `epoch_mismatch` / `epoch_context_conflict`。跨不同顺序run复用同一个合法grant不算重复通知。
- 原始 `runEpoch` / `run_epoch` / `armEpoch` / `postArmEpoch` 仅在调用者明确声明 `epochScope:sender_attempt`、它们同指一次grant快照时纳入同义比较；否则 `epoch_scope_unverified` UNKNOWN。此限定不表示现有producer字段天然等义。`t058_epoch:UNKNOWN` 不是epoch；单个非原子t059快照不证明最新有效绑定。
- 不推断TTL、失效时刻或当前有效性。已知 `binding_invalidated` / `binding_changed` / `grant_expired` 与 submitted 并列时仍 FAIL；缺独立有效epoch事实时 UNKNOWN。
- 合格来源的阶段时间必须不早于本run的startedAt；taskCompleted时间不早于completedAt。页面/审核/续派可以晚于completedAt，没有人为“新鲜度”阈值。此检查不计算授权、不重建endedAtMs、不改变strict-before-consent规则。
- fixture、未观测或错误来源不贡献排序、重复消息/审核或续派关联断言；阶段UNKNOWN保留。合格来源的已知重复id仍FAIL，即便另一个时间字段缺失。`rounds[].stages` 给出逐段 PASS/FAIL/UNKNOWN。
- **独立页面组件缺口**：目标会话侧需独立导出messageId、conversationId、run/同键notice关联和观测时间；Native ACK/seen/发送诊断都替代不了它。
- **独立审核/派单组件缺口**：ChatGPT审核执行侧需导出reviewId或turnId、确切消费的messageId/conversationId/task/run；派单方需提供该review引用与新taskId的独立关联。当前检视的producer没有证明这些新增输入已可导出，本次只加强offline判定，不升级或修改外部组件。

## 三轮验收需要什么

**三轮不是自动开发的次数上限，只是稳定性采样。** 开发目标持续到项目完成、或需要真实人工授权为止；
第 4 轮、第 5 轮同样按本文判定，检查器对轮数没有上限。

每一轮各产出一条上面的记录（一条即可，不要合并成"三轮看起来都对"）。一轮要判 PASS，需要同时满足：

1. 记录的 `providerSessionId` 等于本轮派单时记录的那个 id（**不写入本仓库**，由派单方持有）；
0. 该轮 `taskCompleted.status` 若为 `failed`，这一轮只能作为"失败轮被真实通知"的证据，**不能计为开发成果**；
2. 每轮的 `noticeVisible` 由会话到达证据支撑（`chatgpt_visible_message` / `chatgpt_conversation_message`，
   或人确认），且时间上晚于 `extensionSubmitted`；
3. 每轮的 `reviewed` 都是一次独立复核（不是"任务 completed 顺带说明")；
4. 每轮 `redispatched.taskId` 等于下一轮的 `taskId`，且各轮 `runId` 互不相同；
5. 各轮时间窗互不重叠（同一时刻只允许一条在跑）。

**本仓库里的单测（`test_bridge_loop_acceptance.mjs`）证明的是检查器会拒绝坏记录，不是循环已经跑通。**
实机锁屏、睡眠、后台节流仍需独立实测——那些都在本工具的可观测范围之外。

## 下一阶段：自研常驻 Service + MCP 取代 Bridge 的最小能力

取代 Bridge 的前提是这七件事各自可验证，缺一件就只能继续用 Bridge：

| 能力 | 最小要求 | 验收方式 |
|---|---|---|
| `submit` | 提交任务返回稳定 `taskId`，重复提交同一幂等键返回同一 id | 同键两次提交，id 相同 |
| `status` | 只读查询状态与阶段产物位置，不改状态 | 连续查询不产生状态迁移 |
| `wait` | 长轮询/事件等待，带超时与断线重连 | 断网 30s 后仍拿到终态 |
| `continue` | 在既有 session 上续跑，`providerSessionId` 不变 | 续跑前后 session 相同 |
| `steer` | 运行中注入指令，生效点可见 | 注入后阶段产物变化可定位 |
| `interrupt` | 中止运行并留下终态事件 | 中止后 `status` 终结且事件唯一 |
| 可靠终态事件 | 至少一次投递 + 消费者去重（`eventId`） | 重放同一事件不产生第二次通知 |
| 幂等队列 | `eventId` 唯一索引、ack 后不可再投 | 重复 ack 无副作用 |
| 会话控制权租约 | 租约带 TTL 与持有者；第二持有者被拒 | 双客户端并发跑，只有一个生效 |
| 掉线恢复 | 重启后从持久队列续投，未 ack 的重投 | 杀进程重启，消息不丢不重 |
| 安全边界 | 仅本机 loopback、token 鉴权、审计日志 | 无 token 请求 401，日志有记录 |
| 迁移回滚 | 双跑期两套并存，开关一键切回 Bridge | 切换与回切各一次，闭环不断 |

### 迁移前必须独立验收的事件来源条件（不开展新服务部署）

自主 MCP+Service 要取代 Bridge，必须先满足这些**与本检查器无关**的条件，否则记录再漂亮也只是自证：

1. **事件签名**：终态事件带服务端签名（HMAC 或 ed25519），检查器可离线验签；无签名的事件不得作为到达证据。
2. **消息可回读**：到达证据的 `messageId`/`conversationId` 能从目标会话侧独立回读，而不是由发送方写入记录。
3. **审核可归属**：`reviewId`/`turnId` 能由 ChatGPT 侧独立确认，且与其后续 `submit` 调用同源。
4. **幂等可证**：同一 `eventId` 重复投递只产生一条消息、一次审核、一次派单，且可重放验证。
5. **租约可观测**：会话控制权租约的持有者、TTL 过期事件可查询，第二持有者的拒绝有日志。
6. **掉线恢复**：杀进程重启后未 ack 的事件重投且不重复，恢复过程可通过事件日志逐条核对。

验收判据与本文档一致：**页面可见性与独立复核只能由人/对方给出**，Service 自身的 ACK 不得被计为送达。
