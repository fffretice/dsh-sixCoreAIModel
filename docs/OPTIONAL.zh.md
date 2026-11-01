> English version: [OPTIONAL.md](./OPTIONAL.md)

# 可选能力：这个包里没有，但你可以自己加

发布包刻意**不带**下面这些：它们要么有版权/许可问题，要么需要额外的模型和显卡，
要么是某个人自己的东西。这里说明每一件怎么补。

---

## 1. 语音（说话）

**包里没有**：任何语音包、训练好的音色、GPT-SoVITS 模型、音频样本。

**为什么**：克隆音色涉及他人声音的版权与人格权，不能随开源包分发；
模型本体也有各自的许可证（GPT-SoVITS 是 MIT，但你喂进去的参考音频不是）。

**你自己怎么加**（三种，从易到难）：

| 方案 | 做什么 | 成本 |
| --- | --- | --- |
| A. 系统 TTS | 用 macOS `say` / Windows SAPI 直接合成 | 零成本，音色一般 |
| B. 开源 TTS | 部署 [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) 或 piper，用**你自己的**声音或授权素材 | 半天 + 一块显卡（CPU 也能跑，慢） |
| C. 云端 TTS | 接 OpenAI / Azure / 阿里云的语音合成 API | 按量付费，最省事 |

接进 SurfCore 的位置：`config.json → socialV2.voice`（`enabled`、`dir`、时长/频率限制），
合成服务地址在 `socialV2.voice.tts`。桥接调用的是 OpenAI 兼容的 `/v1/audio/speech` 形态，
所以任何兼容服务都能接。

> **别做的事**：不要把别人的声音（尤其声优、主播、vtuber）拿去克隆后公开分发。
> 自己私下玩是另一回事，公开发布一定出事。

---

## 2. 画图

**包里没有**：ComfyUI、SDXL/任何 checkpoint、生成的工作流。

**为什么**：模型动辄几个 GB，且各有许可证（SDXL 是 CreativeML OpenRAIL++-M，
商用有条件）；塞进代码仓库既不合规也不现实。

**你自己怎么加**：

1. 装 [ComfyUI](https://github.com/comfyanonymous/ComfyUI)，下一个人像/二次元 checkpoint；
2. 启动它（默认 `http://127.0.0.1:8188`）；
3. 在 `config.json` 里：

```jsonc
"socialV2": {
  "draw": {
    "enabled": true,
    "comfyUrl": "http://127.0.0.1:8188",
    "checkpoint": "你的模型文件名.safetensors",
    "dailyLimit": 3,
    "size": "832x832"
  }
}
```

4. 重启桥接。她用 `qq_draw_image` 出图，画完会直接发到会话里。

**没有显卡怎么办**：把 `draw.enabled` 设 `false`。她不会因为没有画图能力而变笨，
只是被要求画图时会说「画不了」。

---

## 3. 3D 房间

**包里没有**：Three.js 房间、MMD 模型、桌宠外壳。

**为什么**：模型（`.pmx`）有明确的使用规约（多数只允许 MMD 视频用途），不能随包分发；
房间本身也需要单独调。

**想要的话**：自己用 Three.js 或 Unity 搭一个只读 `state/` 的查看器即可。
`state/mood.json`、`state/drive.json`、`state/tool-calls.jsonl` 就是全部数据源；
房间里的每个家具对应一类工具调用（按 `tool-calls.jsonl` 统计出来的分布排）。

---

## 4. B 站

**包里没有**：B站 cookie、账号、任何登录态。

**为什么**：那是你的账号。

**怎么加**：`config.json → biliBridge`，填 `self.mid` 与 cookie；
只读功能（看视频、看热榜、看评论）不需要登录也能用一部分。
写操作（点赞/评论/动态）默认关闭，要用自己在配置里开，并且有身份护栏拦着不发敏感信息。

---

## 5. 桌面宠物（Electron 外壳）

**包里没有**。它和 3D 房间是同一类东西：一个渲染 `state/` 的窗口。
想做得自己写一个 Electron/原生壳，读 `state/` 与桥接的 `/api/status` 即可。

---

## 6. 语音对话（麦克风 → ASR → 她 → TTS）

**包里没有**。链路是：浏览器录音 → 本地 whisper（或云端 ASR）→ 独立会话 → TTS →
浏览器播放，实测一句约 6–7 秒。

要做的话：一个静态页面 + 一个 `/v1/audio/transcriptions` 兼容的 ASR 服务 + 上面第 1 条的 TTS。
别做成半双工以外的形态——她说话时麦克风必须静音，否则会把自己的声音当输入。
