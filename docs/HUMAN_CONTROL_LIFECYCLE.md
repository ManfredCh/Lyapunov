# 人物动作归属清理修复

## 2026-10-29 06:55 新加坡时间

主控在最终7d9988角色的Isaac几何QA末尾发现组合断言失败。14条真实足段射线与姿态数值已通过，但当时未把owner字典写入回执，因此主控随后更正为“结合源码推断的残留，尚待直接字段复现”。本轮先跑未修版、保存确切字段，再验证修版；不把进程退出0或源码推断当原生通过。

### 未修版实际反例

从`07eac8a1`提取两个worker原文到本线私有`.runtime/human-r3/old-owner/packages/`，配套依赖为当前同树只读副本，不写主控树或主仓。使用最终7d9988 Scene，经产品World实际执行20tick：

- MuJoCo：receipt `complete.status=completed`、活动动作列表`[]`，但`observedHumanOwnersBeforeClose={"walker":"complete"}`；closed=true。原生校验报告FAILED，原进程和包装器均退出1。完整证据`owner-old-mujoco2/`。
- Isaac CPU/none：相同20tick，receipt completed、活动列表为空，但确切owner同为`{"walker":"complete"}`；closed=true。SDK的app.close导致原进程退出0，**包装器仍按FAILED报告判退出1**。完整证据`owner-old-isaac/`。

两个目录的`owner-receipt.json`保存原始owner、动作ID、receipt状态和步号；`process.json`保存准确命令、原始退出码与信号。第一次Mu shadow少了sim-contract共享Python依赖，未建成World，单列在`owner-old-mujoco/`，不作为物理反例。

### 修复范围

只改两个worker的人物分支：

- `release_human_owner(aid,motion)`仅在当前`control_owners[entityId]===aid`时中性化该人物并pop归属；保留最后原生姿态，不推进tick。已经释放的短成员不会在旧父batch结束时再次撤控。
- 人物在自身最后一个实际物理步完成后就释放，不因长batch成员仍运行而继续占有。其Motion仍保留在旧batch内用于既有最终效果回执，动作时钟与成员窗口不改。
- 正常完成、采样失败、取消在`_motion_effect`读取终态前共用同一出口；人物不再走其后的通用重复neutral逻辑。
- `stop`的人物分支只把确实属于所选aid的目标加入`affectedEntityIds`，不再第二次无条件清人物归属。旧aid晚到取消不能清新人物动作；非human的owner、关节控制和停止语义保持原样。

没有修改SDK、创建时钟/世界/控制服务，没有改物理步、骨/分段/传感器字段或动作精度门槛。新增脚本位于human-crowd/scripts，仅是原生验收入口，不被worker导入，不增加运行时发行依赖。

### 修版实际结果

最终7d9988普通角色分别在MuJoCo与Isaac CPU/none完整通过8项原生生命周期检查，`observedHumanOwnersBeforeClose={}`、活动列表`[]`、closed=true：

1. 正常末步完成释放，非人物owner哨兵不变。
2. 新aid再次执行并正确释放。
3. 暂停中已接纳/排队动作取消，物理步与骨姿态不动。
4. 人物采样异常后动作failed、归属释放，原生步/末姿态不变。
5. 短人物先到窗释放，长人物继续；短人原生姿态保持。
6. 部分停止只撤所选人物，长成员继续到窗。
7. 已到窗短成员的旧父batch取消不能清更晚aid，`affectedEntityIds`排除该人物。
8. 旧活动成员的取消也不能无条件清不同aid或写人物姿态。

第7/8项仅在测试中注入owner元数据模拟晚到归属，明确不伪造物理姿态或运行第二控制器；其他案例均走当前产品World的真实execute/tick/stop。失败用例只注入采样异常以验证终结路径，未替换物理引擎。确切脚本为`human-owner-verify.py`，跨SDK启动包装器`human-owner-native.ts`沿产品`isaacLoaderEnvironment`和私有缓存，不更改许可或全局设置。

### 准确复跑

在源码根执行（选择全新输出目录）：

```bash
LYAPUNOV_MUJOCO_PYTHON=/home/s18/WS/Lyapunov/Dev/.runtime/sim-python/bin/python \
/home/s18/.bun/bin/bun run packages/human-crowd/scripts/human-owner-native.ts \
  --engine mujoco --scene /最终7d9988案例/native/scene.json --out /全新Mu清理案例

LYAPUNOV_ISAAC_PYTHON=/home/s18/WS/Lyapunov/Dev/.runtime/conda/envs/isaac/bin/python \
/home/s18/.bun/bin/bun run packages/human-crowd/scripts/human-owner-native.ts \
  --engine isaac --scene /最终7d9988案例/native/scene.json --out /全新Isaac清理案例
```

执行方最终证据为`.runtime/human-r3/owner-final-mujoco/`与`owner-final-isaac/`，两个包装器均退出0、8项通过、closed=true。若复跑旧版反例，给同脚本显式`--worker /旧版私有worker.py`，对应目录需要原配套Python/kit文件；包装器对FAILED报告始终返回1。

### CI与回归

执行方本地CI等效检查全部通过，仍交主控对固定提交独立验收。准确日志位于`.runtime/human-r3/checks/`：

| 实际命令 | 退出与结果 | 日志 |
| --- | --- | --- |
| `LYAPUNOV_MUJOCO_PYTHON=/已有Mu解释器 node --experimental-strip-types --test packages/human-crowd/test/native.test.ts` | 0，4/4、0skip；原16组（含3000tick/1e-9及当前步1e-12）保留 | owner-native-final.log |
| `LYAPUNOV_ISAAC_PYTHON=/已有Isaac解释器 LYAPUNOV_USD_PYTHON=/已有USD解释器 node --experimental-strip-types --test packages/human-crowd/test/isaac-native.test.ts` | 0，2/2、0skip；原11项与新增8生命周期项 | owner-isaac-native-all.log |
| `bun run test:ci --filter packages/human-crowd/` | 0，1文件通过 | owner-ci-human.log |
| `TESTCI_PYTHON=/已有Mu解释器 bun run test:ci --filter packages/sim-mujoco/` | 0，3文件通过 | owner-ci-mujoco-final.log |
| `TESTCI_PYTHON=/已有Isaac解释器 bun run test:ci --filter packages/sim-isaac/` | 0，18文件通过 | owner-ci-isaac-complete.log |
| `bun x tsc --noEmit --pretty false`、`bun run build:plugins` | 均0 | owner-tsc-final.log、owner-build.log |

首次sim-isaac离线CI使用系统Python，缺numpy；改用Mu环境后仍缺Pillow，出现3文件失败及随后1文件失败。未改测试/判据、未安装依赖，改用已有同时具备numpy2.3.1/Pillow12.2.0的Isaac解释器后18文件全过。原失败日志`owner-ci-isaac.log`、`owner-ci-isaac-final.log`保留；不归为产品代码红或伪造基线通过。
