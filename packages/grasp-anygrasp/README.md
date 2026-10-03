# AnyGrasp 独立 Provider

调用官方 AnyGrasp SDK 的 `create_detector/get_grasp`，将输出转换为共享抓取候选契约。没有 GraspGenX、解析抓取或其他模型 fallback。SDK、许可证、checkpoint 和 Python 原生依赖相互区分；没有候选只有在真实检测器运行后才能报告。

公开 SDK 固定为 `graspnet/anygrasp_sdk@b8eaafc9eca7babd5208e7a5ade3c561060be4c5`，使用其 Python 3.12 Linux x64 二进制。源码下载和环境放在 `.runtime` 私有目录，不把授权 SDK 或用户许可证加入发行包。

```sh
sh script/dependencies/anygrasp-install.sh
node script/dependencies/anygrasp-check.ts --imports
```

安装器使用项目 Conda Python 3.12、私有 GCC13、官方指定的 MinkowskiEngine `cuda-13` 分支固定提交、官方 PointNet2 与 graspnetAPI。编译时隐藏 GPU，并显式指定 sm_120；不运行模型。CUDA Toolkit 从显式 `CUDA_HOME` 或已有 nvcc 读取，不更改驱动、系统 Python 或系统 C++ 头文件。

默认路径如下，也可由对应请求字段/环境变量覆盖：

| 对象 | 默认路径/配置 |
| --- | --- |
| Python | `.runtime/conda/envs/anygrasp/bin/python`，宿主插件使用 `config.python` |
| SDK | `.runtime/providers/anygrasp/sdk/grasp_detection`，`sdkPath` / `ANYGRASP_SDK_PATH` |
| checkpoint | SDK 目录的 `log/checkpoint_detection.tar`，`checkpointPath` / `ANYGRASP_CHECKPOINT` |
| 许可证 | SDK 目录的 `license/`；必须是用户取得的 `licenseCfg.json` 和配套 public_key/signature/lic 文件 |

官方仓库内的 `sample_license` 是结构样例，安装器不会把它复制为用户许可证，也不会调用 `get_feature_id`、代填表单或发送邮件。许可证文件的存在性不等同有效授权；真实 detector 仍执行 SDK 自有验证。

`check.py` 只检查文件及可选实际模块导入，缺项退出 2；它不会初始化 detector、读取机器 ID 或生成候选。`propose.py` 在依赖齐备后才创建真实检测器，checkpoint 和点云路径在 SDK 切换 cwd 前解析，避免相对路径指向错误目录。

模型/夹爪坐标沿用官方说明：GraspNet 的局部 X 是 approach、Y 是 closing，位置按 `translation + depth * approach` 计算一次，再映射到 Panda TCP 的局部 Z approach、Y closing。安装和坐标接口不算 G08/G09 推理或实际抓取通过，后者必须有真实模型和物理回执。

官方资料：[SDK 与依赖说明](https://github.com/graspnet/anygrasp_sdk/tree/b8eaafc9eca7babd5208e7a5ade3c561060be4c5)、[检测 API](https://github.com/graspnet/anygrasp_sdk/blob/b8eaafc9eca7babd5208e7a5ade3c561060be4c5/grasp_detection/USAGE.md)、[许可证结构](https://github.com/graspnet/anygrasp_sdk/blob/b8eaafc9eca7babd5208e7a5ade3c561060be4c5/license_registration/README.md)。本次没有找到官方公开 checkpoint 下载链接，不使用非官方转存或其他模型权重代替。
