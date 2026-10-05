**RC2 固定源码重放与签名生成**

当前版本锁固定自有 fork `https://github.com/ManfredCh/deepseek-harness.git` 的完整集成提交 `6a90cdb159a08b6f1faf36a0eefbf7ff8a80c73a`，保留分支 `lyapunov-patched-0.2.0-rc.2` 与标签 `lyapunov-dsh-v0.2.0-rc.2-20261005`。官方 `dsh-v0.2.0-rc.2` / `639ed015397290b3745d163aafe02ffee4aa3f84` 是其可验证祖先，记录在 upstreamBase。bootstrap 先验同代 artifact，再从自有 fork clone/install/build；267 个已验证差异已经进入该提交，冷 checkout 直接验证完整 final，不重复应用。原固定补丁保留为集成差异的追溯材料，sdkProductPatch.includedInFork 明确这一点。旧 7c3 的 53 项与原完整性记录只留在显式 legacy 入口。

签名文件不是“遇到冲突就继续”的凭据。冷 checkout 必须满足完整自有 fork 快照字节、固定追溯 patch 字节与 registry 签名、全部 affected 文件的精确 final，以及没有未注册的新 source。当前已包含差异的 fork 快照不接受官方未集成的中间态。缺件、未知尾字节、混合 hunk、私有 ignore 隐藏新增、错误 base/HEAD、无签名或被修改的 artifact 都拒绝；不使用三路 apply，不删除完整性校验。

主控在新 SDK 编译、行为测试和剩余审查闭合之后才执行以下生成入口：

~~~sh
node script/generate-rc2-sdk-patch.mjs --sdk /绝对路径/固定RC2工作区 --write
~~~

后续产生新差异时，不带 --write 的生成器在系统临时目录建立当前固定快照的副本，验证确定性的 delta、check→apply、全部 final 字节和第二次幂等，输出 hash 后清理。它不推断默认 SDK 路径或修改原 SDK、产物、lock。--sdk 的 HEAD 必须为源码中声明且与 lock 一致的固定快照，unmerged 必须清零。未忽略新增、删除和全部最终工作字节进入审查；纯 mode 变化或不可精确解析的路径拒绝。

--write 仍先通过同一完整重放，再输出：

- script/patches/dsh-v0.2.0-rc.2-product.patch：逐文件固定顺序的完整索引 binary delta。
- script/sdk-source-integrity-rc2.json：registry 签名、完整 affected 路径、base/final 两个合法 stage 和逐文件 final hash。
- UPSTREAM_LOCK.json 的 sdkProductPatch 与 sdkSourceIntegrity。旧 sdkSourceIntegrity 记录保留为 sdkSourceIntegrityLegacy，其余原有 lock 字段保留，不能仅凭升级擅自删除旧字段。

两份 artifact 先发布，lock 最后原子替换；中断时最多留下签名不匹配的拒绝状态。bootstrap 消费的是已核 SHA-256 的内存字节，不因路径文件在后续变化而改用另一份未核 patch。生成后主控应独立核对 patch 的实际差异，再从干净同代 checkout 运行完整 bootstrap 与规定 CI；生成器的隔离源码重放不是模型、GUI、GPU、生产或已安装产品验收。

现有上游补丁测试内已加入 RC2 完整 clone 与拒绝矩阵；使用已有入口：

~~~sh
node --test --test-name-pattern=RC2 script/upstream-patches.test.mjs
~~~

旧 postimage 与旧补丁组合测试默认自包含：legacy-sdk-fixture 从 bootstrap 已取得的官方 Git 对象，在系统临时目录 clone 到固定 7c3，重放仓库已跟踪的 53 项，再校验原完整签名。不安装依赖、不构建、不启动旧产品；进程结束清理。当前上游为 blob:none 时，隔离仓按固定原 tree/blob 从官方补齐，checkout 即使退出 0 但报 error 也拒绝，不能用当前 RC2 工作文件代替旧 blob。显式旧 fixture 环境变量仍可用于诊断，但公开 CI 不依赖它。

CI seed 直接读取自有 fork 的精确提交并检验官方 RC2 祖先，不靠可移动分支或上游继续保留版本。当前源码编译/outbound 行为使用当前真实源码与本 SDK 声明，原七条 page/follow/live/reconnect/raw/处置拒绝断言保留。正式快照必须从真实锁签名在干净 checkout 核完整 final 与幂等；合成生成器 fixture 不能替代它。

~~~sh
node --test script/upstream-patches.test.mjs
node --test script/guest-model-patch.test.mjs script/guest-own-provider-patch.test.mjs
bun test --no-env-file --tsconfig-override=/绝对产品根/tsconfig.json script/browser-patch-composition.test.ts script/managed-provider-discovery.test.ts
~~~

缺旧Git对象、缺当前SDK hook/声明、缺当前正式bundle签名均失败，不skip、不降低既有test-ci清单或CI门槛。主控统一重建SDK Host后再签真实RC2，安装/测试程序不签用户数据或生产。
