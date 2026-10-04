# Robot priority reference

## Documented robot priorities

The table records documented model priorities as of 2026-09-22. A priority tier does not establish installed assets, policy readiness or physical execution. Model names are matched to registered identities.

| 族 | T0（最常用） | T1 | 与 Dev 现状关系 |
| --- | --- | --- | --- |
| 机械臂 | Franka Panda、UR5e/UR10e | KUKA iiwa14、xArm6、LeRobot SO-101/ViperX(ALOHA) | T0/T1 多数已在库；SO-101/xArm6 为缺口 |
| 机器狗 | Unitree Go2（前代 A1/Go1） | ANYmal、Mini Cheetah、Spot、B2 | Go2 已适配；Go1 权重在库但 `POLICY_ADAPTER_UNAVAILABLE` |
| 无人机 | Crazyflie 2.x；generic quadrotor+PX4 | Tello、DJI Mavic/Matrice | Crazyflie 已验；PX4 桥与资产入库为缺口 |
| 灵巧手 | LEAP、Allegro、Shadow | XHand2/DexHand、RH56、Dex3 | LEAP 通过；Allegro 漂移 FAIL、Shadow 抓取 FAIL |
| 人形 | Unitree G1 | H1、R1、Digit、Figure 类（无资产） | G1 双引擎通过；H1 Isaac 未收口 |
| AGV/叉车 | —（用户已移出默认 T0 目标） | MiR、Jackal/Husky | 保留 `forklift_c` 原包与历史记录，不作为默认验收或示范 |

UR5e has conflicting T0/T1 entries in the priority and expansion references. The registry reports that conflict explicitly instead of selecting a tier automatically.

## 用户范围调整（2026-10-04）

用户明确将 `forklift_c` 移出 T0 默认目标。当前 canonical `packs/t0-roster.json` 保留 11 个确认 T0，UR5e 的 T0/T1 文档冲突继续独列。此调整不将叉车自动转入 T1/T2，不删除原包、模型、用户资产或历史验收证据，也不继续把它列为本轮默认示范。
