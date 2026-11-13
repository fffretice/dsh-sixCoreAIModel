// 记忆来源标注单测（task-52）：LOL 案例 + 构造
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SOURCE_HINT, isGroupSourced, groupNumberOf, speakerOf, attributionBadge,
  formatRecordLineWithAttribution, auditPromptAttribution, renderAttributedLines,
} from '../src/memory-attribution.js';

const LOL = {
  id: 'mem_03b709403704f8', source: 'qq-group', originKind: 'group',
  speaker: '电Man发电机，专电萝莉控', groupId: '1000000003',
  conversationKey: 'group:1000000003', text: '好了，LOL启动', createdAt: '2026-11-10T10:26:50.793Z',
};
const rec = (over = {}) => ({ id: 'mem_x', source: 'qq-group', originKind: 'group', speaker: '群友A', groupId: '1000000002', text: '今天群里聊了联动', ...over });

test('LOL 案例：群来源记录必须带【群号·说话人】', () => {
  assert.equal(isGroupSourced(LOL), true);
  assert.equal(groupNumberOf(LOL), '1000000003');
  assert.equal(speakerOf(LOL), '电Man发电机，专电萝莉控');
  assert.equal(attributionBadge(LOL), '【群1000000003·电Man发电机，专电萝莉控】');
  const line = formatRecordLineWithAttribution(LOL, { view: 'private' });
  assert.ok(line.startsWith('【群1000000003·电Man发电机，专电萝莉控】'));
  assert.ok(line.includes('好了，LOL启动'));
});

test('构造：无 speaker 的群来源不注入；缺 groupId 仍能标；私聊/owner 不加徽标', () => {
  assert.equal(attributionBadge(rec({ speaker: '' })), null);
  assert.equal(formatRecordLineWithAttribution(rec({ speaker: '' }), { view: 'private' }), null);
  assert.equal(renderAttributedLines([rec({ speaker: '' })], { view: 'private' }).length, 0);
  const noGid = rec({ groupId: '', conversationKey: 'group:1000000004' });
  assert.equal(groupNumberOf(noGid), '1000000004');
  assert.ok(formatRecordLineWithAttribution(noGid, { view: 'private' }).includes('【群1000000004·群友A】'));
  const owner = { id: 'm1', source: 'qq-owner', originKind: 'private', speaker: '主人', text: '以后别熬夜' };
  assert.equal(formatRecordLineWithAttribution(owner, { view: 'private' }), '以后别熬夜');
  const pub = { id: 'm2', originKind: 'public', text: '公开活动' };
  assert.equal(formatRecordLineWithAttribution(pub, { view: 'private' }), '公开活动');
});

test('群视图：同群不重复标；跨群仍标', () => {
  const same = formatRecordLineWithAttribution(rec(), { view: 'group', currentGroupId: '1000000002' });
  assert.equal(same, '今天群里聊了联动');
  const cross = formatRecordLineWithAttribution(rec(), { view: 'group', currentGroupId: '1000000003' });
  assert.ok(cross.includes('【群1000000002·群友A】'));
});

test('审计：私聊 prompt 里裸行会被抓；加徽标后 PASS；缺 speaker 单列', () => {
  const bare = '## 最近记得的\n- 2026-11-10 [清楚] 好了，LOL启动';
  const bad = auditPromptAttribution(bare, [LOL], { view: 'private' });
  assert.equal(bad.total, 1);
  assert.equal(bad.unattributed, 1);
  assert.equal(bad.violations[0].expectedBadge, '【群1000000003·电Man发电机，专电萝莉控】');
  const fixed = `## 最近记得的\n- 2026-11-10 [清楚] 【群1000000003·电Man发电机，专电萝莉控】 好了，LOL启动`;
  const good = auditPromptAttribution(fixed, [LOL], { view: 'private' });
  assert.equal(good.attributed, 1);
  assert.equal(good.unattributed, 0);
  const missing = auditPromptAttribution('- 2026-11-10 [清楚] 今天群里聊了联动', [rec({ speaker: '' })], { view: 'private' });
  assert.equal(missing.missingSpeaker, 1);
});

test('软提醒文案：明确“群里的话≠老大说的”', () => {
  assert.match(SOURCE_HINT, /群里的话是群友说的/);
  assert.match(SOURCE_HINT, /不等于老大说的/);
  assert.match(SOURCE_HINT, /引用前先看说话人/);
});
