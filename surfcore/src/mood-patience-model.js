/**
 * patience 机制 Phase 1（task-41，纯离线模型；不接生产、不改 mood.js）
 *
 * 用途：用真实 mood-history + inbox 重放，对照「当前模型」与「A+B 方案」的
 *   patience 分布 / pushCount 非零比例，给 Phase 2 shadow 定参数。
 *
 * A 方案（软回中位，去硬 cap）：
 *   tick: p += (target - p) * min(1, dtH * revertRatePerH)，target = idleAskH>2 ? idleTarget : baseTarget
 * B 方案（扩 moodAsked）：宽请求信号 + 同会话 3 分钟冷却；drain 用 mood.js 同款 gain 公式。
 */

export const CURRENT = Object.freeze({
  recoverPerH: 0.60,          // tick: p += dtH * 0.60
  idlePullRate: 0.12,         // idleAskH>2: p += (0.65-p)*min(1,dtH*0.12)
  idleTarget: 0.65,
  cap: 0.85,                  // p > cap → cap
  lowFloor: 0.20,             // p<0.2 时额外 +dtH*0.5
  lowAccel: 0.50,
  drainWeight: 0.05,          // onAsked weight
  drainTarget: 0.60,
  cooldownMs: 0,              // 当前无冷却（每次都扣）
});

export const PROPOSED = Object.freeze({
  baseTarget: 0.76,
  idleTarget: 0.72,
  revertRatePerH: 0.30,
  lowFloor: 0.20,
  lowRevertRatePerH: 0.20,
  drainWeight: 0.10,
  drainTarget: 0.60,
  cooldownMs: 3 * 60 * 1000,
});

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

/** mood.js 同款 gain（被要求的扣减幅度）。 */
export function askedDrain(weight, patience, target = 0.60) {
  const sensitivity = Math.max(0.4, 1 + (target - Number(patience)) * 1.2);
  return Number(weight) * 0.30 * sensitivity;
}

/** 当前 tick（不含 drain；drain 由调用方按事件施加）。 */
export function currentTick(patience, { dtH = 0, idleAskH = Infinity } = {}, params = CURRENT) {
  let p = clamp01(patience);
  p = clamp01(p + Number(dtH) * params.recoverPerH);
  if (idleAskH > 2) p = clamp01(p + (params.idleTarget - p) * Math.min(1, Number(dtH) * params.idlePullRate));
  if (p > params.cap) p = params.cap;
  if (p < params.lowFloor) p = clamp01(p + Number(dtH) * params.lowAccel);
  return p;
}

/** 方案 A tick：软回中位，无硬 cap。 */
export function proposedTick(patience, { dtH = 0, idleAskH = Infinity } = {}, params = PROPOSED) {
  let p = clamp01(patience);
  const target = idleAskH > 2 ? params.idleTarget : params.baseTarget;
  p = clamp01(p + (target - p) * Math.min(1, Number(dtH) * params.revertRatePerH));
  if (p < params.lowFloor) p = clamp01(p + Number(dtH) * params.lowRevertRatePerH);
  return p;
}

/** pushCount 公式（与 mood.js sampleBehavior 同款；jitter 注入 0~1）。 */
export function pushCountValue(patience, energy, jitter = 0) {
  return Math.max(0, Math.round((0.55 - Number(patience)) * 6 + (0.6 - Number(energy)) * 3 + Number(jitter) * 2 - 1));
}

/** 当前 moodAsked 触发词（bridge.js ~22976）。 */
export function currentAskTrigger(text) {
  return /帮我|给我|你来|画个|来一张|做一下|算算|写个|查一下/.test(String(text || ''));
}

/** 扩展后的「像请求」信号（Phase 1 候选；具体词表以 shadow 数据校准）。 */
export function extendedAskTrigger(text) {
  const t = String(text || '');
  if (!t || /^\[(图片|表情|拍一拍)/.test(t)) return false;
  const signal = /(帮我|给我|替我|请你|麻烦你|你去|你来|你先|先把|先发|先看|先做|先查|先找|发一下|发出来|发过来|看一下|看看这个|试一下|试一试|试试看|找一下|找找|来点|来一段|做一下|做一个|教我|带我|陪我|翻译|读一下|念一下|讲一下|说一下|告诉我|查一下|查查|搜一下|等会.{0,12}(发|做|看|来)|再找找|再试|能不能|可不可以|可以吗|行不行|要不要|该学了|去.{0,4}(翻|看|查|找|试|做|发))/;
  const chat = /(^|，)(哈哈|笑死|草|离谱|逆天|真的假的)/;
  return signal.test(t) && !chat.test(t);
}

/** 冷却记账（同会话 3 分钟最多扣一次）。给定事件列表返回被接受的事件索引。 */
export function filterByCooldown(events = [], cooldownMs = PROPOSED.cooldownMs) {
  const last = new Map();
  const out = [];
  for (const e of events) {
    const key = String(e.key || '');
    const at = Number(e.at) || 0;
    const hasPrev = last.has(key);
    const prev = hasPrev ? last.get(key) : 0;
    if (cooldownMs > 0 && hasPrev && at - prev < cooldownMs) continue;
    last.set(key, at);
    out.push(e);
  }
  return out;
}


/** C 方案候选：把 pushCount 基线/乘子做成参数（Phase 1 只模拟）。 */
export function pushCountWithBaseline(patience, energy, jitter, { baseline = 0.78, mult = 6, energyMult = 3, jitterSpan = 1 } = {}) {
  return Math.max(0, Math.round((Number(baseline) - Number(patience)) * Number(mult)
    + (0.6 - Number(energy)) * Number(energyMult) + (Number(jitter) * 2 - 1) * Number(jitterSpan)));
}

/** 统计工具（供重放脚本用）。 */
export function stats(values = []) {
  const xs = values.map(Number).filter((x) => Number.isFinite(x));
  if (!xs.length) return { n: 0, mean: 0, std: 0, min: 0, max: 0, unique: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const std = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  return { n: xs.length, mean: +mean.toFixed(4), std: +std.toFixed(4), min: +Math.min(...xs).toFixed(3), max: +Math.max(...xs).toFixed(3), unique: new Set(xs.map((v) => v.toFixed(2))).size };
}
