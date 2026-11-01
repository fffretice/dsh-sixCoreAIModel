# 给 DSH（或任何接手的 AI 助手）的安装说明

> 你正在读的这份文件是写给**代理**的，不是写给终端的。用户把整个项目交给你，让你在他的机器上
> 把这套「人格智能体」装起来。请严格按下面的顺序做，不要跳步，不要替用户做决定。

## 你的任务

在用户自己的机器上，把 `surfcore/` 跑起来，并帮他建好第一个角色：

1. 核对前置（Node、DSH、SnowLuma、QQ）
2. `npm install`
3. 生成 `config.json` 并让**用户**填 3 个值（QQ 号、群号、SnowLuma token）
4. 生成角色卡，并**引导用户**写性格（不要替他编人格）
5. `node scripts/setup-dsh.mjs`，然后重启 DSH
6. 启动桥接，按验收清单逐项确认
7. 出问题时按 `docs/TROUBLESHOOTING.md` 排查，不要猜

## 硬规则

- **不要替用户扫码、不要向他索要 QQ 密码**。扫码永远由用户本人完成。
- **不要编造配置值**。用户没给 QQ 号/群号/token 就停下来问，问得具体：
  「你的 QQ 号是多少？要放进哪个群（群号）？SnowLuma 的 access token 是多少？」
- **不要修改 `surfcore/` 以外的任何系统文件**；不要动用户已装好的其他 DSH 插件。
- **不要删 `state/`、`roles/`、`config.json`**——那是用户的角色和她全部的记忆。
- 用户没要求时，不要主动接语音、画图、3D 房间（见 `docs/OPTIONAL.md`，那些要额外的模型和显卡）。
- 报错时先读日志（`state/bridge.log`、`state/bridge-supervisor.log`），把**原始报错**贴给用户，
  不要复述成「可能是环境问题」。

## 一步一步来

### 第 1 步：核对前置

```bash
node -v      # 必须 >= v22.13
npm -v
```

还要确认：
- DSH 能打开（版本 ≥ 0.2.1-rc.2）；
- SnowLuma 已安装并**已由用户扫码登录**；
- `curl -H "Authorization: Bearer <token>" http://127.0.0.1:3000/get_login_info` 能返回 QQ 号。

缺哪一样就先补哪一样，别往下走。

### 第 2 步：装依赖

```bash
cd <项目路径>/surfcore
npm install
```

失败常见原因：网络（换 `--registry=https://registry.npmmirror.com`）、Node 版本太低。

### 第 3 步：配置

```bash
cp config.example.json config.json
```

然后用**用户给你的值**改这四个字段（其余不要动）：

- `ownerQQ`
- `allow.private`（先只放用户自己）
- `allow.groups`（先只放一个测试群）
- `snowluma.accessToken`

改完让用户确认一遍，再继续。

### 第 4 步：建角色

```bash
node scripts/init-character.mjs --name <用户起的名字> --owner <QQ号>
```

然后把 `roles/<名字>.md` 里所有 `【填写】` 指给用户看，让他自己写。
你可以解释每一节在管什么（`docs/CHARACTER.md` 有逐节说明），**但不要代写人格**。
如果他让你先来个能跑的版本，就用模板原样，告诉他「先跑起来，性格随时改，改完下一次唤醒生效」。

### 第 5 步：装进 DSH

```bash
node scripts/setup-dsh.mjs
```

它会打印装了哪些 preset / MCP / bundle。之后**重启 DSH**（让用户点，或按 `docs/INSTALL-macOS.md` 的
重启脚本）。重启后在设置里找 `SurfCore`，点「诊断 → 一键安装」。

### 第 6 步：启动并验收

```bash
npm start
```

逐项确认（见 `INSTALL.md` 第 8 节）：
`/api/status` 是 ok → 控制台能看到角色 → 私聊有回复 → 群里 @ 有反应 → 情绪值在跳。

**任何一项不过，就停下来排查，不要跳过。**

### 第 7 步：交付

告诉用户三件事：
1. 他的女儿叫什么、性格卡在哪个文件、改完什么时候生效；
2. 每天花多少钱（`socialV2.tokenGuard.maxDailyCostCNY`，默认 ¥15）、在哪改；
3. 怎么备份（`state/` + `roles/` + `config.json`）、怎么卸载（`node scripts/uninstall.mjs`）。

## 遇到这些情况，别硬修

| 现象 | 大概率原因 | 你要做的 |
| --- | --- | --- |
| 桥接起来了但 `dshReady:false` | DSH 重启换了端口 | 重启桥接（它自己会找端口）；看 `state/bridge-supervisor.log` |
| 私聊没反应 | 白名单没加、或 SnowLuma 掉线 | 查 `allow.private`、查 `get_login_info` |
| 群里 @ 她不回 | 群不在 `allow.groups`，或 preset 没装上 | 查配置、重跑 `setup-dsh.mjs`、重启 DSH |
| 控制台 401 | token 不对 | `cat state/console-token`，用 `?token=` 访问 |
| 她一直不说话 | 唤醒额度用完了 / 情绪贴底睡着 | 看控制台「情绪」页和 `state/mood.json` |
| 报 `Cannot find module '@deepseek-ai/schemastery'` | 先装了插件后装依赖 | 重跑 `npm install`，再重装插件、重启 DSH |

更全的排查见 `docs/TROUBLESHOOTING.md`。
