# 人体插件阶段回执（2026-10-28，新加坡时间）

状态：部分完成。此为供主控独立验收的第一份实现检查点；后续原生回归、性能与UI实测继续追加。

已实现：插件和Host装配；模型Tool/人工Command同operation；原创真实skin GLB与资源许可登记；合法外部自包含rigged GLB/原地旋转动作导入及显式骨映射；Scene群组共享定义；seed/独立相位；物理tick运动学骨架/14段原生碰撞；自由根球关节ragdoll受力通路；原生body/geom姿态Frame；Viewer只消费物理骨姿态；既有物件清单创建/导入及属性控制入口。Isaac具名拒绝。

已运行：正式离线清单 `bun run test:ci --filter packages/human-crowd/`，第二轮3用例通过，退出码0（第一轮发现导入source中的undefined，被Scene JSON校验拒绝；已修复为省略可选字段）。日志 `/tmp/human-ci2.log`。

原生单人探针：`LYAPUNOV_MUJOCO_PYTHON=<已有MuJoCo解释器> bun run packages/human-crowd/scripts/probe.ts /tmp/human-native-probe-20261028`，退出码0；500步/1秒、根位移1米，Frame人体骨架与碰撞姿态来自原生数组。日志 `/tmp/human-probe.log`。

原生Panda接触和RGB-D：按开发文档命令运行 `native-scene.ts /tmp/human-native-scene-20261028`，退出码0，30个采样、142个帧事件，16个采样含真实Panda接触。峰值力约7627万N，暴露不让行运动学体顶住固定基座时的过约束；该数值不作为接触质量通过。实际场景、帧、图像与深度位于上述输出目录。需默认停障、暂停/停止、同世界多实例、代次/重开、导入动作与ragdoll继续取证。

未完成/未验证：自动绕行导航、ORCA/Recast容量承诺、平衡步态/受力恢复控制器、逼真角色外观、Isaac人体执行、完整人工GUI流程、Viewer性能。程序化样例不能替代这些能力。主控独立CI与验收尚未进行。

## 增量验收（2026-10-28）

主控审查修复：`crowd_inspect` 在读Frame之前先核对world所属Scene，新增相同revision/相同实体ID但不同Scene负例；ragdoll实时实体transform改为原生骨盆body乘逆绑定偏移，保持实体参考帧真实移动，不再回报Scene静态创作姿态。

原生 `node --experimental-transform-types --test packages/human-crowd/test/native.test.ts` 配合已安装MuJoCo解释器，2用例通过、0skip、退出码0；内部覆盖6组逐tick断言以及真实skin GLB导入的walk clip经产品Provider采样。日志 `/tmp/human-native-test2.log`。6组为：闭合循环每步最大位移0.002米（dt=0.002s）；暂停不推进、停止保持/重建清控制/旧代次拒绝；原生墙停障且有界结束；默认Panda停障1500步零人体接触；自由根球关节ragdoll受力/跌倒（骨盆0.95→0.1196米）且结束撤销外力；同tick批量/单人停止不影响他人/独立世界。

`native.test.ts` 已登记正式CI清单为 `envgate/exclude`：常规离线CI不把缺SDK的情况计为原生通过，需上述显式命令复跑。正式离线人体测试现为4用例，通过且退出码0（`/tmp/human-ci4.log`）。根tsc与全插件构建退出码0（`/tmp/human-tsc5.log`、`/tmp/human-build-all.log`）。

默认路径保守停障提前量扩大到0.65米，覆盖程序化摆腿前伸。`native-scene.ts` 继续保留显式 `avoidObstacles:false` 的强制不让行反例，结果标签为 `CONTACT_QUALITY_FAILED`，不作为动态障碍接触质量合格。

原生性能测点（同机MuJoCo3.13，dt=0.002s，10步，粗碰撞1段/人、完整19骨、间距1.5米、无机器人、不启用避障射线/互让；独立进程每档50秒上限）：1人编译0.0076s，RTF3.84，峰值RSS56.8MiB；20人0.072s，RTF0.354，60.4MiB；100人1.135s，RTF0.0678，75.7MiB；300人原生`mj_stackAlloc`在`mj_collision`栈内存不足（请求79,392,600字节、可用30,408,680）退出1；1000人50秒退出124。日志和JSON位于 `/tmp/human-performance-20261028/`。这些数据不是实时容量承诺，Viewer帧时间和实际机器人场景容量未由此测得。

### 更正与第二轮原生证据

主控发现初版人体geom位于group4，默认RGB-D显示组[0,1,2]把人体隐藏；此前「30组RGB-D」只能证明相机出图，不能证明人体可见。保留该失败结论。已在人体适配自身改为默认可见group0，全局capture默认完全不改；停障射线逐交点跳过已编译人体geom，不再依靠隐藏显示组。

默认显示组的真实RGB-D像素回归已通过：1364个蓝色人体像素，最小人体深度3.216米，同帧原生读数。持久复核产物 `/tmp/human-visible-native-20261028/verify.json` 与 `rgbd/30208384-8e8c-4fc2-b0fa-0ef8fb1e0dee.png`。原生分段外观与Viewer蒙皮外观仍分开说明。

粗模式优化：把纯观测骨骼标记从19个无碰撞顶层mocap body收敛到根body下原生sites，真实分段mocap碰撞保持；关闭编译时site_sameframe快捷标志以确保动态旋转被原生FK消费。粗模式为2body/人，300人编译成功（约9秒、114MiB），但RTF约0.013仍远低实时，1000人仍50秒超时。Python剖析显示逐骨FK/数组转换为主要耗时；原创程序化步态共享128相位表，外部clip保持原始采样。该优化解决一个容量失败点，没有建立实时人群容量结论。

真实Guest工作台走查：独立端口16482、运行根 `/tmp/human-guest-ui-20261028`。Edge中创建物理工作区→物件→创建人偶→选择行人1→人体动作→开始30秒→停止所选人物，返回 `STOP_CONFIRMED`，保留姿态且世界继续。界面实际可见19骨低多边形蒙皮外观与同tick的mujoco-site读数。真实Host还发现region schema缺additionalProperties导致插件未激活，已修并新增defineTool实际schema编译及6个Tool/Command入口注册回归。截图已在本次工具记录展示；完整工作台布局未覆盖窄窗/键盘/所有错误状态，因此不标完整人工视觉验收。

主控独立坏GLB负例发现骨架祖先环可能同步阻塞Host。现已在导入层用有界拓扑检查拒绝循环、多父/重复子节点、非法children索引、非法/重复skin索引，新增两节点a→b→a负例。没有修改范围外模块或改动输入原件。

第三轮定向检查：原生 `native.test.ts` 2/2、0skip、退出码0（`/tmp/human-native-test8.log`，包含8组逐tick/可见像素/共享相位误差断言与导入clip）；正式离线人体6用例通过（`/tmp/human-ci7.log`）；根tsc退出0（`/tmp/human-tsc6.log`）。已跑受影响回归：Viewer animation-reference 1文件、scene-kit session-isolation 1文件、sim-contract 9文件均通过（`/tmp/human-animation-ci.log`、`/tmp/human-session-ci.log`、`/tmp/human-contract-ci.log`），gate tsc退出0（`/tmp/human-gate-tsc.log`）。构建人体、Viewer、Shell、MuJoCo通过（`/tmp/human-build6.log`）。当前仍由主控对最终挑入版本独立验收。

## 首版导航与状态投影补齐（2026-10-28）

实现包内 `human_navigation.py`：根据当前原生 `geom_aabb/geom_xpos/geom_xmat` 的保守安全区构造显式固定Z平面网格，8邻域A*与逐段几何检查防止对角穿角，最多4096节点，不另建世界/时钟/调度器。人物让行或原生障碍持续阻塞时每0.5模拟秒有界重规划；无路时保留 `HUMAN_NAV_NO_PATH` 与blocked状态，真实阻塞移开后继续，动作总时限不延长。非平面和超网格预算具名拒绝。

已实测保存12组结果：`/tmp/human-navigation-native-20261028/verify.json`；新增实际墙体绕行到达、站立人物占道绕行、初始无路后阻塞人物经真实human动作移开，等待者恢复到达、L形障碍角不可斜穿并有界结束。墙绕行逐tick核对人物根不进入原生墙体膨胀安全区。原生Node入口2/2、0skip、退出码0（`/tmp/human-nav-native4.log`）。

本轮实际命令（仓库根）：

```bash
bun run test:ci --filter packages/human-crowd/
MUJOCO_GL=osmesa LYAPUNOV_MUJOCO_PYTHON=/home/s18/WS/Lyapunov/Dev/.runtime/sim-python/bin/python \
  node --experimental-transform-types --test packages/human-crowd/test/native.test.ts
MUJOCO_GL=osmesa /home/s18/WS/Lyapunov/Dev/.runtime/sim-python/bin/python \
  packages/human-crowd/scripts/native-verify.py /tmp/human-native-probe-20261028/scene.json \
  --output /tmp/human-navigation-native-20261028
./node_modules/.bin/tsc --noEmit -p tsconfig.json
bun run script/build-plugins.ts human-crowd lyapunov-shell sim-mujoco
```

正式离线人体6用例通过（`/tmp/human-nav-ci3.log`），根tsc退出0（`/tmp/human-nav-tsc2.log`），对应插件与Shell客户端构建通过（`/tmp/human-nav-build3.log`）。UI新增显式平面自动绕障开关及当前planned/blocked重算状态；通用物理属性按同world/generation/revision的原生人体Frame显示“人体碰撞已就绪/待同步”，不再给人体展示未生效的通用Collider写入控件。主控仍需独立验证挑入版本与新UI状态；旧人工创建/组控制/停止流程已由主控另行走查。

## Isaac与原生USD同世界补齐（2026-10-28，新加坡时间）

依赖说明：本线仅为集成测试挑入SimReady提交 `a563b421`、`3aa6257f`，在人体工作树对应 `4fe8120e`、`38e6aa3b`。这些是已有USD实现依赖，不作为人体新增交付。人体增量另行提交，由主控在已有USD集成树挑入。

更正能力边界：此前“Isaac人体明确拒绝”是当时的实现事实。本轮已复用共享人体定义、动作采样和路径状态，在现有Isaac World的唯一 `SM.step` 内通过真实 PhysX `RigidBodyView.set_kinematic_targets` 驱动；19骨标记与14段碰撞均为原生kinematic刚体，Frame从原生tensor读回 `isaac-body` 姿态。默认停障使用PhysX `raycast_all`，按当前实体路径排除人体自身/同类，保留对原生USD形状的真实阻挡查询。没有第二套时钟、世界或资产账本。

真实前置检查：SDK `/home/s18/WS/Lyapunov/Dev/.runtime/conda/envs/isaac/bin/python`，Isaac6.0.1.0，既有EULA标记为已接受；仅只读检查与复用，未安装、未改许可。USD解析复用 `/home/s18/WS/Lyapunov/.worktrees/simready-usd-20261028/.runtime/usd-python/bin/python`。一次独立Kit启动在人体代码加载前停于kit-initialize，90秒预算后按自身PID2953171回收，日志 `/tmp/human-isaac-probe2.log`；独立cache重试成功，保留该启动环境失败，不将其当作人体执行成功。

同world完整场景：`/tmp/human-isaac-usd3-20261028/receipt.json`，status=PASSED、10项检查全部通过、closed=true。包含原生USD静态/关节/自由刚体资产和人体：

- 同一world/generation/物理时间中，原生USD关节及人体14段CollisionAPI均存在。
- 面对原生USD墙，默认避障开启，人物停在x=0.8500米，blockedByGeom为实际USD collider路径。
- 显式非让行接触测试使用自由动态USD物体，3条原生接触，峰值约173.03牛；不把它说成人体受力动力学。
- CPU/none的实际PhysX LiDAR命中人体segment_7，欧氏量程2.8564米。范围/valid/hitGeom/预览在该目录lidar/，来源为isaac-physx-raycast-closest；不冒充RTX RGB-D。
- 真实GLB蒙皮的19骨经现有Viewer投影消费PhysX帧，最大位置误差约4.6e-16米；同帧包含USD原生body投影。
- 暂停时物理步不推进；选择性停止人物后，USD关节继续推进，人物骨骼保持。
- Isaac高级A*与ragdoll分别具名拒绝；ragdoll在重建前预检拒绝，现有world代次和步号保持。RTX/CUDA人体当前也明确未适配。

准确复跑命令（仓库根、全新输出目录）：

```bash
LYAPUNOV_USD_PYTHON=/home/s18/WS/Lyapunov/.worktrees/simready-usd-20261028/.runtime/usd-python/bin/python \
LYAPUNOV_ISAAC_PYTHON=/home/s18/WS/Lyapunov/Dev/.runtime/conda/envs/isaac/bin/python \
bun run packages/human-crowd/scripts/isaac-human-usd.ts /全新输出目录

LYAPUNOV_USD_PYTHON=/home/s18/WS/Lyapunov/.worktrees/simready-usd-20261028/.runtime/usd-python/bin/python \
LYAPUNOV_ISAAC_PYTHON=/home/s18/WS/Lyapunov/Dev/.runtime/conda/envs/isaac/bin/python \
node --experimental-transform-types --test packages/human-crowd/test/isaac-native.test.ts

TESTCI_PYTHON=/home/s18/WS/Lyapunov/Dev/.runtime/conda/envs/isaac/bin/python \
bun run test:ci --filter packages/sim-isaac/
```

Isaac正式离线18文件通过、退出0（`/tmp/human-isaac-ci3.log`）；首次裸工作树3个探针选到无numpy系统Python导致失败，复跑显式使用上述已有numpy/Pillow解释器。另更新一条既有静态测试的原生USD扩展名匹配以包含`.usdz`，不改生产USD逻辑、不削弱原断言。MuJoCo原生2/2、0skip继续通过（`/tmp/human-after-isaac-mujoco.log`），确认共享采样接线未破坏原Provider。CPU/none不证明RTX成像，实际WebGL UI仍由主控对最终集成版本独立验收。

### 混合batch逐成员时长收口（2026-10-28）

固定提交复核发现：父batch按最长成员推进，人体成员若只依赖父动作结束而不检查自身durationS，可能随较长的USD关节/settle窗口继续运动。共享人体advance现按本成员窗口停止采样和写目标；运动学保持最后原生姿态，ragdoll撤销外力，物理世界及其他成员继续。

已补原生负测：MuJoCo短人物0.1秒、长人物0.3秒，短人物实际只移动0.1米并保持；ragdoll短外力0.1秒在长成员继续时归零。Isaac人物0.1秒×0.5m/s与USD关节0.3秒（含额外settle）同batch，人物总位移仅0.05米。MuJoCo原生现13组检查/Node2用例通过（`/tmp/human-window-mujoco2.log`）；Isaac同世界原生现11组检查/Node1用例通过、0skip（`/tmp/human-window-isaac.log`）；均退出0。没有新增计时器或修改通用调度器。

## 继续实施：真实外部角色（2026-10-28 21:24，新加坡时间）

按CONTINUE_PLAN完成Khronos官方CesiumMan实读与固定，非HF对象、非镜像失败替代。固定revision4995a638c96dbc94376d3d6164e70fee3ac7f7a2，438044字节，SHA b7001eae…77d9，CC-BY-4.0及原Cesium标识通知留存。

必要兼容：矩阵祖先/正均匀尺度/显式单位与前向校准；保留19平移+19旋转；19尺度通道浮点噪声逐条报告；保留约7厘米髋部起伏及周期横摆，仅分离净水平根漂移。clip首帧建立初始碰撞，解决首次动作肢端突跳。Viewer绑定尺度保留，原始GLB不改。

MuJoCo与Isaac真实import→便携保存→独立根重开→1000步/2秒均完成。最终产物分别在本线 `.runtime/external-human-final-20261028/`、`.runtime/external-human-final-isaac-20261028/`。实际共享Viewer截图与6时刻原始57通道对照位于前者`viewer-canvas.png`、`viewer-validation.json`，最大骨误差3.38e-7米、对native误差3.2e-16米，errors为空；图片是实测帧回放，物理报告另在receipt.json。原绑定姿态/clip首帧对照失败与未校准版本保留在earlier external-human-native目录，不删除旧证据。

命令与许可范围见docs/HUMAN_EXTERNAL_CHARACTER.md。实际定向检查：外部原生Node1/1、0skip、exit0（/tmp/human-external-native-final.log）；正式人体离线7用例通过（/tmp/human-external-ci-final.log）；根tsc退出0（/tmp/human-external-tsc-final.log）；人体、Viewer、Shell和相关Sim插件构建退出0（/tmp/human-external-build.log）。性能优化仍在进行，本条不代表大量人群或高级控制目标完成。
