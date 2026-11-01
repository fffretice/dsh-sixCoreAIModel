# Windows installation

Windows is the easy platform: DSH and SnowLuma both ship native builds, no Docker involved.
This guide takes a clean Windows 10/11 x64 machine to "she replies in the group".

> Run everything in **PowerShell** (not cmd). Total time ≈ 20 minutes, 10 of which are downloads.

---

## 1. Node.js

Download the **LTS** Windows installer (`.msi`) from [nodejs.org](https://nodejs.org) and click through it.
Then open a **new** PowerShell window (environment variables are only picked up by new shells):

```powershell
node -v      # must be >= v22.13
npm -v
```

> If `node` is "not recognized": close every PowerShell window and reopen one, or reboot.
> Do not use the Node that ships with some IDEs — it is usually older.

---

## 2. DeepSeek Harness

Install the Windows build of DSH and launch it once, so it creates `%USERPROFILE%\.dsh`.

Check it exists:

```powershell
Test-Path "$env:USERPROFILE\.dsh"
```

---

## 3. SnowLuma

1. Download the **win-x64** archive from [SnowLuma Releases](https://github.com/SnowLuma/SnowLuma/releases/latest).
2. Extract it to a path **without spaces or Chinese characters**, e.g. `D:\SnowLuma`.
3. Run it. The first launch may take a while (it initialises an embedded client).
4. In its window: enter the QQ number → a QR code appears → scan it with mobile QQ → confirm.

Then verify the OneBot gateway:

```powershell
curl.exe -H "Authorization: Bearer <token>" http://127.0.0.1:3000/get_login_info
```

> Use `curl.exe`, not `curl` — in PowerShell `curl` is an alias for `Invoke-WebRequest`,
> which ignores `-H` in a different way and will confuse you.

If the response contains your QQ number, the gateway is up. If SnowLuma uses different ports,
either change them in SnowLuma's settings to 3000/3001, or point `snowluma.httpUrl` / `snowluma.wsUrl`
in `config.json` at whatever it does use.

---

## 4. SurfCore

```powershell
cd D:\dsh-sixCoreAIModel\surfcore
npm install
copy config.example.json config.json
```

Open `config.json` in Notepad or VS Code and set:

```jsonc
"ownerQQ": 123456789,
"allow": { "private": [123456789], "groups": [987654321] },
"snowluma": { "accessToken": "the token from step 3" }
```

**Path rules**: do not put this under `C:\Program Files`, and do not put it on the Desktop if your
Windows account name is non-ASCII (`C:\Users\张三\Desktop`). `D:\dsh-sixCoreAIModel` is a good choice.

---

## 5. Create a character and install into DSH

```powershell
node scripts/init-character.mjs --name Daughter --owner 123456789
node scripts/setup-dsh.mjs
```

Then **restart DSH** (quit from the tray, then relaunch) and open `Settings → SurfCore → Diagnose → Install all`.

If SurfCore does not show up in Settings:
1. Did `setup-dsh.mjs` print any error?
2. Did you restart DSH after it?
3. Press F5 in the settings window.

---

## 6. Start the bridge

```powershell
npm start
```

You should see `[bridge] SnowLuma connected`. To keep it running:

- **Simple**: leave the PowerShell window minimised.
- **Proper**: create a Task Scheduler job:
  - Trigger: *At log on*
  - Action: start `node.exe`
  - Arguments: `D:\dsh-sixCoreAIModel\surfcore\src\bridge.js`
  - Start in: `D:\dsh-sixCoreAIModel\surfcore`

> The `scripts/*.sh` helpers are macOS/Linux only. On Windows the DSH plugin's `autoStartBridge`
> handles restarts; the shell scripts are not needed.

---

## 7. Windows-specific pitfalls

| Symptom | Cause | Fix |
| --- | --- | --- |
| `npm install` hangs on a native build | missing build tools | `npm install --ignore-scripts`, then install only what you need; this project normally needs no compilation |
| `ENOENT` with a path containing Chinese characters | non-ASCII path + some Node APIs | move the folder to an ASCII path |
| Garbled Chinese in the console | PowerShell code page | `chcp 65001` in that window, or use Windows Terminal |
| Firewall prompt for port 3100 | bridge listening locally | allow **private networks only**, never public |
| Port 3000 already in use | another service took the OneBot port | `netstat -ano | findstr :3000`, kill it, or change ports on both sides |
| `curl` behaves strangely | alias to `Invoke-WebRequest` | always write `curl.exe` |
| DSH restarts and she stops replying | bridge is still connected to the old DSH port | restart the bridge; the plugin normally handles this |
| Antivirus quarantines the bridge | heuristic on a Node process writing many files | add the project folder as an exclusion |

---

## 8. Verify

```powershell
curl.exe -H "x-console-token: $(Get-Content .\state\console-token)" http://127.0.0.1:3100/api/status
```

`"ok":true` means the bridge is alive. Open `http://127.0.0.1:3100/?token=<token>` in a browser,
then walk through the checklist in [INSTALL.md](../INSTALL.md#8-acceptance-checklist).

---

## 9. Updating and uninstalling

**Update**: keep `config.json`, `roles\`, `state\`, `characters\`; replace the rest; run `npm install`.

**Uninstall**:
```powershell
node scripts/uninstall.mjs
```
Then delete the folder. `state\` and `roles\` hold her memory and character — copy them out first if you care.
