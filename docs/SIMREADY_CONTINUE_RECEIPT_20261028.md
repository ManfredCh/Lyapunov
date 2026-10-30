# SimReady 续作回执（2026-10-28，新加坡时间）

状态：**部分完成**。旧 Warehouse 的实际发现、详情、原生依赖获取实现和来源身份校验已接入；真实小资产下载仍被严格镜像/CDN纪律阻断，不能记为完整真实包通过。

## 新提交与真实产品反馈

- `4d036373`：Guest/local/隔离 Host 逐键保留显式 USD Python 配置，未知秘密仍隔离；解释器缺失/模块缺失有安装修复说明。主控已在真实整合 Host 重新打开材质 Scene 并显示六个材质面板，不用软链兜底。
- `f6840c53`：三个 USD 原生门接入已有 package.json 脚本与 gate-drivers 分类，完整分母和负对照保留。`dist-inventory` 未降低校验；实际失败缺的是三个 desktop 产物，补原 `build-desktop` 后本轮与主控均 24 例通过。
- `29c5a736`：区分 USD 格式、用途和源物理声明。`isaac` 来源指针不再单独表示机器人/自动物理，保留原件和真实声明。主控新 Scene 真实选择/框选保持 rev3、2实体、无 prepare/open/新地面，树显示 USD 资源。
- `4971b63a`：纯视觉 Scene 在 Host 重连时说明可继续显示/编辑，不再宣称恢复物理；原物理 Scene 恢复文案保留，34 个生命周期用例通过。

以上主控截图/AX由总任务回执维护；不把实施方假注册表或旧截图替代主控独立验收。

## Warehouse CSV 独立来源协议

固定源：`nvidia/PhysicalAI-SimReady-Warehouse-01@c7fe115cb79c7ddbd0532630d7768b5736b0ecc4`，源 README 明确 CC-BY-4.0，归属 NVIDIA Corporation。数据在 `packages/scene-kit/source-catalogs/warehouse-01/`：

- CSV 为原字节，SHA256 `f2bda7a5e6b1e80e5ce588ce678ec381fe4819b76250e28ca9c01860ca7d73c8`，Git blob `a85428129b18b9e7e0330a268186e8cec6b9c9de`；753 是这个 CSV 的实读目录行数，不是运行合格数。
- README 原字节 SHA256 `5321c004fd8fa762549978020ee97ed49eebf2c3412d6afeed9049f84c9b6fd2`，Git blob `b099703d5d5b1dda747894ec9271528dfe37e442`。
- `files.json.gz` 为同 revision 的镜像 `files_metadata` API 字段整理，返回 8804 项路径/大小/Git或LFS身份，不能据返回数量推导资产总量。压缩前后校验和、revision和取得方式见 `pins.json`。
- CSV/README 的镜像 CLI 缓存命中已核对源 Git blob，不冒称当次联网成功。默认明确返回 `PINNED_SNAPSHOT`。显式 `refresh:true` 的镜像失败返回 `PARTIAL` 和刷新错误，缓存候选仍可检查。
- CSV 原文官方 `asset_preview` URL 不传给浏览器自动加载；只保留相对缩略图路径和 `NOT_FETCHED`。缺缩略图不通过官方/CDN补取。

同一 `simready_search/detail/import` 根据来源使用 `warehouse-csv-v1`，不建立第二套资产账本。搜索保留原分类、标签、Q code 和 mass；未明确的 mass 单位不猜 kg。一条源 CSV 缺 USD 扩展名，从固定源文件表唯一确认后使用实际 `.usd`，原路径仍保留。

导入按真实 Sdf layer 读取全部外部引用/payload，不用正则猜组合；逐件验证源 LFS SHA256 或 Git blob 身份与大小，然后 OpenUSD 重新验证完整闭包。原件进入现有 ResourceLibrary 并保留行/许可/逐件身份来源；旧源没有新版 Central BOM/验证记录，不伪造。未知身份、外部依赖、模式引用、超预算或官方跳转具名停止。来源 manifest 不写重试时间，复用缓存不改变已登记版本；Central 旧带时间 manifest 也保留原字节。

可直接从工作台同一路调用：

```text
/simready_search {"repoIds":["nvidia/PhysicalAI-SimReady-Warehouse-01"],"query":"pallet"}
/simready_detail {"repoId":"nvidia/PhysicalAI-SimReady-Warehouse-01","revision":"c7fe115cb79c7ddbd0532630d7768b5736b0ecc4","packagePath":"Props/general/Pallet_A1/Pallet_A1_physics.usd"}
/simready_import {"repoId":"nvidia/PhysicalAI-SimReady-Warehouse-01","revision":"c7fe115cb79c7ddbd0532630d7768b5736b0ecc4","packagePath":"Props/general/Pallet_A1/Pallet_A1_physics.usd","maxBytes":16777216}
```

## 实施方验证与真实外部阻断

- `bun run test:ci --filter packages/scene-kit/test/warehouse-catalog.test.ts`：5 个用例通过，包含真实 ToolRegistry 搜索/详情、缓存/刷新失败、路径修正、缩略图不自动请求与 Git/LFS 身份。
- `bun run test:ci --filter packages/scene-kit/test/simready-assets.test.ts`：5 个用例通过，原 Central/镜像协议保留。
- `bun run script/gates/run-usd-assets.ts --out .runtime/warehouse-native-ready`：7 个用例通过，旧协议合法本地 fixture 实际经过 layer 依赖、文件身份、资源登记、重复缓存，以及坏 hash/缺身份拒绝；本地 fixture 不算 NVIDIA 真实包。
- `bun run test:ci --filter distribution/linux/payload-contract.test.ts`：24 个用例通过；发行载荷包含校验过的旧源元数据和归属。
- 构建和两个 tsc 的实际状态及最终日志由本轮提交回执一并报告，不凭触发视为通过。

真实最小条目 `Props/general/Pallet_A1/Pallet_A1_physics.usd` 仅 1053 字节，源 LFS SHA256 `d66db18b995209f586435cf6964a625b0dc0f31cc3b7e1cdb3639ca65366b064`。产品原生导入在镜像跳到官方 `huggingface.co` 前拒绝；同固定对象的 hf 镜像入口又在官方 `*.hf.co/xet-bridge-us/...` 前被守卫拦下。没有请求受禁域、没有扩大白名单、没有全库下载，实际已登记资产数为 0。

具体证据在本工作树：`.runtime/warehouse-real-probe/receipt.json`、`registry-after.json`、`.runtime/warehouse-pallet-mirror.log`。目录可检查和资产可取得分层报告，未取得真实包仍是本项未满足的外部条件。

## 原有上游校验的测试夹具性能收口

主控证实原 `upstream-patches.test.mjs` 在未改基线也于 600 秒文件门槛超时，单 RC2 用例在 120 秒门槛超时；实际链为本地 `git clone --shared` 仍进入 upload-pack/pack-objects，反复打包 SDK 历史。没有修改生产 SourceIntegrity、签名或超时。

限定修复为 `0aa3dd04`，只改测试文件：4 处本地临时 SDK 构造使用 `git init`、明确本地 `objects/info/alternates` 和固定 commit checkout。候选/replay 的工作文件、index、refs 和新增对象均独立，没有复制 source config/remote/promisor；本地对象缺失直接失败，不借网络补齐。原完整 base、字节、签名、未知新增、部分 hunk、final/幂等及原件保护断言全部保留。

同一正式命令 `bun run test:ci --filter script/upstream-patches.test.mjs` 两次完整 18/18 通过：236.7107 秒与最终 248.3440 秒，均在原 600 秒文件门槛内，所有单例保持原 120 秒门槛。最后一次的原生测试运行时间为 247.90 秒，差值为正式 runner 启动/报告开销。

最终报告 `.runtime/ci-upstream-local-fixture-final.json` 与 `.timing.json` 含退出 0 和真实时长；其 `SDK_SOURCE_READ_ONLY_PROOF` 输出记录 source 的 HEAD/config/index/exclude/refs 哈希和 14134 个受保护源文件摘要，before=after。源字节摘要为 `b23bda50a39156fedbcfa805b55009214b9c0e19ebcd9bd9d081dfaefd7d50a6`；夹具新写入的对象在 source SDK 中不可见。没有再完整打包历史来等待超时。

## 2026-10-28 23:11 +08：真实目录的托盘相关性修复

主控真实查询 `query:"托盘", repoIds:["nvidia/PhysicalAI-SimReady-Warehouse-01"], limit:3` 暴露名称子串误匹配：前三项全是 `palletknife`。原 CSV 明确把这 5 件标为 `painting_knife / Q1756462`，把 28 件托盘标为 `Pallet / Q505996`。修复在 `simready-assets.ts` 中按原标签/Q code 精确命中优先、名称和分类按词边界匹配；名称支持下划线、连字符、驼峰和简单英语复数。匹配完成后统一排序再截 Top-k，同分保持来源原序。厂商简称和已有中文别名保持可组合，不新增向量服务或源标签。

真实固定快照的 `托盘`、`pallet`、`Q505996` 前三项现在均为 `Pallet_A1_physics`、`Pallet_B1_physics`、`Pallet_C1_physics`；`pallet` 结果前 28 项均为原 `Pallet` 标签。其 36 条词匹配还包含 3 件原 `Pallet Truck` 和 5 件名称 `Pallets`，不会把无标签 `palletcomposition` 的子串当作明确类别。`palletknife`、`painting knife`、`Q1756462` 仍各命中源目录的 5 件调色刀。这是轻量词法检索，不推断未标注复合名称的语义。

本轮正式本地 CI 等效检查：

- `bun run test:ci --filter packages/scene-kit/test/warehouse-catalog.test.ts --json .runtime/ci-warehouse-relevance.json`：退出 0，6 个用例通过，含真实 753 行 Top-k 和真实 ToolRegistry 的同输入回归。
- `bun run test:ci --filter packages/scene-kit/test/simready-assets.test.ts --json .runtime/ci-central-relevance.json`：退出 0，5 个用例通过，增加 `LG冰箱` 厂商简称/中文组合检查；镜像守卫、缓存和失败非未命中语义保持。
- 根 `tsc --noEmit -p tsconfig.json` 与 `git diff --check`：退出 0。结果摘要在 `.runtime/warehouse-relevance-results.json`，类型检查日志在 `.runtime/tsc-search-relevance.log`。

本轮未改 CSV、文件表、pins、许可原文、来源身份或镜像策略；没有新增网络获取，也不改变上述真实小包的外部阻断。此增量仍由主控在整合版本独立验收。

## 2026-10-28 23:37 +08：人体插件与原生 helper 发行闭包

按主控限定范围，只读核对整合提交 `796e31ce5234a31557e4ae287d3831e02ee165eb` 的实际引用，并在公用 `distribution/linux/payload-contract.ts` 增加六项非空普通文件必需项：

- `packages/human-crowd/package.json`、`packages/human-crowd/dist/plugin.js`。
- `packages/sim-mujoco/python/human.py`、`human_batch.py`、`human_navigation.py`。
- `packages/sim-isaac/python/human_adapter.py`。

`runtime-patch.ts` 按 `packages/<插件名>/dist/plugin.js` 装配 `human-crowd`；既有 `build-plugins.ts` 从该包 `src/plugin.ts` 构建这个入口。既有 `package-linux.ts` 遍历工作区包并复制包内容，未排除这些 `.py` 或包元数据，无须新增源码副本或打包分支。MuJoCo worker 导入 `human` 与 `human_batch`，`human` 导入 `human_navigation`；Isaac worker/scene adapter 导入 `human_adapter`，后者复用兄弟 MuJoCo 包的 `human`。必需项因此覆盖这条跨引擎依赖链。

正式 `bun run test:ci --filter distribution/linux/payload-contract.test.ts --json .runtime/ci-human-payload-closure.json` 退出 0，25 个用例、164 个断言通过。新增负对照对六项逐件删除、写空、替换目录、替换为指向真实普通文件的有效软链，均准确点名该缺件；恢复后整体判据通过。测试固定期望清单独立于被测数组，不能通过删掉必需项使负对照自动消失。存在性夹具沿用现有临时 staging，不把占位字节当作引擎执行证据。

根 `tsc --noEmit -p tsconfig.json`、门 `tsc --noEmit -p script/tsconfig.gates.json` 及 `git diff --check` 均退出 0。类型检查日志为 `.runtime/tsc-human-payload.log` 与 `.runtime/gate-tsc-human-payload.log`。

本轮未修改人体或物理代码，也未复制主控人体源码。没有重打完整发行归档或运行安装；完整整合版本的发行与安装验收由主控执行。
