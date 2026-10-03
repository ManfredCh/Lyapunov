# GraspGenX Provider 部署方式

GraspGenX 不是 LyapunovDSH 的必装依赖，也不要求用户安装 Docker。主程序可以在没有 GraspGenX、没有 CUDA 或没有 Docker 的机器上正常运行；只有用户选择 `graspgenx` 抓取 Provider 时才需要提供一个真实 worker。

Provider 只依赖一个 ZMQ endpoint，部署方式可以自由选择：

```text
宿主 Conda/Python worker  ─┐
远程 GraspGenX worker      ├─> GRASPGENX_ENDPOINT=tcp://host:5556
Docker worker              ─┘
```

优先使用显式 endpoint：

```bash
export GRASPGENX_ENDPOINT=tcp://127.0.0.1:5556
```

如果没有 endpoint，才兼容读取 `LYAPUNOV_GRASPGENX_CONTAINER`，通过 Docker 容器网络发现 worker。这个兼容路径不会安装 Docker，也不会自动启动容器。

Provider 会把宿主环境中的 `GRASPGENX_ENDPOINT`、`LYAPUNOV_GRASPGENX_CONTAINER` 和代理设置传给隔离的 `propose.py` 子进程。没有可用 worker 时返回 `PROVIDER_UNAVAILABLE`，不会返回空候选或伪造结果。

Docker 定义位于 `distribution/providers/graspgenx/`，属于可选的隔离发布方案。正式发行包不应把 Docker、GraspGenX 源码或模型权重作为基础安装条件；选择该 Provider 的用户再按自己的部署方式提供 worker 和模型资产。
