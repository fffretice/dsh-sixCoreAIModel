// patience 模型单测（task-41 Phase 1，纯函数，不接生产）
import {
  CURRENT, PROPOSED, askedDrain, currentTick, proposedTick,
  pushCountValue, pushCountWithBaseline, currentAskTrigger, extendedAskTrigger, filterByCooldown, stats,
} from '../src/mood-patience-model.js';

let pass = 0;
const ok = (name, fn) => { try { fn(); pass += 1; console.log(`PASS ${name}`); } catch (e) { console.error(`FAIL ${name}\n     ${e?.message ?? e}`); process.exitCode = 1; } };
const eq = (a, b, m) => { if (Math.abs(Number(a) - Number(b)) > 1e-9) throw new Error(`${m || 'eq'}: ${a} !== ${b}`); };

console.log('—— drain 与 tick ——');
ok('askedDrain(0.05,0.85)≈0.0105', () => eq(askedDrain(0.05, 0.85), 0.0105));
ok('askedDrain(0.10,0.85)≈0.021', () => eq(askedDrain(0.10, 0.85), 0.021));
ok('currentTick 1h 从 0.5 回满 cap 0.85（复现恒定）', () => eq(currentTick(0.5, { dtH: 1, idleAskH: 0.1 }), 0.85));
ok('currentTick 无事件 24h 仍 0.85', () => eq(currentTick(0.85, { dtH: 24, idleAskH: 0.1 }), 0.85));
ok('proposedTick 软回中位：0.4 →(1h)≈0.508', () => eq(proposedTick(0.4, { dtH: 1, idleAskH: 0.1 }), 0.508));
ok('proposedTick 无硬 cap：0.85 → 0.823（不会钉 0.85）', () => eq(proposedTick(0.85, { dtH: 1, idleAskH: 0.1 }), Number(((0.76 - 0.85) * 0.3 + 0.85).toFixed(6))));
ok('proposedTick 闲置>2h 目标 0.72', () => { const p = proposedTick(0.85, { dtH: 1, idleAskH: 3 }); eq(p, 0.85 + (0.72 - 0.85) * 0.3); });

console.log('—— pushCount ——');
ok('currentFormula 在 p=0.85/e=0.7 恒 0', () => eq(pushCountValue(0.85, 0.7, 0.5), 0));
ok('currentFormula 在 p=0.5/e=0.6/jitter 0.9 → 1', () => eq(pushCountValue(0.5, 0.6, 0.9), 1));
ok('C1 基线 0.78 在 p=0.72/e=0.69/jitter 0.9 → 1', () => eq(pushCountWithBaseline(0.72, 0.69, 0.9, { baseline: 0.78 }), 1));

console.log('—— 触发放宽 / 冷却 ——');
ok('当前触发词只认 8 词', () => { eq(currentAskTrigger('帮我查一下'), 1); eq(currentAskTrigger('等会5:14发这张图'), 0); });
ok('扩展触发认「等会发图/找一下/试试看」，不认纯聊天', () => {
  eq(extendedAskTrigger('等会5:14的时候你往群里发这张图'), 1);
  eq(extendedAskTrigger('这个前几天你发过，再找找？'), 1);
  eq(extendedAskTrigger('今天天气不错，哈哈'), 0);
});
ok('3 分钟冷却：同会话只留第一条', () => {
  const evs = [{ key: 'g1', at: 0 }, { key: 'g1', at: 60000 }, { key: 'g1', at: 200000 }, { key: 'g2', at: 1000 }];
  const out = filterByCooldown(evs, 180000);
  eq(out.length, 3); eq(out[1].at, 200000); eq(out[2].key, 'g2');
});

console.log('—— 统计 ——');
ok('stats std/unique', () => { const s = stats([0.85, 0.85, 0.8]); eq(s.mean, 0.8333); if (!(s.std > 0.02)) throw new Error('std'); eq(s.unique, 2); });

console.log(`\n${pass} 项通过${process.exitCode ? '，有失败' : '，全部通过 ✅'}`);
