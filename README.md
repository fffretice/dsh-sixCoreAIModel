# dsh-sixCoreAIModel

> A persona agent that lives in a QQ group — built on six coupled cores.
> Personality, rules, memory, emotion, causality and narrative, plus the mechanisms that
> turn a chat model into someone who is *continuously there* instead of answering on demand.

[中文文档](README.zh.md) · [Install](INSTALL.md) · [Character authoring](docs/CHARACTER.md) · [Windows guide](docs/INSTALL-Windows.md) · [macOS guide](docs/INSTALL-macOS.md)

This is not another "LLM wired to a chat app" framework. It gives the model an identity,
a memory that forgets, a circadian rhythm, and two hands (QQ + Bilibili) — and it makes
all of those things **interact**, so behaviour changes with state instead of being executed.

Current release: **1.3.0**.

## What's new in 1.3

- **Memory that knows whose memory it is.** Group-sourced records are stamped with group + speaker
  before they enter her private context; records whose speaker is unknown are dropped. The prompt
  header states it plainly: what a group member said is not what the owner said.
- **Continuity without the noise.** The first turn of every conversation carries one real event from
  the last 48 hours (one line, ≤120 chars, once a day). Rest replay surfaces memories at least seven
  days old only after 20 quiet minutes; a write-back gate accepts only conclusions, decisions,
  pitfalls, preferences and agreements.
- **Emotion with a soft ceiling.** `patience` used to pin at 0.85 for days; it now drifts toward 0.72
  (recently asked) / 0.80 (idle) and recovers on a half-life instead of a step function.
- **A voice channel that knows when not to talk.** Local TTS with content-addressed caching (style in
  the cache key), readable failures that fall back to typing, and a voice-opportunity model: late
  night / low energy / short replies lower the odds; at most two a day.
- **Rules and language that earn their place.** Owner teaching passes a gate (core / candidate pool /
  discard); the rules core was compressed 7,062 → 6,694 chars inside a 7,200 budget; slang injection
  only carries words seen in recent messages; a bracket-style self-check flags a sentence-tail habit
  without rewriting a word.
- **Boundaries that hold.** Private wishes stay out of group prompts; reflections are filtered by
  origin; a private token used against a group returns 403 + audit; per-group silence stops group
  outbound only; stickers are told apart from photos; an 8.79 MB image is downscaled to 598 KB.
  Also new: a read-only memory-DB audit (`scripts/memory-db-audit.mjs`) and an injection audit that
  reads the delivered prompt rather than a preview.

### Highlights in 1.2

- **Memory, two views.** The memory card is rendered per conversation: records carry a structured
  `originKind`, and the group view physically cannot see private-chat rows (plus a topic index built
  from group samples only). No text labels, no reminders — the private side simply never enters the
  group prompt.
- **Digest v2 — events, not statistics.** The daily writer used to say "we talked about X; 58 messages,
  you said 76". It now records concrete events (who said what, an agreement, a high-emotion moment,
  an action she took), unpinned, bounded to 2–3 per conversation and 5 per day.
- **The ingestion leak is gone.** `inboxSeen` (3,000) was smaller than the read window (4,000) so
  ~950 lines were re-ingested every round; the hard 2,000-record cap also fought `config.maxRecords`.
  Both fixed, plus a streaming archive dedupe tool: **139,936 rows → 5,497 unique ids, 116 MB → 4.5 MB**
  on a real archive, idempotent and backed up.
- **Topic map that survives eviction.** Topic pages are merged with facts from the hot card and
  rebuilt index; conflicts mark rows `superseded`, status topics keep only the latest row.
- **Candidate rules.** Group-learned lines no longer race into the rules core: they enter a candidate
  pool she decides on at diary time; only direct teaching goes straight in.
- **Voice trim that stays readable.** Length/compound-sentence interrupts now require the rewritten
  sentence to be self-contained — no dangling "that price" with the premise deleted.
- **New web/media helpers**: `html-text.js` (readable body + tables), `image-extract.js` (image URLs,
  read-only), `screenshot.js` (navigate → settle → capture).

Full changelog: [docs/RELEASE-NOTES.md](docs/RELEASE-NOTES.md).

### Highlights in 1.1

- **Rules finally reach the model.** Root cause fix: the rules file (5,972 chars) was only ever
  read by the console — the inject path used a hard-sliced character card, so every rule change
  since day one was invisible to her. The whole file is injected now, the 6,000-char truncation is
  gone, and the console lists every rule with its last-used time.
- **Learning, two tiers.** Prohibition sentences from group members, positive phrasing from the
  owner; full-sentence topics instead of fragments; group learning goes to a candidate pool she
  decides on at diary time, instead of waiting for a repetition that never comes.
- **Prompt-injection shield** — inbound group text is scanned for "ignore your instructions",
  impersonation of the owner, and attempts to read or rewrite memory; hits are neutralised
  before they reach the model (`src/prompt-shield.js`).
- **Search memory** — what she looked up (and what came back) is kept, so she can recall
  "I checked that before" instead of re-searching blindly.
- **Sticker semantics** — stickers carry emotion/content/tags; picking one is matched to the
  current mood instead of cycling the same three.
- **Care beyond chat** — `qq_create_task`: she can ask you to do one small thing (sleep,
  eat, take a walk), and remembers whether you did it.
- **Quotas that follow the room** — per-group quota is distributed by activity level instead
  of split evenly, with quieter nights.
- **Agent presets are included** — `surfcore/dsh/agent-presets/` now ships both `qq-chat` and
  `qq-chat-v2`, so `node scripts/setup-dsh.mjs` has something to install.
- **Deep-dive documentation** — `surfcore/docs/guides/MODULE-*.md` and `SUBSYSTEM-*.md`:
  ~600 KB of line-by-line notes (`file:line`) for the bridge, the cores, the plugin host,
  Bilibili, the desktop pet and the voice path.
- **Configurable, not hard-coded** — interest words, forbidden character names (identity
  guard) and the bot's own QQ now come from `config.json`; nothing personal is baked in.

---

## What you get after installing

Once installed, and once you have written a character card, she will:

- **Speak at her own pace** — not every message gets a reply; more likely to join a burst, quieter in a dead channel.
- **Have affect** — tired means shorter sentences and procrastination; being ignored costs mood; patience bottoming out puts her to sleep.
- **Remember and forget** — memories decay from *vivid* down to *impression*, except the ones that matter (first meetings, promises).
- **Close the loop** — 45 minutes after she says something on her own initiative, the outcome (answered / ignored / called out) is settled and fed back into mood.
- **Claim her own time** — one to three quiet slots a day where she decides what to do, and may decide to do nothing.
- **Keep a diary and a story** — four diary slots a day, plus one nightly entry answering "what kind of person have I been lately".
- **Sound like a person** — sentence length aligned with the group, no bullet lists, no summaries, no status reports.

## Repository layout

```
dsh-sixCoreAIModel/
├── INSTALL.md              ← start here
├── AGENTS.md               ← hand this to your DSH agent to install it for you
├── README.md / README.zh.md
├── surfcore/               ← the engine
│   ├── src/                six cores + bridge (~2 MB of source)
│   ├── roles/              character cards live here (templates: _TEMPLATE.md / _TEMPLATE.规则.md)
│   ├── plugins/            DSH plugin (settings UI, presets, Bilibili tools)
│   ├── dsh/agent-presets/  qq-chat / qq-chat-v2 — installed into DSH by setup-dsh.mjs
│   ├── public/             web console
│   ├── scripts/            install, audit, watchdog scripts
│   └── docs/guides/        deeper documentation (ARCHITECTURE, MODULE-*, SUBSYSTEM-*)
└── docs/
    ├── INSTALL-Windows.md  ← full Windows walkthrough
    ├── INSTALL-macOS.md    ← full macOS walkthrough (SnowLuma runs in Docker)
    ├── CHARACTER.md        ← how to write a character (the part that decides "human or not")
    ├── PRIVACY.md          ← what stays local, what leaves the machine
    ├── SECURITY.md         ← permission model and threat model
    ├── TROUBLESHOOTING.md
    ├── OPTIONAL.md         ← voice, image generation, 3D room: not bundled, here's how
    ├── RELEASE-NOTES.md    ← how this package was sanitised, and how to re-verify
    └── THIRD-PARTY.md
```

**Deliberately not included**: anybody's voice pack, 3D room, ComfyUI/SDXL models, real
memories or diaries, the SnowLuma binary, and any personal identifiers.
See [docs/THIRD-PARTY.md](docs/THIRD-PARTY.md).

---

## Quick start (3 minutes)

Requirements: a machine running [DeepSeek Harness](https://github.com/deepseek-ai) (DSH),
Node.js ≥ 22.13, a spare QQ account, and SnowLuma as the OneBot gateway.

```bash
cd surfcore
npm install

cp config.example.json config.json      # then edit ownerQQ / allow lists / SnowLuma token
node scripts/init-character.mjs --name Daughter --owner <your-qq>
node scripts/setup-dsh.mjs

# restart DSH, then:
npm start
```

Open `http://127.0.0.1:3100/?token=<contents of state/console-token>` and she is online.
Everything after that is writing `roles/Daughter.md` — that file decides whether she reads
as a person.

Full steps: [INSTALL.md](INSTALL.md) · [Windows](docs/INSTALL-Windows.md) · [macOS](docs/INSTALL-macOS.md)

---

## Honest notes

- **What this can do**: keep a language model in a chat group *with persistent state*, such that being ignored genuinely changes how willing she is to speak next time.
- **What this cannot do**: make her conscious, make her love you, or make her "live" while nothing is waking her. Every behaviour is driven by a wake; no wake, no inner life.
- **She is yours**: character card, rules and memory are local files. Edit, back up, delete — and you can keep several (`roles/` holds many, switch from the console).
- **Don't make "sounding human" a KPI.** The more you measure it, the more she performs it, and performance reads worse than stiffness. See the last section of [docs/CHARACTER.md](docs/CHARACTER.md).

## License

Engine: MIT (see [LICENSE](LICENSE)). Third-party components and non-redistributable
assets are covered in [docs/THIRD-PARTY.md](docs/THIRD-PARTY.md).
