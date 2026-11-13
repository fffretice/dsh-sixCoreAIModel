# Automation: session rotation, hourly self-check, and DSH sub-agents

This page documents the **runtime automation** that turns a static prompt into someone who keeps
showing up: the daily session rotation, the daily memory digest, the hourly self-check, and how to run
the whole thing with DSH Agent Teams (a Lead session plus sub-agents).

If you only installed the engine and connected QQ, none of this runs yet. It is cheap to set up and
it is the difference between "a bot that answers" and "a character that maintains herself".

---

## 1. What runs automatically, and who runs it

| Time (local) | Task | Runs inside | Touches |
|---|---|---|---|
| **04:00** | Session rotation — one fresh DSH conversation per chat | **bridge.js** | `state/session-rotate.json`, memory card, first-turn event |
| **05:30** | Memory digest — yesterday's chat compressed into 2–5 concrete events | **bridge.js** | `memory-inbox.jsonl` → `memory-card.json` → prompt files |
| **every hour :00** | Self-check — services, behaviour screen, rules small-fix, injection audit | **DSH scheduled task** | `state/selfcheck*.json`, `bridge.log`, screen scripts |
| **08:00** | Morning report — nightly audit, continuity check, rules big-clean, memory DB audit | **DSH scheduled task** | `nightly-audit/`, `rules-audit`, `memory-db-audit` |
| **22:00** | Three-line daily digest to the owner | **DSH scheduled task** | worklog + owner notify channel |

Two different hosts are involved, and that matters for troubleshooting:

- **Rotation and digest run inside `bridge.js`.** As long as the bridge process is alive they keep
  running even if DSH is closed. They write files, not messages.
- **Self-check / morning / daily run as DSH `schedule` tasks.** They are bound to the session that
  created them, they wake that session, and they stop existing if that session's schedule rows are
  deleted.

---

## 2. Setting up the DSH side

### Option A — one session, three reminders (simplest)

1. Open one DSH session and make it your "operator" session (the real deployment calls it the PM).
2. Create three reminders with the `schedule_create` tool:
   - `cron { expression: "0 * * * *" }` — hourly self-check
   - `daily { time: "08:00:00" }` — morning report
   - `daily { time: "22:00:00" }` — daily digest
3. Keep the instructions **in files**, not in the reminder text. Each reminder says one line:
   "read `pm/runbooks/hourly-selfcheck.md` and follow it". You edit the file, not the schedule.

Why files: reminder prompts are frozen at creation; runbooks change weekly. A 30-line reminder that
tries to describe the whole routine will be stale in two days.

### Option B — DSH Agent Teams (Lead + sub-agents)

The Lead session owns every schedule and every user-facing decision. Sub-agents are **workers, not
stations**:

- Typical split: `duty` (services/schedules), `bugfix` (behaviour/bridge failures), `mechanism`
  (emotion/drive/rules), `memory` (memory card/topics/retrieval), `tools` (rooms/voice/Bilibili),
  `accounting` (tokens/cost).
- The Lead creates a task on the shared board (`team_task_*`) **with a write scope**, then wakes the
  owner with `send_message`. One file has one writer.
- Cap is 8 members including the Lead. Names are permanent; open only what you need.

**What sub-agents cannot do:** they cannot hold schedules. A delegated session gets
`{"code":"subagent_session","message":"A delegated subagent cannot use reminders."}` — by design.
So the Lead keeps the clock; workers keep the hands.

**Waking pattern:** a sub-agent finishes a turn and goes idle; it does not poll. The Lead wakes it
with a message. For long tasks, make the worker write an `inflight.md` (what was done / exact next
step / how to verify) before it returns, then the Lead decides whether to wake it again.

### Cost note

Each sub-agent is a full session with its own context. Two workers doing read-only audits in parallel
is usually worth it; six permanent ones are not. Start with one session, add a worker only when a
task class repeats.

---

## 3. Data flow: who writes what

```
QQ message ──▶ bridge: append to memory-inbox.jsonl
                     │
        05:30 digest │  (bridge)
                     ▼
              memory-card.json ──▶ plugin host renders prompt files
                     │                     │
                     ▼                     ▼
            topic pages (memory/topics/)   prompt-qq.md / prompt-qq-group.md
                     │
                     ▼
          bridge injects the rendered prompt on wake-up

PM session (DSH): reads state files only, writes worklog / runbooks / task board.
                  It does NOT write the memory card.
```

Rules that keep this sane:

- **One writer per file.** The bridge writes the memory card; the plugin host renders prompts; the
  PM session only reads. If two processes must write the same file, add a cheap guard — this repo
  compares the file's mtime before writing and re-reads if it changed.
- **Backups are not the database.** The archive (`memory-card-full.jsonl`) is the database; the
  timestamped copies are rollback material. `scripts/memory-db-audit.mjs` proves the archive is
  complete and that backups are redundant.
- **Digest windows are explicit.** The 05:30 job writes "yesterday 00:00 → today 00:00"; it must not
  use "today" as the label for yesterday's events.

---

## 4. What the hourly self-check actually does

1. **Service health** — bridge port, DSH readiness, TTS service, QQ gateway. Fix what is fixable;
   never restart the QQ gateway container casually (it loses the login).
2. **Behaviour screen** — last 2h of group/private messages, looking for: private content quoted in a
   group (privacy), claiming not to remember something she does remember, wrong names/numbers, and
   mood pinned at an edge. Only confirmed items are reported.
3. **Rules small-fix** — garble and obvious duplicates only, at most 2 per hour, with a backup. The
   big clean is the 08:00 job; hourly must not become a rewriting session.
4. **Injection audit** — reads the *delivered* prompt (not a preview) and reports silently truncated
   blocks. Silent truncation is a bug; designed trims are not.
5. **Watchlist top 5** — the recurring issues the owner keeps asking about; one line each.
6. **Write one log line and stop.** No message unless P0. A quiet hour is a successful hour.

---

## 5. Rotation specifics

- `state/session-rotate.json` stores the date. The bridge rotates once after 04:00 and never twice
  the same day, even if it restarts.
- Rotation gives every conversation a fresh DSH session. **Memory card, topics, goals, mood and
  diaries survive**; only the raw conversation disappears.
- After rotation the first turn carries one real event from the last 48h (the first-turn event layer)
  so she does not wake up blank.
- The morning job verifies four things: all conversations rotated, first-turn event injected, digest
  wrote N events, topic index rebuilt.

---

## 6. Operational discipline (learned the hard way)

- **Alert levels:** P0 = service down / privacy leak / data loss (immediate); P1 = failed task, needs
  a decision (same hour); P2 = daily report. Proactive messages: ≤6/day unless P0.
- **Night is quiet:** 00:00–07:00 non-P0 wait for the 08:00 report.
- **Restart protocol:** bridge restarts are routine (backup → `node --check` → restart → verify).
  DSH restarts change every session; announce, finish in-flight writes, then restart.
- **Never hot-edit the bridge in place:** backup, patch, syntax-check, restart, verify, rollback plan.
- **Secrets stay in `config.json`** (and are never committed). The sanitisation audit in
  `docs/PRIVACY.md` is for distribution, not for your own deployment.
- **Approximate costs:** one wake-up is one full prompt; the hourly self-check costs a few thousand
  tokens per hour. If that is too much, run it every 2–3 hours instead — the bridge-side rotation
  and digest will keep working regardless.

---

## 7. Minimal setup checklist

1. Install the engine, write `config.json` (owner QQ, allowed groups).
2. Confirm the bridge starts: `node src/bridge.js` → console on `:3100` → `dshReady: true`.
3. Create one operator session and three reminders (hourly / 08:00 / 22:00).
4. Create an `pm/runbooks/` folder and write the three runbooks (self-check, morning, digest).
5. Optional: spawn 4–6 sub-agents with named roles and a shared task board.
6. Run one self-check manually and read the output; then wait for the first scheduled fire.
7. Watch the first full night: 04:00 rotation, 05:30 digest, 08:00 morning report.

Assumptions this page makes: bridge and DSH run on the same machine; the bridge reconnects when the
DSH web port changes; schedules are bound to the session that created them.
