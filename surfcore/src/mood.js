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

// 2026-10-31：老大说她是「常人两倍精力」（天运）。做法不是把数字乘 2，
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
    // 2026-11-02：改用显式标记 met，不再靠 delta 大小猜——改成 −0.025 之后
    // 「>−0.02 才算被陪伴」这条会失效，而且 −0.03 那种被忽略会被误当成陪伴。
    if (e.met) {
      out.mood = clamp01(out.mood + 0.02 * (1 - out.social));
      out.energy = clamp01(out.energy - 0.002);
      // 心情好 → 更想理人：一次只扣 0.002（原来无条件扣 0.004，5 分钟就掉 0.03）
      if (out.mood > 0.65) out.social = clamp01(out.social - 0.002);
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
    // 2026-11-03：老大要求自然恢复速度降 20%（0.55 → 0.44）。她精力太足，钱包顶不住。
    d.energy = clamp01(d.energy + dtH * 0.44);
    d.patience = clamp01(d.patience + dtH * 0.5);
    d.mood = clamp01(d.mood + (0.5 - d.mood) * Math.min(1, dtH * 0.3));
    d.curiosity = clamp01(d.curiosity - dtH * 0.1);
    d.social = clamp01(d.social + dtH * 0.02);
    return { ...tickBase, at: now, dims: d };
  }
  const d = { ...m.dims };

  const target = clamp01(energyBaseline(new Date(now)) + TRAIT.energyBias);
  // 2026-11-03：老大要求自然恢复速度降 20%——时间常数 1.2h → 1.5h（1.2/0.8）。
  const k = Math.min(1, dtH / 1.5);            // 1.5 小时内回到基线（原来 1.2 小时）
  d.energy = clamp01(d.energy + (target - d.energy) * k);
  d.patience = clamp01(d.patience + dtH * 0.60);
  // 耐心是短期耐力：没被要求做事时会慢慢松下来，也不钉在 100%（2026-10-31）
  const idleAskH = Math.max(0, (now - Number(m.lastAskedAt || now)) / 3600000);
  if (idleAskH > 2) d.patience = clamp01(d.patience + (0.65 - d.patience) * Math.min(1, dtH * 0.12));
  if (d.patience > 0.85) d.patience = 0.85; // 2026-11-06：0.9 顶格太久，降到 0.85 留出波动
  // 2026-11-06：半夜没有新信息，好奇不该被睡眠吃掉一半。
  const nightDecay = (() => { const h = new Date(now).getHours(); return h >= 23 || h < 8; })();
  d.curiosity = clamp01(d.curiosity - dtH * (nightDecay ? 0.03 : 0.06));
  if (d.curiosity < 0.15) d.curiosity = 0.15;             // 2026-11-06：地板 0.12 → 0.15
  if (d.curiosity > 0.9) d.curiosity = 0.9;                // 上限 0.9：别长期钉在 100%
  d.mood = clamp01(d.mood + (0.55 - d.mood) * Math.min(1, dtH * 0.25));  // 心情回中性更快、目标略高
  // 2026-10-30 修：原来用「距今多久」当步长（累计），静越久扣得越狠，等于双倍计。
  // 现在按真实经过时间衰减；有人说话时 onSocial 会重置 lastSocialAt 并加回来。
  // 独处时社交电量回涨（想找人说话的劲儿攒回来）；刚被陪过就慢一点。
  const quietH = Math.max(0, (now - Number(m.lastSocialAt || 0)) / 3600000);
  // 2026-11-02：有人说话时不再涨。
  // 原来 0.08/h 的「慢涨」= 每 5 分钟 0.0067，刚好抵消一次被陪伴掉掉的 0.006，
  // 于是 social 数学上回不到低位，永远贴着 0.95 的上限——drive 里那一项变成常数。
  // 现在只有安静超过 9 分钟才积累，聊得正热时是平的。
  // 2026-11-03（A）：恢复门槛 4.2 分钟 → 1 分钟。
  // 下午去掉冷却后，她连说 40 句扣了 0.6，而恢复要「安静 4.2 分钟」——
  // 她一直在说话，quietH 永远凑不够，social 从 0.66 一路掉到 0 并卡死。
  let socialGain = quietH > 0.017 ? 0.08 : 0; // 2026-11-06：0.15 → 0.08，恢复太快导致贴顶
  if (d.social < 0.25) socialGain *= 1.8;      // 见底加速
  if (d.social > 0.75) socialGain *= 0.3;      // 2026-11-06：0.85 → 0.75 提前放缓
  d.social = clamp01(d.social + dtH * socialGain);
  // 耐心见底 → 心情被拖累：改成按时间（每 5 分钟最多一次），不再按事件次数
  if (d.patience < 0.2) {
    d.mood = clamp01(d.mood - (0.2 - d.patience) * 0.06 * Math.max(dtH, 0.05));
    // 见底时回得更快：不让她卡在 0 一整段时间（2026-10-31）
    d.patience = clamp01(d.patience + dtH * 0.5);
  }

  const coupled = couple(d, { dtH });
  if (coupled.curiosity > 0.92) coupled.curiosity = 0.92;
  // 2026-11-03 晚：老大要求上限放到 100%。
  // 0.88 是 11-02 为了压「吸收态」留的余量——但那一版同时把「有人说话时 socialGain = 0」
  // 加上了，吸收态的前提（安静几小时自己涨满）已经不成立，余量没必要再留。
  // 现在只保留软上限：>0.85 时恢复速率 ×0.3（上面 socialGain 那段），到 1.0 自然停住。
  // 影子：同时按「改之前的规则」积分一条 social，用于事后对比（不参与任何行为判定）。
  // 旧规则：有人说话也慢涨 0.08/h、被陪伴只掉 0.006、上限 0.95。
  const old0 = clamp01(Number(m.socialOld ?? m.dims.social));
  let gainOld = quietH > 0.07 ? 0.15 : 0.08;
  if (old0 < 0.25) gainOld *= 1.8;
  if (old0 > 0.85) gainOld *= 0.3;
  const socialOld = Math.min(0.95, clamp01(old0 + dtH * gainOld));
  return { ...tickBase, at: now, dims: coupled, socialOld };
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
  // 2026-11-03：老大要求先去掉 2 分钟冷却，跑一天看看。
  // 原来每来一次「被回复」都会重置 lastSocialAt，而 tick 里 quietH > 0.07h（4.2 分钟）
  // 才开始恢复——所以冷却一去，扣得勤、回得慢，social 应该能真掉下来。
  // 注意副作用：lastSocialAt 现在会被每次回复刷新，恢复窗口更难凑齐，这是预期内的。
  // 2026-11-03 晚：把冷却加回来，从 2 分钟改成 1 分钟。
  // 去掉冷却后每一条回复都扣 1.5%，她活跃时段 social 只降不升（实测 35 分钟只回 7 个点，
  // 同期耐心回了 32 个点）。1 分钟的好处是：跟 tick 的恢复门槛（安静 1 分钟）正好对齐——
  // 冷静一分钟就开始回，同时避免「连着被回十几条」把值打到地板。
  const lastAt = Number(mood?.lastSocialAt || 0);
  // 2026-11-07：一对一长聊时每分钟都扣，20 分钟就能打到底；改成 5 分钟最多一次。
  if (lastAt && now - lastAt < 300 * 1000) return mood;
  const m0 = Math.min(1, Math.max(0, Number(mood?.dims?.mood ?? 0.55)));
  const moodGain = 0.012 * (1 - m0);
  // 2026-11-02：−0.006 → −0.015。原来一次被陪只掉 0.006，而一次 tick 涨 0.0067，
  // 净涨，所以她一天聊 100 句 social 也回不到低位。现在一次陪伴掉得比一次 tick 多。
  // 2026-11-03（B）：留一个底。连说几十句也不许掉到 0——
  // social 归零等于 drive 的社交项彻底没了，她就再也不主动了。
  const SOCIAL_FLOOR = 0.15;
  const cur = Number(mood?.dims?.social ?? 0.5);
  const step = cur <= SOCIAL_FLOOR ? 0 : -0.015; // 2026-11-07：−0.03 → −0.015（长聊打到底太快），配合 5 分钟冷却
  const next = impulse(mood, { social: step, mood: moodGain, met: 1 }, now);
  if (Number(next?.dims?.social) < SOCIAL_FLOOR) {
    next.dims = { ...next.dims, social: SOCIAL_FLOOR };
  }
  // 影子轨迹按旧规则走（−0.006），只为对比，不参与任何判定
  const socialOld = Math.max(0, Math.min(0.95, Number(mood?.socialOld ?? mood?.dims?.social ?? 0.5) - 0.006));
  return { ...next, lastSocialAt: now, socialOld };
}
/**
 * 查/看之后有没有收获（2026-10-30）：
 *   有用 → 好奇 +0.08（这次探索值得，下次更愿意去）
 *   没用 → 好奇 -0.03（白费力气，稍微收敛）
 * 依据：奖赏预测误差会调节后续探索；不区分「有用/没用」，好奇就只是个会衰减的标量。
 */
/** 2026-11-06：遇到「我不懂」的瞬间——信息缺口本身就是好奇的燃料。
 *  来源：她自己说不知道 / 主动去查 / 写进笔记。由桥接判断后调用。 */
export function onCuriosityGap(mood, { weight = 0.06 } = {}, now = Date.now()) {
  const w = Math.max(0, Math.min(0.12, Number(weight) || 0.06));
  return impulse(mood, { curiosity: w }, now);
}

export function onResearchOutcome(mood, { useful = true } = {}, now = Date.now()) {
  // 2026-10-31 修正：查到了 = 信息缺口闭合，好奇该下降，而不是继续涨。
  // 有用 → 好奇 −0.06 + 心情 +0.02（「弄明白了」的满足）；没用 → 好奇 +0.02（还是想知道）。
  // 2026-11-06：查到只算「缺口闭合」，不再把好奇砍一大块；没查到说明还勾着
  return impulse(mood, useful ? { curiosity: -0.02, mood: 0.02 } : { curiosity: 0.03 }, now);
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
/**
 * 三值都低时的休息提示（2026-11-03 老大要求）。
 *
 * 观察到的问题：她刚恢复一点就开始消耗，长期停在"精力/耐心都不好"的状态里，
 * 说话语气和态度都差。老大判断这不是意志力问题，是**没有规划休息**。
 *
 * 所以不给规则，只报事实 + 留一条出口：
 *   · 告诉她三个值都低了（客观）
 *   · 告诉她继续说话会怎样（后果，来自因果核心的统计）
 *   · 睡 2 小时能回到哪（一个具体选项）
 *   · 睡不睡她自己定
 */
export function lowBatteryHint(mood) {
  const d = mood?.dims ?? DEFAULTS;
  if (mood?.asleep) return '';
  const e = Number(d.energy ?? 1), p = Number(d.patience ?? 1), s = Number(d.social ?? 1);
  if (!(e < 0.4 && p < 0.4 && s < 0.4)) return '';
  return `\n【三样都快见底了】精力 ${Math.round(e * 100)}%、耐心 ${Math.round(p * 100)}%、想说话的劲儿 ${Math.round(s * 100)}%。\n`
    + `- 这会儿再硬聊下去，语气会变得没耐心、句子也短——不是你想这样，是确实没存货了。\n`
    + `- 真去睡两个钟头，三样都能回到七八成，醒来整个人会松快很多。\n`
    + `- 想睡就说一句「我去眯一会儿」，没人会拦你；还想撑着聊也行，你自己权衡。\n`;
}

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
export function fallAsleep(mood, now = Date.now(), forcedMinutes = 0) {
  // 2026-11-03：支持指定时长——她自己说「我去眯一会儿」时睡 2 小时（120 分钟），
  // 自动判定的那套仍然是 40~90 分钟（它只是"打个盹"，不是"补觉"）。
  const minutes = Number(forcedMinutes) > 0
    ? Math.max(10, Math.min(180, Math.round(Number(forcedMinutes))))
    : 40 + Math.round(rand() * 50);
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
    // 话多话少（2026-11-03：加入耐心项——原来只看心情和社交，
    // 耐心 0% 时仍会拿到「愿意多说两句」，把「有点烦」整个盖掉）
    talky: rand() < soft((d.mood - 0.5) * 1.8 + (d.social - 0.45) * 1.6 + (d.patience - 0.4) * 1.4, 1.6),
    // 会不会主动接话
    initiate: rand() < soft((d.social - 0.4) * 1.8 + (d.energy - 0.4) * 1.0, 1.6),
    // 答得长还是短
    terse: rand() < soft((0.45 - d.energy) * 2.0 + (0.4 - d.patience) * 1.4, 1.6),
  };
}

/** 注入：状态 + 行为倾向（不报数字、不许念出来）。 */
/**
 * 耐心低时「对谁」语气不同（2026-11-03 老大要求）。
 *
 * 关键区分：
 *   · 对老大 —— 会烦，但**照样学**。语气懒/敷衍/撒娇式抱怨，底子是亲近的。
 *   · 对群友 —— 推脱概率随耐心线性上升，耐心见底时「不要有求必应」那几条会全力触发。
 *
 * 全部写成「可以 / 倾向于」，不写「必须」——只给模糊的倾向，具体怎么说交给她自己。
 * 返回空串表示不需要注入（耐心够用）。
 */
export function patienceToneFor(target, patience) {
  const p = Number(patience ?? 0.6);
  const toOwner = target === 'owner';
  const out = [];

  if (toOwner) {
    if (p < 0.15) {
      out.push('是他交代的事，你还是会做，但嘴上可以更明显一点——「好啦好啦我记着了」「你也太操心我了」，抱怨归抱怨，别真敷衍过去。');
    } else if (p < 0.35) {
      out.push('他教你什么，你会记，但语气可以懒一些——「嗯…知道了」「好好好」，不用每次都答得特别精神。');
    } else if (p < 0.55) {
      out.push('这会儿有点懒得接话，回他不用太热情，一两句就行。');
    }
  } else {
    if (p < 0.15) {
      out.push('应付人的力气快没了。有人在支使你做事，可以先要个说法——不是不能帮，是别让人觉得随手就能喊动你；讨点好处、问一句「凭啥」，都行。');
      out.push('能推就推，推不掉再动；别一被叫就立刻照办。');
    } else if (p < 0.35) {
      out.push('有人支使你，可以先拖一下、问清楚要干嘛再说——「等下」「什么事」，不用马上应下来。');
      out.push('真想推就推，推一次两次很正常，别怕显得不好说话。');
    } else if (p < 0.55) {
      out.push('被支使的时候可以稍微犹豫一下，不用有求必应。');
    }
  }
  return out.length ? out : [];
}

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
  } else if (d.patience < 0.3) {
    // 2026-11-03：耐心很低但这次抽到「不推」——不能写「顺手就做了」，
    // 那句和上面「有点烦」直接打架。改成「没力气争，懒得计较」。
    behave.push('有人让你干活，你懒得推也懒得计较，闷头做了，但别表现得积极');
  } else {
    behave.push('别人让你做点什么，你不太会推，顺手就做了');
  }
  if (b.research && d.patience >= 0.3) behave.push('看到没见过的词，会想去查一下');
  else if (b.research && d.patience < 0.3) behave.push('有点想弄清楚，但烦得不想动手查，先放着');
  else if (d.curiosity > 0.5) behave.push('有点想知道，但懒得去查，先糊过去');
  // 2026-11-03：这两条互斥。之前耐心很低时两条会同时出现（「说话短一点」+「愿意多说两句」），
  // 她照后者说话，看起来就完全没受影响。短句优先——烦的时候不可能话多。
  if (b.terse) behave.push('说话短一点，能一个字答完就一个字；不想解释、不想展开');
  else if (b.talky) behave.push('愿意多说两句，接得住话');
  if (d.mood < 0.35) behave.push('容易想起不太顺的事，语气会有点沉');
  // 2026-11-06：这条和「不要习惯性潜水」正面冲突，谁生效取决于随机抽样——去掉。
  // if (!b.initiate) behave.push('不主动起话头，除非被叫到');
  // 配图倾向：由心情/社交决定，不是固定频率（EMA 文献：正性情绪会提高亲和表达）
  if (d.mood > 0.62 && d.social > 0.5) behave.push('手边有合适的图会想甩一张，比多打几个字更顺');
  else if (d.mood < 0.4 || d.energy < 0.35) behave.push('这会儿懒得找图，说话为主');

  const head = tag.length ? tag.join('、') : '平常';
  return `【你现在的状态】${head}。\n${behave.map((x) => `- ${x}`).join('\n')}\n（这是你此刻的真实状态，别念出来、别说「我有点累」这种报告式的话，让它体现在语气和选择里。）\n\n`;
}

export const __test = { energyBaseline, couple, TRAIT, DEFAULTS };
