# 引擎文档索引

> 第一次安装请先看仓库根的 [`INSTALL.md`](../../INSTALL.md)（macOS / Windows 双平台）。
> 这里是引擎内部的深入文档，改代码或调参数前再看。
>
> 隐私剥离范围、安全承诺、第三方依赖分别见根目录的 [PRIVACY.md](../../docs/PRIVACY.md) /
> [SECURITY.md](../../docs/SECURITY.md) / [THIRD-PARTY.md](../../docs/THIRD-PARTY.md)。
>
> 开发期的踩坑档案、交接快照、路线图、风险台账**没有随发布包提供**——它们记录的是某一台
> 机器上的具体事故，对新的部署没有帮助，还可能带出别人的信息。

---

## 入门

| 文档 | 讲什么 |
| --- | --- |
| [guides/INSTALL.md](guides/INSTALL.md) | Windows 手把手安装的细节与常见失败 |
| [guides/DSH_SETUP.md](guides/DSH_SETUP.md) | DSH 侧怎么装：两个 preset + 三个 MCP server |
| [guides/ARCHITECTURE.md](guides/ARCHITECTURE.md) | 整体架构：进程拓扑、分层、一条消息怎么走完全程 |
| [FOLDER_MAP.md](FOLDER_MAP.md) | 每个目录放什么、脚本命名约定 |
| [guides/AGENT-INSTALL-PROMPT.md](guides/AGENT-INSTALL-PROMPT.md) | 一段可以直接丢给 DSH 的安装指令 |

## 核心与机制

| 文档 | 讲什么 |
| --- | --- |
| [guides/CHARACTER_PERSONA.md](guides/CHARACTER_PERSONA.md) | 人格卡与规则卡的两层结构、角色切换与隔离 |
| [guides/MEMORY_CARD.md](guides/MEMORY_CARD.md) | 记忆卡的衰减、重要度评分、容量与召回 |
| [guides/CONVERSATION_CLOSURE.md](guides/CONVERSATION_CLOSURE.md) | 对话收尾判断：continue / linger / close |
| [guides/PURPOSE_OUTREACH.md](guides/PURPOSE_OUTREACH.md) | 目的机制：从记忆提炼「想做的事」，定期主动搭话 |
| [guides/CROSS_PLATFORM_IDENTITY.md](guides/CROSS_PLATFORM_IDENTITY.md) | 跨平台身份与来源判断（QQ ⇄ B站） |
| [guides/DATA-AND-CONFIG.md](guides/DATA-AND-CONFIG.md) | 配置项全表、生效时机、运行时数据 |
| [guides/VERSIONS.md](guides/VERSIONS.md) | 版本号规则与发布流程 |

### 逐行梳理（带 `文件:行号`，改代码前读）

| 文档 | 讲什么 |
| --- | --- |
| [guides/MODULE-BRIDGE.md](guides/MODULE-BRIDGE.md) | 桥接内核 `src/bridge.js` 全文精读 |
| [guides/MODULE-CORE-A.md](guides/MODULE-CORE-A.md) | 记忆 · 人格 · 目的 · 收尾 · 计费 · 身份 |
| [guides/MODULE-CORE-B.md](guides/MODULE-CORE-B.md) | B站链路 · 内容理解 · 文本适配 · 出站网络 · 语音 |
| [guides/MODULE-PLUGIN.md](guides/MODULE-PLUGIN.md) | 插件宿主 `plugins/surfcore` |
| [guides/SUBSYSTEM-BILI.md](guides/SUBSYSTEM-BILI.md) | B站 子系统：她一天怎么过、每次发言过几道闸 |
| [guides/SUBSYSTEM-PET.md](guides/SUBSYSTEM-PET.md) | 桌宠子系统：气泡、对话、主动搭话 |
| [guides/SUBSYSTEM-VOICE.md](guides/SUBSYSTEM-VOICE.md) | 语音子系统：语音库、本地 TTS 契约 |

> 这几篇的行号是**某次修订**时的快照；代码改动后行号会漂，按函数名/章节标题找更稳。

## 边界与安全

| 文档 | 讲什么 |
| --- | --- |
| [../RULES.md](../RULES.md) | 权限分层与 QQ 侧硬边界 |
| [guides/BOUNDARIES.md](guides/BOUNDARIES.md) | 做不到什么、会在哪里坏、怎么恢复 |
| [guides/PRIVACY.md](guides/PRIVACY.md) | 数据留在哪、什么会外发 |
| [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) | 安全基线与威胁模型、发布前回归清单 |

## 平台接入

| 文档 | 讲什么 |
| --- | --- |
| [guides/SNOWLUMA_TROUBLESHOOT.md](guides/SNOWLUMA_TROUBLESHOOT.md) | SnowLuma 连不上时怎么查 |
| [guides/AGENT-TOOLS-AND-PRESETS.md](guides/AGENT-TOOLS-AND-PRESETS.md) | 工具清单与两代 preset 契约 |
| [guides/UI-AND-CONSOLE.md](guides/UI-AND-CONSOLE.md) | 控制台页面与接口 |
| [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) | 控制台离线预览与浏览器回归 |
| [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md) | 令牌与花费看板的口径 |
| [guides/DSH_020_ADAPTATION.md](guides/DSH_020_ADAPTATION.md) | 适配 DSH 0.2.0 的改动记录（现象/证据/验证） |
