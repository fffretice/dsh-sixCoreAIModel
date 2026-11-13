// 静息重放纯函数单测（task-29）。不读生产。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  selectRestReplay, renderRestReplayClue, restReplayDecision, nextReplayState,
  recordVisibleIn, clueTokens, mentionedRecently, REST_REPLAY_RULES,
} from '../src/rest-replay.js';

const NOW = Date.parse('2026-11-09T20:00:00+08:00');
const D = 86400_000;
const rec = (id, daysAgo, text, extra = {}) => ({
  id, created_at: undefined, createdAt: new Date(NOW - daysAgo * D).toISOString(),
  text, importance: 70, originKind: 'private', speaker: '老大', conversationKey: 'private:1', ...extra,
});

test('视图安全：群只允许 group/public；私聊允许 private/public/unknown', () => {
  const g = { originKind: 'group' }, p = { originKind: 'private' }, pub = { originKind: 'public' }, unk = { originKind: 'unknown' };
  assert.equal(recordVisibleIn(g, 'group:860'), true);
  assert.equal(recordVisibleIn(p, 'group:860'), false);
  assert.equal(recordVisibleIn(pub, 'group:860'), true);
  assert.equal(recordVisibleIn(unk, 'group:860'), false);
  assert.equal(recordVisibleIn(p, 'private:1'), true);
  assert.equal(recordVisibleIn(g, 'private:1'), false);
});

test('选条：≥7 天、中高 salience、近 3 天未被提过、不重复', () => {
  const records = [
    rec('old', 10, '商品页文案要不要加一句“可加急”', { importance: 80 }),
    rec('too-new', 2, '昨天的聊天不算旧记忆', { importance: 99 }),
    rec('low-salience', 12, '低重要度的碎片', { importance: 20 }),
    rec('mentioned', 9, '最近刚提过的一件旧事', { importance: 85 }),
  ];
  const picked = selectRestReplay({ records, convKey: 'private:1', now: NOW, recentTexts: ['最近刚提过的一件旧事', '又聊了旧事'] });
  assert.ok(picked, '应选到候选');
  assert.equal(picked.record.id, 'old');
  const none = selectRestReplay({ records: [rec('too-new', 2, 'x')], convKey: 'private:1', now: NOW });
  assert.equal(none, null);
});

test('线索渲染：人+大致时间+半句，≤120 字，不给结论/全文', () => {
  const r = rec('r1', 10, '商品页文案要不要加一句可加急——后来真的加上了并且用了一周', { speaker: '老大' });
  const line = renderRestReplayClue(r, { convKey: 'private:1', now: NOW });
  assert.ok(line.length <= 120, `≤120，实际 ${line.length}`);
  assert.match(line, /你和老大聊过一件事/);
  assert.match(line, /想得起后来怎样了吗/);
  assert.match(line, /不用硬编/);
  assert.ok(!line.includes('后来真的加上了并且用了一周'), '不能给结论/全文');
  const gl = renderRestReplayClue({ ...r, speaker: '群友A', originKind: 'group', conversationKey: 'group:860' }, { convKey: 'group:860', now: NOW });
  assert.match(gl, /群友A在群里聊过一件事/);
});

test('触发/节奏/互斥：静默≥20 分钟或 selfTime；每天≤2、间隔≥3h、与其它记忆提示互斥', () => {
  const records = [rec('r1', 10, '商品页文案可加急那件事后来怎样了', { importance: 80 })];
  const base = { records, convKey: 'private:1', now: NOW, recentTexts: [] };
  assert.equal(restReplayDecision({ ...base, quietMinutes: 5, reason: 'private' }).reason, 'not-quiet-trigger');
  assert.equal(restReplayDecision({ ...base, quietMinutes: 5, reason: 'selfTime' }).reason, 'inject');
  assert.equal(restReplayDecision({ ...base, quietMinutes: 30, reason: 'keyword', recentEventsActive: true }).reason, 'mutex-other-memory-hint');
  assert.equal(restReplayDecision({ ...base, quietMinutes: 30, firstTurnActive: true }).reason, 'mutex-other-memory-hint');
  assert.equal(restReplayDecision({ ...base, quietMinutes: 30, replayState: { day: new Date(NOW).toLocaleDateString('sv-SE'), count: 2, lastAt: NOW - 4 * 3600_000 } }).reason, 'daily-limit');
  assert.equal(restReplayDecision({ ...base, quietMinutes: 30, replayState: { day: '2026-11-08', count: 0, lastAt: NOW - 2 * 3600_000 } }).reason, 'min-interval');
  const ok = restReplayDecision({ ...base, quietMinutes: 40, reason: 'keyword', replayState: { day: '2026-11-08', count: 1, lastAt: NOW - 4 * 3600_000 } });
  assert.equal(ok.reason, 'inject');
  assert.ok(ok.line.length <= 120);
  assert.equal(REST_REPLAY_RULES.quietMinutes, 20);
  assert.equal(REST_REPLAY_RULES.maxPerDay, 2);
});

test('状态推进：同一天计数累加，跨天重置', () => {
  const now = NOW;
  let st = nextReplayState({}, { now });
  assert.equal(st.count, 1);
  st = nextReplayState(st, { now: now + 3600_000 });
  assert.equal(st.count, 2);
  const nextDay = nextReplayState(st, { now: now + D });
  assert.equal(nextDay.count, 1);
});

test('线索词/近 3 天提及判定', () => {
  assert.ok(clueTokens('商品页文案要不要加一句可加急').length >= 2);
  const r = rec('r', 9, '商品页文案要不要加一句可加急');
  assert.equal(mentionedRecently(r, ['商品页文案加急的事聊过了'], { now: NOW }), true);
  assert.equal(mentionedRecently(r, ['今天吃什么'], { now: NOW }), false);
});
