/**
 * 请求闸 v0 · 信息注入版（task-61，2026-11-11）
 *
 * 只回答三件事，作为「信息」给提示层，不强制接/拒：
 *   1) 谁想要什么（requester / want / kind）
 *   2) 要不要接（由她自己定；这里只给中性描述）
 *   3) 拒绝余地（高/中/低 + 理由，也只是一条信息）
 *
 * 同时把她的结果归成 accept | deflect | answer | refuse | ignore | unclear，
 * 供因果核心回收（v0 只 shadow，不写生产）。
 *
 * 纯函数，无 IO；不改行为/不写规则。
 */

export const REQUEST_KINDS = Object.freeze(['do', 'answer', 'tease', 'none']);
export const OUTCOMES = Object.freeze(['accept', 'deflect', 'answer', 'refuse', 'ignore', 'unclear']);

const TASK_SIG = /(帮我|帮忙|替我|给我|你来|你去|你帮|你给|弄一个|整一个|查一下|查查|画一[张个]|发一[张个]|发一下|发出来|发过来|发(?:这|那|一|个|张|到)|转发|发群|写一[段个]|写个|拍一[张个]|做一个|做一下|找一下|找找|看看这个|看一下|来一段|来点|表演|翻译|读一下|念一段|讲一下|说一下|算一下|数一下|回答|回我|来一句|唱一个|跳一个|试试|试试看|再试|测一下|收拾|去搜|去听|截图|附上|快回答|等会.{0,10}(发|做|看|来)|往.{0,6}发|把.{0,12}(发|给|拿|放|做|查|找))/;
const QUESTION_SIG = /(知不知道|知道吗|是什么|是啥|为什么|为啥|怎么会|哪个|哪部|哪家|多少|几点|谁[啊呀]?$|是不是|有没有|能不能|会不会|可以吗|行不行|问一下|问问|[?？]\s*$)/;
const TEASE_SIG = /(啵啵|抱抱|亲亲|贴贴|摸摸|舔|揍|扇|骂|打你|咬你|笨蛋|蠢|傻|煞笔|废物|败鱼|变态|色图|顶嘴|吃醋)/;
const REFUSE_SIG = /(不干|不帮|不做|不查|不画|不发|不写|不看|不接|不学|不试|不去|不要|不行|懒得|嫌累|好麻烦|麻烦死|不想|算了|下次吧|再说吧|没空|别想)/;
const DEFLECT_SIG = /(凭什么|你自己|你行你来|要不你来|你说呢|你猜|为啥是我|为什么是我|拿什么换|收费|收钱|得加钱|想得美|不告诉你|你管|[?？]\s*$)/;
const ACCEPT_SIG = /(^好|^行|^嗯|好呀|好啊|行吧|可以啊|^成|喏|收到|记住|^懂|我来|我去|这就|马上|安排|没问题|当然|给你|发你|挑了一张|那我|看了|试了|听了|照着|按你说的|我懂|我记着|这就去|发了|给你看|给你发)/;

const MEDIA = /^\[(图片|表情|动画表情|语音|拍一拍)/;
const strip = (t) => String(t || '')
  .replace(/\[CQ:[^\]]*\]/gi, ' ')
  .replace(/^(\s*@[^\s@]{1,32}\s*)+/u, '')
  .replace(/^\[@[^\]]*\]\s*/, '')
  .replace(/\s+/g, ' ').trim();
const clip = (s, n) => { const t = String(s || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/** 从请求句里抽「想要什么」：去掉称呼/礼貌词，保留动作短语。 */
export function extractWant(text = '', kind = 'do') {
  let t = strip(text)
    .replace(/^(老大|主人|群友)[，,、\s]*/u, '')
    .replace(/^你(?:这个?|个)?[，,、\s]*/u, '')
    .replace(/^(能不能|可不可以|可以|能不能麻烦你|麻烦你|请你|帮忙|帮我|替我|给我)[，,、\s]*/u, '')
    .replace(/[。！!～~]+$/u, '').trim();
  if (!t) return '';
  return clip(t, 60);
}

/**
 * @param {string} text
 * @param {{isOwner?:boolean,isDirect?:boolean,conversationKey?:string,sender?:string}} ctx
 */
export function detectRequest(text, ctx = {}) {
  const raw = String(text || '');
  const t = strip(raw);
  if (!t || MEDIA.test(t)) return { kind: 'none', confidence: 0, reasons: ['empty-or-media'] };
  const isOwner = ctx.isOwner === true;
  const isDirect = ctx.isDirect !== false;
  const addressed = ctx.atHer === true || /你/.test(t);
  const narrative = /^(我|我们|他|她|他们|助手小姐|助手鱼|豆包|PM鱼|ds superagent|superagent)/;
  const imperative = /^(帮我|给我|替我|你来|你去|你帮|你给|弄|整|查|画|发|写|拍|做|找|看|来|试|测|收拾|去搜|去听|截图|快回答|把)|你(要|先|去|来|帮|给|再|试)|能(帮|给|替)|能不能|可不可以|可以(帮|把)|请(你|帮)|麻烦你|再找找|找找|看看这个|试试看|研究研究|再试试/;
  const narrativeHelp = /(助手小姐|助手鱼|豆包|PM鱼|ds superagent|后台|我).{0,10}帮(助|忙|你)/;
  const strongImperative = /^(帮我|给我|替我|你来|你去|你帮|你给|弄|整|查|画|发|写|拍|做|找|看|来|试|测|收拾|去搜|去听|截图|快回答|把)|你(去|来|帮|给|先|再|试|要)|能(帮|给|替)|能不能|可不可以|可以(帮|把)|请(你|帮)|麻烦你|再找找|找找|看看这个|试试看|研究研究|再试试/;
  const futureNarrative = /^(以后|下次|将来|等你有|要是|如果你)/.test(t) && !/^(以后|下次).*(帮我|帮我做|记得)/.test(t);
  const laterImperative = (addressed || isOwner) && /等会.{0,12}(发|做|看|来)/.test(t);
  const askDo = TASK_SIG.test(t) && (strongImperative.test(t) || laterImperative) && !(narrative.test(t) && !strongImperative.test(t)) && !(narrativeHelp.test(t) && !strongImperative.test(t)) && !futureNarrative;
  const spam = /(姐妹们|兄弟们|转发|🚨|🤯|💻|我的天呐|！！！)/.test(t) || t.length > 120;
  const askQuestion = !askDo && !spam && QUESTION_SIG.test(t) && addressed && !narrative.test(t);
  const teaseSignal = /(啵啵|抱抱|亲亲|贴贴|摸摸|舔舔|揍揍|坏鱼鱼|骂一下我|揍一下我|让我抱|让我亲|摸摸)/.test(t)
    || /^(笨蛋|蠢|傻|煞笔|废物|败鱼)/.test(t)
    || /你(?:这|个|真|好)?(?:笨|蠢|傻|坏|凶)/.test(t);
  const pureAct = /^(啵啵|抱抱|亲亲|贴贴|摸摸|舔舔|揍揍)$/.test(t);
  const tease = TEASE_SIG.test(t) && teaseSignal && isDirect && (addressed || pureAct) && t.length <= 30;
  let kind = 'none'; let confidence = 0; const reasons = [];
  if (askDo) { kind = 'do'; confidence = 0.78; reasons.push('task-signal'); }
  else if (askQuestion) { kind = 'answer'; confidence = 0.72; reasons.push('question-signal'); }
  else if (tease) { kind = 'tease'; confidence = 0.6; reasons.push('tease-signal'); }
  else return { kind: 'none', confidence: 0.2, reasons: ['no-request-signal'] };
  if (isDirect) reasons.push('direct');
  if (isOwner) reasons.push('owner');
  else reasons.push('group-member');
  const want = extractWant(t, kind).replace(/[。！？!?～~]+$/u, '').trim();
  const requester = String(ctx.sender || (isOwner ? '老大' : '群友')).slice(0, 24);
  // 拒绝余地：只作信息，不是指令
  let refusalRoom = '中'; let roomWhy = '';
  if (kind === 'answer') { refusalRoom = '高'; roomWhy = '只是问事，答一句或不答都不算拒绝'; }
  else if (isOwner && String(ctx.conversationKey || '').startsWith('private:')) { refusalRoom = '低-中'; roomWhy = '私聊里他单独找你，可以跟他商量着推'; }
  else if (!isOwner && !isDirect) { refusalRoom = '高'; roomWhy = '群里没点你，可以当没看见'; }
  else if (kind === 'do') { refusalRoom = isOwner ? '中' : '中-高'; roomWhy = isOwner ? '他在跟你要，但怎么接你可以自己说' : '群友的请求，不是欠他的，可以接、反问或推'; }
  if (kind === 'tease') { refusalRoom = '中-高'; roomWhy = '这是逗你，不接也可以'; }
  return {
    kind, confidence, reasons,
    requester, requesterRole: isOwner ? 'owner' : 'member',
    want: want || clip(t, 60),
    raw: clip(t, 120),
    refusalRoom, roomWhy,
    conversationKey: ctx.conversationKey || '',
    isDirect, isOwner,
  };
}

/** 生成注入信息行（≤140 字；只给信息+选择，不命令）。 */
export function buildRequestInfoLine(detection, { maxChars = 150 } = {}) {
  if (!detection || detection.kind === 'none') return '';
  const who = detection.requester;
  let line;
  if (detection.kind === 'answer') {
    line = `【谁想要什么】${who}在问你：${clip(detection.want, 50)}。答不答、答多少，你定（拒绝余地：${detection.refusalRoom}）。`;
  } else if (detection.kind === 'tease') {
    line = `【谁想要什么】${who}在逗你：${clip(detection.want, 50)}。接不接、怎么接，你定（拒绝余地：${detection.refusalRoom}）。`;
  } else {
    line = `【谁想要什么】${who}想让你：${clip(detection.want, 50)}。要不要接、接多少，你定——可以接、可以反问、也可以推（拒绝余地：${detection.refusalRoom}，${detection.roomWhy}）。`;
  }
  return clip(line.replace(/\s+/g, ' '), maxChars);
}

/** 她回话后归结果（v0 shadow 用）。 */
export function classifyOutcome(replyText, detection = {}) {
  const t = strip(replyText);
  if (!t) return { outcome: 'ignore', confidence: 0.8, reasons: ['no-reply'] };
  if (REFUSE_SIG.test(t)) return { outcome: 'refuse', confidence: 0.75, reasons: ['refuse-marker'] };
  if (DEFLECT_SIG.test(t)) return { outcome: 'deflect', confidence: 0.7, reasons: ['deflect-marker'] };
  if (detection.kind === 'answer') return { outcome: 'answer', confidence: t.length <= 60 ? 0.7 : 0.6, reasons: ['answered-question'] };
  if (ACCEPT_SIG.test(t)) return { outcome: 'accept', confidence: 0.7, reasons: ['accept-marker'] };
  return { outcome: 'unclear', confidence: 0.4, reasons: ['no-marker'] };
}

/** 映射到现有因果核心 source；ignore/unclear 不写。 */
export function outcomeToCausalSource(outcome) {
  return ({ accept: 'request:accept', deflect: 'request:deflect', answer: 'request:answer', refuse: 'request:refuse' })[outcome] || null;
}

/** shadow 记录 schema。 */
export function buildShadowRecord({ at = Date.now(), key = '', detection = null, reply = null, outcome = null, infoLine = '', wouldInject = false, injectReason = '' } = {}) {
  return {
    t: 'request-intent', at: new Date(at).toISOString(), key, mode: 'shadow',
    request: detection ? {
      kind: detection.kind, requester: detection.requester, requesterRole: detection.requesterRole,
      want: detection.want, raw: detection.raw, refusalRoom: detection.refusalRoom, roomWhy: detection.roomWhy,
      confidence: detection.confidence, reasons: detection.reasons,
    } : null,
    infoLine, wouldInject, injectReason: injectReason || null,
    reply: reply == null ? null : clip(reply, 120),
    outcome: outcome ? { label: outcome.outcome, confidence: outcome.confidence, reasons: outcome.reasons, causalSource: outcomeToCausalSource(outcome.outcome) } : null,
  };
}
