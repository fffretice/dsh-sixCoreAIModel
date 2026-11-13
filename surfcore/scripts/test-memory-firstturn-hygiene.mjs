// task-60 首轮兜底 + 卡片卫生纯函数单测
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickFirstTurnAux, classifyCardHygiene, findDuplicateGroups, auditCardHygiene, planCardHygiene } from '../src/memory-firstturn-hygiene.js';

const now = Date.parse('2026-11-11T10:00:00+08:00');
const ev = (line, reason = 'inject') => ({ line, reason, event: { text: line } });
const rec = (o = {}) => ({ id: 'm1', text: '普通记录', createdAt: new Date(now).toISOString(), importance: 50, source: 'qq-owner', ...o });

test('首轮兜底：recent-events 优先，无事件时图片兜底，其余 none', () => {
  const a = pickFirstTurnAux({ eventDecision: ev('【最近群里在聊】香名江实装'), imageDecision: ev('【最近群里在聊】图片事件'), mediaCount: 2 });
  assert.equal(a.source, 'recent-events');
  assert.equal(a.reason, 'event');
  const b = pickFirstTurnAux({ eventDecision: ev('', 'no-qualified-event'), imageDecision: ev('【最近群里在聊】图片事件'), mediaCount: 2 });
  assert.equal(b.source, 'image');
  assert.equal(b.wouldInject, true);
  const c = pickFirstTurnAux({ eventDecision: ev('', 'no-qualified-event'), imageDecision: ev('x'), mediaCount: 0 });
  assert.equal(c.source, 'none');
  assert.equal(c.wouldInject, false);
});

test('shadow / inject 模式：只差是否真的写进 prompt', () => {
  const shadow = pickFirstTurnAux({ eventDecision: ev('事件行'), mediaCount: 0, mode: 'shadow' });
  assert.equal(shadow.wouldInject, true);
  assert.equal(shadow.inject, false);
  const inj = pickFirstTurnAux({ eventDecision: ev('事件行'), mediaCount: 0, mode: 'inject' });
  assert.equal(inj.inject, true);
});

test('卡片卫生分类：统计句/占位/过期/待核/老化低价值', () => {
  assert.deepEqual(classifyCardHygiene(rec({ text: '一共 23 句，你自己说了 8 句' }), { now }), ['recap_stat']);
  assert.deepEqual(classifyCardHygiene(rec({ text: '[图片]' }), { now }), ['placeholder']);
  assert.deepEqual(classifyCardHygiene(rec({ status: 'superseded' }), { now }), ['expired']);
  assert.ok(classifyCardHygiene(rec({ status: 'unconfirmed', tags: ['回顾'], title: 'x', importance: 60 }), { now }).includes('note_pending'));
  const old = rec({ importance: 5, createdAt: new Date(now - 40 * 86400_000).toISOString() });
  assert.ok(classifyCardHygiene(old, { now }).includes('stale_low_value'));
  assert.deepEqual(classifyCardHygiene(rec(), { now }), []);
});

test('重复组：同日同源同说话人同文才算；不同天不算', () => {
  const a = rec({ id: 'a', text: '同一句', source: 'qq-owner', speaker: '主人' });
  const b = rec({ id: 'b', text: '同一句', source: 'qq-owner', speaker: '主人' });
  const c = rec({ id: 'c', text: '同一句', source: 'qq-owner', speaker: '主人', createdAt: new Date(now - 86400_000).toISOString() });
  const groups = findDuplicateGroups([a, b, c]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map((x) => x.id), ['a', 'b']);
});

test('审计 + 清理计划：不改原记录，只给 remove/review/expired 清单', () => {
  const list = [
    rec({ id: 'r1', text: '一共 12 句，你自己说了 3 句' }),
    rec({ id: 'r2', text: '[图片]' }),
    rec({ id: 'r3', text: '待核笔记', status: 'unconfirmed', tags: ['回顾'], title: 'x' }),
    rec({ id: 'r4', text: '已过期句', status: 'superseded' }),
    rec({ id: 'r5', text: '同一句' }), rec({ id: 'r6', text: '同一句' }),
  ];
  const audit = auditCardHygiene(list, { now, maxRecords: 5 });
  assert.equal(audit.counts.total, 6);
  assert.equal(audit.counts.recapStat, 1);
  assert.equal(audit.counts.placeholder, 1);
  assert.equal(audit.counts.expired, 1);
  assert.equal(audit.counts.notePending, 1);
  assert.equal(audit.counts.duplicateGroups, 1);
  assert.equal(audit.capacity.atCap, true);
  const plan = planCardHygiene(list, { now });
  assert.equal(plan.dryRun, true);
  assert.ok(plan.removeIds.includes('r1') && plan.removeIds.includes('r2'));
  assert.ok(plan.removeIds.includes('r6') || plan.removeIds.includes('r5'));
  assert.ok(plan.reviewIds.includes('r3'));
  assert.ok(plan.expiredIds.includes('r4'));
  assert.equal(list.length, 6, '不得修改原数组');
});
