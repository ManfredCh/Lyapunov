# Lyapunov 原生 DSH 产品入口

`src/cli.ts` 通过 DSH 原生 Agent／Session 执行和恢复任务。GitHub 入口沿用同一实现，不启动第二套 CI Agent Loop，也不读取旧系统账户或会话。

## GitHub CLI

构建后可直接执行：

```bash
node packages/lyapunov-product-bundle/dist/cli.js github help
node packages/lyapunov-product-bundle/dist/cli.js github inspect --repo owner/repository --auth gh
node packages/lyapunov-product-bundle/dist/cli.js github install --repo owner/repository --support-url https://your-support-service.example --cwd /path/to/repository
node packages/lyapunov-product-bundle/dist/cli.js github run --repo owner/repository --auth github-token --issue 17 --prompt '评审这个任务' --cwd /path/to/repository --result /path/to/private-result.json
```

`inspect` 只读仓库元数据。`install` 查询现有支持服务的 GitHub App 安装状态，并在仓库写入 `.github/workflows/lyapunov.yml`；它不提交文件或触发工作流，相同内容可重入，不覆盖不同的已有工作流。安装草稿使用已有 Lyapunov 的 self-hosted runner 和包内 Node，依赖 `LYAPUNOV_PRODUCT_ROOT` 与支持服务 URL，没有引用尚未发布的远端 Action。

`run` 支持 manual、issue_comment、pull_request_review_comment、issues、pull_request、schedule 和 workflow_dispatch。用户事件会向 GitHub 查询触发者仓库权限；评论默认需要 `/lyapunov`。仓库、Issue／PR、文件、提交、普通评论、逐行评论和 reviews 进入同一个 DSH 任务；GitHub 附件经实际下载后交原生附件存储，图像仅在当前模型声明支持时直传。

`--resume <sessionId>` 继续同一原生 Session，且要求工作目录与原 Session 一致。`--runtime-root` 可选择独立的产品运行目录。`--provider`／`--model` 或 `LYAPUNOV_GITHUB_PROVIDER`／`LYAPUNOV_GITHUB_MODEL` 选择模型；未指定时读取 DSH 当前默认路由。

模型凭据优先使用调用环境中的 `DEEPSEEK_API_KEY`，也支持现有 `LYAPUNOV_DEVELOPER_AUTH_FILE`。缺少时仅采用产品自身已定义的 `.runtime/session-secrets/deepseek-auth.json`，不查旧系统数据目录。生成的工作流从 GitHub secrets 注入模型 Key，并从 vars 读取产品路径、支持服务和可选模型／发布配置。

## GitHub 认证

| `--auth` | 凭据来源与请求路径 |
| --- | --- |
| `gh` | 使用 `gh auth token` 的内存结果；可用 `--gh-path` 或 `LYAPUNOV_GH_EXECUTABLE` 指定已有 gh。不会输出或持久保存该 token。 |
| `github-token` | 使用 `GITHUB_TOKEN`，兼容 `GH_TOKEN`；直接访问指定 GitHub API。 |
| `pat` | 使用 `LYAPUNOV_GITHUB_PAT`，或 `--pat-env` 指定的环境引用；调用既有 `/exchange_github_app_token_with_pat`。 |
| `oidc` | 使用 Actions 的 `ACTIONS_ID_TOKEN_REQUEST_URL`／`ACTIONS_ID_TOKEN_REQUEST_TOKEN`，请求兼容 audience 后调用 `/exchange_github_app_token`。工作流需 `id-token: write`。 |

安装查询、PAT／OIDC 交换要求 `--support-url` 或 `LYAPUNOV_SUPPORT_API_URL`；兼容显式设置的旧 `OIDC_BASE_URL`，没有 `api.opencode.ai` 默认值。GitHub API 默认 `https://api.github.com`，可通过 `--api-url`／`GITHUB_API_URL` 配置。非 loopback 地址要求 HTTPS。

App 安装凭据在运行结束后调用 GitHub 的 installation token 撤销接口；个人 token 不撤销。App 私钥、签发和权限判断仍由已有 `services/lyapunov-support-api` 负责。缺少支持 URL、Actions OIDC 环境或 PAT 引用时返回具体错误，不生成替代凭据。

## 显式发布

`--publish` 或 `LYAPUNOV_GITHUB_PUBLICATION` 选择实际写入；默认 `none`。

| 值 | 行为 |
| --- | --- |
| `none` | 返回本地原生 Session／结果，不自动发布。 |
| `comment` | 将完成结果写入目标 Issue／PR 评论。同一 Session 重试不重复，后续内容变化会更新原评论。 |
| `pull-request` | 从干净工作区创建分支；PR 输入先获取实际 `refs/pull/<number>/head`；完成后提交、普通 push、创建 PR，并在来源讨论引用它。 |
| `update-branch` | 从明确分支获取当前内容，在独立临时分支执行，完成后普通 push 回目标分支并写评论。`--branch` 可指定目标。 |

`--remote`、`--base`、`--commit-message` 可指定已有 Git 远端、PR 基分支和提交说明。代码不会 force push；工作区本来有未提交修改时，分支发布流程拒绝自动提交。Agent 自己切换了分支时，外围自动 push 停止，结果明确返回当前分支。未完成／被取消的任务不会进入发布流程。

## 本地验证

```bash
node packages/lyapunov-product-bundle/test/github-evidence.ts
node packages/lyapunov-product-bundle/test/github-checkout-evidence.ts
bun test packages/lyapunov-product-bundle/test/github-publication.test.ts
```

首项使用真实 DSH 模型与 Tools、同一 Session 的恢复、实际本地 bare Git 以及本地 HTTP 协议服务。PAT／本地签名 OIDC、安装查询、评论、PR、push 和撤销均走实际生产客户端；GitHub App 和发布服务属于本地协议夹具，不代表真实外部安装／发布。第二项验证原生 DSH subprocess 的 PR ref 获取与同会话重复分支准备，不调用模型。第三项验证评论更新、附件重定向／原生存储、PR 完整上下文。

本轮还通过已授权 gh 账户实际读取了指定私有仓库；该证据仅证明只读 API 可用。外部 GitHub App 配置、Actions OIDC 运行环境、正式评论／PR／push 和工作流触发各自保留真实验收边界。
