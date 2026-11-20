# Lyapunov 研究日志

本目录记录研究决策、验证发现、修正及下一步。按新加坡时间追加到 [时间线](RESEARCH_LOG.md)。实验方案、条件和结果索引在 [实验目录](../../research/README.md)。

## 当前进度

Dev 新分支已实跑三项仿真能力。YAM 标记工位从 39.60 px 收敛到 0.92 px，SO-101 五档扰动收齐 10 对且两组各 5 次入盒。Playground 检查点已在独立 CPU MuJoCo 上成对评估，当前权重 0/6。详见 [Dev 仿真 2、3、4 验收](../../research/agy-sim-234/README.md)。

前轮 AGY Robotics 的 18 项技能、七项 API 指南和组合入口已由 Dev 的独立 DSH 会话发现。双视角 RGB 定位接 Bi-RRT 的起点误差为 1.79 mm，SO-101 同种子回归参考 7/12、候选 6/12。详见 [组合技能批次](../../research/agy-robotics/README.md)。

SO-101 已完成同一批次的原生集成验收。历史三例候选的开爪目标接触均为零，目标沿台面保持原位。整批入盒参考 7/12、候选 6/12。四个原生阶段分叉终态一致，两个故障正确止损。详见 [原生集成批次](../../research/so101-native-evaluation/README.md)。
