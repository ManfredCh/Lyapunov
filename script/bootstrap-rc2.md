**RC2 固定源码重放与签名生成**

当前版本锁固定官方 dsh-v0.2.0-rc.2 / 639ed015397290b3745d163aafe02ffee4aa3f84。bootstrap 先验同代 artifact，再 clone/install/build；当前版本只消费 script/patches/dsh-v0.2.0-rc.2-product.patch 一份固定合并补丁。旧 7c3f05885033aa3aed74904d59a94692d12a47f7 的 53 项和原 script/sdk-source-integrity.json 保留在显式 legacy 入口，不能冒充 RC2。

签名文件不是“遇到冲突就继续”的凭据。冷 checkout 必须满足完整官方 base 字节、固定 patch 字节与 registry 签名、全部 affected 文件的合法完整 stage 或精确 final，以及没有未注册的新 source。缺件、未知尾字节、混合 hunk、私有 ignore 隐藏新增、错误 base/HEAD、无签名或被修改的 artifact 都拒绝；不使用三路 apply，不删除完整性校验。已经是完整 final 的 SDK 才可幂等，部分反向可应用不代表合法 final。

主控在新 SDK 编译、行为测试和剩余审查闭合之后才执行以下生成入口：

~~~sh
node script/generate-rc2-sdk-patch.mjs --sdk /绝对路径/固定RC2工作区 --write
~~~

不带 --write 时，生成器只在系统临时目录建立完整官方 RC2 副本，验证确定性的合并 delta、check→apply、全部 final 字节和第二次幂等，输出 hash 摘要后清理。它不会推断默认 SDK 路径，也不会修改原 SDK、产品 patch、manifest 或 lock。--sdk 的 HEAD 必须仍为固定官方 RC2，unmerged 必须清零；staged 与 unstaged 的最终 working bytes 都进入受审查差异。未忽略的新文件显式进入 patch，删除进入 null postimage；纯 mode 变化或无法精确解析的路径拒绝，不能悄悄遗漏。工作区或 lock 在验证期间变化时不发布。

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

CI seed 已改为精确官方 RC2完整Git对象，不再读取旧fork patchedBranch或使用浅clone。当前源码编译/outbound行为入口使用当前 RC2源码和本SDK构建的 lib/types，原7条page/follow/live/reconnect/raw/处置拒绝断言继续运行。正式当前bundle必须从真实锁签名读取并在干净RC2重放；合成4文件生成器fixture不能替代此检查。

~~~sh
node --test script/upstream-patches.test.mjs
node --test script/guest-model-patch.test.mjs script/guest-own-provider-patch.test.mjs
bun test --no-env-file --tsconfig-override=/绝对产品根/tsconfig.json script/browser-patch-composition.test.ts script/managed-provider-discovery.test.ts
~~~

缺旧Git对象、缺当前SDK hook/声明、缺当前正式bundle签名均失败，不skip、不降低既有test-ci清单或CI门槛。主控统一重建SDK Host后再签真实RC2，安装/测试程序不签用户数据或生产。
