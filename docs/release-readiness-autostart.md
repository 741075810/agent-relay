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
带 token 探 /health              200 且回包是 relay 信封  -> 有归属则 service_healthy / service_adopted
                                 200 但不是 relay 信封     -> service_not_a_relay，不启动 sidecar
                                 200 但无本安装进程归属    -> service_healthy_unowned，不启动 sidecar
连不上 + 本安装没有 service                            -> 启动一个，等它写出 token，再探
连不上 + 本安装恰好一个 service                        -> service_unresponsive：等 8 秒；
                                                          端口仍被别人占着 -> 拒绝，不杀不启
                                                          端口空着 -> 停它（须核实退出）-> service_restarted_unresponsive
连不上 + 本安装多于一个 service                        -> service_ambiguous，拒绝
                                 401/403 + 能证明是本安装的 service
                                                         -> service_token_rotated -> 停它（核实退出）-> service_restarted -> 重探
                                 401/403 + 证明不了        -> service_unauthorized_foreign，不碰那个监听者
停进程后核对退出                 清单查询失败             -> service_stop_unverified，**不启动替代者**
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
（`stop_managed`），身份在检查与动手之间变了就记 `service_restart_refused`。T221 之前的说法
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

隔离演练（`test_t095b221_relay_supervisor.py`，21 项，真实 node 进程 + 临时 install + 空 `--native-root`）：
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

### 6.0 T223 追加的五项

| 测试 | 钉住的行为 |
|---|---|
| `test_a_failed_inventory_after_the_kill_is_not_taken_for_an_exit` | 停进程后清单查询失败 -> `service_stop_unverified`，**不启动替代者**，旧 service 确实已死、端口空置 |
| `test_unreachable_health_with_an_owned_service_replaces_it_instead_of_adding_one` | 健康不可达但本安装的 service 还在 -> 不是 `service_started`（不并存第二个），而是核实退出后 `service_restarted_unresponsive`，事后恰好一个 service |
| `test_unreachable_health_with_a_held_port_kills_nothing` | 端口被别的监听者占着且不回应 -> `service_unresponsive`，那个还活着的 service 不被杀 |
| `test_a_healthy_listener_this_install_does_not_own_is_not_ready` | 200 但没有本安装的进程归属 -> `service_healthy_unowned`，不启 sidecar、不杀外来监听者 |
| `test_a_two_hundred_without_the_relay_envelope_is_not_healthy` | 200 但回包不是 relay 信封（无 `ok`/`version`）-> `service_not_a_relay` |

对应的三处红灯：把"查询失败"读成"已退出" -> 第 1 项 FAILED(exit 1)；`unreachable` 分支不看已有
service 就 spawn -> 第 2 项 FAILED(exit 1)；任意 200 都算健康 -> 第 5 项 FAILED(exit 1)；恢复后均 exit 0，
源文件逐字节还原。

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

## 10. T225：每两分钟闪一次的 shell 窗口

症状：用户报"电脑一直有 Windows shell 窗口弹出来"，频率与 `DSH-Relay-Supervisor-Tick`（`PT2M`）对齐。

证据链（只读）：

```
计划任务 action      pythonw.exe -B <REPO>\tools\service\relay_supervisor.py --once --install-dir <INSTALL>
触发周期             MSFT_TaskTimeTrigger / PT2M；ONLOGON 那条 action 完全相同
运行中的父子关系     pythonw.exe 9000 (parent 2648 = Task Scheduler) -> powershell.exe 11272 (parent 9000)
```

`pythonw.exe` 自己没有控制台。控制台子进程从无控制台的父进程启动时，Windows 会给它**新分配一个控制台**，那就是
一闪而过的窗口；`subprocess.run` 从未请求 `CREATE_NO_WINDOW`。每次 tick 至少一个 `powershell.exe`（CIM 进程
清单），需要核对 pid 时再加 `tasklist.exe`，真要杀进程时再加 `taskkill.exe`。从终端手工跑同一份代码看不到这个
问题——父进程有控制台，子进程只是复用它、不新建窗口，这就是它一直没被测出来的原因。

实测（父进程 `pythonw.exe`，问子进程自己的控制台窗口是否可见，即 `GetConsoleWindow()` + `IsWindowVisible`）：

| 启动方式 | 子进程控制台窗口 |
|---|---|
| 旧的 `subprocess.run(...)` | **VISIBLE** |
| 新的 `run_hidden(...)` | `no-console-window` |
| 从有控制台的终端启动（对照组） | `hidden`（复用父控制台，不新建） |

修复：`relay_supervisor.py` 新增 `run_hidden()`，Windows 上带 `CREATE_NO_WINDOW` 与
`STARTUPINFO{STARTF_USESHOWWINDOW, SW_HIDE}`，其它平台不传任何 Windows 专属参数。四个控制台调用点
（`find_processes` 的 powershell、`pid_exists` 的 tasklist、`kill_pid` 的 taskkill、`spawn` 的 node）全部经由它；
`spawn` 原有的 `DETACHED_PROCESS|CREATE_NEW_PROCESS_GROUP` 保留，另加同一份 `STARTUPINFO`。捕获输出、真实 pid、
退出码与全部拒绝码不变——这一层只影响窗口，不影响任何判断。

测试（`test_t095b221_relay_supervisor.py` 24 项，本轮新增 3 项）：

| 测试 | 钉住的行为 |
|---|---|
| `test_a_console_child_of_a_console_less_parent_gets_no_window` | 在 `pythonw.exe` 父进程下，旧路径必须复现 `VISIBLE`、新路径必须是 `no-console-window` |
| `test_every_console_child_goes_through_the_hidden_helper` | AST 断言：除 `run_hidden` / `spawn` 外，任何函数再出现 `subprocess.run/Popen/call/check_output/check_call` 即失败 |
| `test_run_hidden_asks_windows_for_no_window` | `creationflags == CREATE_NO_WINDOW`，`startupinfo` 带 `STARTF_USESHOWWINDOW` 与 `SW_HIDE` |

红灯：删掉 `run_hidden` 里那两个 Windows 参数 → 探针测试 FAILED；恢复后 OK，源文件逐字节还原。

处置顺序（本次实际执行）：先 `schtasks /Change /TN "DSH-Relay-Supervisor-Tick" /DISABLE` 止血——service 与
sidecar 保持运行，不重启、不杀、不动授权；改代码、跑测试与门禁；再 `/ENABLE` 并 `schtasks /Run` 复核一次。登录自启
那条（`DSH-Relay-Supervisor`，ONLOGON）用的是同一份脚本，无需另改。

回滚：`git revert` 本轮提交即恢复旧行为（计划任务读的就是仓库里这份脚本，不需要重新部署）；若只想回到"没有窗口修复"
的状态，`schtasks /Change /TN "DSH-Relay-Supervisor-Tick" /DISABLE` 可再次止血，代价是失去每两分钟的自愈检查。

## 11. T226：T225 之后仍在闪的窗口，是 sidecar 每 20 秒拉起一次 python host

T225 只修了 coordinator 自己的子进程。用户复验仍在闪，所以这一轮不再靠推理，改为观测：一个只读观察器
（EnumWindows + IsWindowVisible + Toolhelp 进程表，自身不起任何子进程、不记录窗口标题）跑了 12 分钟，
覆盖 6 个 tick 周期。

第一次（修复前）：

| 可见控制台窗口 | 数量 | 归属 |
|---|---|---|
| PseudoConsoleWindow / python.exe | **24** | 父进程是 
ode.exe 44752，即 relay sidecar（--poll-ms 20000），中位间隔 **20.5 s** |
| PseudoConsoleWindow / powershell.exe | 1 | 父进程是 WindowsTerminal，是观察者自己的宿主，不是本项目 |

根因在 	ools/service/host_mirror.mjs 第 57 行：spawn(host.python, args, { stdio: [...] })，Node 的
windowsHide 默认 **false**。sidecar 自己是 detached、无控制台，于是每个子控制台程序都被分配一个新控制台 ——
一个新控制台就是一个窗口，每 20 秒一次。
elay_candidate_intake.mjs 是同一个形状，同样的问题。两处都加了
windowsHide: true。

同时清掉两个 10 月遗留、仍在每 2 分钟触发的任务：DSH-WatchTasks-A-120s 用的是 python.exe（控制台程序），
改为 pythonw.exe 并给它的内层 subprocess.run 加 CREATE_NO_WINDOW；DSH-NotifyFlush-Bridge 本来就是
pythonw，且不起子进程。两个任务的定义都先导出到 inbox\backup-t226\*.xml 再改。

第二次（修复后，13 分钟）：可见窗口 5 个 —— 3 个是 WindowsTerminal（观察者宿主），1 个是它下面的 powershell，
剩下 1 个是**回归测试里那条对照用例**故意复现旧行为造成的。sidecar 在这段时间起了 29 个子进程（13 个 python.exe、
15 个 conhost），**没有一个拥有可见窗口**。于是再改一条：对照用例改为 opt-in（DSH_T226_VISIBLE_CONTROL=1），
守护断言不变 —— 测试自己也不许在桌面上弹窗。

复查工具（随仓库走，只读）：

`
pythonw.exe -B tools/service/console_window_probe.py --seconds 780 --out windows.jsonl
`

输出每行一条 JSON：kind（start/window/proc/stop）、时间戳、窗口类名、pid、以及 
ame(pid) <- parent <- ... 的
父子链。只记类名不记标题、不记命令行，避免把用户屏幕上的内容写进日志。
