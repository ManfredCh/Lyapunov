# SO-101 抬升失败分叉实验

从上一轮 [桌面分拣配对评测](../so101-paired-evaluation/README.md) 的两个归档批次重建下降前状态。将同一个 MuJoCo 积分状态恢复到独立世界，分别执行原下降、提高抓取高度 4 mm、分段下降及两者组合。相同高度的分支共享终点关节目标。所有分支共享下降时长 0.55 秒和闭爪、抬升动作窗口。分段路径使用三个 Cartesian 中间点求逆解。

参考分支读取历史记录的场景、关节端点和动作步号，再由原生 Worker 从第 0 步推进。上一轮没有保存完整积分状态。每个案例在本轮生成一份 `pre-descent-state.npy`，分支复用该快照并重新运行。24 个参考分支均重复运行，逐步接触轨迹和终态哈希相同，抬升结论均与历史回执吻合。

| 方式 | 诊断批次 | 跨种子复跑 | 合计 |
| --- | ---: | ---: | ---: |
| 原下降 | 8/12 | 10/12 | 18/24 |
| 抬高 4 mm | 10/12 | 11/12 | 21/24 |
| 分段下降 | 11/12 | 11/12 | **22/24** |
| 抬高并分段 | 11/12 | 10/12 | 21/24 |

分段下降救回 4 次失败，原参考组已通过的案例均保持通过。参考失败时，夹爪固定侧与目标接触、目标与台面接触，肩部原生执行器持续饱和。三次在诊断批次中被分段救回的下降，饱和步数由 305、304、320 降为 0、0、1。`stress-5039`、`stress-2243` 在分段后仍失败。离线短试抬指标与完整抬升结论一致 95/96，有一次早期通过而后续失败。验证范围为夹持抬升，完整入盒、真实机器人和故障注入待验证。

## 复跑

在 Dev 仓库根目录运行 [分叉入口](run.py)。需要 MuJoCo 3.13.0、Mink、SciPy、原 SO-101 模型及其网格。媒体需要 EGL 和 ffmpeg。历史归档由 `script/gates/run-so101-paired.ts` 生成。

```bash
/path/to/sim-python/bin/python research/so101-grasp-fork/run.py \
  --archive /path/to/so101-paired/heldout --out /path/to/new-diagnostic --media
/path/to/sim-python/bin/python research/so101-grasp-fork/run.py \
  --archive /path/to/so101-paired/v2 --out /path/to/new-cross-seed --media
python research/so101-grasp-fork/report.py \
  --diagnostic /path/to/new-diagnostic --cross-seed /path/to/new-cross-seed
```

[结果摘要](summary.json) 可在仓库内查看。[原始证据清单](evidence.json)记录两个批次的本机路径和摘要哈希，回放页收录全部 96 段 MP4 与逐步接触回执。设计参考 [Gauntlet 的分叉流程](https://github.com/google-deepmind/robotics-antigravity-plugin/blob/9cb7f624c4d7c50859a39f1d49d088990429a83d/plugins/robotics/skills/sim2real-gauntlet/src/robosim_gauntlet/episode.py#L279)。
