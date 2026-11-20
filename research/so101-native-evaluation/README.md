# SO-101 原生集成验收

本批次在 Dev 将安全开爪、原生快照分叉、携物净空、模拟故障止损、独立安全评分和 MJCF 审计一起执行。实现与实验结果分开写入 [Agent Graph 合同](../../docs/AGENT_GRAPH_CONTRACT.md) 和 [研究时间线](../../docs/research_log/RESEARCH_LOG.md)。

## 一次批次的结果

| 能力 | 结果 |
| --- | --- |
| 预检并到安全位开爪 | 历史三例的开爪目标接触从 3/3 降至 0/3。一例初态已有夹爪与目标接触，被暂停护栏挡下。三例最终保住目标原位，均未完成入盒。 |
| 完整入盒 | 12 对参考 7/12、候选 6/12。新种子子集 7/9 对 6/9，另一次候选因开爪前净空采样点为负而被拒绝。 |
| 携物净空 | 13 个转运有机器人与载荷相对箱壁和箱底的非侵入采样。最小载荷距离 18.99 mm。 |
| 原生分叉 | 四阶段各从同一积分态分叉两次。八次动作回放分别复核原生开始和结束步，阶段内两次终态哈希一致。 |
| 故障与安全 | 腕相机冻结、夹爪卡滞均被观察并在抬升前停止。低力限反例的任务达成而安全判分不通过。 |
| MJCF 审计 | 开放箱体与杯体通过空腔落体检查，实心封腔反例被识别。正常夹具通过关节行程检查，缩限反例被识别。原始 SO-101 核对六关节、六执行器。 |

完整的回放、证据与运行日志保存在 `/home/s18/WS/Lyapunov/E/so101-native-evaluation-20261120-staged/`，其中 `index.html` 汇总 27 段视频。可用 [摘要](summary.json) 和 [原件清单](evidence.json) 核对。首批与复验采用同一套冻结种子，首批用于定位解除暂停的时序问题，原件也保留在清单中。

## 复跑

从 Dev 工作树执行。需要 Node 24、MuJoCo 3.13.0、Mink、原始 SO-101 MJCF 及其网格目录。回放需要 EGL、ffmpeg 与 ffprobe。

```bash
python research/so101-native-evaluation/run_batch.py \
  --model /path/to/robotstudio_so101/asset/so101.xml \
  --python /path/to/mujoco/bin/python --out /path/to/new-integrated-batch
python research/so101-native-evaluation/report.py --batch /path/to/new-integrated-batch
```

安全分数使用逐物理步的场景接触峰值和铰链速度。力限 60 N、100 N 与速度 10 rad/s 属于本次仿真阈值。几何距离沿关节插值抽样，上界截断在 80 mm。阶段快照在原生 Worker 当前代次内可用于分叉，录像持续保存动作请求和哈希。连续碰撞验证、跨会话状态恢复和真机验证另行验收。
