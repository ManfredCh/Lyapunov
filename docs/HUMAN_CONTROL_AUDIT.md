# 高级人体控制器实际依赖核查

记录时间：2026-10-28 23:10（新加坡时间）。状态：**部分完成**；原生ragdoll受力、失衡和跌倒已有真实实现，稳定行走/平衡和跌倒恢复仍阻断。本轮没有训练、安装SDK、修改许可或下载大模型。

## 本机已有、可推理的固定候选

实际检查了已安装产品包中的Unitree G1策略，复用仓库现有policy-registry的固定身份，而未新建推理服务或控制时钟：

- 仓库`unitreerobotics/unitree_rl_gym`，revision `276801e46c5d433564f24658bac64f254b7d2d4b`。
- `deploy/pre_train/g1/motion.pt`，145745字节，SHA-256 `cf668f75b90d1abf73d2b87612a6e76bccc61ff7e083b63582d3f6aaa3c1759d`。
- `deploy/deploy_mujoco/configs/g1.yaml` SHA-256 `73044e7d355c61915695c16d6e09eb3efef46eec1e3d708fd3eb9157dfe3bbbb`。
- 实读原LICENSE为BSD-3-Clause，SHA-256 `aef6394ba1597725a68308167324e675f562e6606027404deb1b9da254c2b9c1`；原通知须保留，不用Unitree名称作背书。

在已有Isaac解释器中的Torch 2.11.0 CPU实际加载TorchScript，1×47输入返回有限的1×12输出，100次形状推理均值约0.335ms（此核查进程显式1线程，加载约0.037s）。这是权重身份与CPU可执行性检查，零向量输入不是人体平衡观测，也不是原生步态验收。

同一脚本另外真实编译当前原创人体ragdoll：nq=79、nv=60、18个球关节、1个自由根、0个执行器，`controlledJointNames=[]`。G1权重则要求指定12个hinge执行器、G1关节次序与默认角、47维按上游尺度和顺序构造的角速度/重力/命令/关节/上次动作观测，50Hz控制、.002s物理步长。当前人体的结构、惯量、限位和动作空间都不匹配。截断球关节向量、给观测补零、把12个输出分派给任意语义骨都不能构成适配；本轮没有这样做。

复跑脚本只读指定已安装权重，不联网、不训练；先核对SHA再加载模型，编译完自身World后关闭：

```bash
/已有解释器/isaac/bin/python packages/human-crowd/scripts/control-audit.py \
  --policy-root /已有固定Unitree策略目录/276801e46c5d433564f24658bac64f254b7d2d4b \
  --scene /已生成程序化人体目录/scene.json \
  --output /绝对输出目录/control-audit.json
```

本线实际输出为`.runtime/human-control-audit/final.json`与`final.log`，exit 0；其中`cpuShapeInference.status=PASSED`、`physicalHumanAdaptation.status=BLOCKED`，总体PARTIAL。命令退出0只表示核查完成，不表示高级人体控制通过。

## 官方MimicKit对象与实际可用性

从官方GitHub读取固定main revision `fbe1a36e878f036d6bf5521defb8eb3b8ab4170d` 的完整路径元数据、README、LICENSE及示例配置。此revision的`data/models/`只有`.gitignore`，GitHub release v0也没有独立权重附件。源码许可证为Apache-2.0；没有读取到的模型/动作包许可不能由源码许可代填。

README的测试命令引用具体权重`data/models/deepmimic_humanoid_spinkick_model.pt`，AMP示例引用`data/motions/humanoid/humanoid_spinkick.pkl`和`data/assets/humanoid/humanoid.xml`。官方README把资产/动作导向唯一SharePoint数据包入口：

[官方资产/动作数据包](https://1sfu-my.sharepoint.com/:u:/g/personal/xbpeng_sfu_ca/EclKq9pwdOBAl-17SogfMW0Bved4sodZBQ_5eZCiz9O--w?e=bqXBaa)。本机一次有界只读请求返回SSL `UNEXPECTED_EOF_WHILE_READING`，未拿到对象清单、包大小、权重、SHA或模型资产的独立许可，没有下载整包或改证书校验。

固定树中实际引擎是Isaac Gym、Isaac Lab和Newton，没有可直接接本产品World的MuJoCo引擎；本机已有Isaac SDK不等于已安装Isaac Lab。该人体XML使用其特定hinge顺序、被动弹簧/阻尼和motor驱动，仍须匹配该角色观测、动作归一化、关节增益/力矩范围及训练时步长。直接另起MimicKit世界只能证明另一个环境运行，不能替代本产品同世界控制。

必要阻断对象因此明确为：官方spinkick权重与配套动作/角色数据包的可获取身份、适用许可和控制合同；当前原创球关节人体还需要真实执行器/限位/惯量定义与匹配权重。解决前现有MuJoCo仍返回`HUMAN_DYNAMIC_CONTROLLER_UNAVAILABLE`；Isaac高级ragdoll仍返回其具名不支持错误，不静默回放。

原始元数据和访问结果分别保留在`.runtime/human-control-audit/repository-tree.json`、`README.md`、`LICENSE`、`data__envs__amp_humanoid_env.yaml`、`data__agents__amp_humanoid_agent.yaml`、`mimickit-data-access.json`与`backend-modules.json`。本轮未查询或下载HF对象，不存在镜像失败后转到其它来源的替代。

## 下一步成立的条件

产品已有SimControl与policy-registry推理/观测/停止通道可复用，缺的不是新调度器。需要先取得针对明确自然人体物理定义的合法权重和配套控制配置，确认完整观测与力矩接口，再做单人有界平衡/推扰/跌倒恢复的真实原生回归。当前G1是可执行机器人策略，不能填补这个角色匹配缺口；继续训练需要另行明确模型、数据许可和预算。
