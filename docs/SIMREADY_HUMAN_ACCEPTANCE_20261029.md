# SimReady、USD 与人体插件主控验收

## 最新补充：真人可见产物、GPU使用与精确合批（2026-10-29，新加坡时间）

用户要求查看已经接入的真人，并核对是否使用GPU。当前验收的真人为微软Rocketbox `Male_Adult_04`，最终GLB身份仍为下文的7d9988e5；批量测试复用这一款角色，未把官方115角色库全部导入。主控实际查看并向用户展示自己的`grounded-acceptance/walk-ui/viewer-front.png`与`side.webm`，另有完整工作台3人物`grounded-acceptance/workbench-ui/final.jpg`。这些来自项目实际渲染。人物通过运动学骨骼动画、足锁和同World碰撞段沿路线行走；身体受力后自主平衡尚未验收。

| 环节 | 实际使用设备或后端 | 证据与结论 |
| --- | --- | --- |
| 物理积分 | CPU，MuJoCo 3.13普通`mj_step` | 当前worker源码入口；没有接入MJX/Warp后端 |
| 人体采样、FK、当步观测、JSON | CPU，Python/NumPy与现有原生MuJoCo函数 | 已保存分段profile及实际源码；不能把渲染GPU当成这些计算的GPU证据 |
| 同次真人Viewer渲染 | Intel Mesa ARL核显，WebGL2/ANGLE，`softwareRendering=false` | 同次`viewer-side.json`明确设备；画面使用硬件GPU，但没有使用RTX 5090 |
| 当前Isaac人体适配 | CPU、`rendering:none` | adapter明确拒绝人体CUDA/RTX配置；尚未接通对应人体GPU数据路径 |

本机当前查询确认RTX 5090 Laptop/595.91.07，快照利用率0%、显存15MiB。该快照不是录像时的利用率采样；录像设备以上述同次WebGL记录为准。主控记录`GPU_USAGE_REVIEW.json`与执行方只读路线核对`GPU_ROUTE_READONLY.json`均在本轮证据根。未改驱动、系统GPU配置、浏览器设置或用户正式GUI。原始侧面视频77帧/6.670967秒，约11.5fps，未达到流畅验收。

精确clip合批切片`f5034b04`已由主控审查、独立验收并以`f050a66a`合入主仓。主控自行冻结a089参考，两SDK解释器各9240样本最大差2.22e-15；独立进程完整3000tick原生World对照最大geom矩阵差6.36e-13、contact累计3428一致、当前步native读回误差0、owner清空及World关闭。另有500tick停障解除对照。Mu原生6/6、Isaac原生2/2且0skip，正式Human/Mu/Isaac、root/gate类型、全插件构建均实际退出0。首次SDK补验因QA环境漏USD路径而2skip，已保留并标为未执行；修正环境后2例真正运行通过，不能拿前次exit0计通过。准确回执见`clip-batch-acceptance/CONTROLLER_ACCEPTED_MAIN.json`。

随后执行方用普通worker、原20人+Panda配置实测一次：6秒/3000tick耗86.816070893秒，Provider RTF **0.069111628**；较旧三轮中位0.044065约1.57倍。Viewer末呈现99.999秒、RTF 0.0600006；1026完整Frame、约418.42MB、末步3000、0拒0错、closed。20人均81骨/14段，平均移动时间比例0.7998793968、阻挡比例0.20005，与旧输入一致；仍不是20人持续自由行走容量。WebGL仍Intel核显。执行方已精确关闭自己的服务和Tab，主控核对小汇总与生命周期回执，未声称主控重新测得该RTF。原始大JSONL保留执行树，未提交到Git。

**当前仍部分完成：真人外观、基础步行与插件功能已验；20人实时目标仍失败，人体GPU路径尚未接通，真正SDF精确初始重叠仍阻断。** 后续继续已测CPU热点中的当前步姿态观测合批，保原81骨/14段、dt、完整Frame、默认停障与原生状态读取；不能降低观测或改变输出口径刷分。以下09:01快照及更早段落是历史，保留不删除。

## 当前状态快照（2026-10-29T09:01:51.935844+08:00，新加坡时间）

当前状态为**部分完成**。已实现并独立验收的功能包括原厂USD纹理/法线预览、独立标准MDL资源闭包、真实Warehouse托盘及米制静态包装、普通着装真人与足锁行走、模板批量创建和人体动作生命周期修复。**20真实角色+Panda整链实时能力尚未达到要求；SDF精确初始重叠仍阻断。** 下方历史段落保留原结论，其旧“0纹理/托盘缺件/授权未收到/只有低模”等描述不代表当前状态。

本次当前源码位于`/home/s18/WS/Lyapunov/Dev`的`fix/audit-remediation-20261026`，已合`d98d7954`的UI/实际20人入口及其后纯文档快照。后续性能优化仍由原`human_crowd`代理推进；`simready_usd`已经完成对应窄修及交接。两者均按用户指定`gpt-6.1-sol/xhigh`，主控审关键代码并独立验收。全部是本地开发结果，未推送、发布或重启用户正式GUI。

### 当前交付与边界

| 对象 | 当前实际结果 | 仍未通过的范围 |
| --- | --- | --- |
| 原厂纸箱USD | 30件原BOM字节/SHA保持，作者UV/Transform2d、法线、Albedo/ORM/normal三纹理进入原Three材质；完整工作台真实可见 | 不执行任意MDL、USD蒙皮/动画网络 |
| 独立标准模块 | 从已安装SDK登记Core Materials2.1.0/isaacsim-kernel6.0.1.0，6件BSD MDL传递闭包、版本/许可/逐件SHA独立登记；局部Ar resolver，不伪造HF文件 | 不把同名文件视为可信模块，不自动选择歧义版本 |
| Warehouse Pallet_A1 | 固定revision五件源完整；三原PNG12,886,794B逐件size/SHA匹配，例外已closed。原cm源与独立m wrapper都可便携搬迁后删生成源再重开；m wrapper不加刚体/不改源convexHull | 原cm直接Isaac仍具名拒绝；m wrapper是明确单位派生，非自动替代 |
| Pallet材质/物理 | 固定已验模块SHA的OmniPBR Albedo/ORM g-b/DX normal子集派生，保原shader身份。Root完整工作台看到木纹/SAFETY/端面；1kg探针600tick产生4原生geom接触，竖直力9.80622N | 不宣称MDL编译；原源是0刚体/1静态凸包，未证明托盘孔洞可供叉车通过 |
| 初始凸包/平面 | 完整cooked凸包顶点支持函数与native Plane正/反ray身份/pose校验；正间距/真实负深度有证据，保护带内保持未知。Pallet约−7e-8m处于±6.11um带内，`UNVERIFIED/pairs=[]` | SDF/动态/非convex及未覆盖类型继续未知；相切不刷成严格CLEAR |
| 普通真人 | 微软MIT Rocketbox Male_Adult_04，衣服/脸/皮肤/头发/手脚可见；81骨、每人14段。保原六clip/mesh/skin/IBMs/BIN前缀，追加WalkGrounded及两足显式校准 | 当前运动学；不宣称动力学平衡或自然起停/转向全部合格 |
| 脚底/停止 | 足锁减少站立期中位滑移；Root实测鞋底约±1mm、内部足capsule最低约+6.94mm，无原51mm代理穿地。Panda停障与短终点保最后有效姿态，不回绑定。人物按aid完成/失败/取消/短成员到窗清owner | 约束是局部鞋内碰撞近似，未宣称足底自然承重；过渡样本仍有滑移 |
| 真人批量插件 | 当前Scene已导入真实模板经原crowd_spawn复用同一Resource/Definition，实例不复制rig/clip。原面板默认真人、低模明确占位；组节点引用代表成员，资产节点保持模板创建语义 | 20人实时容量尚未通过，不把数量输入上限当容量证据 |

真人最终GLB为22,822,948B，SHA256 `7d9988e5b7ab5e2e6d96a1a0313391f6851ba55478f615e50cedebeae9e2271e`。原角色/六动作基础包为65ca07f2开头的固定字节；主控从自己的原件重新离线派生，得到同最终SHA。来源与转换见[真人来源](HUMAN_ROCKETBOX_WALK.md)、[足锁与校准](HUMAN_GROUNDED_WALK.md)、[控制生命周期](HUMAN_CONTROL_LIFECYCLE.md)。

### 本轮主控独立验收

以下为对应固定切片的本地CI等效或原生检查，准确命令/提交/退出码在各receipt中。没有仅凭执行方自述、进程存在、Kit exit0或漂亮图片判通过。

- 真实USD解析与材质原生门11通过/0跳过，包含未知模块、连接、UV拒绝；资源/场景便携闭包、同字节不同路径、删生成源后新库重开与BSD许可恢复通过。
- USD-Isaac原生门10项外层检查及12个静态convex-plane正反/边界/倾斜/非uniform正缩放/不支持类型/无tick场景通过，源SHA与查询前后World/SDK时钟、pose、actions、owners不变。
- 人体正式CI1文件、Mu3文件、Isaac18文件，Viewer37文件（含即时SkinnedMesh/.01祖先/平移clone边界回归）均实际通过；对应root/gate类型、全插件构建、diff退出0。
- Mu人体Node原生门5/5、0skip，保原16组、1e-9/1e-12门；Isaac人体Node原生门2/2，含原11项与新增8生命周期场景。旧版两引擎均实际复现completed且actions空但owner残留；修复后完成/失败/取消/重入/短长隔离/旧aid保护通过。
- 最终7d资产在Root自己的Isaac CPU/none World运行120tick，7时刻两足14次native ray均命中正确collider，中心与当前原生骨局部计算差≤2.79e-8m；最终actions/人owner均空、closed=true。初版FAILED与一次补采初始化120s超时保留，修复后再次独立通过。
- Root最终单人共享Viewer真实6s/3000tick，338完整Frame、前侧截图均步3000、0错0拒、closed；真视频约11.5fps。Root接受外观/步态方向，不把Provider速度等同流畅画面。
- Root主目录完整工作台：真实MIT模板默认选中→面板批量创建2人（共3真人/1定义）→人物选择并作用同组→同步Mu→双motion0.2s/100tick完成→运行中停止新动作得到cancelled/STOP_CONFIRMED→显式关闭World→scene_save portable。复制后从Root新库重开，3人/1定义/81骨/两足/全部引用与MIT许可SHA正确。原用户偏好仍Isaac，测试Host显式Mu，未暗改偏好。
- Root另用同真实20人+Panda Scene做50tick短窗原生完整字段功能检查：20人都实际移动，每人81骨/14段/同帧身份、Provider关闭；此短窗不记为6s性能成绩。原详细ActionReceipt被QA驱动同名文件覆盖，已更正命名；原before/after完整Frame与stdout/退出码保留，派生重核不冒充重跑。

默认414文件清单旧413通过/1个marketplace基线5s超时的结果继续保留。本轮按改动跑受影响项，未反复重跑最新全仓或宣称默认全绿；未验证的平台/设备也不自动成为通过。

### 20真实角色容量仍失败，正在修复

固定`a089763d`、最终7d角色、20人/81骨/14段/Panda、dt.002/6s3000tick/30Hz完整Frame、原两点loop/默认停障，三轮普通worker结果：

| 完成案例 | Provider秒 | Provider RTF | 点击至末呈现秒 | Viewer RTF |
| --- | ---: | ---: | ---: | ---: |
| 01 | 134.817688 | 0.044505 | 154.815900 | 0.038756 |
| 02-retry1 | 136.162233 | 0.044065 | 155.611900 | 0.038557 |
| 03 | 137.597307 | 0.043606 | 157.108700 | 0.038190 |

均3000tick/capture3000/0拒0错/closed，20人平均约79.99%时间移动、20.00%阻挡，不是多数站住的轻负载。原02服务ready后无帧退出0的独立失败另存，不算完成值。单轮全量JSONL约0.66GB，Viewer末呈现包含后端写全量日志的尾窗，因此与Provider分开报告。原始3条不挑最好；后续profile不当最终RTF。当前正在依据同输入的FK/观测/编码/协议分段定位并修复，目标仍为同配置RTF≥0.9，不能降骨/碰撞/观测/输出口径刷分。详见[真实性能](HUMAN_PERFORMANCE.md)。

### 真正SDF精确审计仍阻断

本机Kit/PhysX5.9.0、omni.physx110.1.13的兼容数据模式保留geom contacts与非根link正确位姿，但SdfShapeView原生backend不可用；初始化GPU数据模式虽能查询signed point，却使geom contacts变0且Hinge Link读回stale。Root独立复现：兼容模式6/6矩阵与原生contacts，实验模式5/6/geom0/GPU20个body粒度点，不能冒充精确geom反馈。有限点、凸化overlap、bbox或RepX导出的原三角面均不作精确CLEAR。RepX导出还可能使articulation view失效，相关失败/更正保留。

当前缺与该Kit ABI匹配、能保留原readback/geometry身份的cooked-SDF或明确pair-query入口；不使用其它版本头文件强接，不重建第二World、隐藏step或推进后回滚。诊断工具已Root独立验证真实错误返回1、超时返回124、完整兼容正对照返回0；这些只是诊断CLI通过，不是SDF功能完成。

### 当前可查看产物

本轮证据根：`/home/s18/WS/Lyapunov/receipts/20261029-simready-human-r3/`。

- 原厂材质完整工作台：`material-acceptance/ui/final.jpg`；独立标准库：`stdlib-acceptance/receipt.json`。
- Pallet原/m包装与原生闭包：`pallet-acceptance/gate/{original-portable,portable-moved}/scene.json`，物理`native/receipt.json`；工作台`pallet-acceptance/ui/final.jpg`及保留的旧`overlap-warning.jpg`。
- 真人最终派生：`grounded-acceptance/derived/`；单人真实视频/正侧图/逐帧证据：`grounded-acceptance/walk-ui/`。
- 主目录3真人工作台图与便携工程：`grounded-acceptance/workbench-ui/{final.jpg,portable/scene.json,reopened.json,receipt.json}`。
- 独立生命周期/真实足ray/凸包平面：`final-delta-acceptance/`；停障终点：`blocked-acceptance/`；新UI/20人短窗：`ui-perf-entry-acceptance/`。
- 三轮容量汇总/初始20人图：`performance-baseline/{summary.json,initial20.png,receipt.json}`；全量原始JSONL仍在执行树real20-baseline各原目录，未复制大文件到Git。

所有自有测试Host/World/Tab按pid/cmd/cwd和实际关闭回执结束，未停用户GUI/驱动/其它任务。用户2503文件原SHA快照仍保留，最终收口再逐件核验。以下历史状态不删除，以保留当时失败、授权前后及后续更正。

---

## 00:25初次验收历史（原文保留）


时间：2026-10-29T00:25:47.084095+08:00，新加坡时间。

结论：两条基础实现已合入当前开发分支，原生闭环和完整工作台均有主控独立证据；扩展目标仍为部分完成。真实厂商包获取受镜像规则阻断，20 人详细碰撞整链尚未实时，高级自然人体平衡与恢复控制尚未接通。默认 CI 存在一项在原分支同样复现的超时，不记为全绿。

## 版本、执行分工与落点

- 原版本：`b27cc70ee057187e40cf1344db234ec383a8c418`。
- 已验收功能版本：`fcafb4ef53e3a56ae3087c8642ac5b3dc37cbedc`，已快进合入 `/home/s18/WS/Lyapunov/Dev` 的 `fix/audit-remediation-20261026`；本文件为其后的纯文档回执。
- 两位执行代理：`simready_usd`、`human_crowd`，均按用户指定使用 `gpt-6.1-sol / xhigh`；主控审查实际变更并独立运行检查。
- 新增人体功能的最后两个集成提交为 `fb951d97`、`4175a192`，高级控制核查为 `89893640`；SimReady 旧目录与排序为 `debc2dd5`、`796e31ce`，人体发行闭包为 `19da0331`。
- 主仓已有 `design/` 与 `lefthook.yml` 共 2503 个文件逐件 SHA 核对不变；未重置、暂存或覆盖用户文件。

## 功能交付

SimReady 使用现有 Scene/Resource、ToolRegistry、Command 与来源路由。默认先 `asset_list`，再 `simready_search`，选定后 `simready_detail`、`simready_import`，缺合适候选才进入其它库或网页获取；来源失败保留 `BLOCKED/PARTIAL`，不伪装成未命中。接入 12 个 Central 库源和独立的旧 Warehouse CSV 协议。旧 CSV 固定 revision 的 753 行只是目录行数，8804 只是文件身份表项数，均不是已下载或合格资产数量。主控实际查询“托盘”返回 Pallet_A1/B1/C1；LG refrigerator 返回具体候选与固定 revision。

USD/USDA/USDC/USDZ 作为一等资源，保留原件、layer/reference/payload、纹理和原生物理声明；Scene 仅保存资源引用与实例覆盖，预览是标明来源的派生资源。支持多实例变体、原件不变、便携复制搬迁重开，以及基础 PreviewSurface/st 纹理。纯视觉 USD 不自动变为机器人。Isaac 的原生刚体/关节真实矩阵驱动同一个 Viewer。MuJoCo/Newton 的原生 USD 物理、MDL/任意 shader、USD 蒙皮动画等未接通范围见 `docs/SIMREADY_USD.md`。

人体插件沿用同一物理 tick、现有世界和 Frame。支持原创蒙皮人偶、seed/相位、批量创建、显式许可和骨映射的自包含外部 GLB、路径/动作、详细分段或粗碰撞、暂停和选择停止。MuJoCo 支持固定高度 A* 和自由受力 ragdoll；Isaac 当前限定 CPU/rendering:none 的基础运动学与原生停障，平面 A* 与 ragdoll 具名拒绝。外部 CesiumMan 固定字节、许可和 57 个通道经公共导入、保存重开、原生运动及真实 Viewer 验证。它不代表任意人体模型均可自动适配。

## 主控自动化与界面验收

以下均为本地 CI 等效检查；未触发或声称远程 CI 通过。

| 对象与检查 | 实际结果 |
| --- | --- |
| 集成 `19da0331`：根类型、gate 类型、全插件、桌面构建、diff 检查 | 全部 exit 0 |
| 默认清单完整覆盖 | 414 个文件均有实际结果；413 通过、1 失败，无遗漏；engine-panel 单项正式复跑通过 |
| 上游补丁测试 | 最后一组 script 35/35 文件通过；含真实上游补丁检查 |
| 集成 `19da0331`：USD 原生门、Isaac USD、同世界人体+USD | 7、8、11 项通过；物理 Provider 正常关闭 |
| 最终 `fcafb4ef`：MuJoCo 人体 Node 门 | 2/2、0 skip，含内部 16 组；20 人闭合 loop/3000 tick 保留严格 1e-9 等价门 |
| 最终 `fcafb4ef`：外部人体 Node 门 | 1/1、0 skip，固定来源、57 通道、重开及髋部起伏通过 |
| 最终 `fcafb4ef`：Isaac 人体 Node 门 | 1/1、0 skip，同世界 11 项通过 |
| 最终增量：人体与 MuJoCo CI、根类型、两插件构建、diff | 全部 exit 0 |
| 主目录默认 USD 解析器 | 独立安装 usd-core 26.5；版本断言与 --check exit 0，默认路径 USD 原生门 7/7 |
| 主目录全插件、桌面构建与发行检查 | 构建 exit 0；payload 25/25；dist inventory 24/24 |
| 主目录完整工作台，默认 USD/Isaac 路径 | 新工作区导入共同场景，正式面板启动；23970 开始、25105 STOP_CONFIRMED，同世界继续至 29063；当前帧 isaac-body/人体碰撞就绪、原贴图蒙皮可见 |

默认清单失败为 `packages/lyapunov-shell/test/plugin-marketplace.test.tsx` 最后 DOM 用例超过原 5000ms。候选连续失败；执行代理在原 Dev `b27cc70ee` 用同一正式入口复现 8 pass/1 fail、5001ms，相关测试与产品源码基线到候选无 diff。未修改该门槛、断言或相关产品。不能以此报告默认 CI 全绿。

完整分组编排的外层工具进程曾 exit 143；最后 script 子组独立继续，实际产出 35/35 文件报告。主控以 40 份实际 JSON 和 engine-panel 单项复跑逐文件核对覆盖，保留外层中断记录，没有声称该外层 exit 0。

USD 默认解释器为 `/home/s18/WS/Lyapunov/Dev/.runtime/usd-python/bin/python`。安装器创建独立环境，不修改既有 MuJoCo/Isaac 环境。发行包含两个 worker 和安装器，开发机 venv 不进入归档；其它目标首次使用仍须运行安装器。本轮没有重新打完整发行归档或验证真实安装包安装。

## 人群实际性能

主控从已合入的 Dev 启动 `performance-live.ts --ui-loop --count 20`，真实 MuJoCoProvider→WebSocket→共享 Viewer，0.002s、14 段/人、Panda 同 batch 运动、默认停障、完整 Frame。没有回放、隐藏角色、改碰撞 mask 或降低物理步数。

- 实际模拟 3000 步、约 6 秒；墙钟 18.618 秒，RTF **0.322268**，低于既有 0.9 门槛。
- 355 个真实 Frame，Viewer 拒收 0、错误 0；页面 visible/focus=true，Provider closed=true。
- 首人被 Panda 原生几何阻挡，最终 X=-0.7056m、blockedS=5.382；功能通过、实时性能部分完成。
- 执行代理同物理输入的无浏览器 Provider 对照最新实测 0.2224528211，原始结果保留；不能用主控较快的一次抹去机器吞吐波动。100/300/1000 的创建与短实测不能冒称这些规模实时。
- 当前人体动力学定义没有可匹配 G1 12-hinge 策略的执行器/观测映射，MimicKit 权重闭包尚未取得；不把已有 G1 推理或 ragdoll 跌倒当成自然人体平衡、行走恢复成功。

## 仍阻断与未验证

1. NVIDIA `box_cardboard_a01@653d91e...` 完整 30 文件包和旧 Warehouse `Pallet_A1_physics.usd@c7fe115c...` 原件此前都因镜像转向官方域/CDN而阻断；Robotiq Hand_E 的声明 metadata 在镜像缺件。元数据读取与夹具测试不能替代真实完整包取得。全程守住用户给定 HF 镜像规则，未获 CDN 例外授权，未静默回退或重复下载同一失败对象。
2. 20 人详细碰撞整链实时目标未过；大量自然人群的互让质量、拥挤密度和更大规模实时能力尚未验收。
3. 自然人体稳定步态、平衡、跌倒恢复缺合法且匹配的权重/物理与观测映射，未启动训练或下载大模型。
4. 当前正式运行中的客户端未被重启。界面证据来自主目录源码启动的自有隔离 Guest Host；本轮未验证真实 Electron 安装包、生产发布、GPU/RTX 人体或物理硬件。

## 证据入口与交接

完整本地证据根：`/home/s18/WS/Lyapunov/receipts/20261028-simready-human`。必要入口：

- `final-19da-ci/coverage-summary.json`、`orchestration-interrupted.json`：414 文件覆盖和外层中断。
- `baseline-marketplace/ci-marketplace-baseline-b27.json`：原分支同超时。
- `final-fcaf-delta/receipt.json` 与 0-7.log：主控最终增量检查。
- `main-integration/receipt.json`、`artifact-checks.json`、`default-usd-native/report.json`：实际合入、独立解析器、主目录构建和发行检查。
- `main-ui/receipt.json`、`stopped.ax.txt`、`final.ax.txt`、`final.jpg`：主目录完整界面与原生开始/停止。
- `main-performance-20/receipt.json`、`viewer-performance.json`、`full-page.jpg`：主控动态性能和画面。
- `final-checks/live-source-search-r2.json`：真实托盘与 LG 候选查询。
- `docs/HUMAN_CROWD.md`、`docs/HUMAN_EXTERNAL_CHARACTER.md`、`docs/HUMAN_PERFORMANCE.md`、`docs/HUMAN_CONTROL_AUDIT.md`、`docs/SIMREADY_USD.md`：接口、使用、范围和执行侧历史回执。

临时服务按自身 PID、命令、cwd 核对后正常退出，未停止用户 GUI 或其它任务进程。验收树与必要原始记录保留，未把模型、帧流或大日志提交 Git。


## 后续更新：本次CDN授权与真实厂商包闭环（2026-10-29T02:01:41.547599+08:00）

用户明确允许本次固定小包跟随镜像返回的公开文件CDN。以下更新替代上文“NVIDIA原件未取得、未收到例外授权”的当前状态；上文保留为授权前历史。人体性能、高级控制及默认CI既有超时结论不变。

真实对象为`nvidia/simready-assets@653d91e182011f357cf1644013cc94ddf194d349`的`box_cardboard_a01/com.nvidia.simready.packaging.json`，CC-BY-4.0。主控独立按本轮开始前已有的固定revision缓存、Git blob ETag、descriptor SHA和源BOM pin交叉核验，再复制冻结并逐件重算：**30/30件、21,502,613字节**全部匹配。当前严格镜像刷新descriptor仍转官方resolve页，已具名拒绝；缓存没有冒称当次metadata网络成功。

下载采用任务局部fetch注入，实际取件仅涉及`hf-mirror.com`与其返回的`cas-bridge.xethub.hf.co`；连同一次托盘有限尝试，响应体共12,666,464字节，官方Hub请求0。全局hf守卫、产品默认镜像策略、设备权限与源资产保持不变。本轮取件结束标记已封存。

真实资产促成两项窄修，并经主控独立验证后合回Dev：

- `aeca5889`：相同字节但不同相对路径的USD层均保留，可能改写引用的layer保持独立副本。主控在旧代码`import-r1`复现便携缺层失败，修复后`import-r2`通过独立搬迁重开，原30件SHA不变。USD原生8例、既有portable-relocation的1文件3例、Central5例、Warehouse6例、类型和全插件构建通过。另两个Blender portable envgate本轮未执行。
- `8af50eba`：实际所选prim/variants/instance-proxies中的启用SDF，在CPU/none进入runtime stage前具名拒绝`ISAAC_SDF_COOKING_REQUIRES_CUDA`，公开提示CUDA要求。主控独立正式Isaac CI为18文件116例通过，公开错误18例、简单USD8项、人体11项原生门及类型/全插件构建通过；真实GPU原生双实例检查也通过。

更正证据边界：先前参数为cpu/none的直接Provider成功发生在宿主GPU可见环境，不能代表纯CPU隔离成功。主控完整Host的CPU隔离首次确曾在SDF cooking等待，Kit报PxCudaContextManager/bad_function_call，已取消并保留失败。修复后，主控在正式CPU隔离Host验证默认SDF会明确失败并结束初始化；同会话显式打开源自带PhysX Disabled变体则真实ready，worker中nvidia/dri节点均为空。主控另在实际GPU隔离Host，以默认PhysX Enabled原SDF完成双实例下落与完整Viewer运行，碰撞已确认；没有改写源碰撞来让CPU通过。两种源变体不宣称物理等价。

可用交接场景（均再次逐件核验30件源BOM，含原始USD/材质/图像，无SDK运行缓存）：

- 默认SDF/GPU：`/home/s18/WS/Lyapunov/receipts/20261028-simready-human/cdn-controller/handoff/nvidia-default/scene.json`。
- 显式非SDF/CPU变体：`/home/s18/WS/Lyapunov/receipts/20261028-simready-human/cdn-controller/handoff/nvidia-explicit-cpu-variant/scene.json`。
- 说明与文件SHA：同目录`README.md`、`FILE_MANIFEST.json`、`receipt.json`。

本包仍为1个派生mesh、0个纹理；UsdTransform2d、normal与MDL未还原，白色受限预览不是原厂贴图质量通过。SDF精确初始overlap审计仍UNVERIFIED。旧Warehouse Pallet_A1虽核验2件89,074字节，仍缺`Props/general/Pallet_A1/OmniPBR.mdl`的固定源身份，具名阻断且未注册。

本轮主控证据：`cdn-controller/package-verification.json`、`candidate-checks/receipt.json`、`sdf-guard-checks/receipt.json`、`native-gpu-r3/receipt.json`、`ui/gpu-ui-receipt.json`、`ui/cpu-guard-ui-receipt.json`及`ui/gpu-final.jpg`。全部自有验收Host正常退出0。默认全量CI未因本轮窄修重复跑414文件，沿用先前完整覆盖与本轮受影响项独立复验，不声称最新全量CI全绿。
