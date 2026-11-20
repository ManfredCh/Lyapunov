# SO-101 桌面分拣配对评测

本实验比较现有抓放流程与加入腕相机纠偏的版本。实现提交 `d2cf277fb50a597cc0a124e96122aaf055aa6328`，基于 `11a4d6f9`。将 Gauntlet 的配对扰动设计接入 Lyapunov 原生 Agent Graph。见 [评测合同](../../docs/AGENT_GRAPH_CONTRACT.md#34-配对评测)及 [研究时间线](../../docs/research_log/RESEARCH_LOG.md)。

## 实验方案

每对共用场景版本、种子、扰动与原生第 0 步状态。两组均采用 SO-101 夹爪宽度标定、Mink 规划和盒口上方转运。候选组额外使用腕相机纠偏。以目标入盒并接触盒底、达到静止、夹爪离开及干扰物留在盒外的观测判分。两种运行策略在每批内交替先执行。

原种子为 `1301,1723,2243,3001`。独立批次种子为 `4019,4561,5039,5851`。每批包含标称、偏移、强化扰动三档，每档 4 对。具体位置、质量、摩擦和场景摘要保存在 [原种子条件](conditions-original.json)和 [独立批次条件](conditions-heldout.json)。

## 结果

| 批次 | 基线 | 候选 | 仅候选通过 | 候选定位误差中位数 |
| --- | ---: | ---: | ---: | ---: |
| v1 原种子 | 4/12 | 7/12 | 3 对 | 5.01 mm |
| v2 原种子复测 | 4/12 | 10/12 | 6 对 | 1.18 mm |
| v2 独立新种子 | 4/12 | 8/12 | 4 对 | 1.26 mm |

独立批次的标称、偏移和强化扰动档，基线与候选分别为 4/4 对 4/4、0/4 对 2/4、0/4 对 2/4。双侧配对精确检验 `p=0.125`。候选组四次失败都发生在抬升阶段。结果适用于此桌面、相机和扰动配置。完整数值见 [结果摘要](summary.json)。

## 复跑

在 Dev 实验工作树使用 Node 24 和包含 MuJoCo 3.13.0、Mink、DAQP 的 Python。摄像机使用 EGL。SO-101 使用原始 MJCF 和它的网格目录。源 XML 和网格组合哈希已随条件记录。

```bash
node --experimental-transform-types script/gates/run-so101-paired.ts \
  --model /path/to/robotstudio_so101/asset/so101.xml \
  --python /path/to/mujoco-mink/bin/python \
  --out /path/to/new-results \
  --seeds 4019,4561,5039,5851
```

原始结果根目录为 `/home/s18/WS/Lyapunov/E/so101-paired-20261119`。其中 `index.html` 展示逐次判定和录像，`heldout/` 保存独立批次，`v2/` 保存原种子复测，`pilot/` 保存两次试跑，`validation/` 保存验收。按 [证据清单](evidence.json)中的 SHA-256 核对原件。

## 验收范围

`bun run test:ci --filter` 的 `packages/agent-graph/`、`packages/robot-workflows/`、`packages/sim-task-check/`、`packages/sim-mujoco/` 四个范围共 15 项入口通过。`tsc -p tsconfig.json`、`tsc -p script/tsconfig.gates.json`、`bun run script/build-plugins.ts agent-graph robot-workflows sim-mujoco` 和修改过的 Python worker 编译均退出 0。三轮 MuJoCo 实测与 72 段 MP4 检查单独留证。后续评估包括夹持失败、故障注入、分叉重演和真机。
