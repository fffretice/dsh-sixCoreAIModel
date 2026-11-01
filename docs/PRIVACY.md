# Privacy: what she sees, and where the data goes

The risk with this class of project is not "the model steals your data". It is that things you thought
were said at home end up in a group, in a log, and in a context window. This document draws the lines.

---

## 1. Where the data lives

All local. No cloud account, no remote database:

| Data | Location | Contents |
| --- | --- | --- |
| Config | `surfcore/config.json` | QQ numbers, group IDs, tokens |
| Character | `surfcore/roles/*.md` | the personality and rules you wrote |
| Memory card | `~/.dsh/surfcore/characters/<id>/` | what she remembers, the diary, Bilibili ledger |
| Runtime state | `surfcore/state/` | emotion, drive, causal log, logs, conversation snapshots |
| Console token | `surfcore/state/console-token` | local console auth |

`state/` contains **raw conversation content** (recent messages in `social-v2.json`, lines in `bridge.log`).
That is what "she remembers what we were just talking about" costs — but it also means **backing up `state/`
is backing up your chat history**.

---

## 2. What leaves the machine

Only two things:

1. **Prompts sent to the model API.** On every wake the program assembles "personality card + rule card + memory
   excerpts + the last N messages + current affect" and sends it to whichever provider DSH is configured with.
   **Messages written by other people in the group go out as part of that context.** This is true of every cloud model.
2. **Messages she sends** (QQ group/DM; Bilibili comments or posts if you enabled them).

What never leaves: the files in `state/`, the cards in `roles/`, the logs, the console token, `config.json`.

> To keep everything local you would have to run the model locally too (e.g. Ollama). Quality drops noticeably.
> The default is a cloud API.

---

## 3. What she can see in a group

- Only whitelisted groups and DMs. Messages from other sessions are dropped **before** they reach the model.
- Images enter the visual context (`qq_get_message_images`), limited to the most recent few.
- **Merged/forwarded chat records** are readable (`qq_get_forward_msg`) — note that a forwarded log may contain
  content you did not intend to send to a model. This is the most commonly overlooked path.

## 4. What she can and cannot do

Hard boundaries are in [SECURITY.md](SECURITY.md). The privacy-relevant ones:

- **Cannot read local files** (the QQ-side preset mounts no file tools) and cannot execute commands.
- **Cannot send local paths out**: outbound text is scrubbed for paths and blocked on credential patterns.
- **Cannot send outside the whitelist.**
- Voice can only send files that already exist in the voice library, not arbitrary local files.

---

## 5. How to clean up

```bash
# runtime state only (keeps character and memory card)
rm -rf surfcore/state/*

# all memory of one character (irreversible)
rm -rf ~/.dsh/surfcore/characters/<id>/

# full reset
rm -rf surfcore/state ~/.dsh/surfcore/characters surfcore/config.json
```

Back up first (`cp -r`); deleting `state/` really deletes it.

---

## 6. What we did before publishing this repository

This repo went through a file-by-file sanitisation before release; the rules are in
`surfcore/scripts/privacy-rules.example.json`:

- removed all real data: memory cards, diaries, chat logs, session snapshots, backups, UI screenshots;
- removed all identifiers: QQ numbers, group IDs, nicknames, local usernames, private IPs, tokens and API keys;
- replaced the character cards with templates, and replaced hard-coded character names in code with config lookups;
- ran `node scripts/privacy-scan.mjs` and `node scripts/release-audit.mjs` over the tree.

**If you redistribute your own fork**, run the audit first and keep `state/`, `roles/` and `config.json`
in `.gitignore` (already done here).
