> English version: [RELEASE-NOTES.md](./RELEASE-NOTES.md)

# 发布说明：这个包是怎么清洗出来的

这份文件写给**要再分发它的人**，也写给未来的自己：说明哪些东西被剥离了、依据是什么、怎么复核。

---

## 零、版本 1.3.0（2026-11-13）

**yourDaughter 1.3.0：她记得那句话是谁说的，也知道什么时候不该开口。**

### 记忆开始分得清「谁的记忆」

新的来源标注层会在群来源记录进入私聊上下文之前，给它打上群号与说话人；说话人查不到的记录直接不注入。`/api/memory/recall` 的返回带上 speaker，prompt 头部也写明这条规矩：群里的话是群友说的，不等于老大说的。1.2.0 里那句话递到她面前时，没有主人。

### 连续性，不是噪音

每个会话的第一轮带一条 48 小时内的真实事件：一行、不超过 120 字、每天一次、30 分钟过期。旁边还有静息重放（7 天以上的旧记忆，安静 20 分钟后才出现，每天最多两次），以及只收结论、决定、坑、偏好、约定的写回质量门。日记整理不再把昨天的事记成今天。

### 情绪有了软上限

`patience` 曾连续 408 个采样钉在 0.85：每小时 +0.60 的恢复，对上每次被要求只 −0.015，外面还扣着硬上限。现在她被要求之后往 0.72 漂，安静两小时后往 0.80 漂，0.85 只是会按 0.4/小时漏掉的盖子。实测第一个下午从 0.822 走到 0.806。模型作为纯函数模块发布，附离线重放。

### 声音知道什么时候不该响

本地 TTS 客户端：内容寻址缓存、缓存版本号、风格也进缓存键（以前一次「normal」会重播缓存里的「happy」）；失败返回可读错误，她改回打字。上层是语音机会模型：深夜、低电量、短回复压低概率；一天最多两条；群聊里还得房间真的轻松（mood 0.65、social 0.6、上一句不超过 12 字）。

### 规则和语言得先挣到位置

owner 教学要先过闸：进核心、进候选池，还是丢弃。规则核心在四批 dry-run 里从 7,062 压到 6,694 字，预算 7,200。黑话从静态 top-18 改成「最近消息里出现过才带」（在用 6 条、理解 3 条、总长 1,200 字）；半括号自检在句尾「（」超过 60% 时提醒一句，一个字都不改。

### 边界守得住

私聊念想不再进群 prompt（抽样 44 条群 prompt，32 条带着）；反思按来源过滤；私聊令牌往群里发会得到 403 和一条审计，除非显式带 crossKey；群级静音只拦群出站，私聊照常；表情包和照片在唤醒前分开；8.79 MB 的图先压到 598 KB 再见模型。可选、不打包：房间「让她看看」——把 3D 场景的 2 MB PNG 作为私聊图像上下文递给她。

底层：**134 个文件、29 个新模块、40 个新测试**；一套读真实投递 prompt 的注入审计；一份传输能力盘点，配一条不依赖 QQ 的告警通道。

### 下一步

把还在影子里的几块接上生产——静息重放、交接块、口径冲突台账——并把传输退路收尾，让引擎在失去 QQ 桥接之后还能活着。

### 1.3.0 的隐私剥离

这一版再次剥离了人格卡、个人记忆与全部个人标识；`scripts/release-audit.mjs` 报告 **0 条高危命中**。核验方法见下文。

---

## 零·一、版本 1.2.0（2026-11-08）

在 1.1.0 之后四天，从同一套部署上再切一刀。这一版的主角是**记忆核心**：一张卡、两个视图，
以及「写事件、不写统计」的每日整理。64 个文件，**+5,571 / −534**，`src/` 下新增七个模块。
下面一至六节的清理原则一条没变。

### 0.1 记忆：一张卡，两个视图

- **按会话分视图**：卡片经 `injectView`（`group` / `private`）渲染，记录带 `originKind`，
  `canEnterGroupView()` 把私聊来源的行挡在群视图外；私聊视图仍然全都看得到，群视图另外滤掉统计句。
- **主题目录也分视图**：私聊读 `memory/topics/_index.md`，群聊读 `_index-group.md`，
  群索引只列「群里有样本」的主题。
- **为什么**：她以前会在群里复述私聊摘要（比如「还在等 11/16」），而群里根本没人提过。

### 0.2 记忆：两处摄入漏洞

- **`inboxSeen` 比读取窗口小**：维护器每轮读最后 4,000 行 inbox，但只留 3,000 个已见键，
  窗口边缘约 950 行每轮都被当成新消息重摄。改为 `INBOX_SEEN_KEEP = 5000`。
- **2,000 条硬帽和 `config.maxRecords` 打架**：现在它只当「防超大文件」的最后一道闸
  （`NORMALIZE_RECORDS_SAFETY_CAP = 20000`），真正的上限交给 config。
- **归档去重**：`scripts/memory-dedupe-archive.mjs`，流式两遍扫描，同 id 只留字段最全的一条。
  实测把 139,936 行压成 5,497 个唯一 id（116 MB → 约 4.5 MB）。

### 0.3 记忆：digest v2，写事件不写统计

- 新模块 `src/memory-digest.js`（`DIGEST_VERSION = 2`，纯函数）。
- 旧整理写的是「聊到…；一共 58 句，你自己说了 76 句」——没信息量却占注入预算，还被永久 pin 住。
  现在每条笔记只记一件具体的事（谁说了什么，原话 ≤30 字 / 一个约定 / 情绪浓度高的瞬间 / 她做过的动作），
  带 `originKind` + `conversationKey`，**不 pin**，importance 60，每会话最多 2–3 条、每天最多 5 条；
  当天没事件就不写。
- 单测：`scripts/test-memory-digest.mjs`。

### 0.4 记忆：主题地图

- 新模块 `src/memory-topics.js`：`memory/topics/<主题>.md` + 索引，重建时把**现有主题页**的事实
  也合并进来，热卡被淘汰不会连带丢历史；新事实与旧行冲突时把旧行标 `superseded`，
  状态型主题（如头像）只留最新一条。
- 预置主题表是**示例**，换自己角色的话题请改 `CORE_TOPICS`。
- 单测：`scripts/test-memory-topics-view.mjs`。

### 0.5 学习与规则

- 新模块 `src/pending-rules.js`：私聊 / @她 / 带「你」的教学直接进规则核心；群里旁听来的进
  **候选池**，由她在日记里自己决定认不认。文本判别实测约 9/17，继续加正则只会更歪；
  而未经筛选的规则一天就能把规则文件顶过 6,000 字符预算。

### 0.6 说话

- 新模块 `src/voice-trim.js`：消息被压长度、或「事实 + 评论」被缝成一句时，提示要求压完还能独立看懂，
  不许留「这价」「这个」这类悬空指代；给两种安全改法 + 自检。`scripts/test-voice-trim.mjs` 锁住文案。

### 0.7 网页与媒体

- 新模块：`src/html-text.js`（HTML → 可读正文和表格，给 `web_fetch` 用）、
  `src/image-extract.js`（从搜索结果和页面里取图片直链，只读、不下载）、
  `src/screenshot.js`（headless Chrome + DevTools，先 navigate、等加载、再截图；
  `--screenshot` 会等广告和统计脚本，能卡一分钟）。
- `plugins/surfcore` 补上对应工具接线；`scripts/test-memory-notify-endpoint.mjs` 锁住记忆容量通知契约。

### 0.8 升级注意

- 没有破坏性配置变更：新键都可选，不填就是 1.1.0 的行为。
- 首次启动会做一次记忆卡维护迁移（留迁移标记 + 旧卡备份）。
- 如果卡是这版之前的、归档又很大，建议手动跑一次 `node scripts/memory-dedupe-archive.mjs`（默认 dry-run）。

### 0.9 这一轮的剥离

方法与之前一致：从线上部署复制，在副本上剥离，运行中的实例一个字节没动。这轮新抓到的泄漏：
三个群号和主人 QQ 写死在 prompt 代码里、测试夹具里的真实 Windows 用户名、两个脚本里的
SnowLuma token 与搜索 key、两个模块里 `/Users/<name>` 的默认值、注释与夹具里的角色名和兴趣词。
prompt 里的角色名现在读当前角色，兴趣词表读 `socialV2.interests`。

**当前审计结果：high 0 / mid 255 / low 3**，mid 仍然全是测试夹具和示例编号。

这轮没打包（只对某台机器有意义的运维脚本）：`assistant-screen.mjs`、`injection-audit.mjs`、
`memory-audit.mjs`、`memory-cleanup-dryrun.mjs`、`memory-crossview-*.mjs`、`memory-status-proto.mjs`、
`memory-topics-proto.mjs`、`night-selfcheck.sh`、`rollback-billion-context.sh`、`rules-audit.mjs`、
`rules-impression.mjs`（及计划 JSON）、`token-baseline.mjs`、`public/console-v2-draft.html`。

---

## 一、内容来源

来自一台真实运行了五天的人格智能体部署（macOS，单机）。原始目录包括：

- 引擎（`SurfCore`）：桥接、六个核心、DSH 插件、控制台、脚本、文档；
- 角色（`roles/`）：两份人格卡（性格核心 + 规则核心）；
- 角色包（`~/.dsh/surfcore/characters/`）：记忆卡、日记、B 站账本、快照；
- 运行状态（`state/`）：情绪、因果、会话、日志；
- 外围：语音实验室、3D 房间、监控台 App、桌宠。

**处理方式：先整包复制到一个新目录，再在副本上剥离；原目录一个字节都没动。**

---

## 二、删掉了什么，为什么

| 类别 | 具体 | 原因 |
| --- | --- | --- |
| 全部真实数据 | `state/`、`characters/`、日记、记忆卡、会话快照、聊天记录 | 他人隐私 + 你的隐私 |
| 全部标识 | QQ 号、群号、群名、群友昵称、B站 mid、本机用户名、内网 IP、主机名 | 直接指向具体的人 |
| 全部凭据 | SnowLuma token、控制台 token、搜索 API key、cookie | 拿到就能冒用 |
| 人格卡 | `roles/*.md`（除通用示例） | 属于某一个具体角色，不是你的 |
| 规则卡里的经历 | 「主人教过的」整段历史条目 | 记录的是某个人的相处细节 |
| 开发史文档 | HANDOFF / PITFALLS / ROADMAP / RISK_REGISTER / cases / CHANGELOG | 记录某台机器的具体事故，对新部署无价值且可能带出信息 |
| UI 截图 | 24 张控制台截图 | 截图里有真实 QQ 号、群名、头像 |
| 备份文件 | `*.bak`、`config.json.bak*`（80+ 个） | 历史配置里全是真实值 |
| 不可分发资产 | 语音包、克隆音色、3D 模型（`.pmx`）、ComfyUI/SDXL 模型 | 版权/许可，见 `docs/THIRD-PARTY.md` |
| 依赖与构建产物 | `node_modules/`、`dist/` | 用户自己 `npm install` |

---

## 三、改写了什么

| 文件 | 改了什么 |
| --- | --- |
| `roles/_TEMPLATE.md`、`_TEMPLATE.规则.md` | 全新写的空白模板（原来那两份是某个具体角色的） |
| `scripts/init-character.mjs` | 新增：从模板生成角色、写 `current-role.json` |
| `scripts/release-audit.mjs` | 新增：发布前隐私自检 |
| `scripts/bridge-supervisor.sh` 等 4 个 shell 脚本 | 去掉硬编码的 `/Users/<name>` 与 Homebrew 绝对路径，改成从脚本位置推导 |
| `src/bridge.js` | 写死的角色名 → 读 `roles/` 当前角色；身份守卫的可疑名单 → 读 `config.json`；兴趣词表 → 读 `config.json`；写死的机器人 QQ → 读配置 |
| `src/learn-ledger.js` | 去掉写死的称呼前缀 |
| `config.example.json` | 增加 `socialV2.interests` / `identityGuard`，清空全部真实号码 |
| `public/*.html` | 控制台标题去掉角色名 |
| 文档 | 重写根 README / INSTALL / AGENTS / CHARACTER / PRIVACY / SECURITY / TROUBLESHOOTING / OPTIONAL / THIRD-PARTY |

---

## 四、怎么复核

```bash
cd surfcore
node scripts/release-audit.mjs
```

它会扫：本机路径、QQ 号形态、API key、Bearer、长十六进制、内网 IP、MAC、邮箱。
**当前结果：high 0 / mid 246 / low 2**，其中 mid 全部是测试夹具与 B站 API 文档里的示例数字
（`192.168.x`、`1000000xx`、`13800138000` 之类），不是真人标识。

mid 里剩下这些是**故意保留**的：

- `scripts/test-*.mjs` 里的假 QQ / 假路径 / 假 key（有 `release-audit: allow` 标注）；
- `plugins/surfcore/tools/docs/*.md` 里 B站 开放平台的示例 `oid`；
- `docs/` 里的 `123456789`、`1000000001` 这类占位符。

---

## 五、这个包仍然**不能**保证的事

- 正则抓不到「用自然语言写进去的隐私」。删文档时是按「这段是不是只对某台机器有意义」人工判断的，
  判断可能漏。**再分发前请自己通读一遍 `docs/` 与 `roles/`。**
- 插件内部还有大量注释提到具体日期的调参记录（例如「2026-10-29 主人定」）。这些是设计理由，
  不指向具体的人，保留是为了让后来改代码的人知道「为什么这么写」。
- 代码里有若干 `console.log` 会打印会话 key（`private:<QQ>`）。这是运行日志，属于**你的**机器，
  不要把它贴到公开 issue 里。

---

## 六、给再分发者的三条建议

1. 改完先跑 `node scripts/release-audit.mjs --strict`，`high` 不为 0 别发；
2. 不要把自己的 `roles/*.md`、`config.json`、`state/` 提交进仓库（`.gitignore` 已经写好）；
3. 如果加了语音/模型/3D 资产，先确认许可，再确认体积——这两个是最容易让仓库变成「别人克隆不动」的原因。
