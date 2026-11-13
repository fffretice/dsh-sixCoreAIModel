// 主题 wiki 升级（累积 + 结论索引 + 规则档案进目录）单测（task-9 B3，2026-11-09）。
// 全部在临时目录，不读写生产记忆。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  addMemoryRecord, createEmptyCard, normalizeMemoryCardConfig, refreshInitialState,
} from '../src/memory-card.js';
import { rebuildTopics, readTopicIndex, listTopics, resolveTopicPaths } from '../src/memory-topics.js';

const CFG = normalizeMemoryCardConfig({ maxChars: 4000, injectMaxChars: { qq: 900, bili: 700 } });
const NOW = Date.parse('2026-11-09T08:00:00+08:00');

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'memory-topics-b3-')); }

function record(card, { text, title = '', key = 'group:1', importance = 80, createdAt = NOW }) {
  addMemoryRecord(card, {
    source: key.startsWith('private:') ? 'qq-owner' : 'qq-group',
    text, title, conversationKey: key, private: key.startsWith('private:'),
    isOwner: key.startsWith('private:'), direct: true,
    manualImportance: importance, createdAt, lastSeenAt: createdAt,
  }, CFG, NOW);
}

test('B3：重建会累积旧事实（热卡里没有的旧行不丢）+ 去重', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'topics'), { recursive: true });
  // 旧主题页：一条卡里已经没有的旧事实 + 一条会与新事实重复的（同一天同文）
  fs.writeFileSync(path.join(dir, 'topics', '头像.md'), [
    '# 头像',
    '',
    '- 2026-10-20 很旧的换头像记忆，卡里已经淘汰了',
    '- 2026-11-09 那天晚上老大怂恿我换头像',
    '',
  ].join('\n'), 'utf8');
  const card = createEmptyCard(NOW);
  record(card, { text: '那天晚上老大怂恿我换头像', key: 'private:2', importance: 90 });
  record(card, { text: '后来头像换成蓝发那张了', key: 'group:1', createdAt: NOW - 60000 });
  record(card, { text: '头像那张是老大挑的', key: 'group:1', createdAt: NOW - 120000 });
  refreshInitialState(card);
  const audit = rebuildTopics(card, dir, NOW);
  const body = fs.readFileSync(path.join(dir, 'topics', '头像.md'), 'utf8');
  assert.match(body, /很旧的换头像记忆/, '旧事实应被累积保留');
  assert.equal(body.split('那天晚上老大怂恿我换头像').length - 1, 1, '同一天同文去重后只出现一次');
  assert.ok(audit.factsAdded >= 2);
  assert.ok(typeof audit.indexChars === 'number' && audit.indexChars <= 1080);
});

test('B3：40 条/主题上限（超出时保留最近的，审计记录 dropped）', () => {
  const dir = tempDir();
  const card = createEmptyCard(NOW);
  for (let i = 0; i < 45; i += 1) record(card, { text: `头像新事实第 ${i} 条，测试 40 条上限`, key: 'group:1', createdAt: NOW - i * 60000 });
  refreshInitialState(card);
  const audit = rebuildTopics(card, dir, NOW);
  const body = fs.readFileSync(path.join(dir, 'topics', '头像.md'), 'utf8');
  const facts = body.split('\n').filter((l) => l.startsWith('- '));
  assert.ok(facts.length <= 40, `事实数应 ≤40，实际 ${facts.length}`);
  assert.ok(audit.factsDropped >= 1, `应记录被上限挤掉的事实，实际 ${audit.factsDropped}`);
});

test('B3：索引写结论（不截半句）、## 摘要优先、## 手写逐字节保留', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'topics'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'topics', '群里的规矩.md'), [
    '# 群里的规矩',
    '',
    '## 摘要',
    '- 群里被逗可以接一句就停，别顺着演。',
    '',
    '- 2026-11-07 旧的事实行',
    '',
    '## 手写',
    '这是我自己写的一段，重建必须保留。第二行也要在。',
    '',
  ].join('\n'), 'utf8');
  const card = createEmptyCard(NOW);
  record(card, { text: '群里刷屏的时候别跟着刷，接一句就停', key: 'group:1' });
  record(card, { text: '群里的规矩：不要转述私聊', key: 'group:1' });
  refreshInitialState(card);
  rebuildTopics(card, dir, NOW);
  const index = fs.readFileSync(path.join(dir, 'topics', '_index.md'), 'utf8');
  const ruleTopic = fs.readFileSync(path.join(dir, 'topics', '群里的规矩.md'), 'utf8');
  assert.match(index, /群里的规矩/);
  assert.match(index, /群里被逗可以接一句就停/, '索引应使用 ## 摘要 作为结论');
  assert.doesNotMatch(index, /旧的事实行/, '索引不是原话清单');
  for (const line of index.split('\n').filter((l) => l.startsWith('- '))) {
    assert.ok(line.length < 90, `索引行不应过长（防截半句）：${line}`);
  }
  assert.match(ruleTopic, /## 手写\n这是我自己写的一段，重建必须保留。第二行也要在。/);
});

test('B3：群聊目录只用 group/public 样本，不把私聊结论带进群', () => {
  const dir = tempDir();
  const card = createEmptyCard(NOW);
  // 私聊头像事实重要度更高
  record(card, { text: '私聊头像暗号：晚上换蓝发，别告诉群里', key: 'private:1000000001', importance: 99 });
  record(card, { text: '群里在聊头像，说蓝发这张好看', key: 'group:1000000002', importance: 70 });
  refreshInitialState(card);
  rebuildTopics(card, dir, NOW);
  const privateIndex = readTopicIndex(dir, 2000, { view: 'private' });
  const groupIndex = readTopicIndex(dir, 2000, { view: 'group' });
  assert.match(privateIndex, /头像/);
  assert.match(groupIndex, /头像/, '群主题目录也应有头像主题（群里有样本）');
  assert.doesNotMatch(groupIndex, /私聊头像暗号/, '群目录不能出现私聊样本');
  assert.doesNotMatch(groupIndex, /别告诉群里/, '群目录不能出现私聊内容');
  assert.match(groupIndex, /群里在聊头像|蓝发这张好看/, '群目录应使用群来源事实');
});

test('B3：规则档案（规则-*.md）自动进「规矩档案」小节，且不被重建改写', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'topics'), { recursive: true });
  const rulePath = path.join(dir, 'topics', '规则-测试.md');
  const ruleBody = '# 规则-测试\n\n- 2026-11-09 [checked] 被讨活时先讨价再决定接不接\n';
  fs.writeFileSync(rulePath, ruleBody, 'utf8');
  const card = createEmptyCard(NOW);
  record(card, { text: '学马卡池 11/16 更新', key: 'group:1' });
  refreshInitialState(card);
  rebuildTopics(card, dir, NOW);
  const index = fs.readFileSync(path.join(dir, 'topics', '_index.md'), 'utf8');
  const groupIndex = fs.readFileSync(path.join(dir, 'topics', '_index-group.md'), 'utf8');
  assert.match(index, /## 规矩档案/);
  assert.match(index, /被讨活时先讨价再决定接不接/, '规则档案结论应进私聊目录');
  assert.match(groupIndex, /## 规矩档案/, '群聊目录也应有规矩档案（行为规则，属群安全）');
  assert.equal(fs.readFileSync(rulePath, 'utf8'), ruleBody, '规则档案页不能被重建改写');
});

test('B3：listTopics 不把 _index-group.md 当主题；索引行数合理', () => {
  const dir = tempDir();
  const card = createEmptyCard(NOW);
  record(card, { text: '学马下一期卡池什么时候', key: 'group:1' });
  record(card, { text: '头像换好了吗', key: 'group:1' });
  refreshInitialState(card);
  const audit = rebuildTopics(card, dir, NOW);
  const names = listTopics(dir).map((t) => t.name);
  assert.ok(!names.includes('_index-group'), 'listTopics 不应包含 _index-group');
  assert.ok(!names.includes('_index'), 'listTopics 不应包含 _index');
  assert.ok(audit.topics >= 2);
  assert.ok(audit.indexChars > 0);
});
