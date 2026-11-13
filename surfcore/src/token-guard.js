/**
 * Token 防爆破的纯逻辑（2026-10-23 用户定）。
 *
 * 和鱼群守则的关系：
 *   · 鱼群守则先判断“群里是不是鱼太多”，决定要不要发；
 *   · 本模块只判断“这一轮值不值得再花一次模型调用/再发一条”，
 *     不绕过鱼群守则；任何一边拒绝都不发。
 */
export const DEFAULT_TOKEN_GUARD = Object.freeze({
  enabled: true,
  maxWakesPerDay: 20,
  privateMaxWakesPerDay: 10,
  minWakeGapMs: 120000,
  directBypassGap: true,
  maxOutboundPerTurn: 8,
  maxDailyCostCNY: 8,
});

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** 每天 0 点（本地时区）。 */
export function localDayStart(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 醒前预算检查。
 * @param {{key?:string, wakeTimes?:number[], now?:number, guard?:object, cost?:number, direct?:boolean}} opts
 * @returns {{blocked:boolean, error?:string, retryAfterMs?:number, reason?:string, dayCount?:number, maxDay?:number}}
 */
export function evaluateWakeBudget({ key = '', wakeTimes = [], now = Date.now(), guard = DEFAULT_TOKEN_GUARD, cost = null, direct = false } = {}) {
  const g = { ...DEFAULT_TOKEN_GUARD, ...(guard && typeof guard === 'object' ? guard : {}) };
  if (g.enabled === false) return { blocked: false };
  const times = (Array.isArray(wakeTimes) ? wakeTimes : []).map(Number).filter((t) => Number.isFinite(t) && t > 0);
  const isPrivate = String(key ?? '').startsWith('private:');
  // 单群额度覆盖（2026-10-29 老大定）：groupWakesPerDay: {"1000000003": 25}
  // 群总池 100 = 我的群 75 + kuri 的群 25；私聊单独 100。
  const groupOverrides = g.groupWakesPerDay && typeof g.groupWakesPerDay === 'object' ? g.groupWakesPerDay : {};
  const groupId = String(key ?? '').startsWith('group:') ? String(key).slice('group:'.length) : '';
  const override = groupId && Object.prototype.hasOwnProperty.call(groupOverrides, groupId)
    ? num(groupOverrides[groupId], NaN)
    : NaN;
  const maxDay = Math.max(0, Math.round(
    isPrivate
      ? num(g.privateMaxWakesPerDay, 0)
      : (Number.isFinite(override) ? override : num(g.maxWakesPerDay, 0))
  ));
  const dayCount = times.filter((t) => t >= localDayStart(now)).length;
  if (maxDay > 0 && dayCount >= maxDay) {
    return {
      blocked: true,
      reason: 'day',
      dayCount,
      maxDay,
      error: `Token 防爆破：这个会话今天已经醒了 ${dayCount}/${maxDay} 次，今天不再唤醒`,
    };
  }
  // 每小时上限（单群覆盖）：groupHourlyWakes: {"1000000003": 8}
  // 日额度是硬刹车，但热闹的群会在一小时内打满；这个把节奏摊平。
  const hourlyOverrides = g.groupHourlyWakes && typeof g.groupHourlyWakes === 'object' ? g.groupHourlyWakes : {};
  const hourlyCapRaw = groupId && Object.prototype.hasOwnProperty.call(hourlyOverrides, groupId)
    ? num(hourlyOverrides[groupId], NaN)
    : NaN;
  if (Number.isFinite(hourlyCapRaw) && hourlyCapRaw > 0) {
    const lastHour = times.filter((t) => t > now - 3600 * 1000).length;
    if (lastHour >= hourlyCapRaw) {
      return {
        blocked: true,
        reason: 'hour',
        dayCount,
        maxDay,
        hourlyCount: lastHour,
        hourlyMax: hourlyCapRaw,
        error: `Token 防爆破：这个群最近一小时已经醒了 ${lastHour}/${hourlyCapRaw} 次，先歇一会儿`,
      };
    }
  }
  const gap = Math.max(0, Math.round(num(g.minWakeGapMs, 0)));
  const last = times.length ? Math.max(...times) : 0;
  const bypassGap = direct === true && g.directBypassGap !== false;
  if (!bypassGap && gap > 0 && last && now - last < gap) {
    return {
      blocked: true,
      reason: 'gap',
      retryAfterMs: gap - (now - last),
      error: `Token 防爆破：同一会话两次苏醒至少隔 ${Math.round(gap / 1000)} 秒`,
    };
  }
  const maxCost = Math.max(0, num(g.maxDailyCostCNY, 0));
  if (maxCost > 0 && Number.isFinite(Number(cost)) && Number(cost) >= maxCost) {
    return {
      blocked: true,
      reason: 'cost',
      cost: Number(cost),
      maxCost,
      error: `Token 防爆破：近 24 小时花费 ¥${Number(cost).toFixed(2)} ≥ ¥${maxCost.toFixed(2)}，暂停唤醒`,
    };
  }
  return { blocked: false, dayCount, maxDay };
}

/**
 * 发送前条数检查（一次醒来内累计）。
 * @returns {{blocked:boolean, next:number, max:number, error?:string}}
 */
export function evaluateOutbound({ used = 0, count = 1, guard = DEFAULT_TOKEN_GUARD } = {}) {
  const g = { ...DEFAULT_TOKEN_GUARD, ...(guard && typeof guard === 'object' ? guard : {}) };
  const max = Math.max(1, Math.round(num(g.maxOutboundPerTurn, 8)));
  const n = Math.max(1, Math.round(num(count, 1)));
  const before = Math.max(0, Math.round(num(used, 0)));
  const next = before + n;
  if (g.enabled === false) return { blocked: false, next, max };
  if (next > max) {
    return {
      blocked: true,
      next,
      max,
      error: `Token 防爆破：本次醒来最多发 ${max} 条（已发 ${before} 条）。内容太长请先总结/挑重点，不要拆成 10 条刷屏；超过 ${max} 条会被硬拦，合并成几句或下次再说。`,
    };
  }
  return { blocked: false, next, max };
}

/**
 * 每小时把群的剩余额度拉平（2026-10-29 定的机制）。
 *
 * 2026-11-03 修了一个会「额度跟着用量涨」的漏洞：原实现是
 *   caps[g] = Math.max(used[g], used[g] + each)
 * 池子用完（each=0）时它就等于 used[g]——用掉多少次，上限就变成多少，
 * 于是越用越能醒（今天 1000000002 从 92 涨到 200）。现在的规则是：
 *   · 还有剩余额度 → 上限 = max(基准, 已用 + 平均分到的)，保证能继续说话；
 *   · 池子已经用完 → 上限钉在基准，**不**随已用量膨胀。
 * 单群上限不超过池子总量（一个群不可能比池子还能用）。
 *
 * @param {{groups?:string[], used?:Record<string,number>, baseCaps?:Record<string,number>, pool?:number}} opts
 * @returns {{caps:Record<string,number>, totalUsed:number, each:number, pool:number}}
 */
export function computeQuotaCaps({ groups = [], used = {}, baseCaps = {}, pool = 0 } = {}) {
  const list = (Array.isArray(groups) ? groups : []).map(String);
  const totalUsed = list.reduce((s, g) => s + (Number(used[g]) || 0), 0);
  // 关键：cap 从**基准**算，不从 used 算。
  // 以前是 used + each，池子用完时 each=0 就退化成 used——这就是「越醒越能醒」的根。
  // 现在 cap 永远是基准（跨天缩放后的值）；池子还有富余（基准之和 < 池子）才平均加一点。
  // 已经用超的群，cap 低于 used 是正常的：检查是 dayCount >= cap 就拦，日志会显示 200/92。
  const sumBase = list.reduce((s, g) => s + (Number(baseCaps[g]) || 0), 0);
  const left = Math.max(0, Number(pool) - sumBase);
  const each = Math.floor(left / Math.max(1, list.length));
  const caps = {};
  for (const g of list) {
    const cap = (Number(baseCaps[g]) || 0) + each;
    caps[g] = pool > 0 ? Math.min(Number(pool), cap) : cap;
  }
  return { caps, totalUsed, each, pool: Number(pool) || 0 };
}

/**
 * 跨天沿用昨天上限时的收敛：总和超过池子就按比例缩回去。
 * 不缩的话，一次被抬坏的上限会永久延续（2026-11-03 实际发生过：92→200 之后一天都按 200 算）。
 * @param {{groups?:string[], prevCaps?:Record<string,number>, defaultCaps?:Record<string,number>, pool?:number}} opts
 * @returns {Record<string,number>}
 */
export function carryQuotaCaps({ groups = [], prevCaps = {}, defaultCaps = {}, pool = 0 } = {}) {
  const list = (Array.isArray(groups) ? groups : []).map(String);
  const prevSum = list.reduce((s, g) => s + (Number(prevCaps[g]) || 0), 0);
  const p = Number(pool) || 0;
  // 昨天分配合计超过池子，说明那不是「借用」，是异常（比如老的 used 膨胀 bug）。
  // 这种情况直接回到配置默认值，别把坏数据按比例带进今天。
  // 2026-11-03 实测：1000000002 被抬到 200 后，按比例缩放会变成 134，仍然偏高。
  if (p > 0 && prevSum > p) {
    const reset = {};
    for (const g of list) reset[g] = Number(defaultCaps[g]) || 0;
    return reset;
  }
  const caps = {};
  for (const g of list) {
    const y = Number(prevCaps[g]);
    caps[g] = Number.isFinite(y) && y > 0 ? Math.round(y) : Number(defaultCaps[g]) || 0;
  }
  return caps;
}

/** 某一刻是否落在「夜间静默」窗口里（支持跨午夜，比如 23→7）。 */
export function inQuietWindow(now = Date.now(), { start = 1, end = 7 } = {}) {
  const h = new Date(Number(now)).getHours();
  const s = Number(start);
  const e = Number(end);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return false;
  return s <= e ? (h >= s && h < e) : (h >= s || h < e);
}

/**
 * 夜间静默要不要拦掉这次唤醒（2026-11-03）。
 *
 * 只拦「群里非直接叫她」的情况：概率接话、关键词、图片、补唤醒、定时检查……
 * 这些在深夜醒来基本只有一句「没事，收尾」，但每次都要重读整段会话。
 * 私聊、日记/叙事、被 @ —— 都放行。
 *
 * 注意这不是「禁止她夜里说话」：白天她照样能主动；夜里有人直接叫她，她也照样醒。
 */
export function quietHoursBlocks({
  key = '',
  reason = '',
  allow = ['atMention'],
  now = Date.now(),
  enabled = true,
  start = 1,
  end = 7,
} = {}) {
  if (!enabled) return false;
  if (!String(key).startsWith('group:')) return false;
  const base = String(reason || '').split(':')[0];
  // sticker-review 和日记同属「她自己的事」，夜里也该能跑
  if (base === 'diary' || base === 'narrative' || base === 'sticker-review') return false;
  if (!inQuietWindow(now, { start, end })) return false;
  return !allow.includes(base);
}
