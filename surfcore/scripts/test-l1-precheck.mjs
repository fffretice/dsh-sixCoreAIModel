// precheck 触发纯函数单测（2026-11-10）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { precheckTrigger, precheckRetrievalQuery, PRECHECK_HINTS } from '../src/l1-shadow-core.js';

test('三类触发：归属/来源、承诺/回溯、事实回溯', () => {
  const cases = [
    ['偷我表情（', 'ownership_source'],
    ['你给过我这个梗吗', 'ownership_source'],
    ['头像是我自己换的吗', 'fact_retro'],
    ['你答应过教我怎么改价吗', 'promise_recall'],
    ['上次问你的双人曲还没回我呢（', 'promise_recall'],
    ['说好的早点睡呢', 'promise_recall'],
    ['美铃是不是我', 'fact_retro'],
    ['我自己长什么样', 'fact_retro'],
    ['头像是不是变过啦', 'fact_retro'],
  ];
  for (const [q, cat] of cases) assert.equal(precheckTrigger(q).category, cat, `${q} 应为 ${cat}`);
  assert.equal(precheckTrigger('自拍照也太像了').triggered, true);
});

test('普通闲聊/规则句不误触发', () => {
  for (const q of ['今天吃什么', '哈哈哈哈', '晚安', '群里发个图吧', '发图的时候一句话都别说', '这张图挺好看', '我去翻一下动态', '11/16 有卡池', '昨天小孩和我说要打工', '[引用 AAA：这比我自己的记忆还清楚（]给你爸闹钟调到晚上4点半']) {
    assert.equal(precheckTrigger(q).triggered, false, `${q} 不应触发`);
  }
});

test('检索 query：命中加类别提示词，未命中保持原文', () => {
  const hit = precheckRetrievalQuery('我自己长什么样');
  assert.equal(hit.category, 'fact_retro');
  assert.ok(hit.retrievalQuery.includes('我自己长什么样'));
  assert.ok(hit.retrievalQuery.includes('外貌'));
  const miss = precheckRetrievalQuery('今天吃什么');
  assert.equal(miss.triggered, false);
  assert.equal(miss.retrievalQuery, '今天吃什么');
  assert.ok(PRECHECK_HINTS.ownership_source.includes('表情'));
});

test('短句/空串安全', () => {
  assert.equal(precheckTrigger('').triggered, false);
  assert.equal(precheckTrigger('嗯').triggered, false);
  assert.equal(precheckTrigger(null).triggered, false);
});
