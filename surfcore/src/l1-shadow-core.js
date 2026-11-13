/**
 * L1 本地检索 shadow —— 纯函数模块（task-22，2026-11-08）
 *
 * 定位：在**不注入**的前提下，对每条进入的群/私聊消息做两件事：
 *   1) 信息类型分类：问过去 / 问人 / 问规则 / 问梗 / 问事实 /（其它=闲聊）；
 *   2) 构造本地检索查询（关键词），并从现有库（记忆卡/主题/cmem/黑话/同步事实）取候选，
 *      拼成「本轮会注入什么」≤200 字的精华，**只写日志**。
 *
 * 纯函数：不读盘、不调 HTTP、不写 state；检索适配器由 scripts/l1-shadow.mjs 提供（复用现有接口）。
 * 依据：`knowledge/two-round-retrieval-eval.md`（L1 本地打底 0 额外调用；先 3 天 shadow 再谈注入）。
 */

export const L1_SHADOW_VERSION = 1;
export const L1_MAX_INJECT_CHARS = 200;

export const INFO_TYPES = Object.freeze([
  { id: 'past', label: '问过去' },
  { id: 'person', label: '问人' },
  { id: 'rule', label: '问规则' },
  { id: 'meme', label: '问梗' },
  { id: 'fact', label: '问事实' },
  { id: 'chat', label: '闲聊' },
]);

const TYPE_PATTERNS = {
  past: [
    [/还?记得|记不记得/, 2.5], [/以前|上次|之前|那次|那时候|当时|后来/, 2], [/说过|提过|讲过|聊过/, 2],
    [/回忆|想起|第一次/, 1.2], [/那天|昨天|前天|上周/, 0.8],
  ],
  person: [
    [/是谁|谁啊|谁呀|哪个人的|哪个人|叫什么|怎么称呼/, 2.5], [/^谁|[？?]谁/, 2], [/老大|主人|管理员/, 1.2],
    [/群友|群里的|你们|她是谁|他是谁/, 1], [/名字|昵称|真名/, 1],
  ],
  rule: [
    [/能不能|可不可以|该不该|要不要|行不行|让不让|是不是应该|是不是该|该先|先问/, 2.2], [/规矩|规则|允许|禁止|违规/, 2],
    [/可以吗|行吗|对吗|没问题吧/, 1.4], [/必须|应该|最好/, 0.8],
  ],
  meme: [
    [/什么梗|梗是啥|梗什么意思|啥意思|什么意思|为什么这么说/, 2.4], [/黑话|术语|出处|来源是哪|哪里来的说法/, 2],
    [/段子|典故|谐音|缩写/, 1.5],
  ],
  fact: [
    [/是什么|做什么的|干什么的|哪个作品|什么作品/, 1.6], [/多少|几个|几号|哪年|什么时候|多久|多大/, 2],
    [/哪里|哪儿|在哪|怎么弄|怎么用|怎么玩|为什么/, 1.3], [/是不是|有没有|真的假的/, 1],
  ],
};

/** 停用词：不进检索关键词。 */
const STOPWORDS = new Set([
  '这个', '那个', '就是', '什么', '怎么', '可以', '不是', '没有', '还是', '已经', '我们', '你们', '他们',
  '自己', '现在', '今天', '明天', '昨天', '然后', '因为', '所以', '但是', '不过', '而且', '还有', '一个',
  '一下', '一点', '觉得', '知道', '看到', '听到', '感觉', '真的', '有点', '这样', '那样', '哪种', '哪个',
  '是不是', '为什么', '什么样', '怎么办', '能不能', '可不可以', '要不要', '有没有', '是不是', '的话',
  '哈哈', '草', '草草', '啊啊', '嗯嗯', '对对', '是的', '好的', '好滴', '收到', '了解', '谢谢', '拜拜',
  '你的', '我的', '他的', '她的', '它的', '引用', '回复', '图片', '视频', '表情', '表情包', '语音',
  '不能', '不会', '可能', '应该', '需要', '一直', '现在', '刚刚', '刚才', '东西', '时候', '地方',
]);

function cleanText(text) {
  return String(text ?? '')
    .replace(/^\[引用[^\]]*\]\s*/u, '') // 引用块不是这句话的内容
    .replace(/\s+/g, ' ')
    .trim();
}

/** 纯占位符消息（[图片]/[视频]/[表情…]）——不构成检索查询。 */
export function isMediaPlaceholder(text) {
  return /^\[(图片|视频|表情|表情包|语音|文件|转发消息|拍一拍)[^\]]*\]$/.test(cleanText(text));
}

/** 是否为「需要本地检索」的信息类型（闲聊不做 L1 检索；与 two-round-retrieval-eval 的 L1 触发面对齐）。 */
export function shouldRetrieve(type) {
  return type === 'past' || type === 'person' || type === 'rule' || type === 'meme' || type === 'fact';
}

/**
 * 信息类型分类。
 * @param {string} text 这条消息正文
 * @param {Array<{text:string,isSelf?:boolean}>} context 最近几条消息（可选，用于短句补上下文）
 */
export function classifyInfoType(text, context = []) {
  const body = cleanText(text);
  const ctxText = (Array.isArray(context) ? context.slice(-2) : []).map((m) => cleanText(m?.text)).join(' ');
  const scores = {};
  const signals = {};
  for (const [type, patterns] of Object.entries(TYPE_PATTERNS)) {
    let score = 0;
    const hits = [];
    for (const [re, weight] of patterns) {
      if (re.test(body)) { score += weight; hits.push(String(re).slice(1, 18)); }
    }
    // 上下文只在短句/指代词时给很小加权（避免把上一条的问题算到这条头上）
    if (ctxText && body.length <= 20 && /^(那|这|它|她|他|你|我|是|对|有|没|还)/.test(body)) {
      for (const [re, weight] of patterns) {
        if (re.test(ctxText)) { score += weight * 0.35; hits.push('ctx'); break; }
      }
    }
    scores[type] = Math.round(score * 100) / 100;
    signals[type] = [...new Set(hits)];
  }
  let best = { type: 'chat', score: 0 };
  for (const [type, score] of Object.entries(scores)) {
    if (score > best.score) best = { type, score };
  }
  const confidence = best.score < 1 ? 0 : Math.min(1, Math.round((best.score / 3) * 100) / 100);
  const label = INFO_TYPES.find((t) => t.id === (confidence > 0 ? best.type : 'chat'))?.label || '闲聊';
  return {
    type: confidence > 0 ? best.type : 'chat',
    label,
    confidence,
    scores,
    signals: confidence > 0 ? signals[best.type] : [],
  };
}

/** 中文分词（Intl.Segmenter），失败时退回 2-gram。 */
export function extractKeywords(text, { limit = 6, names = [] } = {}) {
  const body = cleanText(text);
  if (!body) return [];
  const out = [];
  const push = (word) => {
    const w = String(word || '').trim();
    if (w.length < 2 || w.length > 12) return;
    if (STOPWORDS.has(w)) return;
    if (/^[\d\s.,!?，。！？、；：（）()【】「」…—\-~～]+$/.test(w)) return;
    if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(w)) return;
    if (out.includes(w)) return;
    out.push(w);
  };
  // 专名优先（群友昵称/角色名）
  for (const name of Array.isArray(names) ? names : []) {
    if (name && body.includes(name)) push(String(name));
  }
  try {
    const seg = new Intl.Segmenter('zh', { granularity: 'word' });
    for (const part of seg.segment(body)) {
      if (part.isWordLike) push(part.segment);
      if (out.length >= limit) break;
    }
  } catch {
    // 回退：连续中文按 2-gram
    for (const run of body.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
      for (let i = 0; i + 2 <= run.length && out.length < limit; i += 1) push(run.slice(i, i + 2));
    }
  }
  return out.slice(0, limit);
}

/** 按类型构造检索查询：关键词 + 类型提示词（提示词只用来扩大召回，不进注入）。 */
export function buildRetrievalQuery(text, type, { names = [] } = {}) {
  const keywords = extractKeywords(text, { limit: 6, names });
  const hints = {
    past: ['以前', '上次', '记得'],
    person: ['谁', '名字'],
    rule: ['规矩', '规则', '可以'],
    meme: ['梗', '黑话', '意思'],
    fact: [],
    chat: [],
  }[type] || [];
  return {
    keywords,
    hints,
    query: [...keywords, ...hints].join(' ').trim(),
  };
}

function normText(text) {
  return String(text ?? '').replace(/\s+/g, '').toLowerCase().slice(0, 40);
}

/**
 * 把各来源候选拼成「本轮会注入什么」（≤maxChars，空则返回空串）。
 * @param {Array<{source:string,label?:string,text:string,score?:number}>} candidates
 */
export function assembleWouldInject(candidates = [], { maxChars = L1_MAX_INJECT_CHARS } = {}) {
  const list = Array.isArray(candidates) ? candidates.filter((c) => c && c.text) : [];
  const seen = new Set();
  const picked = [];
  for (const c of list.slice().sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))) {
    const key = normText(c.text);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(c);
  }
  const parts = [];
  let total = 0;
  for (const c of picked) {
    const label = String(c.label || c.source || '?');
    const text = String(c.text).replace(/\s+/g, ' ').trim().slice(0, 80);
    const piece = `[${label}] ${text}`;
    if (total + piece.length + 1 > maxChars) {
      // 还有空间就截一段放进去
      const remain = maxChars - total - 1;
      if (remain >= 12) parts.push(`${piece.slice(0, Math.max(0, remain - 1))}…`);
      break;
    }
    parts.push(piece);
    total += piece.length + 1;
  }
  const out = parts.join('；');
  return out.length > maxChars ? `${out.slice(0, Math.max(0, maxChars - 1))}…` : out;
}

/**
 * 一条 shadow 记录（脚本写盘用；本函数只组装数据结构）。
 * @param {object} input
 * @param {object} retrieval {candidates, sourcesTried, errors, tookMs}
 */
export function buildShadowEntry({
  at = Date.now(), key = '', sender = '', text = '', context = [],
  classification, query, retrieval, names = [], mediaOnly = false,
} = {}) {
  const cls = classification || classifyInfoType(text, context);
  const q = query || buildRetrievalQuery(text, cls.type, { names });
  const l1Triggered = !mediaOnly && shouldRetrieve(cls.type);
  const candidates = l1Triggered && Array.isArray(retrieval?.candidates) ? retrieval.candidates : [];
  const wouldInject = assembleWouldInject(candidates);
  return {
    version: L1_SHADOW_VERSION,
    at,
    key,
    sender: String(sender || '').slice(0, 40),
    text: String(text || '').slice(0, 200),
    context: (Array.isArray(context) ? context.slice(-3) : []).map((m) => ({
      sender: String(m?.sender || '').slice(0, 24),
      isSelf: m?.isSelf === true,
      text: String(m?.text || '').slice(0, 80),
    })),
    type: cls.type,
    typeLabel: cls.label,
    confidence: cls.confidence,
    signals: cls.signals,
    keywords: q.keywords,
    query: q.query,
    sourcesTried: retrieval?.sourcesTried || [],
    sourcesHit: [...new Set(candidates.map((c) => c.source))],
    mediaOnly,
    l1Triggered,
    skipReason: mediaOnly ? 'media-only' : (l1Triggered ? '' : 'chat'),
    candidates: candidates.slice(0, 8).map((c) => ({ source: c.source, text: String(c.text || '').slice(0, 80), score: Number(c.score) || 0 })),
    wouldInject,
    wouldInjectChars: wouldInject.length,
    shadow: true,       // 明确：只记录，不注入
    injected: false,
    tookMs: Number(retrieval?.tookMs) || 0,
    errors: retrieval?.errors || [],
  };
}

/** 评估：给人工评分表算命中率。ratings: [{hit:0|1}] */
export function computeHitRate(ratings = []) {
  const list = Array.isArray(ratings) ? ratings.filter((r) => r && (r.hit === 0 || r.hit === 1 || r.hit === true || r.hit === false)) : [];
  const n = list.length;
  const hits = list.filter((r) => r.hit === 1 || r.hit === true).length;
  return { n, hits, hitRatePct: n ? Math.round((hits / n) * 1000) / 10 : 0 };
}

// ── 2026-11-09（task-22 第二批）：L1 v2 —— 收紧触发面 + 排序/最小重合度 ──────────
// 首日 20 条粗评 55% 的教训：群友叙述句里的「之前/以前」被当问过去；「多少/哪里」
// 把陈述句当问事实；cmem 的「用户：…」长文跑题却排前面；memory-card 句式命中但主题无关。
// v2 只收紧触发与排序，不改变 v1 的采集口径（双跑对照）。
export const L1_V2_VERSION = 2;
export const V2_MIN_OVERLAP_CHARS = 3;   // 候选与查询内容词的最小重合字数
export const V2_MIN_CANDIDATE_SCORE = 2.5;

/**
 * 问句意图。中文群聊经常不打问号（「肥在哪」「那你分析一下这是为什么」），
 * 所以不能只认「？」，用三层判据：
 *   ① 显式：问号/句末吗呢嘛么/请问；
 *   ② 祈使索取：帮我/告诉我/说说/解释一下/分析一下/查一下；
 *   ③ 短疑问句：<=14 字且含疑问词；或「你+疑问词」（问你才知道类）。
 */
export function hasQuestionIntent(text) {
  const body = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!body) return false;
  if (/[？?]\s*$/.test(body)) return true;
  if (/[吗呢嘛么吧]\s*[。！!～~…（(]?\s*$/.test(body)) return true;
  if (/(请问|想问一下|想问下|帮我查|帮我看看|告诉我|说说是|解释一下|分析一下|查一下|你知道吗|知不知道|能告诉我)/.test(body)) return true;
  const WH = /(谁|什么|哪|几|多少|怎么|如何|为什么)/;
  if (WH.test(body)) {
    if (body.length <= 14) return true;                       // 「肥在哪」「这是什么」
    if (/(你|妳).{0,8}/.test(body) && /(知道|记得|觉得|说|看|之前|上次|以前|懂|会)/.test(body)) return true; // 「你之前说…」
    if (/^(谁|什么|哪|几|多少|怎么|为什么|是不是|有没有|能不能|可不可以|要不要|该不该|行不行|对吗|是吗)/.test(body)) return true;
  }
  return false;
}

const PAST_STRONG_RE = /还记得|记不记得|想不起来|记不清|有印象|回忆一下|我记得|印象里/;
const PAST_WEAK_RE = /以前|上次|之前|那次|那时候|当时|说过|提过|讲过|聊过/;
const PERSON_RE = /是谁|谁啊|谁呀|叫什么|怎么称呼|哪个人|哪个群友/;
const RULE_RE = /能不能|可不可以|该不该|要不要|行不行|让不让|规矩|规则|允许|禁止|对吗|行吗|可以吗|没问题吧/;
const MEME_RE = /什么梗|梗是啥|梗什么意思|什么意思|黑话|术语|出处|为什么这么说/;
const FACT_RE = /是什么|做什么的|多少|几个|几号|哪年|什么时候|多久|哪里|哪儿|在哪|怎么弄|怎么用|怎么玩|为什么|是不是|有没有/;

/** v2 触发判定：在 v1 类型基础上加「意图门槛」，不满足则降级为闲聊（不检索）。 */
export function shouldTriggerV2(type, text) {
  const body = String(text ?? '').replace(/\s+/g, ' ').trim();
  const q = hasQuestionIntent(body);
  switch (type) {
    case 'past':
      // 强回忆词：可以直接触发；弱过去词（之前/以前/上次…）必须是问句/回忆语气
      return PAST_STRONG_RE.test(body) || (PAST_WEAK_RE.test(body) && q);
    case 'person':
      return PERSON_RE.test(body) && (q || /[？?]/.test(body));
    case 'rule':
      return RULE_RE.test(body) && (q || /[？?]/.test(body));
    case 'meme':
      return MEME_RE.test(body) && (q || /什么|意思|梗|出处/.test(body));
    case 'fact':
      return FACT_RE.test(body) && q;
    default:
      return false;
  }
}

/** v2 分类：v1 分类 + 意图门槛，不满足的降级成 chat（skipReason=no-intent 由调用方记录）。 */
export function classifyInfoTypeV2(text, context = []) {
  const base = classifyInfoType(text, context);
  const engine = 'v2';
  if (base.type === 'chat') return { ...base, engine, qIntent: false, downgraded: false, downgradeReason: '' };
  const qIntent = hasQuestionIntent(text);
  if (shouldTriggerV2(base.type, text)) return { ...base, engine, qIntent, downgraded: false, downgradeReason: '' };
  return { ...base, type: 'chat', label: '闲聊', confidence: 0, engine, qIntent, downgraded: true, downgradeReason: 'no-intent', originalType: base.type };
}

function contentKeywords(keywords, hints = []) {
  const hintSet = new Set(hints.map(String));
  return (Array.isArray(keywords) ? keywords : []).map(String).filter((k) => k.length >= 2 && !hintSet.has(k));
}

/**
 * v2 候选打分/过滤：
 *   · 内容词重合字数（忽略类型提示词/停用词）≥ V2_MIN_OVERLAP_CHARS；
 *   · 来源权重：cmem 降权（长文/「用户：」进一步降）；
 *   · 低于 V2_MIN_CANDIDATE_SCORE 的丢掉——L1 是 push，错推比不推更糟。
 */
export function rankCandidatesV2({ candidates = [], keywords = [], hints = [], type = 'chat' } = {}) {
  const content = contentKeywords(keywords, hints);
  const out = [];
  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (!c || !c.text) continue;
    const text = String(c.text);
    let overlap = 0;
    const matched = [];
    for (const k of content) {
      if (text.includes(k)) { overlap += k.length; matched.push(k); }
    }
    if (overlap < V2_MIN_OVERLAP_CHARS) continue;
    let sourceWeight = { 记忆卡: 3, 归档: 2, 主题: 3, 黑话: 2.5, 同步事实: 2, cmem: 1.2 }[c.source] || 1.5;
    if (String(c.source) === 'cmem') {
      if (text.length > 80) sourceWeight -= 0.3;
      if (/^用户[：:]/.test(text)) sourceWeight -= 0.3;
    }
    const score = sourceWeight + Math.min(2, overlap / 3) + (Number(c.score) || 0) * 0.2;
    if (score < V2_MIN_CANDIDATE_SCORE) continue;
    out.push({ ...c, score: Math.round(score * 100) / 100, matched });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/** v2 一条 shadow 记录的组装入口（复用 buildShadowEntry，但触发/排序换成 v2）。 */
export function buildShadowEntryV2({ candidates = [], keywords = [], hints = [], mediaOnly = false, ...rest } = {}) {
  const cls = rest.classification || classifyInfoTypeV2(rest.text, rest.context);
  const triggered = !mediaOnly && shouldTriggerV2(cls.originalType || cls.type, rest.text || '');
  const ranked = triggered ? rankCandidatesV2({ candidates, keywords, hints, type: cls.type }) : [];
  const entry = buildShadowEntry({ ...rest, classification: cls, retrieval: { candidates: ranked, sourcesTried: rest?.retrieval?.sourcesTried || [], errors: rest?.retrieval?.errors || [], tookMs: rest?.retrieval?.tookMs || 0 }, mediaOnly });
  entry.engine = 'v2';
  entry.l1Triggered = triggered;
  entry.skipReason = mediaOnly ? 'media-only' : (triggered ? '' : (cls.downgraded ? 'no-intent' : 'chat'));
  entry.rankedCandidates = ranked.length;
  entry.lowOverlap = triggered && ranked.length === 0;
  if (entry.lowOverlap) entry.skipReason = 'low-overlap';
  entry.wouldInject = assembleWouldInject(ranked);
  entry.wouldInjectChars = entry.wouldInject.length;
  return entry;
}

// ── 触发面扩展（2026-11-10，lead 批）：precheck 三类触发，只用于「该不该查」判断 ──
// 目标：覆盖「她自己的输出 vs 记忆冲突」而不每轮查；命中后仍走 L1 检索/shadow，不直接注入。
export const PRECHECK_CATEGORIES = Object.freeze([
  {
    key: 'ownership_source',
    label: '归属/来源',
    patterns: [/(偷|抄|抢|拿|给|送|我的|你给的|你送的|哪来的|来源).{0,8}(表情|图|梗|头像|贴纸|素材|歌|文案)/, /(表情|图|梗|头像|贴纸|素材).{0,6}(偷|抄|我的|你给的|哪来的|来源)/],
  },
  {
    key: 'promise_recall',
    label: '承诺/回溯',
    patterns: [/(?:^|[，。！？；!?、\s])(我说过|我说要|我记得我说|你答应过|你答应|说好的|不是说|上次说|以前说|约定|约好|还没回|没回我|上次.*(问|说)|那套)/],
  },
  {
    key: 'fact_retro',
    label: '事实回溯',
    patterns: [/(是不是我|是我吗|这是我|这不是我|我自己|像我|太像了|长什么样|哪张|哪次|什么时候|看过吗|记得吗|我说过吗|变过|换过|是不是.*(换|给|送|做))/, /(我|我的).{0,6}(是不是|有没有|吗？)/],
  },
]);

/** 三类 precheck 触发（纯函数）：返回 {triggered, category, label}；不改变 L1 正式分类。 */
export function precheckTrigger(text) {
  // 引用块 [引用 …] 里的内容不是她自己的断言，先剔掉（防「比我自己的记忆」误触）
  const body = String(text ?? '').replace(/\[[^\]]{0,120}\]/g, ' ').replace(/\s+/g, ' ').trim();
  if (body.length < 3) return { triggered: false, category: '', label: '' };
  for (const c of PRECHECK_CATEGORIES) if (c.patterns.some((re) => re.test(body))) return { triggered: true, category: c.key, label: c.label };
  return { triggered: false, category: '', label: '' };
}

/** 类别提示词：precheck 命中后并进检索 query（补「我自己长什么样」这类虚词查询）。 */
export const PRECHECK_HINTS = Object.freeze({
  ownership_source: '表情 图 梗 头像 来源 谁给的 收下来',
  promise_recall: '以前说 答应 约定 上次 说好',
  fact_retro: '自己 样子 头像 外貌 以前的事 是不是',
});

/** 返回 {triggered, category, label, retrievalQuery}；未触发时 retrievalQuery=原文。 */
export function precheckRetrievalQuery(text) {
  const p = precheckTrigger(text);
  if (!p.triggered) return { ...p, retrievalQuery: String(text ?? '') };
  return { ...p, retrievalQuery: `${String(text ?? '')} ${PRECHECK_HINTS[p.category] || ''}`.trim() };
}
