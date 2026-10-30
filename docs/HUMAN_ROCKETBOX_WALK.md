# 普通着装成人与原生步行检查点

## 2026-10-29 05:34 新加坡时间

本轮落实用户“人要正常行走，而且至少看上去要像一个真正的人”的优先级。普通成人外观、原始骨骼Walk、同一物理World与共享Viewer已接通；单人接近实时。**正常行走质量仍为部分完成：原动作站立阶段有脚滑，通用脚部碰撞代理穿地。20个该角色加Panda的实用容量、自然起停/转向及动力学平衡尚未通过。**

源角色是微软Rocketbox `Male_Adult_04`，普通夹克、T恤、长裤与鞋，包含脸、皮肤、头发、手脚。使用唯一高LOD网格4752顶点、80个原骨和1个动画祖先，共81个物理骨观测点；实际Viewer显示9376三角形，4张纹理。没有把程序化低模、宇航服角色或官方预览当本产品外观通过。

## 来源与转换

官方仓库：<https://github.com/microsoft/Microsoft-Rocketbox>，固定版本`0943055db6ec570bcef9f2c8b41c9e5467c808f9`。官方README明确整个头像库在2020年改为MIT，并说明417个兼容动作；`LICENSE.md` SHA256为`17474e386e0b9e1a700cc3d06b2b0882a2c376d9c6b49c7f8274409b8f8d2352`，README SHA256为`bcf8013e3d5817a5dee5d1770b9943278189cd76b2d9b2abc243db99b703ecd6`。许可依据是官方对整个资产库的明确授权。

`src/rocketbox-sample.ts`列出11个固定文件的路径、Git blob、字节与SHA256，总61,584,928字节；连同原文许可/README为61,591,339字节，低于64MiB。包括普通FBX、4张原贴图及Idle/Walk/Run/WalkStart/WalkStop/TurnLeft180六个原始FBX动作；没有下载整库，也没有装SDK。原件与22MiB派生GLB保存在本地运行证据目录，不提交二进制到源码库。

现有Blender 5.2.2 LTS离线转换执行以下有记录的变换：

- 只选一个高LOD，保持原网格、权重、骨长，不叠加四档LOD。
- 重建PBR材质，颜色因子设为白色并连接原diffuse贴图，避免Max的黑色diffuse常量与贴图相乘。头发使用原alpha，双面、粗糙度0.78且高光强度0，避免透明头发像玻璃片。头部法线使用原normal贴图，未下载身体normal/specular。
- 动作FBX首帧的局部参考与角色A-pose不同。早期直接复制局部basis的转换已弃用；现将共同身体骨的真实世界矩阵逐帧烘焙到目标骨架，保留目标中性脸。仅排除动作中额外的两个Nub端点。
- 以30fps导出原始时间轴，Walk为1.066666722秒。导入保留81节点/每动作80旋转与80平移通道，单位scale数值噪声按既有容差归一化。原始根净漂移为1.495864376米，默认路径速度1.402372780米/秒；源前方为-Y，以+π/2朝向校准到产品+X。

派生GLB字节22,703,644，SHA256：`65ca07f23511a38bc2eb6945884fba7256c0b1ee8c1d5c84e02eac766b4402c0`。本轮已在全新输出目录从11个原件离线重建并得到完全相同SHA。`conversion.json`保留各动作骨长差、排除端点、材质/导出选项；源Walk身体骨参考距离最大差约4.16e-5米。

## 代码与语义

`glb.ts`允许1至8个共享同一骨架的skin，保留有动画但未被网格加权的指尖/祖先。独立骨架混合仍具名拒绝，原节点环/多父/非法索引负测保留。

`human-pose.ts`先按GLTFLoader保留的`userData.name`原名建立全部映射，再回退无原名对应的显示名，防止`A:B`清洗为`AB`覆盖真正`AB`骨。具备两种遍历顺序、共享skin及未加权指尖夹具。Viewer仅消费原生Frame骨姿态，没有AnimationMixer或另一个动作时钟。

`human.py`在World装配时把不可变rig/clip解码为私有数组，按完全相同的时间轴/插值类型合并通道；每个物理tick仍按原LINEAR/STEP和SLERP公式采样，随后真实FK并提交原生姿态。没有128相位近似表替换外部动作，也没有丢面部/手指/平移/传感器或降物理步长。缓存不写回Scene资源JSON；共享定义只编译一次。Isaac复用同一采样，原生姿态和tick所有权保留。

本检查点不包含工作区中暂停的C数值核、`human_batch.py`和profile包装原型，不增加发行文件或运行期编译。

## 真实单人测量

配置固定：普通Python worker，无profile包装；单Rocketbox角色、14段详细碰撞、ground开启、dt=0.002秒、3000tick、6秒动作、完整81骨/14段Frame、共享Viewer前台真实录制、60Hz最大输出请求。路径`[[20,0,0]]`、速度1.402372780米/秒、原Walk。根最终X=8.414236678米。

| 案例 | 墙钟秒 | RTF | 完整Frame数 | 原生步数 | Provider关闭 |
| --- | ---: | ---: | ---: | ---: | --- |
| 修改前visible-01 | 23.607691 | 0.254154 | 986 | 3000 | 是 |
| 修改后visible-02 | 6.659636 | 0.900950 | 319 | 3000 | 是 |
| 修改后visible-03 | 6.113916 | 0.981368 | 304 | 3000 | 是 |
| 修改后visible-04 | 6.114842 | 0.981219 | 309 | 3000 | 是 |

三轮全部保存，不挑最好值。第一轮与Mu原生回归并行，后两轮串行；实际输出帧数随墙钟输出节流而变化，不能据此说删字段或改了物理步。6个原始动作、3个相位、3294个含边界的时刻，对修改前逐通道标量参考比较，最大位置/四元数绝对差为0，门槛保持1e-12。

证据根为本线`.runtime/human-r3/`。`walk-performance.json`汇总所有结果，`rocketbox-walk-visible-02/side.webm`与`rocketbox-walk-visible-03/front.webm`是浏览器实际画布录制，未重新定时；相邻真实画面拼图为`side-continuous.png`和`front-continuous.png`。每例保留完整`frames.jsonl`、原生`receipt.json`、`source.json`、可移植`portable/scene.json`和原文`LICENSE-character.txt`。`viewer-close.png`已由主控实际查看，只作为脸/衣服/头发/手部外观证据；全身和Walk须另看录像。

## 足底检查与剩余质量差距

`rocketbox-trajectory.ts`用已保存原生81骨姿态、GLB真实skin权重和逆绑定矩阵重建当前步鞋部顶点世界轨迹，采用和Viewer相同坐标变换。接地区间要求同一顶点相邻帧均处于全周期最低鞋底+15mm，且至少15%的鞋部顶点满足条件，避免把摆动中的一两个低鞋尖算作完整站立期。原始每顶点/每Frame轨迹全部保留。

visible-02测得：左脚296鞋部顶点，站立期水平速度中位0.17054m/s、p95=0.26909；右脚244顶点，中位0.11155m/s、p95=0.18558。视觉鞋底最低3.365mm，左右脚最低点随摆动最高为30.08mm和44.08mm。**原动作仍有约步速8%至12%的脚滑，不能称无滑步。**独立Blender重建原GLB蒙皮轨迹也保留在转换目录的`stance.json`。

同时，现有通用14段脚capsule底部最低约-51.02mm；这与视觉鞋底不同，不能用蒙皮最低点证明碰撞自然接地。本检查点未静默抬根、关ground或缩所有碰撞段。下一切片拟为该外部角色增加由原鞋部几何推导的显式足段局部校准，仅影响两足；保留原始Walk与原代理对照。站立期将使用已有原始骨骼动作加有记录的腿部足锁派生，不能将运动学修正声称为动力学平衡。

`crowd_stop`与动作窗口结束仍立即停止控制、保留最后原生目标。本轮没有让WalkStop多播放2秒，现有16组暂停/停止/窗口回归保持通过；自然起停与转向过渡仍未完成。

## 精确复跑

从本源码树根执行。资产原件缓存根需包含`Assets/`、原文`LICENSE.md`与`README.md`；本轮是`.runtime/human-r3/rocketbox-source/files`。缺文件会具名失败，默认不联网。只有显式`--download`才按固定11对象从微软官方版本下载，先校验许可。

```bash
/home/s18/.bun/bin/bun run packages/human-crowd/scripts/prepare-rocketbox.ts \
  --assets .runtime/human-r3/rocketbox-source/files \
  --out .runtime/human-r3/rocketbox-repro-new \
  --blender /snap/bin/blender

LYAPUNOV_MUJOCO_PYTHON=/home/s18/WS/Lyapunov/Dev/.runtime/sim-python/bin/python \
/home/s18/.bun/bin/bun run packages/human-crowd/scripts/human-walk-live.ts \
  --asset .runtime/human-r3/rocketbox-repro-new/Male_Adult_04.glb \
  --source .runtime/human-r3/rocketbox-repro-new/source.json \
  --out .runtime/human-r3/rocketbox-independent-new --port 16650
```

Cua打开服务打印的URL，等“已就绪”，选择正面或侧面，再点“行走6秒并录制当前视角”。结束后点“保存当前画面”。一例只执行一次；独立重复使用全新输出目录和端口。新页在已结束的服务上恢复末帧并禁用启动，不显示虚假的ready。

```bash
/home/s18/WS/Lyapunov/Dev/.runtime/sim-python/bin/python \
  packages/human-crowd/scripts/clip-sampling-verify.py \
  --definition .runtime/human-r3/rocketbox-repro-new/definition.json \
  --output .runtime/human-r3/clip-reference-new.json

/home/s18/.bun/bin/bun run packages/human-crowd/scripts/rocketbox-trajectory.ts \
  --case .runtime/human-r3/rocketbox-independent-new \
  --asset .runtime/human-r3/rocketbox-repro-new/Male_Adult_04.glb

/snap/bin/blender --factory-startup --background \
  --python packages/human-crowd/scripts/rocketbox-stance.py -- \
  --assets .runtime/human-r3/rocketbox-repro-new
```

## 本轮检查回执

以下都是执行方本地CI等效或原生实测，仍由主控对固定commit独立验收。准确日志在`.runtime/human-r3/checks/`。

| 命令 | 退出码与结果 | 日志 |
| --- | --- | --- |
| `bun run test:ci --filter packages/human-crowd/` | 0，正式1文件通过，含新兼容夹具 | walk-ci-human-final.log |
| `bun run test:ci --filter packages/viewer/` | 0，37文件通过 | walk-ci-viewer-final.log |
| `bun run test:ci --filter packages/sim-mujoco/` | 0，3文件通过 | walk-ci-mujoco.log |
| `bun x tsc --noEmit --pretty false` | 0 | walk-tsc-final.log |
| `bun run build:plugins` | 0 | walk-build-final.log |
| `LYAPUNOV_MUJOCO_PYTHON=上述环境 node --experimental-transform-types --test packages/human-crowd/test/native.test.ts` | 0，2/2，0skip，原生16组 | clip-native.log |
| `LYAPUNOV_EXTERNAL_HUMAN_ASSETS=.runtime/external-human-native-20261028/source LYAPUNOV_MUJOCO_PYTHON=上述环境 node --experimental-transform-types --test packages/human-crowd/test/external-native.test.ts` | 0，1/1，0skip，原Cesium57通道回归 | walk-external-native-final.log |
| `LYAPUNOV_ISAAC_PYTHON=/home/s18/WS/Lyapunov/Dev/.runtime/conda/envs/isaac/bin/python LYAPUNOV_USD_PYTHON=/home/s18/WS/Lyapunov/Dev/.runtime/usd-python/bin/python bun run packages/human-crowd/scripts/isaac-human-usd.ts .runtime/human-r3/walk-isaac` | 0，同世界11项全部通过，closed=true | walk-isaac.log |
| 上述prepare/clip-reference/trajectory/stance命令 | 0；重建SHA相同/3294样本差0/真实足底报告 | rocketbox-prepare.log、clip-sampling-verify.log、shoe-trajectory.log、stance-check.log |

首次Viewer正式运行有2文件失败，原因是本隔离树缺未跟踪Go1本地原件；从主仓只读复制已有20MiB资料到本树忽略目录后，原命令37文件全过，未改测试或判据。第一次Cesium缓存选错目录，缺`origin-license.txt`而退出1；改用已有完整校验缓存后真实原生退出0。失败日志均保留，不计为通过。

## 2026-10-29 05:51 新加坡时间：公共模板入口与真实播放诊断

`crowd_spawn`新增可选`templateEntityId`，只接受当前Scene已存在的人物或`humanDefinition`实体。复用同一资源引用、共享定义和`sourceTransform`，实例只保存独立相位与覆盖；不另建模板库、资源副本或下载服务。无模板调用保持原兼容行为，UI明确称为“占位预览人偶”。原“创建或导入人体”面板列出Scene已导入角色并优先选择，批量创建走同一个Tool/Command operation，默认选择WalkGrounded（若有）或Walk，并根据原根净漂移/周期设置匹配步速。已导入骨架不能静默改身高，模板不存在/定义被删/资源版本过期均具名拒绝。

正式人体CI中的新夹具覆盖20实例共享一个定义、视觉变换、不同相位、原动作继承、可移植保存重开、模板删除/过期拒绝和UI默认选择/占位说明。`template-ci-human-final2.log`、`template-tsc-final2.log`、`template-build.log`均退出0。该条是操作层与面板接线的检查点，完整主工作台人工创建/运行验收与20真人加Panda性能尚待主控和后续实测。

主控独立复跑首检查点已确认原生/类型/构建与共享Viewer真实显示，但发现终端observe步3000未必是订阅流最后一步。现`human-walk-live-client.ts`在收到done时消费receipt中的实际`lastFrame`，强制呈现后结束录制；服务新打开页面也恢复该实测末帧。没有造Frame或多推进物理步。visible-06实测capture、Frame身份和Provider均为3000，0reject/errors。

补充播放证据：首三条修改后原视频实际分别为75帧/6.616946秒、50帧/5.633344秒、49帧/5.482559秒，仅约9至11fps。**近实时Provider RTF不能替代流畅的浏览器播放，这一质量门尚未通过。**没有重新定时、插帧或替换原视频。

在主控/另一子代理停止操作共享Edge后，本线用受支持的`Page.bringToFront`及窗口`focused:true`仅聚焦本测试页（原窗口已最大化，未改尺寸/浏览器设置）。visible-06独占复测：6秒动作墙钟6.734388秒、RTF0.890950、320完整Frame、Provider关闭；原video73帧/6.359279秒。页面visible/hasFocus均真，静态同页rAF间隔平均55.35ms/p95=66.7ms；流中平均87.14ms/p95=116.8ms。采样诊断的JSON解析平均0.326ms、pushFrame0.467ms、相机跟随1.838ms、实际applyFrame1.221ms、整个renderFrame3.955ms/p95=8.5ms；这些已测CPU成本不足以解释全部rAF间隔，调度/呈现仍待定位。`costsMs`和`rafIntervalsMs`只记录实际调用，不引入动画/物理时钟或补帧。原始诊断在`visible-06/viewer-side-static.json`和`viewer-side.json`。

## 2026-10-29 06:20 新加坡时间：足底增量

已完成原骨架/六原动作保留的WalkGrounded追加与显式外部足段校准，最终SHA、真实轨迹、原失败和复跑见[足锁与局部足段回执](HUMAN_GROUNDED_WALK.md)。最终普通人20+Panda容量、自然起停/转向及浏览器流畅播放仍未通过，不用单人改进替代这些目标。

## 2026-10-29：共享模板群组的面板投影

真人群组节点只存humanGroup而不重复humanDefinition，因此直接选择群组时现在从当前Scene解析组内代表人物，显示其许可/骨数/路径/原生读数，动作scope仍为groupId。群组的同组复选框固定选中，避免显示未勾选却实际作用全组。工作台原挂载条件最薄扩展为可解析的人物群组，无成员组给出明确说明、无动作入口。选中仅作为来源的humanDefinition资产时进入模板创建，默认尊重当前所选资产，不把非人物实体送入crowd_start。

未复制rig/clip、资源或注册表。静态UI夹具覆盖群组入口、源资产创建、多资产尊重当前选择和无成员说明；正式人体CI、根tsc、plugins构建均退出0，日志`.runtime/human-r3/checks/group-ui-ci-shipping.log`、`group-bounds-tsc.log`、`group-bounds-build.log`。完整UI仍由主控对固定提交走查。
