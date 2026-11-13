// 2026-11-10 task-36 黑话闭环 MVP：纯函数层（不接线、不改 prompt）。
// 依据 knowledge/slang-loop-audit.md §5：
//   1) 候选→可见：私聊一次一张「认不认」卡（优先她已在用的词、空白卡不推、带 meaning/scope/risk）
//   2) 确认→注入修复：meaning || selfUsage；注入不再静态 top18，改为「最近消息里出现才带」，
//      use ≤6 + understand ≤3、总长 ≤1200、scope/risk 过滤
//   3) 使用回收：她发出文本命中 → usage；有人引用/复用 → landed；周度按 recency/usage/landed 调权，21 天未用降 understand
// 所有函数纯函数、不读盘、不写盘；bridge 接线等下个桥接窗口。

export const SLANG_LOOP_DEFAULTS = {
  review: {
    perDayPrivate: 1,
    perWeekPrivate: 3,
    sameTermCooldownMs: 14 * 86400e3,
    rejectedCooldownMs: 30 * 86400e3,
    noResponsePauseAfter: 2,
    noResponsePauseMs: 7 * 86400e3,
  },
  injection: {
    useMax: 6,
    understandMax: 3,
    maxChars: 1200,
    recentWindow: 10,
    minTermLen: 2,
  },
  usage: {
    demoteIdleDays: 21,
    landedWindowMs: 10 * 60e3,
  },
  risk: {
    useAllowed: ['none', 'mild'],
    understandAllowed: ['none', 'mild', 'sensitive', 'offensive'],
    neverUse: ['sensitive', 'offensive', 'nsfw'],
  },
};

// 审计里「她已经在用但系统没确认」的 14 条——首批卡优先从这里面选。
export const USED_CANDIDATE_TERMS = [
  '努努', '偷跑', '招牌词', '小孩', '断片', '摸摸', '孩子', '能工智人',
  '水群', '色样', '摸鱼', '小本本', '大小姐', '吃token',
];

const RISK_LEVELS = ['none', 'mild', 'sensitive', 'offensive', 'nsfw'];
const QUALITIES = ['researched', 'quote-only', 'self', 'blank'];
const PLACEHOLDER_MEANING = /^群里是这么用的/;
const STOP_TERMS = new Set(['这个', '那个', '什么', '怎么', '可以', '就是', '没有', '不是', '一个', '一下', '时候', '东西', '事情']);

function clean(s, max = 300) {
  return String(s ?? '').replace(/\[CQ:[^\]]*\]/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function termOf(e) { return clean(e?.content, 50); }
function normTerm(t) { return String(t || '').replace(/\s+/g, '').toLowerCase(); }
function isAsciiTerm(t) { return /^[\x00-\x7F]+$/.test(t); }

/** 机制 2：确认时 meaning 兜底 —— meaning || selfUsage（修「自认词有 selfUsage 无 meaning 进不了表」）。 */
export function resolveMeaning(entry) {
  return clean(entry?.meaning) || clean(entry?.selfUsage) || '';
}

/** 空白卡：meaning/selfUsage 都没有，或 meaning 只是占位句且没有 selfUsage。 */
export function isBlankCard(entry) {
  const m = clean(entry?.meaning);
  const su = clean(entry?.selfUsage);
  if (!m && !su) return true;
  if (PLACEHOLDER_MEANING.test(m) && !su) return true;
  return false;
}

/** 质量推断（未落库旧数据用）：researched | quote-only | self | blank。 */
export function inferQuality(entry) {
  if (QUALITIES.includes(entry?.quality)) return entry.quality;
  const m = clean(entry?.meaning);
  const su = clean(entry?.selfUsage);
  // 质量分类与「能不能摆卡」分开：占位句算 quote-only（不是真解释），但没 selfUsage 时也不摆卡。
  if (PLACEHOLDER_MEANING.test(m) && !su) return 'quote-only';
  if (!m && !su) return 'blank';
  if (PLACEHOLDER_MEANING.test(m)) return 'quote-only';
  if (entry?.confirmedBy === 'self' && su) return 'self';
  if ((Array.isArray(entry?.sources) && entry.sources.length) || m) return 'researched';
  return 'quote-only';
}

/** 风险推断：优先显式 riskLevel；否则从旧 risk 文本/内容关键词推断（保守）。 */
export function inferRiskLevel(entry) {
  if (RISK_LEVELS.includes(entry?.riskLevel)) return entry.riskLevel;
  const riskText = String(entry?.risk || '');
  const text = `${riskText} ${entry?.meaning || ''} ${entry?.content || ''}`;
  // 研究结果里大量写的是「无敏感风险；…」——不能把「无敏感风险」本身当敏感。
  const saysNoRisk = /无(明显)?(敏感|政治|色情|nsfw)?风险|无敏感|纯技术梗|日常吐槽|本身无风险/.test(riskText);
  if (/(脏字|脏话|粗口|粗俗|辱骂|人身攻击|污言)/.test(riskText) || /(傻逼|妈的|屌样)/.test(String(entry?.content || ''))) return 'offensive';
  if (!saysNoRisk && /(政治|历史|军国|辱华|歧视|色情|nsfw|毒品|性暗示|性相关|未成年|自杀)/.test(riskText)) return 'sensitive';
  if (/(注意场合|看场合|别对|别用|慎用|分寸|略直接|容易得罪|容易冒犯|居高临下|长辈姿态|剧透|盗版|侵权|平台判|不良言论|负面|调侃)/.test(riskText)) return 'mild';
  return 'none';
}

/** scope 推断：显式 scope 优先；否则 evidence 只来自一个群 → group。 */
export function inferScope(entry) {
  if (entry?.scope === 'global' || entry?.scope === 'group') {
    return { scope: entry.scope, groupKeys: Array.isArray(entry.groupKeys) ? entry.groupKeys.filter(Boolean).slice(0, 6) : [] };
  }
  const keys = new Set();
  for (const ev of (Array.isArray(entry?.evidence) ? entry.evidence : [])) {
    const k = String(ev?.key || '').trim();
    if (/^group:\d+$/.test(k)) keys.add(k);
    else if (/^private:\d+$/.test(k)) keys.add(k);
  }
  if (entry?.originKey && /^group:\d+$/.test(String(entry.originKey))) keys.add(String(entry.originKey));
  const groups = [...keys].filter((k) => k.startsWith('group:'));
  if (groups.length === 1 && groups.length === keys.size) return { scope: 'group', groupKeys: groups };
  return { scope: 'global', groupKeys: [] };
}

function riskAllows(list, level) { return Array.isArray(list) && list.includes(level); }

function recencyScore(lastSeenAt, now, windowMs = 7 * 86400e3) {
  const t = Number(lastSeenAt) || 0;
  if (!t) return 0;
  return Math.max(0, 1 - (now - t) / windowMs);
}

/** 机制 1：私聊每日一张「认不认」卡：候选卡选择（一次一条、空白卡不推、优先她已在用的 14 条）。 */
export function selectReviewCandidate(entries, {
  now = Date.now(),
  usedTerms = [],
  noResponseStreak = 0,
  lastShownAt = 0,
  cfg = SLANG_LOOP_DEFAULTS,
} = {}) {
  const c = { ...SLANG_LOOP_DEFAULTS, ...(cfg || {}), review: { ...SLANG_LOOP_DEFAULTS.review, ...(cfg?.review || {}) } };
  const usedSet = new Set((Array.isArray(usedTerms) && usedTerms.length ? usedTerms : USED_CANDIDATE_TERMS).map(normTerm));
  const paused = Number(noResponseStreak) >= Number(c.review.noResponsePauseAfter);
  if (paused) return { entry: null, reason: 'paused-no-response' };
  const scored = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || e.status !== 'candidate') continue;
    const term = termOf(e);
    if (!term || [...term].length < c.injection.minTermLen) continue;
    if (isBlankCard(e)) continue;                           // 空白卡不推
    const risk = inferRiskLevel(e);
    if (!riskAllows(c.risk.useAllowed, risk)) continue;     // 敏感/冒犯词不进首批
    const review = e.review && typeof e.review === 'object' ? e.review : {};
    const deferredUntil = Number(review.deferredUntil || 0);
    if (deferredUntil && deferredUntil > now) continue;
    const lastShown = Math.max(Number(review.lastShownAt || 0), Number(e.suggestedAt || 0), Number(lastShownAt) || 0);
    if (lastShown && now - lastShown < c.review.sameTermCooldownMs) continue; // 同词 14 天冷却
    if (e.rejectedAt && now - Number(e.rejectedAt) < c.review.rejectedCooldownMs) continue;
    const quality = inferQuality(e);
    if (quality === 'blank' || (quality === 'quote-only' && !resolveMeaning(e))) continue;
    const researchState = String(e.researchState || (quality === 'researched' ? 'verified' : 'none'));
    if (quality === 'researched' && researchState !== 'verified') continue;
    const { scope } = inferScope(e);
    const lastSeenAt = Number(e.lastSeenAt || (Array.isArray(e.evidence) && e.evidence.length ? e.evidence[e.evidence.length - 1]?.time : 0)) || 0;
    const usage = e.usage && typeof e.usage === 'object' ? e.usage : {};
    let score = 0;
    if (usedSet.has(normTerm(term))) score += 0.45;
    score += 0.25 * recencyScore(lastSeenAt || Number(e.updatedAt ? Date.parse(e.updatedAt) : 0), now);
    score += 0.15 * Math.min(1, (Number(e.count) || 0) / 10);
    if (String(e.origin || '') === 'search') score += 0.10;
    score += 0.05 * Math.min(1, Math.max(0, Number(e.confidence ?? 0.5)));
    if (risk && !riskAllows(c.risk.useAllowed, risk)) score -= 0.3;
    if (usage.lastUsedAt && now - Number(usage.lastUsedAt) <= 14 * 86400e3) score += 0.35; // 她最近真用过
    scored.push({ entry: { ...e, _loop: { quality, risk, scope, meaning: resolveMeaning(e) } }, score, term });
  }
  scored.sort((a, b) => b.score - a.score || String(a.term).localeCompare(String(b.term)));
  const picked = scored[0] || null;
  return picked ? { entry: picked.entry, score: picked.score, reason: 'ok' } : { entry: null, reason: 'no-candidate' };
}

/** 机制 1：卡面渲染（软提示、不出现「候选/学习/系统/注入」；认不认都行）。 */
export function renderReviewCard(entry) {
  if (!entry) return '';
  const term = termOf(entry);
  const meaning = resolveMeaning(entry);
  if (!term || !meaning || isBlankCard(entry)) return '';
  const risk = inferRiskLevel(entry);
  const quality = inferQuality(entry);
  const { scope, groupKeys } = inferScope(entry);
  const lines = [];
  lines.push(`【有个词你可能想认一下】`);
  lines.push(`「${term}」：${clean(meaning, 160)}`);
  if (scope === 'group' && groupKeys.length) lines.push(`（这是 ${groupKeys[0]} 那边常见的说法。）`);
  if (risk === 'mild') lines.push('（用的时候看场合，别太刻意。）');
  if (risk === 'sensitive' || risk === 'offensive') lines.push('（这个词有点敏感，只在特定语境里看得懂就行，别主动用。）');
  if (quality === 'self' && entry.selfUsage) lines.push(`你之前写过用法：${clean(entry.selfUsage, 80)}`);
  lines.push('认就写一行「认：' + term + ' → 你以后会怎么用」；不想用就写「不认：' + term + '」。认不认都行，不写也没关系。');
  return `\n${lines.join('\n')}\n`;
}

function recentTextOf(recentMessages, windowSize) {
  const list = (Array.isArray(recentMessages) ? recentMessages : []).slice(-Math.max(1, Number(windowSize) || 10));
  return list.map((m) => String(m?.text || m?.plain || '')).join('\n');
}

/** 最近消息里是否出现该词（中文 includes；ASCII 词要求边界，避免 ds 命中 words）。 */
export function mentionsTerm(text, term) {
  const t = String(text || '');
  const w = termOf({ content: term });
  if (!t || !w) return false;
  if (!isAsciiTerm(w)) return t.includes(w);
  const re = new RegExp(`(^|[^A-Za-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`, 'i');
  return re.test(t);
}

/** 机制 2：注入选择器——只带最近消息里出现过的词；use ≤6/understand ≤3/≤1200 字；scope/risk/quality 过滤。 */
export function selectInjectionEntries(entries, {
  recentMessages = [],
  currentKey = '',
  now = Date.now(),
  cfg = SLANG_LOOP_DEFAULTS,
} = {}) {
  const c = { ...SLANG_LOOP_DEFAULTS, ...(cfg || {}), injection: { ...SLANG_LOOP_DEFAULTS.injection, ...(cfg?.injection || {}) }, risk: { ...SLANG_LOOP_DEFAULTS.risk, ...(cfg?.risk || {}) } };
  if (String(currentKey).startsWith('private:')) return { use: [], understand: [], text: '', reason: 'private-no-table' };
  const recentText = recentTextOf(recentMessages, c.injection.recentWindow);
  if (!recentText.trim()) return { use: [], understand: [], text: '', reason: 'no-context' };
  const pool = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || !['confirmed', 'understand'].includes(e.status)) continue;
    const term = termOf(e);
    if (!term || [...term].length < c.injection.minTermLen) continue;
    if (!mentionsTerm(recentText, term)) continue;          // 语境过滤：没出现就不带
    const risk = inferRiskLevel(e);
    const quality = inferQuality(e);
    const { scope, groupKeys } = inferScope(e);
    if (scope === 'group' && currentKey && !groupKeys.includes(String(currentKey))) continue; // 群内专属不外传
    const usage = e.usage && typeof e.usage === 'object' ? e.usage : {};
    const score = 0.35 * recencyScore(Number(e.lastSeenAt) || 0, now)
      + 0.25 * (usage.lastUsedAt ? Math.max(0, 1 - (now - Number(usage.lastUsedAt)) / (14 * 86400e3)) : 0)
      + 0.20 * Math.min(1, Number(usage.landedCount || 0) / Math.max(1, Number(usage.count || 0)) || 0)
      + 0.10 * Math.min(1, Math.max(0, Number(e.confidence ?? 0.5)))
      + 0.10 * Math.min(1, (Number(e.count) || 0) / 10);
    if (e.status === 'confirmed') {
      if (!riskAllows(c.risk.useAllowed, risk)) continue;   // 敏感/冒犯永进 use
      if (quality === 'quote-only' || quality === 'blank') continue; // 占位/空白不进 use
      pool.push({ e, term, score, mode: 'use' });
    } else {
      if (!riskAllows(c.risk.understandAllowed, risk)) continue;
      pool.push({ e, term, score, mode: 'understand' });
    }
  }
  pool.sort((a, b) => b.score - a.score);
  const use = pool.filter((p) => p.mode === 'use').slice(0, c.injection.useMax);
  const understand = pool.filter((p) => p.mode === 'understand' && !use.some((u) => u.term === p.term)).slice(0, c.injection.understandMax);
  // 总长 ≤ maxChars（按行累加，超了就截断后续）
  const lines = [];
  let total = 0;
  const pushLine = (line) => { if (total + line.length + 1 <= c.injection.maxChars) { lines.push(line); total += line.length + 1; return true; } return false; };
  if (use.length) {
    pushLine('【群里最近在说的】');
    for (const p of use) {
      const meaning = resolveMeaning(p.e);
      const line = `- ${p.term}：${clean(meaning, 160)}`;
      if (!pushLine(line)) break;
    }
    pushLine('（顺口就用，不刻意；没人问就别解释。）');
  }
  if (understand.length) {
    const startLen = lines.length;
    pushLine('【这几个词你大概知道就行】');
    for (const p of understand) {
      const meaning = resolveMeaning(p.e);
      const risk = inferRiskLevel(p.e);
      const line = `- ${p.term}：${clean(meaning, 160)}${risk !== 'none' ? '（别主动用）' : ''}`;
      if (!pushLine(line)) break;
    }
    if (lines.length === startLen) lines.pop();
  }
  return { use: use.map((p) => ({ term: p.term, entry: p.e })), understand: understand.map((p) => ({ term: p.term, entry: p.e })), text: lines.length ? `\n${lines.join('\n')}\n` : '', reason: 'ok' };
}

/** 机制 3：她发出的文本里命中了哪些 confirmed/understand 词（长词优先、去重叠）。 */
export function scanUsage(text, entries) {
  const t = String(text || '');
  if (!t.trim()) return [];
  const hits = [];
  const sorted = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && ['confirmed', 'understand'].includes(e.status) && termOf(e))
    .sort((a, b) => [...termOf(b)].length - [...termOf(a)].length);
  for (const e of sorted) {
    const term = termOf(e);
    if ([...term].length < 2 || STOP_TERMS.has(term)) continue;
    if (!mentionsTerm(t, term)) continue;
    if (hits.some((h) => h.term.includes(term) || term.includes(h.term))) continue;
    hits.push({ term, status: e.status });
  }
  return hits;
}

/** 机制 3：她发出后 10 分钟内，有人引用/复用同一个词 → landed。 */
export function scanLanded({ herText = '', laterMessages = [], entries = [], now = Date.now(), windowMs = SLANG_LOOP_DEFAULTS.usage.landedWindowMs } = {}) {
  const used = scanUsage(herText, entries);
  if (!used.length) return [];
  const later = (Array.isArray(laterMessages) ? laterMessages : [])
    .filter((m) => m && !m.isSelf && now - Number(m.time || 0) <= windowMs);
  const laterText = later.map((m) => String(m.text || '')).join('\n');
  return used.filter((u) => mentionsTerm(laterText, u.term));
}

/** 机制 3：周度调权（纯函数）——21 天未用的 confirmed 降 understand；摆过多次没回的候选延后。 */
export function weeklyRecencyUpdate(entries, { now = Date.now(), cfg = SLANG_LOOP_DEFAULTS } = {}) {
  const c = { ...SLANG_LOOP_DEFAULTS, ...(cfg || {}), usage: { ...SLANG_LOOP_DEFAULTS.usage, ...(cfg?.usage || {}) } };
  const changes = [];
  const next = (Array.isArray(entries) ? entries : []).map((e) => {
    if (!e || typeof e !== 'object') return e;
    const usage = e.usage && typeof e.usage === 'object' ? e.usage : {};
    if (e.status === 'confirmed') {
      const lastUsed = Number(usage.lastUsedAt || 0);
      const lastSeen = Number(e.lastSeenAt || 0);
      const idleSince = Math.max(lastUsed, lastSeen);
      const demoteMs = Number(c.usage.demoteIdleDays) * 86400e3;
      if (idleSince && now - idleSince > demoteMs) {
        changes.push({ id: e.id, term: termOf(e), from: 'confirmed', to: 'understand', reason: 'idle-21d' });
        return { ...e, status: 'understand', updatedAt: new Date(now).toISOString() };
      }
    }
    if (e.status === 'candidate') {
      const review = e.review && typeof e.review === 'object' ? e.review : {};
      const shown = Number(review.shownCount || 0);
      if (shown >= 2 && !review.lastDecision) {
        const deferredUntil = now + 30 * 86400e3;
        changes.push({ id: e.id, term: termOf(e), deferredUntil });
        return { ...e, review: { ...review, deferredUntil, state: 'cold' } };
      }
    }
    return e;
  });
  return { entries: next, changes };
}

/** 子注入排序（供 bridge 接线时替换 count 排序用）。 */
export function injectionScore(entry, { now = Date.now() } = {}) {
  const usage = entry?.usage && typeof entry.usage === 'object' ? entry.usage : {};
  return 0.35 * recencyScore(Number(entry?.lastSeenAt) || 0, now)
    + 0.25 * (usage.lastUsedAt ? Math.max(0, 1 - (now - Number(usage.lastUsedAt)) / (14 * 86400e3)) : 0)
    + 0.20 * Math.min(1, Number(usage.landedCount || 0) / Math.max(1, Number(usage.count || 0)) || 0)
    + 0.10 * Math.min(1, Math.max(0, Number(entry?.confidence ?? 0.5)))
    + 0.10 * Math.min(1, (Number(entry?.count) || 0) / 10);
}
