// 2026-11-09（P1 规则污染）：owner 直呼消息自动进规则核心的**语义闸**。
// 背景：13:40:05 群 860 老大 @她调侃「…10块90系塞一起我就可以给你本地部署几百B的ds4.1」
// 被 noteTeaching → direct → addCoreRule 写进 AUTO:owner（rules-meta 13 条）。
// 这里只做纯判定：core（写规则核心）/ pending（转候选池让她自己认）/ skip（丢弃）。
// 原则：宁缺毋滥；群聊比私聊更严；规则句必须有祈使/规则标记；价格/交易/玩梗句不进核心。

export const DEFAULT_OWNER_RULE_GATE = {
  enabled: true,
  maxCharsGroup: 80,
  maxCharsPrivate: 200,
};

/** 去掉开头的 @昵称 与 CQ 码，返回真正对她说的话。 */
export function stripOwnerMentions(text) {
  return String(text ?? '')
    .replace(/\[CQ:[^\]]+\]/g, ' ')
    .replace(/^(?:\s*@[^\s@]{1,32}\s*)+/u, '')
    .trim();
}

// 2026-11-09（task-30 C）：判前剥前导连词（只用于判定，不改原文/入库文本）。
const LEAD_WORDS = /^(?:而且|还有就是|还有|不过|然后|所以|但是|但|并且|另外|顺便|对了|话说|其实)[，,、\s]*/;
export function stripTeachingLead(text) {
  let t = String(text ?? '').trim();
  for (let i = 0; i < 2; i += 1) { const n = t.replace(LEAD_WORDS, ''); if (n === t) break; t = n; }
  return t;
}

/** 是否有祈使/规则标记（必须有其一才可能进规则核心）。 */
export function hasRuleMarker(text) {
  const t = String(text ?? '');
  return /(不要|不准|不许|别再|别用|别说|别把|记得|以后|下次|必须|应该|得(?=把|去|先|给|用|说|回|听|按|带|看)|前提|第一|第二|尽量|最好|规则|规矩|要求|答应我|听我的|给我|帮我|你去|你要|你得|你先|先(?:把|去|看|研究|弄|查)|可以(?:说|做|用|发|问|当|直接)|允许|禁止|不用|不准)/.test(t);
}

/** 价格/交易/玩梗信号：和规则标记同时出现时转候选池，不写核心。 */
export function looksLikeJokeOrTrade(text) {
  const t = String(text ?? '');
  const price = /(?:\d+|[一二三四五六七八九十百千万两]+)\s*(?:块|元|毛|万|亿|[bB]\b|T\b|G\b|刀)/.test(t)
    || /(包邮|砍价|回收|报价|塞一起|免费送|出给|收个|卖个|代写|接单)/.test(t);
  const laugh = /(笑死|哈哈|草(?![里莓稿])|乐死|逆天|离谱|绷不住|梗图|开玩笑|逗你|真的假的|装傻)/.test(t);
  return { price, laugh, any: price || laugh };
}

/** @ 的是别人（不是她）——这类话不是对她说的。 */
export function mentionsOnlyOthers(text, selfNicknames = []) {
  const raw = String(text ?? '');
  const m = raw.match(/^\s*@([^\s@]{1,32})/u);
  if (!m) return false;
  const name = m[1];
  return !selfNicknames.some((n) => n && name.includes(n));
}

/**
 * 判定 owner 消息能不能直接进规则核心。
 * @returns {{ action:'core'|'pending'|'skip', reason:string }}
 */
export function classifyOwnerRule(text, {
  inPrivate = false,
  direct = false,
  selfNicknames = [],
  cfg = DEFAULT_OWNER_RULE_GATE,
} = {}) {
  const c = { ...DEFAULT_OWNER_RULE_GATE, ...(cfg || {}) };
  if (c.enabled === false) return { action: inPrivate || direct ? 'core' : 'pending', reason: 'gate-disabled' };
  const probe = stripTeachingLead(stripOwnerMentions(text));
  if (!probe) return { action: 'skip', reason: 'empty' };
  if (/[?？]\s*$/.test(probe)) return { action: 'skip', reason: 'question' };
  if (probe.length > (inPrivate ? c.maxCharsPrivate : c.maxCharsGroup)) return { action: 'skip', reason: 'too-long' };
  if (/https?:\/\//i.test(probe)) return { action: 'skip', reason: 'url' };
  if (mentionsOnlyOthers(String(text ?? ''), selfNicknames)) return { action: 'skip', reason: 'at-someone-else' };
  const joke = looksLikeJokeOrTrade(probe);
  const marker = hasRuleMarker(probe);
  // 群聊 @她 的玩梗/调侃：不进核心，转候选池（她自己认）；私聊也降级到候选池。
  if (joke.any) return { action: 'pending', reason: joke.price ? 'price-or-trade' : 'joke-or-banter' };
  if (!marker) return { action: 'pending', reason: 'no-rule-marker' };
  // 群聊直接 @ 她但不是明确规则句（含「我…给你」的叙述/玩笑）→ 候选池，不写核心。
  if (!inPrivate && /我.{0,12}(可以|能|会).{0,8}给你/.test(probe) && !/(以后|下次|记得|不要|别|必须|前提)/.test(probe)) {
    return { action: 'pending', reason: 'group-narrative-offer' };
  }
  if (!inPrivate && /^(仔细一想|感觉|我觉得|突然觉得|话说|对了)/.test(probe) && !/(以后|下次|记得|不要|别|必须|前提)/.test(probe)) {
    return { action: 'pending', reason: 'group-casual-lead' };
  }
  return { action: 'core', reason: 'ok' };
}

// 2026-11-09（task-30 A/D）：私聊预筛两级路由——core→批处理写规则；teaching-ish→仍进批处理/账本；junk→shadow。
export function routePrivateTeaching(line, { selfNicknames = [], cfg = DEFAULT_OWNER_RULE_GATE, isJunk = false } = {}) {
  if (isJunk) return { action: 'junk', reason: 'junk', gate: { action: 'skip', reason: 'junk' } };
  const g = classifyOwnerRule(line, { inPrivate: true, direct: true, selfNicknames, cfg });
  if (g.action === 'skip') return { action: 'junk', reason: g.reason, gate: g };
  if (g.action === 'core') return { action: 'core', reason: g.reason, gate: g };
  // teaching-ish：可能被 context/recordTeaching 接住；纯背景闲聊（连候选都不像）才 junk。
  if (!isDirectiveCandidate(line)) return { action: 'junk', reason: 'pure-chat', gate: g };
  return { action: 'teaching-ish', reason: g.reason, gate: g };
}

/** 轻量「像指令/候选」判定（只用于 B 层 recordTeaching null 时决定是否进候选池，避免纯闲聊污染候选池）。 */
export function isDirectiveCandidate(text) {
  const t = String(text ?? '');
  if (hasRuleMarker(t)) return true;
  return /不(?:管|要|准|许|能|用|得|会)|没(?:有)?|别|你|我|记得|以后|下次|必须|应该|得|群|不管|不是/.test(t);
}

/** teaching-drop-shadow 一行（D）：stage ∈ queue|note|recordTeaching，action ∈ core|teaching-ish|junk。 */
export function buildTeachingShadowEntry({ key = '', stage = 'queue', action = 'junk', reason = '', text = '', gate = null, at = new Date() } = {}) {
  return {
    at: (at instanceof Date ? at : new Date(at)).toISOString(),
    key: String(key || ''),
    stage: ['queue', 'note', 'recordTeaching'].includes(stage) ? stage : 'queue',
    action: ['core', 'teaching-ish', 'junk'].includes(action) ? action : 'junk',
    reason: String(reason || (gate?.reason || '')).slice(0, 40),
    text: String(text || '').slice(0, 80),
    gate: gate && typeof gate === 'object' ? { action: String(gate.action || ''), reason: String(gate.reason || '') } : null,
  };
}
