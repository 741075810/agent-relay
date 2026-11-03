# 开机自启与异常恢复：relay service + sidecar（T221）

T219 把 relay 装到了生产路径上，但两个进程是手工启动的：它们的存活只因为启动它们的 shell
退出了，没有服务、没有计划任务、也没有任何东西在崩溃后把它们拉回来。本文件记录 T221 加上的
那一层，以及为什么它只是"用户态的两个计划任务 + 一个幂等的协调器"，而不是一套服务。

## 1. 目标与非目标

| 目标 | 做法 |
|---|---|
| 用户登录后自动起来 | 计划任务 `DSH-Relay-Supervisor`，触发器 `ONLOGON` |
| 意外退出后恢复 | 计划任务 `DSH-Relay-Supervisor-Tick`，每 2 分钟一次 |
| 不会出现第二套 relay | 每个 install 目录一个内核 mutex，加 `--adopt` 接管已在跑的进程 |
| 可停止、可回滚 | 删两个计划任务即可；不留服务、不留注册表、不留启动项 |
| 最小权限 | 当前用户、`LogonType=Interactive`、`RunLevel=Limited`（不提权）、不保存密码 |
| 不碰同意状态 | 只启动进程，`state\`、arm 快照、Bridge 库对它只读 |

非目标：不做 Windows 服务（要提权、要 SCM 交互）；不接管 native host 的生命周期（Chrome 拥有它）；
不做第二套通知路径——supervisor 不认识"完成事件"这个概念。

## 2. 组成

```
tools/service/relay_supervisor.py     协调器：一次 --once 或常驻 --loop
<INSTALL>\relay_autostart.json        配置：repo 路径、install 路径、pollMs、python、sidecarArgs
<INSTALL>\relay\service.pid           协调器启动/接管的 service pid
<INSTALL>\relay\sidecar.pid           协调器启动/接管的 sidecar pid
<INSTALL>\relay\supervisor.json       最近一次的状态（健康、动作、不含 token、不含扩展 id）
<INSTALL>\relay\supervisor.log        追加日志，超过 512 KB 轮转一份 .1
```

`relay_autostart.json` 里没有秘密：只有路径、一个轮询毫秒数和一个 python 解释器路径。token 仍然只在
`relay\service.token` 里，协调器把它以**文件路径**转交给 sidecar，与 launcher 的做法一致。

## 3. 一次协调做什么

```
读 relay.txt                     缺失或不足两行        -> relay_unconfigured，什么都不启动
读 host_manifest.json 的 origin   没有 allowed_origins   -> manifest_missing，什么都不启动
列本安装的进程清单（CIM 命令行）  查询失败               -> inventory_unavailable，不动任何进程
token 缺失 + 端口已在监听         （service 在、token 没了）-> token_missing，不启动 sidecar
带 token 探 /health              200                    -> service_healthy（pid 与清单一致，否则顺手 service_adopted）
                                 连不上                  -> 启动 service，等它写出 token，再探
                                 401/403 + 能证明是本安装的 service
                                                        -> service_token_rotated -> 杀掉它 -> service_restarted -> 重探
                                 401/403 + 证明不了        -> service_unauthorized_foreign，不碰那个监听者
sidecar.pid 在清单里且是本安装的 sidecar                      -> sidecar_alive
              pid 活着但不是本安装的 sidecar（pid 被复用）    -> sidecar_pid_foreign，再按清单找
              清单里恰好一个真 sidecar                        -> sidecar_adopted
              清单里多于一个                                  -> sidecar_ambiguous，拒绝再加第三个
              清单里没有                                      -> 启动 sidecar
写 supervisor.json
```

顺序上的一个坑：全新安装时 token 还不存在，是 service 第一次启动时生成的。所以"token 缺失"只有在
**端口已经有人监听**时才构成拒绝；否则正是由 service 来生产这个文件。删掉这条区分会让冷启动永远起不来，
`test_starts_the_pair_then_leaves_it_alone` 就是钉这条的（去掉 `listening(...)` 它会红）。

`401/403` 这个分支是"token 文件在运行中被换掉"的真实形态：service 在启动时把 token 读进内存（`relay_service.mjs`
第 154 行：文件存在就用文件里的值），此后与文件不再同步，于是每一轮都是 401。修复只有一条——**重启 service**，
让新进程重新读那份文件。但重启前必须先证明"这个监听者归本安装所有"：

1. `service.pid` 里的 pid 在进程清单里且命令行含本安装路径 + `relay_service.mjs`；或
2. 清单里恰好只有一个 `relay_service.mjs` 属于本安装。

两条都不成立就是 `service_unauthorized_foreign`：那个端口上是别人的程序（或者是我们的 service 已被别的东西取代），
去杀它是**对无法识别的程序动手**，所以只记录、不操作、也不启动 sidecar。杀掉之前还会再查一次清单
（`managed_kill`），身份在检查与动手之间变了就记 `service_restart_refused`。T221 之前的说法
（"协调器下一步就会做"）是错的：那一版只是记下 `service_unauthorized` 就返回，每两分钟重复一次，永远不会自愈。
这部分在 T222 修正，`test_a_rotated_token_restarts_the_service_this_install_owns` 与
`test_unauthorized_from_a_listener_this_install_does_not_own_is_refused` 分别钉住两条边。

### 3.1 进程身份，而不是"这个 pid 还活着"

旧实现用 `tasklist /FI "PID eq N"` 的输出里是否出现这个数字来判断 sidecar 活着。问题是 pid 会被复用：
sidecar 死了、pid 被别的程序接手，协调器就永远认为 sidecar 在跑，于是**再也不重启它**，而且每次都说成功。

现在的判据是命令行：一次 CIM 查询列出所有 `node.exe`，只有命令行**同时**含本安装的绝对路径与
`relay_service.mjs` / `host_mirror.mjs` 的进程才被认作本安装的 service / sidecar。由此得到：

| 情形 | 行为 |
|---|---|
| pid 在清单里，kind 对 | `sidecar_alive` / `service_healthy` |
| pid 活着但不在清单里 | `sidecar_pid_foreign`，然后按清单找真正的那个 |
| 真 sidecar 在、pid 文件写错 | `sidecar_adopted`（改写 pid 文件，不启第二个） |
| 一个都没有 | 启动；启动后 pid 由清单确认 |
| 清单查询失败 | `inventory_unavailable`，什么都不启动——"我没查到"不能变成"没有在跑" |


## 4. 为什么是这两个任务，而不是一个

`schtasks` 一次只能给一个 `/SC`。所以：

| 任务 | 触发 | 作用 |
|---|---|---|
| `DSH-Relay-Supervisor` | `ONLOGON` | 登录即拉起，覆盖"重启后" |
| `DSH-Relay-Supervisor-Tick` | `MINUTE /MO 2` | 覆盖"进程崩了但没人登录/没重启" |

两者都是 `--once`，幂等；重叠时由 mutex 让后到者以 `already_running` 退出（退出码 0，不写日志噪音之外的任何东西）。
`/IT`（interactive only）是刻意的：任务只在用户会话里跑，不需要保存密码、不需要批处理登录权。

## 5. 接管已经在跑的进程：`--adopt`

T219 的两个进程是手工起的，没有 pid 文件。如果直接让协调器 reconcile，它会看到一个没有 pid 文件的
sidecar 而去启动**第二个**——两个 sidecar 会重复投递候选。所以第一次运行用的是：

```
python -B tools/service/relay_supervisor.py --adopt --install-dir <INSTALL>
{"code": "adopted", "found": {"service": [18664], "sidecar": [25716]}, "ok": true}
```

`--adopt` 用 CIM 查询 node 进程的命令行（`wmic` 已在新 Windows 上缺席，静默空结果看起来和"没在跑"一模一样，
那正是会启动重复进程的答案），按 install 路径匹配，写 pid 文件；找到 0 个或同种多个都算拒绝
（`adopt_nothing_found` / `adopt_ambiguous`），绝不"以为没有"。

## 6. 生产实测（2026-11-03 22:16–22:17）

| 步骤 | 结果 |
|---|---|
| 注册两个任务 | `SUCCESS`，`logon=Interactive`、`level=Limited`、`action=pythonw.exe`，无提权、无密码 |
| 跑 ONLOGON 任务 | `result=0`，`service_healthy` + `sidecar_alive pid 25716`，进程数仍是 2（接管生效，无重复） |
| 杀掉两个进程 | service 0 / sidecar 0 |
| 跑 Tick 任务 | `service_started pid 27216` -> `sidecar_started pid 44752`，`health: healthy` |
| sidecar 恢复后 | 轮询 `{"ok":true,"status":200,…,"acked":76}`，`relay.json` seq 76 |
| native host | PID 33076（21:56:36）未受影响 |
| readiness 审计 | `decision: GO`、`blocking_failed: []`、`armPrecision: ms` |

隔离演练（`test_t095b221_relay_supervisor.py`，16 项，真实 node 进程 + 临时 install + 空 `--native-root`）：
unconfigured 拒绝、manifest 无 origin 拒绝、token 在端口占用时缺失拒绝、启动服务再启动 sidecar、
第二次 reconcile 不动已活的进程、service 被杀只重启 service、sidecar 被杀只重启 sidecar、
常驻 loop 占用时第二个实例 `already_running`、`--adopt` 记录在跑的 pid 且空时拒绝、
**同意快照逐字节不变**、**token 值不出现在协调器写的任何文件里**（`supervisor.json` 只记
`originPresent`/`originLength`，不记扩展 id 的任何字节）。

T222 追加的五项（都在真实进程上跑，用真的 pid 复用、真的 401 监听者、真的无关进程）：

| 测试 | 钉住的行为 |
|---|---|
| `test_a_rotated_token_restarts_the_service_this_install_owns` | token 文件被换 -> 服务被重启、恢复 healthy、sidecar pid 不变 |
| `test_unauthorized_from_a_listener_this_install_does_not_own_is_refused` | 401 且无归属 -> `service_unauthorized_foreign`，监听者仍活着，不起任何 service |
| `test_a_reused_pid_is_not_mistaken_for_a_live_sidecar` | pid 被无关进程复用 -> `sidecar_pid_foreign` + 启动真 sidecar，无关进程不被杀 |
| `test_a_wrong_pid_file_adopts_the_running_sidecar_instead_of_adding_one` | pid 文件写错但真 sidecar 在 -> `sidecar_adopted`，sidecar 数量仍是 1 |
| `test_an_unreadable_process_inventory_is_a_refusal` | 清单查询失败 -> `inventory_unavailable`，什么都不启动 |

红灯证明（两次演练都以退出码判定，恢复后源文件逐字节还原）：
去掉 token 判断里的端口条件 -> `test_starts_the_pair_then_leaves_it_alone` FAILED(exit 1)；
mutex 名里加入 pid -> 单实例测试 FAILED(exit 1)；
`kind` 退回 `pid_exists(pid)` -> `test_a_reused_pid_is_not_mistaken_for_a_live_sidecar` FAILED(exit 1)；
`401` 分支不再要求归属证明 -> `test_unauthorized_from_a_listener_this_install_does_not_own_is_refused` FAILED(exit 1)。

### 6.1 T222 在生产上的只读复核（2026-11-03 23:12）

```
python -B tools/service/relay_supervisor.py --once --install-dir <INSTALL>
{"actions":[{"code":"service_healthy","detail":"pid 27216"},
            {"code":"sidecar_alive","detail":"pid 44752"}],"code":"ok","ok":true}
```

`pid` 现在来自命令行核验，而不是"这个数字在 tasklist 里出现过"。本轮没有对生产做任何故障注入：
没有杀进程、没有改 token、没有动 `state\`、没有动扩展。<INSTALL> 的两个计划任务仍在，触发器与 principal 未变。


## 7. 启动顺序与重复触发

- **登录 + Tick 同时到**：mutex 让一个 `--once` 跑，另一个退出 `already_running`。
- **service 起着、sidecar 没起**：只起 sidecar（`service_healthy` + `sidecar_started`）。
- **端口被别的进程占着**：探活失败 -> 起 service -> service 起不来（端口占用）-> 探活仍失败 ->
  `service_unreachable`，sidecar 不启动。日志里能看出是端口问题，不是授权问题。
- **两个 install 目录**（演练与生产并存）：mutex 名带 install 路径的 sha1 前 12 位，互不阻塞。
- **Chrome 没开**：与 relay 无关。sidecar 直接读 Bridge 库；native host 由 Chrome 拉起。

## 8. 回滚

```
schtasks /Delete /TN "DSH-Relay-Supervisor" /F
schtasks /Delete /TN "DSH-Relay-Supervisor-Tick" /F
```

删完即回到 T219 的形态（两个手起进程继续跑，只是不再有自动恢复）。配置备份在
`...\chatgpt_handoff\221-backup-<stamp>\`（`relay\`、`relay.txt`、`terminal-arm.json`、
`PRESTATE.txt` 记录当时的 pid 与"无计划任务"这一事实）。要连 relay 一起去掉：停两个 node 进程、
删 `relay.txt`，launcher 的命令行就回到没有 `--relay-*` 的形态（见 T217 的 switch log §2）。

## 9. 仍然不算"24×7 无人值守"的部分

- 计划任务只在**用户登录**后有效。机器重启到登录界面时，relay 不跑；登录后 2 分钟内起来。
  要真正做到无人值守需要服务或批处理登录权，那要提权，属于另一层决定。
- 协调器看到的是**进程存活**，不是"投递成功"。`pageDelivery` 永远是 `unknown`，`health` 只是回环
  `/health` 的 200。这两件事不能互相顶替。
- 杀掉 service 会丢掉它内存里的 `seen`/`runs` 计数，靠 `relay.json` 重建；`acked` 计数因此可能回落，
  但已 ACK 的 run 不会被重新当作新候选投递（快照与基线在 host 的 `state\` 里，协调器不碰它）。
