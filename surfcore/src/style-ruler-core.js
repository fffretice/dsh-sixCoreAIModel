/**
 * P0 尺子（style ruler）纯函数模块（task-22，2026-11-08）
 *
 * 定位：给「经历 → 行为改变」做**可重复的量尺**。本模块只做计算，不读写任何状态、
 * 不参与 prompt 注入、不被 bridge 导入（零行为风险）。
 *
 * 三个用途：
 *   1) 周风格快照：她的发言统计（句长/问句/语气词/括号/表情/@引用/开头词），按会话分；
 *   2) 行为块：从 causal.json / mood-history.jsonl 抽「结果质量 + 预测-结算」指标
 *      （决策文档 §3.3 要求 P0 必须含这两类，不能只有发言统计）；
 *   3) 仪表 bug 的数据侧：双采样缺口的量化、pushCount 恒 0 的推导与候选公式触发率。
 *
 * 数据流：scripts/style-ruler.mjs / scripts/p0-instrument-data.mjs 调本模块。
 */

export const STYLE_METRICS_VERSION = 1;

/** 语气词/口癖片段（出现即计数，取前 N）。只用于统计，不做行为判断。 */
export const PARTICLE_WORDS = Object.freeze([
  '啊', '呀', '嘛', '诶', '欸', '唔', '嗯', '啦', '哦', '噢', '呢', '哈', '嘿', '诶嘿',
  '吧', '咯', '嘞', '唉', '哎', '诶…', '呃', '哇', '嗷', '噗', '啾',
]);

/** 括号码（中文/英文/书名号都算「语气括号」习惯的一部分）。 */
const BRACKET_RE = /[（(【\[]/;

/** 问句：中文问号、英文问号，或句末「吗/呢/嘛/？」结构。 */
const QUESTION_RE = /[？?]|[吗呢嘛]\s*[。！!～~…（(]?$/;

/** @ 或引用（「有人说」「老大说」这类转述不算）。 */
const AT_QUOTE_RE = /@|引用|回复你|回你/;

/** 单句切分：中文句末 + 省略号 + 换行。空格不切（她的短句中间常用空格停顿）。 */
export function splitSentences(text) {
  const s = String(text ?? '').replace(/\r/g, ' ');
  const parts = s.split(/[。！？!?；;\n…]+/).map((x) => x.trim()).filter(Boolean);
  return parts.length ? parts : [];
}

/** 消息长度（按字符，去掉首尾空白；不把 @昵称 算进句长）。 */
export function bodyOf(text) {
  return String(text ?? '')
    .replace(/^@[^\s]+[\s:：]*/u, '')
    .trim();
}

function pct(n, d) {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : 0;
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  return sorted[base];
}

/**
 * 一组「她的发言」→ 风格指标。
 * @param {Array<{text:string,time?:number,mediaCount?:number,sticker?:boolean,quote?:boolean}>} lines
 */
export function computeStyleMetrics(lines = []) {
  const list = Array.isArray(lines) ? lines.filter((x) => x && String(x.text ?? '').trim()) : [];
  const msgCount = list.length;
  const msgLens = [];
  const sentLens = [];
  let questionMsgs = 0;
  let particleMsgs = 0;
  let bracketMsgs = 0;
  let mediaMsgs = 0;
  let atQuoteMsgs = 0;
  let exclaimMsgs = 0;
  const particleCount = new Map();
  const openerCount = new Map();
  for (const line of list) {
    const body = bodyOf(line.text);
    if (!body) continue;
    // [表情:…] / [图片] 这类是平台占位符，不是她的「发言」：只计入媒体率，不参与句长/语气词/开头词
    if (/^\[(表情|表情包|图片|转发消息|拍一拍)[^\]]*\]$/.test(body)) {
      mediaMsgs += 1;
      continue;
    }
    const len = body.length;
    msgLens.push(len);
    if (QUESTION_RE.test(body)) questionMsgs += 1;
    if (/[!！]/.test(body)) exclaimMsgs += 1;
    if (BRACKET_RE.test(body)) bracketMsgs += 1;
    if (AT_QUOTE_RE.test(String(line.text ?? ''))) atQuoteMsgs += 1;
    if (Number(line.mediaCount) > 0 || line.sticker === true) mediaMsgs += 1;
    let hasParticle = false;
    for (const w of PARTICLE_WORDS) {
      if (body.includes(w)) {
        particleCount.set(w, (particleCount.get(w) || 0) + 1);
        hasParticle = true;
      }
    }
    if (hasParticle) particleMsgs += 1;
    const sentences = splitSentences(body);
    for (const s of sentences) sentLens.push(s.length);
    // 开头词：第一句去掉标点后的前 2 个字（「唔…」这种语气开头也保留）
    const first = (sentences[0] || body).replace(/^[「『（(《【\s]+/, '');
    if (first.length >= 2) openerCount.set(first.slice(0, 2), (openerCount.get(first.slice(0, 2)) || 0) + 1);
  }
  const sortedMsgLens = msgLens.slice().sort((a, b) => a - b);
  const sortedSentLens = sentLens.slice().sort((a, b) => a - b);
  const top = (map, n = 8) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([word, count]) => ({ word, count, rate: pct(count, Math.max(1, msgCount)) }));
  const totalChars = msgLens.reduce((a, b) => a + b, 0);
  return {
    version: STYLE_METRICS_VERSION,
    messages: msgCount,
    chars: totalChars,
    avgMsgChars: msgCount ? Math.round((totalChars / msgCount) * 10) / 10 : 0,
    p50MsgChars: Math.round(quantile(sortedMsgLens, 0.5) * 10) / 10,
    p90MsgChars: Math.round(quantile(sortedMsgLens, 0.9) * 10) / 10,
    sentences: sentLens.length,
    avgSentenceChars: sentLens.length ? Math.round((sentLens.reduce((a, b) => a + b, 0) / sentLens.length) * 10) / 10 : 0,
    p50SentenceChars: Math.round(quantile(sortedSentLens, 0.5) * 10) / 10,
    questionRate: pct(questionMsgs, msgCount),
    exclaimRate: pct(exclaimMsgs, msgCount),
    particleRate: pct(particleMsgs, msgCount),
    bracketRate: pct(bracketMsgs, msgCount),
    mediaRate: pct(mediaMsgs, msgCount),
    atQuoteRate: pct(atQuoteMsgs, msgCount),
    particleTop: top(particleCount, 8),
    openerTop: top(openerCount, 8),
  };
}

/** 数字指标集合（用于周对比）。比率字段也在这里，单位都是「百分点」。 */
export const NUMERIC_METRICS = Object.freeze([
  'messages', 'avgMsgChars', 'p50MsgChars', 'p90MsgChars', 'avgSentenceChars', 'p50SentenceChars',
  'questionRate', 'exclaimRate', 'particleRate', 'bracketRate', 'mediaRate', 'atQuoteRate',
]);

/**
 * 两期快照对比：返回每个指标的变化；significant 里放超过阈值的项。
 * @param {{metrics:object}} prev
 * @param {{metrics:object}} cur
 */
export function diffSnapshots(prev, cur, { minAbs = 2 } = {}) {
  const a = prev?.metrics || prev || {};
  const b = cur?.metrics || cur || {};
  const deltas = {};
  for (const key of NUMERIC_METRICS) {
    const va = Number(a[key]) || 0;
    const vb = Number(b[key]) || 0;
    deltas[key] = Math.round((vb - va) * 10) / 10;
  }
  const significant = Object.entries(deltas)
    .filter(([key, d]) => key !== 'messages' && Math.abs(d) >= minAbs)
    .map(([key, d]) => ({ metric: key, delta: d, before: a[key], after: b[key] }));
  return { deltas, significant };
}

/**
 * 行为块（决策文档 §3.3 要求）：结果质量 + 预测-结算，不能只有发言统计。
 * @param {object} causal  state/causal.json 原始对象
 * @param {Array}  moodHistory  state/mood-history.jsonl 解析后的行
 * @param {object} opts { now, windowMs }
 */
export function shapeBehaviorSnapshot(causal = {}, moodHistory = [], { now = Date.now(), windowMs = 7 * 86400000 } = {}) {
  const since = now - windowMs;
  const log = Array.isArray(causal.log) ? causal.log.filter((x) => Number(x.at) >= since) : [];
  const n = log.length;
  const outcome = { replied: 0, no_reply: 0, silent: 0, came: 0, called_out: 0 };
  const latencies = [];
  const surprises = [];
  const bySource = {};
  const byTime = {};
  for (const item of log) {
    const o = String(item.outcome || 'pending');
    outcome[o] = (outcome[o] || 0) + 1;
    // 延迟：优先「真正开口的时间 - 事件时间」（spokeAt/at）；没有才退回结算窗口偏移 latencyMs。
    const realLatency = Number(item.spokeAt) > 0 && Number(item.at) > 0 && Number(item.spokeAt) >= Number(item.at)
      ? Number(item.spokeAt) - Number(item.at)
      : 0;
    if (realLatency > 0) latencies.push(realLatency);
    else if (Number(item.latencyMs) > 0) latencies.push(Number(item.latencyMs));
    if (Number.isFinite(Number(item.surprise))) surprises.push(Number(item.surprise));
    const src = String(item.source || '?').replace(/:.+$/, (m) => m); // 保留 request:accept 这类前缀
    bySource[src] = bySource[src] || { n: 0, replied: 0 };
    bySource[src].n += 1;
    if (o === 'replied') bySource[src].replied += 1;
  }
  const latSorted = latencies.sort((a, b) => a - b);
  const stats = causal.stats && typeof causal.stats === 'object' ? causal.stats : {};
  // 行为块里的「预测-结算」：calibration 有样本时给 Brier；没有就明确写 no-samples。
  const rawCalibration = stats.calibration && typeof stats.calibration === 'object' ? stats.calibration : {};
  const calibration = {
    n: Number(rawCalibration.n || rawCalibration.samples || 0),
    brier: Number.isFinite(Number(rawCalibration.brier)) ? Number(rawCalibration.brier) : null,
    baselineBrier: Number.isFinite(Number(rawCalibration.baselineBrier)) ? Number(rawCalibration.baselineBrier) : null,
  };
  // 情绪序列（patience/energy 分布，供 pushCount 方案用）
  const patience = [];
  const energy = [];
  let asleep = 0;
  for (const row of Array.isArray(moodHistory) ? moodHistory : []) {
    if (Number(row.at) < since) continue;
    const d = row.dims || {};
    if (Number.isFinite(Number(d.patience))) patience.push(Number(d.patience));
    if (Number.isFinite(Number(d.energy))) energy.push(Number(d.energy));
    if (row.asleep === true) asleep += 1;
  }
  const q = (arr, p) => quantile(arr.slice().sort((a, b) => a - b), p);
  const totalMood = Array.isArray(moodHistory) ? moodHistory.filter((r) => Number(r.at) >= since).length : 0;
  return {
    windowMs,
    windows: { causalSamples: n, moodSamples: totalMood },
    outcome,
    spokeRate: pct((outcome.replied || 0) + (outcome.called_out || 0), n),
    calledOutRate: pct(outcome.called_out || 0, n),
    latencyMs: { p50: Math.round(q(latSorted, 0.5)), p90: Math.round(q(latSorted, 0.9)) },
    surpriseMean: surprises.length ? Math.round((surprises.reduce((a, b) => a + b, 0) / surprises.length) * 100) / 100 : null,
    bySource,
    byStyle: stats.byStyle || {},
    byTime: stats.byTime || {},
    calibration,
    mood: {
      patienceP50: Math.round(q(patience, 0.5) * 1000) / 1000,
      patienceP5: Math.round(q(patience, 0.05) * 1000) / 1000,
      patienceP95: Math.round(q(patience, 0.95) * 1000) / 1000,
      energyP50: Math.round(q(energy, 0.5) * 1000) / 1000,
      asleepRate: pct(asleep, totalMood),
    },
    // 结果质量代理（决策文档要求，但只能从现有数据近似）：
    qualityProxy: {
      noReplyRate: pct(outcome.no_reply || 0, n),
      nightNoReply: (() => {
        let night = 0; let nightReplied = 0;
        for (const item of log) {
          const h = new Date(Number(item.at)).getHours();
          if (h >= 1 && h < 7) { night += 1; if (item.outcome === 'replied') nightReplied += 1; }
        }
        return { n: night, repliedRate: pct(nightReplied, night) };
      })(),
      note: '现有数据只有「有人接/没有」与延迟；回复长度、对方后续、终止语尚未采集 → P0 尺子的已知缺口。',
    },
  };
}

// ── pushCount 恒 0：推导与候选公式（数据侧） ─────────────────────────────

/** 当前公式（与 src/mood.js sampleBehavior 一致；jitter 视为 U[0,1)）。 */
export function pushCountBase(patience, energy) {
  return (0.55 - Number(patience)) * 6 + (0.6 - Number(energy)) * 3;
}

/** 候选公式：用于评估「怎么改才会触发」。返回 base，触发条件 = base + u >= 0.5（u∈[0,1)）。 */
export const PUSH_COUNT_VARIANTS = Object.freeze([
  { id: 'current', label: '现状：round((0.55-p)*6+(0.6-e)*3+u)', fn: (p, e) => (0.55 - p) * 6 + (0.6 - e) * 3 },
  { id: 'p-steeper', label: '只把耐心斜率调陡：round((0.62-p)*10+(0.6-e)*3+u)', fn: (p, e) => (0.62 - p) * 10 + (0.6 - e) * 3 },
  { id: 'shifted', label: '整体平移：round((0.7-p)*6+(0.7-e)*3+u)', fn: (p, e) => (0.7 - p) * 6 + (0.7 - e) * 3 },
  { id: 'relative-baseline', label: '相对自身基线：基于 patience 的 z 分数（需运行时基线，先估触发面）', fn: null },
]);

/**
 * 用真实 (patience, energy) 序列评估各公式的触发率与期望推出次数。
 * 触发条件严格按 round(base+u) >= 1 且 base+u>=0.5。
 * @param {Array<{patience:number,energy:number}>} samples
 * @param {{draws?:number}} opts
 */
export function evaluatePushCountVariants(samples = [], { draws = 20, rng = Math.random } = {}) {
  const list = Array.isArray(samples) ? samples.filter((s) => Number.isFinite(Number(s.patience)) && Number.isFinite(Number(s.energy))) : [];
  const out = [];
  for (const variant of PUSH_COUNT_VARIANTS) {
    if (!variant.fn) { out.push({ id: variant.id, label: variant.label, supported: false, note: '需要先定义运行时基线（如 7 天 patience 中位数），本期只给方案' }); continue; }
    let triggerDraws = 0;
    let totalDraws = 0;
    let sumCount = 0;
    const hist = {};
    for (const s of list) {
      const base = variant.fn(Number(s.patience), Number(s.energy));
      for (let i = 0; i < draws; i += 1) {
        const count = Math.max(0, Math.round(base + rng()));
        totalDraws += 1;
        if (count > 0) triggerDraws += 1;
        sumCount += count;
        hist[count] = (hist[count] || 0) + 1;
      }
    }
    out.push({
      id: variant.id,
      label: variant.label,
      supported: true,
      samples: list.length,
      triggerRatePct: pct(triggerDraws, totalDraws),
      expectedPushCount: totalDraws ? Math.round((sumCount / totalDraws) * 100) / 100 : 0,
      distributionPct: Object.fromEntries(Object.entries(hist).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => [k, pct(v, totalDraws)])),
    });
  }
  return out;
}

/**
 * 双采样缺口量化：同一份 dims 下独立抽两次 sampleBehavior，两个字段分别有多大概率不同。
 * （只做概率推导，不 import mood.js，避免把随机源带进报告；公式与 mood.js 一致。）
 */
export function dualSamplingMismatch({ patience, energy, mood, social, draws = 4000, rng = Math.random }) {
  const p = { patience: Number(patience), energy: Number(energy), mood: Number(mood), social: Number(social) };
  const soft = (x, k) => 1 / (1 + Math.exp(-k * x));
  const draw = () => ({
    procrastinate: rng() < soft((0.45 - p.patience) * 2.2 + (0.5 - p.energy) * 0.9, 1.8),
    pushCount: Math.max(0, Math.round((0.55 - p.patience) * 6 + (0.6 - p.energy) * 3 + rng())),
    talky: rng() < soft((p.mood - 0.5) * 1.8 + (p.social - 0.45) * 1.6 + (p.patience - 0.4) * 1.4, 1.6),
    initiate: rng() < soft((p.social - 0.4) * 1.8 + (p.energy - 0.4) * 1.0, 1.6),
    terse: rng() < soft((0.45 - p.energy) * 2.0 + (0.4 - p.patience) * 1.4, 1.6),
  });
  const diff = { procrastinate: 0, pushCount: 0, talky: 0, initiate: 0, terse: 0 };
  let any = 0;
  for (let i = 0; i < draws; i += 1) {
    const a = draw();
    const b = draw();
    let anyDiff = false;
    for (const key of Object.keys(diff)) {
      if (a[key] !== b[key]) { diff[key] += 1; anyDiff = true; }
    }
    if (anyDiff) any += 1;
  }
  const toPct = (v) => Math.round((v / draws) * 1000) / 10;
  return {
    dims: p,
    draws,
    anyDiffPct: toPct(any),
    perFieldPct: Object.fromEntries(Object.entries(diff).map(([k, v]) => [k, toPct(v)])),
    note: '两处各自 sampleBehavior 时，注入（moodPromptLine 内）与落盘（lastBehavior）的字段有上述概率不一致。',
  };
}

// ── 数据采集（纯函数：输入 social-v2 / 记忆卡对象，输出按会话分的「她的发言」）────

// 去重桶：10 分钟。memory-card 的 botReply 与 social-v2 里同一条消息的时间戳可能差几分钟，
// 1 分钟窗口会重复计数；10 分钟足够把同一条消息的两份来源合并，又不至于把不同轮的同句误并。
function minuteKey(ms) {
  return Number.isFinite(Number(ms)) ? Math.round(Number(ms) / 600000) : 0;
}

/**
 * 从 social-v2.recentMessages + 记忆卡记录里收集「她的发言」，按会话分组并去重。
 * 两个来源重叠时按「同一分钟 + 同文本前 24 字」去重（social-v2 的来源优先，媒体信息更准）。
 *
 * @param {{socialState?:object, cardRecords?:Array, sinceMs?:number}} input
 * @returns {{sessions: Record<string, Array>, all: Array, coverage: object}}
 */
export function collectStyleLines({ socialState = null, cardRecords = [], sinceMs = 0 } = {}) {
  const sessions = {};
  const seen = new Set();
  const add = (key, line) => {
    const k = String(key || 'unknown');
    const body = bodyOf(line.text);
    if (!body) return;
    const dedupe = `${k}|${minuteKey(line.time)}|${body.replace(/\s+/g, '').slice(0, 24)}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    (sessions[k] = sessions[k] || []).push({ ...line, time: Number(line.time) || 0 });
  };
  // ① social-v2（最近 100 条/会话；媒体字段准确）
  const conv = socialState?.conversations && typeof socialState.conversations === 'object' ? socialState.conversations : {};
  for (const [key, c] of Object.entries(conv)) {
    for (const m of Array.isArray(c?.recentMessages) ? c.recentMessages : []) {
      if (!m || m.isSelf !== true) continue;
      const time = Number(m.time) || 0;
      if (time && time < sinceMs) continue;
      add(key, {
        text: String(m.text || m.plain || ''),
        time,
        mediaCount: Array.isArray(m.media) ? m.media.length : 0,
        sticker: m.sticker === true || Boolean(m.stickerNo),
        quote: m.quoteTargetIsSelf === true,
      });
    }
  }
  // ② 记忆卡（覆盖更久的历史；qq-self 文本 + botReply 是她说过的话）
  for (const rec of Array.isArray(cardRecords) ? cardRecords : []) {
    const time = Date.parse(String(rec?.createdAt || ''));
    if (!Number.isFinite(time) || (sinceMs && time < sinceMs)) continue;
    const key = String(rec?.conversationKey || (rec?.platform === 'pet' ? 'pet' : 'unknown'));
    if (rec?.isSelf === true && rec?.text) {
      add(key, { text: String(rec.text), time, mediaCount: 0, sticker: false, quote: false });
    }
    if (rec?.botReply) {
      add(key, { text: String(rec.botReply), time: time + 1000, mediaCount: 0, sticker: false, quote: false });
    }
  }
  const all = Object.values(sessions).flat();
  const coverage = {
    sessions: Object.keys(sessions).length,
    lines: all.length,
    earliest: all.length ? Math.min(...all.map((x) => x.time || Infinity)) : 0,
    latest: all.length ? Math.max(...all.map((x) => x.time || 0)) : 0,
    sources: { socialV2: Object.keys(conv).length, memoryCard: Array.isArray(cardRecords) ? cardRecords.length : 0 },
  };
  return { sessions, all, coverage };
}

/** ISO 周（本地时区）：YYYY-Www。 */
export function isoWeekKey(ms = Date.now()) {
  const d = new Date(ms);
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** 本周起点（周一 00:00 本地）。 */
export function weekStartOf(ms = Date.now()) {
  const d = new Date(ms);
  const day = d.getDay() || 7;
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  start.setDate(start.getDate() - (day - 1));
  return start.getTime();
}
