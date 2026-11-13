/**
 * 半括号「（」机制（task-47，2026-11-10）
 *
 * 纯函数，不改行为/不接 bridge：
 *   - 括号率统计 + 软自检行（影子用）
 *   - 研究任务闭环检测（只检测、不替她写结论，不写 goals/memory）
 *
 * 设计原则：不写硬规则；软提示给事实+她自己的例子+开放问题；
 * 频率 ≤1 次/3h/会话；不拦截、不改写。
 */

export const BRACKET_DEFAULTS = Object.freeze({
  windowSentences: 20,      // 最近 N 句
  windowMessages: 20,       // 最近 N 条消息（消息级含率用）
  rateThreshold: 0.60,      // 句尾「（」比例 ≥60%
  containRateThreshold: 0.70, // 消息级「含（」比例 ≥70%
  consecutive: 3,           // 或连续 3 句句尾都带
  consecutiveContain: 3,    // 或连续 3 句含「（」（含句中）
  cooldownMs: 3 * 3600 * 1000,
  maxExamples: 3,
});

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 把一段话拆成句子（保留语气，不丢标点）。 */
export function splitSentences(text) {
  const t = String(text || '').replace(/\r/g, '').trim();
  if (!t) return [];
  const parts = t.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) || [];
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** 句尾是否是半个「（」（允许末尾空白；完整「（）」不算）。 */
export function endsWithHalfBracket(sentence) {
  const s = String(sentence || '').replace(/\s+$/, '');
  if (!s) return false;
  if (!/[（(]$/.test(s)) return false;
  // 完整成对（…）结尾不算「半个」
  if (/[（(][^（()）]*[）)]$/.test(s)) return false;
  return true;
}

/** 是否含半括号（句尾或句中，如「看得见（ 有点羞」）。 */
export function containsBracket(text) {
  return /[（(]/.test(String(text || ''));
}

/** 把消息列表摊平成句子（保留 key/at/time 供 shadow 用）。 */
export function flattenSelfSentences(messages = []) {
  const out = [];
  for (const m of messages) {
    const text = typeof m === 'string' ? m : String(m?.text ?? '');
    const at = typeof m === 'string' ? null : m?.at ?? null;
    const key = typeof m === 'string' ? null : m?.key ?? m?.conversationKey ?? null;
    for (const s of splitSentences(text)) out.push({ text: s, at, key, raw: text });
  }
  return out;
}

/** 统计最近 N 句的括号率/连续数。 */
export function bracketStyleStats(recentSelfMessages = [], options = {}) {
  const cfg = { ...BRACKET_DEFAULTS, ...options };
  const allSentences = flattenSelfSentences(recentSelfMessages);
  const sentences = allSentences.slice(-cfg.windowSentences);
  const messages = (Array.isArray(recentSelfMessages) ? recentSelfMessages : []).slice(-cfg.windowMessages);
  const flags = sentences.map((s) => endsWithHalfBracket(s.text));
  const trailing = flags.filter(Boolean).length;
  const rate = sentences.length ? +(trailing / sentences.length).toFixed(3) : 0;
  const messageHas = messages.map((m) => containsBracket(typeof m === 'string' ? m : (m?.text ?? '')));
  const sentHas = sentences.map((s) => containsBracket(s.text));
  const messageContain = messageHas.filter(Boolean).length;
  const messageContainRate = messages.length ? +(messageContain / messages.length).toFixed(3) : 0;
  const sentenceContain = sentHas.filter(Boolean).length;
  const sentenceContainRate = sentences.length ? +(sentenceContain / sentences.length).toFixed(3) : 0;
  let consecutive = 0;
  for (let i = flags.length - 1; i >= 0; i--) { if (flags[i]) consecutive += 1; else break; }
  let consecutiveContain = 0;
  for (let i = sentHas.length - 1; i >= 0; i--) { if (sentHas[i]) consecutiveContain += 1; else break; }
  let reason = 'none';
  if (sentences.length >= 3 && rate >= cfg.rateThreshold) reason = 'rate';
  else if (sentences.length >= 3 && consecutive >= cfg.consecutive) reason = 'consecutive';
  else if (messages.length >= 3 && messageContainRate >= cfg.containRateThreshold) reason = 'message-contain';
  else if (sentences.length >= 3 && consecutiveContain >= cfg.consecutiveContain) reason = 'consecutive-contain';
  const high = reason !== 'none';
  return {
    sentences: sentences.length, trailing, rate, consecutive,
    messages: messages.length, messageContain, messageContainRate,
    sentenceContain, sentenceContainRate, consecutiveContain,
    high, reason, window: sentences, flags,
  };
}

/** 软自检行：不高返回 null；高则给 2~3 条她自己的例子 + 开放问题。 */
export function bracketStyleLine(recentSelfMessages = [], options = {}) {
  const cfg = { ...BRACKET_DEFAULTS, ...options };
  const st = bracketStyleStats(recentSelfMessages, cfg);
  if (!st.high) return null;
  const source = st.window.filter((s) => containsBracket(s.text));
  const examples = source.slice(-cfg.maxExamples).map((s) => s.text.replace(/\s+$/, ''));
  if (examples.length < 2) return null;
  const quote = examples.map((s) => `『${s.length > 34 ? s.slice(0, 32) + '…' : s}』`).join('');
  let lead;
  if (st.reason === 'rate') lead = `最近 ${st.sentences} 句里有 ${st.trailing} 句句尾带着「（」：${quote}`;
  else if (st.reason === 'consecutive') lead = `连着 ${st.consecutive} 句句尾都带着「（」：${quote}`;
  else if (st.reason === 'consecutive-contain') lead = `连着 ${st.consecutiveContain} 句都带着「（」：${quote}`;
  else lead = `最近 ${st.messages} 条消息里有 ${st.messageContain} 条带着「（」（不少在句子中间）：${quote}`;
  const line = `${lead}。挑一两句想想：这句是玩笑、补充、软化，还是正经事？如果是正经事、或者情绪重，也可以不带——你看着来。`;
  return { line, stats: st, examples, reason: st.reason };
}

/** 冷却：默认 3h/会话。lastShownAt 为 null 视为从未显示。 */
export function shouldShowBracketLine({ now = Date.now(), lastShownAt = null, cooldownMs = BRACKET_DEFAULTS.cooldownMs } = {}) {
  if (lastShownAt == null) return true;
  return Number(now) - Number(lastShownAt) >= Number(cooldownMs);
}

/** 研究任务闭环检测（只检测；不替她写结论、不改 goals/memory）。 */
export function detectBracketResearch({ selfTexts = [], roomTexts = [], goal = null } = {}) {
  const evidence = [];
  const phrase = /(研究[:：]?\s*括号|括号(?:研究|用法|怎么用|的用法)|半个括号|半括号)/;
  for (const t of selfTexts) if (phrase.test(String(t || ''))) evidence.push({ source: 'self', text: String(t).slice(0, 200) });
  for (const t of roomTexts) if (phrase.test(String(t || ''))) evidence.push({ source: 'room', text: String(t).slice(0, 400) });
  const goalDone = !!(goal && String(goal.status || '').toLowerCase() === 'done' && /括号/.test(String(goal.text || '')));
  if (goalDone) evidence.push({ source: 'goal-done', text: String(goal.doneNote || goal.text || '').slice(0, 200) });
  const goalOpen = !!(goal && String(goal.status || '').toLowerCase() === 'open' && /括号/.test(String(goal.text || '')));
  // 她的结论只摘录、不重写：取 room 里「研究：括号」之后的一小段（不加工）
  let herConclusion = '';
  for (const t of roomTexts) {
    const m = String(t || '').match(/研究[:：]\s*括号[\s\S]{0,260}/);
    if (m) { herConclusion = m[0].trim().slice(0, 260); break; }
  }
  const detected = evidence.length > 0;
  return {
    detected,
    goalStatus: goal ? String(goal.status || '') : '',
    goalOpen,
    goalDone,
    evidence: evidence.slice(0, 5),
    herConclusion,
    memoryHandoff: detected ? { action: 'memory-digest-handoff', herConclusion, evidence: evidence.slice(0, 5), doNotRewrite: true } : null,
  };
}


/** 注入接线配置（Phase 2，默认 off；不部署）。 */
export const BRACKET_CFG_DEFAULTS = Object.freeze({ mode: 'off', windowSentences: 20, windowMessages: 20, rateThreshold: 0.60, containRateThreshold: 0.70, consecutive: 3, consecutiveContain: 3, cooldownMs: 3 * 3600 * 1000, maxExamples: 3 });

export function resolveBracketStyleConfig(cfg = {}) {
  // 兼容两种调用：完整 config，或已经取出的 socialV2.bracketStyle 子对象（bridge 现网传的是后者）
  const sub = cfg && typeof cfg === 'object' && (cfg.mode !== undefined || cfg.windowSentences !== undefined || cfg.rateThreshold !== undefined || cfg.containRateThreshold !== undefined || cfg.cooldownMs !== undefined) ? cfg : null;
  const pc = cfg?.socialV2?.bracketStyle || sub || {};
  const raw = String(pc.mode ?? 'off').toLowerCase();
  const mode = raw === 'shadow' || raw === 'inject' ? raw : 'off';
  const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
  return {
    mode,
    windowSentences: Math.round(num(pc.windowSentences, BRACKET_CFG_DEFAULTS.windowSentences, 5, 80)),
    windowMessages: Math.round(num(pc.windowMessages, BRACKET_CFG_DEFAULTS.windowMessages, 5, 80)),
    rateThreshold: num(pc.rateThreshold, BRACKET_CFG_DEFAULTS.rateThreshold, 0.3, 1),
    containRateThreshold: num(pc.containRateThreshold, BRACKET_CFG_DEFAULTS.containRateThreshold, 0.3, 1),
    consecutive: Math.round(num(pc.consecutive, BRACKET_CFG_DEFAULTS.consecutive, 2, 10)),
    consecutiveContain: Math.round(num(pc.consecutiveContain, BRACKET_CFG_DEFAULTS.consecutiveContain, 2, 10)),
    cooldownMs: Math.round(num(pc.cooldownMs, BRACKET_CFG_DEFAULTS.cooldownMs, 60 * 1000, 24 * 3600 * 1000)),
    maxExamples: Math.round(num(pc.maxExamples, BRACKET_CFG_DEFAULTS.maxExamples, 2, 3)),
  };
}

/** 从 social-v2 recentMessages 取她最近说的话（按时间正序，过滤媒体占位）。 */
export function collectRecentSelfTexts(recentMessages = [], limit = 60) {
  const arr = Array.isArray(recentMessages) ? recentMessages : [];
  const out = [];
  for (const m of arr) {
    if (!m || !m.isSelf) continue;
    const t = String(m.text ?? m.plain ?? '').trim();
    if (!t || /^\[(图片|表情|语音|拍一拍)/.test(t)) continue;
    out.push(t);
  }
  return out.slice(-Math.max(1, Number(limit) || 60));
}

/**
 * 唤醒时的接线入口（纯函数）：
 *  - off: 不统计、不写日志、不进 prompt
 *  - shadow: 统计并生成 shadowRecord（line 不注入）
 *  - inject: 冷却通过才 show=true 并注入 line；调用方负责写冷却/日志
 */
export function bracketStyleEmit({ cfg = BRACKET_CFG_DEFAULTS, recentSelfMessages = [], key = '', now = Date.now(), lastShownAt = null } = {}) {
  const c = { ...BRACKET_CFG_DEFAULTS, ...(cfg || {}) };
  if (c.mode === 'off') return { mode: 'off', show: false, line: '', shadowRecord: null, reason: 'off' };
  const result = bracketStyleLine(recentSelfMessages, {
    windowSentences: c.windowSentences, windowMessages: c.windowMessages, rateThreshold: c.rateThreshold, containRateThreshold: c.containRateThreshold, consecutive: c.consecutive, consecutiveContain: c.consecutiveContain, cooldownMs: c.cooldownMs, maxExamples: c.maxExamples,
  });
  if (!result) return { mode: c.mode, show: false, line: '', shadowRecord: null, reason: 'not-high' };
  const canInject = c.mode === 'inject' && shouldShowBracketLine({ now, lastShownAt, cooldownMs: c.cooldownMs });
  const rec = bracketShadowRecord({ at: now, key, result, emitted: canInject, skippedReason: canInject ? '' : (c.mode === 'inject' ? 'cooldown-3h' : 'shadow-only') });
  rec.mode = c.mode; rec.source = 'bridge';
  return { mode: c.mode, show: canInject, line: canInject ? result.line : '', shadowRecord: rec, reason: canInject ? 'high-inject' : (c.mode === 'inject' ? 'cooldown' : 'high-shadow') };
}

/** shadow 记录 schema。 */
export function bracketShadowRecord({ at = Date.now(), key = '', result = null, emitted = false, skippedReason = '' } = {}) {
  const st = result?.stats || result || {};
  return {
    t: 'bracket-style', at: new Date(at).toISOString(), key,
    stats: { sentences: Number(st.sentences) || 0, trailing: Number(st.trailing) || 0, rate: Number(st.rate) || 0, consecutive: Number(st.consecutive) || 0, reason: st.reason || 'none' },
    high: !!st.high, emitted: !!emitted, skippedReason: skippedReason || null,
    line: emitted ? String(result?.line || '') : '',
    examples: Array.isArray(result?.examples) ? result.examples.slice(0, 3) : [],
  };
}
