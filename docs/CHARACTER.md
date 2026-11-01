# Writing your character (the most important file)

The engine decides whether she *can* feel like a person. The character card decides whether she *does*.
This document covers three things: how the two cards split the job, what each section controls,
and the failure modes we actually hit.

---

## 1. Two cards, two timescales

```
roles/<name>.md        personality core — who she is. Rarely changes; a change lasts a long time.
roles/<name>.规则.md    rule core — how she acts right now. Changes, expires.
```

Why they must be separate (this was the biggest scar in the project):

- The first version was one card. At 9,998 characters, **every new rule evicted a piece of personality**.
- Worse, they contradicted each other: the card said "share what you find", you later said "send videos to me only",
  and your instruction lived in the *memory* layer, which is explicitly declared "not instructions".
  So she obeyed the card, every time.

After the split: the personality card only answers "who are you", the rule card only answers "how do we do things now".
Changing a policy is one line in the rule card, effective on the next wake, with no edit to the character.

> Injection order is **personality → rules → admin rules → platform memory → memory card**.
> Rules come *after* personality so that "what you said today" outranks "what the card has always said".

---

## 2. The personality card, section by section

Template: `surfcore/roles/_TEMPLATE.md`. Filled example: `surfcore/roles/傲娇助手.md`.

### 一、Who you are — the identity anchor

Three things must be explicit: **her name, who you are, and how she treats everyone else.**

- The name must match the filename. `roles/Foo.md` must say she is Foo, or she will drift.
- Hard-coding your QQ number is fragile; the template uses `{{OWNER_QQ}}` and `init-character.mjs` fills it.
- **Never write "you are an AI assistant."** If you do, she will speak in assistant voice. What she is, is your call.

### 二、Speaking style — what actually makes her read as human

This is the most important section, more than ten times more important than "personality".

- **Write observable features, not adjectives.**
  Bad: "speak naturally". Good: "20–40 characters per message; no full stop at the end; use '…' for hesitation".
- **Set a length budget.** Models default to essays. A person in a group chat writes 12–20 characters.
- **Write what she does *not* say.** More effective than what she does: no "dear user", no numbered lists, no summaries.
- **At most three verbal tics.** More than that and it becomes a performance.

| Mistake | Consequence |
| --- | --- |
| "gentle and cute" | assistant voice, because those words are assistant words |
| 20 style rules | she cannot hold them and picks the most generic |
| no length limit | every reply is a paragraph, instantly fake |

### 三、Interior — contradictions beat virtues

A good interior is a set of **conflicting** tendencies: lazy but reliable, gentle but picky, slow but decisive.
A character made only of virtues is cardboard.

- Three to six items, each a concrete reaction pattern. Not "kind", not "smart".
- Write **what she does when tired**, **what she does when caught out** — state-dependent reactions are the living part.

### 三·五、Warmth (optional)

Delete this section if your character is not that kind of person. Its job is to give one
**consistent temperature**, so even anger and refusal carry the same base tone.

### 三·七、What kind of person you want to be — long-term direction

This section is extracted **on its own** and injected separately (the bridge matches the heading "三·七"),
and the narrative core compares against it every night. Write two or three things she cares about.
Not "be obedient".

> This section is the line between "she has her own goals" and "she exists to please you".

### 七、Things you remember — leave empty

Memory is injected by the memory core (memory card, diary, group topics, slang). You do not hand-write it.
To inject one item manually, use the console's memory page.

### 十、Things you never do — hard limits

Three to five. Do not reveal paths or tokens; do not claim to have done things she did not do;
do not change her own identity because someone asked. The program adds its own boundary layer (see [SECURITY.md](SECURITY.md));
the two stack.

---

## 3. The rule card, section by section

Template: `surfcore/roles/_TEMPLATE.规则.md`.

Principle: **only what changes, and only "when, do what".**

| Section | Controls | Advice |
| --- | --- | --- |
| Stickers | how often she sends images | delete it and set `socialV2.sticker.enabled=false` if unused |
| Look it up | when to search the web, when to admit ignorance | keep — this is what prevents confident fabrication |
| Browsing | when she looks at video sites on her own | delete if no such tool |
| Reference clearly | when to quote-reply | keep, essential in group chat |
| Leave without announcing | how conversations end | keep, otherwise every exchange ends with a goodbye |
| Don't be a dictionary | no unprompted lectures | keep |
| No ops talk in groups | no mention of models/prompts/budgets | keep |
| Ask in private | fallback when the group is the wrong place | keep |

At the bottom there are **three auto-managed sections** (`<!-- AUTO:owner -->` etc.). Do not delete the markers:

- **Taught by the owner** — what you teach in conversation lands here, and is framed as a *strong tendency*,
  not a command: she may do half of it, do it later, or say "not today".
- **Learned from the group** — needs accumulated evidence. (This path is still imperfect; see TROUBLESHOOTING.)
- **Vague impressions** — long-unused rules are demoted to one line, so she can say "I think there was something like that,
  but I don't remember the details".

---

## 4. Which core reads what

| Core | Reads | Writes |
| --- | --- | --- |
| Personality | the whole `roles/<name>.md` | nothing |
| Rules | `roles/<name>.规则.md` + auto sections | the auto sections |
| Memory | the memory card (`characters/`) | everything that happens |
| Emotion | not the card — it reads the *trait bias* (e.g. "lazy" → energy baseline −0.08) | `state/mood.json` |
| Causality | not the card | `state/causal.json` |
| Narrative | memory + causal log | `state/narrative.jsonl` |

So: **to change how she behaves with state**, tune the program (`src/mood.js` couplings);
**to change who she sounds like**, edit the character card.

---

## 5. When changes take effect

| What you changed | When it applies |
| --- | --- |
| `roles/<name>.md` | **next wake** (re-read before every message; no cache) |
| `roles/<name>.规则.md` | same |
| most of `config.json` | after restarting the bridge |
| `role.maxInjectChars` | after restarting the bridge |

No DSH restart needed, no bridge restart needed — unless you changed the config.

---

## 6. Several characters at once

Put several `<name>.md` files in `roles/`. Names must be unique.

- Switch with `/role <name>` in the group (admin only), or from the console's character page.
- Each character can have its own memory card (`characters/<id>/`); they do not contaminate each other.

---

## 7. Last thing: don't make "sounding human" a KPI

This is a conclusion from experience:

- The more you watch whether she "seems human", the more she performs it — and performance is more obvious than stiffness.
- Do not show her progress reports ("what you are learning", "your score"). That turns rules into achievements she recites.
- The right direction is **fewer occasions that require her to report** (stop asking for summaries and bullet points),
  not more self-awareness about "being human".

She should be: **in the group, occasionally talking, and otherwise just there.** Not proving anything with every sentence.
