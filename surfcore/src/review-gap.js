/**
 * 复习句补规则缺口（task-17，2026-11-08，PM 选 A 方案）。
 *
 * 背景：11-06 21:39 老大私聊「棉宝我教过你的复读文化你还记得不」+「必须」，
 * 她答「记得」——但那句话在 `extractTeaching()` 里是「复习/确认句」，不是教学句：
 * 「还记得不」后面没有 2~30 字内容，「必须」2 字 < 最短 4 字 → teachings/ledger 都没记。
 * 更严重的是：那条「复读」规则 11-04 已被 AUTO:owner 18 条上限挤掉；
 * 她用「还记得不」复习也没法把规则补回来 —— 口头记得、实际没有。
 *
 * 这个模块只做「识别 + 是否该记一条待复核」的纯判断，不写规则核心：
 *   · extractReviewTarget：从复习句里抽对象（如「复读文化」）
 *   · targetKnown：对象是否已存在于规则/teachings/ledger/topics（存在就不提醒）
 *   · shouldRecordReview：开关 / 7 天去重 / 每天上限
 * bridge 侧拿结果往 teachings.json 写 `kind:'review'`，由 teachReviewLine 递给她「要补吗」。
 * 她写「用法：…」或「不学：…」仍走原有 markTeachingUsage / markTeachingSkip 消费。
 *
 * 永不自动进规则核心：避免重走「每句复习都变规则」的老路（AUTO 段被塞爆的原因）。
 */
import { echoDayKey } from './echo-wake.js';

export const REVIEW_GAP_DEFAULTS = Object.freeze({
  enabled: true,
  dedupeMs: 7 * 24 * 3600e3,   // 同一对象 7 天最多提醒 1 次
  dailyMax: 1,                 // 每个会话每天最多 1 条
  minTargetChars: 2,
  maxTargetChars: 20,
  timeZone: 'Asia/Shanghai',
});

// 复习语气：只有「他明确在回忆/检查她记不记得」才算，普通聊天里的「我记得」不算。
const REVIEW_PATTERNS = [
  // 我教过你的复读文化你还记得不 / 我跟你说过的踢皮球还记得吗
  /我(?:教过|跟(?:你)?说过|和你说过|说过)(?:你)?的([\u4e00-\u9fa5A-Za-z0-9·]{2,20}?)(?:你)?(?:还)?记得/,
  // 你还记得我教过你的复读文化吗 / 还记得复读文化不
  /(?:还记得|记不记得|记得不)(?:我(?:教过|跟(?:你)?说过|和你说过|说过)(?:你)?的?)?([\u4e00-\u9fa5A-Za-z0-9·]{2,20}?)(?:吗|呢|吧|不|啊|呀|哈|[？?]|$)/,
  // 复读文化你还记得不 / 踢皮球记得吗
  /([\u4e00-\u9fa5A-Za-z0-9·]{2,20}?)(?:你)?(?:还)?记得(?:不|吗|吧|呢)?[？?]?$/,
  // 上次说的复读文化
  /上次(?:说的|教你的|教的)([\u4e00-\u9fa5A-Za-z0-9·]{2,20})/,
];

function normalizeTarget(raw, opts) {
  let t = String(raw || '').trim();
  t = t.replace(/^[，。！？!?、；;：:~\s]+|[，。！？!?、；;：:~\s]+$/g, '');
  t = t.replace(/^(的|是|那个|这个|一句|句话|个|条)+/, '');
  // 有些复习句会把称呼/教学引导语带进对象（「棉宝我教过你的复读文化」）——剥掉。
  for (const pre of ['棉宝', '我教过你的', '我教过的', '我跟你说过的', '我跟你说过', '我和你说过的', '我说过的', '上次说的', '上次教你的', '你的', '我的']) {
    if (t.startsWith(pre) && t.length > pre.length) t = t.slice(pre.length);
  }
  for (const suf of ['你还记得', '还记得', '记得不', '记得吗', '记得', '吗', '呢', '吧', '不', '啊', '呀', '哈', '了', '的']) {
    if (t.endsWith(suf) && t.length > suf.length) t = t.slice(0, -suf.length);
  }
  t = t.trim();
  if (t.length < Number(opts.minTargetChars) || t.length > Number(opts.maxTargetChars)) return '';
  return t;
}

/** 从一句复习话里抽「复习对象」。不是复习句 → null。 */
export function extractReviewTarget(text, opts = {}) {
  const o = { ...REVIEW_GAP_DEFAULTS, ...(opts || {}) };
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length < 4) return null;
  for (const re of REVIEW_PATTERNS) {
    const m = s.match(re);
    if (!m || !m[1]) continue;
    const target = normalizeTarget(m[1], o);
    if (target) return { target, phrase: m[0].slice(0, 60) };
  }
  return null;
}

function includesTarget(haystack, target) {
  const h = String(haystack || '');
  if (!h) return false;
  if (h.includes(target)) return true;
  // 保守匹配：对象 4+ 字时，前 3 字出现在正文里也算「已知」（避免误提醒）；
  // 2~3 字的短对象要求完整出现。
  if (target.length >= 4) return h.includes(target.slice(0, 3));
  return false;
}

/**
 * 对象是否已存在于某个已知来源（规则/teachings/ledger/topics 任一）。
 * @param {{rulesText?:string, teachingsText?:string, ledgerText?:string, topicsText?:string}} sources
 */
export function targetKnown(target, sources = {}) {
  const t = String(target || '').trim();
  if (!t) return false;
  return includesTarget(sources.rulesText, t)
    || includesTarget(sources.teachingsText, t)
    || includesTarget(sources.ledgerText, t)
    || includesTarget(sources.topicsText, t);
}

function isSameReviewTarget(item, target) {
  if (!item || item.kind !== 'review') return false;
  const t = String(item.text || '');
  if (!t) return false;
  return t.includes(target) || target.includes(t) || t.slice(0, 6) === target.slice(0, 6);
}

/**
 * 一次「要不要记这条待复核」的完整判断（纯函数）。
 * @returns {{ok:false, reason:'disabled'|'no-target'|'known'|'duplicate'|'daily-cap'}
 *          |{ok:true, reason:'ok', item:{text:string,kind:string,reviewFor:string}}}
 */
export function shouldRecordReview({ target, phrase = '', sources = {}, items = [], now = Date.now(), opts = {} } = {}) {
  const o = { ...REVIEW_GAP_DEFAULTS, ...(opts || {}) };
  if (o.enabled === false) return { ok: false, reason: 'disabled' };
  const t = String(target || '').trim();
  if (!t) return { ok: false, reason: 'no-target' };
  if (targetKnown(t, sources)) return { ok: false, reason: 'known' };
  const day = echoDayKey(now, o.timeZone);
  const reviews = (Array.isArray(items) ? items : []).filter((x) => x && x.kind === 'review');
  // 同一对象 7 天内已提醒过 → 不重复
  for (const it of reviews) {
    if (now - Number(it.at || 0) > Number(o.dedupeMs)) continue;
    if (isSameReviewTarget(it, t)) return { ok: false, reason: 'duplicate' };
  }
  // 当天（上海日界）已提醒过 → 每天上限
  const todayCount = reviews.filter((it) => echoDayKey(Number(it.at || 0), o.timeZone) === day).length;
  if (todayCount >= Number(o.dailyMax)) return { ok: false, reason: 'daily-cap' };
  return {
    ok: true,
    reason: 'ok',
    item: {
      text: t.slice(0, 40),
      kind: 'review',
      at: Number(now),
      reviewFor: String(phrase || '').slice(0, 80),
      usage: '',
      usageAt: 0,
      skipAt: 0,
    },
  };
}
