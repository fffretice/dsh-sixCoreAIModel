/**
 * 情绪核心（2026-10-30 由 F+D 升级而来）
 *
 * 与性格核心 / 规则核心 / 记忆核心并列，四者互相影响：
 *   性格 → 决定情绪基线（她懒，所以基线精力偏低）
 *   规则 → 被教 = 消耗耐心；规矩多 = 更容易烦
 *   记忆 → 心情低时更容易想起不好的事（情绪一致回忆）
 *   情绪 → 决定「半推半就」的程度、要不要去查资料、话多话少
 *
 * 五个量互相影响，依据：
 *   · Russell (1980) 环形情绪模型：情绪由 valence × arousal 两维构成
 *   · Mehrabian & Russell (1974) PAD：pleasure / arousal / dominance
 *   · Kuppens et al. (2010) 情绪惯性：情绪变化慢、有自相关
 *   · Fredrickson (1998) broaden-and-build：正情绪拓宽注意 → 更愿意探索（好奇↑）
 *   · Yerkes–Dodson (1908)：唤醒过高/过低都会降低耐受与表现（耐心在中等精力最好）
 */

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

const DEFAULTS = Object.freeze({
  energy: 0.7,
  patience: 0.6,
  curiosity: 0.5,
  mood: 0.55,
  social: 0.5,
});

/** 性格倾向：懒 → 精力基线低一档、耐心恢复慢一点。 */
const TRAIT = Object.freeze({
  energyBias: -0.02,   // 体力偏差从 -0.08 收到 -0.02（两倍精力）
  patienceRecover: 0.26,
  curiosityBias: 0.02,
});


/** 0~1 均匀随机，可注入以便测试。 */
function rand() { return Math.random(); }
function jitter(base, spread) { return base + (rand() * 2 - 1) * spread; }
/** 软阈值：把一个差值转成 0~1 的概率（越偏离越可能），而不是硬开关。 */
function soft(delta, scale = 2.2) {
  return 1 / (1 + Math.exp(-delta * scale));
}
/** 动态增益：同样的刺激，状态不同时感受不同（且每次带一点随机）。 */
function gain(base, state, target = 0.5, spread = 0.25) {
  const sensitivity = 1 + (target - state) * 1.2;      // 越缺越敏感
  return base * Math.max(0.4, sensitivity) * jitter(1, spread);
}

// 2026-10-31：主人说她是「常人两倍精力」（天运）。做法不是把数字乘 2，
// 而是把基线抬高一档、事件消耗减半、体力偏差缩小 —— 她跑一天还有余力做自己的事。
function energyBaseline(date = new Date()) {
  const raw = _energyBaselineRaw(date);
  return Math.min(0.92, raw * 1.15 + 0.12);
}
function _energyBaselineRaw(date = new Date()) {
  const h = date.getHours() + date.getMinutes() / 60;
  // 2026-10-31：凌晨不再掉到 0.25（她夜里要醒着）；清晨平滑回升。
  if (h < 5) return 0.52;
  if (h < 9) return 0.5 + (h - 5) * 0.075;
  if (h < 13) return 0.8;
  if (h < 16) return 0.7;
  if (h < 19) return 0.6;
  if (h < 23) return 0.5;
  // 2026-10-31：夜间基线从 0.3 抬到 0.52 —— 她夜里也要醒着陪人。
  // 之前一到 23 点精力就往 0.22 掉，表现为「大半夜突然没精神」；困意仍由连续对话和睡眠机制决定。
  return 0.52;
}

/** 五量之间的耦合：这是「互相影响」的核心。 */
function couple(d, { dtH = 0, event = null } = {}) {
  const out = { ...d };
  // 事件路径：用固定小步长，而不是按 dtH 缩放（否则一次事件只影响 5%，几乎看不出来）
  if (event) {
    const e = event;
    // 精力低 → 耐心连带下降（社交的连带下降挪到 tick 里按时间算了，
    // 这里再按事件扣一次就是重复计，她一句话说下来电量就没了）
    if (out.energy < 0.4) {
      out.patience = clamp01(out.patience - 0.006);
    }
    // 心情变化会带动好奇（broaden-and-build）
    if (Number(e.mood)) out.curiosity = clamp01(out.curiosity + Number(e.mood) * 0.25);
    // 社交被满足 → 心情明显变好（EMA 文献：有陪伴的时刻正性情绪更高），但边际递减
    // 2026-10-31 修：原来写的是 `e.social > 0`，而 onSocial 传的是负数（-0.006），
    // 这个条件永远不成立 —— 所以「被陪伴心情变好」这段其实从没跑过。
    const socialDelta = Number(e.social || 0);
    if (socialDelta < 0 && socialDelta > -0.02) {   // 小步下降 = 被陪伴；-0.03 那种是被忽略，不算
      out.mood = clamp01(out.mood + 0.02 * (1 - out.social));
      out.energy = clamp01(out.energy - 0.002);
    }
    // 心情好 → 更想理人：只在社交事件上扣，而且一次只扣 0.002。
    // 原来是无条件扣 0.004 —— 她每说一句、每被叫一次都在掉，5 分钟能掉 0.03。
    if (socialDelta < 0 && out.mood > 0.65) {
      out.social = clamp01(out.social - 0.002);
    }
    return out;
  }


  // 1) 精力低 → 耐心恢复变慢、好奇被压住、社交意愿下降（累的时候不想说话）
  const tired = out.energy < 0.4 ? (0.4 - out.energy) / 0.4 : 0;
  out.patience = clamp01(out.patience - tired * 0.02 * Math.max(dtH, 0.05));
  out.curiosity = clamp01(out.curiosity - tired * 0.03 * Math.max(dtH, 0.05));
  out.social = clamp01(out.social - tired * 0.04 * Math.max(dtH, 0.05));

  // 2) 心情高 → 好奇上升（bebroaden-and-build）；心情低 → 探索欲下降
  const valence = out.mood - 0.5;
  out.curiosity = clamp01(out.curiosity + valence * 0.12 * Math.max(dtH, 0.05));

  // 3) Yerkes–Dodson：精力过高/过低都让耐心变差，中等最好
  const dist = Math.abs(out.energy - 0.6);
  if (dist > 0.3) out.patience = clamp01(out.patience - (dist - 0.3) * 0.08 * Math.max(dtH, 0.05));

  // 4) 社交意愿高 → 心情慢慢变好（被陪伴），但精力也花一点
  if (out.social > 0.6) {
    out.mood = clamp01(out.mood + 0.02 * Math.max(dtH, 0.05));
    out.energy = clamp01(out.energy - 0.01 * Math.max(dtH, 0.05));
  }

  // 5) 耐心见底 → 心情被拖累（烦躁）
  if (out.patience < 0.25) out.mood = clamp01(out.mood - 0.03 * Math.max(dtH, 0.05));

  // 6) 情绪惯性：心情变化慢（Kuppens），这里只做轻微回拉，避免抖动
  out.mood = clamp01(out.mood + (out.mood - d.mood) * 0.0);

  return out;
}

export function createMood(now = Date.now()) {
  return {
    at: now,
    lastTickAt: now,
    dims: { ...DEFAULTS, energy: clamp01(DEFAULTS.energy + TRAIT.energyBias) },
    lastWakeAt: 0,
    lastSocialAt: now,
    core: 'emotion', // 命名：情绪核心
  };
}

/** 自然回归 + 耦合。建议 5 分钟一次。 */
export function tick(mood, now = Date.now()) {
  let m = mood && mood.dims ? mood : createMood(now);
  // 2026-10-30 修：dtH 原来在「睡眠分支」之后才算，睡着时这里引用会抛 ReferenceError
  // （上半段整块没执行，表现就是「睡着了但状态不恢复」）。提到最上面。
  // 2026-10-31 重要修正：步长必须用「上次 tick 的时间」，不能用 m.at。
  // onSocial / onAsked 这些事件都会把 at 改写成事件发生时刻，于是下一次 tick 只按
  // 「距上次事件」的时间算恢复——群里越热闹，恢复被算得越少，social 就这么一天贴着 0。
  const dtH = Math.max(0, (now - Number(m.lastTickAt ?? m.at ?? now)) / 3600000);
  const tickBase = { ...m, lastTickAt: now };
  // 睡着：静养 —— 精力、耐心、心情都慢慢回，不再冻结在 0
  if (m.asleep) {
    if (sleepFinished(m, now)) return wakeUp(tickBase, now);
    const d = { ...m.dims };
    d.energy = clamp01(d.energy + dtH * 0.55);
    d.patience = clamp01(d.patience + dtH * 0.5);
    d.mood = clamp01(d.mood + (0.5 - d.mood) * Math.min(1, dtH * 0.3));
    d.curiosity = clamp01(d.curiosity - dtH * 0.1);
    d.social = clamp01(d.social + dtH * 0.02);
    return { ...tickBase, at: now, dims: d };
  }
  const d = { ...m.dims };

  const target = clamp01(energyBaseline(new Date(now)) + TRAIT.energyBias);
  const k = Math.min(1, dtH / 1.2);            // 1.2 小时内回到基线（原来 2 小时）
  d.energy = clamp01(d.energy + (target - d.energy) * k);
  d.patience = clamp01(d.patience + dtH * 0.60);
  // 耐心是短期耐力：没被要求做事时会慢慢松下来，也不钉在 100%（2026-10-31）
  const idleAskH = Math.max(0, (now - Number(m.lastAskedAt || now)) / 3600000);
  if (idleAskH > 2) d.patience = clamp01(d.patience + (0.65 - d.patience) * Math.min(1, dtH * 0.12));
  if (d.patience > 0.9) d.patience = 0.9;
  d.curiosity = clamp01(d.curiosity - dtH * 0.10);        // 好奇回落（2026-10-31：0.05 太慢，长期钉在顶上）
  if (d.curiosity < 0.12) d.curiosity = 0.12;             // 留一点底：人不会对什么都没兴趣
  if (d.curiosity > 0.9) d.curiosity = 0.9;                // 上限 0.9：别长期钉在 100%
  d.mood = clamp01(d.mood + (0.55 - d.mood) * Math.min(1, dtH * 0.25));  // 心情回中性更快、目标略高
  // 2026-10-30 修：原来用「距今多久」当步长（累计），静越久扣得越狠，等于双倍计。
  // 现在按真实经过时间衰减；有人说话时 onSocial 会重置 lastSocialAt 并加回来。
  // 独处时社交电量回涨（想找人说话的劲儿攒回来）；刚被陪过就慢一点。
  const quietH = Math.max(0, (now - Number(m.lastSocialAt || 0)) / 3600000);
  // 2026-10-31 第二次修：门槛 9 分钟太死（群里一直有人说话就永远拿不到快档），
  // 再加「见底加速」——否则一整天贴着 0，drive 的社交项等于废掉。
  let socialGain = quietH > 0.07 ? 0.15 : 0.08;
  if (d.social < 0.25) socialGain *= 1.8;      // 见底加速
  if (d.social > 0.85) socialGain *= 0.3;      // 快满时放缓：别从「贴底」修成「一直顶格」
  d.social = clamp01(d.social + dtH * socialGain);
  // 耐心见底 → 心情被拖累：改成按时间（每 5 分钟最多一次），不再按事件次数
  if (d.patience < 0.2) {
    d.mood = clamp01(d.mood - (0.2 - d.patience) * 0.06 * Math.max(dtH, 0.05));
    // 见底时回得更快：不让她卡在 0 一整段时间（2026-10-31）
    d.patience = clamp01(d.patience + dtH * 0.5);
  }

  const coupled = couple(d, { dtH });
  if (coupled.curiosity > 0.92) coupled.curiosity = 0.92;
  if (coupled.social > 0.95) coupled.social = 0.95;
  return { ...tickBase, at: now, dims: coupled };
}

/** 事件先算 impulse，再按「唤醒放大情绪」处理（PAD：arousal 放大 valence 摆动）。 */
function impulse(mood, deltas, now) {
  const d = { ...mood.dims };
  const amp = 0.75 + d.energy * 0.5;      // 精力越高，情绪反应越大
  for (const [k, v] of Object.entries(deltas)) {
    if (!(k in d)) continue;
    d[k] = clamp01(d[k] + Number(v) * (k === 'mood' ? amp : 1));
  }
  // 事件路径也压上限：不然「听到新梗 +0.05」能一路把好奇顶到 100%（2026-10-31）
  if (d.curiosity > 0.9) d.curiosity = 0.9;
  return { ...mood, at: now, dims: couple(d, { event: deltas }) };
}

export function onWake(mood, now = Date.now()) {
  return impulse(mood, { energy: -0.0015, patience: -0.002 }, now);   // 醒来消耗减半
}
export function onSpeak(mood, now = Date.now()) {
  return { ...impulse(mood, { energy: -0.004 }, now) };   // 说话消耗减半
}
export function onAsked(mood, { weight = 0.06 } = {}, now = Date.now()) {
  // 耐心越低，被要求越难受（动态增益 + 随机），不是每次都掉一样多
  const w = gain(weight * 0.30, mood.dims.patience, 0.6);   // 2026-10-31：0.85→0.30，几句话不再见底
  return { ...impulse(mood, { patience: -w }, now), lastAskedAt: now };
}
export function onTaught(mood, { weight = 0.05, curiosityGain = 0.03 } = {}, now = Date.now()) {
  return impulse(mood, {
    patience: -gain(weight * 0.30, mood.dims.patience, 0.6),
    curiosity: gain(curiosityGain, mood.dims.curiosity, 0.5, 0.35),
  }, now);
}
/** 把话说清楚了（引用回复、对上号）：小小的社交满足 —— 不是奖励，是「被看懂」的感觉。 */
export function onUnderstood(mood, now = Date.now()) {
  return impulse(mood, { mood: 0.008, social: 0.006 }, now);
}

export function onPraise(mood, delta = 0.1, now = Date.now()) {
  // 心情越低，被夸越受用；心情已经很好时增益递减
  return impulse(mood, { mood: gain(delta, mood.dims.mood, 0.45, 0.3) }, now);
}
export function onSocial(mood, now = Date.now()) {
  // 2026-10-30 语义修正：social = 社交电量/意愿（0=懒得理人，1=很想找人说话）。
  // 被陪 → 电量下降（被满足）；心情因为被陪而小幅上涨（越好越不明显，避免刷消息把心情刷满）。
  // 2026-10-31 第二次修：加 2 分钟冷却。之前群里每来一条消息就扣 0.008，刷屏几分钟就归零；
  // 更糟的是 lastSocialAt 被不停刷新，quietH 永远到不了「安静」那档，恢复永远是最慢的 0.06/h。
  const last = Number(mood?.lastSocialAt || 0);
  if (now - last < 2 * 60 * 1000) return mood;
  const m0 = Math.min(1, Math.max(0, Number(mood?.dims?.mood ?? 0.55)));
  const moodGain = 0.012 * (1 - m0);
  const next = impulse(mood, { social: -0.006, mood: moodGain }, now);
  return { ...next, lastSocialAt: now };
}
/**
 * 查/看之后有没有收获（2026-10-30）：
 *   有用 → 好奇 +0.08（这次探索值得，下次更愿意去）
 *   没用 → 好奇 -0.03（白费力气，稍微收敛）
 * 依据：奖赏预测误差会调节后续探索；不区分「有用/没用」，好奇就只是个会衰减的标量。
 */
export function onResearchOutcome(mood, { useful = true } = {}, now = Date.now()) {
  // 2026-10-31 修正：查到了 = 信息缺口闭合，好奇该下降，而不是继续涨。
  // 有用 → 好奇 −0.06 + 心情 +0.02（「弄明白了」的满足）；没用 → 好奇 +0.02（还是想知道）。
  return impulse(mood, useful ? { curiosity: -0.06, mood: 0.02 } : { curiosity: 0.02 }, now);
}

export function onUnknown(mood, now = Date.now()) {
  // 好奇被勾起多少，取决于当时有多闲/多累
  const w = gain(0.05, mood.dims.curiosity, 0.5, 0.4) * (0.7 + mood.dims.energy * 0.6);
  return impulse(mood, { curiosity: w }, now);
}
/** 被冷落：没人理，心情和社交一起掉。 */
export function onIgnored(mood, now = Date.now()) {
  return impulse(mood, { mood: -0.04, social: -0.03 }, now);
}


/** 是否该睡了：耐心见底或精力耗尽 → 撑不住了。 */
export function shouldSleep(mood, now = Date.now()) {
  const d = mood?.dims ?? DEFAULTS;
  if (mood?.asleep) return false;
  // 2026-10-30 修：这里原来引用了未定义的 now —— 每次调用都抛 ReferenceError，
  // 被上层 try/catch 吞掉，于是「睡觉」这条路径从来没生效过。
  // 2026-10-31：一天睡太多次。醒后至少撑 3 小时；一天最多睡 2 次；门槛再压低。
  if (mood?.lastWakeUpAt && now - mood.lastWakeUpAt < 180 * 60000) return false;
  const day = new Date(now).toISOString().slice(0, 10);
  const sleepsToday = (mood?.sleepDay === day) ? Number(mood?.sleepCount || 0) : 0;
  if (sleepsToday >= 2) return false;
  const hour = new Date(now).getHours();
  const deepNight = hour >= 23 || hour < 7;
  const threshold = deepNight ? 0.18 : 0.10;
  return d.energy < threshold && rand() < 0.8;
}

/** 入睡：记下睡到什么时候（默认 40~90 分钟，随机）。 */
export function fallAsleep(mood, now = Date.now()) {
  const minutes = 40 + Math.round(rand() * 50);
  // 记一天睡了几次（shouldSleep 用它封顶，避免一天睡太多次）
  const day = new Date(now).toISOString().slice(0, 10);
  const sameDay = mood?.sleepDay === day;
  const sleepCount = (sameDay ? Number(mood?.sleepCount || 0) : 0) + 1;
  return { ...mood, at: now, asleep: true, sleepUntil: now + minutes * 60000, sleepMinutes: minutes, sleepDay: day, sleepCount };
}

/** 睡醒：精力/耐心恢复，心情回中性。 */
export function wakeUp(mood, now = Date.now()) {
  if (!mood?.asleep) return mood;
  const d = { ...mood.dims };
  d.energy = clamp01(Math.max(d.energy, 0.72) + rand() * 0.1);
  d.patience = clamp01(Math.max(d.patience, 0.68) + rand() * 0.1);
  d.mood = clamp01(0.5 + (rand() * 0.2 - 0.1));
  d.social = clamp01(0.55 + rand() * 0.15);
  return { ...mood, at: now, asleep: false, sleepUntil: 0, lastWakeUpAt: now, dims: d };
}

/** 睡着时是否该醒（到点，或被直接叫醒）。 */
export function sleepFinished(mood, now = Date.now()) {
  return Boolean(mood?.asleep) && now >= Number(mood?.sleepUntil || 0);
}

/** 该不该去查资料：好奇压过耐心、还有精力，且没烦到不想动。 */
export function shouldResearch(mood) {
  const d = mood?.dims ?? DEFAULTS;
  // 不再用「> 0.18 且 > 0.4」这种硬条件：算成概率再抽一次，
  // 所以同样的状态，有时会去查、有时懒得查——这才是人。
  // 想去查 = 好奇 − 累 − 烦（耐心低并不让人更想查，只是更不想动）
  const p = soft(
    (d.curiosity - 0.45) * 1.8 + (d.energy - 0.5) * 1.6 - (1 - d.patience) * 0.6,
    2.0
  );
  return rand() < p;
}

/** 现在这一轮的行为倾向：全部由五量算概率后采样，不是查表。 */
export function sampleBehavior(mood) {
  const d = mood?.dims ?? DEFAULTS;
  if (mood?.asleep) {
    // 睡着了：什么都不想干
    return { procrastinate: true, pushCount: 3, research: false, talky: false, initiate: false, terse: true, asleep: true };
  }
  return {
    // 会不会推脱：耐心低 + 累的时候概率高
    procrastinate: rand() < soft((0.45 - d.patience) * 2.2 + (0.5 - d.energy) * 0.9, 1.8),
    // 推几次：耐心越低、越累，推得越多
    pushCount: Math.max(0, Math.round((0.55 - d.patience) * 6 + (0.6 - d.energy) * 3 + jitter(0, 1))),
    // 想不想去查
    research: shouldResearch(mood),
    // 话多话少
    talky: rand() < soft((d.mood - 0.5) * 1.8 + (d.social - 0.45) * 1.6, 1.6),
    // 会不会主动接话
    initiate: rand() < soft((d.social - 0.4) * 1.8 + (d.energy - 0.4) * 1.0, 1.6),
    // 答得长还是短
    terse: rand() < soft((0.45 - d.energy) * 2.0 + (0.4 - d.patience) * 1.4, 1.6),
  };
}

/** 注入：状态 + 行为倾向（不报数字、不许念出来）。 */
export function moodPromptLine(mood) {
  const d = mood?.dims ?? DEFAULTS;
  if (mood?.asleep) {
    const leftMin = Math.max(1, Math.round((Number(mood.sleepUntil || 0) - Date.now()) / 60000));
    return `【你现在的状态】睡着（大概还有 ${leftMin} 分钟醒）。\n- 别人叫你，你会迷糊、不想动，回一句就又睡了；只回一两个字或「唔…」\n- 不要做任何事、不要查东西、不要长句\n（别解释「我在睡觉」，用语气体现就行。）\n\n`;
  }
  const b = sampleBehavior(mood);
  const tag = [];
  if (d.energy < 0.35) tag.push('累');
  else if (d.energy > 0.7) tag.push('精神不错');
  if (d.patience < 0.3) tag.push('有点烦');
  if (d.curiosity > 0.65) tag.push('好奇');
  if (d.mood < 0.3) tag.push('心情低');
  else if (d.mood > 0.7) tag.push('心情好');
  if (d.social < 0.3) tag.push('不太想说话');

  // 行为是「这一轮抽到的」，不是固定规则，所以前后两轮可能不一样
  const behave = [];
  if (b.procrastinate) {
    behave.push(b.pushCount >= 2
      ? `有人让你干活，先推个两三次（「诶…」「等一下」「现在不想动」），实在躲不过再做`
      : `有人让你干活，先唔一下、拖一拖再动`);
  } else {
    behave.push('别人让你做点什么，你不太会推，顺手就做了');
  }
  if (b.research) behave.push('看到没见过的词，会想去查一下');
  else if (d.curiosity > 0.5) behave.push('有点想知道，但懒得去查，先糊过去');
  if (b.terse) behave.push('说话短一点，能一个字答完就一个字');
  if (b.talky) behave.push('愿意多说两句，接得住话');
  if (d.mood < 0.35) behave.push('容易想起不太顺的事，语气会有点沉');
  if (!b.initiate) behave.push('不主动起话头，除非被叫到');
  // 配图倾向：由心情/社交决定，不是固定频率（EMA 文献：正性情绪会提高亲和表达）
  if (d.mood > 0.62 && d.social > 0.5) behave.push('手边有合适的图会想甩一张，比多打几个字更顺');
  else if (d.mood < 0.4 || d.energy < 0.35) behave.push('这会儿懒得找图，说话为主');

  const head = tag.length ? tag.join('、') : '平常';
  return `【你现在的状态】${head}。\n${behave.map((x) => `- ${x}`).join('\n')}\n（这是你此刻的真实状态，别念出来、别说「我有点累」这种报告式的话，让它体现在语气和选择里。）\n\n`;
}

export const __test = { energyBaseline, couple, TRAIT, DEFAULTS };
