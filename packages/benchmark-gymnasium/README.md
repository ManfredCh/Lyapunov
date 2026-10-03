# @lyapunov/benchmark-gymnasium

可选的外部 Gymnasium Ant-v5 benchmark Provider。它只通过 `bench_*` 工具与
`sim` 契约暴露官方 `gymnasium.make("Ant-v5")` 环境，默认 Profile 不会加载它，
也不会在未显式选择 Provider 时导入 SDK 或启动 Python worker。

## 隔离与失败关闭

- SDK 位于显式隔离目录（默认 `.runtime/bench/gymnasium-env`）。`bench_prepare`
  只检查 `import gymnasium` 与官方 `Ant-v5` action/observation 形状；缺失时返回
  `BLOCKED / GYMNASIUM_SDK_UNAVAILABLE`，不会自动安装、不会换端点下载。
- worker 在模块加载阶段不导入 SDK；只有 `bench_load` 显式 `open` 才
  `import gymnasium` 并 `env.reset(seed)`。
- 请求的 `horizonSteps` 必须与官方 `TimeLimit` 的 `_max_episode_steps` 相等，
  否则 `GYMNASIUM_HORIZON_MISMATCH` 失败关闭，初始化中的 env 会被关闭。

## 终态与累计回报

| 官方信号 | worker status | 工具链视图 | 说明 |
| --- | --- | --- | --- |
| `terminated=true` | `failure` | `result.status=failure`、`terminal.reason=terminated` | 官方 healthy 判定失败（躯干 z 越界或状态非有限） |
| `truncated=true` 或到达 horizon | `timeout` | `result.status=timeout`、`terminal.reason=horizon` | 官方 `TimeLimit` 截断（1000 步） |
| 运行中执行 `stop` | `cancelled` | `terminal.reason=cancelled` | 保留已到达的终态，若当时已终态则只补释放事实 |
| 未终态直接 `close` | `closed` | `terminal=null` | worker 直接 close 且从未 stop；产品路径 `bench_close` 会先 stop 再 close（transport 契约），记录为 `cancelled` + `release.reason=close`，不伪造官方终态 |

Ant-v5 没有二值 `check_success`：`success` 恒为 `false`，`taskAchieved` 恒为
`false`，`score.kind` 是 `score-only`。累计回报 `episodeReturn` 是官方每步
reward 的累加，并写入记录；终态后再次 `bench_step` 会得到
`BENCHMARK_EPISODE_TERMINAL`。

## Episode 产物

每个 episode 在 `<outputRoot>/<episodeId>/` 下产出：

- `episode.json`：最终分数记录。含 `status/terminated/truncated/stepIndex`、
  `score{episodeReturn,stepCount,meanReward,rewardTerms}`、`terminal`、
  `release`、`closed{envClosed}`、`recording`、`trajectory` 摘要。终态步与
  `stop/close` 时原子重写（临时文件 + `os.replace`）。
- `steps.jsonl`：追加写入的逐步轨迹：动作、官方 reward、运行累计回报、
  terminated/truncated、躯干位置/速度、reward 分项与帧路径。轨迹写入失败不会被
  后续成功的 `episode.json` 抹掉：记录与回执都带
  `trajectory{steps,lines,failures,complete,error}`（回执为
  `trajectoryError/trajectoryLines/trajectoryFailures/trajectoryComplete`），
  缺行时 `complete=false` 且 `error` 保留首个失败原因。
- `generation-1/step-%06d-antview.png`：官方 `env.render()` 录制帧；渲染不可用
  时记录 `recording.renderAvailable=false` 与 `renderError`，不伪造帧数。

`bench_result` 返回 `episodeReturn/terminated/truncated/terminal/recording/record`；
`bench_close`（= `sim.close → release`）关闭世界并由该路径回收 episode 独占的
Python worker：`close(worldId)` 自身完成 `transport.close` + `transport.dispose`，
`close→dispose` 标准路径不再泄漏子进程。关闭或回收失败时不会声称 `closed`，
而是抛 `GYMNASIUM_CLOSE_FAILED` 并说明失败环节（`world close` / `worker dispose`）。

## 测试

```bash
# 受控映射测试（不启动真实 SDK）
bun test packages/benchmark-gymnasium/test/adapter.test.ts packages/benchmark-gymnasium/test/episode-record.test.ts

# worker 记账测试（真实 worker 代码 + 桩环境，仅验证状态机/记录，无物理含义）
.runtime/bench/gymnasium-env/bin/python packages/benchmark-gymnasium/python/test_worker_protocol.py

# 真实官方 SDK 有界验收（完整 episode、终态、记录、释放与进程回收）
LYAPUNOV_GYM_LIVE_OUTPUT=<保留目录> bun test packages/benchmark-gymnasium/test/live-episode.test.ts

# 标准 close→dispose 回收验收：真实 SDK 载入后 0 步关闭，验证 worker 进程退出
bun test packages/benchmark-gymnasium/test/live-close-reclaim.test.ts
```

`live-episode` 用受控 torque（零基线 / 固定非零）驱动官方环境，验证的是
benchmark 工具链，不是 DSH 内部 Agent 的自主策略；通过不等于 Agent 解题成功。
`python/test_worker_protocol.py` 注入桩环境的用例只覆盖记账，不得作为真实
Ant-v5 物理或任何 benchmark 成绩引用。
