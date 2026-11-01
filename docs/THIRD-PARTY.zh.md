> English version: [THIRD-PARTY.md](./THIRD-PARTY.md)

# 第三方组件与许可

这个仓库**不含**任何不能合法分发的资产。下面分三类说清楚。

---

## 一、随仓库分发的

| 组件 | 许可 | 说明 |
| --- | --- | --- |
| SurfCore 本体（`surfcore/src` 等） | MIT（见 `surfcore/LICENSE`） | 本项目 |
| 角色模板与文档 | 同 MIT | 随便改、随便用 |
| `roles/傲娇助手.md` | 同 MIT | 一个通用示例角色，不含任何真人信息 |

依赖（`package.json` 里的 npm 包）各自保留其许可证，`npm install` 时随包附带。
主要依赖：`js-yaml`（MIT）。

---

## 二、需要你自己装、本仓库不分发的

| 组件 | 为什么不分发 | 你要做什么 |
| --- | --- | --- |
| **SnowLuma** | 第三方专有运行时，EULA 不允许随包分发 | 自己去 [Releases](https://github.com/SnowLuma/SnowLuma/releases) 下，扫码登录 |
| **DeepSeek Harness** | 官方软件 | 自己装 |
| **Node.js** | 官方运行时 | 自己装 |
| **ComfyUI / SDXL 等模型** | 体积大 + 各自的许可证（SDXL 是 OpenRAIL++-M，商用有条件） | 想画图就自己装，见 `docs/OPTIONAL.md` |
| **TTS / ASR 模型**（GPT-SoVITS、whisper 等） | 体积大；且音色取决于你喂的音频 | 见 `docs/OPTIONAL.md` |

---

## 三、明确**不在**这个仓库里的东西

- **任何人的语音包 / 克隆音色 / 参考音频**；
- **任何 3D 模型（.pmx/.vrm/GLB）与 3D 房间工程**；
  MMD 模型通常带「仅限 MMD 视频用途」之类的使用规约，不能随开源包分发；
- **任何真实聊天记录、记忆卡、日记、群号、QQ 号、令牌**；
- **任何人的 UI 截图**（已全部删除）。

如果你在自己的 fork 里加了上面任何一样，**发布前请自行确认许可**，
并跑一遍 `node scripts/privacy-scan.mjs`。

---

## 四、引用与致谢

这套系统的设计引用了不少公开研究（情绪维度、记忆衰减、内在动机、叙事身份等），
完整文献见仓库根目录的论文稿（如果你拿到的是带 `paper/` 的版本）。
代码里的注释保留了「为什么这么设计」的出处，改参数前建议先读一眼。
