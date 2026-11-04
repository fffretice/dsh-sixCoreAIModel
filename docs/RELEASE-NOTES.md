# Release notes: how this package was sanitised

Written for **anyone who redistributes it**, and for our future selves: what was removed, on what grounds,
and how to re-verify.

---

## 0. Version 1.1.0 (2026-11-04)

Re-cut from the same deployment, three days later. Everything below in §1–§6 still holds; this section
only lists what changed **since 1.0.0**.

**New code that had to be checked**: prompt-injection shield, search memory, sticker semantics,
task/care mechanism, per-group quota distribution, nightly audit, `learn-ledger` teaching extraction,
plus the two agent presets that 1.0.0 accidentally left out (`surfcore/dsh/agent-presets/`).

**New leaks found and fixed in this pass** (all of them existed in 1.0.0):

| What | Where | Fix |
| --- | --- | --- |
| GitHub account of the original author | 39 places: clone URLs, update-check defaults, docs | replaced with `your-github`; you set your own |
| Real Windows username inside a UI hint | `plugins/surfcore/lib/client.js` | rewritten as "Windows usernames with special characters" |
| The bot's own QQ as a hard-coded fallback | `src/bridge.js` ×3 | falls back to empty; read from config |
| A group member's QQ + nickname as a prompt example | `src/bridge.js`, two test fixtures | `1000000005` / `群友A` |
| Two group names, used as comments | `src/token-guard.js`, `src/bridge.js` | generic "群 A / 群 B / 某个群" |
| Persona keywords baked into defaults | `FISH_RE`, `aiMention`, `mustReplyKeywords`, `recommendedKeywords` | read from `socialV2.interests`; defaults empty |
| Borrowed-voice character names | `OTHER_CHARACTER_NAMES` in bridge and pet-chat | `socialV2.identityGuard.forbiddenNames` |

**Also changed**: twelve new deep-dive docs (`MODULE-*`, `SUBSYSTEM-*`, `PURPOSE_OUTREACH`,
`DSH_020_ADAPTATION`, `CONSOLE-UI-TESTING`, `TOKEN_USAGE_CONSOLE`, `VERSIONS`). They are Chinese-only —
the top-level docs are still English-first. Their `file:line` references are a snapshot; line numbers drift.
Links into the dev-only documents (PITFALLS / ROADMAP / HANDOFF / RISK_REGISTER / cases) were rewritten
into plain text so nothing points at a missing file.

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
MAC addresses and emails. **Current result: high 0 / mid 246 / low 2.** All mid hits are test fixtures and
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
