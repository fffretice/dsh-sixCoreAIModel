// 2026-11-09：QQ「语音机会」软提示（私聊 + 群聊，群聊更严）。
// 只做判断/文案，不硬命令、不改人格卡、不写规则核心；状态由桥接存 social-v2。
// 依据 lead 需求：
//   · 私聊：① 22:30–23:30 且话很短/道晚安；② energy<0.35 且话很短；③ 情绪浓度高且话很短。
//   · 群聊（更严）：仅 allowlist 群（先只有 860），mood≥0.65 且 social≥0.6、最近 6 条氛围轻松、
//     她最近一条 ≤12 字（「本轮回复很短」在 prompt 时无法预知，用最近自发话长做代理）、非私密/敏感话题。
//   · 频控：全局 ≤2 条/天（私聊+群）、群 ≤1 条/天（跨群）、同群 3 天 ≤1 条、同一场景当天只提示一次、23:30 后不出现。
//   · 其他群：条件满足也只写 shadow 日志（would-hint），不注入。

export const DEFAULT_VOICE_OPPORTUNITY = {
  enabled: true,
  maxGlobalPerDay: 2,
  maxGroupPerDay: 1,
  maxGroupPer3Days: 1,
  sameScenePerDay: 1,
  hintAfter: 23 * 60 + 30,     // 23:30 后不出现
  lateNightStart: 22 * 60 + 30,
  lateNightEnd: 23 * 60 + 30,
  privateShortMaxChars: 15,
  groupShortMaxChars: 12,
  groupMoodMin: 0.65,
  groupSocialMin: 0.6,
  lowEnergyMax: 0.35,
  allowGroups: ['group:1000000002'],
  lightRecentCount: 6,
};

const DAY_MS = 86400e3;
export function localDayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function minutesOfDay(now) {
  const d = new Date(now);
  return d.getHours() * 60 + d.getMinutes();
}
export function normalizeOpp(st) {
  const o = st?.voiceOpportunity && typeof st.voiceOpportunity === 'object' ? st.voiceOpportunity : {};
  const arr = (x) => (Array.isArray(x) ? x.filter((v) => v && Number(v.at) > 0) : []);
  return { hinted: arr(o.hinted).slice(-100), sent: arr(o.sent).slice(-200) };
}

/** 最近消息氛围是否轻松（群聊用）：有表情/图/笑点/短接梗，且无争吵/严肃/敏感话题。 */
export function groupAtmosphereLight(recentMessages, { limit = 6 } = {}) {
  const recent = (Array.isArray(recentMessages) ? recentMessages : []).filter((m) => m && !m.isSelf).slice(-limit);
  if (!recent.length) return { light: false, reason: 'no-recent' };
  const text = recent.map((m) => String(m.text || '')).join('\n');
  if (/(吵|滚|闭嘴|傻逼|举报|投诉|生气|严肃|政治|去世|死|难过|隐私|密码|地址|电话|身份证|别在群|群里别|私聊说)/.test(text)) {
    return { light: false, reason: 'heavy-or-sensitive' };
  }
  const hasMedia = recent.some((m) => m.hasMedia || (Array.isArray(m.media) && m.media.length));
  const laughter = /(哈|笑|草|梗|乐|乐死|绷不住|逆天|离谱)/.test(text);
  const shortCount = recent.filter((m) => String(m.text || '').length <= 12).length;
  if (hasMedia || laughter || shortCount >= Math.min(3, recent.length)) return { light: true, reason: 'ok' };
  return { light: false, reason: 'not-light' };
}

function lastSelfText(recentMessages) {
  const self = (Array.isArray(recentMessages) ? recentMessages : []).filter((m) => m && m.isSelf && String(m.text || '').trim());
  return self.length ? String(self[self.length - 1].text || '').trim() : '';
}

/**
 * 场景判断（不含频控/状态）。返回 {scope:'private'|'group'|'shadow-group'|'', scene, reason, due}。
 */
export function detectVoiceScene({ key, now = Date.now(), mood = {}, recentMessages = [], cfg = DEFAULT_VOICE_OPPORTUNITY, ownerKey = '' } = {}) {
  const c = { ...DEFAULT_VOICE_OPPORTUNITY, ...(cfg || {}) };
  if (c.enabled === false) return { scope: '', scene: '', reason: 'disabled' };
  const dims = mood?.dims || mood || {};
  const energy = Number(dims.energy ?? 0);
  const moodV = Number(dims.mood ?? 0);
  const social = Number(dims.social ?? 0);
  const selfText = lastSelfText(recentMessages);
  const selfLen = Array.from(selfText).length;
  const minutes = minutesOfDay(now);
  if (minutes >= Number(c.hintAfter)) return { scope: '', scene: '', reason: 'after-23:30' };

  if (String(key).startsWith('private:')) {
    if (ownerKey && String(key) !== String(ownerKey)) return { scope: '', scene: '', reason: 'not-owner-private' };
    const lateNight = minutes >= Number(c.lateNightStart) && minutes < Number(c.lateNightEnd);
    if (lateNight && (selfLen <= c.privateShortMaxChars || /(晚安|睡了|困|睡觉|晚安啦)/.test(selfText))) {
      return { scope: 'private', scene: 'late-night', reason: 'ok', due: '现在是夜里，你要睡了；可以用很小声的一句语音道晚安' };
    }
    if (energy < Number(c.lowEnergyMax) && selfLen <= c.privateShortMaxChars) {
      return { scope: 'private', scene: 'low-energy', reason: 'ok', due: '你电量和力气都不多；一句短语音比打字更像真的在说话' };
    }
    if ((moodV >= 0.65 || social >= 0.6) && selfLen <= c.privateShortMaxChars) {
      return { scope: 'private', scene: 'emotion-high', reason: 'ok', due: '你现在心情不错；一句语音能把语气带出来' };
    }
    return { scope: '', scene: '', reason: 'no-scene' };
  }

  if (String(key).startsWith('group:')) {
    const allow = Array.isArray(c.allowGroups) ? c.allowGroups.includes(key) : true;
    if (!(moodV >= Number(c.groupMoodMin) && social >= Number(c.groupSocialMin))) {
      return { scope: '', scene: '', reason: 'mood-or-social-low' };
    }
    if (selfLen > Number(c.groupShortMaxChars)) return { scope: '', scene: '', reason: 'reply-too-long-proxy' };
    const atmo = groupAtmosphereLight(recentMessages, { limit: c.lightRecentCount });
    if (!atmo.light) return { scope: '', scene: '', reason: atmo.reason };
    const due = '群里气氛轻松、你心情也好；如果这轮只想接一句或道晚安，短语音比打字更自然';
    if (!allow) return { scope: 'shadow-group', scene: 'group-light', reason: 'group-not-allowlisted', due };
    return { scope: 'group', scene: 'group-light', reason: 'ok', due };
  }
  return { scope: '', scene: '', reason: 'unsupported-key' };
}

function counts(allStates, now) {
  const day = localDayKey(now);
  let globalSentToday = 0;
  let groupSentToday = 0;
  let hintedToday = 0;
  const groupLastSent = new Map();
  for (const { key, state } of Array.isArray(allStates) ? allStates : []) {
    const o = normalizeOpp(state);
    for (const s of o.sent) {
      const k = localDayKey(s.at);
      if (k === day) {
        globalSentToday += 1; // 仅诊断：私聊不计入任何日上限（老大 2026-11-09 改口径）
        if (String(s.scope) === 'group' || String(key).startsWith('group:')) groupSentToday += 1;
      }
      if (String(key).startsWith('group:')) {
        const prev = groupLastSent.get(key) || 0;
        if (Number(s.at) > prev) groupLastSent.set(key, Number(s.at));
      }
    }
    for (const h of o.hinted) if (localDayKey(h.at) === day) hintedToday += 1;
  }
  return { day, globalSentToday, groupSentToday, hintedToday, groupLastSent };
}

/** 提示门控：频控/场景当天去重/23:30 后。 */
export function voiceHintGate({ key, scene, now = Date.now(), state, allStates = [], cfg = DEFAULT_VOICE_OPPORTUNITY } = {}) {
  const c = { ...DEFAULT_VOICE_OPPORTUNITY, ...(cfg || {}) };
  if (c.enabled === false) return { ok: false, reason: 'disabled' };
  if (minutesOfDay(now) >= Number(c.hintAfter)) return { ok: false, reason: 'after-23:30' };
  const st = state || {};
  const o = normalizeOpp(st);
  const day = localDayKey(now);
  if (o.hinted.some((h) => localDayKey(h.at) === day && String(h.scene || '') === String(scene))) {
    return { ok: false, reason: 'scene-hinted-today' };
  }
  const k = counts([{ key, state: st }, ...(allStates || []).filter((x) => x && x.key !== key)], now);
  // 2026-11-09 老大改口径：语音频控只限群聊——私聊不设每日上限（其他场景/同场景当天一次仍保留）。
  if (String(key).startsWith('group:')) {
    if (k.groupSentToday >= Number(c.maxGlobalPerDay)) return { ok: false, reason: 'group-total-daily-cap' };
    if (k.groupSentToday >= Number(c.maxGroupPerDay)) return { ok: false, reason: 'group-daily-cap' };
    const last = k.groupLastSent.get(key) || 0;
    if (last && now - last < Number(c.maxGroupPer3Days) * 3 * DAY_MS) return { ok: false, reason: 'group-3day-cap' };
  }
  return { ok: true, reason: 'ok' };
}

/** 发送门控（硬）：真发语音前的频控（私聊+群合计 ≤2/天、群跨群 ≤1/天、同群 3 天 ≤1）。 */
export function voiceSendBlock({ key, now = Date.now(), state, allStates = [], cfg = DEFAULT_VOICE_OPPORTUNITY } = {}) {
  const c = { ...DEFAULT_VOICE_OPPORTUNITY, ...(cfg || {}) };
  if (c.enabled === false) return null;
  // 2026-11-09 老大改口径：私聊不设每日上限（直接放行）；群聊保持硬拦。
  if (!String(key).startsWith('group:')) return null;
  const k = counts([{ key, state: state || {} }, ...(allStates || []).filter((x) => x && x.key !== key)], now);
  if (k.groupSentToday >= Number(c.maxGlobalPerDay)) return `今天群语音已经 ${k.groupSentToday} 条（群语音总额 ≤${c.maxGlobalPerDay} 条/天），改回打字吧`;
  if (k.groupSentToday >= Number(c.maxGroupPerDay)) return `今天群里语音已经 ${k.groupSentToday} 条（群语音跨群合计 ≤${c.maxGroupPerDay} 条/天），改回打字吧`;
  const last = k.groupLastSent.get(key) || 0;
  if (last && now - last < Number(c.maxGroupPer3Days) * 3 * DAY_MS) return `这个群 ${Math.max(1, Math.round((now - last) / DAY_MS))} 天前发过语音（同群 3 天 ≤1 条），改回打字吧`;
  return null;
}

/** 生成软提示行（不硬命令）。 */
export function voiceOpportunityLine({ scope, scene, due, cfg = DEFAULT_VOICE_OPPORTUNITY } = {}) {
  const c = { ...DEFAULT_VOICE_OPPORTUNITY, ...(cfg || {}) };
  if (c.enabled === false) return '';
  if (scope === 'private') {
    return `\n【语音机会】${due || '现在适合发一句语音'}。想说就说，不想说就打字——可发可不发，别勉强。\n`;
  }
  if (scope === 'group') {
    return `\n【语音机会】群里发语音是更强的表达：${due || '心情好、话很短的时候才用'}。这轮如果只想接一句/道晚安，可以考虑发一条短语音；可发可不发，不发就打字。\n`;
  }
  return '';
}

/** 记录一次真发语音（返回更新后的 state.voiceOpportunity）。 */
export function recordVoiceSent(state, { now = Date.now(), key = '' } = {}) {
  const o = normalizeOpp(state);
  o.sent.push({ at: now, key: String(key || ''), scope: String(key || '').startsWith('group:') ? 'group' : 'private' });
  return { ...(state || {}), voiceOpportunity: { ...(state?.voiceOpportunity || {}), hinted: o.hinted, sent: o.sent.slice(-200) } };
}

/** 记录一次「提示已注入」（delivery 时调用）。 */
export function recordVoiceHint(state, { now = Date.now(), scene = '', key = '' } = {}) {
  const o = normalizeOpp(state);
  o.hinted.push({ at: now, scene: String(scene || ''), key: String(key || '') });
  return { ...(state || {}), voiceOpportunity: { ...(state?.voiceOpportunity || {}), hinted: o.hinted.slice(-100), sent: o.sent } };
}
