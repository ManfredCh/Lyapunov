# LyapunovDev 索引

> **核心必读｜所有贡献者和 AI 先读**
>
> 按 **产品 → 开发 → 美学 → 交互** 完整阅读 [核心原则总入口](principles/README.md)：
> [产品](principles/PRODUCT.md) · [开发](principles/DEVELOPMENT.md) · [美学](principles/AESTHETICS.md) · [交互](principles/INTERACTION.md)

本索引只列本源码树中真实存在的当前文档。Lyapunov 0.2.1 的发布日期、包含能力、验证范围和当前版本状态以 [0.2.1 发布说明](docs/releases/0.2.1.md) 与 [发布说明目录](docs/releases) 为准。本源码树不随包分发旧的开发状态、TODO 或已解决账本；导航不引用它们，也不伪造替代账本。

## 必读与执行

| 入口 | 内容 |
| --- | --- |
| [核心原则（必读）](principles/README.md) | 产品、开发、美学、交互四份长期约束与阅读顺序 |
| [AGENTS.md](AGENTS.md) | AI／自动化代理的执行边界、必读顺序和回执要求 |
| [agent.md](agent.md) | 文件名兼容入口，只做导航 |
| [开发标准与流程](docs/DEVELOPMENT_STANDARDS.md) | 目录职责、接口合同、开发、检查、发布与验收流程 |
| [旧开发原则迁移页](docs/DEVELOPMENT_PRINCIPLES.md) | 旧路径的迁移导航，不保留现行正文 |
| [旧开发原则历史归档](docs/DEVELOPMENT_PRINCIPLES_2026-10-25_ARCHIVE.md) | 2026-10-25 归档的旧原文；历史身份，非现行依据 |

## 当前发行与使用

| 入口 | 内容 |
| --- | --- |
| [0.2.4.2 发布说明](docs/releases/0.2.4.2.md) | 关节范围判定、中文关节动作与各平台下载 |
| [0.2.4.1 发布说明](docs/releases/0.2.4.1.md) | Linux、Windows/WSL2 与 macOS Apple Silicon 下载及各平台源码来源 |
| [0.2.3 发布说明](docs/releases/0.2.3.md) | 首次提供 macOS arm64，记录当时的平台差异与已知问题 |
| [0.2.2 发布说明](docs/releases/0.2.2.md) | 完整 Linux x64 发行版的变化、能力范围与安装说明 |
| [0.2.1 发布说明](docs/releases/0.2.1.md) | 上一完整 Linux x64 发行版 |
| [发布说明目录](docs/releases) | 各历史版本的发布说明；旧版本记录只描述对应版本 |
| [README](README.md) / [简体中文](README.zh-CN.md) | 产品介绍、安装、首次运行、工作流和开发入口 |
| [中文操作手册](docs/MANUAL.zh-CN.md) | 完整安装 → Guest／登录 → 场景 → 机器人 → 相机 → 录制 → 导出流程 |
| [场景与 Isaac 工作流](docs/ISAAC_SCENE_WORKFLOWS.zh-CN.md) | 录制、资产检查和通过 Agent Graph 使用 USD、NuRec、Mimic 与位姿配准 |
| [快速上手](docs/QUICKSTART.md) / [简体中文](docs/QUICKSTART.zh-CN.md) | 输入、动作顺序、示例请求和输出检查 |
| [安装说明](docs/install.md) | 安装、运行时与版本准备 |
| [Isaac 安装与选择](docs/isaac-setup.md) / [English](docs/isaac-setup.en.md) | Isaac SDK、许可与本地安装选择 |

## 能力、场景与 Agent Graph

| 入口 | 内容 |
| --- | --- |
| [产品能力总表](docs/CAPABILITY_MATRIX.md) | 机器人族、引擎、控制路径、下载生成与当前卡点 |
| [机器人分层](docs/ROBOT_TIERS.md) | 机器人支持层级与验收边界 |
| [场景与相机链路](docs/SCENE_CAMERA_PIPELINE.md) | 场景、相机、采集与来源说明 |
| [Agent Graph 用户文档](docs/AGENT_GRAPH.md) | Coordinator／Worker／Verifier、campaign、分区、预算与技能准入 |
| [Agent Graph 接口契约](docs/AGENT_GRAPH_CONTRACT.md) | 工具名、类型、持久化位置与角色边界 |
| [packs 技能库](docs/PACK_SKILLS.md) | 提案、验证、晋升目录与 `skill_*` 工具面 |
| [开发说明](development/README.md) | 开发账号、模型配置、源码启动与构建入口 |
| [贡献说明](CONTRIBUTING.md) | 贡献流程与提交边界 |

## 维护边界

- 现行原则只在 `principles/` 维护；本索引只做导航，不复制第二套规则。
- 历史归档中的旧链接保持历史身份，可以缺失，不作为现行导航或要求。
- 不因本索引新增状态账本、文档自动化平台、设计系统或插件框架。
