/**
 * 静息重放（task-29，2026-11-09）—— 纯逻辑（不读盘、不注入）
 *
 * 目标：安静时（≥20 分钟没消息 / selfTime 主动机会）挑 1–2 条 ≥7 天的旧记忆，
 * 只给「人 + 大致时间 + 半句话线索」，让她自己想起，而不是被塞结论。
 *
 * 节奏：每会话每天 ≤2 次、间隔 ≥3 小时；与 recent-events/首轮兜底同轮互斥（同轮只出一个记忆提示）。
 * 视图：群上下文只取 group/public 记录；私聊可取 private+public；不跨会话串条。
 */

export const REST_REPLAY_VERSION = 1;
export const REST_REPLAY_RULES = Object.freeze({
  minAgeDays: 7,
  maxAgeDays: 120,
  quietMinutes: 20,
  maxPerDay: 2,
  minIntervalHours: 3,
  maxChars: 120,
  maxRecords: 2,
  mentionWindowHours: 72,
});

function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function dayOf(iso) { return String(iso || '').slice(0, 10); }
function ageDays(at, now) { return (now - Number(at)) / 86400_000; }

/** 记录视图安全：群上下文只允许 group/public；私聊允许 private/public。 */
export function recordVisibleIn(record, convKey) {
  const key = String(convKey || '');
  const isGroup = key.startsWith('group:');
  const origin = String(record?.originKind || 'unknown');
  if (isGroup) return origin === 'group' || origin === 'public';
  if (key.startsWith('private:')) return origin === 'private' || origin === 'public' || origin === 'unknown';
  return false;
}

/** 取记录里的「线索词」：中文 2–4 字片段（去停用词）用于「近 3 天是否被提过」判断。 */
const STOP = new Set(['今天', '明天', '昨天', '自己', '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '可以', '不要', '就是', '还是', '因为', '所以', '然后', '一个', '一下', '没有', '知道', '觉得']);
export function clueTokens(text, { limit = 5 } = {}) {
  const body = norm(text);
  const out = [];
  for (const run of body.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
    for (let len = 2; len <= 4; len += 1) {
      for (let i = 0; i + len <= run.length; i += 1) {
        const tok = run.slice(i, i + len);
        if (STOP.has(tok)) continue;
        out.push(tok);
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

/** 最近 3 天是否有人提过这条记忆（线索词命中 ≥2 个不同词=提过）。 */
export function mentionedRecently(record, recentTexts, { windowHours = REST_REPLAY_RULES.mentionWindowHours, now = Date.now() } = {}) {
  const toks = clueTokens(record?.text || '', { limit: 6 });
  if (!toks.length) return false;
  const hay = (Array.isArray(recentTexts) ? recentTexts : []).join('\n');
  const hits = new Set(toks.filter((t) => hay.includes(t)));
  return hits.size >= 2;
}

/** 选一条重放记录（纯函数）：旧 ≥7 天、中高 salience、近 3 天未被提过、视图安全、不重复。 */
export function selectRestReplay({ records = [], convKey = '', now = Date.now(), recentTexts = [], excludeIds = [], preferSpeakers = [] } = {}) {
  const key = String(convKey || '');
  const isGroup = key.startsWith('group:');
  const scored = [];
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || !r.text) continue;
    const id = String(r.id || '');
    if (id && excludeIds.includes(id)) continue;
    if (norm(r.text).length < 10 || !/[\u4e00-\u9fa5]/.test(String(r.text))) continue;
    if (!recordVisibleIn(r, key)) continue;
    const at = Date.parse(String(r.createdAt || ''));
    if (!Number.isFinite(at)) continue;
    const age = ageDays(at, now);
    if (age < REST_REPLAY_RULES.minAgeDays || age > REST_REPLAY_RULES.maxAgeDays) continue;
    const importance = Number(r.importance) || 0;
    if (importance < 45 && r.pinned !== true) continue;
    if (mentionedRecently(r, recentTexts, { now })) continue;
    // 群记录不能来自私聊会话（防串会话）；私聊允许 private+public+unknown
    const conv = String(r.conversationKey || '');
    if (conv.startsWith('private:') && isGroup) continue;
    if (conv.startsWith('private:') && key.startsWith('group:')) continue;
    const speaker = String(r.speaker || '');
    const prefer = preferSpeakers.includes(speaker) ? 8 : 0;
    const score = importance + Math.min(age, 60) * 0.6 + prefer;
    scored.push({ record: r, at, age, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.length ? scored[0] : null;
}

function roughTime(age) {
  if (age >= 28) return `${Math.floor(age / 7)} 周前`;
  if (age >= 14) return '上周';
  if (age >= 7) return `${Math.floor(age)} 天前`;
  return '前段时间';
}

/** 渲染半句线索（≤120 字）：人 + 大致时间 + 开头半句；不给结论/全文。 */
export function renderRestReplayClue(record, { convKey = '', now = Date.now(), maxChars = REST_REPLAY_RULES.maxChars } = {}) {
  if (!record) return '';
  const text = norm(record.text).replace(/^@[^\s]+[\s:：]*/u, '').replace(/^[「『“"]+/, '');
  if (!text) return '';
  const age = ageDays(Date.parse(String(record.createdAt || '')), now);
  const time = roughTime(age);
  const isGroup = String(convKey || '').startsWith('group:');
  const speaker = String(record.speaker || '');
  const who = isGroup && speaker ? `${speaker}在群里` : (isGroup ? '群里' : (speaker || '你和老大'));
  const head = isGroup ? `${time}${who}聊过一件事，开头是「${text.slice(0, 18)}…」` : `${time}你和老大聊过一件事，开头是「${text.slice(0, 18)}…」`;
  let out = `${head}——想得起后来怎样了吗？（想不起就说想不起，不用硬编）`;
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 1)}…`;
  return out;
}

function localDay(ms) { return new Date(ms).toLocaleDateString('sv-SE'); }

/**
 * 触发/节奏/互斥统一判定（纯函数）：
 *  - 必须是静默 ≥20 分钟或 selfTime 唤醒；
 *  - 每会话每天 ≤2 次、间隔 ≥3 小时；
 *  - 同轮若 recent-events / 首轮兜底已经有记忆提示 → 本机制让位（同轮只出一个记忆提示）。
 */
export function restReplayDecision({
  records = [], convKey = '', now = Date.now(), quietMinutes = 0, reason = '', recentTexts = [],
  replayState = {}, recentEventsActive = false, firstTurnActive = false, excludeIds = [],
} = {}) {
  const key = String(convKey || '');
  const isQuiet = Number(quietMinutes) >= REST_REPLAY_RULES.quietMinutes;
  const isSelfTime = /selfTime|主动|proactive/i.test(String(reason || ''));
  if (!isQuiet && !isSelfTime) return { line: '', record: null, injected: false, reason: 'not-quiet-trigger' };
  if (recentEventsActive || firstTurnActive) return { line: '', record: null, injected: false, reason: 'mutex-other-memory-hint' };
  const st = replayState && typeof replayState === 'object' ? replayState : {};
  const day = localDay(now);
  const todayCount = st.day === day ? Number(st.count) || 0 : 0;
  if (todayCount >= REST_REPLAY_RULES.maxPerDay) return { line: '', record: null, injected: false, reason: 'daily-limit' };
  const lastAt = Number(st.lastAt) || 0;
  if (lastAt && now - lastAt < REST_REPLAY_RULES.minIntervalHours * 3600_000) return { line: '', record: null, injected: false, reason: 'min-interval' };
  const recentIds = (Array.isArray(st.recentIds) ? st.recentIds : [])
    .filter((x) => x && x.id && now - Number(x.at || 0) < 7 * 86400_000)
    .map((x) => String(x.id));
  const picked = selectRestReplay({ records, convKey: key, now, recentTexts, excludeIds: [...excludeIds, ...recentIds] });
  if (!picked) return { line: '', record: null, injected: false, reason: 'no-candidate' };
  const line = renderRestReplayClue(picked.record, { convKey: key, now });
  if (!line) return { line: '', record: null, injected: false, reason: 'render-empty' };
  return { line, record: picked.record, injected: true, reason: 'inject', ageDays: Math.round(picked.age * 10) / 10 };
}

/** 记录一次注入后的新 state（纯函数，供 bridge/shadow 存盘）。 */
export function nextReplayState(state, { now = Date.now(), recordId = '' } = {}) {
  const key = String(localDay(now));
  const st = state && typeof state === 'object' ? state : {};
  const recentIds = (Array.isArray(st.recentIds) ? st.recentIds : [])
    .filter((x) => x && x.id && now - Number(x.at || 0) < 7 * 86400_000)
    .slice(-20);
  if (recordId) recentIds.push({ id: String(recordId), at: now });
  return { ...st, day: key, count: (st.day === key ? Number(st.count) || 0 : 0) + 1, lastAt: now, recentIds };
}
