# 一条命令发布

在 Dev 的 `main` 中运行：

```sh
bun run release:publish
```

命令发布 **main 已提交的版本和已准备的 Linux/Mac 归档**，自动同步 Dev 与公开 GitHub 仓库、Release、OSS、安装清单及官网。WSL2 使用 Linux 包。它沿用各平台已有出包与验收流程，不在 Linux 上编译 Mac 安装包。

## 本机准备一次

本机配置位于 `.runtime/release-publish.json`，可参考 [配置示例](../distribution/release-publish.example.json)。只填写已有资源的标识与路径；GitHub、阿里云继续使用 `gh`、`aliyun` 的既有登录。OSS 凭据在服务器现有容器中读取，不写入配置、日志或 Git。

本次交付已配置当前发布机。其他发布机需要 Python 3.12+、Node 24+、Git、npm、curl、gh、aliyun，以及上述现有权限。

将已验收产物放入配置的待发布目录，默认结构如下；目录可以链接到原有出包目录，包不需要复制进 Git：

```text
.runtime/release-inputs/
  <Linux发布ID>/linux-x64.json、linux-x64.tsv、对应.tar.gz
  <Mac发布ID>/darwin-arm64.json、darwin-arm64.tsv、对应.tar.gz
```

也可在同一条命令中指定清单：

```sh
bun run release:publish --linux /绝对路径/linux-x64.json --mac /绝对路径/darwin-arm64.json
```

## 命令会完成的工作

1. 从已提交的 main 读取版本与源码树，校验双平台 JSON/TSV、完整归档大小与 SHA-256、包内 `RELEASE.json` 及真实来源。
2. 同步 Dev main 与公开 main。公开仓库只接收已提交的源码快照，保留公开历史；现有工作区不切换、不清理、不自动暂存。人群资源和 `.runtime` 不能进入提交。
3. 在隔离目录构建官网。官网当前版本、日期和说明链接统一来自 `Web/lyapunov-standalone/current-release.json`；命令自动更新这一个配置。已有历史说明保留，新版本可直接链接 GitHub 发布说明。
4. 上传缺失的归档，先核对不可变对象，再切换 OSS latest 与官网。服务器保留旧版本、旧资源及更改前备份。
5. 使用真实版本标签创建或补齐 GitHub Release 和校验附件，显式设置 Latest。已发布标签、归档与同名资产不被覆盖；重复运行用于补齐与核验。
6. 回读官网文件、双平台 latest、下载 HEAD/Range 字节和安装脚本，再检查 GitHub **main 的 `statusCheckRollup` 汇总**，包括正式标签与额外检查。取消的检查可真实重跑一次；失败、缺失、仍排队或超时均不报完成。

只有所有检查通过，命令才输出“完成”并退出 0。失败退出非 0，保留日志和阶段回执，修复具体问题后重新运行同一条命令。它不删除失败记录，不取消检查，不伪造状态，也不移动已发布标签来消除红叉。

如果已有未发布标签指向另一份源码，命令会明确阻断，保留候选现场；不会把新归档挂到旧源码标签上。

## 预览与核验

```sh
# 只检查本地输入并生成计划，不写生产
bun run release:publish --plan

# 只核对线上结果，不推送、不部署、不重跑 CI
bun run release:publish --verify-only
```

最近一次回执位置见 `.runtime/release-publish/last.json`；各次执行日志与 `receipt.json` 保存在同目录下的独立任务目录中。这些文件均不提交。CI 通过与发布入口通过，只证明对应的构建、检查和分发结果；平台实机验收仍沿用该安装包的原始记录。
