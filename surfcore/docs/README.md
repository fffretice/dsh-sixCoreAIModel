# 引擎文档索引

> 第一次装请先看仓库根的 [`../../INSTALL.md`](../../INSTALL.md)。
> 这里是引擎内部的深入文档，改代码或调参数前再看。

## 入门

| 文档 | 讲什么 |
| --- | --- |
| [guides/INSTALL.md](guides/INSTALL.md) | 安装的细节与常见失败 |
| [guides/ARCHITECTURE.md](guides/ARCHITECTURE.md) | 整体架构：桥接、核心、注入顺序 |
| [guides/DSH_SETUP.md](guides/DSH_SETUP.md) | DSH 侧怎么装（preset / MCP / 插件） |
| [FOLDER_MAP.md](FOLDER_MAP.md) | 每个目录放什么 |

## 核心与机制

| 文档 | 讲什么 |
| --- | --- |
| [guides/CHARACTER_PERSONA.md](guides/CHARACTER_PERSONA.md) | 人格卡与规则卡的两层结构 |
| [guides/MEMORY_CARD.md](guides/MEMORY_CARD.md) | 记忆卡的衰减与注入 |
| [guides/CONVERSATION_CLOSURE.md](guides/CONVERSATION_CLOSURE.md) | 对话收尾判断 |
| [guides/CROSS_PLATFORM_IDENTITY.md](guides/CROSS_PLATFORM_IDENTITY.md) | 跨平台身份与自我识别 |
| [guides/DATA-AND-CONFIG.md](guides/DATA-AND-CONFIG.md) | 配置项全表与数据流 |

## 边界与安全

| 文档 | 讲什么 |
| --- | --- |
| [../RULES.md](../RULES.md) | 权限分层与 QQ 侧硬边界 |
| [guides/BOUNDARIES.md](guides/BOUNDARIES.md) | 能做什么、不能做什么 |
| [guides/PRIVACY.md](guides/PRIVACY.md) | 数据留在哪、什么会外发 |
| [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) | 安全基线 |

## 平台接入

| 文档 | 讲什么 |
| --- | --- |
| [guides/SNOWLUMA_TROUBLESHOOT.md](guides/SNOWLUMA_TROUBLESHOOT.md) | SnowLuma 连不上时怎么查 |
| [guides/AGENT-TOOLS-AND-PRESETS.md](guides/AGENT-TOOLS-AND-PRESETS.md) | 工具清单与 preset 契约 |
| [guides/UI-AND-CONSOLE.md](guides/UI-AND-CONSOLE.md) | 控制台页面与接口 |

> 开发期的 PITFALLS / ROADMAP / RISK_REGISTER / cases 没有随发布包提供：
> 它们记录的是某一台机器上的具体事故，对新的部署没有帮助，还可能带出别人的信息。
