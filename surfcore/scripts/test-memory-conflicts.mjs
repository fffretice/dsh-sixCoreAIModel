// 旧口径保留 + 冲突检测单测（task-28）。用真实口径原话做 fixture，不读生产。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyTopic, classifyStance, detectConflicts, linkVersionFields,
  renderConflictBlock, conflictsForWake, conflictsForTopic, topicLabel,
} from '../src/memory-conflicts.js';

const rec = (id, source, day, text) => ({ id, source, createdAt: `${day}T12:00:00+08:00`, text });
const FIXTURES = [
  // 1) 视频观后感：旧允许 → 新只私聊
  rec('v-old', 'rule', '2026-10-31', '刷手办类视频先交给老大审核；其他视频自己先看，看完写点观后感（10/31）'),
  rec('v-mid', 'qq-owner', '2026-11-01', '可以哦，对于剧情的观后感可以丢群里，一次一句话就好'),
  rec('v-new', 'rule', '2026-11-02', '没人说话的时候：真闷就翻翻 B 站/热榜，或挑一张图丢群里。注意：可以丢图，但不要在群里讲视频内容或观后感（只私聊老大）'),
  // 2) 群情报：旧允许发群 → 新只发老大群
  rec('g-old', 'qq-owner', '2026-11-03', '以后看到新的联动就把图发群里带一个来源链接'),
  rec('g-new', 'qq-owner', '2026-11-07', '网上找到的新情报，只往我的群里发，kuri群和小兴群你就别发新情报了，那两个群里你只聊天就行了'),
  // 3) 发图配话：旧别说 → 新可配一句
  rec('i-old', 'qq-owner', '2026-11-04', '发图的时候一句话都别说，发到各个群里'),
  rec('i-new', 'qq-owner', '2026-11-07', '发了海报你还可以像正常人一样说一句话'),
];

test('主题/极性分类（三组真实口径）', () => {
  assert.equal(classifyTopic('看完写点观后感'), 'video_afterthought');
  assert.equal(classifyTopic('只往我的群里发新情报'), 'group_intel_forward');
  assert.equal(classifyTopic('发图的时候一句话都别说'), 'image_caption');
  assert.equal(classifyStance('可以丢图，但不要在群里讲视频内容或观后感（只私聊老大）'), 'restrict');
  assert.equal(classifyStance('以后看到新的联动就把图发群里带一个来源链接'), 'allow');
  assert.equal(classifyStance('只往我的群里发，kuri群别发'), 'restrict');
  assert.equal(classifyStance('发图的时候一句话都别说'), 'forbid');
  assert.equal(classifyStance('发了海报你还可以像正常人一样说一句话'), 'allow');
  assert.equal(topicLabel('video_afterthought'), '视频观后感');
});

test('检测三组真实冲突：旧→新、日期/原话成对', () => {
  const cs = detectConflicts(FIXTURES);
  assert.equal(cs.length, 3, `应 3 组冲突，实际 ${cs.map((c) => c.topicKey).join(',')}`);
  const byTopic = Object.fromEntries(cs.map((c) => [c.topicKey, c]));
  assert.equal(byTopic.video_afterthought.old.day, '2026-11-01');
  assert.equal(byTopic.video_afterthought.new.day, '2026-11-02');
  assert.equal(byTopic.group_intel_forward.old.day, '2026-11-03');
  assert.equal(byTopic.group_intel_forward.new.day, '2026-11-07');
  assert.equal(byTopic.image_caption.old.day, '2026-11-04');
  assert.equal(byTopic.image_caption.new.day, '2026-11-07');
  for (const c of cs) assert.ok(c.old.id !== c.new.id);
});

test('同极性/问句/自述不进冲突；称呼类当日志稳定=0 冲突', () => {
  const noConflict = [
    rec('a1', 'qq-owner', '2026-11-01', '以后发图之前先看清内容'),
    rec('a2', 'qq-owner', '2026-11-02', '发图之前记得先看清内容'),
    rec('q1', 'qq-owner', '2026-11-01', '可以发群吗'),
    rec('s1', 'qq-self', '2026-11-01', '发图的时候一句话都别说，发到各个群里'),
    rec('addr', 'qq-owner', '2026-11-03', '孩子在房间里叫我我甚至直接说话就可以了'),
  ];
  assert.equal(detectConflicts(noConflict).length, 0);
});

test('版本字段成对登记（幂等）：旧 supersededAt/By/conflictWith，新 conflictWith', () => {
  const cs = detectConflicts(FIXTURES);
  const once = linkVersionFields(FIXTURES, cs);
  const twice = linkVersionFields(once, cs);
  const gOld = twice.find((r) => r.id === 'g-old');
  const gNew = twice.find((r) => r.id === 'g-new');
  assert.ok(gOld.supersededAt && gOld.supersededBy === 'g-new');
  assert.ok(gOld.conflictWith.includes('g-new'));
  assert.ok(gNew.conflictWith.includes('g-old'));
  assert.deepEqual(twice, once, '重复打标应幂等');
});

test('渲染：≤2 对、≤120 字、含旧→新日期与线索措辞；私聊/owner 才返回', () => {
  const cs = detectConflicts(FIXTURES);
  const block = renderConflictBlock(cs, { maxChars: 120 });
  assert.ok(block.length <= 120, `块应 ≤120 字，实际 ${block.length}`);
  assert.ok((block.match(/；/g) || []).length <= 1, '最多 2 对（一个分号）');
  assert.match(block, /口径变更/);
  assert.match(block, /老大 11-/, 'owner 口径应标注「老大」');
  assert.match(block, /不要急着道歉|愣一下/);
  const records = FIXTURES;
  assert.equal(conflictsForWake({ text: '群情报发哪？', convKey: 'group:860', isOwner: false, records }), '');
  assert.equal(conflictsForWake({ text: '今天吃什么', convKey: 'private:1', isOwner: true, records }), '');
  assert.match(conflictsForWake({ text: '群里发情报的事你还记得吗', convKey: 'private:1', isOwner: true, records }), /口径变更/);
  assert.match(conflictsForWake({ text: '视频观后感我忘了', convKey: 'private:1', isOwner: true, records }), /口径变更/);
  assert.equal(conflictsForTopic('发图配话', records).length, 1);
});
