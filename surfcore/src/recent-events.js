/**
 * 最近事件层（recent-events）—— 纯逻辑模块（task-26，2026-11-09）
 *
 * 背景：昨晚群里已经在聊「氷渡香名江 実装決定」，今天 09:40 她看到相关调𰋵漫画时
 * 像第一次看到——「最近群里在聊什么」在新回合里默认失踪。原料在 memory-inbox 里，
 * 但没变成「最近事件」进入群上下文。
 *
 * 本模块从最近 48h 的群聊/私聊里按「专名 + 重复提及 + 多人参与 + 事件关键词」提取事件：
 *   · 每条 ≤40 字：事件（专名+类型）+ 出现时间 + 参与人数；keywords/participants 另存 JSON；
 *   · 去重/排序：多人 > 单人，新 > 旧，专名（片假名/引号/英文）> 泛词；
 *   · 渲染 `recentEventsLine(convKey, maxChars=120)`：群聊只取本群；私聊可取私聊+共享群事件；
 *   · 本模块不注入、不写 prompt（shadow），只产出数据与行文本。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, '..', 'state');
export const RECENT_EVENTS_VERSION = 1;
export const MAX_EVENT_CHARS = 40;
export const DEFAULT_HOURS = 48;
export const DEFAULT_FILE = path.join(STATE_DIR, 'recent-events.json');

// 事件类型：关键词 → 类型标签（优先级按数组顺序）
const EVENT_TYPES = [
  ['实装', /実装|实装|上线|出了|登场|参战|追加/],
  ['卡池', /卡池|池子|抽卡|限定池|复刻|pickup|PU/i],
  ['活动', /活动|联动|周年|生日|生诞|live|演唱会|公演/i],
  ['公布', /公布|公告|官宣|发表|公开|正式确认/],
  ['直播', /直播|配信|转播/],
  ['约定', /约定|说好|下次一起|答应|说定了/],
  ['梗', /梗|段子|名场面|玩梗|群体梗/],
];

// 泛词/停用词：不能当专名（也防止「今天/大家/老大」被提成事件）
const STOPWORDS = new Set([
  '今天', '明天', '昨天', '前天', '刚才', '刚刚', '现在', '晚上', '早上', '下午', '中午', '半夜',
  '大家', '我们', '你们', '他们', '她们', '自己', '别人', '有人', '没人', '这个人', '那个人',
  '这个', '那个', '什么', '怎么', '为什么', '是不是', '有没有', '能不能', '可以', '不行', '好的',
  '老大', '主人', '群里', '群友', '消息', '内容', '东西', '事情', '问题', '感觉', '真的', '有点',
  '一个', '一下', '一点', '一样', '这种', '那种', '就是', '不是', '还是', '已经', '因为', '所以',
  '好像', '处理', '觉得', '感觉', '应该', '需要', '可以', '可能', '一直', '真的', '有点', '也是',
  '但是', '不过', '而且', '然后', '如果', '虽然', '可能', '应该', '需要', '知道', '看到', '听到',
  '哈哈', '哈哈哈', '笑死', '草', '好家伙', '确实', '真的假的', '厉害了', '表情', '图片', '视频',
  '游戏', '角色', '新角色', '活动', '卡池', '实装', '消息', '情报', '官方', '推特', '论坛',
  '女仆', '女人', '男人', '玩家', '偶像', '学校', '学生', '建模', '剧情', '声优', '动画',
  '一声', '我一声', '一声萝', '一声声', '链接', '省略', 'jpg', 'jpeg', 'png', 'http', 'https', 'www',
]);
const CJK = /[\u4e00-\u9fa5]/;
const KATAKANA = /[\u30a0-\u30ffー]{2,}/g;
const QUOTED = /[「『“"]([^」』”"]{2,12})[」』”"]/g;
const LATIN = /\b[A-Za-z][A-Za-z0-9._-]{2,}\b/g;

function normText(t) { return String(t || '').replace(/\s+/g, ' ').trim(); }

// 提取候选前先把「事件词」挖掉：否则「账号公布」会被切成「账号公」这种假专名。
const EVENT_MASK_RE = /実装|实装|卡池|活动|联动|直播|公布|约定|话题|周年|公告|官宣|梗/;

/** 消息 → 候选专名 token（CJK 2–4 gram + 片假名 + 引号内容 + 英文词）。 */
export function candidateTokens(text) {
  const body = normText(text);
  const masked = body
    .replace(/\[[^\]]{0,60}\]/g, ' ') // [图片]/[转发消息 id=...] 等占位
    .replace(/（[^）]{0,40}已省略[^）]{0,10}）/g, ' ') // （链接已省略）
    .replace(new RegExp(EVENT_MASK_RE.source, 'g'), ' ');
  const out = new Set();
  for (const run of masked.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
    for (let len = 2; len <= 4; len += 1) {
      for (let i = 0; i + len <= run.length; i += 1) {
        const tok = run.slice(i, i + len);
        if (STOPWORDS.has(tok)) continue;
        out.add(tok);
      }
    }
  }
  for (const m of body.matchAll(KATAKANA)) {
    if (m[0].length >= 2 && m[0].length <= 10) out.add(m[0]);
  }
  for (const m of body.matchAll(QUOTED)) {
    const tok = normText(m[1]);
    if (tok.length >= 2 && tok.length <= 12) out.add(tok);
  }
  for (const m of body.matchAll(LATIN)) {
    if (m[0].length >= 3 && m[0].length <= 16) out.add(m[0]);
  }
  return [...out];
}

function eventTypeOf(text) {
  for (const [label, re] of EVENT_TYPES) if (re.test(text)) return label;
  return '';
}

/** 专名加成：片假名/引号/英文/含数字的专名更像「名字」，普通中文 2 字词降权。 */
// ── 别名表（2026-11-09，PM 拍板 B+ 锚点触发用）──────────────────────────────
// 当前聊天提到任一别名 → 才注入对应事件行。静态种子 + 提取时观察到的变体，事件条目带 aliases[]。
export const EVENT_ALIASES = Object.freeze({
  '香名江': ['香名江', '名江', '氷渡', '冰渡', '氷渡香名江', '冰渡香名江', 'ひめ', 'hime'],
  '双人曲': ['双人曲', '学马双人曲', '专辑第二弹'],
  '卡池': ['卡池', '池子', '抽卡', '11/16', '11-16'],
  '学马': ['学马', '学园偶像大师', 'gakumas', '初星'],
  '美铃': ['美铃', '美鈴'],
  '千奈': ['千奈'],
  '甜甜圈': ['甜甜圈', 'donut', '甜甜圈梗'],
  '常服': ['常服', '常服设定', '常服公布'],  // 2026-11-09：去掉「女仆/女仆装」——太泛，会把「香名江女仆」误挂到常服事件（memory-watch 复核）
  '努努': ['努努'],
  '林酱': ['林酱'],
  'syngup': ['syngup', '前队友'],
});

/** 事件 → 别名列表：静态 + 事件 token 本身 + 提取时观察到的更长/更短变体。 */
export function aliasesFor(token, observed = []) {
  const base = new Set([String(token)]);
  for (const a of EVENT_ALIASES[token] || []) base.add(String(a));
  for (const o of observed) {
    const v = String(o);
    if (v.length >= 2 && (v.includes(token) || token.includes(v))) base.add(v);
  }
  return [...base].slice(0, 8);
}

export function normalizeMatchText(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, '').replace(/[／/]/g, '/');
}

/** 当前文本是否提到该事件的任一别名。 */
export function eventMatchesText(event, text) {
  const hay = normalizeMatchText(text);
  if (!hay) return false;
  const aliases = Array.isArray(event?.aliases) && event.aliases.length ? event.aliases : aliasesFor((event?.tokens || [])[0] || '');
  return aliases.some((a) => {
    const needle = normalizeMatchText(a);
    return needle.length >= 2 && hay.includes(needle);
  });
}

// 事件词本身不能当专名（「账号公布」「学马氏活动」这类是描述，不是名字）
const EVENT_WORD_RE = /实装|卡池|活动|联动|直播|公布|约定|梗|话题|周年|公告|官宣/;
// 含这些高频虚词/通用字的 n-gram 基本不是专名（香名江/冰渡/美铃/千奈都不含）
const COMMON_CHARS = /[的了们吗呢吧我你他她它在有就都说要这那个上下出来去事话时天点人次吧呀啊哦嗯]/;

function properBonus(token) {
  if (/^[\u30a0-\u30ffー]{2,}$/.test(token)) return 3;
  if (/[A-Za-z]/.test(token)) return 2;
  if (token.length >= 3) return 1.5;
  return 0;
}

/**
 * 从消息数组提取事件。
 * @param {Array<{at:number, conversationKey:string, sender:string, isSelf?:boolean, isOwner?:boolean, text:string}>} messages
 * @param {{now?:number, hours?:number, knownNames?:string[], minParticipants?:number}} opts
 */
/**
 * 单会话事件提取：只统计「非自己」的发言（自己的话不定义群体事件），
 * 排除群昵称碎片，要求 多人参与 + 重复提及 + 专名/事件词。
 */
export function extractEventsForMessages(messages, { now = Date.now(), knownNames = [] } = {}) {
  const known = new Set((Array.isArray(knownNames) ? knownNames : []).filter((x) => String(x).length >= 2));
  const senderNames = [...new Set(messages.map((m) => String(m.sender || '')).filter(Boolean))];
  const isSenderFragment = (tok) => senderNames.some((n) => n.length > tok.length && n.toLowerCase().includes(tok.toLowerCase()));
  const stats = new Map();
  for (const m of messages) {
    if (m.isSelf === true) continue;                       // 她自己的发言不算群体事件
    const text = String(m.text || '');
    if (!text.trim()) continue;
    if (/^\[(图片|视频|表情|表情包|语音|文件|转发消息|拍一拍)/.test(text.trim())) continue;
    for (const tok of candidateTokens(text)) {
      if (tok.length < 2 || tok.length > 12 || STOPWORDS.has(tok)) continue;
      if (/链接|省略|转发消息/.test(tok)) continue;
      if (/^(怎么|什么|为什么|哪|多少|是不是|有没有|可以|不要|不能|还是|就是)/.test(tok)) continue;
      if (isSenderFragment(tok)) continue;                 // 「神秘/在线/装傻」是群昵称碎片
      const rec = stats.get(tok) || { token: tok, n: 0, senders: new Set(), texts: new Set(), times: [], types: new Map(), sample: '', latestAt: 0, latestText: '' };
      rec.n += 1;
      rec.senders.add(String(m.sender || ''));
      rec.texts.add(normText(text).slice(0, 80));
      rec.times.push(Number(m.at));
      if (Number(m.at) >= Number(rec.latestAt || 0)) { rec.latestAt = Number(m.at); rec.latestText = normText(text).slice(0, 60); }
      const type = eventTypeOf(text);
      if (type) rec.types.set(type, (rec.types.get(type) || 0) + 1);
      if (String(text).length > String(rec.sample).length) rec.sample = normText(text).slice(0, 60);
      stats.set(tok, rec);
    }
  }
  const ranked = [...stats.values()].map((rec) => {
    const participants = rec.senders.size;
    const mentions = rec.n;
    const rawType = [...rec.types.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    const typeCount = [...rec.types.values()].reduce((a, b) => a + b, 0);
    // 事件词占比太低（如 6 次提及只有 1 次带「实装」）→ 不按事件类型算，走专名话题分支
    const eventType = rawType && typeCount / rec.n >= 0.25 ? rawType : '';
    const latest = Math.max(...rec.times);
    const recencyHours = (now - latest) / 3600_000;
    const bonus = properBonus(rec.token);
    // 新 > 旧：12h 内最多 +3，越新越高（多人/专名的权重仍更高，避免刷屏旧事压过新事件）
    const recencyBonus = Math.max(0, 3 - recencyHours / 12);
    const score = participants * 3 + Math.min(mentions, 10) * 1.2 + typeCount * 2 + bonus
      + recencyBonus + (known.has(rec.token) ? 2 : 0);
    return { ...rec, participants, mentions, eventType, typeCount, latest, score, senders: [...rec.senders], bonus };
  }).filter((rec) => {
    const tok = rec.token;
    if (tok.length < 2 || tok.length > 8 || /^\d+$/.test(tok)) return false;
    if (EVENT_WORD_RE.test(tok)) return false;          // 「账号公布」不是专名
    if (COMMON_CHARS.test(tok) && !known.has(tok)) return false;
    // 长句里切出来的「女仆超车/被不知」不是专名：只在同一条重复文本里出现的 token 丢掉，
    // 首尾是虚词/动词的也丢掉（真正的名字很少以「被/把/还/在」开头）。
    if (!known.has(tok) && /^[被把让给在是了的和跟向从对就都也还又很太最更不没有说看听想要会可能来去上下出进回到个这那你我他她它们吗呢吧啊哦呀嘛]|[...]$/.test(tok)) return false;
    const hasType = Boolean(rec.eventType);
    const isKnown = known.has(tok);
    if (!isKnown && rec.texts.size < 2) return false;   // 只在同一条文本里出现的不算（重复刷屏/引用）
    if (rec.eventType === '梗' && rec.mentions < 3) return false; // 梗类：重复提及 ≥3 次才进
    const proper = rec.bonus >= 1; // ≥3 字中文/假名等专名加成
    const properCJK = /^[\u4e00-\u9fa5]{3,6}$/.test(tok) || /^[\u30a0-\u30ffー]{2,}$/.test(tok);
    if (!hasType) {
      // memory-watch 2026-11-10：无事件词的「多人多次专名」不丢；但只收中文 ≥3 字/片假名，防 AAA/jpg/短链噪声
      if (rec.participants >= 2 && rec.mentions >= 3 && properCJK) return true;
      return isKnown && rec.participants >= 3 && rec.mentions >= 4;
    }
    if (rec.participants < 3) return false;             // B+：有事件词的事件仍要求 ≥3 人参与
    const purity = rec.mentions ? rec.typeCount / rec.mentions : 0;
    return rec.mentions >= 2 && purity >= 0.25 && (proper || isKnown);
  }).sort((a, b) => (b.score - a.score) || (b.token.length - a.token.length));

  const picked = [];
  const bigramsOf = (t) => { const s = String(t || ''); const out = new Set(); for (let i = 0; i + 2 <= s.length; i += 1) out.add(s.slice(i, i + 2)); return out; };
  const overlapRatio = (a, b) => { const A = bigramsOf(a), B = bigramsOf(b); if (!A.size || !B.size) return 0; let inter = 0; for (const g of A) if (B.has(g)) inter += 1; return inter / Math.min(A.size, B.size); };
  for (const rec of ranked) {
    if (picked.some((p) => p.eventType === rec.eventType && (p.token.includes(rec.token) || rec.token.includes(p.token) || overlapRatio(p.token, rec.token) >= 0.5))) continue;
    picked.push(rec);
  }
  if (process.env.RE_DEBUG) { const t = stats.get('香名江'); if (t) console.error('[re-debug] 香名江', JSON.stringify({ n: t.n, senders: t.senders.size, texts: t.texts.size, types: [...t.types.keys()] })); }
  const normal = picked.map((rec) => {
    const type = rec.eventType || '话题';
    const d = new Date(rec.latest);
    const timeLabel = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const head = `${rec.token}${type}`;
    let text = `${head}（${timeLabel}，${rec.participants}人）`;
    if (text.length > MAX_EVENT_CHARS) text = `${head.slice(0, Math.max(6, MAX_EVENT_CHARS - 14))}…（${timeLabel}）`;
    // 别名：静态 + 同批候选里观察到、包含该 token 的更长变体（如 香名江 → 冰渡香名江）
    const observed = [...stats.keys()].filter((t) => t !== rec.token && t.includes(rec.token) && t.length >= 2 && t.length <= 8 && !EVENT_MASK_RE.test(t) && (stats.get(t)?.n || 0) >= 2);
    return {
      id: `ev_${rec.token}_${rec.latest}`,
      text,
      tokens: [rec.token],
      aliases: aliasesFor(rec.token, observed),
      keywords: [...rec.types.keys()].slice(0, 4),
      eventType: type,
      anchorEligible: Boolean(EVENT_ALIASES[rec.token]) || ['实装', '卡池', '活动', '直播', '公布', '约定', '曲'].includes(rec.eventType),
      time: rec.latest,
      timeLabel,
      participants: rec.participants,
      participantNames: rec.senders.slice(0, 8),
      mentions: rec.mentions,
      // B+：24h 内还在聊 = active（进注入候选）；24–48h = 持续事件标记（不常驻）
      active: now - rec.latest <= 24 * 3600_000,
      sustained: now - rec.latest > 24 * 3600_000 && now - rec.latest <= 48 * 3600_000,
      heat6h: rec.times.filter((t) => now - t <= 6 * 3600_000).length,
      mentions24h: rec.times.filter((t) => now - t <= 24 * 3600_000).length,
      score: Math.round(rec.score * 10) / 10,
      sample: rec.latestText || rec.sample,
    };
  });
  // 计划/约定/日期类事件（模板提取，补 双人曲/卡池/约定 缺口）；与普通事件按 token+type 去重
  const planned = extractPlannedEvents(messages, { now });
  const merged = [...normal];
  for (const ev of planned) {
    if (!merged.some((e) => (e.tokens || []).some((t) => t === ev.tokens[0]) && e.eventType === ev.eventType)) merged.push(ev);
  }
  return merged.sort((a, b) => b.score - a.score);
}

/**
 * 从消息数组提取事件（按会话分别提取；群事件作为 sharedEvents 供私聊共享）。
 * @param {Array<{at:number, conversationKey:string, sender:string, isSelf?:boolean, text:string}>} messages
 */
export function extractRecentEvents(messages, { now = Date.now(), hours = DEFAULT_HOURS, knownNames = [] } = {}) {
  const since = now - hours * 3600 * 1000;
  const use = (Array.isArray(messages) ? messages : []).filter((m) => {
    const at = Number(m?.at);
    const key = String(m?.conversationKey || '');
    return Number.isFinite(at) && at >= since && at <= now + 60_000
      && (key.startsWith('group:') || key.startsWith('private:'))
      && String(m?.text || '').trim().length > 0;
  });
  const byKey = new Map();
  for (const m of use) {
    const key = String(m.conversationKey);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(m);
  }
  const conversations = {};
  for (const [key, list] of byKey) {
    const events = extractEventsForMessages(list, { now, knownNames });
    if (events.length) conversations[key] = { events: events.slice(0, 8) };
  }
  const sharedEvents = Object.entries(conversations)
    .filter(([k]) => k.startsWith('group:'))
    .flatMap(([k, v]) => v.events.map((e) => ({ ...e, fromGroup: k })))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  return {
    version: RECENT_EVENTS_VERSION,
    generatedAt: now,
    windowHours: hours,
    messageCount: use.length,
    conversations,
    sharedEvents,
  };
}

/**
 * 渲染：群聊只取本群；私聊取私聊+共享群事件。无事件返回 ''。
 * 可选 context：只渲染「事件专名出现在当前上下文里」的条目（相关性门控）。
 *   —— 常驻整行在私聊/无关话题轮次噪音很大，门控版才适合真正注入。
 */
export function renderRecentEventsLine(data, convKey, maxChars = 120, { context = null } = {}) {
  const key = String(convKey || '');
  const isGroup = key.startsWith('group:');
  const own = (data?.conversations?.[key]?.events || []).filter((e) => e.active !== false);
  const shared = isGroup ? own : [
    ...own,
    ...(Array.isArray(data?.sharedEvents) ? data.sharedEvents.filter((e) => e.active !== false && !own.some((x) => x.text === e.text)) : []),
  ];
  const ctx = context === null || context === undefined ? null : String(context);
  // context 传了就严格门控（空上下文 = 不推，宁缺毋滥）；不传 = 常驻整行（旧行为，用于对比）
  const gated = ctx === null
    ? shared
    : shared.filter((e) => (e.tokens || []).some((t) => t && ctx.includes(t)));
  const events = gated.slice(0, 4).filter((e) => e && e.text);
  if (!events.length) return '';
  const header = isGroup ? '【最近群里在聊】' : '【最近群里/私聊在聊】';
  const body = events.map((e) => e.text).join('；');
  let out = `${header}${body}`;
  if (out.length > maxChars) out = `${out.slice(0, Math.max(0, maxChars - 1))}…`;
  return out;
}

function renderMatched(events, isGroup, maxChars) {
  const list = (events || []).slice(0, 2).filter((e) => e && e.text);
  if (!list.length) return '';
  const header = isGroup ? '【最近群里在聊】' : '【最近群里/私聊在聊】';
  let out = `${header}${list.map((e) => e.text).join('；')}`;
  if (out.length > maxChars) out = `${out.slice(0, Math.max(0, maxChars - 1))}…`;
  return out;
}

// ── 图片唤醒兜底（PM 2026-11-09 拍板：少注入、0 噪音优先）──────────────────
// 仅 image 唤醒；本轮无文本锚点；群内 24h active 事件且 participants≥4、最近 12h 被提到；
// 每群 4h 最多 1 次（限频由调用方存 lastFallbackAt）；私聊不做。
export const IMAGE_FALLBACK = Object.freeze({ minParticipants: 4, maxEventAgeH: 12, cooldownH: 4, dailyMax: 1, maxChars: 120 });
// 锚点注入只认 active 且 12h 内被提到的「新鲜」事件（memory-watch 复核：旧事件误挂要修）
export const FRESH_EVENT_HOURS = 12;
export function eventIsFresh(event, now = Date.now()) {
  return Boolean(event) && event.active !== false && now - Number(event.time) <= FRESH_EVENT_HOURS * 3600_000;
}

// ── 计划/约定/日期类事件模板（memory-watch 指出 双人曲/卡池/约定 提取缺口）────────
const PLAN_PATTERNS = [
  { type: '卡池', re: /卡池|池子|抽卡|复刻|新池/, need: /(\d{1,2}[\/.月]\d{1,2})|下回|下期|下池|更新|什么时候|周年/, tokenOf: (t) => { const m = t.match(/(\d{1,2}[\/.]\d{1,2})|(\d{1,2}月\d{1,2}日?)/); return m ? `卡池${m[0]}` : '卡池'; } },
  { type: '曲', re: /双人曲|双人曲专辑|新曲|专辑第二弹/, need: /双人曲|双人|专辑|曲/, tokenOf: () => '双人曲' },
  { type: '约定', re: /约好|说定了|答应|下次一起|约定/, need: /约好|说定|答应|下次一起|约定/, tokenOf: (t) => { const m = t.match(/「([^」]{2,10})」/); return m ? m[1] : '约定'; } },
];

/** 计划/约定类事件（可来自她自己的发言；模板强、噪音低；participants 包含自己，单源事件标 planned 供上层甄别）。 */
export function extractPlannedEvents(messages, { now = Date.now(), knownNames = [] } = {}) {
  const found = new Map();
  for (const m of messages) {
    const text = String(m.text || '');
    if (!text.trim() || /^\[(图片|视频|表情|表情包|语音|文件|转发消息|拍一拍)/.test(text.trim())) continue;
    for (const pat of PLAN_PATTERNS) {
      if (!pat.re.test(text) || !pat.need.test(text)) continue;
      const token = pat.tokenOf(text);
      if (!token || token.length < 2) continue;
      const key = `${token}|${pat.type}`;
      const rec = found.get(key) || { token, type: pat.type, senders: new Set(), times: [], texts: new Set(), sample: '' };
      rec.senders.add(String(m.sender || (m.isSelf ? '她' : '')));
      rec.times.push(Number(m.at));
      if (Number(m.at) >= Number(rec.latestAt || 0)) { rec.latestAt = Number(m.at); rec.latestText = normText(text).slice(0, 60); }
      rec.texts.add(normText(text).slice(0, 80));
      if (String(text).length > String(rec.sample).length) rec.sample = normText(text).slice(0, 70);
      found.set(key, rec);
    }
  }
  const events = [];
  for (const rec of found.values()) {
    const latest = Math.max(...rec.times);
    const participants = rec.senders.size;
    if (rec.type === '约定' && participants < 2) continue; // 单源「约定」不进事件
    const aliases = new Set([rec.token]); // 类型标签（曲/约定…）不当别名
    if (rec.type === '卡池') { for (const a of ['卡池', '池子', '抽卡', '复刻', '新池', '11/16']) aliases.add(a); }
    if (rec.type === '曲') { for (const a of ['双人曲', '学马双人曲', '专辑第二弹']) aliases.add(a); }
    if (rec.type === '约定') { for (const a of ['约定', '约好', '说定', '下次一起']) aliases.add(a); }
    for (const a of EVENT_ALIASES[rec.token] || []) aliases.add(a);
    const d = new Date(latest);
    const timeLabel = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    let text = `${rec.token}（${timeLabel}，${participants}人）`;
    if (text.length > MAX_EVENT_CHARS) text = `${rec.token.slice(0, 16)}…（${timeLabel}）`;
    events.push({
      id: `ev_plan_${rec.token}_${latest}`,
      text,
      tokens: [rec.token],
      aliases: [...aliases].slice(0, 8),
      keywords: [rec.type],
      eventType: rec.type,
      anchorEligible: true,
      time: latest,
      timeLabel,
      participants,
      participantNames: [...rec.senders].slice(0, 8),
      mentions: rec.times.length,
      planned: true,
      active: now - latest <= 24 * 3600_000,
      sustained: now - latest > 24 * 3600_000 && now - latest <= 48 * 3600_000,
      heat6h: rec.times.filter((t) => now - t <= 6 * 3600_000).length,
      mentions24h: rec.times.filter((t) => now - t <= 24 * 3600_000).length,
      score: 8 + participants * 1.5 + Math.max(0, 3 - (now - latest) / 12 / 3600_000),
      sample: [...rec.texts][0] || rec.sample, // 用触发句当 sample，别拿最长句
    });
  }
  return events.sort((a, b) => b.score - a.score);
}

// 首轮兜底口径（2026-11-09 10:37 冻结为 shadow 基线；变更需通知 memory-watch 重基线）
export const FIRSTTURN_RULES = Object.freeze({ silenceBypassH: 2, freshH: 12, oncePerDay: 1 });
// 首轮兜底的事件类型权重（memory-watch 复核：07:40 大小姐梗 score 会压过香名江，需要类型优先）
export const FIRSTTURN_TYPE_WEIGHT = Object.freeze({ 实装: 2, 卡池: 2, 活动: 2, 公布: 2, 直播: 2, 约定: 2, 曲: 1, 梗: -2 });

/**
 * 每会话每天第一轮兜底（shadow 用，2026-11-09 PM 口径）：
 *   · 候选 = 本会话 24h active 事件（participants≥3），且事件专名/别名
 *     出现在「最近 10 条消息」或「最近 2 小时消息」里（= 最近对话锚点，不用纯时间窗）；
 *   · 排序 = base score + 类型权重（实装/卡池/活动/公布/约定 +2、梗 −2）；
 *   · 每天每会话 1 次（调用方控制）、最多 1 行；
 *   · memoryTexts 里已有同专名 → 不重复注入（dedupHit）；前 2 天首轮注入过的 token → 跳过（recentSkip）。
 * opts: { data, convKey, now, recentMessages: [{at,text}] | string[], memoryTexts, recentInjectedTokens }
 */
export function firstTurnFallbackDecision({ data, convKey, now = Date.now(), recentMessages = [], memoryTexts = [], recentInjectedTokens = [], enforceFresh = true } = {}) {
  const key = String(convKey || '');
  const own = (data?.conversations?.[key]?.events || []).filter((e) => e.active !== false && !e.planned);
  // 最近对话锚点文本：最近 10 条 或 最近 2 小时（并集）
  const msgs = (Array.isArray(recentMessages) ? recentMessages : [])
    .map((m) => (typeof m === 'string' ? { at: now, text: m } : { at: Number(m?.at) || 0, text: String(m?.text || '') }))
    .filter((m) => m.text);
  const last10 = msgs.slice(-10).map((m) => m.text).join('\n');
  const last2h = msgs.filter((m) => now - m.at <= 2 * 3600_000).map((m) => m.text).join('\n');
  const anchorHay = `${last10}\n${last2h}`;
  // 补丁 A（memory-watch 2026-11-09）：静默 ≥2h 的首轮免锚点（用 24h 热度+类型权重）；
  // 静默 <2h 才要求「最近 10 条 / 最近 2h」对话锚点。解决 07:40 隔夜首轮进不了香名江的问题。
  const lastMsgAt = msgs.length ? Number(msgs[msgs.length - 1].at) : 0;
  const silenceMs = lastMsgAt ? Math.max(0, now - lastMsgAt) : Infinity;
  const anchorRequired = silenceMs < FIRSTTURN_RULES.silenceBypassH * 3600_000;
  const memoryHay = (Array.isArray(memoryTexts) ? memoryTexts : []).join('\n');
  const recentTokens = new Set((Array.isArray(recentInjectedTokens) ? recentInjectedTokens : []).map(String));
  let dedupHit = false;
  let recentSkip = false;
  let noAnchor = false;
  const candidates = own
    .filter((e) => Number(e.participants) >= 3)
    .filter((e) => (enforceFresh ? now - Number(e.time) <= FRESH_EVENT_HOURS * 3600_000 : true))
    .filter((e) => {
      const aliases = Array.isArray(e.aliases) && e.aliases.length ? e.aliases : [(e.tokens || [])[0] || ''];
      const anchored = aliases.some((a) => a && anchorHay.includes(String(a)));
      if (anchorRequired && !anchored) { noAnchor = true; return false; }
      const token = (e.tokens || [])[0] || '';
      if (token && memoryHay.includes(token)) { dedupHit = true; return false; }
      if (token && recentTokens.has(token)) { recentSkip = true; return false; }
      return true;
    })
    .map((e) => ({ e, rank: Number(e.score) + (FIRSTTURN_TYPE_WEIGHT[e.eventType] || 0) }))
    .sort((a, b) => (b.rank - a.rank) || (Number(b.e.participants) - Number(a.e.participants)) || (Number(b.e.time) - Number(a.e.time)));
  const silenceH = Number.isFinite(silenceMs) ? Math.round((silenceMs / 3600_000) * 10) / 10 : null;
  if (!candidates.length) {
    const reason = dedupHit ? 'dedup-hit' : (recentSkip ? 'recent-day' : (noAnchor ? 'no-recent-anchor' : 'no-qualified-event'));
    return { line: '', event: null, reason, dedupHit, recentSkip, candidates: [], silenceH, anchorRequired };
  }
  const chosen = candidates[0].e;
  return {
    line: renderMatched([chosen], key.startsWith('group:'), 120),
    event: chosen,
    reason: 'inject',
    rank: candidates[0].rank,
    candidates: candidates.slice(0, 4).map((x) => ({ text: x.e.text, rank: x.rank, eventType: x.e.eventType })),
    dedupHit,
    recentSkip,
    silenceH,
    anchorRequired,
  };
}

/**
 * 图片唤醒兜底（PM 2026-11-09）：仅 image 唤醒 + 无文本锚点；
 * 群内 24h active 事件 participants≥4、12h 内被提；每群 4h/每天 1 次；排序含类型权重。
 */
export function imageFallbackDecision({ data, convKey, text = '', now = Date.now(), lastFallbackAt = 0, lastFallbackDay = '' } = {}) {
  const key = String(convKey || '');
  if (!key.startsWith('group:')) return { line: '', event: null, reason: 'not-group' };
  const today = new Date(now).toLocaleDateString('sv-SE');
  if (lastFallbackDay && lastFallbackDay === today) return { line: '', event: null, reason: 'daily-limit' };
  if (lastFallbackAt && now - Number(lastFallbackAt) < IMAGE_FALLBACK.cooldownH * 3600_000) {
    return { line: '', event: null, reason: 'cooldown' };
  }
  const own = (data?.conversations?.[key]?.events || []).filter((e) => e.active !== false);
  if (!own.length) return { line: '', event: null, reason: 'no-event' };
  if (own.some((e) => eventMatchesText(e, text))) return { line: '', event: null, reason: 'has-anchor' };
  const eligible = own
    .filter((e) => Number(e.participants) >= IMAGE_FALLBACK.minParticipants)
    .filter((e) => now - Number(e.time) <= IMAGE_FALLBACK.maxEventAgeH * 3600_000)
    .map((e) => ({ e, rank: Number(e.participants) * 4 + (FIRSTTURN_TYPE_WEIGHT[e.eventType] || 0) }))
    .sort((a, b) => (b.rank - a.rank) || (Number(b.e.time) - Number(a.e.time)));
  if (!eligible.length) return { line: '', event: null, reason: 'no-qualified-event' };
  const ev = eligible[0].e;
  return { line: renderMatched([ev], true, IMAGE_FALLBACK.maxChars), event: ev, reason: 'inject' };
}

/** B+ 统一入口：锚点（fresh）→ 首轮兜底 → 图片兜底 → 群热度兜底。 */
export function renderRecentEventsLineFor(data, convKey, text, maxChars = 120, opts = {}) {
  const key = String(convKey || '');
  const isGroup = key.startsWith('group:');
  const own = (data?.conversations?.[key]?.events || []).filter((e) => e.active !== false);
  const events = isGroup ? own : [
    ...own,
    ...(Array.isArray(data?.sharedEvents) ? data.sharedEvents.filter((e) => e.active !== false && !own.some((x) => x.text === e.text)) : []),
  ];
  const nowMs = Number.isFinite(opts.now) ? opts.now : Date.now();
  const matched = events.filter((e) => e.anchorEligible !== false && eventMatchesText(e, text) && eventIsFresh(e, nowMs));
  if (matched.length) return renderMatched(matched, isGroup, maxChars);
  if (opts.firstTurn === true) {
    const decision = firstTurnFallbackDecision({
      data, convKey: key, now: nowMs,
      recentMessages: opts.recentMessages || [], memoryTexts: opts.memoryTexts || [], recentInjectedTokens: opts.recentInjectedTokens || [],
    });
    return decision.line;
  }
  if (opts.imageWake === true) {
    const decision = imageFallbackDecision({ data, convKey: key, text, now: nowMs, lastFallbackAt: opts.lastFallbackAt || 0, lastFallbackDay: opts.lastFallbackDay || '' });
    return decision.line;
  }
  if (!isGroup) return '';
  const hot = events.filter((e) => Number(e.participants) >= 4 && Number(e.heat6h) >= 3);
  if (hot.length) return renderMatched(hot.slice(0, 1), isGroup, maxChars);
  return '';
}

export function loadRecentEvents(file = DEFAULT_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function recentEventsLine(convKey, maxChars = 120, { file = DEFAULT_FILE, data = null, context = null } = {}) {
  return renderRecentEventsLine(data || loadRecentEvents(file), convKey, maxChars, { context });
}

/**
 * B+ 锚点触发接口：传当前聊天文本，只有提到事件别名（或热度/图片兜底）才返回一行。
 * 支持两种调用：recentEventsLineFor(text, convKey, maxChars, opts) 或 recentEventsLineFor(text, convKey, opts)。
 * opts: { file, data, imageWake, firstTurn, now, lastFallbackAt, lastFallbackDay }
 */
export function recentEventsLineFor(text, convKey, maxChars = 120, opts = {}) {
  if (maxChars && typeof maxChars === 'object') { opts = maxChars; maxChars = 120; }
  const { file = DEFAULT_FILE, data = null, ...rest } = opts;
  return renderRecentEventsLineFor(data || loadRecentEvents(file), convKey, text, maxChars, rest);
}
