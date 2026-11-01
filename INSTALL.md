# Installation

> Written for two readers: **you**, and **your DSH agent**. If you want the agent to do it,
> hand it [`AGENTS.md`](AGENTS.md) and say "install this for me".
> Budget 30–60 minutes; half of that is downloads and one QR scan.

---

## 0. Who does what

Three layers, and they must be installed in this order:

| Layer | What it is | Who does it |
| --- | --- | --- |
| **DSH** | the runtime that hosts the model, tools and plugins | you install the app; DSH manages itself |
| **SnowLuma** | OneBot gateway that bridges QQ protocol (needs a QR login) | you download it and scan the code — **nobody can do this for you** |
| **SurfCore** | bridge + six cores + plugin, i.e. "her" | a few commands, mostly automatic |

**Only you can do these** (no program can):
1. Scan the QR code to log the QQ account into SnowLuma.
2. Provide your QQ number and the group ID she should join.
3. Decide her name and personality (write `surfcore/roles/<name>.md`).
4. If you want voice or image generation: supply the models yourself (see [OPTIONAL.md](docs/OPTIONAL.md)).

---

## 1. Prerequisites

| Need | Version | Check | Notes |
| --- | --- | --- | --- |
| DeepSeek Harness | ≥ 0.2.1-rc.2 | app opens to Settings | the host runtime |
| Node.js | ≥ 22.13 | `node -v` | bridge and scripts run on Node |
| npm | ships with Node | `npm -v` | |
| SnowLuma | latest | see step 3 | third-party OneBot gateway, not bundled |
| a spare QQ account | — | — | use a secondary account, not your main one |

Platform notes:
- **Windows**: DSH and SnowLuma both have native builds — the easy path → [docs/INSTALL-Windows.md](docs/INSTALL-Windows.md)
- **macOS**: DSH is native; SnowLuma has no macOS build, so it runs in arm64 Docker → [docs/INSTALL-macOS.md](docs/INSTALL-macOS.md)

---

## 2. Get the code

Put the folder somewhere **without spaces or non-ASCII characters** in the path:

- Windows: `D:\dsh-sixCoreAIModel`
- macOS: `~/dsh-sixCoreAIModel`

```bash
cd surfcore
npm install
```

> If the network is slow: `npm install --registry=https://registry.npmmirror.com`

---

## 3. SnowLuma + QQ login

SnowLuma is a third-party OneBot implementation. **It is not bundled here** and is not modified by this project.

1. Download and start SnowLuma (native exe on Windows; Docker on macOS — see the platform guide).
2. Log in your QQ account with the QR code.
3. Confirm the OneBot endpoints: HTTP on `http://127.0.0.1:3000`, WebSocket on `ws://127.0.0.1:3001`.
4. Copy the **access token** from SnowLuma's settings (sometimes called "auth token"); you need it in step 4.

Verify:

```bash
# macOS / Linux
curl -H "Authorization: Bearer <token>" http://127.0.0.1:3000/get_login_info
```
```powershell
# Windows (note curl.exe — plain curl is aliased to Invoke-WebRequest)
curl.exe -H "Authorization: Bearer <token>" http://127.0.0.1:3000/get_login_info
```

If it returns your QQ number and nickname, the gateway is up.

---

## 4. Configure

```bash
cp config.example.json config.json      # Windows: copy config.example.json config.json
```

Open `config.json` and change **only these** (leave the rest at defaults):

```jsonc
{
  "ownerQQ": 123456789,                  // your own QQ number (the admin)
  "snowluma": {
    "accessToken": "paste the token from step 3",
    "wsUrl": "ws://127.0.0.1:3001",
    "httpUrl": "http://127.0.0.1:3000"
  },
  "allow": {
    "private": [123456789],              // who may DM her — start with only yourself
    "groups": [987654321]                // which groups may she join — start with one test group
  },
  "socialV2": {
    "interests": {                       // optional: her topics (empty = no boost)
      "mascot": [],                      // the "signature" word — strong interest
      "topics": []                       // ordinary interests
    },
    "identityGuard": {
      "forbiddenNames": []               // if you cloned a character's voice, list that name here
    }
  }
}
```

> `consoleToken` may stay empty — one is generated on first start and written to
> `state/console-token`. The console URL is `http://127.0.0.1:3100/?token=<that value>`.

**Common mistakes**
- IDs must be numbers (quotes are fine, stray spaces are not).
- `allow` is an allow-list: messages from groups that are not listed never reach the model. That is a security boundary, not a bug.
- To add another group later, append its ID to `allow.groups` and restart the bridge.

---

## 5. Create a character

```bash
node scripts/init-character.mjs --name Daughter --owner 123456789
```

It does three things:
1. generates `roles/Daughter.md` from `roles/_TEMPLATE.md`;
2. generates `roles/Daughter.规则.md` from `roles/_TEMPLATE.规则.md`;
3. writes `state/current-role.json` so the bridge knows which role is active.

Then **open `roles/Daughter.md` and write it**. This step decides whether she reads as a person;
it matters more than every other setting combined. How to write it: [docs/CHARACTER.md](docs/CHARACTER.md).
A filled-in example: `surfcore/roles/傲娇助手.md`.

---

## 6. Install into DSH

```bash
node scripts/setup-dsh.mjs
```

This installs three things into DSH:
- two agent presets (`qq-chat` / `qq-chat-v2`) — which tools she gets in QQ, and how she speaks there;
- three MCP servers (`snowluma` / `snowluma-host` / `web-search-safe`);
- the `surfcore` plugin bundle (settings page + console + Bilibili tools).

Then **restart DSH**, open `Settings → SurfCore` and click "Diagnose → Install all" once.
(If SurfCore does not appear in Settings, press F5 — the plugin list is a snapshot taken at page load.)

---

## 7. Start

Either:

**A. Let the plugin start it (recommended)** — after restarting DSH, the plugin launches the bridge from `config.json`.

**B. Start manually (easier to watch logs)**
```bash
cd surfcore
npm start
```

You should see:

```
[bridge] SnowLuma connected: ws://127.0.0.1:3001
[bridge] bot nickname: xxx
[bridge] DSH ready (mode: reserved2)
```

---

## 8. Acceptance checklist

Go through these in order; if one fails, stop and read [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md):

- [ ] `curl -H "x-console-token: $(cat state/console-token)" http://127.0.0.1:3100/api/status` returns `"ok":true`
- [ ] the console shows your character name as the current role
- [ ] DM her "hello" — she replies (the first reply can take ~10 s)
- [ ] @-mention her in the group — she responds
- [ ] the console's emotion page shows five values moving between 0 and 1
- [ ] ten minutes later, those values have changed (the tick is running)
- [ ] after she speaks on her own, the console's causal page shows a pending settlement

---

## 9. What to do next

1. **Finish the character card** — sections "二、说话风格" (speaking style) and "三、内在" (interior) matter most.
2. **Let it run for a day** — affect and drive need time to accumulate; the first 30 minutes tell you nothing.
3. **Tune the budget** — `socialV2.tokenGuard` caps wakes per day and spend per day (default 80 wakes, ¥15).
4. **Add optional abilities** — voice, image generation, Bilibili (see [OPTIONAL.md](docs/OPTIONAL.md)).
5. **Back up** — `state/` and `roles/` are all of her; archive them now and then.

---

## 10. Upgrade and uninstall

**Upgrade**: keep `config.json`, `roles/`, `state/` and `characters/`; replace everything else; run `npm install` again.

**Uninstall**:
```bash
node scripts/uninstall.mjs
```
Then delete the folder. Her memory and diary live in `state/` and `roles/` — copy them out first if you want to keep them.
