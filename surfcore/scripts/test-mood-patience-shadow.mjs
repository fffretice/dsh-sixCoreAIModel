// patience Phase2 shadow 模块单测（task-41）
import { GROUP_PARAMS, SHADOW_THRESHOLDS, readShadowMode, createShadowState, shadowAskEvents, shadowTick, flipPatienceTick, summarizeShadow, selectShadowGroup } from '../src/mood-patience-shadow.js';

let pass = 0;
const ok = (name, fn) => { try { fn(); pass += 1; console.log(`PASS ${name}`); } catch (e) { console.error(`FAIL ${name}\n     ${e?.message ?? e}`); process.exitCode = 1; } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || 'eq'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
const assert = (c, m) => { if (!c) throw new Error(m || 'assert'); };
const rng = () => 0.99; // 稳定 jitter → push 公式可预测

console.log('—— config/mode ——');
ok('默认 off（不写 shadow）', () => eq(readShadowMode({}).mode, 'off'));
ok('cfg shadow 开启，两组参数覆盖生效', () => {
  const r = readShadowMode({ socialV2: { moodPatience: { mode: 'shadow', groups: { main: { drainWeight: 0.2 }, alt: {} } } } });
  eq(r.mode, 'shadow'); eq(r.groups.main.drainWeight, 0.2); eq(r.groups.main.baseTarget, 0.76); eq(r.groups.alt.baseTarget, 0.72);
});
ok('on 也按 shadow 处理（兼容旧写法）', () => eq(readShadowMode({ socialV2: { moodPatience: { mode: 'on' } } }).mode, 'shadow'));

console.log('—— 事件分流/冷却 ——');
ok('当前触发只扣旧模型；扩展触发扣两组新模型', () => {
  let s = createShadowState({ at: 0, patience: 0.85 });
  const a = shadowAskEvents(s, { at: 1000, events: [{ key: 'g1', text: '帮我查一下' }], groups: GROUP_PARAMS });
  s = a.state;
  assert(a.records[0].drained.old > 0, 'old drain');
  assert(a.records[0].drained.main > 0, 'main drain');
  assert(a.records[0].drained.alt > 0, 'alt drain');
  assert(a.records[0].triggers.current === true && a.records[0].triggers.extended === true);
});
ok('纯聊天不扣任何模型', () => {
  const a = shadowAskEvents(createShadowState({ at: 0 }), { at: 1000, events: [{ key: 'g1', text: '今天天气不错哈哈' }] });
  eq(a.records[0].drained, { old: 0, main: 0, alt: 0 });
});
ok('同会话 3 分钟内扩展触发只扣一次（旧模型无冷却）', () => {
  let s = createShadowState({ at: 0, patience: 0.85 });
  s = shadowAskEvents(s, { at: 1000, events: [{ key: 'g1', text: '帮我查一下' }] }).state;
  const before = s.groups.main.patience;
  const b = shadowAskEvents(s, { at: 60000, events: [{ key: 'g1', text: '帮我查一下' }] });
  eq(b.records[0].drained.main, 0); eq(b.state.groups.main.patience, before);
});
ok('不同会话不受同一冷却影响', () => {
  let s = createShadowState({ at: 0 });
  s = shadowAskEvents(s, { at: 1000, events: [{ key: 'g1', text: '帮我查一下' }] }).state;
  const c = shadowAskEvents(s, { at: 60000, events: [{ key: 'g2', text: '帮我查一下' }] });
  assert(c.records[0].drained.main > 0);
});

console.log('—— tick / 记录结构 ——');
ok('无事件：旧模型保持 0.85，新模型软回中位；记录可 JSON 序列化', () => {
  let s = createShadowState({ at: 0, patience: 0.85 });
  let rec;
  for (let i = 1; i <= 24; i++) { const r = shadowTick(s, { at: i * 3600000, realPatience: 0.85, energy: 0.6, rng }); s = r.state; rec = r.record; }
  eq(rec.old.patience, 0.85);
  // 24h 无事件 → idleAskH>2h，两组都软回 idleTarget 0.72
  assert(Math.abs(rec.groups.main.patience - 0.72) < 0.01, 'main idle→0.72');
  assert(Math.abs(rec.groups.alt.patience - 0.72) < 0.01, 'alt idle→0.72');
  assert(rec.groups.main.patience < 0.85, '未钉上限');
  assert(typeof rec.groups.main.pushProb === 'number');
  JSON.stringify(rec); // 不抛
});
ok('旧模型 pushProb 用原公式，新模型用 C1 基线', () => {
  const s = createShadowState({ at: 0, patience: 0.85 });
  const rec = shadowTick(s, { at: 3600000, realPatience: 0.85, energy: 0.6, rng }).record;
  eq(rec.old.pushBase, 0); // (0.55-0.85)*6=-1.8 → 0
  const s2 = createShadowState({ at: 0, patience: 0.72 });
  const rec2 = shadowTick(s2, { at: 3600000, realPatience: 0.72, energy: 0.6, rng }).record;
  eq(rec2.groups.main.pushBase, 0); // (0.78-0.72)*6=0.36 → round 0；但 jitter 0.99 时 pushProb>0
  assert(rec2.groups.main.pushProb > 0);
});

console.log('—— 24h 验收统计 ——');
ok('summarizeShadow 能判 std/unique/push', () => {
  const ticks = [0.6, 0.7, 0.8].map((p, i) => ({ t: 'tick', at: new Date(i * 3600000).toISOString(), real: { patience: 0.85 }, old: { patience: 0.85, pushProb: 0 }, groups: { main: { patience: p, pushProb: 0.3 }, alt: { patience: p - 0.02, pushProb: 0.2 } } }));
  const s = summarizeShadow(ticks);
  eq(s.byGroup.main.unique, 3); assert(s.byGroup.main.std > 0.02); assert(s.pass.mainPush);
  eq(s.byGroup.old.std, 0);
});
ok('空记录不炸', () => { const s = summarizeShadow([]); eq(s.ticks, 0); eq(s.pass.mainStd, false); });

console.log('—— flip 组（task-45 稳态版） ——');
ok('flip：刚被要求后 target 0.72，安静>2h target 0.80（target 翻转）', () => {
  const justAsked = shadowTick(createShadowState({ at: 0, patience: 0.72, groups: { flip: {} } }), { at: 3600000, realPatience: 0.72, energy: 0.6, groups: { flip: GROUP_PARAMS.flip }, rng });
  // 无事件时 idle>2h，应向 0.80 升；有事件时（lastAskAt 设为 1h 前）应向 0.72 回
  assert(justAsked.record.groups.flip.patience > 0.72, 'idle→0.80');
  let s = createShadowState({ at: 0, patience: 0.8, groups: { flip: {} } });
  s = shadowAskEvents(s, { at: 0, events: [{ key: 'g1', text: '帮我查一下', private: true }], groups: { flip: GROUP_PARAMS.flip } }).state;
  const r = shadowTick(s, { at: 3600000, realPatience: 0.8, energy: 0.6, groups: { flip: GROUP_PARAMS.flip }, rng });
  assert(r.record.groups.flip.patience < 0.8, 'just asked→0.72');
});
ok('flip：softcap 0.85 + hardPush（可越界后回落，不硬夹）', () => {
  const t = flipPatienceTick(0.99, { dtH: 1, idleAskH: 0.1 }, GROUP_PARAMS.flip);
  assert(t > 0.85 && t < 0.99, 'softcap decay not hard clamp');
});
ok('flip：gated 触发需要上下文（私聊/@她/她刚说过）', () => {
  const evs = [{ key: 'g1', text: '帮我查一下', private: false, atHer: false }, { key: 'g1', text: '帮我查一下', private: true }];
  const a = shadowAskEvents(createShadowState({ at: 0, groups: { flip: {} } }), { at: 1000, events: [evs[0]], groups: { flip: GROUP_PARAMS.flip } });
  eq(a.records[0].drained.flip, 0); // 无上下文不扣
  const b = shadowAskEvents(createShadowState({ at: 0, groups: { flip: {} } }), { at: 1000, events: [evs[1]], groups: { flip: GROUP_PARAMS.flip } });
  assert(b.records[0].drained.flip > 0, 'private drains');
});
ok('flip：全局 5min 限速（跨会话）', () => {
  let s = createShadowState({ at: 0, groups: { flip: {} } });
  s = shadowAskEvents(s, { at: 1000, events: [{ key: 'g1', text: '帮我查一下', private: true }], groups: { flip: GROUP_PARAMS.flip } }).state;
  const b = shadowAskEvents(s, { at: 1000 + 60 * 1000, events: [{ key: 'g2', text: '帮我查一下', private: true }], groups: { flip: GROUP_PARAMS.flip } });
  eq(b.records[0].drained.flip, 0);
  const c = shadowAskEvents(s, { at: 1000 + 6 * 60 * 1000, events: [{ key: 'g2', text: '帮我查一下', private: true }], groups: { flip: GROUP_PARAMS.flip } });
  assert(c.records[0].drained.flip > 0, 'after 5min drains');
});
ok('config 三选二：groups 指定 main+flip 时只初始化两组', () => {
  const sm = readShadowMode({ socialV2: { moodPatience: { mode: 'shadow', groups: { main: {}, flip: {} } } } });
  eq(sm.groupIds, ['main', 'flip']);
  const st = createShadowState({ at: 0, groups: sm.groups });
  eq(Object.keys(st.groups), ['main', 'flip']);
});
ok('summarizeShadow 有事件日：静默日不拉低 std/不算失败', () => {
  const ticks = [];
  // 造 2 个本地日：day1 有 6 个 ask 事件 + 6 个 tick，day2 无事件 + 6 个 tick
  for (let i = 0; i < 6; i++) ticks.push({ t: 'tick', at: new Date(Date.parse('2026-11-09T03:00:00Z') + i * 3600000).toISOString(), real: { patience: 0.85 }, old: { patience: 0.85, pushProb: 0 }, groups: { main: { patience: 0.6 + i * 0.04, pushProb: 0.3 } } });
  for (let i = 0; i < 6; i++) ticks.push({ t: 'tick', at: new Date(Date.parse('2026-11-09T15:00:00Z') + i * 3600000).toISOString(), real: { patience: 0.85 }, old: { patience: 0.85, pushProb: 0 }, groups: { main: { patience: 0.80, pushProb: 0.1 } } });
  const asks = Array.from({ length: 6 }, (_, i) => ({ t: 'ask', at: new Date(Date.parse('2026-11-09T03:00:00Z') + i * 60000).toISOString(), drained: { main: 0.01 } }));
  const st = summarizeShadow([...asks, ...ticks], { activeDayMinEvents: 6 });
  eq(st.activeDays.length, 1);
  assert(st.byGroup.main.std > 0.02, 'active day std');
  eq(st.insufficient, false);
});
ok('summarizeShadow 无事件日 → insufficient（不判失败）', () => {
  const ticks = [{ t: 'tick', at: new Date().toISOString(), real: { patience: 0.85 }, old: { patience: 0.85, pushProb: 0 }, groups: { main: { patience: 0.72, pushProb: 0.2 } } }];
  const st = summarizeShadow(ticks, { activeDayMinEvents: 6 });
  eq(st.insufficient, false); // 无 ask 记录时按旧口径全算（兼容离线）
  const st2 = summarizeShadow([...ticks, { t: 'ask', at: new Date().toISOString(), drained: { main: 0.01 } }], { activeDayMinEvents: 6 });
  eq(st2.insufficient, true);
  eq(st2.pass.mainStd, false);
});

console.log('—— 选组规则 ——');
const passG = (std, unique, push) => ({ std, unique, pushProbMean: push, mean: 0.7 });
ok('main 过 → 选 main', () => {
  const r = selectShadowGroup({ byGroup: { main: passG(0.03, 5, 0.3), alt: passG(0.02, 4, 0.12), old: passG(0, 1, 0) } });
  eq(r.selected, 'main'); eq(r.reason, 'multi-pass-prefer-main');
});
ok('只有 alt 过 → 选 alt', () => {
  const r = selectShadowGroup({ byGroup: { main: passG(0.01, 5, 0.3), alt: passG(0.03, 4, 0.2), old: passG(0, 1, 0) } });
  eq(r.selected, 'alt'); eq(r.reason, 'alt-pass');
});
ok('都不过 → 不切，保留 shadow', () => {
  const r = selectShadowGroup({ byGroup: { main: passG(0.01, 2, 0.05), alt: passG(0.019, 3, 0.09), old: passG(0, 1, 0) } });
  eq(r.selected, null); eq(r.reason, 'none-pass-keep-shadow');
});
ok('阈值来自 SHADOW_THRESHOLDS（std 0.02/unique 3/push 0.10）', () => {
  eq(SHADOW_THRESHOLDS, { stdMin: 0.02, uniqueMin: 3, pushMin: 0.10 });
  // 边界：std=0.02 恰过、push=0.10 不过（要求 >0.10）
  const r = selectShadowGroup({ byGroup: { main: passG(0.02, 3, 0.10), alt: passG(0, 1, 0) } });
  eq(r.groups.main.passStd, true); eq(r.groups.main.passPush, false);
  eq(r.selected, null);
});

console.log(`\n${pass} 项通过${process.exitCode ? '，有失败' : '，全部通过 ✅'}`);
