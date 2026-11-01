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
export const CALLED_OUT_RE = /八股|像\s*AI|像\s*ai|AI\s*味|ai\s*味|机器人|程序写|生成的|不像人|太假|演的/i;

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
});

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

/** 本地日期 key（凌晨也算今天，不按 UTC）。 */
export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function emptyState() {
  return { version: CAUSAL_VERSION, pending: [], log: [], stats: { bySource: {}, lastPromptDay: '', lastIgnoredAt: 0 } };
}

/** 规整从磁盘读到的状态，防止旧版本/坏文件把逻辑搞崩。 */
export function normalizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  const pending = Array.isArray(raw.pending) ? raw.pending.filter((x) => x && x.key && Number(x.at)) : [];
  const log = Array.isArray(raw.log) ? raw.log.filter((x) => x && x.key && Number(x.at)) : [];
  return {
    version: CAUSAL_VERSION,
    pending: pending.slice(-CAUSAL_DEFAULTS.maxPending),
    log: log.slice(-CAUSAL_DEFAULTS.maxLog),
    stats: {
      bySource: raw.stats && typeof raw.stats.bySource === 'object' ? raw.stats.bySource : {},
      lastPromptDay: String(raw.stats?.lastPromptDay || ''),
      lastIgnoredAt: Number(raw.stats?.lastIgnoredAt || 0),
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
export function noteSpoke(state, { key, at = Date.now() } = {}) {
  const st = normalizeState(state);
  for (let i = st.pending.length - 1; i >= 0; i -= 1) {
    const p = st.pending[i];
    if (p.key !== key) continue;
    if (at - Number(p.at) > CAUSAL_DEFAULTS.windowMs * 2) continue;
    p.spoke = true;
    p.spokeAt = at;
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
  state.log.push(entry);
  bump(state.stats, p.source, outcome);
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

/** 给监控台/排查看的一句话摘要。 */
export function summarize(state) {
  const st = normalizeState(state);
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

export const __test = { emptyState, normalizeState, expectedRate, noteAction, noteSpoke, settleIncoming, expirePending, promptLine, shouldFeelIgnored, outcomeBrief };
