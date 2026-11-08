/**
 * 内在驱力（D，2026-10-30）
 *
 * 不是定时器，是「缺口」：社交缺口 + 好奇缺口 + 无聊 + 久未联系，
 * 合成一个 0~1 的 drive。drive 高说明她「想找人说点什么」；
 * 低说明她正满足/忙/困，不该被打扰。
 *
 * 依据：
 *   · 自我决定理论：归属（社交）、胜任、自主三种需要被满足时内在动机最高；
 *   · 好奇即信息缺口驱动探索（curiosity-driven learning）。
 */

const HOUR = 3600 * 1000;

export function computeDrive({ dims, lastContactAt = 0, now = Date.now(), asleep = false, groupActivity = 0, interest = 0, goalPull = 0 }) {
  const d = dims || {};
  const social = Number(d.social ?? 0.5);
  const curiosity = Number(d.curiosity ?? 0.5);
  const energy = Number(d.energy ?? 0.5);
  const mood = Number(d.mood ?? 0.5);

  // 2026-10-30：social 改为「社交电量」，越高越想说 → 缺口直接用本身，不再取反。
  const socialGap = Math.min(1, Math.max(0, social));
  const curiosityGap = Math.max(0, 1 - curiosity);    // 没新鲜事 → 想找点东西看
  const quietH = lastContactAt ? (now - lastContactAt) / HOUR : 6;
  // 2026-10-31 修：原来只算「多久没人说话」——群里越热闹，lastContactAt 越新，
  // 孤独项反而归零，变成「越热闹越不想加入」。这跟人相反。
  // 依据：Zajonc(1965) 社会促进（他人在场提高唤醒）；Baumeister & Leary(1995) 归属需求；
  //       Williams 的 ostracism 研究（在场却没被带上时，归属需求被威胁，反而更想重新连接）。
  // 所以孤独有两个来源：安静太久（想念），和热闹但插不进去（被勾起）。
  const quietPull = Math.min(1, quietH / 3);                       // 安静 3 小时 → 满
  const crowdPull = Math.max(0, Math.min(1, Number(groupActivity) || 0)) * 0.85;  // 热闹时最多 0.85，比彻底独处轻一点
  const loneliness = Math.max(quietPull, crowdPull);
  const lowMood = Math.max(0, 0.4 - mood) / 0.4;      // 心情低时更想被哄

  // 精力是闸门：太累就不想说话；精力高时才让驱力起作用
  const gate = Math.max(0, Math.min(1, (energy - 0.15) / 0.35));

  // 话题兴趣：群里正在聊她感兴趣的东西（尤其招牌词）时，「要不要插一句」的门槛会明显 lowering。
  // 不是加进求和里（那会打乱权重），而是当乘数——兴趣是放大器，不是新的缺口。
  const interestPull = Math.max(0, Math.min(1, Number(interest) || 0));
  // 1.08 的底数：即使没聊到她感兴趣的东西，群里有人说话时也有一点被带动的可能
  const interestBoost = 1.08 + 0.65 * interestPull;

  // 她自己惦记的事（goals 里还没做的）：放得越久越惦记（蔡格尼克效应）。
  // 这是独立于「想跟人说话」的另一条缺口——想去做点什么。
  const goal = Math.max(0, Math.min(1, Number(goalPull) || 0));

  let drive = (socialGap * 0.30 + curiosityGap * 0.20 + loneliness * 0.40 + lowMood * 0.10) * gate * interestBoost
            + goal * 0.15 * gate;
  if (asleep) drive = 0;
  drive = Math.max(0, Math.min(1, drive));
  return {
    drive: Math.round(drive * 100) / 100,
    parts: {
      socialGap: Math.round(socialGap * 100) / 100,
      curiosityGap: Math.round(curiosityGap * 100) / 100,
      loneliness: Math.round(loneliness * 100) / 100,
      quietPull: Math.round(quietPull * 100) / 100,
      crowdPull: Math.round(crowdPull * 100) / 100,
      interest: Math.round(interestPull * 100) / 100,
      interestBoost: Math.round(interestBoost * 100) / 100,
      goalPull: Math.round(goal * 100) / 100,
      lowMood: Math.round(lowMood * 100) / 100,
      gate: Math.round(gate * 100) / 100,
    },
    wantTalk: drive > 0.5,
  };
}

/** 注入用一行：只在真想说话时给，不报数字。 */
export function drivePromptLine(info) {
  if (!info || !info.wantTalk) return '';
  // 2026-11-07：驱力分叉。想说话 ≠ 只有说话这一条路；
  // 手上有没弄明白的事时，先问她一句「你是想说话，还是想弄明白点什么」。
  const fork = info.hasOpenWork
    ? `- 还有一条路：你手上有没弄明白的事。要是现在更想弄明白它，就去查，不用非得说话。\n`
    : '';
  return `\n【你现在有点想说话】不是到点了，是你自己有点闷、有点想找人搭一句。\n- 可以主动起个话头；但别一上来就说「我好无聊」，说点具体的（刚看到的、想到的）\n${fork}- 对方没接就算了，别追\n`;
}

export const __test = { computeDrive };
