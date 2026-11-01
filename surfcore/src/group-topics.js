/**
 * 群兴趣画像 + 热点追踪（2026-10-30）
 *
 * 两件事：
 *   1. 每个群有一份「长期兴趣」（手办模型 / PCR / 偶像大师 …），写在 config 里；
 *   2. 从最近聊天里数关键词，得到「这几天在聊什么」，带时间衰减。
 *
 * 输出一行注入：这个群最近在聊什么，优先级从高到低。
 */

const HOUR = 3600 * 1000;

// 通用兴趣词表：命中就算一次（可被 config 的 groupInterests 覆盖/补充）
const DEFAULT_TOPICS = {
  '手办/模型': ['手办', '景品', '高达', '拼装', '模型', '万代', '寿屋', 'MG', 'HG', 'RG', 'PG', 'GK', '雕像', '粘土人', 'figma', '手涂', '喷涂', '渗线', '水贴'],
  'PCR': ['PCR', '公主连结', '公主连接', '公会战', '抽卡', '井', '妈', '可可萝', '佩可', '凯露', '优衣'],
  '偶像大师': ['偶像大师', '学马', '学マス', '灰姑娘', '百万', '闪耀色彩', 'シャニ', 'imas', 'Pさん', '担当', 'live', '演唱会'],
  'AI/模型': ['token', '模型', 'AI', '提示词', '插件', 'agent', '招牌词', 'DSH'],
  '游戏': ['原神', '崩铁', '明日方舟', '碧蓝', '打游戏', 'steam'],
};

function normalizeTopicMap(cfg) {
  const map = {};
  for (const [k, v] of Object.entries(DEFAULT_TOPICS)) map[k] = [...v];
  // 群配置里可以写 topics: { "主题名": ["关键词", ...] }，只合并主题，不把群名当主题
  for (const g of Object.values(cfg || {})) {
    const topics = g?.topics;
    if (!topics || typeof topics !== 'object') continue;
    for (const [name, words] of Object.entries(topics)) {
      const key = String(name || '').trim();
      const add = Array.isArray(words) ? words.map(String).filter(Boolean) : [];
      if (!key || !add.length) continue;
      map[key] = [...new Set([...(map[key] || []), ...add])];
    }
  }
  return map;
}

/** 数一条消息命中了哪些主题。 */
function topicsOf(text, topicMap) {
  const s = String(text || '');
  if (s.length < 2) return [];
  const hit = [];
  for (const [name, words] of Object.entries(topicMap)) {
    for (const w of words) {
      if (!w) continue;
      if (s.toLowerCase().includes(String(w).toLowerCase())) { hit.push(name); break; }
    }
  }
  return hit;
}

/** store: { groups: { [groupId]: { topic: [{n, lastAt}] } } } */
export function trackTopics(store, { groupId, text, now = Date.now(), topicMap }) {
  const st = store && typeof store === 'object' ? store : { groups: {} };
  st.groups = st.groups || {};
  const g = (st.groups[groupId] = st.groups[groupId] || {});
  for (const name of topicsOf(text, topicMap || normalizeTopicMap())) {
    const arr = (g[name] = g[name] || []);
    arr.push({ n: 1, lastAt: now });
    if (arr.length > 200) arr.splice(0, arr.length - 200);
  }
  return st;
}

/** 带衰减的统计：越久远权重越低。 */
export function summarizeTopics(store, { groupId, hours = 12, now = Date.now(), limit = 5 }) {
  const g = store?.groups?.[groupId] || {};
  const rows = [];
  for (const [name, arr] of Object.entries(g)) {
    let score = 0, lastAt = 0;
    for (const it of arr || []) {
      const age = (now - Number(it.lastAt || 0)) / HOUR;
      if (!isFinite(age) || age > hours) continue;
      score += Math.exp(-age / (hours / 2));
      lastAt = Math.max(lastAt, Number(it.lastAt || 0));
    }
    if (score > 0.01) rows.push({ name, score: Math.round(score * 10) / 10, lastAt });
  }
  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, limit);
}

/** 注入用的一行。 */
export function topicPromptLine(store, { groupId, interests = [], hours = 12, now = Date.now() }) {
  const hot = summarizeTopics(store, { groupId, hours, now, limit: 4 });
  if (!hot.length && !interests.length) return '';
  const bits = [];
  if (interests.length) bits.push(`这个群平时主要聊：${interests.join('、')}`);
  if (hot.length) bits.push(`最近半天在聊：${hot.map((h) => `${h.name}（${h.score}）`).join('、')}`);
  if (!bits.length) return '';
  return (
    `\n【这个群】${bits.join('；')}。\n` +
    `- 别人聊你懂的就自然接一句；不懂的就听着，偶尔问一句「这是啥」也行，别硬装懂\n` +
    `- 聊到你熟的（手办/角色/游戏），可以接，但别科普、别当解说\n`
  );
}

export { normalizeTopicMap };
export const __test = { topicsOf, DEFAULT_TOPICS };
