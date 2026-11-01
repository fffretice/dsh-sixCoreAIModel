# macOS installation

On a Mac the only awkward part is **SnowLuma: there is no macOS build**, so it runs as a Linux
container through Docker. Everything else (DSH, Node, SurfCore) is native.

> Works on Apple Silicon (M1–M4) and Intel Macs. All commands go in Terminal.

---

## 1. Node.js

```bash
brew install node@22
node -v            # must be >= v22.13
```

No Homebrew? Install the pkg from [nodejs.org](https://nodejs.org).

---

## 2. DeepSeek Harness

Install the macOS build (drag the `.dmg` into Applications) and launch it once so `~/.dsh/` is created.
Leave it running — the plugin install later needs it.

---

## 3. SnowLuma (Docker)

### 3.1 Docker runtime

Pick one:

```bash
# A. Colima — lightweight, CLI only (recommended)
brew install colima docker
colima start --cpu 2 --memory 4

# B. Docker Desktop — GUI
#    download from docker.com, launch it, wait for the whale icon in the menu bar
```

Verify:

```bash
docker ps        # no error means the runtime is up
```

### 3.2 Start SnowLuma

Save the reference compose file from this repo as `~/snowluma/docker-compose.yml`
(it is [`snowluma-compose.yml`](snowluma-compose.yml)), then:

```bash
cd ~/snowluma
docker compose up -d
docker compose logs -f --tail=50
```

The first run pulls a few hundred MB.

### 3.3 QR login

Open **`http://127.0.0.1:6081`** (noVNC). Inside is SnowLuma's UI:

1. enter the QQ number;
2. click login → QR code appears;
3. scan it with mobile QQ and confirm.

Then check the gateway:

```bash
curl -H "Authorization: Bearer <token>" http://127.0.0.1:3000/get_login_info
```

> **macOS gotcha**: the QQ window inside the container occasionally renders black. Reload the
> `6081` page; if that fails, `docker compose restart` and look again.

---

## 4. SurfCore

```bash
cd ~/dsh-sixCoreAIModel/surfcore
npm install
cp config.example.json config.json
```

Edit `config.json`: `ownerQQ`, `allow.private`, `allow.groups`, `snowluma.accessToken`.

> Keep the path free of spaces and non-ASCII characters — some scripts pass it to shell
> commands without quoting. `~/dsh-sixCoreAIModel` is a good choice.

---

## 5. Character and DSH install

```bash
node scripts/init-character.mjs --name Daughter --owner <your-qq>
node scripts/setup-dsh.mjs
```

Then **restart DSH** (⌘Q, reopen) and go to `Settings → SurfCore → Diagnose → Install all`.

---

## 6. Start the bridge

```bash
cd ~/dsh-sixCoreAIModel/surfcore
npm start
```

To keep it running in the background — the supervisor script discovers the DSH port by itself:

```bash
nohup ./scripts/bridge-supervisor.sh >/dev/null 2>&1 &
```

To start at login, let launchd run it: create `~/Library/LaunchAgents/com.yourname.surfcore.plist`
with `ProgramArguments` pointing at `bridge-supervisor.sh` and `RunAtLoad` set to true, then:

```bash
launchctl load ~/Library/LaunchAgents/com.yourname.surfcore.plist
```

---

## 7. Three macOS-specific pitfalls

**① DSH changes port on every restart.**
The bridge keeps the old port and goes quiet — the symptom is "QQ has messages, she says nothing".
Use `scripts/bridge-supervisor.sh` (it rediscovers the port) or restart the bridge manually.

**② Don't `killall` DSH.**
Use `osascript -e 'quit app "DeepSeek Harness"'` (that is what `scripts/restart-dsh.sh` does);
hard-killing leaves the session state dirty.

**③ Microphone permission (only if you add voice).**
Browser recording requires https or localhost, and macOS will ask for microphone access once.
Voice is not included by default — see [OPTIONAL.md](OPTIONAL.md).

---

## 8. Verify

```bash
curl -s -H "x-console-token: $(cat ~/dsh-sixCoreAIModel/surfcore/state/console-token)" \
     http://127.0.0.1:3100/api/status
```

`"ok":true`, then open `http://127.0.0.1:3100/?token=<token>` and walk the checklist in
[INSTALL.md](../INSTALL.md#8-acceptance-checklist).
