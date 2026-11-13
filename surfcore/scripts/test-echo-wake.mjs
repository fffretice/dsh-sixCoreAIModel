// echo-wake 单测（task-15 C，2026-11-08）
//
// 覆盖 PM 要求：4×「下头」触发 / 2 条不触发 / 夜间不触发 / 节流不触发；
// 外加：同发送者不触发、白天边界、睡着/醒着、日上限、跨天重置、概率、媒体/超长/自身消息过滤。
import {
  ECHO_WAKE_DEFAULTS,
  normalizeEchoText,
  detectEchoBurst,
  isEchoQuietHour,
  echoDayKey,
  lastSelfAt,
  shouldEchoWake,
} from '../src/echo-wake.js';

let pass = 0;
const ok = (name, fn) => {
  try { fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}\n     ${String(error?.message ?? error)}`); process.exitCode = 1; }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assert failed'); };
const eq = (a, b, msg) => assert(a === b, `${msg || 'eq'}：${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

const TZ = 'Asia/Shanghai';
const t = (hhmmss) => new Date(`2026-11-08T${hhmmss}+08:00`).getTime();
const msg = (text, userId, at, extra = {}) => ({ text, userId, time: at, isSelf: false, ...extra });

// 「下头」现场：18:39:53 / 18:40:22 / 18:42:53 / 18:43:02，4 个不同人
const xiaTou = [
  msg('下头', 'u1', t('18:39:53')),
  msg('下头', 'u2', t('18:40:22')),
  msg('下头', 'u3', t('18:42:53')),
  msg('下头', 'u4', t('18:43:02')),
];
const nowXiaTou = t('18:43:02');

console.log('—— detectEchoBurst ——');
ok('「下头」3 分钟内 3 人刷 → 触发（第 4 条在窗口外）', () => {
  const b = detectEchoBurst(xiaTou, nowXiaTou);
  assert(b, '应触发');
  eq(b.text, '下头'); eq(b.count, 3); eq(b.sendersCount, 3);
});
ok('放宽窗口到 5 分钟后 4 条全算', () => {
  const b = detectEchoBurst(xiaTou, nowXiaTou, { windowMs: 5 * 60 * 1000 });
  assert(b, '应触发'); eq(b.count, 4); eq(b.sendersCount, 4);
});
ok('只刷 2 条不触发', () => {
  eq(detectEchoBurst(xiaTou.slice(0, 2), t('18:40:22')), null);
});
ok('3 条但同一个人不触发（发送者 <2）', () => {
  const same = [msg('下头', 'u1', t('18:39:53')), msg('下头', 'u1', t('18:40:22')), msg('下头', 'u1', t('18:42:53'))];
  eq(detectEchoBurst(same, t('18:42:53')), null);
});
ok('3 条 2 人触发（≥2 人边界）', () => {
  const two = [msg('下头', 'u1', t('18:39:53')), msg('下头', 'u2', t('18:40:22')), msg('下头', 'u1', t('18:42:53'))];
  const b = detectEchoBurst(two, t('18:42:53'));
  assert(b, '应触发'); eq(b.sendersCount, 2);
});
ok('超过 3 分钟窗口的旧消息不算', () => {
  const old = [msg('下头', 'u1', t('18:30:00')), msg('下头', 'u2', t('18:31:00')), msg('下头', 'u3', t('18:32:00')), msg('下头', 'u4', t('18:43:00'))];
  eq(detectEchoBurst(old, t('18:43:02')), null);
});
ok('媒体/引用/超长/过短/她自己的消息不计数', () => {
  const noisy = [
    msg('[图片]', 'u1', t('18:39:53')),
    msg('[表情:某某]', 'u2', t('18:40:00')),
    msg('这是一句非常非常长的话'.repeat(6), 'u3', t('18:40:10')),
    msg('。', 'u4', t('18:40:20')),
    { text: '下头', userId: 'self', time: t('18:40:30'), isSelf: true },
    msg('下头', 'u1', t('18:42:53')),
  ];
  eq(detectEchoBurst(noisy, t('18:43:02')), null);
});
ok('normalizeEchoText 去空白/首尾标点', () => {
  eq(normalizeEchoText('  下头（ '), '下头');
  eq(normalizeEchoText('下头'), '下头');
  eq(normalizeEchoText('!!!'), '');
});

console.log('—— 夜间静默（22:30–08:00） ——');
ok('22:29 不算夜间、22:30 算夜间', () => {
  eq(isEchoQuietHour(t('22:29')), false);
  eq(isEchoQuietHour(t('22:30')), true);
});
ok('07:59 算夜间、08:00 不算', () => {
  eq(isEchoQuietHour(t('07:59')), true);
  eq(isEchoQuietHour(t('08:00')), false);
});
ok('18:43 白天不算夜间', () => eq(isEchoQuietHour(nowXiaTou), false));

console.log('—— shouldEchoWake ——');
const baseArgs = {
  state: null,
  now: nowXiaTou,
  isAsleep: true,
  lastSelfMessageAt: t('18:33:40'), // 9 分钟前说过话，不影响
  random: 0.1,
};
ok('基础场景：睡着 + 白天 + 概率中 → ok，记账 n=1', () => {
  const d = shouldEchoWake(baseArgs);
  eq(d.ok, true); eq(d.reason, 'ok');
  eq(d.next.n, 1); eq(d.next.day, '2026-11-08');
});
ok('醒着不触发（醒着走原 probability 路径）', () => {
  const d = shouldEchoWake({ ...baseArgs, isAsleep: false });
  eq(d.ok, false); eq(d.reason, 'awake');
});
ok('夜间不触发（即使睡着、概率必中）', () => {
  const d = shouldEchoWake({ ...baseArgs, now: t('23:00'), random: 0 });
  eq(d.ok, false); eq(d.reason, 'quiet-hours');
});
ok('最近 5 分钟她说过话 → 不叫（人已在场）', () => {
  const d = shouldEchoWake({ ...baseArgs, lastSelfMessageAt: nowXiaTou - 4 * 60 * 1000 });
  eq(d.ok, false); eq(d.reason, 'recent-self');
});
ok('30 分钟冷却内不触发', () => {
  const d = shouldEchoWake({ ...baseArgs, state: { day: '2026-11-08', n: 1, lastAt: nowXiaTou - 10 * 60 * 1000 } });
  eq(d.ok, false); eq(d.reason, 'cooldown');
});
ok('冷却外（31 分钟前）可触发，n 累加', () => {
  const d = shouldEchoWake({ ...baseArgs, state: { day: '2026-11-08', n: 1, lastAt: nowXiaTou - 31 * 60 * 1000 } });
  eq(d.ok, true); eq(d.next.n, 2);
});
ok('当天已 3 次 → 日上限不触发', () => {
  const d = shouldEchoWake({ ...baseArgs, state: { day: '2026-11-08', n: 3, lastAt: nowXiaTou - 31 * 60 * 1000 } });
  eq(d.ok, false); eq(d.reason, 'daily-cap');
});
ok('跨天重置：昨天 n=3 不影响今天', () => {
  const d = shouldEchoWake({ ...baseArgs, state: { day: '2026-11-07', n: 3, lastAt: nowXiaTou - 31 * 60 * 1000 } });
  eq(d.ok, true); eq(d.next.n, 1);
});
ok('概率没中不触发（0.9 > 0.35）', () => {
  const d = shouldEchoWake({ ...baseArgs, random: 0.9 });
  eq(d.ok, false); eq(d.reason, 'probability');
});
ok('enabled=false 全关', () => {
  const d = shouldEchoWake({ ...baseArgs, opts: { enabled: false } });
  eq(d.ok, false); eq(d.reason, 'disabled');
});
ok('默认参数：0.35 / 30 分钟 / 每天 3 次 / 夜间 22:30-08:00', () => {
  eq(ECHO_WAKE_DEFAULTS.probability, 0.35);
  eq(ECHO_WAKE_DEFAULTS.cooldownMs, 30 * 60 * 1000);
  eq(ECHO_WAKE_DEFAULTS.dailyMax, 3);
  eq(ECHO_WAKE_DEFAULTS.nightStart, 22 * 60 + 30);
  eq(ECHO_WAKE_DEFAULTS.nightEnd, 8 * 60);
});

console.log('—— 辅助 ——');
ok('echoDayKey 上海日界', () => eq(echoDayKey(t('00:10')), '2026-11-08'));
ok('lastSelfAt 取最近一条 her 消息', () => {
  eq(lastSelfAt([...xiaTou, { text: 'x', isSelf: true, time: t('18:41:00') }]), t('18:41:00'));
});

console.log(`\n${pass} 项通过${process.exitCode ? '，有失败' : '，全部通过 ✅'}`);
