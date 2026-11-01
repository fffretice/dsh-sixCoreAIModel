# Instructions for the DSH agent doing the install

> This file is written for an **agent**, not for a terminal. The user handed you this project and
> asked you to get it running on their machine. Follow the order below. Do not skip steps.
> Do not make decisions that belong to the user.

## Your task

Get `surfcore/` running on the user's machine and create their first character:

1. verify prerequisites (Node, DSH, SnowLuma, QQ)
2. `npm install`
3. generate `config.json` and have the **user** supply three values (QQ number, group ID, SnowLuma token)
4. create a character card and **guide the user** through writing it (do not invent a personality)
5. `node scripts/setup-dsh.mjs`, then restart DSH
6. start the bridge and walk the acceptance checklist
7. when something fails, follow `docs/TROUBLESHOOTING.md` — do not guess

## Hard rules

- **Never scan the QR code for the user, never ask for the QQ password.** QR login is always theirs.
- **Never invent config values.** If you are missing the QQ number, group ID or token, stop and ask precisely:
  "What is your QQ number? Which group should she join (group ID)? What is the SnowLuma access token?"
- **Do not modify anything outside `surfcore/`**, and do not touch other DSH plugins the user already has.
- **Never delete `state/`, `roles/`, `config.json`** — that is the character and all of her memory.
- Do not enable voice, image generation or 3D on your own initiative (see `docs/OPTIONAL.md`; those need extra models).
- When something breaks, read the logs (`state/bridge.log`, `state/bridge-supervisor.log`) and show the user
  the **raw error**, not your paraphrase of it.

## Step by step

### 1. Prerequisites

```bash
node -v      # must be >= v22.13
npm -v
```

Also confirm: DSH opens (≥ 0.2.1-rc.2); SnowLuma is installed and the user has scanned the QR;
`curl -H "Authorization: Bearer <token>" http://127.0.0.1:3000/get_login_info` returns their QQ number.

If anything is missing, fix that first.

### 2. Dependencies

```bash
cd <project>/surfcore
npm install
```

Common failures: network (`--registry=https://registry.npmmirror.com`), Node too old.

### 3. Config

```bash
cp config.example.json config.json
```

Change exactly four fields, using **values the user gave you**:

- `ownerQQ`
- `allow.private` (start with only the user)
- `allow.groups` (start with one test group)
- `snowluma.accessToken`

Show the edited block back to the user for confirmation before continuing.

### 4. Character

```bash
node scripts/init-character.mjs --name <name> --owner <qq>
```

Then point the user at the `【填写】` markers in `roles/<name>.md` and let **them** write it.
You may explain what each section controls (see `docs/CHARACTER.md`), but do not write the personality for them.
If they ask for something runnable right now, leave the template as-is and tell them:
"it runs like this; the personality can change any time, and edits apply on the next wake."

### 5. Install into DSH

```bash
node scripts/setup-dsh.mjs
```

It prints which presets / MCP servers / bundles it installed. Then **restart DSH** (let the user do it,
or use `scripts/restart-dsh.sh` on macOS). After restart, `Settings → SurfCore → Diagnose → Install all`.

### 6. Start and verify

```bash
npm start
```

Walk the checklist in `INSTALL.md` §8: `/api/status` is ok → console shows the character → DM gets a reply →
@-mention gets a reply → emotion values are moving.

**If any item fails, stop and debug. Do not skip.**

### 7. Handover

Tell the user three things:
1. her name, where the character card is, and when edits take effect;
2. the daily cost (`socialV2.tokenGuard.maxDailyCostCNY`, default ¥15) and where to change it;
3. how to back up (`state/` + `roles/` + `config.json`) and how to uninstall (`node scripts/uninstall.mjs`).

## When you see these, do not improvise

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| bridge up but `dshReady:false` | DSH restarted on a new port | restart the bridge; check `state/bridge-supervisor.log` |
| DMs get no reply | not in `allow.private`, or SnowLuma offline | check config, check `get_login_info` |
| @-mentions ignored | group not in `allow.groups`, or preset missing | check config, rerun `setup-dsh.mjs`, restart DSH |
| console returns 401 | wrong token | `cat state/console-token`, use `?token=` |
| she never speaks | wake budget exhausted, or asleep at low patience | check the console's emotion page and `state/mood.json` |
| `Cannot find module '@deepseek-ai/schemastery'` | plugin installed before dependencies | `npm install` again, reinstall the plugin, restart DSH |

More: `docs/TROUBLESHOOTING.md`.
