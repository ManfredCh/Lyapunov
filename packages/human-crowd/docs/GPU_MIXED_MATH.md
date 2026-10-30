# 异构角色 CUDA 数学合批

本模块只计算输入给定时刻的原始 clip、完整骨架 FK 和水平根运动移除，不维护 World、动作、物理时钟、场景或资源身份。Provider 决定何时采样、缓存、关闭及把骨姿态提交到原生世界。

## 接口

```python
from human_gpu_multi import MixedClipBatch

batch = MixedClipBatch(
    [(canonical_cfg_a, 'Walk'), (canonical_cfg_b, 'Run')],
    device='cuda:0', cache_root=provider_private_cache,
)
positions, quaternions_wxyz = batch.sample(roots, root_quaternions_wxyz, elapsed, phases)
for actor, names in enumerate(batch.names):
    count = batch.bone_counts[actor]
    actor_positions = positions[actor, :count]
    actor_quaternions_wxyz = quaternions_wxyz[actor, :count]
facts = batch.facts()
batch.close()
```

- 构造参数为固定有序 `[(canonical_cfg, clip_name), ...]`，支持 1–1000 个演员，每个定义 1–128 个按父先子后排序的骨。`canonical_cfg` 为原有导入层完成米、朝向、rest 和足端点变换后的定义，可包含只读内部 `_poseRuntime`；本模块不读取或修改该内部对象。
- `roots` 为 `(N, 3)` 米，根四元数为 `(N, 4)`、内部 `wxyz` 顺序，`elapsed` 为 `(N,)` 秒，`phases` 为 `(N,)` 无量纲相位。每个演员使用自己的 `durationS`；负相位沿用 Python 正余数语义。
- 返回两个独立数组 `(N, max_bones, 3)` 和 `(N, max_bones, 4)`。有效长度由 `bone_counts[i]` 给出，`names[i]` 与有效骨一一对应。Padding 恒为零，不代表新增骨。下一次采样与 `close()` 不覆盖先前返回数组。
- 描述打包后不保留调用方定义引用。同一构造中相同定义对象与 clip 共享只读描述；这只是数学缓冲复用，不是 World、资源或动作状态缓存。
- 一次采样只重放一张 CUDA graph。graph 固定包含一次 pinned-host 到 device 拷贝、一个以演员为线程的混合 FK kernel、一次 device 到 pinned-host 拷贝，然后调用方等待一次 stream 同步。演员数、定义数、clip 数不会增加每次采样的提交或同步次数。
- 模块复用 `human_gpu.py` 的 FP64 数学 primitive、Warp 依赖与结构化错误。当前受验依赖为 Warp 1.13.0，显式要求 CUDA，`fast_math=False`、`fuse_fp=False`。缺依赖、缺 CUDA 或指定 CPU 都不能回落成 CPU 数学。
- `facts()` 保留设备名、UUID、arch、Warp 版本、dtype、有效骨数、graph/kernel/H2D/D2H/采样同步计数。构造预热和释放同步单独于采样计数；`graphReplayAndSyncS` 只记录 graph 提交与同步，不能解释为完整采样、World、渲染或 RTF。
- `close()` 幂等，等待自己的 stream 后释放 graph 和各缓冲。缓存条目选择、有界数量、模型代次和 subset 重绑归现有 Provider owner；本模块没有第二套缓存 owner。

## 数值验收入口

`packages/human-crowd/scripts/gpu-mixed-clip-verify.py` 必须使用真实 CUDA，要求 `--definition` 至少四次、独立冻结 `--reference-human`、预期 `--expected-uuid`、私有 `--cache` 与 JSON `--out`。缺 CUDA 或数学差异不达标时进程非零退出，不提供 skip 通过。

验收将四个以上真实导入定义交叉混合为 20 演员，并逐轮覆盖所有 clip、不同 duration、随机根和四元数、负相位、循环与 key 边界、反符号四元数。独立冻结标量只经自己的 `pose` 和 `segment_points` 计算参考，不调用候选 GPU primitive。骨姿态、原 14 段/校准足端点与段长门均为绝对误差小于 `1e-12`。

另有明确标为数值夹具的 STEP、SLERP `.9995` 阈值两侧、根运动两种移除方式以及 81/82/83/128 骨混合案例；附加叶骨不改真实资源。生命周期检查覆盖构造 capture 故障、graph 提交故障、恢复、释放一个批后另一个仍可执行、非有限输入拒绝、描述快照独立和 CPU 明确拒绝。脚本核对每个采样只有一次 `capture_launch` 与一次 `synchronize_stream`。

这里的数学通过只证明固定输入的真实 CUDA clip/FK 数值与资源生命周期。20 真人与机器人同 World、停障、动作 owner、真实 Frame、RTX 渲染、实时率和发行包验收由对应 owner 与主控另行完成。

## 研究记录

- 2026-10-29 新加坡时间：按团队合同在固定基线 `b901d0de` 的独立工作树新增纯数学模块与独立冻结参考 QA，保留原 `human_gpu.py`、`human_batch.py`、`human.py`、`worker.py` 写域。初次语法与 diff 检查通过；实际 CUDA 数值与产品整链验收在回执中分层记录。未推送、未发布。

## 2026-10-29 执行方实测

18:41:53（新加坡时间）开始运行固定源码 `c277e347` 的真实 CUDA 门，35.24 秒后退出码为 0。设备为 RTX 5090 Laptop，UUID 为 `GPU-b0fb1abf-cbc1-c006-55fe-11273e0627b2`，Warp 1.13.0，FP64，`fast_math=False`、`fuse_fp=False`。

实际输入为旧 M04 固定 GLB 经公共导入的四种单位／朝向定义，以及新 F01 的封存最终定义。它们构成五个数学定义、两个真实外观；四个单位／朝向变体没有被称为四种外观。每次合批均为 20 个演员，共独立对照 12,900 个人体样本，覆盖七个动作、各自时长、不同根和相位、反符号四元数，以及另行标识的 81／82／83／128 骨数值夹具。

| 验收项 | 实测 |
| --- | --- |
| 完整骨位置与四元数最大绝对差 | `2.220446049250313e-15` |
| 14 段及校准足端点最大绝对差 | `1.7763568394002505e-15` |
| 段长最大绝对差 | `1.0547118733938987e-15` |
| 数值门 | 三项均 `< 1e-12` |
| graph 捕获节点 | H2D／kernel／D2H 各一次 |
| 每组 43 次采样 | `capture_launch=43`、`synchronize_stream=43`，无额外独立 copy／kernel 提交 |
| 生命周期 | capture 故障、提交故障、恢复、独立批释放、描述快照、输出不别名、非有限输入拒绝均通过 |
| 缺 CUDA | `CUDA_VISIBLE_DEVICES=''`，实际退出码 1，`HUMAN_CUDA_UNAVAILABLE` |
| 缺 Warp | 实际退出码 1，`HUMAN_GPU_DEPENDENCY_MISSING` |
| 默认 CPU 模块导入 | 不导入 `human_gpu` 或 `human_gpu_multi`，退出码 0 |
| 人体相关现有 CI | 14 通过、0 失败、0 跳过，退出码 0 |
| MuJoCo 相关现有 CI | 指定已有 MuJoCo 3.13 解释器与 OSMesa 后 12 通过、0 失败、0 跳过，退出码 0 |
| 相关插件构建、Python 语法、差异格式 | 退出码均为 0 |

独立参考为冻结 `a089` 的 `human.py` 原字节，SHA-256 为 `7d1537fac7a0aae78144246d4eda0141178c74bdc8c00179e76998a914fff435`；候选新模块 SHA-256 为 `9219406984694625ffb7826be524b238dc8145d86ce373df7d403636f6ed9c37`。F01 最终定义 SHA-256 为 `ca9ba9b10d76aeac440815e890c472d5fb35ccc9832bca038c3a02293a242bfc`。完整命令、实际退出码、stdout／stderr、输入 SHA 与分组结果留在本次团队证据目录的 `gpu-mixed-math/` 回执中。

同窗口 200 次混合数学采样的均值为 2.379 毫秒，包含 Python 输入与输出拷贝、graph 和同步；窗口允许其它功能取证并发。此读数只描述该次数学采样，不换算 World、渲染或 RTF。

更正：最初人体 CI 为 13 通过、1 失败，构建也失败；原因是私有工作树的 `@deepseek-ai` 父 scope 链接触发既有保护，以及锁定 `fflate@0.8.3` 未在本树建立可解析链接。只在本树 `node_modules` 建立私有目录和已安装依赖的只读子链接后，上述原入口通过。最初 MuJoCo CI 的三项默认路径跳过也保留在旧回执；指定已有解释器后补跑得到表中 12 通过、0 跳过。没有修改产品源码、锁文件、主仓或共享 SDK 来消除这些环境失败。

当前范围为执行方数学与相关自动化验收。World 接线由原 Human owner 执行，主控需在固定提交独立运行；12 外观、正常实时、产品 RTX 画面和发行包仍以各自独立验收为准。

## 二分槽位查找性能切片

2026-10-29 19:25:00（新加坡时间）：保留 `c3d598d2` 稳定线性版本，只在本混合模块新增 `mixed_slot` 的严格 `side='right'` 二分查找。它保留 key 恰好命中、首尾 clamp、STEP、负相位之后的相同局部时间，以及原来的插值权重算式；没有修改原 `human_gpu.py`、World 接线、graph 节点数量或 API。

先以 CUDA event 定位组件，线性版 WalkGrounded 的 H2D／kernel／D2H 中位分别约 0.007／1.098／0.016 毫秒，主机输入检查与输出检查／拷贝合计约 0.08–0.12 毫秒。二分版的 kernel 中位降至约 0.638 毫秒；Idle 与七动作混合 kernel 中位分别从 1.784／1.873 降至 0.625／0.679 毫秒。这些是功能并发窗口的组件测量。

同一进程加载固定稳定源与候选源，逐样本交替 AB／BA 顺序，每种输入做三轮、每轮每版 100 次实际 `sample`，全部轮次保留：

| 混合 20 人输入 | 稳定版三轮中位范围（毫秒） | 二分版三轮中位范围（毫秒） | 各轮降低比例 |
| --- | --- | --- | --- |
| WalkGrounded | 1.167–1.190 | 0.719–0.730 | 38.4%–38.9% |
| Idle | 1.878–1.889 | 0.721–0.726 | 61.4%–61.6% |
| 七动作混合 | 1.839–1.895 | 0.778–0.784 | 57.5%–58.9% |

上述 900 对输入的稳定／候选 GPU 输出逐元素差为零。候选同时重跑五定义、12,900 人体样本的独立冻结 `a089` 门，骨姿态／校准足端点／段长误差仍分别为 `2.220446049250313e-15`、`1.7763568394002505e-15`、`1.0547118733938987e-15`，门为 `< 1e-12`；原 graph 捕获节点、一次采样一次同步、不同骨数、负相位、输出不别名、close 与故障恢复均通过。

候选相关现有 CI 再次得到人体 14 通过／0 失败／0 跳过、MuJoCo 12 通过／0 失败／0 跳过，相关插件构建、Python 语法和差异检查退出码均为 0。

候选模块 SHA-256 为 `5d18177aeb97c350ef27e5cad947cffac4a4a93e437be504b3127f14e46b578f`。逐项 CUDA event、主机分段、三轮完整成对结果、命令／退出码、stdout／stderr 与本地 CI 留在原团队证据目录的 `gpu-mixed-math/performance/`。首次组件脚本命名为 `profile.py` 与 Python 标准库同名，导致导入失败；已改名 `component_profile.py`，最初失败日志保留，未改共享 Python 环境。

此切片确认数学组件收益，保留单 kernel 的小改动。当前没有安静独占性能、World RTF、产品渲染或发行包的新验收结论；这些仍由主控及对应 owner 验收。
