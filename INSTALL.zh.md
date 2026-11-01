> English version: [INSTALL.md](./INSTALL.md)

# 安装指南（从这里开始）

> 这份文档写给**两个人**：你和你的 DSH。
> 你可以自己照着做；也可以把 `AGENTS.md` 丢给 DSH，让它带着你走完。
> 全程大约 30–60 分钟，其中一半时间在等下载和扫码。

---

## 0. 先看清「谁做什么」

这套系统分三层，装的时候必须按顺序，少一层都跑不起来：

| 层 | 是什么 | 谁来做 |
| --- | --- | --- |
| **DSH** | 承载模型、工具与插件的运行时 | 你装 App/包；DSH 自己管自己 |
| **SnowLuma** | 把 QQ 协议转成 OneBot 的网关（要扫码登录） | 你下载、扫码；**不能替你扫码** |
| **SurfCore** | 桥接 + 六个核心 + 插件，也就是「她」 | 你跑几条命令；大部分能自动化 |

**只有你能做的事**（程序替不了）：
1. 用手机 QQ 扫码登录 SnowLuma；
2. 提供你的 QQ 号、要放她进去的群号；
3. 决定她叫什么、是什么性格（写 `roles/<名字>.md`）；
4. 如果要用语音/画图：自己准备音色和模型（见 `docs/OPTIONAL.md`）。

---

## 1. 装前置

| 需要 | 版本 | 检查命令 | 说明 |
| --- | --- | --- | --- |
| DeepSeek Harness | ≥ 0.2.1-rc.2 | 打开 App 能看到设置页 | 主程序 |
| Node.js | ≥ 22.13 | `node -v` | 桥接和脚本都跑在 Node 上 |
| npm | 随 Node | `npm -v` | 装依赖 |
| SnowLuma | 最新版 | 见第 3 步 | OneBot 网关，第三方，不随本项目分发 |
| QQ 小号 | — | — | 建议用小号，别用主号 |

平台差异：
- **Windows**：DSH 与 SnowLuma 都有原生包，最省事 → 看 [docs/INSTALL-Windows.md](docs/INSTALL-Windows.md)
- **macOS**：DSH 有原生包；SnowLuma 没有 macOS 版，要用 arm64 Docker 跑 → 看 [docs/INSTALL-macOS.md](docs/INSTALL-macOS.md)

---

## 2. 拿到代码

把整个 `yourDaughter` 文件夹放到一个**路径里没有空格和中文**的地方，例如：

- Windows：`D:\yourDaughter`
- macOS：`~/yourDaughter`

然后：

```bash
cd yourDaughter/surfcore
npm install
```

> 这一步会装 `js-yaml` 等依赖。国内网络慢可以加镜像：
> `npm install --registry=https://registry.npmmirror.com`

---

## 3. 装 SnowLuma 并登录 QQ

SnowLuma 是第三方 OneBot 实现，**本项目不包含它**，也不修改它。

1. 下载并启动 SnowLuma（Windows 直接跑 exe；macOS 用 Docker，见平台文档）。
2. 用它登录你的 QQ 小号（手机扫码）。
3. 确认它的 OneBot HTTP 服务在 `http://127.0.0.1:3000`、WebSocket 在 `ws://127.0.0.1:3001`。
4. 在 SnowLuma 的设置里找到 **access token**（有的版本叫「鉴权 token」），复制下来，下一步要用。

验证：

```bash
curl -H "Authorization: Bearer <你的token>" http://127.0.0.1:3000/get_login_info
```

返回里有你的 QQ 号和昵称，就说明网关通了。

---

## 4. 写配置

```bash
cp config.example.json config.json      # Windows: copy config.example.json config.json
```

打开 `config.json`，**只需要改这几处**（其余保持默认）：

```jsonc
{
  "ownerQQ": 123456789,                  // 你自己的 QQ 号（管理员）
  "snowluma": {
    "accessToken": "粘贴第 3 步的 token",
    "wsUrl": "ws://127.0.0.1:3001",
    "httpUrl": "http://127.0.0.1:3000"
  },
  "allow": {
    "private": [123456789],              // 允许私聊她的 QQ 号（先只放你自己）
    "groups": [987654321]                // 允许她进的群号（先放一个测试群）
  },
  "socialV2": {
    "interests": {                       // 她关心什么（可留空）
      "mascot": [],                      // 招牌词：命中算「强兴趣」
      "topics": []                       // 一般兴趣
    },
    "identityGuard": {
      "forbiddenNames": []               // 如果你借了某个角色的音色，把那个名字填进来
    }
  }
}
```

> `consoleToken` 留空也行——第一次启动会自动生成，写到 `state/console-token`，
> 控制台地址是 `http://127.0.0.1:3100/?token=<那个值>`。

**几个容易踩的点**：
- 群号/QQ 号写**数字**，不要加引号也行，但别写成字符串带空格；
- `allow` 是白名单：不在里面的群，她连消息都收不到（这是安全边界，不是 bug）；
- 想让另一个群也能用，把它加到 `allow.groups` 再重启。

---

## 5. 造一个角色

```bash
node scripts/init-character.mjs --name 女儿 --owner 123456789
```

它会做三件事：
1. 用 `roles/_TEMPLATE.md` 生成 `roles/女儿.md`；
2. 用 `roles/_TEMPLATE.规则.md` 生成 `roles/女儿.规则.md`；
3. 写 `state/current-role.json`，让桥接知道当前用哪个角色。

然后**打开 `roles/女儿.md` 开始写**。这一步决定她像不像人，比所有配置加起来都重要。
怎么写见 [docs/CHARACTER.md](docs/CHARACTER.md)；想先看个填好的例子：`roles/傲娇助手.md`。

---

## 6. 装 DSH 端

```bash
node scripts/setup-dsh.mjs
```

它会把三样东西装进 DSH：
- 两个 agent preset（`qq-chat` / `qq-chat-v2`）——决定她在 QQ 里能用哪些工具、怎么说话；
- 三个 MCP server（`snowluma` / `snowluma-host` / `web-search-safe`）；
- `surfcore` 插件 bundle（设置窗口 + 监控台 + B站工具）。

装完**重启 DSH**，然后在 `设置 → SurfCore` 里点一次「诊断 → 一键安装」。
（如果设置里看不到 SurfCore，按 F5 刷新页面，或确认 `setup-dsh.mjs` 没报错。）

---

## 7. 启动

两种方式，选一个：

**A. 让插件自己起（推荐）**
重启 DSH 后，插件会按 `config.json` 自动拉起桥接。

**B. 手动起，方便看日志**
```bash
cd surfcore
npm start
```

看到这几行就说明起来了：

```
[bridge] SnowLuma 已连接：ws://127.0.0.1:3001
[bridge] 机器人昵称: xxx
[bridge] DSH 已就绪（模式: reserved2）
```

---

## 8. 验收清单

按顺序过一遍，任何一步不对就停下来看 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)：

- [ ] `curl http://127.0.0.1:3100/api/status -H "x-console-token: $(cat state/console-token)"` 返回 `"ok":true`
- [ ] 控制台能看到「当前角色」是你起的名字
- [ ] 私聊她说一句「在吗」，她回你（第一次可能要等十几秒）
- [ ] 群里 @ 她，她能接
- [ ] 控制台「情绪」页五个值在 0–1 之间跳动
- [ ] 过十分钟再看，情绪值变了（说明 tick 在跑）
- [ ] 她主动说话的那次，控制台「因果」里能看到一条待结算

---

## 9. 接下来做的事

1. **把性格卡写完整**：`roles/女儿.md` 的「二、说话风格」和「三、内在」是最影响真实感的。
2. **跑一天再看**：情绪和驱力需要时间积累，刚装的半小时看不出东西。
3. **调额度**：`socialV2.tokenGuard` 控制每天唤醒次数和花费上限，默认 80 次/天、¥15/天。
4. **接可选能力**：语音、画图、B站（见 `docs/OPTIONAL.md`）。
5. **备份**：`state/` 和 `roles/` 就是她的全部；定期打包。

---

## 10. 升级与卸载

**升级**：保留 `config.json`、`roles/`、`state/`、`characters/`，替换其余文件，再 `npm install`。

**卸载**：
```bash
node scripts/uninstall.mjs      # 从 DSH 里摘掉 presets / MCP / 插件
```
然后删掉整个目录即可。她的记忆和日记都在 `state/` 与 `roles/`，删之前想留就复制走。
