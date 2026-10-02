# sim-contract：仿真 Provider 的公共合同与 python 行协议传输

本包只有两件事：各引擎共享的 `SimService` 类型合同（`src/index.ts`），以及把 Python worker 当
**owned child process** 管的行协议传输（`src/python-transport.ts`）。Isaac / MuJoCo / Newton 的
provider 都在这层之上，不各自造一套进程生命周期。

## 行协议

每行一个 JSON。Node→worker：`{id, method, args}`；worker→Node 两种：

- 请求回复：`{id, result}` 或 `{id, error:{code,message}}`；
- 主动事件：`{event:'ready'|'fatal'|'receipt'|'frame'|'phase'|'protocol-error'|'cache-preflight', …}`。

`phase` 是启动/关闭的**阶段事件**（`{event:'phase',phase,elapsedS}`），只用于归因，不触发任何
自动动作：某个阶段久无进展**不是**终止理由。

## 启动 / 退出语义（83 的“零输出卡住约 3 分钟”之后的边界）

- **只由显式动作结束**：调用方取消（`open(snapshot, options, signal)` 的 `signal`）或显式配置的
  启动预算到期。二者都会给出 `pid / 等待时长 / 最后阶段 / 阶段轨迹 / 现有 stderr 尾部`摘要；不会有
  悬空 Promise，也不会留下孤儿进程或孤儿世界。
- **取消不越界**：只有**确实独占**这个 child 的启动才会被整进程终止（本次启动自己起的、且这个 worker
  上还没有任何已交付 world——Isaac 每 world 一个 owned child 就是这条）。一个 worker 复用多个 world
  时（如 MuJoCo），取消新的 `open` 只结束**本次 open**：worker、已交付的 world 与帧一律不动，worker
  迟到建出来的那个世界会被就地关掉。排队未开始的 `open` 被取消时立刻返回，既不启动也不结束任何
  worker。
- **清场不看句柄表**：迟到世界的清理判据只有「这个 child 还是不是当前 worker」。`handles`/`worlds`
  不能当「已经交付」用——普通的 `listWorlds()` 轮询（UI 常做）会把 worker 的世界照单采纳进来，靠它
  判断就会跳过 `close`、留下孤儿。清理与排队取消都排在既有 `openQueue` 上：取消者立刻返回，而同一
  `openQueue` 上的后续操作（同 id 的新 `open`）在迟到的清场之后才轮到，两者不会互相覆盖。
- **open 之前的追加步骤也要被取消打断**：`open`/`sync` 之前的 `syncArgsExtras`（MuJoCo 的碰撞补丁
  编译）与取消竞速，编译很久也不会让调用方一直等；晚到的编译结果既不会发出本次 `open`，也不会写进
  下一次 `open` 用的缓存（钩子拿到的 `signal` 已 aborted）。没有自动超时看门狗。
- **ready 之后的真实故障**：worker 真的退出、发 `fatal` 或管道断裂时，终态错误登记进 Provider，
  **全部在途请求被拒绝**（不会挂在 pending 上），失效的 world/帧句柄被清掉，终态前不会自动重启。
- **没有看门狗**：没有“多久没输出就杀”的逻辑。观察轮询超时、慢 `observe`、启动期静默都只表现为
  “继续等”。一个仍然有效的 worker 不会因为暂时没有新输出被杀。
- **不自动重试**：启动失败后 Provider 进入终态错误，后台调用只会沿用同一个错误；**只有显式新
  `open`** 才会重新起 worker（`prepareExplicitOpen`）。取消同样不产生任何重启。

| 配置 | 语义 | 默认 |
| --- | --- | --- |
| `startupBudgetMs` | 显式启动预算；到期即按上表结束本次启动，错误码 `PROVIDER_START_TIMEOUT` | 无（不设上限） |

必须为正的有限毫秒数，配错直接 `RangeError`，不静默当成没配置。**没有环境变量入口**：产品路径里配置
要经既有可信装配到达 Provider。本仓当前的 Isaac 装配（`packages/sim-isaac`）**还没有** `startupBudgetMs`
入口、也没有把调用方 `signal` 传进 `open`，所以那边走的就是这里的两条默认（不配置预算 = 一直等 ready，
不给 signal = 不取消）——既有 Isaac 调用约定的行为不变；Isaac 侧接线等真 Kit 那一轮。**不设默认值**是有意的：
Isaac RTX 冷缓存冷启动实测约 270s，凭空给默认上限会杀掉有效启动。

## dispose：正常等真回执，尚未 ready 的不悬空

- **正常关闭**：发出 `shutdown`、关 stdin、**等进程真实退出**，等多久由 Kit 自己决定；不靠强杀冒充
  正常关闭。（83 报告里的“close 200s+”是累计计时口径，复算后的真实 close 约 1s，见 91 REPORT §1.2。）
- **尚未 ready 时 dispose**：worker 卡在启动、根本不会回复 shutdown 时，无限等就是悬空 Promise
  （已在基线版本上最小复现）。这条路径按归属结束本 Provider 自己尚未交付的进程——复用既有
  `failProvider`→`terminateOwned`，与「显式取消」同一机制；调用方的 `open` 拿到 `PROVIDER_CLOSED`
  终态错误，带阶段/pid/stderr 摘要。

## 终态回执

动作终态（`terminalResults(worldId)`）在 `close`/`dispose` 之后仍然可读，不因为关世界或强杀丢失；同一
`worldId` 被重新开成新世界时才清理**上一次**留下的终态（本次 open 请求之后到达的回执属于新世界，保留）。
被取消的 open 若迟到建出了世界（见「取消不越界」），它自己带上来的终态回执同样不属于任何已交付的
世界，会被一起清掉；该 `worldId` 上更早那个世界的回执不受影响。

## 测试

`test/startup-lifecycle.test.ts` 用可编排的假 worker（`test/fixtures/fake-worker.py`）逐条复现 delayed
ready / 显式取消 / 显式预算 / 真实 fatal / 真实 exit / 迟到旧 ready / 正常 SDK 关闭 / 尚未 ready 时
dispose / ready 之后交付之前取消 / 静默不判死 / 慢观察不判死 / ready 之后的 exit·fatal·管道断裂·自行死亡 /
共享 worker 上的取消隔离 / 排队取消 / 取消期间普通 `listWorlds` 轮询不放过孤儿 / 同 id 新 open 排在迟到
清场之后 / 慢 extras 期间的取消。它证明的是**生命周期由显式取消或显式预算触发**，不是由观察超时触发；
引擎侧物理/渲染行为由各 provider 自己的真实测量覆盖。

MuJoCo 侧另见 `packages/sim-mujoco/test/open-cancel.test.ts`（真实 `MuJoCoProvider` + 假 worker，
可控慢编译）：取消只清本次的碰撞缓存条目、不碰其他 world/并行 sync，正常路径与共用 worker 的隔离不变。
真实引擎的取消/清场另有一次性探针（110 任务 `evidence/mujoco-cancel-probe.ts`）：真 MuJoCo open→
显式/自动 worldId 取消→迟到世界被清掉→新 open 照常，已交付 world 全程可观察。

注：管道断裂那条用「销毁本 Provider 那个真子进程的 stdin 写端」触发——bun 不会把「子进程关掉自己
stdin」报成写错误（写回调仍成功、也没有 `error` 事件，实测见 105 任务证据 `evidence/pipe-probe*.ts`），
所以那个现场无法从传输层观测，测试改用同一代码路径上可观测的触发点。
