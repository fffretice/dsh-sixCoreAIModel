// 主题目录分视图单测（task-12）：群聊视角索引只列群/公开来源样本。
// 2026-11-08。纯本地临时目录，不读写生产记忆。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  addMemoryRecord, createEmptyCard, normalizeMemoryCardConfig, resolveMemoryCardPaths,
} from '../src/memory-card.js';
import { rebuildTopics, readTopicIndex, resolveTopicPaths } from '../src/memory-topics.js';

const CFG = normalizeMemoryCardConfig({ maxChars: 4000, injectMaxChars: { qq: 900, bili: 700 } });
const NOW = Date.parse('2026-11-08T20:00:00+08:00');

test('task-12：群聊视角主题目录不含私聊样本，私聊版保留完整样本', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-topics-view-'));
  const card = createEmptyCard(NOW);
  // 私聊里聊头像（重要度更高，会成为私聊索引样本）
  const priv = addMemoryRecord(card, {
    source: 'qq-owner', text: '私聊里说的头像暗号：晚上换蓝发那张，别告诉群里',
    isOwner: true, isPrivate: true, direct: true, conversationKey: 'private:1000000001', private: true,
    manualImportance: 95, createdAt: NOW, lastSeenAt: NOW,
  }, CFG, NOW);
  assert.equal(priv.added, true);
  // 群里聊头像（重要度低一些，但群视图只能用它当样本）
  addMemoryRecord(card, {
    source: 'qq-group', text: '群里在聊头像，说蓝发这张挺好看',
    conversationKey: 'group:1000000002', manualImportance: 80, createdAt: NOW - 60_000, lastSeenAt: NOW - 60_000,
  }, CFG, NOW);
  // B站公开来源（也算群视图可用样本）
  addMemoryRecord(card, {
    source: 'bili-video', text: 'B站头像相关：鲸鱼娘的头像合集', scope: 'bili', platform: 'bili',
    createdAt: NOW - 120_000, lastSeenAt: NOW - 120_000,
  }, CFG, NOW);

  rebuildTopics(card, dir, NOW);
  const paths = resolveTopicPaths(dir);
  const privateIndex = readTopicIndex(dir, 2000, { view: 'private' });
  const groupIndex = readTopicIndex(dir, 2000, { view: 'group' });
  assert.ok(privateIndex.length > 0);
  assert.ok(groupIndex.length > 0, '群聊视角索引应生成');
  assert.ok(fs.existsSync(paths.indexGroup), '_index-group.md 应落盘');
  assert.ok(privateIndex.includes('头像'), '私聊索引应有头像主题');
  assert.ok(groupIndex.includes('头像'), '群聊索引也应有头像主题（有群/公开样本）');
  assert.doesNotMatch(groupIndex, /私聊里说的头像暗号/, '群聊索引不能出现私聊样本');
  assert.doesNotMatch(groupIndex, /别告诉群里/, '群聊索引不能出现私聊内容');
  assert.match(groupIndex, /群里在聊头像|B站头像相关/, '群聊索引应使用群/公开来源样本');
});

test('task-12：还没有群聊索引文件时返回空（宁可没目录，不泄露私聊）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-topics-view-empty-'));
  fs.mkdirSync(path.join(dir, 'topics'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'topics', '_index.md'), '- **头像**（3 条）：私聊里的事\n');
  assert.equal(readTopicIndex(dir, 2000, { view: 'group' }), '', '群聊视图缺文件时应返回空，而不是回退到私聊索引');
  assert.match(readTopicIndex(dir, 2000, { view: 'private' }), /私聊里的事/);
});
