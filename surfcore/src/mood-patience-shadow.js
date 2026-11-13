/**
 * patience Phase 2/2b shadow（task-41 + task-45 flip，2026-11-10）
 *
 * 纯函数：旧模型 + 配置的两组新模型并排（main/alt/flip 三选二），
 * 产出写 state/patience-shadow.jsonl 的记录；**不修改真实 mood、不修改 pushCount**。
 *
 * 组：
 *  - main/alt：task-41 v0.1 软回中位（base 0.76/idle 0.72、revert 0.30/0.20）
 *  - flip：task-45 稳态版（刚被要求 target 0.72，安静>2h target 0.80，softcap 0.85 + hardPush，
 *          revert 0.30/h，drain 0.10 / 180s / 全局 5min 限速，gated 触发，C1 push 0.78）
 */
import {
  CURRENT, PROPOSED, askedDrain, currentTick, proposedTick,
  pushCountValue, pushCountWithBaseline, currentAskTrigger, extendedAskTrigger,
} from './mood-patience-model.js';
import { askTrigger } from './mood-softcap-model.js';

export const GROUP_PARAMS = Object.freeze({
  main: Object.freeze({ baseTarget: 0.76, idleTarget: 0.72, revertRatePerH: 0.30, drainWeight: 0.10, cooldownMs: 180000, globalCooldownMs: 0, trigger: 'extended', pushBaseline: 0.78 }),
  alt: Object.freeze({ baseTarget: 0.72, idleTarget: 0.72, revertRatePerH: 0.20, drainWeight: 0.08, cooldownMs: 180000, globalCooldownMs: 0, trigger: 'extended', pushBaseline: 0.78 }),
  flip: Object.freeze({ baseTarget: 0.72, idleTarget: 0.80, revertRatePerH: 0.30, softcap: 0.85, capRatePerH: 0.40, hardPush: true, drainWeight: 0.10, cooldownMs: 180000, globalCooldownMs: 300000, trigger: 'gated', pushBaseline: 0.78 }),
});

const GROUP_IDS = Object.freeze(Object.keys(GROUP_PARAMS));
const DEFAULT_GROUP_IDS = Object.freeze(['main', 'alt']);
const DEFAULT_MODE = 'off';
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

/** 从 config 读 shadow 模式与「三选二」组；默认 off、默认 main+alt。 */
export function readShadowMode(cfg = {}) {
  const pc = cfg?.socialV2?.moodPatience;
  const raw = String(pc?.mode ?? DEFAULT_MODE).toLowerCase();
  const mode = raw === 'shadow' || raw === 'on' ? 'shadow' : 'off';
  const configured = pc?.groups && typeof pc.groups === 'object' ? Object.keys(pc.groups) : null;
  let ids = configured && configured.length ? configured.filter((id) => GROUP_IDS.includes(id)) : [...DEFAULT_GROUP_IDS];
  if (!ids.length || ids.length > 2) ids = [...DEFAULT_GROUP_IDS]; // 三选二；非法回退默认
  const groups = {};
  for (const id of ids) groups[id] = { ...GROUP_PARAMS[id], ...(pc?.groups?.[id] || {}) };
  return { mode, groupIds: ids, groups };
}

/** 初始化 shadow 状态（只初始化配置的两组）。 */
export function createShadowState({ at = Date.now(), patience = 0.85, groups = null } = {}) {
  const p = clamp01(patience);
  const ids = groups ? Object.keys(groups) : [...DEFAULT_GROUP_IDS];
  const mk = () => ({ patience: p, lastAskAt: -Infinity, lastGlobalDrainAt: -Infinity, lastDrainByKey: {} });
  const gs = {};
  for (const id of ids) gs[id] = mk();
  return { mode: 'shadow', lastAt: at, old: mk(), groups: gs };
}

function probePush(patience, energy, baseline, { rng = Math.random, samples = 8, mult = 6 } = {}) {
  const base = Math.max(0, Math.round((Number(baseline) - Number(patience)) * mult + (0.6 - Number(energy)) * 3));
  if (samples <= 0) return { pushBase: base, pushProb: base > 0 ? 1 : 0 };
  let n = 0;
  for (let i = 0; i < samples; i++) if (pushCountWithBaseline(patience, energy, rng(), { baseline, mult }) > 0) n += 1;
  return { pushBase: base, pushProb: +(n / samples).toFixed(3) };
}
function oldPush(patience, energy, opts) {
  const base = Math.max(0, Math.round((0.55 - Number(patience)) * 6 + (0.6 - Number(energy)) * 3));
  const { rng = Math.random, samples = 8 } = opts || {};
  let n = 0;
  for (let i = 0; i < samples; i++) if (pushCountValue(patience, energy, rng()) > 0) n += 1;
  return { pushBase: base, pushProb: +(n / samples).toFixed(3) };
}

/** flip tick：softcap 软上限（hardPush=true 可越界后回落）+ target 翻转（刚被要求 0.72 / 闲置 0.80）。 */
export function flipPatienceTick(patience, { dtH = 0, idleAskH = Infinity } = {}, gp = GROUP_PARAMS.flip) {
  let p = clamp01(patience);
  if (Number(p) > Number(gp.softcap)) {
    p = Number(gp.softcap) + (p - Number(gp.softcap)) * Math.exp(-Number(gp.capRatePerH || 0.4) * Math.max(0, Number(dtH) || 0));
  }
  const target = Number(idleAskH) > 2 ? Number(gp.idleTarget) : Number(gp.baseTarget);
  p = clamp01(p + (target - p) * Math.min(1, Number(gp.revertRatePerH) * Math.max(0, Number(dtH) || 0)));
  if (!gp.hardPush) p = Math.min(p, Number(gp.softcap));
  return clamp01(p);
}

/** 事件触发：旧模型 current；各组 gated 或 extended。 */
function groupTriggered(gp, ev) {
  const text = String(ev.text || '');
  if (gp.trigger === 'gated') {
    const r = askTrigger(text, { private: !!ev.private, atHer: ev.atHer ?? !!ev.isDirect, recentSelfMs: ev.recentSelfMs ?? Infinity });
    return !!r.gated;
  }
  return extendedAskTrigger(text);
}

/** 处理一批「对她说」的事件：旧模型 current 触发；新组按配置触发 + 冷却/全局限速。 */
export function shadowAskEvents(state, { at = Date.now(), events = [], groups = GROUP_PARAMS } = {}) {
  const s = { ...state, old: { ...state.old, lastDrainByKey: { ...state.old.lastDrainByKey } }, groups: {} };
  for (const id of Object.keys(state.groups)) s.groups[id] = { ...state.groups[id], lastDrainByKey: { ...state.groups[id].lastDrainByKey } };
  const records = [];
  for (const ev of Array.isArray(events) ? events : []) {
    const key = String(ev.key || '');
    const text = String(ev.text || '');
    const cur = currentAskTrigger(text);
    const recTriggers = { current: cur, extended: extendedAskTrigger(text), gated: !!askTrigger(text, { private: !!ev.private, atHer: ev.atHer ?? !!ev.isDirect, recentSelfMs: ev.recentSelfMs ?? Infinity }).gated };
    const drained = { old: 0 };
    for (const id of Object.keys(s.groups)) drained[id] = 0;
    if (cur) {
      const d = askedDrain(CURRENT.drainWeight, s.old.patience);
      s.old.patience = clamp01(s.old.patience - d);
      s.old.lastAskAt = at;
      drained.old = +d.toFixed(5);
    }
    for (const id of Object.keys(s.groups)) {
      const g = s.groups[id];
      const gp = { ...GROUP_PARAMS[id], ...(groups?.[id] || {}) };
      if (!groupTriggered(gp, ev)) continue;
      const last = g.lastDrainByKey[key];
      if (Number(gp.cooldownMs) > 0 && last !== undefined && at - last < Number(gp.cooldownMs)) { drained[id] = 0; continue; }
      if (Number(gp.globalCooldownMs) > 0 && at - Number(g.lastGlobalDrainAt || -Infinity) < Number(gp.globalCooldownMs)) { drained[id] = 0; continue; }
      const d = askedDrain(gp.drainWeight, g.patience);
      g.patience = clamp01(g.patience - d);
      g.lastAskAt = at;
      g.lastGlobalDrainAt = at;
      g.lastDrainByKey[key] = at;
      drained[id] = +d.toFixed(5);
    }
    records.push({ t: 'ask', at: new Date(at).toISOString(), mode: 'shadow', key, text: text.slice(0, 80), private: !!ev.private, isDirect: !!ev.isDirect, triggers: recTriggers, drained });
  }
  return { state: s, records };
}

/** 推进一个 tick：旧模型 + 配置的两组并排。 */
export function shadowTick(state, { at = Date.now(), realPatience = 0.85, energy = 0.6, otherDims = null, groups = GROUP_PARAMS, rng = Math.random, samples = 8 } = {}) {
  const dtH = Math.max(1 / 60, (at - Number(state.lastAt || at)) / 3600000);
  const s = { ...state, lastAt: at, old: { ...state.old }, groups: { ...state.groups } };
  const oldIdleH = (at - Number(s.old.lastAskAt || -Infinity)) / 3600000;
  s.old = { ...s.old, patience: currentTick(s.old.patience, { dtH, idleAskH: oldIdleH }) };
  for (const id of Object.keys(s.groups)) {
    const g = s.groups[id];
    const gp = { ...GROUP_PARAMS[id], ...(groups?.[id] || {}) };
    const idleH = (at - Number(g.lastAskAt || -Infinity)) / 3600000;
    const next = gp.softcap !== undefined
      ? flipPatienceTick(g.patience, { dtH, idleAskH: idleH }, gp)
      : proposedTick(g.patience, { dtH, idleAskH: idleH }, { baseTarget: gp.baseTarget, idleTarget: gp.idleTarget, revertRatePerH: gp.revertRatePerH, lowFloor: PROPOSED.lowFloor, lowRevertRatePerH: PROPOSED.lowRevertRatePerH });
    s.groups[id] = { ...g, patience: next };
  }
  const record = {
    t: 'tick', at: new Date(at).toISOString(), mode: 'shadow', dtH: +dtH.toFixed(4),
    real: { patience: +Number(realPatience).toFixed(4), energy: +Number(energy).toFixed(4), otherDims: otherDims || null },
    old: { patience: +s.old.patience.toFixed(4), ...oldPush(s.old.patience, energy, { rng, samples }) },
    groups: {},
  };
  for (const id of Object.keys(s.groups)) {
    const gp = { ...GROUP_PARAMS[id], ...(groups?.[id] || {}) };
    record.groups[id] = { patience: +s.groups[id].patience.toFixed(4), ...probePush(s.groups[id].patience, energy, gp.pushBaseline, { rng, samples }) };
  }
  return { state: s, record };
}

/** 本地日 key（Asia/Shanghai），用于「有事件日」验收。 */
export function localDayKey(at, timeZone = 'Asia/Shanghai') {
  try { return new Intl.DateTimeFormat('zh-CN', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at)); } catch { return String(at).slice(0, 10); }
}

/**
 * 24h/稳态验收统计：
 *  - 支持 excludeFirstMs（部署后前 3h 过渡不算）
 *  - activeDayMinEvents>0 时只在「有 ≥N 条有效事件的日子」上算 std/unique/push（静默日不算失败）
 *  - 旧模型仍作对照（应恒定）
 *  - 记录最后一次 reset 时刻，避免 bridge 重启跳变污染
 */
export function summarizeShadow(records = [], options = {}) {
  const opts = { excludeFirstMs: 0, activeDayMinEvents: 0, ...options };
  const ticksAll = records.filter((r) => r && r.t === 'tick');
  const asks = records.filter((r) => r && r.t === 'ask');
  const resets = records.filter((r) => r && r.t === 'reset').map((r) => Date.parse(r.at)).filter(Number.isFinite);
  const lastResetAt = resets.length ? Math.max(...resets) : null;
  const startAt = Math.max(lastResetAt != null ? lastResetAt + Number(opts.excludeFirstMs || 0) : -Infinity, ticksAll.length ? Date.parse(ticksAll[0].at) : -Infinity);
  const inWindow = ticksAll.filter((r) => Date.parse(r.at) >= startAt);
  // 有事件日
  const eventDays = new Map();
  for (const r of asks) {
    const day = localDayKey(r.at);
    const n = Number(r.drained ? Object.values(r.drained).filter((v) => Number(v) > 0).length : 0);
    if (n > 0) eventDays.set(day, (eventDays.get(day) || 0) + 1);
  }
  let evaluated = inWindow; let activeDays = []; let quietDays = []; let insufficient = false;
  if (asks.length > 0 && Number(opts.activeDayMinEvents) > 0) {
    activeDays = [...eventDays.entries()].filter(([, n]) => n >= Number(opts.activeDayMinEvents)).map(([d]) => d);
    quietDays = [...eventDays.entries()].filter(([, n]) => n < Number(opts.activeDayMinEvents)).map(([d, n]) => ({ day: d, events: n }));
    evaluated = inWindow.filter((r) => activeDays.includes(localDayKey(r.at)));
    insufficient = activeDays.length === 0;
  }
  const byGroup = {};
  // 只用「参与统计窗口」里出现的组（部署/重置前的旧组不参与选组；窗口为空时取最后一拍的组）
  const groupSource = evaluated.length ? evaluated : (inWindow.length ? [inWindow[inWindow.length - 1]] : (ticksAll.length ? [ticksAll[ticksAll.length - 1]] : []));
  const ids = ['old', ...new Set(groupSource.flatMap((r) => Object.keys(r.groups || {})))];
  for (const id of ids) {
    const ps = evaluated.map((r) => (id === 'old' ? r.old?.patience : r.groups?.[id]?.patience)).filter((x) => typeof x === 'number');
    const prob = evaluated.map((r) => (id === 'old' ? r.old?.pushProb : r.groups?.[id]?.pushProb)).filter((x) => typeof x === 'number');
    const mean = ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 0;
    const std = ps.length ? Math.sqrt(ps.reduce((a, b) => a + (b - mean) ** 2, 0) / ps.length) : 0;
    byGroup[id] = { n: ps.length, mean: +mean.toFixed(4), std: +std.toFixed(4), unique: new Set(ps.map((v) => v.toFixed(2))).size, min: ps.length ? +Math.min(...ps).toFixed(3) : 0, max: ps.length ? +Math.max(...ps).toFixed(3) : 0, pushProbMean: prob.length ? +(prob.reduce((a, b) => a + b, 0) / prob.length).toFixed(3) : 0 };
  }
  const real = evaluated.length ? (() => { const xs = evaluated.map((r) => r.real?.patience).filter((x) => typeof x === 'number'); const mean = xs.reduce((a, b) => a + b, 0) / (xs.length || 1); return { n: xs.length, mean: +mean.toFixed(4), std: +Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length || 1)).toFixed(4) }; })() : { n: 0, mean: 0, std: 0 };
  const primary = byGroup.main ? 'main' : Object.keys(byGroup).find((id) => id !== 'old');
  const pass = { mainStd: !!primary && byGroup[primary].std >= SHADOW_THRESHOLDS.stdMin, mainUnique: !!primary && byGroup[primary].unique >= SHADOW_THRESHOLDS.uniqueMin, mainPush: !!primary && byGroup[primary].pushProbMean > SHADOW_THRESHOLDS.pushMin, primary: primary || null };
  return { ticks: evaluated.length, ticksAll: ticksAll.length, lastResetAt: resets.length ? new Date(lastResetAt).toISOString() : null, excludeFirstMs: opts.excludeFirstMs, activeDayMinEvents: opts.activeDayMinEvents, activeDays, quietDays, insufficient, real, byGroup, pass };
}

/** 选组：main 优先 → alt → flip（都过优先 main）；都不过 null。 */
export const SHADOW_THRESHOLDS = Object.freeze({ stdMin: 0.02, uniqueMin: 3, pushMin: 0.10 });
export function selectShadowGroup(summary = {}, thresholds = SHADOW_THRESHOLDS) {
  const groups = summary.byGroup || {};
  const evalGroup = (id) => {
    const g = groups[id] || {};
    const passStd = Number(g.std) >= thresholds.stdMin;
    const passUnique = Number(g.unique) >= thresholds.uniqueMin;
    const passPush = Number(g.pushProbMean) > thresholds.pushMin;
    return { id, passStd, passUnique, passPush, pass: passStd && passUnique && passPush, std: g.std, unique: g.unique, pushProbMean: g.pushProbMean, mean: g.mean, n: g.n };
  };
  const order = ['main', 'alt', 'flip'];
  const ids = Object.keys(groups).filter((id) => id !== 'old');
  const ranked = [...order.filter((id) => ids.includes(id)), ...ids.filter((id) => !order.includes(id))];
  const ev = {};
  for (const id of ranked) ev[id] = evalGroup(id);
  const selected = ranked.find((id) => ev[id].pass) || null;
  const passIds = ranked.filter((id) => ev[id].pass);
  const reason = !selected ? 'none-pass-keep-shadow' : (passIds.length > 1 ? 'multi-pass-prefer-' + selected : selected + '-pass');
  return { selected, reason, groups: ev, thresholds: { ...thresholds }, oldControl: groups.old || null };
}
