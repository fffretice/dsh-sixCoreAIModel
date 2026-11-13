/**
 * 说话前先读一遍（2026-11-04）—— 纯逻辑，零 I/O。
 *
 * 要解决的问题：
 *   「鱼八股」不是措辞问题，是**一次说太多**。她那套话总是完整、周到、
 *   有开场有铺垫有总结；群里真人说的是半句，剩下让对方问。
 *
 * 做法（老大的流程）：
 *   提示 → 自己读一遍 → 再读一遍 → 根据情况拆条
 *
 *   桥接这边不做改写、不调模型 —— 它只负责一件事：
 *   **一句话太长的时候，先别发出去，让她自己读一遍再说。**
 *   这是「发送前的一次刹车」，不是润色器。
 *
 * 为什么不在桥接里自动改写：
 *   · 桥接没有独立模型凭据（她走 DSH 的账号授权），要多一条链路和一份 key；
 *   · 每次改写多 2~3 秒，群里抢话等不起；
 *   · 更要紧的是：改写器只会删字，不会替她想「这句到底该说什么」。
 *
 * 刻意不做：
 *   · 不评分、不记谁被拦了几次（那会变成新的应试指标）
 *   · 不改内容、不改语气，只按长度/句数判断「值不值得先读一遍」
 *   · 不拦私聊（一对一本来就该说完整）
 */

export const VOICE_TRIM_DEFAULTS = Object.freeze({
  enabled: true,
  // 超过这么多字，才值得先读一遍。她平时中位 14 字，28 字基本就是「在解释」。
  minChars: 28,
  // 或者句末标点这么多，也算「一口气说太多」。
  minSentences: 3,
  // 同会话冷却：刚拦过就别连着拦，不然她一急就更长。
  cooldownMs: 90 * 1000,
  // 只对群生效。
  groupsOnly: true,
});

const SENTENCE_END = /[。！？!?…~～]/g;

/** 去掉空白后的长度（跟 style-core 的口径一致）。 */
export function bodyLength(text) {
  return String(text ?? '').replace(/\s+/g, '').length;
}

/** 粗略数句：按句末标点切，末段没标点也算一句。 */
export function sentenceCount(text) {
  const body = String(text ?? '').replace(/\s+/g, '');
  if (!body) return 0;
  const marks = (body.match(SENTENCE_END) || []).length;
  const tail = /[。！？!?…~～]$/.test(body) ? 0 : 1;
  return marks + tail;
}

function hasListShape(text) {
  const body = String(text ?? '');
  if (/[：:]/.test(body)) return true;
  if (/(^|\n)\s*[1-9][.、]/.test(body)) return true;
  if ((body.match(/、/g) || []).length >= 3) return true;
  return false;
}

/**
 * 这句要不要先读一遍？
 * 返回 { trim, reason, chars, sentences }；trim=false 时 reason=''。
 */
export function shouldTrim(text, { key = '', opts = {} } = {}) {
  const o = { ...VOICE_TRIM_DEFAULTS, ...opts };
  if (!o.enabled) return { trim: false, reason: '', chars: 0, sentences: 0 };
  const chars = bodyLength(text);
  const sentences = sentenceCount(text);
  if (o.groupsOnly && !String(key).startsWith('group:')) {
    return { trim: false, reason: '', chars, sentences };
  }
  if (!chars) return { trim: false, reason: '', chars, sentences };
  if (chars > Number(o.minChars)) return { trim: true, reason: 'long', chars, sentences };
  if (sentences >= Number(o.minSentences)) return { trim: true, reason: 'many-sentences', chars, sentences };
  if (hasListShape(text) && chars > 20) return { trim: true, reason: 'list', chars, sentences };
  return { trim: false, reason: '', chars, sentences };
}

/**
 * 拦下来时给她看的话。
 * 写得像提醒，不像报错 —— 她不是犯错，是话说太顺了。
 *
 * 2026-11-08 傍晚修（老大反馈）：原来只教「删/缩」，没要求「缩完还能独立看懂」。
 * 案例 16:59 群 1000000004：原文「15一只，那还挑什么，直接一笼上汽（」被 [voice-fact] 拦下，
 * 她按「挑一半说就行」只留后半，发出「这价直接一笼上汽（」——群里没看到「15一只」的人看不懂。
 * 所以提示里现在必须写清：压完的句子要能脱离前文成立，指代要有落脚点。
 */
export function trimHint({ chars = 0, sentences = 0 } = {}) {
  const size = sentences >= 2 ? `${chars} 字、${sentences} 句` : `${chars} 字`;
  return [
    `【先等一下】这句 ${size}，先别发。`,
    '看一遍：有没有哪一句删了也不影响意思？有就删。',
    '再看一遍：能只留半句吗？能——但留下的那半句要能**独立看懂**。',
    '指代（这/那/它/他/她）得有落脚点，别把前提留在被删掉的那半句里。',
    '补不出前提就加一句背景；实在压不动就不压，或者换一句说。',
    '压完自己读一遍：群里没看到前文的人，这句能看懂吗？',
    '没说完的话，再发一条补完——补具体的，不是解释刚才那句为什么那么说。',
    '读完了，把改好的发出来就行。',
  ].join('\n');
}

/**
 * 冷却判定：同会话刚拦过就别再拦。
 * 只读一个时间戳，不新增持久字段。
 */
export function inCooldown(lastBlockedAt, { at = Date.now(), opts = {} } = {}) {
  const o = { ...VOICE_TRIM_DEFAULTS, ...opts };
  const last = Number(lastBlockedAt) || 0;
  if (!last) return false;
  return at - last < Number(o.cooldownMs);
}

// ────────────────────────────────────────────────────────────────
// 同一个动作说两遍之后（2026-11-04 老大提的）
//
// 长度门槛抓不到她真正的八股：她从来不说长话（中位 15 字），
// 但会**用同一个动作连做六遍**——把对方的梗接住、往上再推一格。
// 单看每句都不八股，连着读才像复读机。
//
// 所以这里判的不是「句子长不长」，是「最近两条是不是同一个动作」：
//   短 · 没有问句 · 两段式（中间有逗号）· 长度接近
// 连续两条这样，第三条就拦一下，让她用因果核心看一眼自己这种说法
// 到底有没有人接——有人接就接着说，没人接就换个做法。
//
// 判据故意留得糙：精确判断「是不是同一个模板」需要读懂语义，
// 那要么调模型（贵、慢），要么写一堆正则（脆）。
// 现在是「糙判据触发、她自己判断」——拦下来那段话里会说清楚
// 「是不是同一个动作，你自己看」，她否认就照原样发。
// ────────────────────────────────────────────────────────────────

export const REPEAT_DEFAULTS = Object.freeze({
  enabled: true,
  // 至少连着两条这样，第三条才管。
  minStreak: 2,
  // 超过这个长度就不算「接一句就跑」，不参与判重。
  maxChars: 25,
  // 两条长度差超过这么多就不算同一个动作。
  maxLenGap: 8,
  // 同会话 3 分钟只拦一次（和长度门槛的 90 秒分开算，这个更烦人，所以更宽）。
  cooldownMs: 3 * 60 * 1000,
});

/** 问句判定：结尾问号，或者「吗/呢/吧」收尾的短句。 */
export function isQuestion(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (/[？?]/.test(t)) return true;
  return /(吗|呢|吧|么)[（(]?$/.test(t);
}

/** 表情、图片这类不算「一句话」，不参与判重。 */
export function isSpeech(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (/^\[(表情|表情包|图片|语音|转发)/.test(t)) return false;
  return bodyLength(t) >= 2;
}

/**
 * 两条是不是「同一个动作」。
 * 判据：都短、都没有问句、都是两段式、长度接近。
 */
export function looksLikeSameMove(a, b, { opts = {} } = {}) {
  const o = { ...REPEAT_DEFAULTS, ...opts };
  const ta = String(a ?? '').trim();
  const tb = String(b ?? '').trim();
  if (!ta || !tb) return false;
  const la = bodyLength(ta);
  const lb = bodyLength(tb);
  if (la > Number(o.maxChars) || lb > Number(o.maxChars)) return false;
  if (isQuestion(ta) || isQuestion(tb)) return false;
  if (Math.abs(la - lb) > Number(o.maxLenGap)) return false;
  // 两段式：都有逗号隔开。她那种「接一句、再推一格」的长相都在这儿。
  if (!/[，,]/.test(ta) || !/[，,]/.test(tb)) return false;
  return true;
}

/**
 * 从她自己最近说的话里，算出结尾连着几条是同一个动作。
 * mine 按时间正序传入（旧→新）。
 */
export function repeatStreak(mine, { opts = {} } = {}) {
  const o = { ...REPEAT_DEFAULTS, ...opts };
  if (!o.enabled) return 0;
  const list = (Array.isArray(mine) ? mine : []).filter(isSpeech);
  let streak = 0;
  for (let i = list.length - 1; i > 0; i -= 1) {
    if (looksLikeSameMove(list[i - 1], list[i], { opts })) streak += 1;
    else break;
  }
  return streak;
}

/**
 * 拦下来时说的话。
 * stats 是因果核心的 byStyle（可选）；有数就把「这种说法几次里有人接」摆出来，
 * 没有就不提——不编数字。
 */
export function repeatHint({ streak = 2, stats = null } = {}) {
  const lines = [
    `【又来了】你最近连着 ${streak + 1} 条都是同一个动作：短、接一句、不往下问。`,
    '自己看一眼：是不是在把对方的话再往上推一格？',
  ];
  const plain = stats && typeof stats === 'object' ? stats.plain : null;
  const n = Number(plain?.n) || 0;
  const replied = Number(plain?.replied) || 0;
  if (n >= 10) lines.push(`（你这种陈述句，${n} 次里 ${replied} 次有人接。）`);
  lines.push('有人接就接着说；没人接就换个做法——问一句、说不知道、或者干脆不接。');
  lines.push('如果你觉得这不算同一个动作，就照原样发，不用改。');
  return lines.join('\n');
}

/**
 * 判重冷却：比长度门槛宽松，3 分钟只拦一次。
 */
export function inRepeatCooldown(lastBlockedAt, { at = Date.now(), opts = {} } = {}) {
  const o = { ...REPEAT_DEFAULTS, ...opts };
  const last = Number(lastBlockedAt) || 0;
  if (!last) return false;
  return at - last < Number(o.cooldownMs);
}

// ────────────────────────────────────────────────────────────────
// 「事实，评论」缝成一句（2026-11-06 老大提的）
//
// 她的高频句式：「2段把体力那点去了，确实值」「5000都不够，那这堆起来可太吃卡了」
// ——前半抛事实，后半给反应，中间一个逗号。逗号在这里是「接着」的意思，
// 于是整句话变成一次分析，而不是聊天。
//
// 真人一般只做一半：只抛事实（剩下的让对方问），或者直接说那个反应。
//
// 判据刻意收得窄：只看逗号后面第一个字是不是评价启动词。
// 宁可漏，不可错——上一版按长度判，一次都没命中，就是因为判据错了方向。
// ────────────────────────────────────────────────────────────────

export const FACT_COMMENT_DEFAULTS = Object.freeze({
  enabled: true,
  maxChars: 30,
  cooldownMs: 3 * 60 * 1000,
});

const COMMENT_START = /^[是那这就真还确挺可太咋怎为像看]/;

/** 这句是不是「事实，评论」缝起来的？ */
export function looksLikeFactComment(text, { opts = {} } = {}) {
  const o = { ...FACT_COMMENT_DEFAULTS, ...opts };
  const s = String(text ?? '').replace(/\s+/g, '');
  if (!s || bodyLength(s) > Number(o.maxChars)) return false;
  const i = s.search(/[，,]/);
  if (i < 0) return false;
  const before = s.slice(0, i);
  const after = s.slice(i + 1);
  if (bodyLength(before) < 3 || bodyLength(after) < 2) return false;
  // 前半已经是问句的，不是「抛事实」
  if (/[？?吗呢]$/.test(before)) return false;
  return COMMENT_START.test(after);
}

/**
 * 「事实，评论」缝成一句时给她看的话。
 *
 * 2026-11-08 傍晚修（老大反馈）：原来说「不用改成两句——挑一半说就行」，
 * 她挑了后半、把前提丢了：16:59 群 1000000004 的「15一只，那还挑什么，直接一笼上汽（」
 * 被拦后发出「这价直接一笼上汽（」，群里不知道「这价」是多少。
 * 现在明说两种安全改法（只留前半 / 只留后半必须补主语），并给正反例 + 自检。
 */
export function factCommentHint() {
  return [
    '【这句缝了两半】前半是事实、后半是评论，中间一个逗号。',
    '真人一般只抛前半，剩下的让对方问；或者直接说后半那个反应。',
    '压成一半可以，但**没看到前文的人得能看懂**：',
    '· 只留前半：把事实说全，「15一只」行，「15」太省了；',
    '· 只留后半：把指代说清——「这价」要写成「15一只的价」，「那」要有落脚点；',
    '· 补不出前提就只留前半，或者整句换一句能独立看懂的。',
    '✅「15一只，那还挑什么」　❌「这价直接一笼上汽」',
    '压完自己读一遍：群里不知道前一句的人，这句能懂吗？',
  ].join('\n');
}

export function inFactCommentCooldown(lastBlockedAt, { at = Date.now(), opts = {} } = {}) {
  const o = { ...FACT_COMMENT_DEFAULTS, ...opts };
  const last = Number(lastBlockedAt) || 0;
  if (!last) return false;
  return at - last < Number(o.cooldownMs);
}

export const __test = {
  bodyLength, sentenceCount, shouldTrim, trimHint, inCooldown,
  isQuestion, isSpeech, looksLikeSameMove, repeatStreak, repeatHint, inRepeatCooldown,
  looksLikeFactComment, factCommentHint, inFactCommentCooldown,
};
