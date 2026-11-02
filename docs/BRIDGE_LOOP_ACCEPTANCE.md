# Bridge 连续闭环验收（T190 → T191 → T192）

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
| `taskCompleted` | Bridge 台账记录 DSH 任务完成 | `bridge_ledger` |
| `extensionSubmitted` | 适配器接受通知（写入 + 点击 + 提交） | `extension_diagnostic` |
| `noticeVisible` | **通知确实进入了目标 ChatGPT 会话** | `chatgpt_visible_message` / `chatgpt_conversation_message`（人确认 `chatgpt_operator_confirmation` 也算，但不是必需） |
| `reviewed` | ChatGPT 独立复核该任务结果 | `chatgpt_review` |
| `redispatched` | 从这次复核里创建了**新**任务 | `bridge_ledger`（带新 `taskId`） |

**目标状态是无人值守，所以 `noticeVisible` 不要求有人在场。** 可接受的到达证据是"该消息出现在目标会话里"：
`chatgpt_visible_message`（会话视图里可观察到）或 `chatgpt_conversation_message`（能读到这条消息本身，
带 `messageId`/`conversationId`）；`chatgpt_operator_confirmation` 依然接受，但它只是若干有效观测之一，
不是通过条件。

仍然禁止的是"发送侧冒充到达"：`host_ack`（Chrome 报"已持久化"）、`chrome_persisted`、
`extension_diagnostic` 的 `submitted`（适配器接受了消息）、`dsh_summary` / `dsh_completion_report`
（工人自述）。这些来源出现在 `noticeVisible` 上时判 FAIL，并写入
`noticeVisible:wrong_source(<来源>):sending_side_is_not_arrival`。

消息进入会话之后，**该会话里 ChatGPT 那一 turn 的复核与再派单动作**才是"消息被真正消费"的证据；
`reviewed` 仍只接受 `chatgpt_review`，`redispatched` 仍只接受 `bridge_ledger` 且必须指向下一轮 `taskId`。
以上三者都不需要人：一轮完整记录的 PASS 可以完全无人参与，报告里以 `unattended: true` 标注。

## 记录格式（脱敏，无正文）

```json
{
  "providerSessionId": "session-<本轮派单时的真实 id，不写入仓库>",
  "rounds": [
    {
      "round": 190,
      "providerSessionId": "session-<本轮派单时的真实 id，不写入仓库>",
      "taskId": "tsk-<bridge task id>",
      "runId": "<run uuid>",
      "startedAt": "2026-11-02T10:00:00Z",
      "completedAt": "2026-11-02T10:30:00Z",
      "states": {
        "taskCompleted":       { "observed": true, "source": "bridge_ledger", "at": "..." },
        "extensionSubmitted":  { "observed": true, "source": "extension_diagnostic", "at": "...", "status": "submitted" },
        "noticeVisible":       { "observed": true, "source": "chatgpt_operator_confirmation", "at": "..." },
        "reviewed":            { "observed": true, "source": "chatgpt_review", "at": "..." },
        "redispatched":        { "observed": true, "source": "bridge_ledger", "at": "...", "taskId": "tsk-<下一轮>" }
      }
    }
  ]
}
```

禁止入内：消息正文、草稿、会话内容、URL、cookie、token、凭据、扩展 id。`runId` 与 `taskId` 是标识符，
不是内容。

## 判定规则（全部为 FAIL，除注明外）

- 任一阶段 `observed: false` → FAIL（`<stage>:reported_false`）。
- 来源不在该阶段的允许集合 → FAIL（`<stage>:wrong_source(...)`）。
- 阶段时间戳倒序 → FAIL（`chain:out_of_order`）。
- `providerSessionId` 与记录头不一致 → FAIL（`session:mismatch(...)`）；**缺失**则是
  `UNKNOWN`（`session:absent`）——缺证据和自相矛盾不是一回事，不许合并。
- `runId` / `taskId` 重复 → FAIL（`duplicate_run:` / `duplicate_task:`）。
- 两轮时间窗重叠 → FAIL（`overlap:190/191`）：闭环一次只应有一条在跑。
- `redispatched.taskId` 不指向下一轮的实际 `taskId` → FAIL（`redispatch:does_not_lead_to_round_N`）。
- 任一阶段 `observed` 缺失/`null` → `UNKNOWN`（`<stage>:not_observed`）。
- 来源是 `fixture` / `mock` / `test` / `synthetic` / `replay` → **`UNKNOWN`**，不是 PASS：
  模拟数据永远不能充当实机证据。

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

验收判据与本文档一致：**页面可见性与独立复核只能由人/对方给出**，Service 自身的 ACK 不得被计为送达。
