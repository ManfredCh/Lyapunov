# Gauntlet 接入 Agent Graph

[上游模块对比](UPSTREAM_COMPARISON.md)对照固定源码中的任务合同、扰动、验收、录制、设备隔离、分叉、判分和统计。此轮在现有 Agent Graph、Mink 和机器人抓放流程中吸收同起点资格、判据控制、物理证据、分档统计、分段下降和有界复拍。

| 试验 | 参考 | 候选 | 仅候选通过 |
| --- | ---: | ---: | ---: |
| 分段下降，独立新种子 | 9/12 | 9/12 | 0 |
| 分段下降，诊断种子回归 | 8/12 | 11/12 | 3 |
| 腕相机退远复拍，已知视野失效条件 | 9/12 | 9/12 | 0 |

独立新种子的三对双失败都出现在下抓之前。30 mm 退远复拍触发三次，完整观测恢复为零。随后读出开爪动作窗口的真实载荷数据，目标在第一次观察之前被接触并横向移动约 209、62、42 mm。六次针对性复跑确认了 Agent Graph 的 `targetContact` 能保存这类证据。几个新种子压力场景仍需验证预抓起点与开爪顺序。分段与复拍均为显式选项。

## 复跑

从 Dev 工作树执行以下命令。共有原腕相机方案、分段对照和复拍对照三种模式。建议使用新输出目录和 MuJoCo 3.13.0、Mink、DAQP、EGL 环境。

```bash
node --experimental-transform-types script/gates/run-so101-paired.ts \
  --model /path/to/robotstudio_so101/asset/so101.xml --python /path/to/mujoco/bin/python \
  --out /path/to/heldout --comparison descent --seeds 6151,6763,7129,7919
```

用相同命令将种子换为 `4019,4561,5039,5851` 可复跑诊断种子。用 `--comparison reacquire` 对照已知视野失败，两组都走分段下降。完成三轮后运行 [回放与校验脚本](report.py)。结果见 [仓库摘要](summary.json)及 [证据清单](evidence.json)。真机、动作级力限准入、在线同状态分叉和传感器故障注入需要单独验收。
