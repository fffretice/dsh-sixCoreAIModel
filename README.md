# dsh-sixCoreAIModel

> A persona agent that lives in a QQ group — built on six coupled cores.
> Personality, rules, memory, emotion, causality and narrative, plus the mechanisms that
> turn a chat model into someone who is *continuously there* instead of answering on demand.

[中文文档](README.zh.md) · [Install](INSTALL.md) · [Character authoring](docs/CHARACTER.md) · [Windows guide](docs/INSTALL-Windows.md) · [macOS guide](docs/INSTALL-macOS.md)

This is not another "LLM wired to a chat app" framework. It gives the model an identity,
a memory that forgets, a circadian rhythm, and two hands (QQ + Bilibili) — and it makes
all of those things **interact**, so behaviour changes with state instead of being executed.

Current release: **1.1.0**.

## What's new in 1.1

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
