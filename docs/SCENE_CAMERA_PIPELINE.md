# Scene 声明相机接入两引擎（相机合同）

Scene 的两处相机声明如何进 MuJoCo / Isaac 的**已有**命名相机族：
`camera_list` / `camera_adjust` / `camera_capture(_multi)` / `camera_project_annotation`。
不新增第二套相机数据库或录制器；引擎里就是原生相机（MuJoCo `mjModel` 相机、Isaac `UsdGeom.Camera`），
采集/标定/标注走的仍是既有那条路径。

更新（2026-09-28）：真实 Isaac 6.0.1 RTX 验收已覆盖三相机同帧、手部挂载 FK、FOV／分辨率、界面手动操作及原生 Agent 调整、标注／数据集导出。RTX 下 `camera_list` 与 `camera_adjust` 用 Fabric 实时父节点结合 USD 局部安装变换；采集仍读取实际渲染相机。详情见[运行时相机回执](../bugfixHistory/FUNCTIONAL-RUNTIME-CAMERA-20260927.md)。

采集登记保留实际标定与米制深度；宿主发布暂存文件后同步 worker 的登记路径。Inf／NaN 原样保留在 NPY，JSON 的深度范围只统计有限正值，无有效值为 null。不带 captureId 的标注实际渲染一次，登记为不可导出的 ephemeral 采集，不要求 outputDir。同 revision 的显式 sim_sync 也会清除临时相机覆盖。

## 1. 坐标系、单位与轴

- 右手系、Z-up；长度米、角度度。相机轴约定与 Blender / USD / MuJoCo 一致：
  **+X 右 / +Y 上 / −Z 前**。
- 实体 `transform`（`positionM` / `quaternionXyzw` / `scale`）是**相对父实体**的局部 TRS；
  相机沿用同一口径：有 `parentId` 时，相机的 TRS 是相对父实体的安装位姿。
- `components.camera.direction` 是**世界系**视线方向（与 TRS 独立的一条声明），用于交叉核对：
  以 TRS 世界朝向为准的前提是它真给出朝向；两者不一致时按下面的规则处理，不静默改写。
- `components.camera` 字段：`fovYDeg`（引擎实际使用，必须 ∈ (0,180)）、`direction`、`isActive`（机位是否激活，
  原样带进回执）、`lensMm` / `sensorWidthMm`（**只是源件声明**，用于回显核对，不参与投影计算）。
- `components.viewerCamera.cameras[]`（66 的 Scene 命名相机，只读兼容）：`[{name, savedAt, state}]`，
  `state` = `{position, quaternion, target, up, fovDeg, near, far, intrinsics}`。其中
  `position/quaternion`（`[x,y,z,w]`）是**保存时的世界位姿**（不是局部 TRS），`fovDeg` 是竖直视场，
  `near/far/intrinsics` 是当时那块画布的口径，只回显核对；`quaternion` 缺失/非法时按
  `position→target` 取景并标 `orientationSource='viewer-camera-target'`。同一实体上两处声明都读、
  互不覆盖；名字缺省用实体显示名（命名相机用条目自己的 `name`），同名一律让位给已在册的相机。

## 2. 世界位姿与挂载点

| 情形 | 世界位姿 | 挂载点（物理推进后随之运动） |
| --- | --- | --- |
| `components.camera`，自由相机（无 `parentId`） | 实体世界 TRS | MuJoCo `worldbody` / Isaac 实体根 Xform（静态） |
| `components.viewerCamera` 条目 | `state.position/quaternion`（保存时的世界位姿） | 同下（实体根 Xform，静态） |
| 父实体相机，父体有物理体 | 父体世界位姿 ∘ 相机局部 TRS | MuJoCo 父实体根 body；Isaac 父实体的 articulation 根 / 刚体 prim |
| 父实体相机，父体没有物理体 | 场景声明的世界位姿 | 静态挂载 + 结构化告警（可用，但不假装跟随一个不存在的物理体） |

- 相机世界朝向：TRS 的世界旋转 ≥ 1−1e-4 地与 `direction` 对齐时用 TRS；
  TRS 是**单位旋转**（没有实质朝向）时按其世界 `direction` 做 look-at 兜底（`orientationSource='direction'`）；
  有实质朝向但与 `direction` 冲突时**保留 TRS**，并登记 `SCENE_CAMERA_DIRECTION_MISMATCH`（含偏差角）。
- 安装位姿一律由「相机世界位姿 × 挂载点世界位姿⁻¹」算出（只保留旋转+平移），
  所以父体在 MJCF/URDF 里自带偏移、或 Isaac 挂到 articulation 根 prim 时，安装关系都被自动吸收。

## 3. 命名与共存（绝不覆盖用户原件）

- 引擎相机名 = **`<entityId>/<实体显示名>`**（与既有原生相机前缀约定同一命名空间）。
- 解析（`resolve_camera_name` / `SimService.listCameras` 的消费方）接受两种写法：
  实体限定全名 `entityId/名字`，或**实体局部名简写**；简写命中多台即按歧义拒绝（`AMBIGUOUS_CAMERA`），
  不会静默挑一台，也不会串台到别的实体。
- 与**同实体**的原生 MJCF/USD 相机同名时：保留原生相机、跳过 Scene 声明，并登记
  `SCENE_CAMERA_NAME_CONFLICT`（MuJoCo 进 `warnings`；Isaac 在同一名字上给出 `UNSUPPORTED_CAPABILITY`
  + 说明，原生相机属性一个字节都不改）。
- 用户原有的腕部/头部 MJCF/URDF 相机不受影响：Scene 相机不会与它们抢名、抢路径、抢 prim。

## 4. 光学与标定口径

**K 优先、fovy 兜底**：声明里有合法像素 K（`intrinsics.fx/fy/cx/cy/width/height`）时按 K 装配；只有视场
（`fovYDeg`／`fovDeg`）时走 fovy 路径。`capture`/`camera_list`/`camera_adjust` 的 `calibration.intrinsics` 报的是
**该分辨率下实际参与渲染的 K**（不是声明值的原样回显，也不是另算一份），并带 `intrinsicsSource`：

- `engine-intrinsics`：声明的 K 真的进了 MuJoCo 渲染。装配用引擎原生字段
  `resolution = (W_c, H_c)`、`sensorsize`（声明 `sensorWidthMm` 优先，否则 36 mm 按 K 的长宽比配高）、
  `focalpixel = (fx, fy)`（**不折成 fx=fy**）。引擎的 principalpixel 口径是"主点相对图像中心的偏移、符号与 CV 相反"，
  声明的 CV 主点按 `principalpixel = ((W_c−1)/2 − cx, (H_c−1)/2 − cy)` 换算（负值合法）。
  回执另给 `appliedIntrinsicsPx`（实际应用的声明值，六个字段）与 `engineIntrinsics`（引擎侧读数换回像素：
  `fx_eff = fx_cfg·W_v/W_c`、`fy_eff = fy_cfg·H_v/H_c`、`cx_eff = (W_v−1)/2 − cx_cfg·W_v/W_c`、同式 cy）。
- `mjcf`：实体自带的原生 MJCF 相机。原件里已经有 `focalpixel/principalpixel` 的**一个字节都不改**（不重写成 fovy），
  回执把引擎读数换回 CV 口径（`cx = (W_v−1)/2 − principalpixel_x`）上报。
- `fovy`：只声明视场（没有 K）的老相机，`fx = fy = H_v/(2·tan(fovy/2))`、主点恰在 `((W_v−1)/2,(H_v−1)/2)`，
  与视口长宽比无关。

改输出分辨率（`capture.width/height` 或 `camera_adjust.width/height`）：焦距按视口等比缩放、主点按
`((W_v−1)/2,(H_v−1)/2)` 跟随；相机在源分辨率（引擎相机的 `resolution`，即声明 K 自己的 W_c×H_c）下的 K 不变，
回执用 `intrinsicsAtReferenceResolution` 给出**本次调用参考分辨率**（调用给的 width/height，未给则 640×480）下生效的 K。对已有 K 的相机给 `fovyDeg` 只重标定焦距
（`fovyApplied: 'intrinsic-focal-rescale'`：`fy' = H_c/(2·tan(fovy/2))`、`fx' = fx·(fy'/fy)`），主点不动；
纯 fovy 相机给 `fovyDeg` 仍是整幅竖直视场。仅移位／只改 width/height 不动 K。

畸变：MuJoCo 3.13 的相机投影只有透视/正交（`mjtProjection`），**没有镜头畸变模型**。声明了非零畸变时如实声明
（`calibration.distortionModeled=false` + `distortionDeclared` 回显 + `SCENE_CAMERA_DISTORTION_UNMODELED`），
不假装已建模（也不因此拒绝整台相机）。

- 深度是**沿相机 −Z 的米制轴向距离**（MuJoCo `distance_to_image_plane` 语义一致）；背景像素是远平面值，不是 0。
- 反投影：`p_cam = [(u−cx)·d/fx, −(v−cy)·d/fy, −d]`，`p_world = R·p_cam + t`，
  `R` 是 `worldFromCamera.rotationMatrix`（列 = 相机轴）。图像行号向下增大（`+y_cam` 向上 → 行号更小），
  由地面剖线的真实深度钉死。深度通道的射线映射与 RGB 像素约定差 (+0.125, −0.375) px（见 §6 的实测），
  用整数像素取深度做反投影时会带这么多像素当量，量级在 3 m 处 ≤5 mm 级。
- Isaac 侧相机 prim 会写 `lyapunov:sourceFovyDeg`，`capture()` 按目标宽高比重算光圈，
  所以同一台相机换分辨率时视场语义不变（MuJoCo 由 `mjModel.cam_fovy` 直接给）。

### 标注深度来源与像素边界（Isaac `camera_project_annotation`）

- 引用 `captureId` 时，深度取该 capture 记录里 **`select_capture` 命中的那台相机条目**的
  `cameras[].depth.uri`（真落盘 npy）；不是 capture 记录的第一台，也不是调用方传入的 `depthM`。
  `depthM` 只作"必须与真实读数一致"的核对输入（不一致 → `ANNOTATION_DEPTH_MISMATCH`）。
- 像素边界检查在**共同的 `depth[v,u]` 读取之前**、按该 capture/本次渲染的真实 `intrinsics` 做：
  `u∈[0,width−1]`、`v∈[0,height−1]`；正越界（`u=width`）与负越界（`u=−1`）都判
  `PIXEL_OUT_OF_BOUNDS`，不夹紧像素、不把其它异常归到这个码。
- 未给 `captureId` 时用本步 fresh-render 深度，边界检查与引用路径同处、同码。
- 无 Kit 回归：`packages/sim-isaac/test/camera-annotation-dataset.test.ts` 用 AST 执行真实 worker
  `_remember_capture` / `_camera_resolution` / `project_annotation` 并引用真 numpy `.npy`
  （fresh-render 数组是明确单元夹具，不是 RTX 证据）。RTX 真机执行由设备可见会话另行验证，本树不声称已通过。

## 5. 结构化告警码

| 码 | 含义 |
| --- | --- |
| `SCENE_CAMERA_FOV_INVALID` / 非法条目 | `fovYDeg` 不是 (0,180) 内的有限值，该相机不进引擎（不猜视场） |
| `SCENE_CAMERA_NAME_CONFLICT` | 引擎名与已有相机/已占用路径冲突，Scene 声明让位，原生保留 |
| `SCENE_CAMERA_DIRECTION_INVALID` | `direction` 不是 3 个有限数值 / 零向量，按 TRS 取景 |
| `SCENE_CAMERA_DIRECTION_MISMATCH` | `direction` 与 TRS 世界朝向不一致，保留 TRS 并标出偏差角 |
| `SCENE_CAMERA_PARENT_UNSIMULATED` | 父实体没有物理体，相机按声明世界位姿静态挂载 |
| `SCENE_CAMERA_VIEWER_POSE_INCOMPLETE` | 命名相机声明没有可用四元数，按 `position→target`（或实体 TRS）取景，回执标出实际来源 |
| `SCENE_CAMERA_INTRINSICS_INVALID` | `intrinsics` 缺字段／非有限／焦距非正／width·height 不是 1..16384 的整数像素数／`distortion` 不是有限数值数组；不猜 K，退回 fovy 或干脆不装 |
| `SCENE_CAMERA_DISTORTION_UNMODELED` | 声明了非零畸变，但 MuJoCo 3.13 的相机投影没有畸变模型：未进渲染，标定标 `distortionModeled=false`（畸变声明仍回显） |
| `SCENE_CAMERA_FOV_INTRINSICS_MISMATCH` | 同一台相机同时声明了 `fovDeg` 与 K，两者派生的竖直视场差超过 max(0.5°, 1%)：按 K 装配（K 更严格），但不静默丢掉声明的 `fovDeg` |

## 6. 实现与验证位置

- MuJoCo：`packages/sim-mujoco/python/worker.py`（`compile_scene_cameras` / `scene_camera_intrinsics` /
  `scene_camera_optics` / `scene_camera_rotation` / `_camera_engine_intrinsics` / `_camera_effective_intrinsics` /
  `camera_list` 的 `cameraSource='scene-camera'` 出处字段）。
  真实行为测试：`packages/sim-mujoco/test/scene-camera.test.ts`
  （`node --experimental-transform-types --test packages/sim-mujoco/test/scene-camera.test.ts`）
  ——真实引擎出 RGB/米制深度、逐像素核对透视几何、相机移动后同一世界物体换像素、父实体跟随；
  同一个文件里也跑 66 命名相机（世界位姿/视场/K 回显/真实帧/反投影到地面 + override）这一组。
- **K 的像素级验收**（task 99）：`packages/sim-mujoco/test/camera-intrinsics.test.ts`。方法：8 个等轴向深度 3 m 的
  自发光彩色标记球，按"深度门（±0.6 m）+ 归一化色度"分离出各自像素质心（色度对白光 Lambert 缩放与逐通道 gamma
  不变，所以不靠亮度阈值），再用**真实 RGB 质心**做回归，逐标记核对渲染位置与声明 K 的投影预测（残差 ≤0.5 px），
  并从两端标记独立反解 (fx,cx)/(fy,cy)（不复用回执里的 K）；覆盖非方形像素、偏心主点、竖幅、原生 MJCF
  `focalpixel/principalpixel`、改分辨率（`u₂ = 2·u₁ + 0.5` 且深度不变）、仅移位/只改 FOV/clear、
  静态与运动父体跟随、以及真实深度反投影回世界点（实测落在标记球**前表面** 0.11–1.32 mm 内；
  到球心 30 mm 即球半径，属深度图给可见表面的正常效应）。同一套几何在 `probe_fovy_focal.py`（任务目录内的独立探针）
  里用**地面/侧墙的深度几何**交叉核对了 fovy 与 K 两条路径的焦距：拟合焦距与报出值相对差 ≤1.5e-5（四个视口），
  即报出的 K 就是渲染用的 K；同一探针量出深度通道的射线映射相对 RGB 像素约定偏 (+0.125, −0.375) px
  （两台相机、两轴独立解出，残差 ≤3e-4 px），这是渲染器深度 pass 的亚像素约定差，不影响报出的 K 字段本身。
- Isaac：`packages/sim-isaac/python/scene_adapter.py`（`scene_cameras` / `scene_camera_axis` /
  `matrix4_from`）+ `packages/sim-isaac/python/worker.py`（`camera_list`，只读、不需要 RTX）
  + `packages/sim-isaac/src/provider.ts`（`listCameras` 转发）。
  装配层行为测试：`packages/sim-isaac/test/scene-camera-adapter.test.ts`
  （在真实 `Usd.Stage` 上执行真实源函数；不启动 Kit）。
- Isaac 侧的**多视角采集 / 位姿 override / 像素标注 / 数据集导出**已实现
  （`worker.capture_multi` / `camera_adjust` / `project_annotation` / `export_camera_dataset` 与 Provider 转发）；
  无 Kit 的真实算术/纯实现与 AST 真实现回归见 `packages/sim-isaac/test/camera-annotation-dataset.test.ts`，
  RTX 真机执行由设备可见会话另行验证。
- 出参形状：`listCameras` 的 `cameras[]` 两台引擎共用 `cameraName / entityId / localName / status /
  cameraSource / cameraComponent / parentBodyName / fovyDeg / worldFromCamera`；`cameraSource` 为
  `'scene-camera'`（Scene 声明编译进引擎）或 `'mjcf'`（实体自带原生相机），`cameraComponent` 区分
  `'camera'`（Blender 机位）与 `'viewerCamera'`（66 命名相机），源件声明的
  `lensMm/sensorWidthMm`（`declared*`）与 `near/far/intrinsics`（`declared*`）原样回显。
  Isaac 额外带 `cameraPath` / `frameBackend`（位姿读自 fabric 还是 usd，物理推进写的是 fabric），
  MuJoCo 额外带 override 家族字段。

## 7. 边界

- 相机**装配**不影响场景碰撞中心、physicalization 与终端入口；也不改 66 的 Scene 命名相机结构
  （只读接口 + 必要兼容：读 `components.viewerCamera.cameras[]`，不写入、不代它存 localStorage）。
- MuJoCo 侧命名相机的 `intrinsics`（含非方形像素、偏心主点）**会装进引擎**（`focalpixel`/`principalpixel`/`resolution`），
  标定回执报的就是渲染用的那份 K；Isaac 侧（本树状态）仍只按 `fovyDeg` 写光圈（`vertical = 48·tan(fovy/2)`、
  `horizontal = vertical·4/3`），不读像素 K —— 跨引擎对齐留给 Isaac 侧任务，本树未改；同一台相机要在两引擎给出
  同一份像素 K，需要 Isaac 侧也按 K 装配（或由调用方只声明 `fovYDeg` 并对非 4:3 视口的差异知情）。
- 畸变没有进渲染（MuJoCo 无畸变模型，见 §4）：非零畸变如实标 `distortionModeled=false`，
  需要畸变的训练数据必须在消费者侧另做去畸变/合成或改用带畸变的渲染器。
- `lensMm/sensorWidthMm` 只是**源件声明的回显**。Blender 导出侧（`packages/blender/src/world.py`）目前只发
  `lensMm/sensorWidthMm/fovYDeg/direction/isActive`，**不发像素 K**，所以这类相机在 MuJoCo 走 fovy 路径
  （像素尺度由 `fovYDeg` 派生，`sensorsize` 只用声明的 `sensorWidthMm`）；要让它的像素尺度可核对，
  需要导出侧补 `fx/fy/cx/cy/width/height`（跨范围，本树未改）。
- 引擎相机帧与 3D 视口/Viewer 截图是两条路径：相机族的回执是引擎渲染的真帧，
  与截图不能互相替代。
- 非均匀 `scale` 的父实体会在安装位姿里被按刚体处理（去掉斜切分量）；Scene 相机按刚体语义装配。
