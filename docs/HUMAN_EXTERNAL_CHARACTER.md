# 真实外部角色与动作样例

2026-10-28 21:24（新加坡时间）。本轮选择 Khronos 官方 CesiumMan，而非用原创程序化人偶代替外部兼容性。

| 项目 | 固定事实 |
| --- | --- |
| 仓库 | KhronosGroup/glTF-Sample-Assets |
| revision | `4995a638c96dbc94376d3d6164e70fee3ac7f7a2` |
| 文件 | `Models/CesiumMan/glTF-Binary/CesiumMan.glb`，438044字节 |
| SHA-256 | `b7001eaeea8254bd44773bcd247e78696d94169388fbb2a1800fc69434e777d9` |
| 模型许可 | ©2017 Cesium，CC-BY-4.0 |
| 标识范围 | 保留模型内原Cesium标识及原通知；模型许可不授予标识在其它场合的使用权，不表示官方背书 |

许可与标识事实来自同revision的 [官方模型说明](https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/4995a638c96dbc94376d3d6164e70fee3ac7f7a2/Models/CesiumMan/README.md) 和 [官方标识通知](https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/4995a638c96dbc94376d3d6164e70fee3ac7f7a2/LICENSES/LicenseRef-LegalMark-Cesium.txt)。下载器只取这三个固定小对象并逐件核对字节数/SHA，不回退其它来源，不将GLB提交到源码。

## 必要兼容与通道处理

实际文件有19个skin骨骼、两个矩阵祖先和一个2秒动作，57条通道分别为19旋转、19平移、19尺度。现在：

- 可分解的父矩阵、正均匀缩放和显式`metersPerUnit`进入同一米制骨架；非均匀尺度/剪切明确拒绝。
- LINEAR旋转使用最短路径球面插值，平移通道全部保留。19条尺度通道相对绑定尺度最大偏差约1.31e-6，作为有回执的浮点单位尺度噪声归一化；真正伸缩仍拒绝，没有默默忽略通道。
- 水平**净根位移**按周期移交路径控制，保留髋部垂直起伏与周期横向摆动。CesiumMan几乎没有净水平位移，不能把约1厘米髋部横摆误当成必须删除的行进轨迹。
- 显式`headingOffsetRad`校准资产前向。本样例在Z-up后原前向为-Y，使用`+π/2`对齐产品路径的+X，避免侧身沿路径移动；UI提供源单位与前向角度输入。
- 保存了clip的角色以clip首帧建立真实初始碰撞姿态，避免绑定姿态到首帧约0.49米的肢端突跳。旧失败回执保留，不通过放宽对照阈值隐藏问题。
- Viewer保留源骨骼的绑定世界尺度，只消费原生姿态；源纹理、skin和原始GLB字节不改。

## 实测与边界

MuJoCo与Isaac CPU/none均从真实外部GLB执行公共`importHuman`，保存便携工程并从独立资源根重开，再执行1000物理步、2模拟秒动作。骨盆Z约0.6401–0.7109米，约7厘米起伏保留，实体根按0.5m/s移动1米。来源分别为`mujoco-site`和`isaac-body`。

真实共享SceneViewer中显示原模型纹理与蒙皮。6个物理时刻独立对照未经修改的原始GLTF动画，最大骨位置误差约3.38e-7米，Viewer对原生标记误差约3.2e-16米，`viewer.errors=[]`。截图属于**原生实测帧回放显示**，不把回放说成新的物理执行；物理执行报告与显示报告分别保存。

当前支持范围不含CUBICSPLINE、真实骨骼伸缩、剪切/非均匀骨架尺度、多skin及面部morph动画。原动作没有足锁或自动步频适配；选择不同路径速度时仍需检查足滑，不宣称动作捕捉级步行质量。高级稳定动力学控制另行验收。

## 复跑

在源码根选择全新输出目录：

```bash
LYAPUNOV_MUJOCO_PYTHON=/已有环境/bin/python \
  bun run packages/human-crowd/scripts/external-character.ts --fetch --out /全新案例目录

LYAPUNOV_ISAAC_PYTHON=/已有Isaac环境/bin/python \
  bun run packages/human-crowd/scripts/external-character.ts --fetch --engine isaac --out /全新Isaac案例目录

bun run packages/human-crowd/scripts/external-viewer.ts --input /上述案例目录 --port 16490
```

浏览器打开命令输出的本机地址，查看纹理/动作对照状态，再点“保存Viewer证据”。服务只授权该案例中已声明资源，输出`viewer-canvas.png`和`viewer-validation.json`。播放控制只回放已有物理帧，不推进世界。

无网络的原生回归使用已校验缓存：

```bash
LYAPUNOV_EXTERNAL_HUMAN_ASSETS=/缓存目录 \
LYAPUNOV_MUJOCO_PYTHON=/已有环境/bin/python \
node --experimental-strip-types --test packages/human-crowd/test/external-native.test.ts
```

正式离线CI不下载模型，外部用例已登记envgate；缺条件明确skip，不能计为通过。

## 2026-10-29 05:34 新加坡时间：普通着装成人与真实Walk

用户明确提高优先级，要求普通人外观和正常步行。新增微软官方MIT Rocketbox Male_Adult_04单人检查点，详细来源、转换、三轮真实性能、原生脚底轨迹和复跑见[普通成人步行回执](HUMAN_ROCKETBOX_WALK.md)。外观与原生运动已可见；脚滑及脚部碰撞代理穿地保留为待修质量项，不能把原Cesium样例或低模容量替代该目标。更正本文件旧兼容边界：现支持最多8个共享骨架skin及动画祖先/未加权指尖；独立骨架混合仍拒绝。暂停的C核/动力学控制原型未包含在这个检查点。
