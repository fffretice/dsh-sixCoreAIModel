# 排障

按「症状」查，不按报错查——报错千奇百怪，症状就那么几种。
先看日志：`surfcore/state/bridge.log`（最近的）、`state/bridge-supervisor.log`（守护进程）。

---

## 一、装不上

### `npm install` 报 `Cannot find module '@deepseek-ai/schemastery'`

顺序错了：**先装依赖，再装插件**。

```bash
npm install
node scripts/setup-dsh.mjs
```

### 设置里找不到 SurfCore

1. `setup-dsh.mjs` 有没有报错？
2. DSH 重启了吗？
3. 页面 F5 刷新（插件列表是页面加载时的快照）。

### Node 版本太低

```
Error: Cannot use import statement outside a module
```

→ `node -v` 低于 22.13。升级 Node，别用系统自带的旧版本。

---

## 二、起来了但不说话

按顺序查，多数问题在第一步：

### ① 桥接连上 SnowLuma 了吗

```bash
curl -H "x-console-token: $(cat state/console-token)" http://127.0.0.1:3100/api/status
```

看 `snowlumaConnected`。`false` → 查 SnowLuma 是否在跑、`wsUrl` 对不对、token 对不对。

### ② 她连上 DSH 了吗

同样的返回里看 `dshReady`。`false` → **DSH 重启后端口变了**，桥接还在连旧端口。
重启桥接（`bridge-supervisor.sh` 会自动找端口）。

### ③ 白名单对吗

`allow.groups` / `allow.private`。不在里面的会话，消息**根本不会进模型**，
不是「看了不回」——所以表现就是完全没反应。

### ④ 额度用完了吗

```bash
cat state/mood.json | head -20      # 看 asleep / 五个值
tail -50 state/bridge.log | grep -E '额度|quota|唤醒'
```

默认每天 80 次群唤醒、120 次私聊、¥15。用完后她会安静到第二天零点。

### ⑤ 她是不是睡着了

耐心 < 0.08 或精力 < 0.12 时会随机睡 40–90 分钟。`mood.json` 里 `asleep: true` 就是。
这期间只有 @ / 叫名字 / 提问 / 私聊 / 日记时段能叫醒她。

---

## 三、回得不像人

| 现象 | 原因 | 改哪 |
| --- | --- | --- |
| 每条都很长 | 人格卡没写长度约束 | `roles/<名字>.md` 的「二、说话风格」 |
| 爱列点、爱总结 | 提示里「汇报」场合太多 | 少让她总结；检查规则卡别写「汇报」 |
| 总是用同一句开头 | 口癖写太多，或记忆里反复出现 | 删口癖、清记忆 |
| 像客服 | 人格卡写了「温柔」「专业」这类词 | 换成可观察的写法 |
| 群里不说话 | 唤醒概率低 / 情绪低 | `socialV2.wake.recommendedProbability`，或看情绪 |

**根治办法**：`docs/CHARACTER.md` 的「二、说话风格」重写一遍，比调任何参数都有效。

---

## 四、情绪不对

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 五个值长期不动 | tick 没跑（桥接没在运行） | 看 `/api/status` 的 `uptime` |
| 某个值钉在 0 或 1 | 速率参数调到极端 | 改 `src/mood.js` 的衰减/恢复速率，重启 |
| 一直睡着 | 精力/耐心基线太低 | 改 `mood.js` 里 `energyBaseline` 或睡眠阈值 |
| 社交长期满格 | 恢复速率过高 | 社交上限 0.95、>0.85 时恢复 ×0.3，仍满就再降 |

> 这一类「速率参数」最容易从一头滑到另一头。改完**跑两小时**再看，别只看一眼。

---

## 五、记忆不对劲

- **记不住刚说的话**：`~/.dsh/surfcore/characters/<id>/memory/` 有没有新写入？
  没有就是 `characters/current.json` 指向错了。
- **记得太多、上下文爆炸**：`memory-card` 有注入上限（默认 4313 字符），超了会截断；
  想更狠就调 `config.json → role.maxInjectChars`。
- **把别人的事记成自己的**：这是提示词串了，检查 `memory-card` 的归属字段。

---

## 六、主动说话太频繁 / 从不说

| 方向 | 旋钮 |
| --- | --- |
| 太频繁 | `socialV2.wake.recommendedProbability` 调低；`tokenGuard.maxWakesPerDay` 调低 |
| 从不说 | 看 `state/drive.json` 的 `drive` 值；阈值 0.62，低于它不会主动 |
| 只在群里说、不私聊 | 私聊主动需要 `drive > 0.62` 且距上次 ≥2 小时 |

---

## 七、端口与控制台

| 症状 | 处理 |
| --- | --- |
| 控制台 401 | `cat state/console-token`，用 `?token=` 访问 |
| 3100 被占 | `lsof -i:3100`（mac）/ `netstat -ano \| findstr :3100`（win），杀掉旧进程 |
| 3000 被占 | 改 SnowLuma 或 `config.json` 的端口 |
| 页面白屏 | 浏览器控制台看报错；多半是没带 token |

---

## 八、真要重来

```bash
# 保留角色与记忆，只重装依赖和插件
rm -rf node_modules && npm install
node scripts/setup-dsh.mjs

# 连运行状态一起清（会丢情绪/因果/日志）
rm -rf state/*

# 全部重来（角色和记忆一起没了，先备份）
cp -r roles ~/roles.bak
rm -rf state ~/.dsh/surfcore/characters
```

实在不行，把这三样贴出来问人：`node -v`、`config.json`（**删掉 token 再贴**）、
`state/bridge.log` 最后 50 行。
