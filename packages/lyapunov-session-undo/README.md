# 原生会话撤销与工作树恢复

本包向原生 DSH Commands 注册 `/undo`、`/redo` 和 `/undo_status`，通过 `Session.checkout` 改变同一会话的活动历史，并协调该输入之后的工作树文件恢复。它不创建第二份 Session 数据库、不通过 fork 代替撤销，也不删除原始事件。当前产品启动默认装配本功能；显式 `LYAPUNOV_SESSION_UNDO=0` 可停用本插件。

撤销先取消当前 Agent 并等待原生 idle，再进入 maintenance：写入操作关联元数据、执行文件事务、追加 required `session/history-checkout`、flush 原生日志，最后提交文件事务。模型、投影、搜索和聊天消费者使用同一活动历史选择器。原始 seq、实际消耗、设置和 Goal 不倒退；新的已准入消息（包括 Goal 自动输入）或实际执行步骤清除 redo 分支；单纯查询状态和压缩替换不会清除。旧读取器可以忽略文件快照元数据，但不认识 required checkout 时必须明确拒绝。

本地终端和远端终端支持 `:undo`、`:redo` 和 `:undo_status`；斜杠形式进入相同原生 Commands。撤销后的文字及附件恢复为待确认草稿，只有用户再次发送才进入模型。未发送草稿仍是当前客户端状态。非 Git 目录只提供会话历史撤销，结果通过 `files.mode=not-git` 明示没有 Git 文件恢复；Git 旧输入缺少快照时拒绝承诺完整撤销。

`openWorktreeSnapshots({ cwd, storageRoot, excludedRoots? })` 仅支持真实 Git 工作树；非 Git 目录返回 `{ supported: false, reason: 'NOT_GIT_WORKTREE' }`，不会创建快照目录或假报成功。`storageRoot` 必须是该工作树专用的 DSH 私有目录，不能位于用户 Git 元数据目录。私有 Git 对象库及每次独立索引位于其中，组件不修改用户 `.git/index`、HEAD 或提交。私有目录位于工作树内时自动排除。`excludedRoots` 只由可信产品装配登记明确的绝对运行目录，打开 store 时按同一规范路径规则解析；不得包含 Git 根或当前工作目录。正式装配排除 `private/config`、`private/data`、`private/cache`、`private/state`、`private/tmp`、`dsh` 与 `worktree-history`。捕获、差集、恢复及旧 journal 应用共用排除判据，其他同名目录、`private` 根的普通项目文件与用户 worlds/assets/robots/captures/recordings 保持覆盖。这样 Git 根内临时索引正常删除不会成为用户快照的读取失败。

会话从 Git 子目录启动时，也按该 Git 工作树完整的变化路径恢复，包括工具实际修改的同仓库其他目录文件；不静默丢弃这些路径。

`capture()` 按当前 Git 忽略规则捕获整个工作树，返回可持久化的 `{ version: 1, worktree, tree }`。`tree` 是私有 Git 对象树；持久引用依赖该私有对象库，不能只保存引用后删除库。文本保持原字节，二进制、文件增删、可执行位和符号链接都由 Git 条目保存；空目录不是 Git 快照对象。`diff(before, after)` 返回精确变化叶路径，重命名表现为删除与新增。所有 Git 调用使用 argv，路径流使用 NUL 分隔。

`beginRestore({ operationId, sessionId, target, paths })` 只恢复 `paths`，通常传入 `diff` 的结果。它先保存当前相关文件与必要目录元数据，将文件事务 journal 持久化，再应用目标。目录/文件互换若会删除不在指定路径集中的文件，将在修改前拒绝。恢复失败尝试回滚；若回滚也失败，原文件对象和 journal 保留并抛出错误，不能把该操作算作成功。

文件恢复失败通过 `RestoreError` 返回 `operationId` 和 `recovered`。只有 beginRestore 的自动回滚已恢复相关原件，且 journal 清除完成，`recovered` 才为 true；回滚或 journal 清理未完成则为 false，调用方必须阻止该工作树继续模型执行，直到 recover 成功。显式 transaction.rollback 失败也返回 recovered=false。纯预检且没有修改文件或留下待恢复 journal 的错误保持普通 Error，调用方不需要自行读取 journal 猜测失败状态。

返回的事务有 `commit()` 和 `rollback()`。**调用方必须先持久化并 flush 对应原生 Session 操作，再调用 commit。** commit 只移除协调 journal；调用方确认原生操作未持久化时，rollback 恢复本次 beginRestore 前的相关文件。flush 结果不确定时通过 recover 查询真实持久结果，不能直接猜测回滚。operationId/sessionId 只用于关联原生持久操作，不构成第二份会话数据库。一个工作树存在待确认事务时拒绝下一次 beginRestore。

进程重启后先调用 `recover(async (operationId, sessionId) => 是否已持久化)`：回调 true 时完成目标文件恢复，false 时恢复 beginRestore 前的原件；回调失败则保留当前状态和 journal。调用方应在恢复完成前禁止该工作树继续执行原生操作。完成后 journal 移除，重复 recover 没有动作。

定向测试使用独立 `/tmp` Git 工作树，覆盖原字节、中文空格/换行路径、增删、执行位、符号链接、文件目录互换、无关文件冲突以及新 Node 进程被 SIGKILL 后的冷恢复。组件不会回退或删除原生 Session 事实。

原生 Session ZIP 是日志与附件导出，不是整个运行根备份；它不包含本包的私有 Git 对象和 journal。保留完整撤销能力时需保留同一运行根的 `worktree-history`。当前不支持将工作树搬到不同绝对路径后自动重映射旧快照；缺少快照对象的旧输入不能算作可完成的文件撤销。
