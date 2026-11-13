// review-gap 单测（task-17，2026-11-08）
//
// 覆盖 PM 要求：复习句命中、普通闲聊不命中、规则已存在时不重复；
// 外加：7 天去重、每天上限、群聊/非 owner 由 bridge 侧限制（本模块只看纯判断）、开关。
import {
  REVIEW_GAP_DEFAULTS,
  extractReviewTarget,
  targetKnown,
  shouldRecordReview,
} from '../src/review-gap.js';

let pass = 0;
const ok = (name, fn) => {
  try { fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}\n     ${String(error?.message ?? error)}`); process.exitCode = 1; }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assert failed'); };
const eq = (a, b, msg) => assert(a === b, `${msg || 'eq'}：${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

const NOW = new Date('2026-11-08T21:40:00+08:00').getTime();
const DAY = 24 * 3600e3;

console.log('—— extractReviewTarget ——');
ok('11/6 原句「棉宝我教过你的复读文化你还记得不」→ 复读文化', () => {
  const hit = extractReviewTarget('棉宝我教过你的复读文化你还记得不');
  assert(hit, '应命中'); eq(hit.target, '复读文化');
});
ok('「你还记得我教过你的复读文化吗」→ 复读文化', () => {
  eq(extractReviewTarget('你还记得我教过你的复读文化吗').target, '复读文化');
});
ok('「复读文化你还记得不」→ 复读文化', () => {
  eq(extractReviewTarget('复读文化你还记得不').target, '复读文化');
});
ok('「上次说的踢皮球还记得吗」→ 踢皮球', () => {
  eq(extractReviewTarget('上次说的踢皮球还记得吗').target, '踢皮球');
});
ok('「我跟你说过的别应太直接了还记得吗」→ 别应太直接', () => {
  eq(extractReviewTarget('我跟你说过的别应太直接了还记得吗').target, '别应太直接');
});
ok('普通闲聊不命中：今天天气不错 / 我记得吃饭了 / 我不记得了', () => {
  eq(extractReviewTarget('今天天气不错'), null);
  eq(extractReviewTarget('我记得吃饭了'), null);
  eq(extractReviewTarget('我不记得了'), null);
});

console.log('—— targetKnown ——');
ok('对象在规则里 → known', () => {
  assert(targetKnown('复读文化', { rulesText: '群里有人刷同一句时，跟着复读一句…复读文化' }));
});
ok('对象在 teachings/ledger/topics 里 → known', () => {
  assert(targetKnown('踢皮球', { teachingsText: '以前教过踢皮球' }));
  assert(targetKnown('踢皮球', { ledgerText: '踢皮球' }));
  assert(targetKnown('踢皮球', { topicsText: '踢皮球的事' }));
});
ok('哪里都没有 → known=false', () => {
  eq(targetKnown('复读文化', { rulesText: '完全不相关的内容' }), false);
});

console.log('—— shouldRecordReview ——');
const sourcesNone = {};
const base = { target: '复读文化', phrase: '棉宝我教过你的复读文化你还记得不', sources: sourcesNone, items: [], now: NOW };
ok('基础：复习对象不存在、无历史 → ok，条目 kind=review', () => {
  const d = shouldRecordReview(base);
  eq(d.ok, true); eq(d.reason, 'ok');
  eq(d.item.kind, 'review'); eq(d.item.text, '复读文化');
});
ok('对象已存在（规则/记忆里有）→ known 不记', () => {
  const d = shouldRecordReview({ ...base, sources: { rulesText: '…复读文化…' } });
  eq(d.ok, false); eq(d.reason, 'known');
});
ok('同一对象 3 天前提醒过 → duplicate 不重复', () => {
  const items = [{ text: '复读文化', kind: 'review', at: NOW - 3 * DAY }];
  const d = shouldRecordReview({ ...base, items });
  eq(d.ok, false); eq(d.reason, 'duplicate');
});
ok('同一对象 8 天前提醒过 → 去重已过期，可再记', () => {
  const items = [{ text: '复读文化', kind: 'review', at: NOW - 8 * DAY }];
  const d = shouldRecordReview({ ...base, items });
  eq(d.ok, true);
});
ok('当天已提醒过 1 条 → daily-cap', () => {
  const items = [{ text: '别的对象', kind: 'review', at: NOW - 2 * 3600e3 }];
  const d = shouldRecordReview({ ...base, items });
  eq(d.ok, false); eq(d.reason, 'daily-cap');
});
ok('跨天：昨天的 review 不算今天的上限', () => {
  const items = [{ text: '别的对象', kind: 'review', at: NOW - 1 * DAY }];
  const d = shouldRecordReview({ ...base, items });
  eq(d.ok, true);
});
ok('非 review 类条目不影响去重/上限', () => {
  const items = [{ text: '复读文化', kind: undefined, at: NOW - 2 * DAY }];
  const d = shouldRecordReview({ ...base, items });
  eq(d.ok, true);
});
ok('enabled=false 全关', () => {
  const d = shouldRecordReview({ ...base, opts: { enabled: false } });
  eq(d.ok, false); eq(d.reason, 'disabled');
});
ok('默认参数：7 天去重 / 每天 1 条', () => {
  eq(REVIEW_GAP_DEFAULTS.dedupeMs, 7 * 24 * 3600e3);
  eq(REVIEW_GAP_DEFAULTS.dailyMax, 1);
});

console.log(`\n${pass} 项通过${process.exitCode ? '，有失败' : '，全部通过 ✅'}`);
