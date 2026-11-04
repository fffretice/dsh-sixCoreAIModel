// 2026-11-03 三件省钱改动的回归测试：
//   1) 额度分配：池子用完后上限不再跟着 used 涨（今天 92→200 的那个漏洞）
//   2) 黑话预筛：普通聊天窗口不该再起 LLM 回合
//   3) 因果核心的时间统计：夜里/高峰开口的回应率，样本不够不说
//
// 跑：node scripts/test-quota-and-night.mjs
import assert from 'node:assert/strict';
import { computeQuotaCaps, carryQuotaCaps, quietHoursBlocks, inQuietWindow } from '../src/token-guard.js';
import { screenSlangWindow } from '../src/slang-learner.js';
import { emptyState, timeStatLine } from '../src/causal-core.js';

let n = 0;
const ok = (msg) => { n += 1; console.log(`✅ ${msg}`); };

// ── 1. 额度分配 ─────────────────────────────────────────────
{
  const groups = ['a', 'b', 'c'];
  const baseCaps = { a: 92, b: 91, c: 7 };
  const pool = 190;

  // 池子已经用超：上限必须钉在基准，不能变成「已用次数」
  const over = computeQuotaCaps({ groups, used: { a: 200, b: 77, c: 7 }, baseCaps, pool });
  assert.equal(over.caps.a, 92, '用超后 a 的上限应该回到 92，而不是 200');
  assert.equal(over.caps.b, 91);
  assert.equal(over.caps.c, 7);
  assert.equal(over.each, 0);
  ok('池子用超时上限等于基准，不随 used 膨胀');

  // 还没用：剩余额度平均分下去
  const fresh = computeQuotaCaps({ groups, used: { a: 0, b: 0, c: 0 }, baseCaps, pool });
  assert.equal(fresh.caps.a + fresh.caps.b + fresh.caps.c, pool);
  ok('没用时把剩余额度平均分完（合计等于池子）');

  // 部分用了：cap 仍然是基准（已经用超 92 的 a 会被拦），总 cap 不超过池子
  const half = computeQuotaCaps({ groups, used: { a: 100, b: 20, c: 7 }, baseCaps, pool });
  assert.equal(half.caps.a, 92, '用超基准后 cap 回到 92，检查会按 100/92 拦下');
  assert.ok(half.caps.a + half.caps.b + half.caps.c <= pool, '总 cap 不超过池子');
  ok('部分使用后 cap 回到基准，总 cap 不超池');

  // 跨天沿用：昨天被抬到 200/77/7（合计 284 > 190）说明是异常，直接回默认值
  const carried = carryQuotaCaps({
    groups,
    prevCaps: { a: 200, b: 77, c: 7 },
    defaultCaps: baseCaps,
    pool,
  });
  assert.deepEqual(carried, baseCaps, '超池的旧分配不能带进今天');
  ok('跨天时超池的旧分配直接回默认（92/91/7）');

  // 昨天在池内：原样沿用
  const carriedOk = carryQuotaCaps({
    groups,
    prevCaps: { a: 100, b: 80, c: 7 },
    defaultCaps: baseCaps,
    pool,
  });
  assert.deepEqual(carriedOk, { a: 100, b: 80, c: 7 });
  ok('跨天时正常的旧分配原样沿用');

  // 没有历史时用默认值
  const noHistory = carryQuotaCaps({ groups, prevCaps: {}, defaultCaps: baseCaps, pool });
  assert.deepEqual(noHistory, baseCaps);
  ok('没有历史分配时回落默认上限');
}

// ── 1.5 夜间静默 ────────────────────────────────────────────
{
  const at = (h) => new Date(2026, 10, 4, h, 30, 0).getTime(); // 2026-11-04 周三
  const base = { allow: ['atMention'], enabled: true, start: 1, end: 7 };

  assert.equal(inQuietWindow(at(2), { start: 1, end: 7 }), true);
  assert.equal(inQuietWindow(at(22), { start: 1, end: 7 }), false);
  assert.equal(inQuietWindow(at(23), { start: 23, end: 7 }), true);
  assert.equal(inQuietWindow(at(6), { start: 23, end: 7 }), true);
  ok('静默窗口判断正确（含跨午夜）');

  const g = 'group:1000000002';
  assert.equal(quietHoursBlocks({ key: g, reason: 'atMention', now: at(2), ...base }), false);
  ok('深夜被 @ 照样醒');
  assert.equal(quietHoursBlocks({ key: g, reason: 'probability', now: at(2), ...base }), true);
  assert.equal(quietHoursBlocks({ key: g, reason: 'keyword:招牌词', now: at(2), ...base }), true);
  assert.equal(quietHoursBlocks({ key: g, reason: 'admin', now: at(2), ...base }), true);
  ok('深夜的概率/关键词/补唤醒被拦');
  assert.equal(quietHoursBlocks({ key: g, reason: 'probability', now: at(15), ...base }), false);
  ok('白天不拦');
  assert.equal(quietHoursBlocks({ key: 'private:1000000001', reason: 'probability', now: at(2), ...base }), false);
  ok('私聊不受夜间静默影响');
  assert.equal(quietHoursBlocks({ key: g, reason: 'diary', now: at(2), ...base }), false);
  ok('她自己的日记/叙事照常');
  assert.equal(quietHoursBlocks({ ...base, key: g, reason: 'probability', now: at(2), enabled: false }), false);
  ok('配置关掉就完全不拦');
}

// ── 2. 黑话预筛 ─────────────────────────────────────────────
{
  const boring = [
    { sender: '甲', text: '今天天气还行' },
    { sender: '乙', text: '嗯 吃过饭了' },
    { sender: '甲', text: '下午去打游戏' },
    { sender: '乙', text: '好' },
    { sender: '甲', text: '[图片]' },
    { sender: '乙', text: '我也去' },
    { sender: '甲', text: '几点' },
    { sender: '乙', text: '八点吧' },
    { sender: '甲', text: '行' },
    { sender: '乙', text: '那说好了' },
  ];
  assert.equal(screenSlangWindow(boring, { known: [] }).worth, false);
  ok('普通聊天窗口被预筛拦住');

  const slangy = [
    { sender: '甲', text: '这也太抽象了' },
    { sender: '乙', text: '真的抽象 我绷不住了' },
    { sender: '甲', text: '我听不懂你在说什么' },
    { sender: '乙', text: '草 又被你抽象到了' },
    { sender: '甲', text: '哈哈哈哈' },
    { sender: '乙', text: '这波属于是抽象到家' },
    { sender: '甲', text: '你懂什么叫抽象' },
    { sender: '乙', text: '不懂 但大受震撼' },
    { sender: '甲', text: '笑死' },
    { sender: '乙', text: '确实抽象' },
  ];
  const r = screenSlangWindow(slangy, { known: [] });
  assert.equal(r.worth, true);
  assert.ok(r.sample.includes('抽象'), `应该把复现的「抽象」标出来，实得 ${JSON.stringify(r.sample)}`);
  ok('有重复新词时放行（抽象）');

  const acronym = [
    { sender: '甲', text: '这个 xswl 了吧' },
    { sender: '乙', text: '确实' },
    { sender: '甲', text: '你也太菜了' },
    { sender: '乙', text: '闭嘴' },
    { sender: '甲', text: '哼' },
    { sender: '乙', text: '看比赛去' },
    { sender: '甲', text: '好' },
    { sender: '乙', text: '走' },
    { sender: '甲', text: '等我一下我马上就到' },
    { sender: '乙', text: '快点快点' },
  ];
  assert.equal(screenSlangWindow(acronym, { known: [] }).worth, true);
  ok('拼音缩写形态会放行');

  const known = [{ content: '抽象' }];
  const knownOnly = slangy.map((m) => ({ ...m, text: m.text.replace(/抽象/g, '抽象') }));
  assert.equal(screenSlangWindow(knownOnly, { known }).worth, false);
  ok('已经是库里的词不会再触发学习');

  assert.equal(screenSlangWindow([], { known: [] }).worth, false);
  assert.equal(screenSlangWindow([{ sender: '甲', text: '哈哈' }], { known: [] }).worth, false);
  ok('空窗口/太短窗口直接拦');
}

// ── 3. 因果核心的时间统计 ────────────────────────────────────
{
  const st = emptyState();
  st.stats.byTime = {
    night: { n: 3, replied: 1 },
    day: { n: 10, replied: 5 },
    peak: { n: 9, replied: 4 },
    off: { n: 4, replied: 1 },
  };
  assert.equal(timeStatLine(st, { at: Date.now() }).line, '');
  ok('样本不够时不说（夜里 3 次、空闲 4 次）');

  const st2 = emptyState();
  st2.stats.byTime = {
    night: { n: 8, replied: 2 },
    day: { n: 30, replied: 18 },
    peak: { n: 20, replied: 11 },
    off: { n: 18, replied: 9 },
  };
  const first = timeStatLine(st2, { at: Date.now() });
  const line = first.line;
  assert.ok(line.includes('夜里开口 8 次'), line);
  assert.ok(line.includes('高峰时段开口 20 次'), line);
  assert.ok(!line.includes('应该'), '不能给指令，只报数字');
  ok('样本够时给夜里/高峰两组对比，且不带指令');

  const second = timeStatLine(first.state, { at: Date.now() });
  assert.equal(second.line, '');
  ok('同一天只注入一次（冷却记录在返回的 state 里）');
}

console.log(`\n🎉 额度 / 黑话预筛 / 时间统计 测试通过（${n} 项）`);
