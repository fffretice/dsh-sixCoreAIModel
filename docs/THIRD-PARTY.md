# Third-party components and licensing

This repository contains **no asset that cannot be redistributed legally**. Three categories below.

---

## 1. Shipped with the repo

| Component | License | Notes |
| --- | --- | --- |
| SurfCore engine (`surfcore/src` etc.) | MIT (see `surfcore/LICENSE`) | this project |
| Character templates and documentation | MIT | edit freely |
| `roles/傲娇助手.md` | MIT | a generic example character, no real person |

npm dependencies keep their own licenses; `npm install` brings them along.
Main dependency: `js-yaml` (MIT).

---

## 2. You install these yourself; not shipped

| Component | Why not shipped | What you do |
| --- | --- | --- |
| **SnowLuma** | third-party proprietary runtime; its EULA forbids bundling | download from [Releases](https://github.com/SnowLuma/SnowLuma/releases), scan the QR |
| **DeepSeek Harness** | vendor software | install it yourself |
| **Node.js** | vendor runtime | install it yourself |
| **ComfyUI / SDXL and other models** | large + separate licenses (SDXL is OpenRAIL++-M with commercial conditions) | install if you want image generation — see [OPTIONAL.md](OPTIONAL.md) |
| **TTS / ASR models** (GPT-SoVITS, whisper) | large; the timbre depends on the audio you supply | see [OPTIONAL.md](OPTIONAL.md) |

---

## 3. Explicitly **not** in this repository

- **Any voice pack, cloned timbre or reference audio**;
- **Any 3-D model (.pmx/.vrm/GLB) or 3-D room project** — MMD models usually carry "MMD videos only" terms and cannot
  be redistributed in an open-source package;
- **Any real chat log, memory card, diary, group ID, QQ number or token**;
- **Any UI screenshot** (all removed).

If you add any of the above to your fork, **verify the license before publishing** and run
`node scripts/release-audit.mjs`.

---

## 4. Credits and references

The design cites a fair amount of published research (affect dimensions, memory decay, intrinsic motivation,
narrative identity). The code comments keep the "why we designed it this way" rationale; if you are about to
change a parameter, read them first.
