/**
 * 「群里在复读」唤醒判定（2026-11-08，task-15 C）。
 *
 * 背景：echoLine 只在**唤醒 prompt** 里才算「最近 6 条有人复读」，
 * 她睡着时没有人叫醒她 —— 18:39-18:43 群 860 四个人刷「下头」，她整段睡眠错过。
 *
 * 这里把判定抽成纯函数（不依赖 bridge 闭包），便于单测：
 *   · detectEchoBurst：最近窗口内同一短句被多人刷 → 返回 {text,count,senders}
 *   · isEchoQuietHour：22:30–08:00 不叫醒（老大定的，夜里被刷梗叫醒不值）
 *   · shouldEchoWake：综合「睡着 / 夜间 / 概率 / 节流 / 日上限」给一次性决定
 *
 * 设计边界（PM 2026-11-08 批准）：
 *   · 只在群聊、且她睡着时考虑（醒着走原来的 probability 路径）；
 *   · 3 分钟内同一短句（2~40 字）≥3 次、且 ≥2 个不同发送者；
 *   · 概率 0.35；同会话 30 分钟最多 1 次、每天 ≤3 次；
 *   · 最近 5 分钟她在这个群说过话就不叫（人已经在场）；
 *   · 只做「要不要叫醒」的判断，不决定说什么；prompt 仍由 echoLine 给【群里在复读】。
 */

export const ECHO_WAKE_DEFAULTS = Object.freeze({
  enabled: true,
  windowMs: 3 * 60 * 1000,       // 3 分钟内
  minRepeats: 3,                  // 同一短句 ≥3 次
  minSenders: 2,                  // ≥2 个不同发送者
  minChars: 2,                    // 短句长度下限（去空白后）
  maxChars: 40,
  probability: 0.35,              // PM 定的 0.35
  cooldownMs: 30 * 60 * 1000,     // 同会话 30 分钟最多 1 次
  dailyMax: 3,                    // 每天 ≤3 次
  recentSelfQuietMs: 5 * 60 * 1000, // 最近 5 分钟她在群里说过话 → 不叫
  nightStart: 22 * 60 + 30,       // 22:30
  nightEnd: 8 * 60,               // 08:00
  timeZone: 'Asia/Shanghai',
});

const DEFAULT_OPTS = ECHO_WAKE_DEFAULTS;

function optsWith(opts) {
  return { ...DEFAULT_OPTS, ...(opts && typeof opts === 'object' ? opts : {}) };
}

/** 短句归一化：去空白、去首尾标点，保留文字本体用于比对。 */
export function normalizeEchoText(text) {
  return String(text ?? '')
    .replace(/\s+/g, '')
    .replace(/^[，。！？!?、；;：:~～（）()【\[\]「」『』“”"']+/, '')
    .replace(/[，。！？!?、；;：:~～（）()【\[\]「」『』“”"']+$/, '')
    .trim();
}

/** 这条消息能不能参与复读计数（排除她自己的、媒体/引用占位、命令词）。 */
function isCountableEchoMessage(m, opts) {
  if (!m || m.isSelf) return false;
  const t = normalizeEchoText(m.text ?? m.plain ?? '');
  if (!t) return false;
  if (/^\[(图片|表情|表情包|语音|转发消息|拍一拍)/.test(t)) return false;
  if (t.startsWith('#')) return false;               // #sl 之类网关命令
  if (t.length < opts.minChars || t.length > opts.maxChars) return false;
  return true;
}

function senderOf(m) {
  return String(m?.userId ?? m?.senderId ?? m?.sender ?? m?.senderName ?? '');
}

/**
 * 在 recentMessages 里找「正在被复读」的那句。
 * @returns {null | {text:string, count:number, senders:string[], sendersCount:number, lastAt:number}}
 */
export function detectEchoBurst(recentMessages, now = Date.now(), opts = {}) {
  const o = optsWith(opts);
  if (o.enabled === false) return null;
  const list = Array.isArray(recentMessages) ? recentMessages : [];
  const since = Number(now) - Number(o.windowMs);
  const buckets = new Map();
  for (const m of list) {
    const at = Number(m?.time ?? m?.at ?? 0);
    if (!at || at < since || at > Number(now) + 60 * 1000) continue; // 允许 1 分钟时钟误差
    if (!isCountableEchoMessage(m, o)) continue;
    const text = normalizeEchoText(m.text ?? m.plain ?? '');
    let b = buckets.get(text);
    if (!b) { b = { text, count: 0, senders: new Set(), lastAt: 0 }; buckets.set(text, b); }
    b.count += 1;
    const s = senderOf(m);
    if (s) b.senders.add(s);
    b.lastAt = Math.max(b.lastAt, at);
  }
  let best = null;
  for (const b of buckets.values()) {
    if (b.count < o.minRepeats) continue;
    if (b.senders.size < o.minSenders) continue;
    if (!best || b.count > best.count || (b.count === best.count && b.lastAt > best.lastAt)) {
      best = { text: b.text, count: b.count, senders: [...b.senders], sendersCount: b.senders.size, lastAt: b.lastAt };
    }
  }
  return best;
}

/** 上海时区当前分钟数（0~1439）。 */
export function minuteOfDay(now = Date.now(), timeZone = DEFAULT_OPTS.timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(Number(now)));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return (get('hour') % 24) * 60 + get('minute');
}

/** 22:30–08:00 的夜间静默（与 bridge 的 quietHours 双保险；这条不豁免）。 */
export function isEchoQuietHour(now = Date.now(), opts = {}) {
  const o = optsWith(opts);
  const m = minuteOfDay(now, o.timeZone);
  const start = Number(o.nightStart);
  const end = Number(o.nightEnd);
  if (start === end) return false;
  if (start < end) return m >= start && m < end;
  return m >= start || m < end;   // 跨午夜
}

/** 上海时区的 day key（YYYY-MM-DD），和 bridge 的 localDayKey 同口径。 */
export function echoDayKey(now = Date.now(), timeZone = DEFAULT_OPTS.timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(Number(now)));
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** 她最近一次在这个会话说话的时间（没有则 0）。 */
export function lastSelfAt(recentMessages) {
  const list = Array.isArray(recentMessages) ? recentMessages : [];
  let last = 0;
  for (const m of list) {
    if (!m || !m.isSelf) continue;
    last = Math.max(last, Number(m.time ?? m.at ?? 0) || 0);
  }
  return last;
}

/**
 * 一次「要不要为复读叫醒她」的完整决定（纯函数，不改入参）。
 *
 * @param {object} args
 * @param {{day?:string,n?:number,lastAt?:number}|null} args.state 会话里的 echoWake 记账
 * @param {number} args.now
 * @param {boolean} args.isAsleep 她是否睡着
 * @param {number} args.lastSelfMessageAt 她最近一次在该会话说话的时间
 * @param {number} [args.random] 0~1 随机数（默认 Math.random，便于单测）
 * @param {object} [args.opts]
 * @returns {{ok:false, reason:'disabled'|'quiet-hours'|'awake'|'recent-self'|'cooldown'|'daily-cap'|'probability'}
 *          |{ok:true, reason:'ok', next:{day:string,n:number,lastAt:number}}}
 */
export function shouldEchoWake({
  state = null,
  now = Date.now(),
  isAsleep = false,
  lastSelfMessageAt = 0,
  random = Math.random,
  opts = {},
} = {}) {
  const o = optsWith(opts);
  if (o.enabled === false) return { ok: false, reason: 'disabled' };
  if (isEchoQuietHour(now, o)) return { ok: false, reason: 'quiet-hours' };
  if (!isAsleep) return { ok: false, reason: 'awake' };
  const lastSelf = Number(lastSelfMessageAt) || 0;
  if (lastSelf && Number(now) - lastSelf < Number(o.recentSelfQuietMs)) return { ok: false, reason: 'recent-self' };

  const day = echoDayKey(now, o.timeZone);
  const s = state && typeof state === 'object' ? state : {};
  const sameDay = String(s.day || '') === day;
  const usedToday = sameDay ? Math.max(0, Number(s.n) || 0) : 0;
  const lastAt = Number(s.lastAt) || 0;
  if (usedToday >= Number(o.dailyMax)) return { ok: false, reason: 'daily-cap' };
  if (lastAt && Number(now) - lastAt < Number(o.cooldownMs)) return { ok: false, reason: 'cooldown' };
  if (!(Number(random) < Number(o.probability))) return { ok: false, reason: 'probability' };
  return { ok: true, reason: 'ok', next: { day, n: usedToday + 1, lastAt: Number(now) } };
}
