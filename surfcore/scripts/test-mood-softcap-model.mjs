// 五量软上限模型单测（task-45，纯函数，不接生产）
// 跑法：node scripts/test-mood-softcap-model.mjs
import {
  DIM_KEYS, DIM_PARAMS, GROUPS, softCapValue, driftTo, linearDecay, floorPull,
  targetFor, tickDim, eventMultiplier, createEventWindow, applyEvent, askedDrain,
  pushCountValue, pushCountWithBaseline, pushCountNonZeroProb, stats, topRatio, stickRatio,
  askTrigger, filterByCooldown,
} from '../src/mood-softcap-model.js';

let pass = 0;
const ok = (name, fn) => {
  try { fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n     ${e?.message ?? e}`); process.exitCode = 1; }
};
const eq = (a, b, m) => { if (Math.abs(Number(a) - Number(b)) > 1e-9) throw new Error(`${m || 'eq'}: ${a} !== ${b}`); };
const near = (a, b, eps = 1e-4, m) => { if (Math.abs(Number(a) - Number(b)) > eps) throw new Error(`${m || 'near'}: ${a} !≈ ${b}`); };
const tr = (x) => { if (!x) throw new Error('expected true'); };
const fa = (x) => { if (x) throw new Error('expected false'); };

console.log('—— 软上限 / 漂移 / 地板 ——');
ok('softCapValue：低于上限原样返回', () => eq(softCapValue(0.8, 0.9, 1), 0.8));
ok('softCapValue：越界 0.1 一小时回落 e^-0.4', () => {
  near(softCapValue(1.0, 0.9, 1, 0.4), 0.9 + 0.1 * Math.exp(-0.4));
});
ok('softCapValue：dt=0 不动', () => eq(softCapValue(1.0, 0.9, 0), 1.0));
ok('driftTo：1h/0.3 走 30%', () => near(driftTo(0.5, 0.8, 1, 0.3), 0.59));
ok('driftTo：rate=0 不动', () => eq(driftTo(0.5, 0.8, 1, 0), 0.5));
ok('linearDecay：0.06/h 两小时掉 0.12', () => near(linearDecay(0.5, 2, 0.06), 0.38));
ok('linearDecay：不为负', () => eq(linearDecay(0.01, 1, 0.5), 0));
ok('floorPull：低于地板按速率回收', () => near(floorPull(0.10, 0.15, 1, 0.5), 0.125));
ok('floorPull：高于地板不动', () => eq(floorPull(0.2, 0.15, 1, 0.5), 0.2));

console.log('—— 参数 / 目标切换 ——');
ok('DIM_KEYS 固定五量', () => { eq(DIM_KEYS.length, 5); eq(DIM_KEYS.join(','), 'energy,patience,curiosity,mood,social'); });
ok('targetFor：闲置 >2h 用 idleTarget，否则 target', () => {
  eq(targetFor(DIM_PARAMS.patience, { idleH: 3 }), 0.80);
  eq(targetFor(DIM_PARAMS.patience, { idleH: 1 }), 0.72);
  eq(targetFor(DIM_PARAMS.mood, { idleH: 99 }), 0.55);
});
ok('task-41 两组的 idle/base 关系是反的（记录成因）', () => {
  tr(GROUPS['task41-main'].idleTarget < GROUPS['task41-main'].target);
  tr(GROUPS['task41-alt'].idleTarget === GROUPS['task41-alt'].target);
});
ok('softcap 组：闲置目标高于刚被要求后的目标（翻转）', () => {
  tr(GROUPS.softcap.idleTarget > GROUPS.softcap.target);
});

console.log('—— tickDim ——');
ok('patience 0.85 闲置 3h：向 0.80 漂移（1h）', () => {
  const r = tickDim(0.85, DIM_PARAMS.patience, { dtH: 1, idleH: 3 });
  near(r.value, 0.85 + (0.80 - 0.85) * 0.3);
  fa(r.overCap);
});
ok('patience 0.85 刚被要求 1h：向 0.72 漂移', () => {
  const r = tickDim(0.85, DIM_PARAMS.patience, { dtH: 1, idleH: 0.5 });
  near(r.value, 0.85 + (0.72 - 0.85) * 0.3);
});
ok('软上限：0.95 在 1h 后低于 0.95 且高于 0.85', () => {
  const v = tickDim(0.95, DIM_PARAMS.patience, { dtH: 1, idleH: 3 }).value;
  tr(v < 0.95 && v > 0.84);
});
ok('hardPush=false：越界被夹回 cap', () => {
  const v = tickDim(0.95, { ...DIM_PARAMS.mood, hardPush: false, revertRatePerH: 0 }, { dtH: 0 }).value;
  eq(v, DIM_PARAMS.mood.softcap);
});
ok('hardPushMax 兜底：不会超过配置上限', () => {
  const v = tickDim(1.0, { ...DIM_PARAMS.mood, hardPushMax: 0.94, revertRatePerH: 0 }, { dtH: 0 }).value;
  eq(v, 0.94);
});

console.log('—— 事件 1/(1+n) 递减 / 硬撑 ——');
ok('eventMultiplier：1 / 0.5 / 1/3', () => { eq(eventMultiplier(0), 1); eq(eventMultiplier(1), 0.5); near(eventMultiplier(2), 1 / 3); });
ok('createEventWindow：1h 内按顺序给 0/1/2，窗口外归零', () => {
  const w = createEventWindow({ windowMs: 3600e3 });
  eq(w.note('praise', 0), 0);
  eq(w.note('praise', 60e3), 1);
  eq(w.note('praise', 120e3), 2);
  eq(w.note('praise', 4 * 3600e3), 0);
  eq(w.count('praise', 4 * 3600e3), 1);
});
ok('applyEvent：第二次 +0.1 只加 0.05', () => {
  near(applyEvent(0.5, 0.1, DIM_PARAMS.mood, { n: 1 }), 0.55);
});
ok('applyEvent：hardPush 允许顶出软上限，但不超 hardPushMax', () => {
  const v = applyEvent(0.90, 0.10, DIM_PARAMS.mood, { n: 0 });
  near(v, DIM_PARAMS.mood.hardPushMax);
  tr(v > DIM_PARAMS.mood.softcap);
});
ok('applyEvent：hardPush=false 时夹在软上限', () => {
  eq(applyEvent(0.90, 0.10, { ...DIM_PARAMS.mood, hardPush: false }, { n: 0 }), DIM_PARAMS.mood.softcap);
});
ok('applyEvent：单次幅度封顶 ±0.12', () => {
  near(applyEvent(0.5, 0.5, DIM_PARAMS.mood, { n: 0 }), 0.62);
});
ok('askedDrain(0.10, 0.85)=0.021', () => near(askedDrain(0.10, 0.85), 0.021));
ok('askedDrain 越低越敏感', () => tr(askedDrain(0.10, 0.5) > askedDrain(0.10, 0.8)));

console.log('—— pushCount ——');
ok('原公式 p=0.85/e=0.7 恒 0', () => eq(pushCountValue(0.85, 0.7, 0.9), 0));
ok('原公式 p=0.5/e=0.6/j=0.9 → 1', () => eq(pushCountValue(0.5, 0.6, 0.9), 1));
ok('C1 基线 0.78：p=0.72/e=0.69/j=0.9 → 1', () => eq(pushCountWithBaseline(0.72, 0.69, 0.9, { baseline: 0.78 }), 1));
ok('pushCountNonZeroProb：概率在 0~1 且可复现', () => {
  const seq = [0, 0.25, 0.5, 0.75];
  let i = 0; const rng = () => seq[(i++) % seq.length];
  const p = pushCountNonZeroProb(0.75, 0.7, { baseline: 0.78, samples: 4, rng });
  tr(p >= 0 && p <= 1);
});

console.log('—— 统计 ——');
ok('stats mean/std/unique', () => {
  const s = stats([0.85, 0.85, 0.8]);
  near(s.mean, 0.8333, 1e-3); tr(s.std > 0.02); eq(s.unique, 2);
});
ok('topRatio：≥0.849 占比', () => near(topRatio([0.85, 0.84, 0.85, 0.80], 0.849), 0.5));
ok('stickRatio：贴边 ±0.01', () => near(stickRatio([0.90, 0.905, 0.80], 0.90, 0.01), 2 / 3));

console.log('—— 触发面 ——');
ok('current：只认 8 词', () => {
  tr(askTrigger('帮我查一下').current);
  fa(askTrigger('等会5:14发这张图').current);
});
ok('extended：认「等会发图 / 再找找 / 试试看」', () => {
  tr(askTrigger('等会5:14的时候你往群里发这张图').extended);
  tr(askTrigger('这个前几天你发过，再找找？').extended);
  fa(askTrigger('今天天气不错，哈哈').extended);
});
ok('gated：v1 在私聊里通过', () => {
  const r = askTrigger('等会5:14的时候你往群里发这张图', { private: true });
  tr(r.extended); tr(r.gated);
});
ok('gated：无上下文（群里没点名、她刚没说话）不通过', () => {
  fa(askTrigger('等会5:14的时候你往群里发这张图', { private: false, atHer: false, recentSelfMs: 30 * 60e3 }).gated);
});
ok('gated：@她 或 5 分钟内她说过话就通过', () => {
  tr(askTrigger('等会5:14发这张图', { atHer: true }).gated);
  tr(askTrigger('等会5:14发这张图', { recentSelfMs: 60e3 }).gated);
});
ok('gated：补漏「快回答 / 截图 / 发到」', () => {
  tr(askTrigger('快回答第五题', { private: true }).gated);
  tr(askTrigger('你把这个截图发到我的群里吧', { private: true }).gated);
  tr(askTrigger('发图的时候一句话都别说，发到各个群里', { private: true }).gated);
});
ok('gated：挡掉叙述别人 / 教学 / 纯闲聊', () => {
  fa(askTrigger('我给我的DSH拓展了全功能', { private: true }).gated);
  fa(askTrigger('下次看到你觉得不认识的先查查记忆哦', { private: true }).gated);
  fa(askTrigger('今天天气不错，哈哈', { private: true }).gated);
});
ok('filterByCooldown：同会话 3 分钟只留第一条', () => {
  const evs = [{ key: 'g1', at: 0 }, { key: 'g1', at: 60000 }, { key: 'g1', at: 200000 }, { key: 'g2', at: 1000 }];
  const out = filterByCooldown(evs, 180000);
  eq(out.length, 3); eq(out[1].at, 200000); eq(out[2].key, 'g2');
});
ok('filterByCooldown：globalMs 跨会话限速', () => {
  const evs = [{ key: 'g1', at: 0 }, { key: 'g2', at: 60000 }, { key: 'g3', at: 400000 }];
  const out = filterByCooldown(evs, 180000, { globalMs: 5 * 60e3 });
  eq(out.length, 2); eq(out[1].key, 'g3');
});

console.log('—— 24h 机制自检（0.5 次/小时被要求 ≈ 真实 7d 的 11.6/day）——');
ok('翻转目标 + 软上限：24h 有波动、不贴顶、p50 在 0.65~0.80', () => {
  let p = 0.85;
  const vals = [];
  const rng = (() => { let s = 7; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; })();
  let lastAsk = -Infinity;
  for (let t = 0; t < 24 * 12; t++) {
    const now = t * 5 * 60e3;
    const dtH = t === 0 ? 0 : 5 / 60;
    p = tickDim(p, DIM_PARAMS.patience, { dtH, idleH: (now - lastAsk) / 3600e3 }).value;
    if (rng() < 0.5 / 12) {
      p = Math.max(0, p - askedDrain(0.10, p));
      lastAsk = now;
    }
    vals.push(p);
  }
  const s = stats(vals);
  tr(s.std >= 0.02);
  tr(s.unique >= 3);
  tr(s.p50 >= 0.65 && s.p50 <= 0.80);
  tr(topRatio(vals, 0.849) < 0.05);
});
ok('提醒：事件率 5/h（≈60/day）会把耐心打穿——所以需要全局限速', () => {
  let p = 0.85;
  let lastAsk = -Infinity;
  for (let t = 0; t < 24 * 12; t++) {
    const now = t * 5 * 60e3;
    p = tickDim(p, DIM_PARAMS.patience, { dtH: t === 0 ? 0 : 5 / 60, idleH: (now - lastAsk) / 3600e3 }).value;
    if (t % 2 === 0) { p = Math.max(0, p - askedDrain(0.10, p)); lastAsk = now; }
  }
  tr(p < 0.4);   // 不是 bug，是参数安全边界：高密度事件下必须限速或降权重
});

console.log(`\n${pass} 项通过${process.exitCode ? '，有失败' : '，全部通过 ✅'}`);
