# Release notes: how this package was sanitised

Written for **anyone who redistributes it**, and for our future selves: what was removed, on what grounds,
and how to re-verify.

---

## 0. Version 1.4.0 (2026-11-18)

**yourDaughter 1.4.0 — she checks the sentence before she says it.**

### A check before speaking

`sendMessagesV2` now runs every group message through a local `fishtalk` checker before it leaves the
bridge. The tool is external and **not bundled**: it is a read-only, zero-dependency Node CLI
(`npm i -g github:Nozzi2455/fishtalk`) that answers four questions — is this a stock fish-bot phrase
("这条我认", "我记下了"), is it AI-speak ("不是 A 而是 B", "本质上"), is it at least 60 % identical to
something she has said before, and is it copied verbatim from the corpus (6–10 consecutive
characters). A hard hit throws, so she has to rewrite; soft notes only go to the log.

Three details make it safe to run on every send:

- **Only `group:` conversations are checked.** Private chat is one-to-one and never blocked, matching
  the existing voice-trim and repeat gates.
- **Same sentence, 60-second exemption.** A blocked `(conversation, text)` pair is remembered; the
  second attempt within a minute goes through untouched. Two rewrites and the message is sent — a
  false positive can delay a sentence but never silence her.
- **The binary is resolved once at startup.** Config override (`socialV2.fishtalk.command`) → the
  directory of the running `node` → `/opt/homebrew/bin` → `/usr/local/bin` → `~/.npm-global/bin` →
  `/usr/bin` → `which`/`where`. Nothing found means the feature reports `skip` and nothing changes.
  The check is awaited, but a synchronous placeholder is taken on the send chain first, so an async
  check can never let a later sticker or voice message overtake the text that preceded it.

### From blocked hits to a language hint

`state/fishtalk-stats.json` records `total` / `blocked` / per-problem counters and the last 200 blocked
sentences. `fishtalkStatsLine()` turns it into at most one short line a day: once there are at least
three blocks in seven days, she is told the top three problems **and what the concrete rewrite is**
("say it plainly", "say it your own way") — phrased as a style hint inside the language module, never
written into the memory card.

### Voice turns that stay out of QQ

When the voice lab starts a spoken turn it sets a `voice-active` marker (60 s). While it is live:

- every QQ send path refuses with a readable error (text, voice, and the operator endpoints);
- a DSH turn started under the marker is flagged, so its end does not fall into the "no action" QQ
  fallback and its reply is not replayed to QQ;
- `GET /api/socialV2/voice-context` hands the voice pipeline the same language-module line, causal
  line and mood snapshot the QQ prompt gets, plus `GET /api/socialV2/session-id` for session reuse.

Speech also gets a conversation-level emotion lock: the same conversation keeps one emotion for 15
minutes, and sentences of ≤12 characters are not tagged "happy" (the tag over-amplified short lines
and consecutive sentences jumped between tones). Voice messages finally carry a `time` field, so they
no longer display as 08:00:00.

### Memory recall, two tiers

Recall used to require a "remember / last time / you said" keyword before it ran at all. It now runs
on every turn: the hot card is searched first, and when fewer than four hits come back, the full
archive is searched as well and merged in. The archive is read once and cached by file mtime. Keyword
matching dropped from ≥3 characters to ≥2 — Chinese keywords are mostly two characters, so the old
rule silently matched nothing. Empty result still means "inject nothing", so the change costs nothing
in the common case.

### Smaller fixes

- Thought TTL unified: 7 days for actionable items, 3 days otherwise (was 14 / 7); room goals 30 → 7
  days, because a two-week-old goal kept resurfacing.
- `speakerLine()` — the "the speaker is connected, you can just talk" choice — now appears in private
  chat only.
- Image descriptions may use the last 10 messages around the image as labels (comments before and
  after a picture are the best caption available), and later comments are no longer cut off.
- Rule decay no longer demotes a rule by character overlap. Candidates are written to
  `state/rules-decay-candidates.json` for a human/sub-agent to judge.
- The "Bilibili recommendations you already made" block is no longer injected every turn (it became
  an impression); the stale "you changed your name today" line is gone; the "things you have already
  told each other" block shows 4 lines instead of 8.
- A rollback note on `isOwner: true` for batched teaching is restored as a comment, so the next
  reader does not "fix" a flag that is deliberately true.

### Under the hood

109 files, **+1,259 / −526**. There is one main code cut (`bridge.js`), matching updates in `memory-card.js` (section budgets),
`nightly-audit.mjs` (doc-path filter) and `config.example.json` (the new `fishtalk` block); everything
else in the diff is the re-sanitisation pass described below. Four review passes on the fishtalk work (hard-coded path, ordering,
regression) landed as P0 fixes inside this cut.

### What's next

Teaching the checker more of her own dialect rather than more generic AI-speak rules; and moving the
remaining shadow mechanisms (rest replay, handoff, conflict ledger) into the live path.

### Sanitisation for 1.4.0

Every personal identifier was stripped again: character names and nicknames, QQ numbers, group
numbers, the LAN host, and the private assistant channel added upstream are all out of this cut. This time the
pass is stricter than 1.3.0 — the audit's Chinese-identifier greps (`release-audit.mjs` only looks at
paths, credentials and numeric ids) are covered by a separate full-repo grep that must return zero.
`scripts/release-audit.mjs` reports **0 high-severity findings**. See §1 below for how to verify.

---

## 0.0 Version 1.3.0 (2026-11-13)

**yourDaughter 1.3.0 — she remembers who said it, and knows when not to speak.**

### Memory that knows whose memory it is

A new attribution layer stamps every group-sourced record with its group and speaker before it enters her private context, and drops records whose speaker is unknown. `/api/memory/recall` returns the speaker; the prompt header says it plainly: what group members say is not what the owner said. In 1.2.0 that line arrived with no owner attached.

### Continuity without the noise

The first turn of every conversation now carries one real event from the last 48 hours: one line, 120 characters at most, once a day, stale after 30 minutes. Alongside it, rest replay offers a memory at least seven days old only after 20 quiet minutes, at most twice a day, and a write-back gate accepts only conclusions, decisions, pitfalls, preferences and agreements. Digest windows no longer file yesterday under today's date.

### Emotion with a soft ceiling

`patience` sat at exactly 0.85 for 408 consecutive samples: +0.60/hour recovery against a −0.015 penalty per request, under a hard cap. It now drifts to 0.72 right after she has been asked for something and 0.80 after two quiet hours; 0.85 is a lid that bleeds off at 0.4/hour. The first measured afternoon moved 0.822 → 0.806. The model ships as a pure module with an offline replay harness.

### A voice channel that knows when not to talk

A local TTS client with content-addressed caching, cache versioning and style inside the cache key — a *normal* request used to replay a cached *happy* clip. Failures return a readable error, so she types instead of claiming she spoke. On top, a voice-opportunity model: late night, low energy and short replies lower the odds; at most two a day; in groups only when the room is light (mood 0.65, social 0.6, her last line ≤12 characters).

### Rules and language that earn their place

Owner teaching now passes a gate — core, candidate pool, or discard. The core was compressed from 7,062 to 6,694 characters across four dry-run batches inside a 7,200-character budget. A slang loop replaces static top-18 injection with only words that appeared in recent messages (6 in use, 3 understood, 1,200 characters); a bracket-style self-check flags a 60 %-plus sentence-tail habit without rewriting a word.

### Boundaries that hold

Private wishes stopped appearing in group prompts (32 of 44 sampled group prompts carried one); reflections are filtered by origin; a private-conversation token used against a group returns 403 and an audit row unless the caller passes `crossKey`; per-group silence stops outbound messages without touching private chat; stickers are told apart from photos before waking her; an 8.79 MB image is downscaled to 598 KB before it reaches the model. Optional and unpackaged: a room-view route that hands her a 2 MB PNG of a 3D scene as private image context.

Under the hood: **134 files touched, 29 new modules, 40 new tests**, an injection audit that reads the delivered prompt rather than a preview, and a QQ transport inventory with an alert channel that does not depend on QQ.

### What's next

Wiring what is still in shadow — rest replay, handoff, the conflict ledger — and finishing the transport fallback, so the engine survives losing its QQ bridge.

### Sanitisation for 1.3.0

Character cards, personal memory and every personal identifier were stripped again from this cut; `scripts/release-audit.mjs` reports **0 high-severity findings**. See §1 below for how to verify.

---

## 0.1 Version 1.2.0 (2026-11-08)

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
