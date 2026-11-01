> English version: [INSTALL-macOS.md](./INSTALL-macOS.md)

# macOS 部署

在 Mac 上跑这套东西，唯一麻烦的是 **SnowLuma 没有 macOS 原生版**，得用 Docker 跑它的 Linux 镜像。
除此之外（DSH、Node、SurfCore）都是原生的。

> 适用于 Apple Silicon（M1/M2/M3/M4）与 Intel Mac。下面的命令都在「终端」里执行。

---

## 1. Node.js

推荐用 Homebrew：

```bash
brew install node@22
node -v        # 需要 >= v22.13
```

没有 Homebrew 就去 [nodejs.org](https://nodejs.org) 下 pkg 安装包。

---

## 2. DeepSeek Harness

装 macOS 版 DSH（dmg 拖进 Applications 即可）。首次启动它会自己建 `~/.dsh/`。
先别急着关，后面的插件安装要连它。

---

## 3. SnowLuma（Docker）

### 3.1 装 Docker 运行时

二选一：

```bash
# A. Colima（轻量，推荐；命令行）
brew install colima docker
colima start --cpu 2 --memory 4

# B. Docker Desktop（图形界面）
#    从 docker.com 下载安装，启动后在菜单栏看到招牌词图标即可
```

验证：

```bash
docker ps      # 不报错就说明运行时通了
```

### 3.2 起 SnowLuma

把仓库里的参考 compose 存到任意目录（例如 `~/snowluma/docker-compose.yml`），内容就是
[`snowluma-compose.yml`](snowluma-compose.yml)。然后：

```bash
cd ~/snowluma
docker compose up -d
docker compose logs -f --tail=50
```

第一次会拉镜像（约几百 MB），等它起来。

### 3.3 扫码登录

浏览器打开 **`http://127.0.0.1:6081`**（noVNC 画面），里面是 SnowLuma 的界面：

1. 输入 QQ 号；
2. 点登录，出现二维码；
3. 用手机 QQ 扫码，确认。

登录成功后，检查网关：

```bash
curl http://127.0.0.1:3000/get_login_info      # 没设 token 时
```

如果镜像设了 token，就带 `-H "Authorization: Bearer <token>"`。

> **macOS 的坑**：Docker 容器里跑 QQ，扫码窗口偶尔会黑屏。刷新 `6081` 页面即可；
> 还不行就 `docker compose restart` 再看。

---

## 4. SurfCore

```bash
cd ~/yourDaughter/surfcore
npm install
cp config.example.json config.json
```

编辑 `config.json`，填 `ownerQQ`、`allow.private`、`allow.groups`、`snowluma.accessToken`。

> macOS 上文件路径别带空格和中文，否则某些脚本会挂。`~/yourDaughter` 就很好。

---

## 5. 建角色并装进 DSH

```bash
node scripts/init-character.mjs --name 女儿 --owner <你的QQ号>
node scripts/setup-dsh.mjs
```

然后**重启 DSH**（⌘Q 退出再打开），进 `设置 → SurfCore → 诊断 → 一键安装`。

---

## 6. 启动桥接

```bash
cd ~/yourDaughter/surfcore
npm start
```

如果想让它在后台常驻，用仓库自带的守护脚本（它自己会找 DSH 的端口）：

```bash
nohup ./scripts/bridge-supervisor.sh >/dev/null 2>&1 &
```

想开机自启，把它交给 launchd：新建 `~/Library/LaunchAgents/com.yourname.surfcore.plist`，
`ProgramArguments` 指向 `bridge-supervisor.sh`，`RunAtLoad` 设 true，然后
`launchctl load ~/Library/LaunchAgents/com.yourname.surfcore.plist`。

---

## 7. macOS 特有的三个坑

**① DSH 每次重启都换端口**
桥接会拿着旧端口静默失联，表现是「QQ 有消息、她不说话」。
用 `scripts/bridge-supervisor.sh`（会自动发现端口），或手动重启桥接。

**② 别用 `restart-dsh.sh` 之外的方式硬杀 DSH**
`killall` 会让 DSH 的会话状态不干净；用 `osascript` 退 App 的方式在脚本里已经写好了。

**③ 麦克风权限（只有做语音时需要）**
浏览器录音要求 https 或 localhost；系统会弹一次麦克风授权，点允许。
本项目默认不含语音，见 `docs/OPTIONAL.md`。

---

## 8. 验收

```bash
curl -s -H "x-console-token: $(cat ~/yourDaughter/surfcore/state/console-token)" \
     http://127.0.0.1:3100/api/status
```

返回 `"ok":true`，然后浏览器打开 `http://127.0.0.1:3100/?token=<token>` 看控制台。
剩下的验收项见 `INSTALL.md` 第 8 节。
