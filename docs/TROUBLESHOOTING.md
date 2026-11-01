# Troubleshooting

Look up by **symptom**, not by error text — there are only a handful of symptoms.
Logs first: `surfcore/state/bridge.log` (recent) and `state/bridge-supervisor.log` (the supervisor).

---

## 1. Installation

**`Cannot find module '@deepseek-ai/schemastery'`**
Wrong order: dependencies must be installed before the plugin.

```bash
npm install
node scripts/setup-dsh.mjs
```

**SurfCore does not appear in Settings**
1. Did `setup-dsh.mjs` error?
2. Did you restart DSH?
3. Press F5 (the plugin list is a snapshot from page load).

**`Cannot use import statement outside a module`**
Node is too old. `node -v` must be ≥ 22.13. Do not use the Node bundled with an IDE.

---

## 2. It runs but she never speaks

Check in this order — most problems are the first item.

**① Is the bridge connected to SnowLuma?**

```bash
curl -H "x-console-token: $(cat state/console-token)" http://127.0.0.1:3100/api/status
```

Look at `snowlumaConnected`. `false` → is SnowLuma running? Is `wsUrl` right? Is the token right?

**② Is she connected to DSH?**

Same response, `dshReady`. `false` → **DSH restarted and the port changed**; the bridge is still on the old one.
Restart the bridge (`bridge-supervisor.sh` rediscovers the port).

**③ Is the group whitelisted?**

`allow.groups` / `allow.private`. Messages from sessions that are not listed **never reach the model** —
not "read but ignored", simply dropped. The symptom is total silence.

**④ Is the wake budget exhausted?**

```bash
tail -50 state/bridge.log | grep -iE 'quota|budget|wake'
cat state/mood.json          # asleep flag and the five values
```

Defaults: 80 group wakes/day, 120 private, ¥15/day. When exhausted she stays quiet until midnight.

**⑤ Is she asleep?**

Patience < 0.08 or energy < 0.12 puts her to sleep for a random 40–90 minutes (`asleep: true` in `mood.json`).
Only @-mention, name, question, DM or the diary slot wakes her.

---

## 3. She replies, but sounds wrong

| Symptom | Cause | Fix |
| --- | --- | --- |
| every reply is long | no length constraint in the card | `roles/<name>.md` → speaking style |
| bullet lists, summaries | too many "report to me" occasions | stop asking for summaries; check the rule card |
| always the same opener | too many verbal tics, or repetitive memory | remove tics, trim memory |
| assistant voice | the card uses words like "gentle", "professional" | rewrite with observable features |
| silent in groups | low wake probability, or low mood | `socialV2.wake.recommendedProbability`, or check emotion |

**Root fix**: rewrite the "speaking style" section per [CHARACTER.md](CHARACTER.md). That beats any parameter tuning.

---

## 4. Emotion behaves badly

| Symptom | Cause | Fix |
| --- | --- | --- |
| values never move | tick not running (bridge down) | check `uptime` in `/api/status` |
| a value pinned at 0 or 1 | rate parameter pushed to an extreme | adjust decay/recovery in `src/mood.js`, restart |
| always asleep | baselines too low | `energyBaseline` or sleep thresholds in `mood.js` |
| social pinned at the ceiling | recovery rate too high | cap 0.95 already; lower the recovery rate further |

> Rate parameters slide from one extreme to the other. After changing one, **let it run two hours** before judging.

---

## 5. Memory

- **She forgets what was just said** — is `characters/current.json` pointing at the right character?
  Check whether `~/.dsh/surfcore/characters/<id>/memory/` is being written.
- **Context too large** — the memory block is capped (default 4,313 chars). Lower `role.maxInjectChars`.
- **She attributes someone else's memory to herself** — a prompt-assembly bug; check the ownership fields in the memory card.

---

## 6. She talks too much / never initiates

| Direction | Knob |
| --- | --- |
| too often | lower `socialV2.wake.recommendedProbability`; lower `tokenGuard.maxWakesPerDay` |
| never initiates | check `drive` in `state/drive.json`; the threshold is 0.62 |
| initiates only in DMs | group initiative needs a quiet group **and** drive above the threshold |

---

## 7. Ports and console

| Symptom | Fix |
| --- | --- |
| console 401 | `cat state/console-token`, open `?token=` |
| 3100 in use | `lsof -i:3100` (mac) / `netstat -ano \| findstr :3100` (win), kill the old process |
| 3000 in use | change SnowLuma's port, or `snowluma.httpUrl` |
| blank page | check the browser console; usually a missing token |

---

## 8. Starting over

```bash
# keep character and memory, reinstall dependencies and plugin
rm -rf node_modules && npm install
node scripts/setup-dsh.mjs

# clear runtime state only (loses emotion/causal/logs)
rm -rf state/*

# full reset (character and memory gone — back up first)
cp -r roles ~/roles.bak
rm -rf state ~/.dsh/surfcore/characters
```

If you still cannot fix it, gather three things before asking for help: `node -v`,
`config.json` (**remove the token first**), and the last 50 lines of `state/bridge.log`.
