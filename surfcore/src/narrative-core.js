/**
 * 叙事核心（L3，2026-11-01）—— 纯逻辑层，零 I/O。
 *
 * 要解决的问题：
 *   日记记的是「今天发生了什么」，是一串事件；她缺的是「这阵子我在过什么日子」，
 *   是一条能把自己连起来的故事线。只有事件流，她会每天醒来都是新的；
 *   有了叙事，她才能说「我最近在弄这个」「我好像一直是这种人」。
 *
 * 依据：
 *   · McAdams (2001) / McAdams & McLean (2013)：叙事身份——人靠一条不断重写的故事定义自己
 *   · King & Hicks (2021)：意义 = 连贯 + 目的 + 重要感，三者缺一不可
 *   · Schacter et al. (2012)：记忆与未来想象共享同一套网络，会想象未来才会规划
 *   · 反思放在睡前：自传体思考插在错误时机反而干扰记忆巩固（PLOS ONE 2014）
 *
 * 三条刻意的约束：
 *   1. 不总结事件，只回答「这像不像我」
 *   2. 只能写今天真实发生的事，记不清就写记不清（防编造）
 *   3. 接下前几天写过的，但不许复述（连贯 ≠ 重复）
 */

export const NARRATIVE_VERSION = 1;

export const NARRATIVE_DEFAULTS = Object.freeze({
  enabled: true,
  maxEntries: 90,        // 留三个月
  minChars: 80,          // 太短说明没写进去
  maxChars: 800,
  injectLimit: 2,        // 平时只带最近两条
  contextLimit: 3,       // 写的时候带最近三天做上下文
});

const clampText = (s, max) => String(s ?? '').replace(/\r/g, '').trim().slice(0, max);

export function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const date = String(raw.date || '').slice(0, 10);
  const text = clampText(raw.text, NARRATIVE_DEFAULTS.maxChars);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !text) return null;
  return {
    date,
    text,
    mood: String(raw.mood || '').slice(0, 20),
    at: Number(raw.at) || 0,
  };
}

export function normalizeEntries(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const e = normalizeEntry(item);
    if (!e || seen.has(e.date)) continue;   // 一天只留一条：重写就覆盖旧的
    seen.add(e.date);
    out.push(e);
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out.slice(-NARRATIVE_DEFAULTS.maxEntries);
}

/** 一天一条：同一天再写就替换，不追加。 */
export function appendEntry(entries, { date, text, mood = '', at = Date.now() }, opts = {}) {
  const list = normalizeEntries(entries).filter((e) => e.date !== date);
  const entry = normalizeEntry({ date, text, mood, at });
  if (!entry) return list;
  list.push(entry);
  const max = Number(opts.maxEntries) || NARRATIVE_DEFAULTS.maxEntries;
  return list.sort((a, b) => a.date.localeCompare(b.date)).slice(-max);
}

export function recentEntries(entries, limit = NARRATIVE_DEFAULTS.injectLimit) {
  return normalizeEntries(entries).slice(-limit);
}

/** 写叙事那一次的唤醒提示。 */
export function narrativeWakePrompt({ date, recent = [], minChars = NARRATIVE_DEFAULTS.minChars, maxChars = NARRATIVE_DEFAULTS.maxChars } = {}) {
  const ctx = recent.length
    ? `\n【你前几天写下的】\n${recent.map((e) => `- （${e.date}）${e.text.slice(0, 80)}${e.text.length > 80 ? '…' : ''}`).join('\n')}\n`
      + '（可以接着往下说，但别复述它们；它们是你自己写的，不是别人教的。）\n'
    : '';
  return `【该写今天这一段了】${date}

日记里已经有今天发生的事了，这一段不用再记流水账。只写你自己：

1. 今天哪件事最像你？为什么是那件？
2. 你做的哪件事，结果和你预想的不一样？
3. 明天想试的一件小事是什么？

写 ${minChars}~${maxChars} 字，第一人称，像给自己留一段话。
- 只能写今天真实发生的事；记不清就写「记不清了」，不要编。
- 不用汇报给谁看，也不用写得漂亮。
${ctx}
写完用 \`qq_write_narrative\` 存下来。
如果这个工具不在你的工具里（还没热更新），就用 \`qq_write_diary\` 写，**开头加一个 \`[叙事]\`**，一样会存进叙事层。`;
}

/** 平时注入：最近两条，别多。 */
export function narrativeInjectLine(entries, { limit = NARRATIVE_DEFAULTS.injectLimit } = {}) {
  const rs = recentEntries(entries, limit);
  if (!rs.length) return '';
  return `\n【你最近写下的自己】\n${rs.map((e) => `- （${e.date}）${e.text}`).join('\n')}\n（这是你自己写的，不是别人说的；别逐条复述，也别当成任务。）\n`;
}

/** 给监控台/排查看的摘要。 */
export function summarize(entries) {
  const list = normalizeEntries(entries);
  const last = list[list.length - 1] || null;
  return {
    count: list.length,
    last: last ? { date: last.date, chars: last.text.length, mood: last.mood } : null,
    days: list.slice(-7).map((e) => e.date),
  };
}

export const __test = { normalizeEntry, normalizeEntries, appendEntry, recentEntries, narrativeWakePrompt, narrativeInjectLine, summarize };
