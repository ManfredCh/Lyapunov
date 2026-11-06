# 普通成人足锁与局部足段校准

## 2026-10-29 06:20 新加坡时间

本切片修复Rocketbox普通成人原Walk的站立期脚滑，以及通用脚capsule约51mm穿地的问题。继续使用同World/同物理tick的运动学角色，**不宣称动力学平衡**。本轮不再调整已收敛的接地目标；大量真实角色的容量、浏览器播放帧率与自然起停/转向仍另验。

最终自包含GLB为`Male_Adult_04-Grounded-Calibrated.glb`，22,822,948字节，SHA256：

`7d9988e5b7ab5e2e6d96a1a0313391f6851ba55478f615e50cedebeae9e2271e`

微软官方MIT来源、固定版本`0943055db6ec570bcef9f2c8b41c9e5467c808f9`及11对象清单沿用[普通成人来源回执](HUMAN_ROCKETBOX_WALK.md)。本次没有新下载或新SDK。两个全新目录离线重建均得到上述SHA。

## 派生动作与原件保留

`rocketbox-grounded.py`从原始33帧Walk中用真实鞋部skin顶点确定接地区间，水平锁住同一足底点；垂直方向按原鞋底形变投影到1mm地面余量。进入/离开接地区间使用两帧smoothstep。两骨腿IK保持原骨长；为使目标可达，仅在派生clip内允许Pelvis下沉最多5.648418mm，先取五帧可达性上包络，再以循环`[1,2,1]/4`平滑两次。实体路径根与Bip01根不增加平移/外力，原摆臂和上身动作保留。最大IK目标残差为8.42937e-8米，每帧权重、目标/实际踝点和残差写入`grounded-conversion.json`。

新动作明确命名`WalkGrounded`，原六动作Idle/Walk/Run/WalkStart/WalkStop/TurnLeft180继续可选。默认演示与模板面板优先选择新动作，页面明确注明“原始Walk + 足锁派生”。硬停止与动作窗口结束不续播WalkStop，不改变立即停止语义。

为避免Blender再导出改变原件，`rocketbox-retarget-grounded.py`将已求出的skin世界矩阵通过双方逆绑定矩阵转回原GLB骨参考基，只在原65ca角色中追加派生动画/二进制。原网格、材质、skin、节点对象、六个原动画JSON对象及原BIN前缀逐项保持一致；最终解析后的原rig和原六个clip也与同轴/同heading的原定义完全相等。没有以六个同名动作冒充原件保留。`grounded-retarget.json`记录这些断言。

更正：一次早期差分混用了heading=0的inspect定义与heading=1.5707961963的产品定义，其约2.29的分量差不能作为精度结论。错误结果保留在`checks/grounded-original-clip-difference.json`，同来源坐标对照与追加保留断言在`grounded-original-clip-difference-correction.json`。本切片以原JSON对象/BIN前缀和同坐标解析定义的严格保留为准。

## 局部碰撞几何

现有`human.ts`新增可选`footCollision`，只允许`leftAnkle-leftToe`和`rightAnkle-rightToe`两个分段，以`frameJoint + endpointsM + radiusM`表示规范骨局部米制capsule，并保存校准来源SHA与方法。角色GLB的`asset.extras.lyapunovHumanFootCapsules`显式声明源骨局部几何，导入层按同一源轴/heading转为规范坐标；非法骨、端点或半径拒绝。

`rocketbox-fit-feet.py`从原GLB真实shoe skin顶点做PCA内接拟合，再用Idle/Walk/WalkGrounded各65个姿态的鞋底支持下界校验。校准只改变两足，保留其他12段、碰撞mask、根高度、重力、dt与完整骨/传感器观测。MuJoCo和Isaac均通过已有segment提交路径求骨局部端点，不增加时钟、世界或服务。没有校准的旧角色仍走原端点/半径，旧默认行为保持。

这些capsule是鞋内部的碰撞近似，不把它们说成完整鞋面或自然受力足底。最终原生几何最低约+6.98mm；这是消除穿透后的几何余量，不能据此声称地面已产生足底承重接触。

## 原生量化与真实画面

最终7d9988资产在产品MuJoCo World中实际执行6秒/3000tick，dt=0.002。保存188个完整观测样本（每16步及最后一步），每个样本包括81骨、14段及原生步号。用原GLB skin权重、逆绑定矩阵与当前步原生骨姿态重建鞋底世界轨迹；同顶点相邻帧均位于全周期最低鞋底+15mm内，且至少15%鞋部顶点满足接地条件才纳入站立期。全部顶点/Frame原轨迹保留，不用摆动脚均值标定速度。

| 指标 | 原Walk | 最终WalkGrounded |
| --- | ---: | ---: |
| 左鞋站立期水平速度中位 m/s | 0.17054 | 0.002568 |
| 左鞋站立期水平速度p95 m/s | 0.26909 | 0.114772 |
| 右鞋站立期水平速度中位 m/s | 0.11155 | 0.015128 |
| 右鞋站立期水平速度p95 m/s | 0.18558 | 0.034571 |
| 左鞋最低世界Z mm | +5.728 | +0.629 |
| 右鞋最低世界Z mm | +3.365 | -0.839 |
| 足capsule最低世界Z mm | -51.017 | +6.984 |

保留起落边缘的p95，不声称所有点零滑移。约±1mm的视觉鞋底误差保留为真实几何/采样容差，没有抬根或修改门槛来清零。根路径速度仍为1.402372780m/s，最终X=8.414236678m。

执行方已用Cua实际看过第三版全身正侧姿态及侧面行走，无明显翻膝/T-pose，画面中有普通衣服、脸、头发、皮肤和手脚。该次录制用c093中间asset（与最终派生动作世界skin姿态等价，原件保留方式随后修正），真实`side.webm`与331原生Frame已落盘；**capture POST当时失败，viewer-front/side PNG未保存，不能计作PNG通过**。服务随后退出0、端口不可达，`Failed to fetch`保留；未以图像文件不存在的回执当成功。最终7d9988资产的原生轨迹已单独重跑，上表为最终值，准确最终图交主控独立打开新服务核对。服务现在另保存`server-close.json`以追溯明确收到的退出信号。

浏览器真实播放此前约9至11fps的限制仍未解决，不能用Provider RTF或连续帧拼图冒充流畅播放。

## 最短离线复跑

从源码根执行，`--assets`指已通过原11对象校验并转换为65ca GLB的目录；本线为`.runtime/human-r3/rocketbox-repro`。使用全新输出目录。包装器给Blender设置`--python-exit-code 1`，Python错误明确导致失败，不读取旧输出冒充新结果。

```bash
/home/s18/.bun/bin/bun run packages/human-crowd/scripts/prepare-rocketbox-grounded.ts \
  --assets /已验证的原65ca角色目录 \
  --out /全新派生目录 \
  --blender /snap/bin/blender \
  --python /home/s18/WS/Lyapunov/Dev/.runtime/sim-python/bin/python

LYAPUNOV_MUJOCO_PYTHON=/home/s18/WS/Lyapunov/Dev/.runtime/sim-python/bin/python \
/home/s18/.bun/bin/bun run packages/human-crowd/scripts/human-walk-live.ts \
  --asset /全新派生目录/Male_Adult_04-Grounded-Calibrated.glb \
  --source /全新派生目录/source.json \
  --out /全新原生与画面案例目录 --port 16654
```

Cua等ready后选择侧面并点“行走6秒并录制当前视角”，最后保存当前画面。页面和Provider必须同一步3000。正面重复用全新案例，或在末帧切正面保存实际画面。`rocketbox-trajectory.ts --case /案例目录 --asset /派生GLB`从已保存原生Frame重建鞋底轨迹，不启动第二物理世界。

本线可直接复制的已校验最终目录：`.runtime/human-r3/rocketbox-grounded-final/`；`source.json`包含完整许可路径、派生与校准报告。完整可移植Scene为`native/portable/scene.json`，带同一最终资源。全部SHA与元数据位于`grounded-retarget.json`、`grounded-conversion.json`、`foot-calibration.json`；最终原生轨迹在`native/shoe-trajectory.json`。

## 检查回执

本轮执行方本地检查，主控仍须对固定commit独立验收。日志均在`.runtime/human-r3/checks/`。

- `LYAPUNOV_MUJOCO_PYTHON=/已有环境 node --experimental-strip-types --test packages/human-crowd/test/native.test.ts`：退出0，3/3、0skip；原16组完整保留，新增足段从当前原生骨局部坐标求值、其他12段不变。日志`foot-native-final.log`。
- `LYAPUNOV_ISAAC_PYTHON=/已有Isaac环境 LYAPUNOV_USD_PYTHON=/已有USD环境 bun run packages/human-crowd/scripts/isaac-human-usd.ts .runtime/human-r3/foot-isaac`：退出0，原同world11项全部通过、closed。日志`foot-isaac.log`。这条验证原默认14段与共享适配回归，**未把它称为最终外部鞋部校准在Isaac的新资产实测**。
- `bun run test:ci --filter packages/human-crowd/`：退出0，含GLB显式校准与非法骨/半径负测，日志`foot-ci-final.log`。
- `bun x tsc --noEmit --pretty false`：退出0，日志`foot-tsc-shipping-final.log`；`bun run build:plugins`：退出0，日志`foot-build.log`。
- 最终两次完整离线派生均退出0、SHA相同，日志`grounded-final-prepare.log`和`grounded-final-repro.log`。最终Mu3000tick与轨迹命令退出0，日志`grounded-final-native.log`和`grounded-final-trajectory.log`。

第一次新增合成足校准fixture只改了共享定义source.kind，实例仍覆盖为procedural，校验层正确拒绝；修正fixture后全套3/3重跑0，初始失败日志`foot-native.log`保留。不得把其初次退出1报为通过。

### 2026-10-29 06:22 新加坡时间：显式源单位校验

主控审查要求确认`metersPerUnit=.5`时局部校准随rig/视觉一起缩放。导入代码对端点乘相同`meters`再转源轴/heading，半径同乘`meters`，不原样保留源校准向量。新增合法半身高夹具严格检查全部rig offset、两端点及半径同时缩半；原无校准单位支持不变。正式人体CI与根tsc退出0，日志`foot-half-units-ci-final.log`、`foot-half-units-tsc-final.log`。最初新夹具的数组推断不满足TS固定三元组，类型检查退出2；改成逐坐标严格比较后重跑退出0，原失败日志保留。

## 2026-10-29 06:55 新加坡时间：动作归属末步清理

主控几何QA之后发现人物控制归属清理缺陷。已先用未修版Mu/Isaac记录确切owner残留，再做同aid限定清理并在最终7d9988角色验证。修复、反例字段、8项原生生命周期和完整回归见[人物控制归属回执](HUMAN_CONTROL_LIFECYCLE.md)。此项与正常起停/转向动画及20真实人群性能是不同验收面，不互相替代。

## 2026-10-29 07:25 新加坡时间：外部clip停障/终点不回绑定

主控在20人+Panda基准准备时指出：`stopped`分支把外部`route.clip`清成None，可能回A/T绑定姿态。本轮先用最终7d9988单人从(-1.2,0,0)朝原Panda执行公共human动作，默认停障开启，记录真实native前/后骨姿态。旧版首blocked为step177，该步与bind骨位置误差为0；相对前一步最大坐标差0.493635m。该差并非只来自未加权祖先：左腕实际跳0.378124m、右腕0.432773m、右脚尖0.443508m。原生证据在`.runtime/human-r3/blocked-old/{blocked-receipt.json,semantic-jumps.json,frames.jsonl}`。`--expect bind`退出0只表示成功复现坏行为，不是产品功能通过。

薄修只作用于外部rigged GLB的已命名clip、walk/run停止分支：准备/运动时保留最后有效clip姿态；阻挡、互让、无路和终点/loop停留保持该姿态，不重新采样绑定，不继续原地空走。终点最后不足一tick的根位移按最后局部骨姿态平移/旋转到真实目标，随后保持，既不到目标前偷偷停住，也不续播clip。阻挡期间相位只扣除同一World物理dt累计的暂停时长，没有新墙钟/AnimationMixer/模拟世界；清障后仍沿现有物理时钟继续。程序化人物、无clip人物的旧行为不变，硬stop与时长窗口不延长。

最终角色实测：

- 同Panda首blocked仍为step177，前后原生骨最大差0，后续阻挡1000tick内最大变化0；与bind的差仍为0.493635m，证明保持了动作姿态。窗口2秒/end1000、owner为空、closed。
- 短非loop终点从X=-1.2到-1.196m，step2精确到达；扣除真实根平移后局部clip姿态前后差0，后续至1000tick骨姿态变化0，与bind差0.462196m。窗口仍2秒，不额外推进或续播。

准确命令（输出用全新目录）：

```bash
/home/s18/WS/Lyapunov/Dev/.runtime/sim-python/bin/python \
  packages/human-crowd/scripts/blocked-clip-verify.py \
  --scene /最终7d9988案例/native/scene.json --output /全新停障案例 --expect held

/home/s18/WS/Lyapunov/Dev/.runtime/sim-python/bin/python \
  packages/human-crowd/scripts/blocked-clip-verify.py \
  --scene /最终7d9988案例/native/scene.json --output /全新短终点案例 --expect held --endpoint
```

回执在`blocked-fixed/`与`endpoint-fixed/`，日志`checks/blocked-fixed.log`、`endpoint-fixed.log`。新原生测试使用经公共importHuman导入的合法合成GLB，另覆盖Panda与短终点，避免正式回归必须下载外部资产。完整Mu native 5/5、0skip，原16组与1e-9/1e-12门保留；Isaac native 2/2、0skip，原11项和8生命周期保留；正式人体CI、根tsc、plugins构建全部退出0，日志`clip-hold-native-all.log`、`clip-hold-isaac-native.log`、`clip-hold-ci-human.log`、`clip-hold-tsc.log`、`clip-hold-build.log`。

本修复证明保持有效动作姿态；不把单脚可能抬起的紧急保持称为自然Idle/停步过渡。20人基准还须记录每个人实际移动和阻挡时间比例，不据大量人物站住的结果推导20人持续自由行走容量。

## 2026-10-29：人体即时蒙皮矩阵与取景

主控稳态截图/重复frameSelected均正常，不能把第一次裤子极近景直接当持续取景故障。只读数值复现则确认一个显示前同步缺口：最终7d portable重开和3个平移SkeletonUtils克隆，仅applyHumanPose后即时bbox约0.00879×0.01836×0.00653m；执行renderer本来就调用的updateMatrixWorld(true)后恢复0.879×0.653×1.836m。原因是原updateWorldMatrix不调用SkinnedMesh重载中的bindMatrixInverse刷新。三个primitive均低于2m，不是自动取景阈值过滤。

按主控批准，仅把human-pose.ts姿态出口最后一次updateWorldMatrix改为updateMatrixWorld(true)，不改framing.ts/阈值/相机策略。新增真实SkinnedMesh、0.01祖先尺度和3平移clone的即时bounds回归，不用额外renderer更新掩盖，尺寸立即为1.8m；逐骨坐标及每顶点位置保持。

最终真实7d的5669个skin顶点×3实例比较：修版即时位置相对原版正常renderer更新后最大差0，原生骨输入位置误差最大5.41e-15m，均未画图或启动新物理世界。证据`.runtime/human-r3/bounds-compare/vertex-compare.json`、`bounds-fixed/bounds.json`，复现脚本`bounds-compare.ts`与`bounds-fixed-probe.ts`；原版18mm数据保留在`bounds/bounds.json`。这些是geometry/skin数值证据，材质贴图仅在内存移除依赖以供Node计算，不作为实际渲染图。

Viewer正式37文件、人体正式CI、根tsc、plugins构建均退出0，日志`instant-bounds-viewer-ci.log`、`group-ui-ci-shipping.log`、`group-bounds-tsc.log`、`group-bounds-build.log`。完整工作台初次取景交主控独验。
