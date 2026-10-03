# 原生执行图与恢复

执行图从当前Session事件与原生Job快照重建。关闭标签只取消该标签的GET，不取消模型、Job或Sim。只读`execution_status`工具提供同一份图；事件引用保留seq、turn、step、callId，图裁剪不会裁原日志。

图仅保存公开身份、hash、字节/块数量、阶段与领域水位。图片仍走原ContentBlock和Attachment；工具结果嵌套图片递归计数。有效输入摘要采集实际GenerateOptions，basis为harness-before-adapter，不能当成线上body/token或费用数。

模型运输、工具结果、后台Job和物理停止分别显示。partial tool stream不是已执行tool/call。Bash外层isError=false同时出现timeout/SIGTERM仍属于执行结果未知，不能报告下载成功。新Host无原registryId/startedAt关联的bash-1保持未知；读取或停止需要确认当前执行实例，不自动重放未知提交。

恢复使用已有pre-step/tools hooks与Goal.disarm/Agent.cancel。只有资源/世界/Job/产物owner回执或新观察改变水位才重置预算，参数里随机ID不算进展；两个已见静态owner快照互换不算进展，受阻误差只认当前target窗口的最佳改善，重复振荡和仅stepIndex增加都不续预算。正常阻塞Job等待不吃失败预算，不变的即时查询单独有界交接。交接一次，保inbox，不把Goal标为完成或blocked，不设置第二Task状态。真人新输入开新的恢复窗口，但保未确认副作用。

SDK变更作为dsh-jobs-observation-identity.patch、dsh-public-model-diagnostics.patch登记；前者提供registry代次和reported原子认领，后者保公开失败诊断并veto未知费用重发。派生投影stateVersion为3，旧缓存按原生规则重建；窗口只存有界hash/最佳误差，不新增任务owner。新Session观察事件均ignorable:true，旧日志可缺少它们；新增Job/Llm诊断字段可选，缺失保持未知或原有无诊断重试规则。

本次本地CI等效入口为bun --no-env-file test对应execution-graph、native、model-diagnostic-http与session-history文件；生产、GUI和GPU验收由主控单独执行。
