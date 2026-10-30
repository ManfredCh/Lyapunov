# RTX人体动作计算与渲染

## 当前状态

最新进展：现有MuJoCo World/Provider已接通显式CUDA原clip/FK，并取得完整原生/生命周期/兼容回归证据，见文末World检查点。整体仍部分完成；产品RTX渲染、真实多外观与最终实时性能由并行线继续交付和整合。以下17:33段保留首次数学检查点当时的范围。

2026-10-29 17:33新加坡时间，本轮已完成**真实CUDA原始clip采样/81骨FK数值检查点**，整体仍为部分完成。该检查点尚未接入产品World，不代表物理、20人实时或RTX画面验收。旧CPU基线20真实角色+Panda为6秒耗77.526秒/RTF0.077393，不能写成GPU成绩。

后续仍由既有Provider拥有World、tick、动作、owner和原生观测；GPU模块只计算当前输入对应的数值，不保存另一份动作/物理时钟。Viewer消费原生Frame。当前目标是动作计算和画面实际使用RTX5090、完整20人+机器人正常实时；不会以少人、减骨/分段/字段、关停障、近似clip或补帧替代。

## 第一个GPU数学检查点

`sim-mujoco/python/human_gpu.py`使用独立`warp-lang==1.13.0`，GPU数组与计算均为float64，`fast_math=false`、`fuse_fp=false`。原始LINEAR/STEP/SLERP、拓扑FK和原rootMotion在CUDA kernel完成。每人一个线程依原拓扑顺序求全部骨；当前根、四元数、elapsed和phase每次更新到固定pinned输入，CUDA graph包含H2D→kernel→D2H，返回前同步。返回值复制为独立数组，下一次graph不会覆盖上次结果。缓存只含不可变定义/clip及批buffer/graph，不含World或动作owner。

实际设备为NVIDIA GeForce RTX5090 Laptop，UUID `GPU-b0fb1abf-cbc1-c006-55fe-11273e0627b2`、sm120/82SM。首次2048元素fp64小kernel读回逐元素差0，进程内nvidia-smi匹配相同UUID/自有PID，32次CUDA graph真实重放通过。该小kernel的冷init1.544秒、首次编译/launch/sync1.407秒、32次重放/sync0.001475秒只作硬件与编译证据，不外推人体吞吐。主控另以不同4097元素kernel独立复验通过，其回执不代替本线人体测试。

完整人体数值验证使用实际7d角色及公共导入产生的0.5单位/不同heading定义，均81骨、真实两足校准。两定义、原7clip、原符号/交替反符号、不同phase（含负数、大于1及周期边界）、任意合法3D根姿态，以及另标的SLERP阈值/STEP数值夹具，共19,800个人体样本。对独立冻结a089完整模块，最大骨位置/四元数差2.22e-15，14段与两足端点最大差1.78e-15，保持1e-12门。30个批正常关闭，关闭后再采样明确拒绝；实际捕获期间注入拷贝故障，capture_end最终收口，随后重建/重放成功；关闭一个批不影响另一个批。

更正保留：初GPU kernel直接使用Warp浮点`%`（fmod），phase=-.25/-1.25实际出现1.5733的差；原源码与失败回执保留。修复只为负余数加duration并归一有符号零，保留原phase合同，没有限制phase到0..1。capture_begin之后以try/finally结束捕获，异常释放本批stream/buffer/graph；不清全局CUDA上下文或持久编译缓存。

显式GPU要求可写的当前Provider私有cacheRoot、受验Warp版本和真实CUDA设备。缺Warp给`HUMAN_GPU_DEPENDENCY_MISSING`，版本不符/缓存不可写/设备不可用有各自具名错误，不暗回CPU。必需GPU验证入口在缺Warp的普通Mu3.13环境实际exit1，未skip成绿。默认CPU路径此时尚未导入该可选GPU模块，无Warp仍可运行原GLB动作；后续产品接线会保持显式CPU兼容。

## 隔离依赖

本线没有安装或修改共享SDK。任务私有Mu3.13环境只读引用既有Mu3.13 site-packages，并从已装SDK中校验复制独立Warp及其dist-info/许可：526文件、372,216,495B，逐文件验证原RECORD SHA及复制后SHA。没有复制整个Isaac SDK、Mu3.8或Torch，也未将Isaac site-packages加入私有sys.path。实际导入为Mu3.13.0与私有Warp1.13.0；许可Apache-2.0，完整逐文件/二进制清单在本线`.runtime/human-r4/gpu-python-manifest.json`，导入边界在`gpu-python-imports.json`。未下载RapidJSON或其它旧CPU方案依赖。

## 复跑与证据

从源码根，用已准备的Mu3.13+Warp1.13隔离解释器（或已装Warp的原有SDK，只作数学对照时记录其实际Mu版本）执行。输入定义与冻结参考各保原身份，不让reference导入候选GPU primitive：

```bash
CUDA_CACHE_PATH=/任务私有CUDA缓存 \
/隔离解释器/bin/python packages/human-crowd/scripts/gpu-clip-verify.py \
  --definition /最终7d定义/definition.json \
  --definition /公共导入的半单位定义.json \
  --reference-human /冻结a089/packages/sim-mujoco/python/human.py \
  --cache /任务私有Warp缓存 \
  --expected-uuid GPU-b0fb1abf-cbc1-c006-55fe-11273e0627b2 \
  --out /新建结果/gpu-clip.json
```

本线准确原命令与退出码见`.runtime/human-r4/gpu-math-receipt.json`。实际GPU输出`gpu-clip-checkpoint.json/log`、前负phase失败`gpu-negative-before.json/log`、首kernel`cuda-smoke-receipt.json/log`均保留。该入口缺CUDA/依赖时非零失败；显式CPU设备被拒绝，不能用CPU结果冒GPU。

当前相关检查已实际通过：19,800样本GPU专项、GPU缺依赖负例、默认CPU GLB原生兼容单项、正式human1/Mu3及两插件构建/diff，均收真实退出。GPU helper尚未改变World/Provider/Viewer接口，当前没有重新运行完整Mu6/Isaac2或旧77秒整链，也没有新增TS变更；这些不是本检查点新取得的验收。World接线后须按R4合同补完整Mu6/Isaac2、GPU生命周期/原生停障/接触与对应类型/构建。

## 未完成部分与后续

下一步将GPU采样/FK薄接回现有Mu World的当前tick，沿现有生成代次/停止/hold/owner和私有cache配置释放GPU资源，再验证完整14段、实际机器人/contacts/默认停障和原生观察；当前不能从独立kernel或数学样例声称该产品链已经接通。GPU目标中的必要局部/足段派生仅在实测需要时纳入同模块。

RTX5090渲染、自有隔离Electron完整工作台、多外观20人、原6秒吞吐及正常realtime时钟30秒稳定段/3轮/活动>=30fps均待实现和实测。系统GPU/驱动、全局PRIME、用户GUI与浏览器设置没有修改。主控最终独立验收和README/能力表整合另列。


## 2026-10-29 19:20 新加坡时间：现有World/Provider CUDA检查点

GPU路径已经薄接回原MuJoCo World.tick，物理仍为Mu3.13原生CPU。公开MuJoCoProvider参数为`humanComputeDevice:'cpu'|'cuda:0'`、直连时的绝对私有`humanGpuCacheRoot`，亦可用本进程`LYAPUNOV_HUMAN_COMPUTE_DEVICE`/`LYAPUNOV_HUMAN_GPU_CACHE_ROOT`显式配置。正式/游客产品入口同样经该变量开启：`LYAPUNOV_HUMAN_COMPUTE_DEVICE=cuda:0 ./lyapunov desktop`（需先 `./lyapunov install-provider mujoco --human-cuda`）；父环境值仅 `cpu`/`cuda:0` 会被转发进 Host，非法值与未设置不进入。产品会话未给直连cache时，从既有`LYAPUNOV_SIM_RUNTIME_ROOT/scratch/human-cuda`解析，属于原生launcher既有私有scratch写入面，不回落cwd。仅worker进程内的CUDA driver cache同步指向该私有根；没有修改系统或用户全局环境。

默认CPU不导入Warp。显式CUDA仅在World有实际原clip人体时延迟准备；缺库/版本/设备/cache都具体拒绝，不暗回CPU人偶。Mu插件复用gpu-facts唯一owner的设备可见/暴露清单，不复制硬件判据；没有人体采样需求的普通CPU机器人世界不因这项可选依赖失败而拖垮整个Host。当前GPU动作支持rigged-glb显式原clip，无clip/程序化占位动作返回HUMAN_GPU_CLIP_REQUIRED，旧CPU兼容保留；ragdoll仍是原Mu原生物理，不冒称GPU动态平衡。

大组、小组以及导航/互让标量回退的原clip均经CUDA采样，停止/阻挡/终点复用原hold出口，没有二次advance。GPU资源只按当前model token、完整定义/源轴单位heading/足校准签名、clip和批大小缓存，最多16批；LRU驱逐和成功重绑释放旧graph/stream/buffer，关闭World不清其它World的CUDA上下文或持久编译缓存。输出继续copy，末clip姿态不引用下次graph覆盖的view。没有更改Frame字段、source、物理步长、mask、观测/传感器或墙钟输出触发规则。

真实计算事实在既有`sim.describe(worldId,humanId).controller.humanCompute`：requestedDevice/backend/device/name/uuid/arch/warpVersion/dtype/fastMath/fuseFp/kernelCalls/activeBatches/prepareS/closed，带World与generation身份；并非用GPU目标替换观测。原humanPose.source仍为mujoco-site/body，发布数据每步从当前native model/data回读。

实际专项（全部取得exit0，数值门不放宽）：

| 检查 | 实际结果 |
| --- | --- |
| 公共Provider20实际7d+Panda | .1s/50tick completed，20人各81骨14段、当步原生source；Panda joint1真实变化0.0363381rad |
| 多World隔离 | 同一Provider开B后关闭B，A继续单人CUDA动作至step70；A累计91kernel，关闭B未清全局设备或A资源 |
| 全3000tick独立a089 World参考 | site/geom位置最大3.55e-15，geom矩阵6.36e-13，Panda qpos/qvel差≤4.84e-14；当步native读回8.88e-16；contacts3428精确一致 |
| CUDA真实参与 | 3000tick场景3020次运行kernel（含20次动作初姿态）；CPU批采样函数调用0；实际用到16批上限，World close后activeBatches0/closed真 |
| 混定义/短长窗/4mm终点/重绑 | 两个定义、单位1/.5、不同heading/clip/phase；generation2旧资源closed；geom矩阵最大3.61e-13 |
| 导航/互让回退 | 基础路径仍原CPU，骨计算实际CUDA3483次，CPU批采样0；全native字段保持参考精度 |
| 停障解除 | 500tick，仅移动非人体native mocap障碍；原停步相位/恢复记录与冻结参考逐项一致，geom矩阵2.61e-13 |
| 人物owner生命周期8项 | 完成/重入/暂停取消/采样故障注入/短窗口/选择停/旧aid守卫均过，不清其它owner原义；221kernel，人物owner空、close资源空 |
| 真实接触正例 | 明确avoidObstacles:false、独立移除Panda只测试人体与动态1kg盒；150tick，103人体-盒接触，峰422.94N，盒位移0.138012m；GPU对原Mju标量native最大3.25e-13，mask相同 |
| 缺Warp/设备/cache | 三个公开API具体错误；随后同worker无人体Panda真实20tick/关节Δ0.00822581，表明未拖垮无关CPU世界；GPU拒绝不当GPU通过 |

接触正例不代表默认停障安全或正常人群容量，正常默认停障已另由完整冻结参考验证。两参考World仅用于独立数值对照，产品仍只有既有World/时钟/owner。其frameRateHz=.001是诊断数值对照的明确低输出设置，不作为完整Provider或RTF成绩。

主要复跑入口：`gpu-world-verify.py`的`--compute-device cuda:0 --gpu-cache <绝对私有目录>`，同原clip-batch-world入口的`--scene/--worker-root/--reference/--steps`，另有`--mixed --rebind`/`--fallback`/`--resume`；公共Provider入口`gpu-provider-verify.ts --scene <20人Scene> --python <Mu313+Warp> --out <新目录>`；缺能力负例加`--expect-error HUMAN_GPU_DEPENDENCY_MISSING|HUMAN_CUDA_UNAVAILABLE|HUMAN_GPU_CACHE_REQUIRED`。`human-owner-verify.py`保原入口与8例，仅显式CUDA时附加实际GPU关闭事实。`native-clip-batch.py`保旧CPU默认参数，真实7d接触正例显式`--clip WalkGrounded --without-robot`，仍非容量测试。

本线完整命令/exit/源SHA汇总`.runtime/human-r4/world-runtime-receipt.json`；各专项为`gpu-world-frozen/compare.json`、`gpu-world-{mixed,fallback,resume}/compare.json`、`gpu-owner/owner-receipt.json`、`gpu-contact.json`、`gpu-provider-{positive,missing-warp,missing-device,missing-cache}/receipt.json`。GPU运行事实与pose/owner/close均由实际执行取得。CPU和GPU不同控制器的跨动力学位级比较不泛化，当前是同Mu solver/同物理配置的既定门槛内对照。

兼容回归在Root协调的独占回归窗口顺序运行：原Mu6/Isaac2均0skip/exit0，正式Human1/Mu3/Isaac18、root/gates类型、两插件构建/diff全部exit0。独立driver逐PID/signal/exit在world-gates.json，signals=[]。未用本次回归报告RTF，未借Root或其它代理结果冒执行方新GPU性能。

GPU运行时生产安装/发行helper闭包由专职并行线接管；此World提交不带其4个安装器WIP，也不把当前QA私有site-packages复用说成可安装发行已完成。RTX产品渲染、异构一次graph、真实多外观/normal30s及三轮性能由对应并行交付整合；下一步先固定本切片交Root独验，再立即运行原配置6s实际GPU完整链一次识别瓶颈，保持manual吞吐与realtime正常节奏分列。当前没有新完整RTF或>=30fps结论。

## 2026-10-30 R5：人群单 graph 与帧快路径（部分完成）

主线 `a36f24c7`。状态：**部分完成**，20 人 + Panda 实时（RTF≥0.9）仍未达到。

改动：
- 帧输出：`World.frame_text()` 把 humanPose 预先渲染成 JSON 文本，再拼进其余帧；输出与原 `json.dumps` 逐字节相同（等价门 GPU 309/309、CPU 1128/1128 帧，mismatch 0）。四元数批转换改为一次向量化。sync/execute 后 `gc.unfreeze/collect/freeze`。
- CUDA：`human_gpu_multi.CrowdPoseBatch` 把全部 clip 行人放进一个 graph（逐骨采样 → 拓扑 FK → site/段写回目标），每 tick 一次 replay、一次同步；写回改为 6 次扁平 gather/scatter；末姿态改为惰性 `ClipPoseMap`。CPU 默认路径不变。
- 执行器静态量按 model 缓存，换代时清空。

数值门（判据未改）：冻结 a089 3000tick（site_xpos 3.55e-15、geom_xmat 6.36e-13、contacts 一致）、mixed/rebind、fallback、resume 按原参考 PASSED；crowd 数值门 12,900 样本、world 骨对 MixedClipBatch 逐位一致；owner 8/8；Mu native 6/0 skip、Isaac native 2/0 skip。

实测（cuda:0，RTX 5090 Laptop，circles 20 人四外观 + Panda）：
- manual 6s：providerRTF 0.0676（改动前）→ 0.2985 / 0.3209 / 0.3411（三轮）；`World.tick` 28.95ms → 5.44ms。
- realtime 30s：0.3679 / 0.3402 / 0.3244。
- 旧 6 秒基准（real20-baseline-03）：0.1739 / 0.1927 / 0.1815。
- Electron 工作台（`--nvidia-rendering`，ANGLE Vulkan RTX 5090）三轮 30 秒：fps 16.3 / 14.8 / 11.9，p95 83 / 100 / 117ms，Provider RTF 0.164 / 0.148 / 0.126；均未达 30fps / p95≤50ms。

剩余主要开销（每 tick）：clip 写回 Python 段与 CUDA 同步（~1.4ms）、路径状态（~0.4ms）、每帧 observe+文本（~6–10ms，按墙钟 30Hz）。证据：`/home/s18/WS/Lyapunov/receipts/20261029-devin-r5/`（profile、p1–p3、integ、render、final）。
