// L1 本地检索 shadow 纯函数单测（task-22）。只测分类/关键词/拼装，不读生产、不注入。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyInfoType, extractKeywords, buildRetrievalQuery, assembleWouldInject,
  buildShadowEntry, computeHitRate, L1_MAX_INJECT_CHARS,
  hasQuestionIntent, shouldTriggerV2, classifyInfoTypeV2, rankCandidatesV2, buildShadowEntryV2,
} from '../src/l1-shadow-core.js';

test('L1：五类信息 + 闲聊分类', () => {
  const cases = [
    ['你还记得上次说的那个卡池吗', 'past'],
    ['她是谁啊，叫什么名字', 'person'],
    ['这个可以吗？是不是该先问老大', 'rule'],
    ['这个梗什么意思，出处是哪', 'meme'],
    ['学马下一期卡池什么时候开，多少抽', 'fact'],
    ['今天天气不错啊（', 'chat'],
  ];
  for (const [text, expected] of cases) {
    const r = classifyInfoType(text);
    assert.equal(r.type, expected, `${text} 应分类为 ${expected}，实际 ${r.type}（${JSON.stringify(r.scores)}）`);
    assert.ok(r.label);
    if (expected === 'chat') assert.equal(r.confidence, 0);
    else assert.ok(r.confidence > 0 && r.confidence <= 1);
  }
});

test('L1：关键词抽取（停用词过滤 + 专名优先）', () => {
  const kw = extractKeywords('你还记得美铃那个卡池什么时候更新吗', { names: ['美铃'] });
  assert.ok(kw.includes('美铃'), `应包含专名，实际 ${JSON.stringify(kw)}`);
  assert.ok(!kw.includes('什么'));
  assert.ok(kw.length <= 6);
  const q = buildRetrievalQuery('你还记得上次那个卡池吗', 'past');
  assert.ok(q.keywords.length > 0);
  assert.ok(q.query.includes('以前') || q.query.includes('上次'), '过去类查询应带类型提示词');
  assert.deepEqual(extractKeywords(''), []);
});

test('L1：拼装注入精华 ≤200 字、去重、空安全', () => {
  const candidates = [
    { source: '记忆卡', text: '学马下一期卡池 11/16 更新', score: 5 },
    { source: '归档', text: '学马下一期卡池 11/16 更新', score: 4 }, // 重复文本应被去重
    { source: '主题', text: '学马：资料源 game8 / seesaawiki 可用', score: 3 },
    ...Array.from({ length: 20 }, (_, i) => ({ source: 'cmem', text: `候选记忆 ${i} ${'很长'.repeat(20)}`, score: 1 })),
  ];
  const out = assembleWouldInject(candidates);
  assert.ok(out.length > 0 && out.length <= L1_MAX_INJECT_CHARS, `应 ≤200 字，实际 ${out.length}`);
  assert.equal((out.match(/11\/16 更新/g) || []).length, 1, '重复候选应去重');
  assert.equal(assembleWouldInject([]), '');
  assert.equal(assembleWouldInject([{ source: 'x', text: '' }]), '');
});

test('L1：shadow 记录结构（明确不注入）', () => {
  const entry = buildShadowEntry({
    at: 1794150000000,
    key: 'group:1000000002',
    sender: '群友',
    text: '你还记得上次那个卡池吗',
    context: [{ sender: '老大', text: '学马下期 11/16', isSelf: false }],
    retrieval: {
      candidates: [{ source: '记忆卡', text: '学马卡池 11/16 更新', score: 3 }],
      sourcesTried: ['memory-card', 'topics'],
      errors: [],
      tookMs: 12,
    },
  });
  assert.equal(entry.shadow, true);
  assert.equal(entry.injected, false);
  assert.equal(entry.type, 'past');
  assert.equal(entry.typeLabel, '问过去');
  assert.ok(entry.keywords.length > 0);
  assert.ok(entry.wouldInject.includes('[记忆卡]'));
  assert.ok(entry.wouldInjectChars <= L1_MAX_INJECT_CHARS);
  assert.equal(entry.wouldInjectChars, entry.wouldInject.length);
  assert.deepEqual(entry.sourcesHit, ['记忆卡']);
});

test('L1：人工评分命中率计算', () => {
  assert.deepEqual(computeHitRate([{ hit: 1 }, { hit: 1 }, { hit: 0 }, { hit: true }, { hit: null }]), { n: 4, hits: 3, hitRatePct: 75 });
  assert.deepEqual(computeHitRate([]), { n: 0, hits: 0, hitRatePct: 0 });
});

// ── L1 v2（2026-11-09）：收紧触发面 + 排序/最小重合度 ───────────────────
test('L1 v2：问句意图与类型门槛（叙述句降级为闲聊）', () => {
  assert.equal(hasQuestionIntent('你还记得上次那个卡池吗'), true);
  assert.equal(hasQuestionIntent('之前我还说用谷歌远程'), false);
  assert.equal(hasQuestionIntent('那你分析一下这是为什么'), true);
  assert.equal(hasQuestionIntent('肥在哪'), true);
  assert.equal(hasQuestionIntent('这剧情对吗'), true);

  const cases = [
    ['之前我还说用谷歌远程', 'chat', 'no-intent'],       // v1 错判「问过去」的典型
    ['群友的鱼已经驰骋沙场', 'chat', 'no-intent'],
    ['你还记得上次那个卡池吗', 'past', ''],
    ['superagent我记得好像是', 'past', ''],              // 强回忆词直接触发
    ['这剧情对吗', 'rule', ''],
    ['肥在哪', 'fact', ''],                              // 中文短疑问句（不打问号也算问）
    ['学马下一期卡池什么时候开，多少抽？', 'fact', ''],
  ];
  for (const [text, expectType, reason] of cases) {
    const r = classifyInfoTypeV2(text);
    assert.equal(r.type, expectType, `${text} → ${r.type}（期望 ${expectType}，scores=${JSON.stringify(r.scores)}）`);
    assert.equal(r.engine, 'v2');
    if (expectType === 'chat' && reason) assert.equal(r.downgradeReason, reason);
  }
});

test('L1 v2：候选排序——内容词最小重合、cmem 降权/长文过滤', () => {
  const ranked = rankCandidatesV2({
    keywords: ['学马', '卡池', '11/16', '以前', '上次'],
    hints: ['以前', '上次', '记得'],
    candidates: [
      { source: '记忆卡', text: '学马下一期卡池 11/16 更新', score: 1 },
      { source: 'cmem', text: `用户：${'完全无关的长文'.repeat(20)}`, score: 5 },
      { source: '归档', text: '群友在聊别的游戏', score: 5 },
      { source: 'cmem', text: '学马卡池 11/16 的旧讨论', score: 1 },
    ],
  });
  assert.ok(ranked.length >= 1);
  assert.ok(ranked.every((c) => c.score >= 2.5));
  assert.ok(ranked.some((c) => c.source === '记忆卡'), '相关记忆卡候选应保留');
  assert.ok(!ranked.some((c) => c.text.includes('完全无关的长文')), '低重合长文应被过滤');
  assert.ok(!ranked.some((c) => c.text.includes('别的游戏')), '无关候选应被过滤');
});

test('L1 v2：shadow 记录（engine=v2、no-intent/low-overlap 不注入）', () => {
  const noIntent = buildShadowEntryV2({
    at: 1794150000000, key: 'group:1', sender: '群友', text: '之前我还说用谷歌远程',
    retrieval: { candidates: [{ source: '记忆卡', text: '之前聊过远程的事', score: 3 }] },
    keywords: ['远程'], hints: [],
  });
  assert.equal(noIntent.engine, 'v2');
  assert.equal(noIntent.l1Triggered, false);
  assert.equal(noIntent.skipReason, 'no-intent');
  assert.equal(noIntent.wouldInject, '');

  const lowOverlap = buildShadowEntryV2({
    at: 1794150000000, key: 'group:1', sender: '群友', text: '你还记得美铃那期卡池吗？',
    retrieval: { candidates: [{ source: '归档', text: '今天吃了什么', score: 5 }] },
    keywords: ['美铃', '卡池'], hints: ['以前'],
  });
  assert.equal(lowOverlap.l1Triggered, true, '问句应触发检索');
  assert.equal(lowOverlap.skipReason, 'low-overlap');
  assert.equal(lowOverlap.wouldInject, '');
});
