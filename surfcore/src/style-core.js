/**
 * 风格层（2026-11-01）—— 纯逻辑，零 I/O。
 *
 * 要解决的问题：
 *   群友说她「鱼八股」。因果核心只能测「有没有人接」，测不了「像不像人」；
 *   她的 AI 味集中在句级特征：句子太长、爱列点、几乎不问问题、每句都完整。
 *
 * 做法：
 *   只统计，不评分。拿她最近几条的长度/列点/提问比例，和同群的人比；
 *   偏离明显时给一句提醒，每天最多一次。不告诉她「你在被评估」，也不给数字。
 *
 * 刻意不做：
 *   · 不做「像不像人」的分数（会被优化）
 *   · 不纠正内容，只管形式
 *   · 不跨群混算（每个群有自己的节奏）
 */

export const STYLE_DEFAULTS = Object.freeze({
  enabled: true,
  selfWindow: 8,      // 她自己最近几条
  otherWindow: 24,    // 群友最近几条
  minSelf: 4,         // 至少几条才说话
  longRatio: 2.2,     // 比群里平均长这么多倍才算「长」
  listRatio: 0.4,     // 列点比例
  dailyLimit: 1,
});

const q = (s) => String(s ?? '').replace(/\s+/g, '');

export function emptyStyle() {
  return { byKey: {} };
}

export function normalizeStyle(raw) {
  const base = emptyStyle();
  if (!raw || typeof raw !== 'object' || !raw.byKey || typeof raw.byKey !== 'object') return base;
  for (const [k, v] of Object.entries(raw.byKey)) {
    if (!v || typeof v !== 'object') continue;
    base.byKey[k] = {
      selfLens: Array.isArray(v.selfLens) ? v.selfLens.map(Number).filter((n) => Number.isFinite(n)).slice(-STYLE_DEFAULTS.selfWindow) : [],
      otherLens: Array.isArray(v.otherLens) ? v.otherLens.map(Number).filter((n) => Number.isFinite(n)).slice(-STYLE_DEFAULTS.otherWindow) : [],
      selfQ: Number(v.selfQ) || 0,
      selfList: Number(v.selfList) || 0,
      selfN: Number(v.selfN) || 0,
      lastPromptDay: String(v.lastPromptDay || ''),
    };
  }
  return base;
}

function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 记一条样本。self=true 是她说的话，false 是群友。 */
export function recordSample(state, { key, self = false, text = '', at = Date.now() } = {}) {
  const st = normalizeStyle(state);
  if (!key) return st;
  const body = q(text);
  if (!body || body.length < 2) return st;
  const bucket = st.byKey[key] || (st.byKey[key] = { selfLens: [], otherLens: [], selfQ: 0, selfList: 0, selfN: 0, lastPromptDay: '' });
  if (self) {
    bucket.selfLens.push(body.length);
    bucket.selfLens = bucket.selfLens.slice(-STYLE_DEFAULTS.selfWindow);
    bucket.selfN += 1;
    if (/[？?]|吗[。！？!?]?$|呢[。！？!?]?$/.test(body)) bucket.selfQ += 1;
    if (/[：:]/.test(body) || /(^|\s)[1-9][.、]/.test(body) || (body.match(/、/g) || []).length >= 3) bucket.selfList += 1;
  } else {
    bucket.otherLens.push(body.length);
    bucket.otherLens = bucket.otherLens.slice(-STYLE_DEFAULTS.otherWindow);
  }
  return st;
}

const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

/**
 * 偏离明显时给一句提醒。每天最多一次，不报数字。
 * 返回 { state, line }；没有可说的 line=''。
 */
export function styleLine(state, { key, at = Date.now(), opts = {} } = {}) {
  const st = normalizeStyle(state);
  const bucket = st.byKey[key];
  if (!bucket) return { state: st, line: '' };
  const dailyLimit = Number(opts.dailyLimit ?? STYLE_DEFAULTS.dailyLimit);
  if (bucket.lastPromptDay === dayKey(at)) return { state: st, line: '' };
  if (bucket.selfN < Number(opts.minSelf ?? STYLE_DEFAULTS.minSelf)) return { state: st, line: '' };

  const selfAvg = avg(bucket.selfLens);
  const otherAvg = avg(bucket.otherLens);
  const listRatio = bucket.selfN ? bucket.selfList / bucket.selfN : 0;
  const qRatio = bucket.selfN ? bucket.selfQ / bucket.selfN : 0;

  let line = '';
  if (otherAvg > 6 && selfAvg > otherAvg * Number(opts.longRatio ?? STYLE_DEFAULTS.longRatio)) {
    line = '\n【说话的节奏】你最近几条比群里长不少，像在解释。短一点，或者只说半句，剩下的让他们问。\n';
  } else if (listRatio >= Number(opts.listRatio ?? STYLE_DEFAULTS.listRatio)) {
    line = '\n【说话的节奏】你最近几条里，有一半在列点。聊天不是写方案——拆成一句一句说，或者只说一条。\n';
  } else if (bucket.selfN >= 6 && qRatio < 0.1) {
    line = '\n【说话的节奏】你最近几乎不问问题。聊天可以只接半句，也可以反问一句；不用每条都答完整。\n';
  }
  if (!line || dailyLimit < 1) return { state: st, line: '' };
  bucket.lastPromptDay = dayKey(at);
  return { state: st, line };
}

export function summarize(state) {
  const st = normalizeStyle(state);
  const out = {};
  for (const [k, v] of Object.entries(st.byKey)) {
    out[k] = {
      selfAvg: Math.round(avg(v.selfLens)),
      otherAvg: Math.round(avg(v.otherLens)),
      selfN: v.selfN,
      listRatio: v.selfN ? Math.round((v.selfList / v.selfN) * 100) / 100 : 0,
      qRatio: v.selfN ? Math.round((v.selfQ / v.selfN) * 100) / 100 : 0,
    };
  }
  return out;
}

export const __test = { emptyStyle, normalizeStyle, recordSample, styleLine, summarize };
