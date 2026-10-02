# Policy 检索、下载与执行

支持 G1 TorchScript、Go2 ONNX、Go1 Walk These Ways TorchScript，以及 SmolVLA×LIBERO 的 VLA bench 链；通过同一原生 Tools/Jobs/ctx.sim 执行。

策略来源有四档：`modelscope`、`github`、`huggingface`、`packs`。`policySource()`（`src/source.ts`）对这四个值都返回，只对未知来源值抛 `POLICY_SOURCE_UNSUPPORTED`；`FETCHABLE_PROVIDERS`（`src/pack-contract.ts`）同为这四值；`policy_search` 四个来源各有检索分支。**huggingface 只走镜像**（`huggingfaceEndpoint()` 默认 `https://hf-mirror.com`，可用 `HF_ENDPOINT` 覆盖，打到官方 `huggingface.co` 一律拒绝）；`packs` 只查我们服务器的能力包 catalog／发现面，搜索阶段只出元数据、不取字节。其他模型只有在动作、观测与执行适配器明确后才可执行。

支持 Unitree 官方 `unitreerobotics/unitree_rl_gym` 的 G1 12DOF TorchScript 策略，固定提交为 `276801e46c5d433564f24658bac64f254b7d2d4b`。其真实输入是 47 维状态，输出为 12 个关节的 PD 位置参考，CPU 推理频率为 50 Hz。

来源依据为[官方 G1 配置](https://github.com/unitreerobotics/unitree_rl_gym/blob/276801e46c5d433564f24658bac64f254b7d2d4b/deploy/deploy_mujoco/configs/g1.yaml)和[官方 MuJoCo 部署代码](https://github.com/unitreerobotics/unitree_rl_gym/blob/276801e46c5d433564f24658bac64f254b7d2d4b/deploy/deploy_mujoco/deploy_mujoco.py)。原件保存于账号的 `policies/github/.../<revision>`；派生模型在同一目录的 `derived` 下，原件不被覆盖。

## 工具流程

1. `policy_search` 接收 `provider: "modelscope" | "github" | "huggingface" | "packs"`、`query` 和可选 `pageSize`。GitHub 检索示例为 `unitree_rl_gym in:name user:unitreerobotics`；huggingface 经配置的镜像端点（默认 hf-mirror）；packs 只查能力包 catalog／公开发现面（元数据 only，不回落公开源）。
2. `policy_metadata`、`policy_files` 接收 `provider`、`modelId`、`revision`。它们返回完整来源元数据和解析后的固定身份。
3. `policy_download` 接收上述身份和 `files`，可设 `background: true` 使用原生 DSH Jobs。`resume` 默认为真。文件通过真实增量写入 `.part`，恢复要求来源身份相同且 `Content-Range` 正确；下载完成对照来源 Git blob 或 SHA-256 验证。
4. `policy_verify` 验证全部下载文件。`policy_prepare` 生成已支持策略的模型派生件、`components` 和 `worldOptions`。
5. 关节控制路线（G1／Go2／Go1 WTW）：将返回的 `components` 放入目标实体的 `scene_edit`，使用返回的 `worldOptions` 调用 `sim_open`。该路线的 `timestepS` 来自各适配器声明的物理步长 `simulation_dt`，策略的一次控制周期才是 `simulation_dt×control_decimation`（每轮推进 `control_decimation` 个物理步；G1 为 `clock:"manual"`＋`timestepS:0.002`、50 Hz 的路线，每轮 10 个物理步），Scene 的米/弧度、Z-up 与 xyzw 坐标约定不变。**VLA bench 链不套用这组参数**：它有自己的派生契约与 20 Hz 周期（见下方“VLA（SmolVLA×LIBERO）bench 链”）。
6. `policy_match` 接收来源身份及 `sceneId`、`entityId`、`worldId`、`expectedGeneration`，核对当前世界与实体。差异返回具体字段、期望和实际值。匹配支持仅 STATE 输入，只有来源要求视觉时才比较视觉输入。
7. `policy_execute` 使用同一组参数。关节控制路线可传 `durationS`（0.02–300 秒，默认 4）与 `command: [前向速度, 横向速度, 转向角速度]`（默认 `[0.5, 0, 0]`）；**VLA bench 链的观测与周期不同**（见下节），只共用同一 `policy_execute` 入口与回执形状。工具返回原生 `jobId`、`runId` 和最终回执路径。
8. `policy_stop` 接收 `worldId`、`entityId`；也可使用原生 `job_kill`。停止调用以本 run 最后 actionId 与原 expectedGeneration 为界的 `sim.stop`，终态记录为 `CANCELLED`，推理子进程退出。新代次或已由用户新动作接管的实体不会被旧清理重置。已运行的策略不会跨 Host 重启自动继续运动。

## G1 适配语义

观测顺序与官方部署代码一致：局部角速度、由基座四元数计算的投影重力、速度指令、相对默认角度的关节位置、关节速度、上一动作以及步态相位的正余弦。各项归一化参数、默认角度与 PD 增益直接读取固定来源 YAML。

原始网络动作先执行 `action * 0.25 + default_angles`。官方每 10 个 0.002 秒物理步更新一次目标。`ctx.sim.execute(kind: "control")` 在唯一物理时钟内保持该目标，回执提供恰好第 10 步的状态，再用于下一次网络推理。CPU 推理与网络 IPC 的墙钟耗时不会增加物理步数。

适配将原 motor+显式 PD 公式表达为 MuJoCo 的原生 position actuator（kp、kv），保留原关节力矩限幅、gear、单位、质量、惯量、几何与碰撞参数，不加重力补偿、不剪裁网络动作。派生时逐项核对这些物理字段。机器人型号参数位于本包的适配代码和配置中，不进入 sim core。

执行前后保存 `policy-runs/<runId>/result.json` 与 `trace.jsonl`，包括 world/Scene/代次、真实状态、每次 47 维输入与 12 维动作、物理步数、仿真时间、停止回执和实际 CPU/PyTorch 信息。仅首次匹配不会执行权重。

## 验证边界

策略下载、来源校验、prepare/match/execute/stop 和 Jobs 回执必须在部署环境中单独验证；运行回执保留在开发机运行目录，不随发布源码提交。

### T0 优先级与三级 readiness 独立

[packs/t0-roster.json](../../packs/t0-roster.json) 是文档 T0 名单的机器可读权威；[registry.json](../../packs/registry.json) 只用 `tierRoster` 引用它，不复制档位或 readiness。当前为 12 个无歧义 T0 包，UR5e 的原始 T0 / 扩面 T1 冲突显式保留，不擅自裁决。T0 不是“已支持/已通过”：`contentReady`（内容一致）、`adapterReady`（装配/执行路由可用）、`behaviorVerified`（既有行为证据合同）仍由 [pack-contract.ts](src/pack-contract.ts) 独立给出，档位或元数据测试不提升任何一层。

[tier-roster.ts](src/tier-roster.ts) 提供纯元数据接口：

- `validateT0Roster(roster, registry)`：校验 schema/档位/来源、registry 引用、重复与未知包；拒绝将 readiness/status 字段塞入优先级台账。
- `lookupPackTier(roster, registry, packId)`：仅接受精确注册 ID；无歧义 T0 返回 `classification: documented`，UR5e 返回 `conflicting-docs` 和原始 claims，已知但未列入的包返回 `unclassified` / `tier: null`（不能推断 T1/T2），未知 ID 抛 `PACK_NOT_FOUND`。无效台账抛 `PACK_TIER_ROSTER_INVALID` 和结构化 issues。

不改 catalog/discovery 端点字段、不取资产、不运行 policy。离线回归（从 Dev 根执行）：`bun test packages/policy-registry/test/tier-roster.test.ts`。

## Go2 ONNX

支持作者公开的 [INRIA Go2 controller](https://github.com/inria-paris-robotics-lab/go2_onnx_controller/tree/c1729e1a4aa2e7e1091ccff42be68d42bd054764)，固定来源为 `inria-paris-robotics-lab/go2_onnx_controller`、revision `c1729e1a4aa2e7e1091ccff42be68d42bd054764`。Go2 观测是按特征分组的两帧历史（98维），动作12维。适配按作者关节次序、50Hz、PD 28/0.5 和动作比例0.25执行；真实基座姿态、局部角速度与足端接触均从 MuJoCo 读取。

使用相同的工具链，`policy_prepare` 另传 `robotModelPath`，指向已导入 Go2 MJCF 原件。适配器只写派生的 position-PD 模型，保留原质量、惯量、碰撞、摩擦、关节限制和力矩上限。复制返回的 components 时保留原实体 visual 资源；使用返回的 manual worldOptions 启动后调用 `policy_match/execute/stop`。手动 Command 启动的 Job 完成后留在原生 Jobs 面板，不自动产生一次模型请求。

安装 ONNX CPU 依赖只修改项目隔离环境，原生功能验收使用同一 MuJoCo Python：

```sh
.runtime/sim-python/bin/python -m pip install -r packages/policy-registry/requirements-onnx.txt
bun run packages/policy-registry/test/go2-native-policy.ts /绝对路径/go2.xml
```

该原子测试会在隔离目录读取固定 Git 策略源，真实验证 prepare/match/原生 Jobs 的站立、前进、零速停止，以及运行中 policy_stop。没有新建 Agent loop 或控制时钟。运行回执保留在开发机运行目录，不随发布源码提交。

## Go1（Walk These Ways TorchScript）

`wtw-go1-torchscript-v1` 适配分支支持 Walk These Ways 的 Go1 TorchScript 策略：`policy_prepare` 产出 WTW 两段式适配契约（`inference:'torchscript-adaptation'`＋`adaptation_module` 权重），观测含步态命令槽与步态相位，动作幅度与执行频率按适配器声明。物理模型为本机资产 `materials/robots/unitree_go1/menagerie/go1.xml`（可用 `robotModelPath` 覆盖为等价 Go1 MJCF）。Go1 不能用 Go2 适配器替代；全任务与多引擎复验仍按 DEV-024。

## VLA（SmolVLA×LIBERO）bench 链

SmolVLA×LIBERO 走**并列的 VLA 执行分支**（`src/execution.ts` 的 `executeLiberoVlaPolicy`），不属于关节控制路线，不套用 G1 的 `manual`／`timestepS:0.002`／`durationS` 默认 4／`command` 条件：

- **来源**：`k1000dai/smolvla_libero_finetune`（固定 revision `492ac1c5f1b7808c444fae37b75a84fdeb15e70d`），属 bench 链的 HF 来源，pin 只有 `src/adapter.ts` 一处；HF 请求仍只走镜像。
- **派生契约**：`policy_prepare` 产出 `LiberoVlaAdapter`（`derived/adapter.json`），声明 `actionDim`、`nActionSteps`（动作块）、`frequencyHz`／`periodS`、观测键与归一化、控制语义。
- **观测**：官方 bench `Frame` 的 `sensors`——`eefPositionM`(3)、`eefQuaternionXyzw`(4)、`gripperQpos`(2)（另加图像路径），与 Go1 的 47 维／Go2 的 98 维向量不同。
- **周期与时长**：`periodS = 1/frequencyHz`（LIBERO 为 20 Hz，即 `timestepS=1/20`）；`durationS` 仍受 0.02–300 边界，但**默认跑满 `libero_goal` 官方 horizon**（1000 步 @20 Hz = 50 s），不是关节路线的 4 s。
- **推理**：产品模块 `python/libero_vla_infer_server.py`，CPU 出块预算由 `LYAPUNOV_VLA_INFER_TIMEOUT_MS` 控制（只作用于本分支）。产品通路 `policy_execute` 曾在限定 seed／任务跑出官方终态（台账 R463–R469；限定 seed／任务，不等于全任务成功率）。
