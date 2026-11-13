// 交接块 + 写回质量门单测（task-42，2026-11-10）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { renderHandoffBlock, renderHandoffViews, filterHandoffItems, extractNextFromText, writeHandoffAtomic, HANDOFF_MAX_CHARS } from '../src/handoff-render.js';
import { classifyWriteback, classifyWritebackBatch, isDuplicateText, applyReviewedLabel } from '../src/writeback-gate.js';

const NOW = Date.parse('2026-11-10T15:00:00+08:00');
const THOUGHT = { text: '商品页写完了（不是草稿），等他明天账号弄好就想给他看。还想问手机是不是真给。', at: NOW - 3600_000, origin: 'private' };
const GOAL = { text: '把加急单和老客户回头这两个改价问题自己扒明白', status: 'open', createdAt: NOW - 7200_000, origin: 'private' };

test('交接块：字段齐全、≤200 字、updatedAt 格式', () => {
  const b = renderHandoffBlock({ pendingThoughts: [THOUGHT], goals: [GOAL], view: 'private', now: NOW });
  assert.ok(b.chars <= HANDOFF_MAX_CHARS);
  assert.ok(b.text.includes('做：') && b.text.includes('下一步：') && b.text.includes('卡住：'));
  assert.match(b.text, /（更新 11-10 15:00）/);
  assert.equal(b.fields.doing.length > 0, true);
});

test('视图隔离：群版只含 public/group，私聊念想/日记/room 一律不进群', () => {
  const privateOnly = filterHandoffItems([THOUGHT, { text: '群任务', origin: 'group' }, { text: '公开', origin: 'public' }, { text: '拿不准', origin: 'unknown' }], 'group');
  assert.deepEqual(privateOnly.map((x) => x.text), ['群任务', '公开']);
  const input = { pendingThoughts: [THOUGHT], goals: [GOAL], diary: '今天很暖。明天试着少说半句。', narrative: '明天想试一件小事：早点睡。', view: 'group', now: NOW };
  const views = renderHandoffViews(input);
  assert.ok(!views.group.text.includes('商品页'));
  assert.ok(!views.group.text.includes('日记') && !views.group.text.includes('念想'));
  assert.equal(views.group.view, 'group');
});

test('空源兜底、超长压缩、next 提取', () => {
  const b = renderHandoffBlock({ view: 'private', now: NOW });
  assert.ok(b.chars <= HANDOFF_MAX_CHARS);
  assert.ok(b.fields.next === '—' && b.fields.blocked === '—');
  const long = renderHandoffBlock({ pendingThoughts: [{ text: '很长'.repeat(300), at: NOW, origin: 'private' }], goals: [{ text: '目标'.repeat(200), status: 'open', createdAt: NOW, origin: 'private' }], view: 'private', now: NOW });
  assert.ok(long.chars <= HANDOFF_MAX_CHARS);
  assert.equal(extractNextFromText('明天试着少说半句。'), '少说半句');
});

test('字段互斥：blocked 无则不兜底；群版无公开源省略整块', () => {
  const noBlocked = renderHandoffBlock({ pendingThoughts: [{ text: '把商品页写完', origin: 'private', at: NOW }], view: 'private', now: NOW });
  assert.equal(noBlocked.fields.blocked, '—');
  assert.notEqual(noBlocked.fields.doing, noBlocked.fields.blocked);
  const groupOmit = renderHandoffViews({ pendingThoughts: [THOUGHT], diary: '私事', view: 'group', now: NOW });
  assert.equal(groupOmit.group.text, '');
  assert.equal(groupOmit.group.omitted, true);
});

test('原子覆盖写：同文件两次写入只保留最新，不追加', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-'));
  const file = path.join(dir, 'blocks.json');
  const first = writeHandoffAtomic(fs, file, { updatedAt: '11-10 15:00', private: { text: 'A' }, group: { text: 'G1' } });
  const second = writeHandoffAtomic(fs, file, { updatedAt: '11-10 15:05', private: { text: 'B' }, group: { text: 'G2' } });
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.private.text, 'B');
  assert.equal(parsed.group.text, 'G2');
  assert.equal(second.updatedAt, '11-10 15:05');
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')).length, 0);
  assert.ok(first);
});

test('写回分类：老大原话/约定/偏好不误杀，闲聊/问题/日志拒绝', () => {
  const date = '2026-11-10';
  const accept = [
    { text: '以后学马氏的东西丢我的群里就够了', source: 'qq-owner', date, createdAt: `${date}T12:00:00+08:00` },
    { text: '我喜欢的是美铃', source: 'qq-owner', date, createdAt: `${date}T12:00:00+08:00` },
    { text: '说好我发呆的时候找你要音乐听的', source: 'qq-owner', date, createdAt: `${date}T12:00:00+08:00` },
    { text: '主要是这一点：不要让人觉得你有求必应', source: 'qq-owner', date, createdAt: `${date}T12:00:00+08:00` },
    { text: '记得是要发消息的图，而不是只说一声', source: 'qq-owner', date, createdAt: `${date}T12:00:00+08:00` },
  ];
  for (const r of accept) assert.equal(classifyWriteback(r).action, 'accept', r.text);
  assert.equal(classifyWriteback({ text: '这张看着挺乖的，合适（', source: 'qq-self', date }).action, 'reject');
  assert.equal(classifyWriteback({ text: '今天吃什么？', source: 'qq-owner', date }).action, 'reject');
  assert.equal(classifyWriteback({ text: '【助手】夜间体检：0 个 P0', source: 'qq-self', date }).action, 'reject');
  // 缺日期/来源 → quarantine，不直接丢
  assert.equal(classifyWriteback({ text: '以后别把私聊内容发群里' }).action, 'quarantine');
  // owner 祈使/原则但规则未命中 → quarantine（不直接 reject，防误杀）
  const qOwner = classifyWriteback({ text: '你别这样', source: 'qq-owner', date });
  assert.equal(qOwner.action, 'quarantine');
  assert.equal(qOwner.reviewPriority, 'high');
  // 纯 @/图片 片段 → reject
  assert.equal(classifyWriteback({ text: '@AAA [图片]', source: 'qq-owner', date }).action, 'reject');
  // owner 方向问句不能丢 reject（PM 校准 #1）
  assert.equal(classifyWriteback({ text: '你不应该去研究关节算法之类的吗', source: 'qq-owner', date }).action, 'accept');
  // 已在规则/决定里的重复项可识别
  assert.equal(isDuplicateText('好哦，你可以自己提前去研究了，比如说怎么控制身体各关节怎么做家务', '十一、做家务：控制身体各关节怎么做家务'), true);
  assert.equal(isDuplicateText('今天吃什么', '做家务：控制身体各关节怎么做家务'), false);
  // PM 人工标签覆盖：reject 后不再进队列
  const rej = applyReviewedLabel(classifyWriteback({ text: '小孩子别听', source: 'qq-owner', date }), 'reject');
  assert.equal(rej.action, 'reject');
  assert.equal(rej.reason, 'pm_review_reject');
  const acc = applyReviewedLabel(classifyWriteback({ text: '小孩子别听', source: 'qq-owner', date }), 'accept');
  assert.equal(acc.action, 'accept');
});

test('批量门：单次 ≤10 行、≤2KB；超出 quarantine 不整批丢', () => {
  const recs = Array.from({ length: 14 }, (_, i) => ({ text: `以后第${i}条：别丢小兴群`, source: 'qq-owner', date: '2026-11-10' }));
  const out = classifyWritebackBatch(recs);
  const accepted = out.results.filter((r) => r.action === 'accept').length;
  const limited = out.results.filter((r) => r.reason === 'batch_limit').length;
  assert.ok(out.lines <= 10);
  assert.ok(accepted <= 10);
  assert.ok(limited >= 4);
  assert.equal(out.results.length, 14);
});
