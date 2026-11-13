/**
 * 写回质量门（task-42，2026-11-10）—— 纯分类函数，不写盘。
 *
 * 只收：结论 / 决定 / 坑 / 偏好 / 约定。
 * 每条要求：结论 + 证据 + 日期 + 来源；单次 ≤10 行 / ≤2KB。
 * 输出：accept / reject / quarantine（不确定或证据不全但不该丢的）。
 * 原则：别误杀老大原话、约定、偏好——owner/rule 来源的记录本身可作证据。
 */

export const WRITEBACK_VERSION = 1;
export const WRITEBACK_RULES = Object.freeze({
  maxLines: 10,
  maxBytes: 2048,
  maxCharsPerRecord: 500,
});

export const WRITEBACK_CATEGORIES = Object.freeze([
  { key: 'conclusion', label: '结论', patterns: [/(结论|所以|说明|确认|算是|就是.*不是|判断)/] },
  { key: 'decision', label: '决定', patterns: [/(决定|定了|说定|就这么|以后就|改用|换成|不做了|要做)/] },
  { key: 'pitfall', label: '坑', patterns: [/(踩坑|坑|别再|别白试|不要|别.*(试|用)|注意|教训|以后别)/, /(记得(?:是)?(?:要|多|一个事情|先|别)|别(?:丢|被|觉得|让人|发|点评|留言|刷屏))/] },
  { key: 'preference', label: '偏好', patterns: [/(喜欢|不喜欢|偏好|爱吃|爱看|习惯|讨厌|叫我|称呼|别叫)/] },
  { key: 'agreement', label: '约定', patterns: [/(约定|说好|约好|答应|说定|下次一起|到时候|不许赖|说定了)/] },
]);
const QUESTION_RE = /[？?]$|^(吗|呢|是不是|有没有|怎么|为什么|哪|多少)/;
const NOISE_RE = /^(嗯|哦|啊|哈哈|草|好|行|可以|收到|ok|OK|\+1|？|。|！)/;
const SYSTEM_LOG_RE = /^(【助手】|\[助手\]|夜间体检|早报|已发版|维护：)/;
const DIRECTIVE_RE = /(记得|记着|别|以后|往后|今后|不要|可以|要|不准|不许|必须|应该|原则|偏好|喜欢)/;
// owner 方向问句（反问式指令）：不算纯问句，按「决定/方向」收（PM 2026-11-10 校准）
const OWNER_DIRECTION_q_RE = /(不应该|要不要|能不能|可不可以|是否|应该)/;
const IMAGE_OR_MENTION_RE = /^@\S+|\[图片\]|\[表情\]|\[视频\]/;
const EVIDENCE_RE = /(因为|所以|证据|来源|老大说|他说|她说|群里|私聊|记录|原话|引用|前面|上次|昨天|今天)/;

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const dayOf = (r) => String(r?.date || r?.createdAt || r?.at || '').slice(0, 10);

/** 归一化输入（record 文本框 / text 字符串皆可）。 */
function normalizeRecord(record) {
  if (typeof record === 'string') return { text: norm(record), source: '', date: '', evidence: '', origin: 'unknown' };
  const r = record || {};
  return {
    text: norm(r.text || r.content || ''),
    source: String(r.source || r.origin || ''),
    date: dayOf(r),
    evidence: norm(r.evidence || r.evidenceText || ''),
    origin: String(r.originKind || r.origin || 'unknown'),
    conversationKey: String(r.conversationKey || ''),
    at: Number(r.at || Date.parse(String(r.createdAt || '')) || 0),
  };
}
function categoryOf(text) {
  for (const c of WRITEBACK_CATEGORIES) if (c.patterns.some((re) => re.test(text))) return c;
  return null;
}

/**
 * 分类单条记录。
 * @returns {{action:'accept'|'reject'|'quarantine', category:string, label:string, reason:string, confidence:number, record:object}}
 */
export function classifyWriteback(record) {
  const r = normalizeRecord(record);
  const text = r.text;
  const base = { record: r, category: '', label: '', reason: '', confidence: 0 };
  if (!text) return { ...base, action: 'reject', reason: 'empty' };
  if (text.length > WRITEBACK_RULES.maxCharsPerRecord) return { ...base, action: 'reject', reason: 'too_long' };
  if (SYSTEM_LOG_RE.test(text)) return { ...base, action: 'reject', reason: 'system_log' };
  const ownerRule0 = ['qq-owner', 'rule'].includes(r.source);
  const isQuestionLike = QUESTION_RE.test(text) || /[吗呢]$/.test(text);
  const directionQuestion = isQuestionLike && ownerRule0 && OWNER_DIRECTION_q_RE.test(text)
    && /(研究|做|学|看|处理|走|改|买|订|发|去|家务|关节)/.test(text);
  if (isQuestionLike && !directionQuestion) return { ...base, action: 'reject', reason: 'question' };
  if (directionQuestion) {
    return { ...base, action: 'accept', category: 'decision', label: '决定', reason: 'owner_direction_question', confidence: 0.7, reviewPriority: 'low' };
  }
  if (NOISE_RE.test(text) && text.length < 8) return { ...base, action: 'reject', reason: 'noise' };
  const ownerRule = ['qq-owner', 'rule'].includes(r.source);
  // 老大/规则里的「以后/往后/今后…」是决定/规矩，别误杀（lead 2026-11-10 口径）
  // 纯闲聊/问句/复读/图片@（无祈使/原则标记）直接 reject
  if (IMAGE_OR_MENTION_RE.test(text) && !DIRECTIVE_RE.test(text)) return { ...base, action: 'reject', reason: 'image_or_mention' };
  if (/^(.{1,8})\1+$/.test(text)) return { ...base, action: 'reject', reason: 'repeat' };
  const cat = categoryOf(text) || (ownerRule && /(以后|往后|今后)/.test(text) ? WRITEBACK_CATEGORIES.find((c) => c.key === 'decision') : null);
  if (!cat) {
    // owner/rule 带祈使/原则/偏好标记：不直接 reject，交人工 quarantine（勿误杀老大原话）
    if (ownerRule && DIRECTIVE_RE.test(text)) {
      return { ...base, action: 'quarantine', category: 'review', label: '待核', reason: 'owner_directive_needs_review', confidence: 0.4, reviewPriority: 'high' };
    }
    return { ...base, action: 'reject', reason: 'not_conclusion_decision_pitfall_preference_agreement' };
  }
  const ownerOrRule = ['qq-owner', 'rule', 'manual', 'digest', 'qq-self'].includes(r.source);
  const hasDate = Boolean(r.date && /^\d{4}-\d{2}-\d{2}/.test(r.date));
  const hasSource = Boolean(r.source);
  const hasEvidence = Boolean(r.evidence) || EVIDENCE_RE.test(text) || ownerOrRule; // owner/rule 原话本身即证据
  const out = { ...base, category: cat.key, label: cat.label, confidence: 0.6 };
  if (hasDate && hasSource && hasEvidence) return { ...out, action: 'accept', confidence: 0.9, reason: 'ok' };
  // 有结论/价值但缺元信息 → 隔离，不直接丢；优先级供 PM 每天抽 5–10 条
  // 只有 owner/rule + 指令/偏好标记才 high；manual/digest/偏好类 medium；其余 low（群聊碎片不占 PM 抽检预算）
  const priority = (ownerRule && DIRECTIVE_RE.test(text)) ? 'high'
    : (['manual', 'digest'].includes(r.source) || ['preference', 'agreement'].includes(cat.key) ? 'medium' : 'low');
  return { ...out, action: 'quarantine', reason: !hasDate ? 'missing_date' : (!hasSource ? 'missing_source' : 'missing_evidence'), confidence: 0.5, reviewPriority: priority };
}

/** 批量门：单次 ≤10 行 / ≤2KB；超出部分 quarantine（batch_limit），保证不整批丢。 */
export function classifyWritebackBatch(records) {
  const list = Array.isArray(records) ? records : [];
  const results = [];
  let lines = 0; let bytes = 0;
  for (const r of list) {
    const c = classifyWriteback(r);
    const lineBytes = Buffer.byteLength(`${JSON.stringify([c.record.text.length, c.record.date, c.record.source])}\n`, 'utf8');
    if (lines + 1 > WRITEBACK_RULES.maxLines || bytes + lineBytes > WRITEBACK_RULES.maxBytes) {
      results.push({ ...c, action: 'quarantine', reason: 'batch_limit', confidence: Math.min(c.confidence, 0.4), reviewPriority: c.reviewPriority || 'low' });
      continue;
    }
    lines += 1; bytes += lineBytes;
    results.push(c);
  }
  const counts = results.reduce((a, r) => { a[r.action] = (a[r.action] || 0) + 1; return a; }, {});
  return { results, counts, lines, bytes, rules: { ...WRITEBACK_RULES } };
}


/** 文本是否已存在于给定语料（规则/决定）：中文 3-gram 至少命中 2 个不同片段。 */
export function isDuplicateText(text, corpus, { minGram = 3, minHits = 2 } = {}) {
  const body = norm(text);
  const hay = norm(corpus);
  if (body.length < minGram || hay.length < minGram) return false;
  const grams = new Set();
  for (let i = 0; i + minGram <= body.length; i += 1) grams.add(body.slice(i, i + minGram));
  let hits = 0;
  for (const g of grams) if (g.trim() && hay.includes(g)) { hits += 1; if (hits >= minHits) return true; }
  return false;
}

/** 应用 PM 人工复核标签（校准用）：accept/reject/quarantine 覆盖分类结果。 */
export function applyReviewedLabel(result, label) {
  const l = String(label || '').trim();
  if (!['accept', 'reject', 'quarantine'].includes(l)) return result;
  if (l === 'accept') return { ...result, action: 'accept', reason: 'pm_review_accept', reviewPriority: 'low' };
  if (l === 'reject') return { ...result, action: 'reject', reason: 'pm_review_reject' };
  return { ...result, action: 'quarantine', reason: 'pm_review_quarantine', reviewPriority: 'low' };
}
