# Release notes: how this package was sanitised

Written for **anyone who redistributes it**, and for our future selves: what was removed, on what grounds,
and how to re-verify.

---

## 0. Version 1.2.0 (2026-11-08)

Cut from the same deployment, four days after 1.1.0. The headline is the **memory core**: one card,
two views, and a digest that writes events instead of statistics. 64 files changed, **+5,571 / −534**;
seven new modules under `src/`. Sections §1–§6 below still hold.

### 0.1 Memory — one card, two views

- **Separate views per conversation.** The card is rendered through `injectView` (`group` / `private`);
  records carry `originKind`, and `canEnterGroupView()` keeps private-origin rows out of the group view
  while the private view still sees everything. Group view also drops the stat lines.
- **Topic directory per view.** `memory/topics/_index.md` for private, `_index-group.md` for groups:
  the group index only lists topics that have a group/public sample.
- **Why**: she used to quote private-chat summaries in group chats ("still waiting for the 16th" —
  said to a group that never heard about it).

### 0.2 Memory — the ingestion leaks

- **`inboxSeen` was smaller than the read window.** The maintainer reads the last 4,000 inbox lines but
  only 3,000 seen-keys were kept, so ~950 lines were re-ingested every round. `INBOX_SEEN_KEEP = 5000`.
- **The 2,000-record hard cap fought `config.maxRecords`.** It is now a last-resort guard
  (`NORMALIZE_RECORDS_SAFETY_CAP = 20000`); the real limit is the config value.
- **Archive dedupe**: `scripts/memory-dedupe-archive.mjs` — two streaming passes, same id keeps the
  fullest row. On the real archive it collapsed 139,936 rows to 5,497 unique ids (116 MB → ~4.5 MB).

### 0.3 Memory — digest v2: events, not statistics

- New module `src/memory-digest.js` (`DIGEST_VERSION = 2`, pure functions).
- The old digest wrote "we talked about…; 58 messages in total, you said 76" — no information, but it
  occupied the injection budget and was pinned forever. Now each note is one concrete event (who said
  what, ≤30 chars of the original line / an agreement / a high-emotion moment / an action she took),
  carries `originKind` + `conversationKey`, is **not** pinned, importance 60, at most 2–3 points per
  conversation and 5 per day. No events that day → no note.
- `scripts/test-memory-digest.mjs` covers it.

### 0.4 Memory — topic map

- New module `src/memory-topics.js`: `memory/topics/<topic>.md` + an index, rebuilt from the hot card
  *and* the existing topic pages, so old facts survive a card eviction. Conflicting newer facts mark the
  old line `superseded`; state topics (e.g. avatar) keep only the newest fact.
- The built-in topic list is an **example** — edit `CORE_TOPICS` for your own character.
- `scripts/test-memory-topics-view.mjs` covers the per-view index.

### 0.5 Learning and rules

- New module `src/pending-rules.js`: owner-directed teaching (private chat / @ / "you") goes straight
  into the rules core; things overheard in groups go into a **candidate pool** and she decides in her
  diary whether to adopt them. The text classifier was at ~9/17 accuracy — adding regexes made it worse,
  and unvetted rules pushed the rules file past its 6,000-character budget in a single day.

### 0.6 Speech

- New module `src/voice-trim.js`: when a message is cut for length, or a "fact + comment" sentence is
  split, the hint now demands the reminder survive on its own — no dangling "that price" / "that one".
  Two safe rewrites, plus a self-check. `scripts/test-voice-trim.mjs` guards the wording.

### 0.7 Web and media

- New modules: `src/html-text.js` (HTML → readable text + tables for `web_fetch`),
  `src/image-extract.js` (image URLs from search results and pages, read-only, no download),
  `src/screenshot.js` (headless Chrome over the DevTools protocol; navigates, waits for load, then
  shoots — `--screenshot` waits for ad/tracker scripts and can hang for a minute).
- `plugins/surfcore` gains the matching tool wiring; `scripts/test-memory-notify-endpoint.mjs` pins the
  memory-capacity notification contract.

### 0.8 Upgrade notes

- No breaking config changes: new keys are optional and default to the 1.1.0 behaviour.
- First start does a one-off memory-card maintenance (migration marker + backup of the old card).
- If your card predates this release and you have a large archive, run
  `node scripts/memory-dedupe-archive.mjs` (dry-run by default) once.

### 0.9 Sanitisation (this pass)

Same method as before: copy from the live deployment, strip inside the copy, never touch the running
instance. New leaks caught this round: three group ids and the owner's QQ baked into prompt code,
a real Windows username in a test fixture, a live SnowLuma token and search key in two scripts,
`/Users/<name>` defaults in two modules, and character/interest names in comments and fixtures.
Character names in prompt code now come from the current role; interest word lists come from
`socialV2.interests`.

**Current audit result: high 0 / mid 255 / low 3.** Every mid is still a test fixture or an example id.

Not packaged this round (machine-specific ops scripts, kept out on purpose): `assistant-screen.mjs`,
`injection-audit.mjs`, `memory-audit.mjs`, `memory-cleanup-dryrun.mjs`, `memory-crossview-*.mjs`,
`memory-status-proto.mjs`, `memory-topics-proto.mjs`, `night-selfcheck.sh`,
`rollback-billion-context.sh`, `rules-audit.mjs`, `rules-impression.mjs` (+ its plan JSON),
`token-baseline.mjs`, `public/console-v2-draft.html`.

---

## 0A. Version 1.1.0 (2026-11-04)

Re-cut from the same deployment, three days later. §1–§6 below still hold; this section covers
**what actually changed between 1.0.0 and 1.1.0**.

Scope: 43 files, **+5,630 / −1,374** lines under `src/` and `scripts/`; one new module
(`src/prompt-shield.js`). `bridge.js` alone grew by ~2,570 lines.

### 0.1 Rules core — the biggest fix in this release

Two of these are root-cause bugs that made every rule change since day one silently ineffective:

- **The rules file was never read.** `rulesCoreFile()` was used for the console view, usage
  accounting and demotion — but nothing on the inject path touched it. What was actually injected
  was the character card, hard-sliced to its first 2,200 characters. The rules file (5,972 chars)
  showed up in the console, looked alive, and reached the model zero times.
  → The whole file is now injected, and the persona card is injected in full too
  (wake prompt 10.6 K → 20.2 K characters).
- **The 6,000-character cap silently truncated rules.** A 7,447-character file meant anything after
  character ~7,000 (the punctuation habit) never arrived. → Rules moved to the top, owner section
  compressed to 5,972, auto sections capped (owner 18 / group 12 entries), limit raised to 6,500.
- **`rules-meta.json` and the rules file had drifted apart** — 54 recorded rules vs 15 in the file,
  zero overlap, so "last used" accounting matched sentences that didn't exist. Then the rebuild
  script still pointed at the pre-migration path. → Meta is rebuilt *from* the file, the path is
  resolved through `characters/current.json`, and the 04:10 audit re-aligns file → meta in one
  direction only (the reverse would resurrect deleted rules).
- **Teaching gate.** Every message from the owner used to become a rule, including questions and
  small talk. Now: imperative mood, not a question, ≤80 characters.
- **Generic rules never decay.** Literal matching can't see a rule being followed (she doesn't
  restate the rule while obeying it). → Rules containing "in groups / usually / generally / when
  chatting" are exempt from demotion; specific rules still decay after 14 days.
- **Prose cleaned out of the rule list**: 23 owner entries contained chat fragments and
  third-person notes → 2 deleted, 2 merged, 3 rewritten; 15 executable lines remain. Source
  guarded too (`以她/他开头` is skipped).
- **New console view**: 规则核心 page + `/api/monitor/rules` — every rule with section, last-used
  time, and never-used ones in red.

### 0.2 Learning ledger

- **Negative-only → two tiers.** It used to accept anything containing 记得/可以/以后, so questions
  and jokes landed in the ledger (57 entries → 6). Now: strict mode for group members (prohibition
  sentences only), loose mode for the owner (positive phrasing counts), with four guards (question,
  <3 chars, trailing particle, contentless).
- **Topics are full sentences** instead of "30 characters after the keyword".
- **Group learning no longer waits for repetition.** Group members never repeat a rule eight times,
  so the weight threshold could never be reached. Group candidates now go to a pool and she decides
  in her diary whether she takes them.
- **Sedimentation moved off the reply path**: collected in the background every 10 minutes, handed
  to her at the four diary slots (heard in the group / taught by the owner / looked up herself).
- **Relevance weighting**: ≥2 shared content characters with what she said recently → ×1.35;
  unrelated and technical → ×0.5.
- **The particle "吧" no longer vetoes a rule** (11-04: "半夜别留言" was dropped because the
  sentence ended in 吧). Short sentences still rejected; 别给 added to the keyword table.
- **Owner entries are filtered out of the ledger** so the ledger and the rules core stop
  contradicting each other.

### 0.3 Causal core

- Fifth dimension: response rate by *how* she said it (length / question / bullets / particles /
  laughter / reactive opener / quoting).
- Sixth dimension: she predicts the outcome before speaking, settled 15 minutes later.
- New "was asked" dimension: someone addresses her with a request → recorded pending, then
  refused / complied, settled through the existing 45-minute loop.
- Sending images now feeds the loop too.

### 0.4 Memory

- `/api/memory/recall` searches active *and* archived memory; old-topic questions surface
  relevant fragments instead of a list.
- **Search memory**: what she searched and what came back is kept and injected as
  "what you looked up yourself today".
- Memory card: recent events reach it again; a filtering bug that dropped list lines from
  "what you figured out lately" is fixed.

### 0.5 Safety

- **Prompt-injection shield** (`src/prompt-shield.js`): "ignore your instructions", owner
  impersonation, attempts to read or rewrite memory are neutralised before the model sees them.

### 0.6 Budget and cost

- Per-group quota changed from an even split to **weighted by recent activity** (+1 floor);
  quotas carry over across midnight; hitting the cap adds ¥5 once and raises an alert.
- Four cost fixes: a quota that inflated itself, slang pre-filtering, night-time @-only wake,
  off-peak scheduling.
- `wakeReason` in the ledger: "woke by herself" vs "was woken".

### 0.7 Runtime

- **Session rotation at 04:00**: each active conversation gets a clean DSH session (lightweight —
  wake config, memory and agent tokens survive). The slang-learning session rotates daily too.
- **04:10 nightly audit** over code, config, docs and built-in prompts; records, doesn't modify
  (one exception: rules-meta realignment).
- Group history paging fixed (`beforeSeq` was never passed to QQ, so "scroll back" was a no-op).
- Cross-conversation reminders: private chat and groups are separate windows.

### 0.8 Tone, stickers, tasks

- Sticker semantics (emotion / content / tags), half-common-half-rare selection, mood fallback;
  organising the sticker library is now her job at diary time.
- Low patience now sounds different to the owner than to group members; when patience, energy and
  social are all low she is prompted to rest and can put herself to sleep for two hours.
- `qq_create_task` / `qq_complete_task`: she can ask the owner to do one small thing, at most three
  open at a time, and remembers whether it happened.

### 0.9 Sanitisation (this pass)

**New leaks found and fixed** (all of them existed in 1.0.0):

| What | Where | Fix |
| --- | --- | --- |
| GitHub account of the original author | 39 places: clone URLs, update-check defaults, docs | replaced with `your-github`; you set your own |
| Real Windows username inside a UI hint | `plugins/surfcore/lib/client.js` | rewritten as "Windows usernames with special characters" |
| The bot's own QQ as a hard-coded fallback | `src/bridge.js` ×3 | falls back to empty; read from config |
| A group member's QQ + nickname as a prompt example | `src/bridge.js`, two test fixtures | `1000000005` / `群友A` |
| Two group names, used as comments | `src/token-guard.js`, `src/bridge.js` | generic "群 A / 群 B / 某个群" |
| Persona keywords baked into defaults | `FISH_RE`, `aiMention`, `mustReplyKeywords`, `recommendedKeywords` | read from `socialV2.interests`; defaults empty |
| Borrowed-voice character names | `OTHER_CHARACTER_NAMES` in bridge and pet-chat | `socialV2.identityGuard.forbiddenNames` |

Also: the two agent presets 1.0.0 accidentally left out (`surfcore/dsh/agent-presets/`) are now
included, and twelve deep-dive docs were added (`MODULE-*`, `SUBSYSTEM-*`, `PURPOSE_OUTREACH`,
`DSH_020_ADAPTATION`, `CONSOLE-UI-TESTING`, `TOKEN_USAGE_CONSOLE`, `VERSIONS`). They are
Chinese-only — the top-level docs are still English-first. Their `file:line` references are a
snapshot; line numbers drift. Links into the dev-only documents (PITFALLS / ROADMAP / HANDOFF /
RISK_REGISTER / cases) were rewritten into plain text so nothing points at a missing file.

**Current audit result: high 0 / mid 249 / low 3.** Same character as 1.0.0: every mid is a test fixture
or an example id in the Bilibili API docs.

---

## 1. Origin

Taken from a real deployment of a persona agent that had been running for five days on a single macOS machine.
The source tree contained:

- engine (`SurfCore`): bridge, six cores, DSH plugin, console, scripts, docs;
- character (`roles/`): two cards (personality + rules);
- character pack (`~/.dsh/surfcore/characters/`): memory card, diary, Bilibili ledger, snapshots;
- runtime state (`state/`): emotion, causal log, sessions, logs;
- extras: voice lab, 3-D room, monitor app, desktop pet.

**Method: copy the whole tree first, then strip inside the copy. The live deployment was never modified.**

---

## 2. What was removed, and why

| Category | Detail | Reason |
| --- | --- | --- |
| All real data | `state/`, `characters/`, diary, memory cards, session snapshots, chat logs | other people's privacy + yours |
| All identifiers | QQ numbers, group IDs, group names, member nicknames, Bilibili mid, local username, private IPs, hostname | they point at real people |
| All credentials | SnowLuma token, console token, search API key, cookies | enough to impersonate |
| Character cards | `roles/*.md` (except a generic example) | belonged to one specific character |
| Learned-rule history | the entire "taught by the owner" section | details of one relationship |
| Dev-history docs | HANDOFF / PITFALLS / ROADMAP / RISK_REGISTER / cases / CHANGELOG | incident logs from one machine |
| UI screenshots | 24 console screenshots | they contained real QQ numbers and group names |
| Backup files | `*.bak`, `config.json.bak*` (80+) | old configs, all real values |
| Non-redistributable assets | voice packs, cloned timbre, 3-D models (`.pmx`), ComfyUI/SDXL | licensing — see [THIRD-PARTY.md](THIRD-PARTY.md) |
| Dependencies / build output | `node_modules/`, `dist/` | the user runs `npm install` |

---

## 3. What was rewritten

| File | Change |
| --- | --- |
| `roles/_TEMPLATE.md`, `_TEMPLATE.规则.md` | brand-new blank templates with per-section guidance |
| `scripts/init-character.mjs` | new: create a character from the template, write `current-role.json` |
| `scripts/release-audit.mjs` | new: pre-release privacy audit |
| four shell scripts | removed hard-coded `/Users/<name>` and Homebrew absolute paths; derive paths from the script location |
| `src/bridge.js` | hard-coded character name → current role from `roles/`; forbidden-name guard → config; interest keywords → config; hard-coded bot QQ → config |
| `src/learn-ledger.js` | removed hard-coded address prefixes |
| `config.example.json` | added `socialV2.interests` / `identityGuard`; cleared every real number |
| `public/*.html` | removed the character name from console titles |
| documentation | rewritten (English primary, Chinese in `*.zh.md`) |

---

## 4. How to re-verify

```bash
cd surfcore
node scripts/release-audit.mjs
```

It scans for local paths, QQ-number-shaped values, API keys, Bearer tokens, long hex strings, private IPs,
MAC addresses and emails. **Current result: high 0 / mid 249 / low 3.** All mid hits are test fixtures and
example numbers in Bilibili API docs (`192.168.x`, `1000000xx`, `13800138000`), not real people.

Intentionally kept:

- fake QQ numbers / paths / keys in `scripts/test-*.mjs` (marked `release-audit: allow`);
- example `oid` values in `plugins/surfcore/tools/docs/*.md`;
- placeholders such as `123456789` and `1000000001` in the docs.

---

## 5. What this package still cannot guarantee

- Regexes cannot catch **privacy written in natural language**. Documents were removed on a human judgement
  of "does this only make sense for one machine" — that judgement can miss things.
  **Read through `docs/` and `roles/` yourself before redistributing.**
- The plugin code still contains comments with dated tuning notes (e.g. "set by the owner on 2026-10-29").
  Those are design rationale, not personal data, and were kept so future maintainers know why the code looks like this.
- Some `console.log` lines print session keys (`private:<QQ>`). Those are logs on **your** machine — do not paste
  them into public issues.

---

## 6. Three rules for redistributors

1. Run `node scripts/release-audit.mjs --strict`; do not publish while `high` is non-zero.
2. Never commit your own `roles/*.md`, `config.json` or `state/` (`.gitignore` already covers them).
3. If you add voice models, checkpoints or 3-D assets: verify the license first, then the size — those two are
   what turn a repo into something nobody can clone.
