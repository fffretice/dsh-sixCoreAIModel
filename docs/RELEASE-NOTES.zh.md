> English version: [RELEASE-NOTES.md](./RELEASE-NOTES.md)

# 发布说明：这个包是怎么清洗出来的

这份文件写给**要再分发它的人**，也写给未来的自己：说明哪些东西被剥离了、依据是什么、怎么复核。

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
