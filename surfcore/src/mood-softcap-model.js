/**
 * 五量软上限模型（task-45，纯离线；不接 bridge、不改 mood.js）
 *
 * 来源：dsh-longing 的三条机制（调研见 xiaomian-pm/knowledge/dsh-longing-review.md）
 *   ① 软上限 + 向基线漂移：越界不硬夹，按 e^(-rate·dt) 回落；平时向 target 漂移。
 *   ② 同类事件 1/(1+n) 递减：1 小时内同类事件第 n 次效果 ×1/(1+n)。
 *   ③ 越界「硬撑」：事件可以把值顶出软上限（hardPush），只在回落时慢慢还；
 *      hardPush=false 时退回硬夹。数值层只给「越界」这个事实，文案层（硬撑行）另做。
 *
 * 设计边界：
 *   · 参数全部走 DIM_PARAMS / 调用方传入，不写死到规则或人格；
 *   · 五量语义不变（energy / patience / curiosity / mood / social），不引入第七个状态；
 *   · 本文件只有纯函数，不做 IO、不读 config、不写 state。
 *
 * 术语：
 *   target    基线（长期想待在的地方）
 *   idleTarget 闲置 > idleH 小时后的基线（patience 用；默认 null = 不区分）
 *   softcap   软上限（可以越界，但会回落；不是墙）
 *   revertRatePerH 向基线漂移的速率（1/h）
 *   decayPerH 线性衰减（1/h；curiosity 这类「越放越少」的量用）
 *   hardPush  是否允许事件把值顶出软上限
 */

export const DIM_KEYS = Object.freeze(['energy', 'patience', 'curiosity', 'mood', 'social']);

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

/** 每个量的默认参数。enabled=false 表示这一段只做对照、不进模型。 */
export const DIM_PARAMS = Object.freeze({
  energy: Object.freeze({
    enabled: false,          // 已有昼夜基线，本轮不动
    target: null,            // 由 mood.js 的 energyBaseline 提供
    idleTarget: null,
    idleH: 2,
    softcap: 0.92,
    capRatePerH: 0.4,
    hardPush: true,
    hardPushMax: 0.97,
    revertRatePerH: 1 / 1.5, // 现状：1.5h 回到基线
    decayPerH: 0,
    floor: 0,
    floorRatePerH: 0,
  }),
  patience: Object.freeze({
    enabled: true,
    // 2026-11-10（task-45）：task-41 的 base=0.76 / idle=0.72 关系是反的——
    // 事件稀疏时几乎永远走 idle 分支 → 全部钉在 0.72，只会在切换瞬间有一点波动。
    // 这里翻过来：刚被要求后目标低（一时缓不过来），安静 >2h 目标高（真正恢复）。
    target: 0.72,
    idleTarget: 0.80,
    idleH: 2,
    softcap: 0.85,           // 旧硬 cap 0.85 改成软上限：越界可硬撑，回落
    capRatePerH: 0.4,
    hardPush: true,
    hardPushMax: 0.95,
    revertRatePerH: 0.30,
    decayPerH: 0,
    floor: 0,
    floorRatePerH: 0,
  }),
  curiosity: Object.freeze({
    enabled: false,          // 本轮只做边界对照
    target: 0.15,            // 现状：线性衰减到地板，没有向上漂移
    idleTarget: null,
    idleH: 2,
    softcap: 0.85,
    capRatePerH: 0.4,
    hardPush: true,
    hardPushMax: 0.92,
    revertRatePerH: 0,       // 不向 target 回拉，保持现状的「只降不升」
    decayPerH: 0.06,         // 白天 0.06/h、夜里 0.03/h 由调用方传入
    floor: 0.15,
    floorRatePerH: 0,
  }),
  mood: Object.freeze({
    enabled: false,
    target: 0.55,
    idleTarget: null,
    idleH: 2,
    softcap: 0.90,
    capRatePerH: 0.4,
    hardPush: true,
    hardPushMax: 0.96,
    revertRatePerH: 0.25,
    decayPerH: 0,
    floor: 0,
    floorRatePerH: 0,
  }),
  social: Object.freeze({
    enabled: false,
    target: 0.78,            // 现状恢复是向 1.0 涨；软上限版给一个 0.78 的落点
    idleTarget: null,
    idleH: 2,
    softcap: 0.90,
    capRatePerH: 0.4,
    hardPush: true,
    hardPushMax: 0.96,
    revertRatePerH: 0.08,
    decayPerH: 0,
    floor: 0.15,
    floorRatePerH: 0.05,
  }),
});

/** 参数预设（只影响 patience 的恢复/目标；事件触发在 askTrigger 里）。 */
export const GROUPS = Object.freeze({
  'task41-main': Object.freeze({ target: 0.76, idleTarget: 0.72, revertRatePerH: 0.30, drainWeight: 0.10, cooldownMs: 180000 }),
  'task41-alt': Object.freeze({ target: 0.72, idleTarget: 0.72, revertRatePerH: 0.20, drainWeight: 0.08, cooldownMs: 180000 }),
  softcap: Object.freeze({ target: 0.72, idleTarget: 0.80, revertRatePerH: 0.30, drainWeight: 0.10, cooldownMs: 180000 }),
});

/** 软上限一步：v 高于 cap 时 v = cap + (v-cap)·e^(-rate·dt)；不高于时原样返回。 */
export function softCapValue(v, cap, dtH, ratePerH = 0.4) {
  const x = Number(v) || 0;
  const c = Number(cap);
  const dt = Math.max(0, Number(dtH) || 0);
  if (!Number.isFinite(c) || x <= c) return x;
  return c + (x - c) * Math.exp(-Math.max(0, Number(ratePerH) || 0) * dt);
}

/** 向基线漂移一步：v += (target - v)·min(1, rate·dt)。 */
export function driftTo(v, target, dtH, ratePerH = 0.3) {
  const x = Number(v) || 0;
  const t = Number(target);
  const dt = Math.max(0, Number(dtH) || 0);
  const k = Math.min(1, Math.max(0, Number(ratePerH) || 0) * dt);
  if (!Number.isFinite(t) || k <= 0) return x;
  return x + (t - x) * k;
}

/** 线性衰减：v - decayPerH·dt（不低于 0）。 */
export function linearDecay(v, dtH, decayPerH = 0) {
  return Math.max(0, (Number(v) || 0) - Math.max(0, Number(decayPerH) || 0) * Math.max(0, Number(dtH) || 0));
}

/** 软地板：低于 floor 时按 floorRatePerH 回收（不硬夹，避免底部瞬弹）。 */
export function floorPull(v, floor, dtH, ratePerH = 0) {
  const x = Number(v) || 0;
  const f = Number(floor);
  if (!Number.isFinite(f) || x >= f) return x;
  const k = Math.min(1, Math.max(0, Number(ratePerH) || 0) * Math.max(0, Number(dtH) || 0));
  return x + (f - x) * k;
}

/** 当前该用哪个基线：闲置超过 idleH 小时用 idleTarget（没配就用 target）。 */
export function targetFor(params, { idleH = Infinity } = {}) {
  const p = params || {};
  if (p.idleTarget != null && Number(idleH) > Number(p.idleH ?? 2)) return Number(p.idleTarget);
  return p.target == null ? null : Number(p.target);
}

/**
 * 推进一个量的一步（不含事件）。
 * 顺序：软上限回落 → 线性衰减 → 向基线漂移 → hardPush 关时夹回 cap → 软地板。
 * 返回 { value, overCap }；overCap 表示这一步结束时仍在软上限之上（硬撑中）。
 */
export function tickDim(v, params = {}, { dtH = 0, idleH = Infinity } = {}) {
  const p = { ...DIM_PARAMS, ...(params || {}) };
  let x = clamp01(v);
  const cap = Number(p.softcap);
  const dt = Math.max(0, Number(dtH) || 0);
  if (Number.isFinite(cap) && x > cap) x = softCapValue(x, cap, dt, p.capRatePerH);
  if (p.decayPerH) x = linearDecay(x, dt, p.decayPerH);
  const tgt = targetFor(p, { idleH });
  if (tgt != null) x = driftTo(x, tgt, dt, p.revertRatePerH);
  if (Number.isFinite(cap) && x > cap && !p.hardPush) x = cap;
  if (Number.isFinite(cap) && Number.isFinite(p.hardPushMax)) x = Math.min(Number(p.hardPushMax), x);
  x = floorPull(x, p.floor, dt, p.floorRatePerH);
  return { value: clamp01(x), overCap: Number.isFinite(cap) && x > cap + 1e-9 };
}

/** 同类事件递减：1h 内第 n 次（n 从 0 开始）效果 ×1/(1+n)。 */
export function eventMultiplier(n) {
  return 1 / (1 + Math.max(0, Math.floor(Number(n) || 0)));
}

/**
 * 同类事件计数器：按 key 记 1h 窗口内已经发生过几次。
 * 用法：const w = createEventWindow(); const n = w.note('praise', at); const mult = eventMultiplier(n);
 */
export function createEventWindow({ windowMs = 3600e3 } = {}) {
  const last = new Map();   // key -> 最近 N 次时间戳
  return {
    /** 记一次，返回「在它之前」同 key 的次数（第一次返回 0）。 */
    note(key, at = Date.now()) {
      const k = String(key || '');
      const t = Number(at) || 0;
      const arr = (last.get(k) || []).filter((x) => t - x < windowMs);
      const n = arr.length;
      arr.push(t);
      last.set(k, arr);
      return n;
    },
    count(key, at = Date.now()) {
      const k = String(key || '');
      const t = Number(at) || 0;
      return (last.get(k) || []).filter((x) => t - x < windowMs).length;
    },
    reset() { last.clear(); },
  };
}

/**
 * 施加一次事件增量（已含递减后的 delta）。
 * 单次幅度先按 ±maxStep 夹，再允许 hardPush 越界；越界上限 hardPushMax。
 */
export function applyEvent(v, delta, params = {}, { n = 0, maxStep = 0.12 } = {}) {
  const p = { ...DIM_PARAMS, ...(params || {}) };
  const d = Math.max(-Math.abs(maxStep), Math.min(Math.abs(maxStep), Number(delta) * eventMultiplier(n)));
  let x = clamp01((Number(v) || 0) + d);
  const cap = Number(p.softcap);
  if (Number.isFinite(cap) && x > cap) {
    x = p.hardPush ? Math.min(Number(p.hardPushMax ?? 1), x) : cap;
  }
  return clamp01(x);
}

/** 被要求做事时 patience 的扣减（与 mood.js onAsked 的 gain 同式）。 */
export function askedDrain(weight, patience, target = 0.60) {
  const sensitivity = Math.max(0.4, 1 + (target - Number(patience)) * 1.2);
  return Number(weight) * 0.30 * sensitivity;
}

/** pushCount 公式（与 mood.js sampleBehavior 同款：jitter 为 0~1 均匀）。 */
export function pushCountValue(patience, energy, jitter = 0) {
  return Math.max(0, Math.round((0.55 - Number(patience)) * 6 + (0.6 - Number(energy)) * 3 + Number(jitter) * 2 - 1));
}

/** C1 候选：把 pushCount 基线做成参数（Phase 3 才可能改生产；本轮只模拟）。 */
export function pushCountWithBaseline(patience, energy, jitter = 0, { baseline = 0.78, mult = 6, energyMult = 3 } = {}) {
  return Math.max(0, Math.round((Number(baseline) - Number(patience)) * Number(mult)
    + (0.6 - Number(energy)) * Number(energyMult) + Number(jitter) * 2 - 1));
}

/** 用 samples 次 jitter 抽样估「此刻 pushCount≥1」的概率（不改生产、只做离线验收）。 */
export function pushCountNonZeroProb(patience, energy, { baseline = 0.78, mult = 6, energyMult = 3, samples = 64, rng = Math.random } = {}) {
  const n = Math.max(1, Math.floor(Number(samples) || 1));
  let hit = 0;
  for (let i = 0; i < n; i++) {
    if (pushCountWithBaseline(patience, energy, rng(), { baseline, mult, energyMult }) > 0) hit += 1;
  }
  return hit / n;
}

/** 描述统计（std 用总体标准差；unique 按 2 位小数去重）。 */
export function stats(values = []) {
  const xs = values.map(Number).filter((x) => Number.isFinite(x));
  if (!xs.length) return { n: 0, mean: 0, std: 0, min: 0, max: 0, p10: 0, p50: 0, p90: 0, unique: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const std = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  const sorted = [...xs].sort((a, b) => a - b);
  const q = (f) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * f)))];
  return {
    n: xs.length,
    mean: +mean.toFixed(4),
    std: +std.toFixed(4),
    min: +sorted[0].toFixed(3),
    max: +sorted[sorted.length - 1].toFixed(3),
    p10: +q(0.1).toFixed(3),
    p50: +q(0.5).toFixed(3),
    p90: +q(0.9).toFixed(3),
    unique: new Set(xs.map((v) => v.toFixed(2))).size,
  };
}

/** 贴顶比例：value ≥ threshold 的占比（0~1）。 */
export function topRatio(values = [], threshold) {
  const xs = values.map(Number).filter((x) => Number.isFinite(x));
  if (!xs.length) return 0;
  return xs.filter((x) => x >= Number(threshold)).length / xs.length;
}

/** 贴边比例：|value - edge| < eps 的占比（用来抓「换个地方钉住」的吸收态）。 */
export function stickRatio(values = [], edge, eps = 0.01) {
  const xs = values.map(Number).filter((x) => Number.isFinite(x));
  if (!xs.length) return 0;
  return xs.filter((x) => Math.abs(x - Number(edge)) < Number(eps)).length / xs.length;
}

// ── 触发面 ────────────────────────────────────────────────────────────────
// 只做 mood 事件触发（ask），不接 bridge、不改分类器。三档并排：
//   current  生产现状：8 个词
//   extended task-41 Phase 1 的扩展词表（v1）
//   gated    在 v1 上补 5 类漏词 + 上下文闸 + 去掉叙述/教学/他人主语（v2，候选）

const CURRENT_RE = /帮我|给我|你来|画个|来一张|做一下|算算|写个|查一下/;
const SIGNAL_V1_RE = /(帮我|给我|替我|请你|麻烦你|你去|你来|你先|先把|先发|先看|先做|先查|先找|发一下|发出来|发过来|看一下|看看这个|试一下|试一试|试试看|找一下|找找|来点|来一段|做一下|做一个|教我|带我|陪我|翻译|读一下|念一下|讲一下|说一下|告诉我|查一下|查查|搜一下|等会.{0,12}(发|做|看|来)|再找找|再试|能不能|可不可以|可以吗|行不行|要不要|该学了|去.{0,4}(翻|看|查|找|试|做|发))/;
// 2026-11-10：真实漏词里补出来的 5 类（快回答/截图/发到/附上/收拾/去搜/去听/看看你）
const SIGNAL_EXTRA_RE = /发到|看看你|截图|回答|附上|收拾|研究|去.{0,4}(搜|听)/;
const CHAT_RE = /(^|，)(哈哈|笑死|草|离谱|逆天|真的假的)/;
// 主语不是她 / 叙述别人：去掉，避免「我给我的 DSH 拓展了全功能」这种被当成使唤
const NOISE_RE = /^(我|我们|他|她|他们|你们)|助手小姐|助手鱼|豆包|PM鱼|ds superagent/;
// 教学/规矩/未来约束：交给 moodTaught，不走 ask
const TEACH_RE = /^(以后|下次|记得|不要|别|不准)|(以后|下次).{0,12}(要|别|不要|记得|不准)/;

/**
 * 判定一条消息是不是「对她说、像请求」。
 * ctx: { private, atHer, recentSelfMs } —— recentSelfMs = 距该会话上一条她自己发言的毫秒数。
 * 返回 { current, extended, gated, reason }；gated 是候选（v2 + 上下文闸）。
 */
export function askTrigger(text, ctx = {}) {
  const t = String(text || '');
  const current = CURRENT_RE.test(t);
  const extended = SIGNAL_V1_RE.test(t) && !CHAT_RE.test(t);
  const context = Boolean(ctx.private) || Boolean(ctx.atHer) || Number(ctx.recentSelfMs) <= 5 * 60e3;
  const noise = NOISE_RE.test(t) || TEACH_RE.test(t);
  const gated = (extended || (SIGNAL_EXTRA_RE.test(t) && !CHAT_RE.test(t))) && context && !noise;
  let reason = '';
  if (gated) reason = 'gated';
  else if (extended && !context) reason = 'no-context';
  else if (extended && noise) reason = 'noise-or-teaching';
  else if (!current && !extended) reason = 'no-signal';
  return { current, extended, gated, reason };
}

/**
 * 同会话冷却：同一 key 在 cooldownMs 内只保留第一条。events 需含 {key, at}。
 * 可选 globalMs：跨会话的全局间隔（防止多群同时刷请求把耐心打穿）。
 */
export function filterByCooldown(events = [], cooldownMs = 180000, { globalMs = 0 } = {}) {
  const last = new Map();
  let lastGlobal = -Infinity;
  const out = [];
  for (const e of events) {
    const key = String(e.key || '');
    const at = Number(e.at) || 0;
    if (cooldownMs > 0 && last.has(key) && at - last.get(key) < cooldownMs) continue;
    if (globalMs > 0 && at - lastGlobal < globalMs) continue;
    last.set(key, at);
    lastGlobal = at;
    out.push(e);
  }
  return out;
}
