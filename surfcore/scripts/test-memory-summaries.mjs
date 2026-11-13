// 主题页 ## 摘要 写入工具的单测（task-9 B3，2026-11-09）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { upsertSummary, APPROVED_SUMMARIES } from './memory-apply-summaries.mjs';

const BODY = ['# 头像', '', '> 自动从记忆卡整理。', '> 想改的话直接改这个文件。', '', '- 2026-11-06 旧事实一', '- 2026-11-05 旧事实二', ''].join('\n');

test('摘要写入：插在标题/引言之后、事实之前，其余内容逐字节保留', () => {
  const out = upsertSummary(BODY, '现在用蓝发那张。');
  assert.match(out, /^# 头像\n\n> 自动从记忆卡整理。\n> 想改的话直接改这个文件。\n\n## 摘要\n- 现在用蓝发那张。\n\n- 2026-11-06 旧事实一/);
  assert.ok(out.includes('- 2026-11-05 旧事实二'));
  assert.equal((out.match(/## 摘要/g) || []).length, 1);
});

test('摘要写入：幂等（重复执行只保留一个摘要段，内容更新为最新）', () => {
  const once = upsertSummary(BODY, '第一版摘要。');
  const twice = upsertSummary(once, '第二版摘要。');
  assert.equal((twice.match(/## 摘要/g) || []).length, 1);
  assert.match(twice, /## 摘要\n- 第二版摘要。/);
  assert.doesNotMatch(twice, /第一版摘要/);
  assert.equal(upsertSummary(twice, '第二版摘要。'), twice, '同样内容再跑应完全一致');
});

test('摘要写入：13 条已审摘要齐备且不含 QQ 号/群号等隐私', () => {
  assert.equal(Object.keys(APPROVED_SUMMARIES).length, 13);
  for (const [name, text] of Object.entries(APPROVED_SUMMARIES)) {
    assert.ok(text.length >= 10 && text.length <= 90, `${name} 摘要长度异常：${text.length}`);
    assert.doesNotMatch(text, /\d{8,}/, `${name} 摘要不应含长数字（QQ/群号）：${text}`);
  }
  assert.match(APPROVED_SUMMARIES['B站和兴趣'], /先私聊老大/);
  assert.match(APPROVED_SUMMARIES['这台机器'], /别在群里聊运维/);
});
