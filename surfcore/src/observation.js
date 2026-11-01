/**
 * 观察层（2026-11-01）—— 纯逻辑，零 I/O。
 *
 * 要解决的问题：
 *   她每轮只看到最近几分钟的消息，看不到「模式」——
 *   群里最近在聊什么、他们说话什么节奏、她翻过什么。
 *   没有模式，就不会有「这个群是这样」的判断，也就不会自己想去搜、去问。
 *
 * 这个模块只把已有的统计压成几行事实。不评价、不给建议、不催她做事。
 * 开关：config.observation.enabled（false 时整条路径跳过，state 不动）。
 */

const DAY = 86400 * 1000;

function avg(arr) {
  const list = Array.isArray(arr) ? arr : [];
  if (!list.length) return 0;
  return Math.round(list.reduce((a, b) => a + Number(b || 0), 0) / list.length);
}

/** 这个群最近在聊什么（按最近 N 天出现次数排）。 */
export function topicDigest(topicState, groupId, { days = 3, limit = 4, at = Date.now() } = {}) {
  const group = topicState?.groups?.[String(groupId)];
  if (!group) return [];
  const cutoff = at - Number(days) * DAY;
  return Object.entries(group)
    .map(([name, rows]) => ({
      name,
      n: (Array.isArray(rows) ? rows : []).filter((r) => Number(r?.lastAt) >= cutoff).length,
    }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, limit);
}

/** 群里说话什么节奏，她自己又是什么节奏。 */
export function styleDigest(styleState, key) {
  const s = styleState?.byKey?.[String(key)];
  if (!s) return null;
  return {
    groupAvgLen: avg(s.otherLens),
    selfAvgLen: avg(s.selfLens),
    selfN: Number(s.selfN || 0),
  };
}

/**
 * 拼成给她看的几行。只放有内容的部分；全空就返回 ''。
 * 语气：像在跟她说话，不是报表。
 */
export function observationBlock({ topics = [], style = null, seen = [] } = {}) {
  const lines = [];
  if (topics.length) {
    const top = topics.map((t) => `${t.name}（${t.n} 次）`).join('、');
    lines.push(`- 这个群最近在聊：${top}`);
  }
  if (style && style.groupAvgLen > 0) {
    const diff = style.selfAvgLen - style.groupAvgLen;
    const feel = Math.abs(diff) <= 4 ? '差不多' : diff > 0 ? '你说得比他们长一点' : '你说得比他们短';
    lines.push(`- 他们一句大概 ${style.groupAvgLen} 个字，你 ${style.selfAvgLen} 个字（${feel}）`);
  }
  if (seen.length) {
    lines.push(`- 你最近看过的：${seen.slice(0, 3).join('、')}`);
  }
  if (!lines.length) return '';
  return `\n【这个群最近】\n${lines.join('\n')}\n（这些只是你看到的，不用回应，也不用拿来开话题。看多了自然会有判断。）\n`;
}

/**
 * 复盘用：今天看过什么。
 * 和上面不同——这里只给「线索」，问题留给她自己。
 */
export function seenPromptBlock({ topics = [], seen = [] } = {}) {
  const bits = [];
  if (topics.length) bits.push(`群里这两天聊得最多的是${topics.slice(0, 2).map((t) => t.name).join('、')}`);
  if (seen.length) bits.push(`你翻了${seen.slice(0, 2).join('、')}`);
  if (!bits.length) return '';
  return `\n【今天你看到的东西】\n${bits.join('；')}。\n有没有哪条、哪张图让你多看了一眼？想过什么就写一句，没想就过。\n`;
}

export const OBSERVATION_DEFAULTS = Object.freeze({
  enabled: true,
  topicDays: 3,
  topicLimit: 4,
  /** 同一会话两次观察摘要至少隔这么久，避免每轮都塞 */
  cooldownMs: 6 * 3600 * 1000,
  maxTopics: 4,
});

export const __test = { topicDigest, styleDigest, observationBlock, seenPromptBlock };
