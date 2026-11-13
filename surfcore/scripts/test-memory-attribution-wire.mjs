// task-52 接线单测：memory-card 渲染 shadow/enforce（不改生产 prompt 默认）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEmptyCard, addMemoryRecord, renderMemoryCard, normalizeMemoryCardConfig, saveMemoryCardOutputs, resolveMemoryCardPaths } from '../src/memory-card.js';
import { annotateRecallItem, appendSourceHint, SOURCE_HINT } from '../src/memory-attribution.js';

const NOW = Date.parse('2026-11-10T21:00:00+08:00');
const LOL = {
  source: 'qq-group', text: '好了，LOL启动', conversationKey: 'group:1000000003',
  speaker: '电Man发电机，专电萝莉控', groupId: '1000000003',
  createdAt: new Date(NOW - 3600_000).toISOString(),
};
function cardWith(records) {
  const card = createEmptyCard(NOW);
  for (const r of records) addMemoryRecord(card, r, {}, NOW);
  return card;
}
const render = (card, opts = {}) => renderMemoryCard(card, { platform: 'qq', config: {}, maxChars: 4000, now: NOW, ...opts });

test('shadow（默认）：prompt 不变，记录 would-add 徽标 + 软提醒', () => {
  const events = [];
  const out = render(cardWith([LOL]), { onWouldChange: (e) => events.push(e) });
  assert.ok(out.includes('好了，LOL启动'));
  assert.ok(!out.includes('【群1000000003'));
  assert.ok(!out.includes(SOURCE_HINT));
  assert.ok(events.some((e) => e.action === 'add_badge' && e.badge.includes('电Man')));
  assert.ok(events.some((e) => e.action === 'add_source_hint'));
  assert.equal(normalizeMemoryCardConfig({}).attributionMode, 'shadow');
});

test('enforce：群来源加【群号·说话人】+ 软提醒；缺 speaker 跳过', () => {
  const card = cardWith([
    LOL,
    { source: 'qq-group', text: '无主句测试', conversationKey: 'group:1000000003', speaker: '', groupId: '1000000003', createdAt: new Date(NOW - 7200_000).toISOString() },
    { source: 'qq-owner', text: '以后别熬夜', conversationKey: 'private:1', createdAt: new Date(NOW - 1800_000).toISOString() },
  ]);
  const out = render(card, { attributionMode: 'enforce' });
  assert.ok(out.includes('【群1000000003·电Man发电机，专电萝莉控】 好了，LOL启动'));
  assert.ok(out.includes(SOURCE_HINT));
  assert.ok(!out.includes('无主句测试'), '缺 speaker 群记录不注入');
  assert.ok(out.includes('以后别熬夜'), 'owner 记录不加徽标');
  assert.equal(normalizeMemoryCardConfig({ attribution: { mode: 'enforce' } }).attributionMode, 'enforce');
});

test('群视图：同群记录不重复加徽标（enforce 也不加）', () => {
  const out = render(cardWith([LOL]), { attributionMode: 'enforce', perspective: 'group' });
  assert.ok(out.includes('好了，LOL启动'));
  assert.ok(!out.includes('【群1000000003'));
});

test('recall item 补 speaker/groupId/origin；软提醒可独立追加', () => {
  const record = { id: 'm', source: 'qq-group', originKind: 'group', speaker: '群友A', groupId: '1000000002', text: '群里聊了联动' };
  const item = annotateRecallItem({ from: 'card', text: '群里聊了联动' }, record);
  assert.equal(item.speaker, '群友A');
  assert.equal(item.groupId, '1000000002');
  assert.equal(item.originKind, 'group');
  assert.equal(appendSourceHint('记忆卡', { mode: 'shadow' }), '记忆卡');
  assert.ok(appendSourceHint('记忆卡', { mode: 'enforce' }).includes(SOURCE_HINT));
});


test('saveMemoryCardOutputs：默认 shadow 不写徽标/提示；enforce 才写', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-attr-'));
  const paths = resolveMemoryCardPaths(dir);
  const card = cardWith([LOL]);
  saveMemoryCardOutputs(paths, card, {}, NOW, {});
  const shadowPrompt = fs.readFileSync(paths.promptQq, 'utf8');
  assert.ok(shadowPrompt.includes('好了，LOL启动'));
  assert.ok(!shadowPrompt.includes('【群1000000003'));
  assert.ok(!shadowPrompt.includes('引用前先看说话人'));
  saveMemoryCardOutputs(paths, card, { attributionMode: 'enforce' }, NOW, {});
  const enforcePrompt = fs.readFileSync(paths.promptQq, 'utf8');
  assert.ok(enforcePrompt.includes('【群1000000003·电Man发电机，专电萝莉控】'));
  assert.ok(enforcePrompt.includes('引用前先看说话人'));
});
