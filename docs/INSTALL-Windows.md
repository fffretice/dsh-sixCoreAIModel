# Windows 部署

Windows 是最省事的平台：DSH 和 SnowLuma 都有原生包，不需要 Docker。

> 下面的命令在 **PowerShell**（不是 cmd）里执行。建议用 Windows 10/11 x64。

---

## 1. Node.js

去 [nodejs.org](https://nodejs.org) 下 **LTS** 的 Windows 安装包（`.msi`），一路下一步。
装完**新开一个** PowerShell：

```powershell
node -v      # 需要 >= v22.13
npm -v
```

> 如果 `node` 命令找不到：关掉所有 PowerShell 窗口重开，或重启一次。

---

## 2. DeepSeek Harness

装 Windows 版 DSH，先启动一次，让它把 `%USERPROFILE%\.dsh` 建出来。

---

## 3. SnowLuma

1. 到 [SnowLuma Releases](https://github.com/SnowLuma/SnowLuma/releases/latest) 下 **win-x64** 包；
2. 解压到一个**没有中文和空格**的路径，例如 `D:\SnowLuma`；
3. 双击启动，等它把界面拉起来；
4. 在界面里输入 QQ 号 → 出二维码 → 手机 QQ 扫码登录。

登录后确认网关在跑：

```powershell
curl.exe -H "Authorization: Bearer <token>" http://127.0.0.1:3000/get_login_info
```

> Windows 自带的是 `curl.exe`，在 PowerShell 里写 `curl` 可能会被别名成 `Invoke-WebRequest`，
> 所以显式写 `curl.exe`。

如果 SnowLuma 的默认端口不是 3000/3001，去它的设置里改成这两个，或者改 `config.json`
里的 `snowluma.httpUrl` / `wsUrl` 去适配它。

---

## 4. SurfCore

```powershell
cd D:\yourDaughter\surfcore
npm install
copy config.example.json config.json
```

用记事本 / VS Code 打开 `config.json`，改这四个字段：

```jsonc
"ownerQQ": 123456789,
"allow": { "private": [123456789], "groups": [987654321] },
"snowluma": { "accessToken": "第 3 步的 token" }
```

> **路径要求**：别放在 `C:\Program Files`、别放桌面（中文用户名会变成 `C:\Users\张三\Desktop`），
> 放在 `D:\yourDaughter` 这种纯英文短路径最稳。

---

## 5. 建角色、装进 DSH

```powershell
node scripts/init-character.mjs --name 女儿 --owner 123456789
node scripts/setup-dsh.mjs
```

然后**重启 DSH**（托盘退出，再打开），进 `设置 → SurfCore → 诊断 → 一键安装`。

---

## 6. 启动

```powershell
npm start
```

看到 `[bridge] SnowLuma 已连接` 就成了。想后台常驻：

- 简单做法：把 `npm start` 的窗口最小化，别关；
- 稳一点：用「任务计划程序」建一个「登录时启动」的任务，程序填 `node.exe`，
  参数填 `D:\yourDaughter\surfcore\src\bridge.js`，起始位置填 `D:\yourDaughter\surfcore`。

> 仓库里的 `scripts/*.sh` 是给 macOS/Linux 的，Windows 上用不到；
> Windows 侧的守护逻辑由 DSH 插件负责（`autoStartBridge`）。

---

## 7. Windows 特有的坑

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `npm install` 卡在编译 | 缺构建工具 | 先 `npm install --ignore-scripts`，再单独装需要的包；本项目一般不需要编译原生模块 |
| 路径里带中文，桥接报 `ENOENT` | 中文路径 + 某些 Node API | 换纯英文路径 |
| 控制台中文乱码 | PowerShell 编码 | `chcp 65001` 再跑，或改用 Windows Terminal |
| 防火墙弹窗 | 桥接监听 3100 | 只允许「专用网络」即可，别开到公网 |
| 端口 3000 被占 | 别的服务占了 OneBot 端口 | `netstat -ano | findstr :3000` 找到进程，改 SnowLuma 或本项目的端口 |

---

## 8. 验收

```powershell
curl.exe -H "x-console-token: $((Get-Content .\state\console-token))" http://127.0.0.1:3100/api/status
```

返回 `"ok":true` 就说明桥接活着。浏览器打开 `http://127.0.0.1:3100/?token=<token>` 看控制台，
然后按 `INSTALL.md` 第 8 节逐项验收。
