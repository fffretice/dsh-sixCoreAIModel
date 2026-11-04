/**
 * 因果核心（2026-10-31）—— 纯逻辑层，零 I/O。
 *
 * 要解决的问题：
 *   现在的 drive 只靠「时间」衰减——她主动说了话、有没有人接，对下一次想不想说话没有影响。
 *   也就是说她的行动和结果之间没有闭环。人的驱力不是这样工作的：
 *   发出去的话有人接 → 满足（drive 降）；没人接 → 也降，但降得不一样。
 *
 * 这个模块只做三件事：
 *   1. noteAction   ：她主动做了点什么（主动私聊/在群里起话头/去看一眼）
 *   2. settle       ：窗口内有没有回响（replied / came / no_reply / silent）
 *   3. promptLine   ：把「有意外的那一次」压缩成一句陈述，交给她自己处理
 *
 * 刻意不做的事：
 *   · 不评价、不安慰、不总结成报表（那会变成表演）
 *   · 不算「成功率」给她看（那是 KPI）
 *   · 不在群里提示（只在私聊，避免当众尴尬）
 *
 * 依据：
 *   · Schultz 1997 / Fiorillo 2003：多巴胺编码预测误差，不是奖励本身
 *   · Balleine & Dickinson 1998：目标导向行为依赖行动-结果关联；结果不变的行为是习惯
 *   · Haggard 2017：能动感来自「预测 → 结果」的比较
 *   · Deci 1999：可预期的外部奖赏会削弱内在动机 → 所以这里不给分、不给等级
 */

export const CAUSAL_VERSION = 1;

// 「被识破」的强信号：这些词本身就说明群友觉得她像 AI / 像程序，不用看语境。
// 2026-11-03：裸的「生成的」会被「anima生成的比较有特色」这种群友闲聊触发（实测误报过一次）。
// 改成必须指向她或者 AI 才认——「你这生成的」「AI 生成的」「机器生成的」。
export const CALLED_OUT_RE = /八股|像\s*AI|像\s*ai|AI\s*味|ai\s*味|机器人|程序写|你[这那]?\s*生成|AI\s*生成|机器\s*生成|不像人|太假|演的/i;

// 弱信号：「谁教的」「设定」单独出现时，在群里更常见的是惊讶和夸
// （「谁教你这么厉害的」），或者单纯在聊游戏设定。必须再看到语境才算。
export const CALLED_OUT_WEAK_RE = /谁教|设定/;
const CALLED_OUT_CONTEXT_RE = /怎么说话|这样说话|这么说话|那种说话|口癖|腔调|背课文|念稿|模板|套路|学来的|学的吧/;
const CALLED_OUT_PRAISE_RE = /厉害|好牛|太牛|牛啊|强的|好强|太强|可以啊|不错|好家伙|惊了|服了|太顶|学到了|进步/;

/**
 * 这段消息是不是在说她「像 AI」。
 * 2026-11-01：原来「谁教的」被当成负面，但群友说这句多数是夸（惊讶她学得像）。
 * 分两档：强信号直接算；弱信号要求同时有「说话方式」的语境，且没有明显夸的词。
 */
export function detectCalledOut(text) {
  const t = String(text || '');
  if (!t) return false;
  if (CALLED_OUT_RE.test(t)) return true;
  if (!CALLED_OUT_WEAK_RE.test(t)) return false;
  if (CALLED_OUT_PRAISE_RE.test(t)) return false;
  return CALLED_OUT_CONTEXT_RE.test(t);
}

export const CAUSAL_DEFAULTS = Object.freeze({
  enabled: true,
  windowMs: 45 * 60 * 1000,        // 行动后 45 分钟内算「有回响」
  maxPending: 50,
  maxLog: 300,
  promptPerDay: 1,                 // 一天最多一句，避免变成碎碎念
  promptFreshMs: 12 * 3600 * 1000, // 只提示 12 小时内的结算
  ignoredCooldownMs: 3 * 3600 * 1000, // 「没人接」的情绪反馈 3 小时内最多一次
  priorRate: 0.5,                  // 没历史时的先验回应率
  minSamplesForPrior: 3,
  // 2026-11-02：她开口前先猜「这句会不会有人接」，15 分钟后对账。
  // 15 分钟是从真实数据里定的：她发言后有人应的中位延迟 0.5~3 分钟，
  // p75 在 6~7 分钟，p90 才到 16 分钟。45 分钟的窗口太宽，会把半小时后的闲话也算成「回应」。
  predictWindowMs: 15 * 60 * 1000,
});

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

/** 本地日期 key（凌晨也算今天，不按 UTC）。 */
/** 夜间静默时段与高峰时段（2026-11-03 接入因果核心用，和桥接侧的机制共用一套常量）。 */
export const NIGHT_HOURS = Object.freeze({ start: 1, end: 7 });
export const PEAK_WINDOWS = Object.freeze([[9, 12], [14, 18]]);

/** 是否在深夜（默认 01:00–07:00，本地时区）。 */
export function isNightAt(at = Date.now()) {
  const h = new Date(Number(at)).getHours();
  return h >= NIGHT_HOURS.start && h < NIGHT_HOURS.end;
}

/** 是否在用电高峰（工作日 9–12、14–18，本地时区；节假日不谈，只做统计用）。 */
export function isPeakAtLocal(at = Date.now()) {
  const d = new Date(Number(at));
  const wd = d.getDay();
  if (wd === 0 || wd === 6) return false;
  const h = d.getHours();
  return PEAK_WINDOWS.some(([s, e]) => h >= s && h < e);
}

export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function emptyState() {
  return { version: CAUSAL_VERSION, pending: [], log: [], sceneMisses: [], stats: { bySource: {}, byStyle: {}, lastPromptDay: '', lastIgnoredAt: 0, calibration: { saidYes: { n: 0, hit: 0 }, saidNo: { n: 0, hit: 0 } } } };
}

/** 规整从磁盘读到的状态，防止旧版本/坏文件把逻辑搞崩。 */
export function normalizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  const pending = Array.isArray(raw.pending) ? raw.pending.filter((x) => x && x.key && Number(x.at)) : [];
  const log = Array.isArray(raw.log) ? raw.log.filter((x) => x && x.key && Number(x.at)) : [];
  // 2026-11-04：场合失误（把只该私下说的话发进群、被主人点出来）。
  const sceneMisses = Array.isArray(raw.sceneMisses)
    ? raw.sceneMisses.filter((x) => x && Number(x.at) && String(x.mine || '').trim()).slice(-20)
    : [];
  return {
    version: CAUSAL_VERSION,
    pending: pending.slice(-CAUSAL_DEFAULTS.maxPending),
    log: log.slice(-CAUSAL_DEFAULTS.maxLog),
    sceneMisses,
    stats: {
      bySource: raw.stats && typeof raw.stats.bySource === 'object' ? raw.stats.bySource : {},
      byStyle: raw.stats && typeof raw.stats.byStyle === 'object' ? raw.stats.byStyle : {},
      lastPromptDay: String(raw.stats?.lastPromptDay || ''),
      lastIgnoredAt: Number(raw.stats?.lastIgnoredAt || 0),
      lastStylePromptAt: Number(raw.stats?.lastStylePromptAt || 0),
      // 2026-11-03：夜里 / 高峰时段说话的结果。只统计，不评分——给她自己回味用。
      byTime: raw.stats && typeof raw.stats.byTime === 'object' ? raw.stats.byTime : {},
      lastTimePromptAt: Number(raw.stats?.lastTimePromptAt || 0),
      lastScenePromptAt: Number(raw.stats?.lastScenePromptAt || 0),
      lastRequestPromptAt: Number(raw.stats?.lastRequestPromptAt || 0),
      // 2026-11-02：预测校准账。她猜「会/不会有人接」，对账后记在 hit/n。
      calibration: {
        saidYes: {
          n: Number(raw.stats?.calibration?.saidYes?.n || 0),
          hit: Number(raw.stats?.calibration?.saidYes?.hit || 0),
        },
        saidNo: {
          n: Number(raw.stats?.calibration?.saidNo?.n || 0),
          hit: Number(raw.stats?.calibration?.saidNo?.hit || 0),
        },
        lastPromptAt: Number(raw.stats?.calibration?.lastPromptAt || 0),
      },
    },
  };
}

function makeId(now) {
  return `c${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function bump(stats, source, outcome) {
  const s = stats.bySource[source] || (stats.bySource[source] = { n: 0, replied: 0, noReply: 0 });
  s.n += 1;
  if (outcome === 'replied') s.replied += 1;
  if (outcome === 'no_reply') s.noReply += 1;
  if (outcome === 'called_out') s.calledOut = (s.calledOut || 0) + 1;
}

/** 按「说话的形态」记一笔：长度带 + 问句/陈述。只统计，不评分。 */
function bumpStyle(stats, style, outcome) {
  if (!style || !stats) return;
  if (!stats.byStyle || typeof stats.byStyle !== 'object') stats.byStyle = {};
  const lens = Number(style.lens) || 0;
  const band = lens <= 12 ? 'short' : lens <= 30 ? 'medium' : 'long';
  const dims = [`len:${band}`, style.isQ ? 'q' : 'plain'];
  if (style.isList) dims.push('list');
  // 只在「有」的时候记一笔：这样每个维度都是「带这个特征的句子，被接的比例」
  if (style.hasParticle) dims.push('particle');
  if (style.hasLaugh) dims.push('laugh');
  if (style.reactive) dims.push('reactive');
  if (style.hasQuote) dims.push('quote');
  if (style.echo) dims.push('echo');
  // 发图 vs 只打字：这是两个互斥的对照组，用来回答「哪种更容易被接」
  dims.push(style.isSticker ? 'sticker' : 'text');
  const replied = outcome === 'replied' ? 1 : 0;
  for (const d of dims) {
    const s = stats.byStyle[d] || (stats.byStyle[d] = { n: 0, replied: 0 });
    s.n += 1;
    s.replied += replied;
  }
}

/** 按「什么时候开口」记一笔：夜里/白天、高峰/空闲。只统计，不评分。 */
function bumpTime(stats, at, outcome) {
  if (!stats) return;
  if (!stats.byTime || typeof stats.byTime !== 'object') stats.byTime = {};
  const replied = outcome === 'replied' ? 1 : 0;
  const dims = [isNightAt(at) ? 'night' : 'day', isPeakAtLocal(at) ? 'peak' : 'off'];
  for (const d of dims) {
    const s = stats.byTime[d] || (stats.byTime[d] = { n: 0, replied: 0 });
    s.n += 1;
    s.replied += replied;
  }
}

/** 同类行动的回应率（带先验，样本少时偏向 0.5）。 */
export function expectedRate(stats, source, opts = {}) {
  const prior = Number(opts.priorRate ?? CAUSAL_DEFAULTS.priorRate);
  const minN = Number(opts.minSamplesForPrior ?? CAUSAL_DEFAULTS.minSamplesForPrior);
  const s = stats?.bySource?.[source];
  if (!s || !s.n) return prior;
  const n = s.n;
  const hits = s.replied || 0;
  if (n < minN) {
    const w = n / minN;
    return prior * (1 - w) + (hits / n) * w;
  }
  return hits / n;
}

/** 记一次主动行动。同一会话 10 分钟内不重复记（防抖）。 */
export function noteAction(state, { key, source = 'drive', detail = '', at = Date.now(), id } = {}) {
  const st = normalizeState(state);
  if (!key) return st;
  const recent = st.pending.find((p) => p.key === key && p.source === source && at - Number(p.at) < 10 * 60 * 1000);
  if (recent) return st;
  st.pending.push({ id: id || makeId(at), key, source, detail: String(detail).slice(0, 80), at, spoke: false, spokeAt: 0 });
  if (st.pending.length > CAUSAL_DEFAULTS.maxPending) {
    st.pending = st.pending.slice(-CAUSAL_DEFAULTS.maxPending);
  }
  return st;
}

/**
 * 被识破：有消息在说她「像 AI / 八股 / 谁教的」。
 * 优先结算该会话还没结算的 pending，记成 called_out；没有 pending 也单独记一条，
 * 因为它本身就是最直接的一次「结果」，而且比 replied 更该被记住。
 */
export function noteCalledOut(state, { key, at = Date.now(), text = '' } = {}) {
  const st = normalizeState(state);
  const events = [];
  const keep = [];
  let settled = false;
  for (const p of st.pending) {
    if (p.key !== key || settled) { keep.push(p); continue; }
    if (at - Number(p.at) > CAUSAL_DEFAULTS.windowMs) { keep.push(p); continue; }
    events.push(settleOne(st, p, { at, outcome: 'called_out' }));
    settled = true;
  }
  if (!settled) {
    st.log.push({
      id: makeId(at), key, source: 'meta', detail: String(text).slice(0, 80), at,
      spoke: false, spokeAt: 0, outcome: 'called_out', latencyMs: 0, surprise: 1, shownAt: 0,
    });
  }
  st.pending = keep.slice(-CAUSAL_DEFAULTS.maxPending);
  st.log = st.log.slice(-CAUSAL_DEFAULTS.maxLog);
  return { state: st, events };
}

/** 她真的开口了（发送成功）。找到该会话最近一条 pending 标记。 */
/**
 * 她开口前自己猜了一句「这话会不会有人接」（2026-11-02）。
 * 格式：正文末尾 `[[接住:会]]` / `[[接住:不会]]`。发送前会剥掉，群友看不到。
 *
 * 为什么值得记：预测和实际之间的差，才是真正的反思素材——
 * 不是「没人接」，是「我以为会有人接，结果没有」。这给的是校准，不是叙事。
 * 依据：SAMULE（EMNLP 2025）的 foresight-based reflection；
 * Haggard 2017 的能动感来自「预测 → 结果」比较。
 */
const PREDICT_RE = /\[\[\s*(?:接住|接)\s*[:：]\s*(会|不会|能|不能|有|没有)\s*\]\]/;

/** 从她的话里解析预测：1=猜有人接，0=猜没人接，null=没猜。 */
export function parsePredict(text) {
  const m = PREDICT_RE.exec(String(text || ''));
  if (!m) return null;
  return /不会|不能|没有/.test(m[1]) ? 0 : 1;
}

/** 把预测标记从正文里剥掉——这东西不能让人看见。 */
export function stripPredict(text) {
  return String(text || '').replace(new RegExp(PREDICT_RE.source, 'g'), '').replace(/[ \t]+$/gm, '').trimEnd();
}

export function noteSpoke(state, { key, at = Date.now(), text = '', echo = false, sticker = null } = {}) {
  // 2026-11-02：把她「说的是什么样的句子」也记下来（长度带 / 是否问句），
  // 结算时按这个维度统计，才知道哪种说法更容易被接——这是给「反思」用的，不是给她看的成绩单。
  const t = String(text || '');
  const compact = t.replace(/\s+/g, '');
  const hasSticker = sticker !== null && sticker !== undefined && String(sticker) !== '';
  const style = (compact.length || hasSticker)
    ? {
        lens: compact.length,
        isQ: /[？?]/.test(t),
        isList: /^[-•·\d]|、|；/.test(t.trim()) || t.split('\n').filter(Boolean).length >= 3,
        // 2026-11-02：主人说「不止句长，还有说话方式」。这里加几个能自动判、又确实像人的：
        // 语气词（口语感）、笑/草（网络感）、反应式开场（唔/诶/哦）、引用（对话感）。
        hasParticle: /[啊吧呢嘛呀哦啦呗捏]/.test(compact),
        hasLaugh: /草|哈哈|笑死|绷|乐|6\b/.test(compact),
        reactive: /^(唔|诶|哎|哦|嗯|啊|咦|喂)/.test(compact),
        hasQuote: /^\[引用|^\[回复/.test(t.trim()),
        // 跟了群里的复读：这是「群里什么模式值得跟」的唯一证据来源
        echo: Boolean(echo),
        isSticker: hasSticker,
        stickerNo: hasSticker ? String(sticker) : '',
      }
    : null;
  const st = normalizeState(state);
  const predict = parsePredict(t);
  // 2026-11-02：发图也是一次「开口」。之前只记文字，所以她发图的后果永远不回流，
  // 也就没法知道「发图」和「只打字」哪个更容易被人接。
  for (let i = st.pending.length - 1; i >= 0; i -= 1) {
    const p = st.pending[i];
    if (p.key !== key) continue;
    if (at - Number(p.at) > CAUSAL_DEFAULTS.windowMs * 2) continue;
    p.spoke = true;
    p.spokeAt = at;
    if (style) p.style = style;
    if (predict !== null) p.predict = predict;
    break;
  }
  return st;
}

function settleOne(state, p, { at, outcome }) {
  const latencyMs = Math.max(0, at - Number(p.at));
  const rate = expectedRate(state.stats, p.source);
  const r = outcome === 'replied' ? 1 : 0;   // called_out 也是负面：被识破不算接住
  const surprise = Math.round(Math.abs(r - rate) * 100) / 100;
  const entry = {
    id: p.id, key: p.key, source: p.source, detail: String(p.detail || ''), at: p.at, spoke: Boolean(p.spoke),
    spokeAt: Number(p.spokeAt || 0), outcome, latencyMs, surprise, shownAt: 0,
  };
  // 2026-11-02：她猜的准不准。窗口用 15 分钟，不是 45——
  // 45 分钟那条是「这次主动行动有没有结果」，这里是「我说完这句话，15 分钟内有没有人接」。
  if (p.predict === 0 || p.predict === 1) {
    const gotReply = outcome === 'replied' && latencyMs <= CAUSAL_DEFAULTS.predictWindowMs;
    if (!state.stats.calibration) {
      state.stats.calibration = { saidYes: { n: 0, hit: 0 }, saidNo: { n: 0, hit: 0 }, lastPromptAt: 0 };
    }
    const bucket = p.predict === 1 ? state.stats.calibration.saidYes : state.stats.calibration.saidNo;
    bucket.n += 1;
    if ((p.predict === 1) === gotReply) bucket.hit += 1;
    entry.predict = p.predict;
    entry.predictedHit = (p.predict === 1) === gotReply;
  }
  state.log.push(entry);
  bump(state.stats, p.source, outcome);
  bumpStyle(state.stats, p.style, outcome);
  // 2026-11-03：夜里/高峰开口的后果也回流——她能看到「这个点说话有多少人接」。
  bumpTime(state.stats, Number(p.spokeAt || p.at), outcome);
  return entry;
}

/**
 * 有消息进来时结算该会话的 pending。
 *   spoke  → replied
 *   !spoke → came（场子自己热了，不算她的功劳）
 */
export function settleIncoming(state, { key, at = Date.now() } = {}) {
  const st = normalizeState(state);
  const events = [];
  const keep = [];
  for (const p of st.pending) {
    if (p.key !== key) { keep.push(p); continue; }
    if (at - Number(p.at) > CAUSAL_DEFAULTS.windowMs) { keep.push(p); continue; }
    events.push(settleOne(st, p, { at, outcome: p.spoke ? 'replied' : 'came' }));
  }
  st.pending = keep.slice(-CAUSAL_DEFAULTS.maxPending);
  st.log = st.log.slice(-CAUSAL_DEFAULTS.maxLog);
  return { state: st, events };
}

/**
 * 超窗结算（定时器调用）。
 *   spoke  → no_reply（说了没人接）
 *   !spoke → silent（只是看了一眼，不算失败）
 * 返回的 events 里 outcome==='no_reply' 的，调用方可以给一次情绪反馈。
 */
export function expirePending(state, { at = Date.now() } = {}) {
  const st = normalizeState(state);
  const events = [];
  const keep = [];
  for (const p of st.pending) {
    if (at - Number(p.at) <= CAUSAL_DEFAULTS.windowMs) { keep.push(p); continue; }
    // 结算时点用窗口末尾，延迟才不会算成 45 分钟整
    const endAt = Number(p.at) + CAUSAL_DEFAULTS.windowMs;
    events.push(settleOne(st, p, { at: endAt, outcome: p.spoke ? 'no_reply' : 'silent' }));
  }
  st.pending = keep.slice(-CAUSAL_DEFAULTS.maxPending);
  st.log = st.log.slice(-CAUSAL_DEFAULTS.maxLog);
  return { state: st, events };
}

/** 这条结算值不值得给一次「被冷落」的情绪反馈。 */
export function shouldFeelIgnored(state, event, { at = Date.now() } = {}) {
  const st = normalizeState(state);
  if (!event || event.outcome !== 'no_reply') return false;
  const last = Number(st.stats.lastIgnoredAt || 0);
  // last=0 表示从来没忽略过，不该被冷却挡住（否则第一次永远不触发）
  if (last && at - last < CAUSAL_DEFAULTS.ignoredCooldownMs) return false;
  return true;
}

/**
 * 生成一句提示。只在私聊、每天最多一句、优先意外的。
 * 返回 { state, line }；没有可说的就 line=''。
 */
export function promptLine(state, { isPrivate = false, at = Date.now(), opts = {} } = {}) {
  const st = normalizeState(state);
  const max = Number(opts.promptPerDay ?? CAUSAL_DEFAULTS.promptPerDay);
  const fresh = Number(opts.promptFreshMs ?? CAUSAL_DEFAULTS.promptFreshMs);
  if (!isPrivate) return { state: st, line: '' };
  if (st.stats.lastPromptDay === dayKey(at)) return { state: st, line: '' };

  const allow = Array.isArray(opts.sources) && opts.sources.length ? new Set(opts.sources) : null;
  const candidates = st.log
    .filter((e) => !allow || allow.has(e.source))
    .filter((e) => !e.shownAt && (e.outcome === 'replied' || e.outcome === 'no_reply' || e.outcome === 'called_out'))
    .filter((e) => at - Number(e.at) <= fresh)
    .sort((a, b) => {
      // 被识破 > 别的结果：这条最该让她知道
      const rank = (e) => (e.outcome === 'called_out' ? 2 : 1);
      return (rank(b) - rank(a)) || (b.surprise - a.surprise) || (b.at - a.at);
    });
  if (!candidates.length || max < 1) return { state: st, line: '' };

  const e = candidates[0];
  e.shownAt = at;
  st.stats.lastPromptDay = dayKey(at);
  // 一句陈述，不解释、不安慰、不问她问题。
  const who = String(e.key).startsWith('private:') ? '他' : '群里';
  let line;
  if (e.outcome === 'called_out') {
    line = `\n【因果】上次有人说你说话像 AI。不用解释，也不用证明自己不是——换个说法就行。\n`;
  } else if (e.outcome === 'replied') {
    line = `\n【因果】你上次主动找${who}，有人接了。\n`;
  } else {
    line = `\n【因果】你上次主动找${who}，没人接。\n`;
  }
  return { state: st, line };
}

/**
 * 「你说话的样子」——把风格统计接进因果核心（2026-11-02）。
 *
 * 主人问「群友的说话模式能不能学进去」。原来的 style-core 只比「谁长谁短」，
 * 没有结果反馈；这里改成**按结果**：短句/长句/问句这几种说法，哪一种更容易被人接。
 *
 * 和 promptLine 的区别：promptLine 每天一句、说的是「某次行动」；
 * 这个是**统计口径**：每天最多一次，样本不到 8 次不说——宁可不说，也别拿噪声指导她。
 * （原来写的是三天，主人说太慢：她一天说 40 多句，一天就够攒样本了。）
 */
export function styleStatLine(state, { at = Date.now(), minN = 8, cooldownMs = 24 * 3600 * 1000, opts = {} } = {}) {
  const st = normalizeState(state);
  const bs = st.stats.byStyle || {};
  const last = Number(opts.lastStylePromptAt ?? st.stats.lastStylePromptAt ?? 0);
  if (last && at - last < cooldownMs) return { state: st, line: '' };
  const rows = [];
  for (const [dim, s] of Object.entries(bs)) {
    const n = Number(s?.n) || 0;
    if (n < minN) continue;
    rows.push({ dim, n, replied: Number(s.replied) || 0 });
  }
  if (rows.length < 2) return { state: st, line: '' };
  const LABEL = {
    'len:short': '短句', 'len:medium': '中等长度', 'len:long': '长句',
    q: '问句', plain: '陈述句', list: '列点',
    particle: '带语气词', laugh: '带笑/草', reactive: '开头先应一声', quote: '引用着回',
    echo: '跟着群友复读',
    sticker: '配图/发图时',
    text: '只打字时',
  };
  // 优先展示「会说话的方式」那几维（不是长度），有数才说
  // 2026-11-02：把「发图 vs 只打字」放最前面——这是她最该先知道的对比，
  // 比句长句短有用得多。
  const FLAVOR = ['sticker', 'text', 'echo', 'reactive', 'laugh', 'particle', 'quote'];
  const flavored = rows.filter((r) => FLAVOR.includes(r.dim) && r.n >= minN);
  const picked = (flavored.length ? flavored : []).concat(rows.filter((r) => !FLAVOR.includes(r.dim)));
  // 按 FLAVOR 里的顺序排优先级（sticker 在最前），同档内按样本量降序
  const flavorRank = (d) => { const i = FLAVOR.indexOf(d); return i < 0 ? 999 : i; };
  picked.sort((a, b) => flavorRank(a.dim) - flavorRank(b.dim) || b.n - a.n);
  const parts = picked.slice(0, 3).map((r) => {
    // 复读这件事不按「有没有人接」算——她跟了就是跟了，那是她自己的尝试
    if (r.dim === 'echo') return `跟着复读 ${r.n} 次`;
    return `${LABEL[r.dim] || r.dim} ${r.n} 次里 ${r.replied} 次有人接`;
  });
  st.stats.lastStylePromptAt = at;
  return {
    state: st,
    line: `\n【你说话的样子】${parts.join('；')}。不用对着这个调，知道一下就行。\n`,
  };
}

/**
 * 「什么时候说话有人接」——夜里 / 高峰时段的统计（2026-11-03）。
 *
 * 为什么要有它：桥接在深夜只保留「有人直接叫她」的唤醒，白天的高峰时段也提醒她
 * 「这个点做同样的事贵一倍」。但**不做硬性禁止**——只把后果摆出来：
 * 夜里开口的回应率、高峰时段开口的回应率，和白天/空闲时比一比。
 *
 * 和 styleStatLine 一样：每天最多一次，样本不够不说，措辞不带评价。
 */
export function timeStatLine(state, { at = Date.now(), minN = 6, cooldownMs = 24 * 3600 * 1000 } = {}) {
  const st = normalizeState(state);
  const bt = st.stats.byTime || {};
  const last = Number(st.stats.lastTimePromptAt || 0);
  if (last && at - last < cooldownMs) return { state: st, line: '' };
  const g = (k) => ({ n: Number(bt[k]?.n) || 0, replied: Number(bt[k]?.replied) || 0 });
  const night = g('night');
  const day = g('day');
  const peak = g('peak');
  const off = g('off');
  const parts = [];
  if (night.n >= minN && day.n >= minN) {
    parts.push(`夜里开口 ${night.n} 次，${night.replied} 次有人接；白天 ${day.n} 次里 ${day.replied} 次`);
  }
  if (peak.n >= minN && off.n >= minN) {
    parts.push(`高峰时段开口 ${peak.n} 次里 ${peak.replied} 次有人接；空闲时 ${off.n} 次里 ${off.replied} 次`);
  }
  if (!parts.length) return { state: st, line: '' };
  st.stats.lastTimePromptAt = at;
  return {
    state: st,
    line: `\n【什么时候说话有人接】${parts.join('；')}。\n（只是个数字，不用照着改。真觉得某个点醒着没意思，自己安排就行。）\n`,
  };
}

/**
 * 「你猜的准不准」（2026-11-02）。
 *
 * 她从 2026-11-02 起可以在开口前猜一句「这句会不会有人接」。对账之后，这里把
 * 猜和实际对上的比例告诉她——但只说数字，不评价、不建议。
 *
 * 为什么不做成「你太乐观了」：一旦她把「预测准确率」当成要达成的指标，
 * 就会开始说安全的话、或者说「不会」来保命中率。那是表演，比不准更糟。
 *
 * 和 styleStatLine 的区别：那个说「哪种说法更容易被接」（策略），
 * 这个说「你以为的和实际差多少」（校准）。前者可以照着调，后者调不了，只能知道。
 */
export function predictionLine(state, { at = Date.now(), minN = 8, cooldownMs = 24 * 3600 * 1000 } = {}) {
  const st = normalizeState(state);
  const c = st.stats.calibration || {};
  const yes = c.saidYes || { n: 0, hit: 0 };
  const no = c.saidNo || { n: 0, hit: 0 };
  const last = Number(c.lastPromptAt || 0);
  if (last && at - last < cooldownMs) return { state: st, line: '' };
  if (Number(yes.n) < minN && Number(no.n) < minN) return { state: st, line: '' };

  const parts = [];
  if (Number(yes.n) >= minN) parts.push(`觉得「会有人接」的 ${yes.n} 次里，${yes.hit} 次真有人接`);
  if (Number(no.n) >= minN) parts.push(`觉得「不会」的 ${no.n} 次里，${no.hit} 次确实没人接`);
  if (!parts.length) return { state: st, line: '' };

  st.stats.calibration.lastPromptAt = at;
  return {
    state: st,
    line: `\n【你猜的准不准】${parts.join('；')}。\n（猜不准很正常。这条不用对着调——知道了就行。）\n`,
  };
}

/**
 * 场合失误：她说了只该私下讲的话，被主人当场点出来（2026-11-04）。
 *
 * 主人原话：「如果能让她用因果核心进行后果预判，比什么规则都好。」
 * 所以这里不写规则，只记「说过什么 → 他回了什么」这一对事实，
 * 在下次开口前把具体的上一次递回给她——让她自己推后果。
 */
export function noteSceneMiss(state, { key = '', at = Date.now(), mine = '', his = '' } = {}) {
  const st = normalizeState(state);
  const mineText = String(mine || '').trim().slice(0, 160);
  if (!mineText) return { state: st, added: false };
  // 同一条消息别重复记（主人可能连发两句）
  if (st.sceneMisses.some((m) => m.mine === mineText && Math.abs(Number(m.at) - at) < 10 * 60 * 1000)) {
    return { state: st, added: false };
  }
  st.sceneMisses.push({ at, key: String(key || ''), mine: mineText, his: String(his || '').trim().slice(0, 80) });
  if (st.sceneMisses.length > 20) st.sceneMisses = st.sceneMisses.slice(-20);
  return { state: st, added: true };
}

/**
 * 把最近一两次「场合失误」递回给她（不是命令，是让她自己推后果）。
 * 同一时段不重复注入：默认 6 小时最多一次。
 */
export function sceneLine(state, { at = Date.now(), maxAgeDays = 14, cooldownMs = 6 * 3600 * 1000, lookback = 2 } = {}) {
  const st = normalizeState(state);
  const last = Number(st.stats.lastScenePromptAt || 0);
  if (last && at - last < cooldownMs) return { state: st, line: '' };
  const since = at - maxAgeDays * 86400000;
  const rows = st.sceneMisses.filter((m) => Number(m.at) >= since).slice(-lookback);
  if (!rows.length) return { state: st, line: '' };

  const fmt = (ts) => {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const clipped = (s, n) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));
  const lines = rows.map((m) => {
    const his = m.his ? `，他回你「${clipped(m.his, 30)}」` : '';
    return `- ${fmt(Number(m.at))} 你在群里说了「${clipped(m.mine, 48)}」${his}`;
  });
  st.stats.lastScenePromptAt = at;
  return {
    state: st,
    line: `\n【上次这样说之后】\n${lines.join('\n')}\n`
      + '这次开口前可以先过一下：这句要是被所有人都看到，会怎样；想不清也不用勉强，可以先不说。\n'
      + '（说不说、怎么说，你自己拿主意，我不规定。）\n',
  };
}

/**
 * 「别人让你做事之后」（2026-11-04）。
 *
 * 主人：「能不能让她多用因果核心来判断。」所以把她自己攒的那点经验递回去：
 * 拒绝过几次、拒绝之后对方还接着说的比例——不是评分，是她自己看。
 * bySource 里的 `request:refuse` / `request:accept` 由桥接在她回话时记。
 */
export function requestLine(state, { at = Date.now(), minN = 5, cooldownMs = 24 * 3600 * 1000 } = {}) {
  const st = normalizeState(state);
  const last = Number(st.stats.lastRequestPromptAt || 0);
  if (last && at - last < cooldownMs) return { state: st, line: '' };
  const refuse = st.stats.bySource?.['request:refuse'] || { n: 0, replied: 0 };
  const accept = st.stats.bySource?.['request:accept'] || { n: 0, replied: 0 };
  const total = Number(refuse.n || 0) + Number(accept.n || 0);
  if (total < minN) return { state: st, line: '' };
  const parts = [];
  if (Number(refuse.n)) parts.push(`你推掉过 ${refuse.n} 次，其中 ${Number(refuse.replied) || 0} 次对方还接着跟你说话`);
  if (Number(accept.n)) parts.push(`你顺着做过 ${accept.n} 次，其中 ${Number(accept.replied) || 0} 次有人接`);
  if (!parts.length) return { state: st, line: '' };
  st.stats.lastRequestPromptAt = at;
  return {
    state: st,
    line: `\n【有人找你之后】\n- ${parts.join('；')}。\n（没有好坏。推掉之后场子散没散，你自己看。）\n`,
  };
}

/** 给监控台/排查看的一句话摘要。 */
export function summarize(state) {  const st = normalizeState(state);
  const last = st.log[st.log.length - 1] || null;
  return {
    pending: st.pending.length,
    log: st.log.length,
    last: last ? { at: last.at, outcome: last.outcome, spoke: last.spoke, surprise: last.surprise } : null,
    bySource: st.stats.bySource,
    lastPromptDay: st.stats.lastPromptDay,
  };
}

/**
 * 最近的行动 + 结果，压成一份事实清单（不带评价、不给建议）。
 * 2026-11-01：原来这些结果只有「每天一句」，大部分记录没被用到。
 * 这里是给她自己复盘用的素材：什么时候、在哪、做了什么、后来怎样。
 */
export function outcomeBrief(state, { hours = 24, limit = 8, at = Date.now() } = {}) {
  const st = normalizeState(state);
  const cutoff = at - Number(hours) * 3600 * 1000;
  const rows = st.log.filter((e) => Number(e.at) >= cutoff).slice(-limit);
  if (!rows.length) return '';
  const what = (src) => {
    if (src === 'tool:search') return '搜了点东西';
    if (src === 'tool:bili') return '翻了 B 站';
    if (src === 'tool:voice') return '发了语音';
    if (src === 'drive') return '主动找了个话头';
    if (src === 'purpose') return '按自己惦记的事动了动';
    return '做了点什么';
  };
  const outcome = (e) => {
    if (e.outcome === 'replied') return '有人接';
    if (e.outcome === 'no_reply') return '没人接';
    if (e.outcome === 'came') return '你没开口，场子自己热了';
    if (e.outcome === 'silent') return '你只是看了看，没说话';
    if (e.outcome === 'called_out') return '有人觉得你说话不像人';
    return String(e.outcome || '');
  };
  const lines = rows.map((e) => {
    const d = new Date(Number(e.at));
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const where = String(e.key).startsWith('private:') ? '私聊' : '群里';
    return `- ${hh}:${mm} 在${where}${what(e.source)} → ${outcome(e)}`;
  });
  return `\n【你最近自己做过的事，后来怎样了】\n${lines.join('\n')}\n`;
}

export const __test = { emptyState, normalizeState, expectedRate, noteAction, noteSpoke, settleIncoming, expirePending, promptLine, shouldFeelIgnored, outcomeBrief, timeStatLine };
