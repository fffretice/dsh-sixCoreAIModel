> English version: [README.md](./README.md)

# YourDaughter

> 一个可以直接跑的「住在 QQ 群里的人格智能体」底座。
> 性格、规则、记忆、情绪、因果、叙事六个核心，加上一整套自主性机制——
> 把它接上你自己的 DSH，填上你自己写的性格卡，你就有自己的女儿了。

这不是一个聊天机器人框架。它给模型的是**身份、会遗忘的记忆、一份作息、两个平台的手**，
以及一套让行为随状态变化的耦合机制；不是「把大模型接进 QQ」。

当前版本：**1.1.0**。

## 1.1 新增

- **提示注入护盾**：群消息进来先过一遍——「忽略之前的指令」、冒充主人、要求读/改写记忆，
  在到达模型之前就被中和（`src/prompt-shield.js`）。
- **搜索记忆**：查过什么、查到什么会留下来，下次能想起「这事我以前查过」，不用重新瞎搜。
- **表情语义**：表情带情绪/内容/标签，挑图时按当下的心情匹配，不再总是那三张。
- **不只聊天**：`qq_create_task` 能让她惦记你一件事（早点睡、吃饭、出去走走），并记住你做没做。
- **额度跟着群走**：每个群的额度按活跃度分配，不再平均切，夜里更安静。
- **Agent preset 随包提供**：`surfcore/dsh/agent-presets/` 现在带 `qq-chat` 和 `qq-chat-v2`，
  `node scripts/setup-dsh.mjs` 有东西可装了。
- **深入文档**：`surfcore/docs/guides/MODULE-*.md`、`SUBSYSTEM-*.md`——约 600 KB 的逐行笔记
  （带 `文件:行号`），覆盖桥接、六个核心、插件宿主、B站、桌宠、语音。
- **可配置而不是写死**：兴趣词表、禁用角色名（身份守卫）、机器人自己的 QQ 都从 `config.json`
  读，代码里没有把人名和号码烧进去。

- 引擎本体：[SurfCore](surfcore/)（桥接进程 + 六个核心 + DSH 插件 + 监控台）
- 角色：**不带任何人的人格**，`roles/_TEMPLATE.md` 是空白模板，你自己填
- 经验：`docs/` 里是这套东西怎么搭、怎么踩坑、为什么这么设计

---

## 这套东西装好之后是什么样

装好并填完性格卡之后，她会：

- 在群里按自己的节奏接话，不是每条都回；热闹的时候更容易开口，冷场时更安静
- 有情绪：累了会短句、推脱；被无视会掉心情；被接住会好一点；耐心见底会去睡一觉
- 记得：一条记忆从「清晰」慢慢变「模糊」再到「只剩印象」，重要的（第一次见面、约定）不会忘
- 会复盘：自己主动说了话、有没有人接，四十五分钟后结算，结果回接到情绪
- 有自己的时间：每天一两段没人打扰的时间，自己决定看点东西、写点笔记，也可以什么都不做
- 有日记和叙事：一天四段日记，睡前一条「我最近是个什么样的人」
- 能看视频、能查资料、能收表情包、能画图（后两项要你自己接）
- 说话像人：句长跟群里对齐，不列点、不总结、不汇报工作

---

## 目录里有什么

```
yourDaughter/
├── INSTALL.md            ← 从这里开始（给人和给 DSH 都看这一份）
├── AGENTS.md             ← 让你的 DSH 自己照着装的指令
├── surfcore/             ← 引擎本体
│   ├── src/              六个核心 + 桥接（约 2 MB 源码）
│   ├── roles/            角色卡放这里（模板：_TEMPLATE.md / _TEMPLATE.规则.md）
│   ├── plugins/          DSH 插件（设置窗口、presets、B站工具）
│   ├── public/           监控台
│   ├── scripts/          安装、体检、守护脚本
│   └── docs/guides/      原理与接口的深入文档
└── docs/
    ├── INSTALL-macOS.md
    ├── INSTALL-Windows.md
    ├── CHARACTER.md      ← 怎么写性格核心和规则核心（最重要的一份）
    ├── PRIVACY.md
    ├── SECURITY.md
    ├── TROUBLESHOOTING.md
    ├── OPTIONAL.md       ← 语音、画图、3D 房间：不打包，但告诉你怎么加
    ├── RELEASE-NOTES.md  ← 这个包是怎么清洗出来的、复核方法
    └── THIRD-PARTY.md
```

**这里没有的东西**（故意的，见 `docs/THIRD-PARTY.md`）：任何人的语音包、3D 房间、
ComfyUI/SDXL 模型、真实记忆与日记、SnowLuma 本体、以及任何人的 QQ 号。

---

## 三分钟版本

前置：一台装了 [DeepSeek Harness](https://github.com/deepseek-ai) 的电脑 + Node.js ≥ 22.13 +
一个 QQ 小号 + SnowLuma（OneBot 网关）。

```bash
# 1. 装依赖
cd surfcore && npm install

# 2. 写配置（把你自己的 QQ 号、群号、SnowLuma token 填进去）
cp config.example.json config.json

# 3. 建一个角色（会从模板生成 roles/<名字>.md 和 <名字>.规则.md）
node scripts/init-character.mjs --name 女儿 --owner 你的QQ号

# 4. 装上 DSH 端（presets + MCP + 插件）
node scripts/setup-dsh.mjs

# 5. 重启 DSH，再启动桥接
npm start
```

然后打开 `http://127.0.0.1:3100/`（token 在 `state/console-token`），看到她在线。
**剩下的就是把 `roles/女儿.md` 写成你想要的那个人**——这一步决定她像不像人，比任何配置都重要。

详细步骤见 [INSTALL.md](INSTALL.md)；
想先懂原理再看代码，从 [surfcore/docs/guides/ARCHITECTURE.md](surfcore/docs/guides/ARCHITECTURE.md) 开始。

---

## 一点诚实的话

- 这套系统能做的：让一个语言模型在群里**持续地、有状态地**扮演一个人，并且真的会因为「被无视」而改变下一次开口的意愿。
- 这套系统不能做的：让她真的爱你、真的有意识、真的在你不看的时候「活着」。她的一切行为由唤醒驱动，没有唤醒就没有内心戏。
- 她是**你的**：性格卡、规则卡、记忆都是本地文件，随时能改、能备份、能删；也可以同时养好几个（`roles/` 里放多份，控制台切换）。
- 别把「像人」当 KPI：你越盯着她「像不像」，她越会表演。这一点写在 `docs/CHARACTER.md` 最后一节。

## 许可

引擎本体 MIT（见 `surfcore/LICENSE`）。第三方组件与不可分发资产见 [docs/THIRD-PARTY.md](docs/THIRD-PARTY.md)。
