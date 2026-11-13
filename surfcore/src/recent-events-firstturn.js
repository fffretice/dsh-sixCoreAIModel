// 2026-11-10 task-39：记忆事件层「每会话每天第一轮」兜底接线（纯函数层，不写盘）。
// 契约来自 memory `knowledge/recent-events-layer.md §11`：
//   · 接口 recentEventsLineFor(..., {firstTurn:true}) / firstTurnFallbackDecision
//   · 位置 memoryCardLine 之后，≤120 字、独立一行
//   · shadow 只写 would-inject 日志；inject 才进 prompt
//   · 群只取群来源、私聊可取共享事件（renderer 已按视图区分）
//   · 失败/文件过期（>30min）→ 空串
import { firstTurnFallbackDecision } from './recent-events.js';

export const DEFAULT_FIRSTTURN_MODE = 'shadow';
export const FIRESH_MS = 30 * 60e3;
export const FIRSTTURN_MAX_CHARS = 120;
export const FIRSTTURN_MODES = ['off', 'shadow', 'inject'];

export function resolveFirstTurnMode(cfg) {
  const m = String(cfg?.mode || cfg || DEFAULT_FIRSTTURN_MODE);
  return FIRSTTURN_MODES.includes(m) ? m : DEFAULT_FIRSTTURN_MODE;
}

export function firstTurnMaxChars(cfg) {
  const n = Number(cfg?.maxChars);
  return Number.isFinite(n) && n > 0 ? Math.min(240, Math.max(40, Math.round(n))) : FIRSTTURN_MAX_CHARS;
}

export function firstTurnDay(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 首轮桥接状态：{days:{key:day}, tokens:{key:[{day,token}]}}，跨天自然重置。 */
export function normalizeBridgeState(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const days = d.days && typeof d.days === 'object' ? d.days : {};
  const tokens = d.tokens && typeof d.tokens === 'object' ? d.tokens : {};
  return { version: 1, days: { ...days }, tokens: Object.fromEntries(Object.entries(tokens).map(([k, v]) => [k, Array.isArray(v) ? v.filter((x) => x && x.token).slice(-8) : []])) };
}
export function markFirstTurnDay(state, convKey, day) {
  const s = normalizeBridgeState(state);
  s.days[String(convKey)] = String(day);
  return s;
}
export function rememberFirstTurnToken(state, convKey, day, token) {
  const s = normalizeBridgeState(state);
  if (!token) return s;
  const list = Array.isArray(s.tokens[convKey]) ? s.tokens[convKey] : [];
  s.tokens[convKey] = [...list.filter((x) => x.day !== day), { day: String(day), token: String(token) }].slice(-8);
  return s;
}
export function recentInjectedTokensFor(state, convKey, { now = Date.now(), days = 2 } = {}) {
  const s = normalizeBridgeState(state);
  const list = Array.isArray(s.tokens[convKey]) ? s.tokens[convKey] : [];
  const wanted = new Set();
  for (let i = 1; i <= days; i += 1) {
    const d = new Date(now - i * 86400e3);
    wanted.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return list.filter((x) => wanted.has(String(x.day))).map((x) => String(x.token)).filter(Boolean);
}

/**
 * 首轮兜底决策（纯函数）：不写盘、不改 state。
 * @returns {{mode,wouldLine,line,event,reason,day,stale,alreadyMarked}}
 */
export function decideFirstTurnFallback({
  data = null,
  convKey = '',
  now = Date.now(),
  cfg = null,
  recentMessages = [],
  memoryTexts = [],
  recentInjectedTokens = [],
  alreadyMarked = false,
  freshMs = FIRESH_MS,
} = {}) {
  const mode = resolveFirstTurnMode(cfg);
  const maxChars = firstTurnMaxChars(cfg);
  const day = firstTurnDay(now);
  const base = { mode, day, wouldLine: '', line: '', event: null, reason: '', stale: false, alreadyMarked };
  if (mode === 'off') return { ...base, reason: 'off' };
  if (alreadyMarked) return { ...base, reason: 'already-marked-today' };
  const generatedAt = Number(data?.generatedAt || 0);
  if (!data || !generatedAt || now - generatedAt > Math.max(60e3, Number(freshMs) || FIRESH_MS)) {
    return { ...base, stale: true, reason: 'stale-or-missing' };
  }
  // 私聊可取共享事件（renderer 视图约定）；firstTurnFallbackDecision 只读 own，这里按视图合并。
  const viewData = (() => {
    if (String(convKey).startsWith('group:')) return data;
    const shared = Array.isArray(data?.sharedEvents) ? data.sharedEvents.filter((e) => e && e.active !== false) : [];
    if (!shared.length) return data;
    const own = data?.conversations?.[convKey]?.events || [];
    return {
      ...data,
      conversations: {
        ...(data.conversations || {}),
        [convKey]: { ...(data.conversations?.[convKey] || {}), events: [...own, ...shared.filter((e) => !own.some((x) => x.text === e.text))] },
      },
    };
  })();
  let decision;
  try {
    decision = firstTurnFallbackDecision({
      data: viewData,
      convKey,
      now,
      recentMessages,
      memoryTexts,
      recentInjectedTokens,
    });
  } catch {
    return { ...base, reason: 'decision-error' };
  }
  const wouldLine = String(decision?.line || '').slice(0, maxChars);
  const line = mode === 'inject' ? wouldLine : '';
  return { ...base, line, wouldLine, event: decision?.event || null, reason: decision?.reason || (wouldLine ? 'inject' : 'no-line') };
}

/** 文案/视图安全检查：群行不得出现私聊标记；行长 ≤ maxChars。 */
export function firstTurnLineSafe(line, convKey, maxChars = FIRSTTURN_MAX_CHARS) {
  const s = String(line || '');
  if (!s) return true;
  if (s.length > maxChars + 1) return false;
  if (String(convKey).startsWith('group:') && /私聊|private:/.test(s)) return false;
  return true;
}

/**
 * 解析 bridge 首轮状态文本（2026-11-10 Lead 口径）：
 *   · 文件不存在（text=null）→ ok，视作今日未注入（正常首次运行）；
 *   · JSON 解析失败/损坏 → corrupt=true，调用方应**跳过本轮注入**（宁可少注入一次，避免重复）。
 */
export function parseBridgeStateText(text) {
  const raw = text == null ? null : String(text);
  if (raw === null || !raw.trim()) return { ok: true, missing: true, corrupt: false, state: normalizeBridgeState(null) };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ok: false, missing: false, corrupt: true, state: normalizeBridgeState(null) };
    return { ok: true, missing: false, corrupt: false, state: normalizeBridgeState(parsed) };
  } catch {
    return { ok: false, missing: false, corrupt: true, state: normalizeBridgeState(null) };
  }
}

/**
 * 2026-11-10 P2 修复（首轮状态预标）：
 * pending 只在「真实投递构建」（delivery=true）时生成；dry/预览永不生成。
 * return null 表示无需落盘（无 wouldLine / 非法 mode）。
 */
export function makePendingFirstTurn({ mode, day, line, event = null, builtAt = Date.now() } = {}) {
  const text = String(line || '');
  if (!text || !['shadow', 'inject'].includes(String(mode))) return null;
  return { mode: String(mode), day: String(day), line: text, event: event || null, builtAt: Number(builtAt) || Date.now() };
}

/**
 * 投递成功后的消费判定（纯函数）：
 *   · shadow：不需要 prompt 包含（本来就不注入），但 pending 不能太旧（防串轮/预览残留）；
 *   · inject：必须 prompt 真的包含该行；
 *   · stale/不匹配 → consume=false（调用方可选清理）。
 */
export function consumePendingFirstTurn(pending, { now = Date.now(), promptText = '', maxAgeMs = 120000 } = {}) {
  if (!pending || typeof pending !== 'object') return { consume: false, reason: 'none' };
  const age = Number(now) - Number(pending.builtAt || 0);
  if (age > Math.max(1000, Number(maxAgeMs) || 120000)) return { consume: false, reason: 'stale-pending' };
  if (pending.mode === 'shadow') return { consume: true, write: 'shadow' };
  if (pending.mode === 'inject') {
    return String(promptText || '').includes(String(pending.line || ''))
      ? { consume: true, write: 'inject' }
      : { consume: false, reason: 'not-in-prompt' };
  }
  return { consume: false, reason: 'unknown-mode' };
}
