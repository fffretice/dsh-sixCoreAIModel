// pushCount 相对基线 shadow 采集的单测（task-23-B）。纯函数，不读生产、不写盘。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseWakeLines, baselineStats, seededRng, buildBaselineRow, parseMoodHistory, nearestMood, report, quantile, mergeWakeEvents,
} from './pushcount-shadow.mjs';

const NOW = Date.parse('2026-11-08T23:00:00+08:00');

test('parseWakeLines：只认真实唤醒行，排除带图/计划/跳过；跨零点按文件 mtime 推日期', () => {
  const text = [
    '23:14:42 [bridge] [reserved2] 唤醒带图 private:1000000001：2 张',
    '23:15:06 [bridge] [token-guard] 跳过唤醒 group:1000000002（image）：Token 防爆破',
    '23:16:30 [bridge] [reserved2] 计划唤醒 group:1000000002（image），8s 后发送',
    '23:18:05 [bridge] [reserved2] 唤醒 private:1000000001（private）',
    '23:17:31 [bridge] [reserved2] 唤醒 group:1000000004（question）',
    '00:05:01 [bridge] [reserved2] 唤醒 group:1000000002（natural）', // 跨零点：应算前一天
  ].join('\n');
  // 文件 mtime 取 2026-11-08 23:20
  const events = parseWakeLines(text, { fileMtimeMs: NOW });
  assert.equal(events.length, 3, `只应解析出 3 条真实唤醒，实际 ${events.length}`);
  assert.deepEqual(events.map((e) => e.key), ['private:1000000001', 'group:1000000004', 'group:1000000002']);
  const cross = events.find((e) => e.key === 'group:1000000002');
  assert.ok(cross.at < NOW - 20 * 3600_000, '跨零点行应落到前一天');
  assert.equal(events[0].reason, 'private');
  assert.equal(events[1].reason, 'question');
});

test('baselineStats：7 天中位数/标准差；样本不足返回 null', () => {
  const samples = Array.from({ length: 50 }, (_, i) => ({ at: NOW - i * 3600_000, dims: { patience: 0.8 + (i % 5) * 0.01 } }));
  const st = baselineStats(samples, NOW);
  assert.equal(st.n, 50);
  assert.ok(st.median >= 0.8 && st.median <= 0.85);
  assert.ok(st.sd >= 0);
  const few = baselineStats(samples.slice(0, 5), NOW);
  assert.equal(few.median, null);
  assert.equal(few.n, 5);
  // 窗口外样本不算
  const old = samples.map((s) => ({ ...s, at: s.at - 30 * 86400000 }));
  assert.equal(baselineStats(old, NOW).median, null);
});

test('seededRng 可复现 + quantile 正确', () => {
  const a = seededRng(1, 'group:1');
  const b = seededRng(1, 'group:1');
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(quantile([], 0.5), 0);
});

test('buildBaselineRow：高耐心 pushCount 恒 0、低耐心触发；z 分数与行为字段', () => {
  const high = buildBaselineRow({
    at: NOW, key: 'group:1', reason: 'image', dims: { patience: 0.9, energy: 0.7, mood: 0.6, social: 0.8 },
    baseline: { median: 0.9, sd: 0.05, n: 100 }, rng: seededRng(NOW, 'group:1'),
  });
  assert.equal(high.pushCountCurrent, 0);
  assert.equal(high.pushCountPSteeper, 0);
  assert.equal(high.patienceZ, 0);
  assert.equal(high.source, 'script');
  assert.equal(high.behaviorSource, 'script');
  for (const k of ['procrastinate', 'terse', 'initiate', 'talky']) assert.equal(typeof high[k], 'boolean');

  const low = buildBaselineRow({
    at: NOW, key: 'group:1', reason: 'question', dims: { patience: 0.3, energy: 0.5, mood: 0.6, social: 0.8 },
    baseline: { median: 0.9, sd: 0.05, n: 100 }, rng: seededRng(NOW, 'group:1'),
  });
  assert.ok(low.pushCountCurrent > 0, '低耐心应触发 current');
  assert.ok(low.pushCountPSteeper > 0, '低耐心应触发 p-steeper');
  assert.ok(low.patienceZ < -1, '低耐心 z 应显著为负');
  assert.equal(low.asleep, false);
  // 相同输入 + 相同种子 → 行完全一致（可复现）
  const again = buildBaselineRow({
    at: NOW, key: 'group:1', reason: 'question', dims: { patience: 0.3, energy: 0.5, mood: 0.6, social: 0.8 },
    baseline: { median: 0.9, sd: 0.05, n: 100 }, rng: seededRng(NOW, 'group:1'),
  });
  assert.deepEqual(low, again);
});

test('nearestMood：取 <= at 的最近采样，超 15 分钟不回看', () => {
  const samples = [
    { at: NOW - 30 * 60000, dims: { patience: 0.9 } },
    { at: NOW - 5 * 60000, dims: { patience: 0.8 } },
  ];
  assert.equal(nearestMood(samples, NOW).dims.patience, 0.8);
  assert.equal(nearestMood(samples, NOW - 20 * 60000).dims.patience, 0.9);
  assert.equal(nearestMood(samples, NOW - 50 * 60000), null, '超过 15 分钟不回看应返回 null');
});

test('report：z<-1 占比、公式日均触发差、按天统计', () => {
  const rows = [
    { at: NOW - 2 * 86400000, patienceZ: -1.5, pushCountCurrent: 0, pushCountPSteeper: 1, pushCountShifted: 1, reason: 'image' },
    { at: NOW - 2 * 86400000 + 3600_000, patienceZ: 0.2, pushCountCurrent: 0, pushCountPSteeper: 0, pushCountShifted: 0, reason: 'private' },
    { at: NOW - 86400000, patienceZ: -2, pushCountCurrent: 1, pushCountPSteeper: 2, pushCountShifted: 2, reason: 'question' },
  ];
  const rep = report(rows);
  assert.equal(rep.n, 3);
  assert.equal(rep.days, 2);
  assert.equal(rep.patienceZ.lowMinus1Count, 2);
  assert.equal(rep.patienceZ.lowMinus1Pct, 66.7);
  assert.equal(rep.pushCount.currentTriggerRatePct, 33.3);
  assert.equal(rep.pushCount.pSteeperTriggerRatePct, 66.7);
  assert.equal(rep.perDay.length, 2);
  assert.equal(rep.perDay[0].diffPSteeperVsCurrent, 1);
  assert.equal(rep.perDay[1].diffPSteeperVsCurrent, 0);
});

test('mergeWakeEvents：wakeTimes 打底 + 日志 reason 对齐 ±10 秒', () => {
  const wakeTimesByKey = {
    'group:1': [NOW, NOW + 60_000],
    'private:2': [NOW + 30_000],
  };
  const logEvents = [
    { at: NOW + 2000, key: 'group:1', reason: 'image' },      // ±2 秒 → 命中
    { at: NOW + 60_500, key: 'group:1', reason: 'question' }, // ±0.5 秒 → 命中
    { at: NOW + 120_000, key: 'group:1', reason: 'drive' },   // 日志有、wakeTimes 没有 → 新增
  ];
  const merged = mergeWakeEvents({ wakeTimesByKey, logEvents });
  // 排序按时间：NOW(image) / NOW+30s(私聊,无 reason) / NOW+60s(question) / NOW+120s(drive 新增)
  assert.equal(merged.length, 4);
  assert.equal(merged[0].reason, 'image');
  assert.equal(merged[1].reason, '', 'wakeTimes 独有的事件没有 reason');
  assert.equal(merged[2].reason, 'question');
  assert.equal(merged[3].reason, 'drive');
  assert.ok(merged.every((e) => Number.isFinite(e.at) && e.key));
});
