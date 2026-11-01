# Optional capabilities (not bundled — here is how to add them)

These are deliberately excluded: either the licensing is a problem, or they need extra models and a GPU,
or they are simply one person's private setup.

---

## 1. Voice

**Not included**: any voice pack, any trained timbre, GPT-SoVITS models, reference audio.

**Why**: cloning a voice involves the rights of the person behind it, and the models have their own licenses
(GPT-SoVITS is MIT, but the audio you feed it is not).

**How to add** (easy → hard):

| Option | What to do | Cost |
| --- | --- | --- |
| A. System TTS | macOS `say` / Windows SAPI | free, generic voice |
| B. Open-source TTS | run [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) or piper with **your own** or licensed audio | half a day + a GPU (CPU works, slow) |
| C. Cloud TTS | OpenAI / Azure / AliCloud speech APIs | pay per character, easiest |

Wire it in at `config.json → socialV2.voice` (`enabled`, `dir`, duration/rate limits); the endpoint lives in
`socialV2.voice.tts`. The bridge calls an OpenAI-compatible `/v1/audio/speech`, so any compatible service works.

> **Do not** clone a voice actor's, streamer's or VTuber's voice and publish it. Private experimentation is one
> thing; public distribution definitely gets you in trouble.

---

## 2. Image generation

**Not included**: ComfyUI, any SDXL checkpoint, any workflow.

**Why**: models are several GB and each has its own license (SDXL is CreativeML OpenRAIL++-M, with conditions
on commercial use). Shipping them in a code repo is neither compliant nor practical.

**How to add**:

1. install [ComfyUI](https://github.com/comfyanonymous/ComfyUI) and a portrait/anime checkpoint;
2. start it (default `http://127.0.0.1:8188`);
3. in `config.json`:

```jsonc
"socialV2": {
  "draw": {
    "enabled": true,
    "comfyUrl": "http://127.0.0.1:8188",
    "checkpoint": "your-model.safetensors",
    "dailyLimit": 3,
    "size": "832x832"
  }
}
```

4. restart the bridge. She uses `qq_draw_image`; the image is sent into the conversation.

**No GPU?** Set `draw.enabled` to `false`. She is not "dumber" without it — she just says she cannot draw.

---

## 3. 3-D room

**Not included**: the Three.js room, the MMD model, the desktop-pet shell.

**Why**: `.pmx` models carry explicit usage terms (most allow MMD videos only) and cannot be redistributed.

**If you want one**: build a viewer that reads `state/` — that is the whole data source.
`state/mood.json`, `state/drive.json` and `state/tool-calls.jsonl` are enough; map furniture to tool
categories using the call distribution in `tool-calls.jsonl`.

---

## 4. Bilibili

**Not included**: cookies, accounts, any login state.

**Why**: that is your account.

**How to add**: `config.json → biliBridge`, fill `self.mid` and the cookie. Read-only features
(watching, trending, comments) work partially without login. Write actions (like/comment/post) are off by default;
enable them yourself if you want, and note the identity guard will still block sensitive content.

---

## 5. Desktop pet (Electron shell)

**Not included**. Same category as the 3-D room: a window that renders `state/`.
Write an Electron/native shell that reads `state/` and the bridge's `/api/status`.

---

## 6. Voice conversation (mic → ASR → her → TTS)

**Not included**. The chain is: browser recording → local whisper (or cloud ASR) → separate session → TTS →
browser playback; measured end-to-end at roughly 6–7 seconds per short turn.

To build it: a static page + an `/v1/audio/transcriptions`-compatible ASR service + the TTS from section 1.
Keep it half-duplex — the microphone must be muted while she speaks, or she will hear herself.
