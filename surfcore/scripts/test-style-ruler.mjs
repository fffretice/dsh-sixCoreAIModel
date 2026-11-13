// P0 尺子（src/style-ruler-core.js）单测（task-22）。纯函数，不读写生产。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  splitSentences, bodyOf, computeStyleMetrics, collectStyleLines, diffSnapshots,
  shapeBehaviorSnapshot, evaluatePushCountVariants, dualSamplingMismatch, pushCountBase,
  isoWeekKey, weekStartOf,
} from '../src/style-ruler-core.js';

const NOW = Date.parse('2026-11-08T23:00:00+08:00');
function seededRng(seed = 42) {
  let a = seed >>> 0;
  return () => {
    a += 0x6D2B79F5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('style：句子切分与消息正文（去 @ 前缀）', () => {
  assert.deepEqual(splitSentences('唔…今天有点累。先这样吧！'), ['唔', '今天有点累', '先这样吧']);
  assert.deepEqual(splitSentences(''), []);
  assert.equal(bodyOf('@角色昵称 你好呀'), '你好呀');
  assert.equal(bodyOf('   '), '');
});

test('style：风格指标（句长/问句/语气词/括号/表情/@引用/开头词）', () => {
  const lines = [
    { text: '唔…这也行？', mediaCount: 0, sticker: false },
    { text: '那我去看看（', mediaCount: 0, sticker: false },
    { text: '啊对，你说的那个', mediaCount: 0, sticker: false },
    { text: '@某人 群里没人接你', mediaCount: 0, sticker: false },
    { text: '[表情]', mediaCount: 1, sticker: true },
  ];
  const m = computeStyleMetrics(lines);
  assert.equal(m.messages, 5);
  assert.ok(m.questionRate > 0 && m.questionRate < 100);
  assert.ok(m.particleRate > 0);
  assert.ok(m.bracketRate > 0);
  assert.ok(m.mediaRate > 0);
  assert.ok(m.atQuoteRate > 0);
  assert.ok(m.avgMsgChars > 0 && m.p50MsgChars >= 0);
  assert.ok(Array.isArray(m.particleTop) && m.particleTop.length > 0);
  assert.ok(m.openerTop.length > 0);
  // 空输入不炸
  const empty = computeStyleMetrics([]);
  assert.equal(empty.messages, 0);
  assert.equal(empty.questionRate, 0);
});

test('style：social-v2 + 记忆卡去重合并（同分钟同文只算一次）', () => {
  const t = NOW - 3600_000;
  const collected = collectStyleLines({
    socialState: { conversations: { 'group:1': { recentMessages: [ { text: '同一句话', isSelf: true, time: t, sender: '我' } ] } } },
    cardRecords: [ { isSelf: true, text: '同一句话', conversationKey: 'group:1', createdAt: new Date(t + 5000).toISOString() } ],
    sinceMs: NOW - 7 * 86400000,
  });
  assert.equal(collected.sessions['group:1'].length, 1);
  // botReply 是另一句，应保留
  const collected2 = collectStyleLines({
    socialState: { conversations: {} },
    cardRecords: [ { isSelf: false, text: '主人说', botReply: '她说的话', conversationKey: 'private:2', createdAt: new Date(t).toISOString() } ],
    sinceMs: 0,
  });
  assert.equal(collected2.sessions['private:2'].length, 1);
  assert.equal(collected2.sessions['private:2'][0].text, '她说的话');
});

test('style：两期对比与显著变化', () => {
  const diff = diffSnapshots(
    { metrics: { avgMsgChars: 30, questionRate: 10, particleRate: 50 } },
    { metrics: { avgMsgChars: 24, questionRate: 25, particleRate: 51 } },
  );
  assert.equal(diff.deltas.avgMsgChars, -6);
  assert.equal(diff.deltas.questionRate, 15);
  assert.ok(diff.significant.some((x) => x.metric === 'questionRate'));
  assert.ok(!diff.significant.some((x) => x.metric === 'particleRate')); // 只差 1，不到阈值
});

test('style：行为块（结果质量 + 预测-结算 + 情绪分布）', () => {
  const causal = {
    log: [
      { at: NOW - 1000, source: 'drive', outcome: 'replied', latencyMs: 5000, surprise: 0.2 },
      { at: NOW - 2000, source: 'drive', outcome: 'no_reply', latencyMs: 0, surprise: 0.4 },
      { at: NOW - 7200_000, source: 'request:accept', outcome: 'replied', latencyMs: 15000, surprise: 0.1 },
    ],
    stats: { byStyle: { 'len:short': { n: 5, replied: 4 } }, calibration: { n: 10, brier: 0.21 } },
  };
  const mood = [
    { at: NOW - 1000, dims: { patience: 0.9, energy: 0.7 } },
    { at: NOW - 2000, dims: { patience: 0.8, energy: 0.6 }, asleep: false },
  ];
  const b = shapeBehaviorSnapshot(causal, mood, { now: NOW, windowMs: 7 * 86400000 });
  assert.equal(b.windows.causalSamples, 3);
  assert.equal(b.outcome.replied, 2);
  assert.equal(b.outcome.no_reply, 1);
  assert.equal(b.calibration.n, 10);
  assert.equal(b.calibration.brier, 0.21);
  assert.ok(b.mood.patienceP50 >= 0.8 && b.mood.patienceP50 <= 0.9);
  assert.ok(b.latencyMs.p50 > 0);
  assert.equal(b.qualityProxy.noReplyRate > 0, true);
});

test('style：pushCount 公式推导（高耐心=0，低耐心触发）+ 候选公式对比', () => {
  // 现状公式 base：patience 0.85 / energy 0.7 → -1.8 - 0.3 = -2.1，远低于 -0.5
  assert.ok(pushCountBase(0.85, 0.7) < -0.5);
  assert.ok(pushCountBase(0.3, 0.5) > 0.5);
  const low = Array.from({ length: 50 }, (_, i) => ({ patience: 0.3 + (i % 3) * 0.01, energy: 0.5 }));
  const high = Array.from({ length: 50 }, () => ({ patience: 0.87, energy: 0.7 }));
  const rng1 = seededRng();
  const variantsLow = evaluatePushCountVariants(low, { draws: 10, rng: rng1 });
  const currentLow = variantsLow.find((v) => v.id === 'current');
  assert.ok(currentLow.triggerRatePct > 80, `低耐心时现状公式应触发，实际 ${currentLow.triggerRatePct}%`);
  const variantsHigh = evaluatePushCountVariants(high, { draws: 10, rng: seededRng() });
  const currentHigh = variantsHigh.find((v) => v.id === 'current');
  assert.equal(currentHigh.triggerRatePct, 0, '高耐心时现状公式应恒 0');
  // 相对基线公式标记为 unsupported（需运行时基线）
  assert.equal(variantsHigh.find((v) => v.id === 'relative-baseline').supported, false);
});

test('style：双采样不一致概率 > 0（字段级）', () => {
  const r = dualSamplingMismatch({ patience: 0.5, energy: 0.6, mood: 0.6, social: 0.8, draws: 800, rng: seededRng() });
  assert.ok(r.perFieldPct.pushCount > 0, 'pushCount 两次取值应有差异');
  assert.ok(r.anyDiffPct >= 0 && r.anyDiffPct <= 100);
  for (const k of ['procrastinate', 'pushCount', 'talky', 'initiate', 'terse']) assert.ok(Number.isFinite(r.perFieldPct[k]));
});

test('style：ISO 周与周起点（周一）', () => {
  assert.match(isoWeekKey(NOW), /^\d{4}-W\d{2}$/);
  const start = weekStartOf(NOW);
  const d = new Date(start);
  assert.equal(d.getDay(), 1, '周起点应是周一');
  assert.ok(start <= NOW && NOW - start < 7 * 86400000);
});
