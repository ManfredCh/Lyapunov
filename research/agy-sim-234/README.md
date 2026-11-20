# Dev 视觉闭环、五档扰动和策略评估

在 0.2.6 候选之后的 Dev 隔离分支验收三项仿真能力。复用 Agent Graph、MuJoCo Provider、DSH Jobs 和原生录制。

| 能力 | 产品入口与实测 |
| --- | --- |
| SO-101 迭代抓放 | robot_pick.wristRefinement.feedbackPasses 用真实腕部 RGB‑D 反复读取余量，确认新帧和动作到位，收敛前不下降。控制在已校准平面内。 |
| YAM 六轴视觉闭环 | robotics_lab operation=yam-ibvs 使用本地 Menagerie YAM Linear 4310。在标记工位初始 RMS 39.60 px，25 次关节命令后 0.92 px。静止、陈旧帧、不可达 IK 各有原件。四组使用同一模型重力补偿与位置执行器。 |
| T0–T4 原生配对 | 使用 campaign_init、sim_evaluation 和 sim_task_check。10 个有效对，单次纠偏和反馈各 5 次入盒。三类外力、帧延迟、相机冻结含故障时间戳、夹爪卡滞均触发。 |
| Playground 策略评估 | playground_eval_so101 读取权重和训练回执，在独立 CPU MuJoCo 中与零动作成对比较。已训练 3,072 步，两组各在 6 个保留种子上 0 次完成上游任务，共 12 段回放。 |

## 注入和采集边界

- 静态质量、摩擦、目标位移及偏航、台面高差及倾斜、目的箱位置由实验场景驱动构建。两组共享声明摘要与第 0 步实态。桌面高度作为已知标定面，两组均读取同样的信息。
- MuJoCo worker 在第 0 步应用阻尼、驱动增益、重力补偿和相机外参偏移。运行时施加外力，仅扰动实验相机 RGB／轴向深度和明确启用的控制器关节读数。任务判定、安全监测与固定机位录制读取权威物理状态。 [MuJoCo 步进与施力](https://mujoco.readthedocs.io/en/stable/programming/simulation.html)
- T3 实验外力绑定动作阶段。滑动 0.30 N／22 步，推动 0.80 N／18 步，击脱 1.20 N／16 步。方向由固定采样决定。相机发生延迟或冻结时保留真实采集步与文件；坏的报送步号单独记录。
- YAM 验收范围为有色标记与真深度的单工位。FR3 闭环、无标记工况和物理设备按各自场景另验。Playground 的上游成功谓词为抬起方块并接近目标。已验证检查点加载和仿真执行，当前权重的任务表现尚未达标。

## 复跑与原件

原件在 Dev/.runtime/agy-sim-234/。打开 index.html 可看逐次判定与回放。 [阶段记录](STAGE_SUMMARY.md) · [实测摘要](summary.json)

```bash
MUJOCO=/path/to/mujoco/bin/python
PLAYGROUND=/path/to/playground/bin/python
node --experimental-transform-types research/agy-sim-234/run-policy.ts /path/to/yam-workspace "$MUJOCO" yam
node --experimental-transform-types research/agy-sim-234/run-policy.ts /path/to/policy-workspace "$PLAYGROUND"
"$MUJOCO" research/agy-sim-234/schedule.py --output /path/to/run/schedule.json
node --experimental-transform-types script/gates/run-so101-paired.ts \
  --model /path/to/robotstudio_so101/asset/so101.xml --python "$MUJOCO" \
  --out /path/to/run/gauntlet-native --gauntlet /path/to/run/schedule.json
```

YAM 工作区的 model/ 包含 MJCF 与网格。策略工作区的 model/ 包含训练时使用的 MJCF 与网格，train/result.json 和对应权重来自同一次训练。正常开发宿主通过 LYAPUNOV_SIM_LAB_FAULTS=1 显式启用扰动。
