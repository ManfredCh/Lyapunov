# 可选人体 CUDA 运行时

Linux x64 标准 MuJoCo 安装维持 CPU 默认。已解包的完整产品根可显式准备人体 CUDA：

```sh
./lyapunov install-provider mujoco --human-cuda
```

该参数只适用于 MuJoCo。首次安装在本产品 `.runtime/sim-python` 创建标准 MuJoCo 3.13.0 环境，再补 Warp；已有前缀必须实际确认 `sys.prefix` 归属本产品，且 MuJoCo 必须为 3.13.0。不接受指向产品根之外的前缀，不删除或替换冲突目录，不修改 Isaac、Newton 或系统 Python。

Warp 使用 [官方 PyPI 1.13.0 元数据](https://pypi.org/pypi/warp-lang/1.13.0/json) 的 `warp_lang-1.13.0-py3-none-manylinux_2_28_x86_64.whl`，大小 138,337,580 字节、SHA-256 `ac2479c70ad410d58deb088c2a64168792be588efc1bec22dc51f92238e8c8c3`。安装器使用 `--only-binary=:all: --no-deps --require-hashes`，只补该扩展；前后核对已有 MuJoCo/NumPy 的版本、模块位置和原生库 SHA，发生变化即阻断。无 `--human-cuda` 参数时不安装 Warp。该 wheel、固定 requirements、来源记录、原 Apache-2.0 许可与检查脚本各有不同身份；源码发行归档含后三者，wheel 由目标安装流程获取，不把开发者 SDK 复制入包。

许可证见 [WARP-LICENSE.md](WARP-LICENSE.md)，完整来源见 [warp-source.json](warp-source.json)，安装 pin 见 [requirements-human-cuda.txt](requirements-human-cuda.txt)。官方原许可 SHA-256 为 `a6cba85bc92e0cff7a450b1d873c0eaa2e9fc96bf472df0247a26bec77bf3ff9`。载荷门会拒绝缺失、空文件、来源或固定 hash 漂移。

安装收尾使用本次包内解释器执行 `python/check_human_cuda.py`，加载同一份 `human_gpu.py`，在真实 CUDA 上执行一次单角色、单骨骼 FP64 clip/FK 并精确核对回读。输出包含 Python/prefix、MuJoCo/NumPy/Warp 版本、CUDA 设备名称/UUID/架构、kernel 次数与 helper SHA。可单独复查：

```sh
./.runtime/sim-python/bin/python packages/sim-mujoco/python/check_human_cuda.py --cache-root .runtime/cache/human-cuda-install
./lyapunov doctor mujoco --managed-sdk
```

第一条检查 CUDA 与实际计算；第二条是常规 Provider 依赖诊断。缺包、版本不符、设备不可用、缓存不可写或 kernel 回读失败均非零退出，并保留前缀供修复后重复运行。重复运行不会升级基础 MuJoCo/NumPy，也不会设置世界或引擎偏好。它只证明本次运行时和一次真实 kernel 可用；20 人、机器人、场景持续运行、实时性能和 Viewer 渲染由对应真实场景验收单独记录。

本轮 Linux x64 安装验收记录由发行回执持有；未运行的平台保持未验证。NVIDIA 驱动与 CUDA 设备是本机运行条件，安装流程不升级系统驱动，不安装 Torch、完整 Isaac SDK 或 Warp examples/docs extras。
