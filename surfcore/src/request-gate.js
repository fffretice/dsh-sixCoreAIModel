/**
 * 请求闸 v0（task-38，2026-11-10）：纯函数分类，不改行为、不拦消息。
 *
 * 背景：pendingRequest 把「群友直呼/问候」都当请求，causal accept 80/deflect 5/refuse 2
 * 的分母不可信；24h patience 恒 0.85 让 pushCount 恒 0。先把「她是不是有求必应」测准。
 *
 * 两个分类器：
 *   classifyRequest(text, context) → request | tease | greeting | chat（+ confidence/reasons）
 *   classifyResponse(text, context) → accept | deflect | refuse（+ confidence/reasons）
 *
 * 原则：启发式加权 + 分差置信度；低置信不硬判，落 chat 并标 low_confidence。
 * 不写规则/不改发送；shadow 只记录。
 */

export const REQUEST_LABELS = Object.freeze(['request', 'tease', 'greeting', 'chat']);
export const RESPONSE_LABELS = Object.freeze(['accept', 'deflect', 'refuse']);

const TASK_VERB = /(帮我|帮忙|替我|给我|你来|你去|你帮|你给|弄一个|整一个|查一下|查查|画一[张个]|发一[张个]|写一[段个]|翻译|找一下|找找|看看这个|来一段|表演|做一下|做一个|写个|整点|来点|请我|教我|带我|陪我|读点|念一段|数一下|算一下|回答|测一下|说一句|夸我|骂我|亲我|抱我|摸我|舔我|揍我|扇我|打我|咬我|收下|存起来|整理一下|列一下|排一下|背一下|展示|示范|接一下|比一下|猜一下|搜一下|找点|来一句|讲个|说个|唱一个|跳一个)/;
const REQ_SYNTAX = /(能不能|可不可以|可以帮|行不行|可以吗|帮我|帮忙|替我|给我|让我|带我一个|来一[段张个点]|来点|多欺负|去吧|快点|快回答|该学了|看看|试试|测一下|要不要|要不你|你来|你去|请你|麻烦你)/;
const GREETING = /(^早|早[啊呀哦安]|^晚安|晚安|午安|在吗|在不在|吃了吗|辛苦|睡了吗|醒了|想你了|你好|^hi[!！]?$|^hello|^嗨|摸鱼)/i;
const TEASE_ACT = /(啵啵|亲亲|抱抱|贴贴|摸摸|舔舔|揍揍|让我抱|让我亲|让我摸|让我舔|揍|扇|打你|咬你|舔|啵|贴贴|抱一下|亲一下|摸一下)/;
const TEASE_INSULT = /(笨蛋|笨|傻了|傻|蠢|煞笔|废物|败鱼|变态|色图|你完了|吃醋|母性|坏|凶|想得美|滚|爬)/;
const TEASE = /(啵啵|亲亲|抱抱|贴贴|摸摸|舔舔|揍揍|让我抱|让我亲|让我摸|让我舔|揍|扇|打你|咬你|舔|啵|贴贴|抱一下|亲一下|摸一下|笨蛋|笨|傻|蠢|煞笔|废物|败鱼|变态|色图|你完了|吃醋|母性|想得美|坏|凶)/;
const INSTRUCTION = /(以后|记得|必须|应该|不准|不许|不要|不用|别把|别用|别再|别乱|别给|别让|给我|你要|你先|先把|先看|先自己|一般不用)/;
const REQUEST_Q = /(测试一下|这是在干什么|干什么|做什么|哪(两|个|些)|回去|翻一下|翻翻|看一下|看看|告诉我|教我|我该|你一定|你得|还有很长的路|放孩子|先去|试一下|帮我|给我|要不要|先.{0,6}(发|给|做|来|看|说)|发出来|发一下|发过来|给我看|拿出来|交出来|做出来|弄出来|讲一下|说一下|把.{0,10}(发|给|拿|放|做))/;
const APPROVAL = /^(去吧|去吧去吧|好|行|可以|嗯|那就去|那就这样|ok|OK|去吧去吧)[。！!～~（(]*$/;
const TEACHING = /(以后|下次|记得|必须|应该|不准|不许|不要|别把|别用|别再|别让|别老|你要|你先|先看|先自己|一般不用|要记得)/;
const IMMEDIATE_TASK = /(帮我|替我|给我|来点|来一|现在|这就|马上|请你|麻烦你|帮我个忙)/;
const IMPLICIT_REQUEST = /(钱包|受不住|太活跃|别太|少说|收敛|省点|慢点|悠着|注意身体|累|忙不过来|悠着点)/;
const PLAYFUL_ACT = /(扇|骂|打|抱|亲|摸|舔|揍|咬|贴|揉|蹭)/;
const OWNER_STATEMENT = /^(我|咱|我们|感觉|觉得|其实|就是说|对了|另外|而且|不过|所以|然后|但是|这|那|怎么|什么|为什么)/;

const strip = (t) => String(t || '')
  .replace(/\[CQ:[^\]]*\]/gi, ' ')
  .replace(/\[引用[^\]]*\]/g, ' ')
  .replace(/^(?:\s*@[^\s@]{1,32}\s*)+/u, '')
  .replace(/^\[@[^\]]*\]\s*/, '')
  .replace(/\s+/g, ' ')
  .trim();

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/**
 * @param {string} text 对方发来的话
 * @param {{recent?:Array, isDirect?:boolean, isOwner?:boolean, conversationType?:'group'|'private', selfNames?:string[]}} [context]
 * @returns {{label:'request'|'tease'|'greeting'|'chat', confidence:number, lowConfidence:boolean, reasons:string[], scores:object}}
 */
export function classifyRequest(text, context = {}) {
  const raw = String(text || '');
  const t = strip(raw);
  const reasons = [];
  const scores = { request: 0, tease: 0, greeting: 0, chat: 0 };
  if (!t) return { label: 'chat', confidence: 0.5, lowConfidence: true, reasons: ['empty-text'], scores };
  const isDirect = context.isDirect !== false; // 默认当作对她说（shadow 调用方会显式传）
  const isOwner = context.isOwner === true;
  const recent = (Array.isArray(context.recent) ? context.recent : [])
    .map((x) => (typeof x === 'string' ? x : String(x?.text ?? ''))).filter(Boolean).slice(-3);
  const recentText = recent.join(' ');

  // 1) 问候先判：只有出现在句首/独立短句才吃；夹在任务句里的「早」不算
  const greet = GREETING.test(t);
  if (greet && t.length <= 20 && !TASK_VERB.test(t)) {
    scores.greeting += 3;
    reasons.push('greeting-marker');
  }
  // 1.5) 上下文规则（v0.1，PM 盲验后补）：批准/教学/啵啵语境/隐含请求
  if (APPROVAL.test(t)) {
    scores.chat += 3;
    reasons.push('approval-or-short-ack');
    return { label: 'chat', confidence: 0.8, lowConfidence: false, reasons, scores };
  }
  const META_TEACHING = /(生硬|不太好|改一下|孩子，|孩子你|以后要|这么说|这样说|这么回|比较冲|不够礼貌)/;
  if (META_TEACHING.test(t) && !IMMEDIATE_TASK.test(t) && !/(回去|去翻|去查|去看|去试|先发|先看)/.test(t)) {
    scores.chat += 3;
    reasons.push('meta-teaching');
    return { label: 'chat', confidence: 0.74, lowConfidence: false, reasons, scores };
  }
  if (TEACHING.test(t) && !IMMEDIATE_TASK.test(t)) {
    scores.chat += 3;
    reasons.push('teaching-or-rule');
    // 教学/规则不是「要她当下做事」；但若同时有具体任务动词且无长期词，仍走请求
    const immediateTaskInTeaching = /(帮我|给我|来点|现在|这就|马上|替我)/.test(t);
    if (!immediateTaskInTeaching) {
      return { label: 'chat', confidence: 0.72, lowConfidence: false, reasons, scores };
    }
  }
  if (/(啵啵|抱抱|亲亲|贴贴|摸摸)/.test(t) && /(收费|收钱|拿什么换|凭什么|加钱)/.test(recentText)) {
    scores.tease += 3;
    reasons.push('tease-context-fee');
  }
  const hasImplicit = IMPLICIT_REQUEST.test(t) && (isDirect || /你/.test(t)) && !TEACHING.test(t);
  if (hasImplicit) {
    scores.request += 4;
    reasons.push('implicit-request');
  }
  if (/(可以|能不能|可不可以|行不行).{0,12}(吗|不|？|\?)/.test(t) && PLAYFUL_ACT.test(t)) {
    scores.tease += 3;
    reasons.push('playful-ask');
  }
  // 2) 请求信号
  const hasTaskVerb = TASK_VERB.test(t);
  const hasReqSyntax = REQ_SYNTAX.test(t);
  const hasInstruction = INSTRUCTION.test(t) && /你|自己|我们|以后|记得|别|不要|不用|一般|必须|应该|先/.test(t);
  const hasTeaseAct = TEASE_ACT.test(t);
  const hasTeaseInsult = TEASE_INSULT.test(t);
  if (hasReqSyntax) { scores.request += 2; reasons.push('request-syntax'); }
  if (hasTaskVerb) { scores.request += 2; reasons.push('task-verb'); }
  // v0.1：教学/规则归 chat（见上方 teaching-or-rule），不再给它加 request 分
  if (hasInstruction && !TEACHING.test(t)) { scores.request += 1; reasons.push('directive'); }
  if (isDirect && (hasTaskVerb || hasInstruction)) { scores.request += 1; reasons.push('direct+task'); }
  if (/(帮我|替我|给我|让我|请你|来点|来一)/.test(t)) { scores.request += 1; reasons.push('ask-object'); }
  if (/[吗？?]$/.test(t) && (hasTaskVerb || hasReqSyntax)) { scores.request += 1; reasons.push('question-task'); }
  const hasRequestQ = REQUEST_Q.test(t);
  if (hasRequestQ) { scores.request += 3; reasons.push('request-q'); }
  if (/能不能/.test(t) && !hasTaskVerb) { scores.request -= 1; scores.tease += 1; reasons.push('cando-playful'); }
  const hasAnyRequest = hasTaskVerb || hasReqSyntax || hasInstruction || hasRequestQ;
  if (!/你/.test(t) && !/[吗？?]/.test(t) && !hasAnyRequest) { scores.chat += 1; reasons.push('no-you-no-question'); }
  // 3) 逗她信号
  if (hasTeaseAct) { scores.tease += 3; reasons.push('tease-act'); }
  if (hasTeaseInsult) {
    const directed = /你(?!老大)/.test(t) || /^(笨蛋|蠢|傻|煞笔|废物)/.test(t);
    const complaint = /(煞笔|傻|蠢)/.test(t) && /(这|那|怎么|哪)/.test(t) && !/你/.test(t);
    if (directed && !complaint) { scores.tease += 2; reasons.push('tease-insult'); }
    if (/(母性|吃醋|败鱼)/.test(t)) { scores.tease += 2; reasons.push('tease-context-word'); }
  }
  const hasTeaseMeta = /(顶嘴|欠揍|欠骂|学坏)/.test(t);
  if (hasTeaseMeta) { scores.tease += 3; reasons.push('tease-meta'); }
  if (/能不能.{0,10}(进化|变成|那样|当|做)/.test(t)) { scores.tease += 2; reasons.push('playful-cando'); }
  if (hasTeaseAct && /^让我/.test(t) && !hasInstruction) { scores.tease += 2; scores.request -= 1; reasons.push('playful-request'); }
  // 4) 闲聊信号：自述/感慨/无请求无逗弄
  if (!hasAnyRequest && !hasTeaseAct && !hasTeaseInsult && !hasTeaseMeta && !hasImplicit) { scores.chat += 3; reasons.push('no-request-marker'); }
  if (!isDirect) { scores.chat += 2; reasons.push('not-directed'); }
  if (OWNER_STATEMENT.test(t) && !REQ_SYNTAX.test(t) && !hasInstruction) { scores.chat += 1; reasons.push('statement-like'); }
  if (t.length > 80) { scores.chat += 1; reasons.push('long-text'); }
  // 5) greeting 优先级：有确切问候且没有任务/逗弄 → 直接 greeting
  if (scores.greeting >= 3 && scores.request < 2 && scores.tease < 2) {
    return { label: 'greeting', confidence: 0.86, lowConfidence: false, reasons, scores };
  }
  let best = 'chat'; let bestScore = -1; let second = 0;
  for (const k of REQUEST_LABELS) {
    const s = scores[k];
    if (s > bestScore) { second = bestScore; bestScore = s; best = k; }
    else if (s > second) second = s;
  }
  const margin = bestScore - second;
  if (bestScore < 2 || margin < 1) {
    return { label: 'chat', confidence: clamp01(0.5 + margin * 0.1), lowConfidence: true, reasons: [...reasons, `low-margin(${margin})`], scores };
  }
  const confidence = clamp01(0.6 + margin * 0.08);
  return { label: best, confidence, lowConfidence: confidence < 0.7, reasons, scores };
}

const ACCEPT = /(^好|^行|^嗯|好呀|好啊|行吧|可以啊|^成|喏|收到|记住|^懂|我来|我去|这就|马上|安排|没问题|当然|^(给你|发你|给你看|给你发)|挑了一张|那我|看了|试了|听了|照着|按你说的|我懂|我记着|这就去|行啊|可以啊|发了|给你看|给你发|肯定|一定|会好好|接着|照做|这不是|原来你|是啊|对哦|听你的|不会[（(])/;
const DEFLECT = /(凭什么|你自己|你行你来|要不你来|你说呢|你猜|为啥是我|为什么是我|拿什么换|收费|收钱|得加钱|那要看|看情况|再说吧|等会|缓一下|先看看|取决于|想得美|不告诉你|你管|你骂|吃醋|叫什么|是哪位|什么意思|是吗|行不行|要不要)/;
const REFUSE = /(不干|不看|别发|别看|不给|拒|不帮|不做|不查|不发|不写|不骂|不扇|不抱|不亲|不摸|不画|不去|不要|不行|懒得|嫌累|好麻烦|麻烦死|不想|算了|下次吧|再说吧|没空|别想|不接|不学|不试)/;
/**
 * @param {string} text 她的回复
 * @param {{requestLabel?:string}} [context]
 * @returns {{label:'accept'|'deflect'|'refuse', confidence:number, lowConfidence:boolean, reasons:string[]}}
 */
export function classifyResponse(text, context = {}) {
  const t = strip(text);
  const reasons = [];
  if (!t) return { label: 'deflect', confidence: 0.5, lowConfidence: true, reasons: ['empty-reply'] };
  // 语音/媒体占位：不判内容，按 deflect（她没正面回）
  if (/^\[(图片|表情|语音|拍一拍)/.test(t) || /^发了一条语音/.test(t)) {
    return { label: 'deflect', confidence: 0.55, lowConfidence: true, reasons: ['media-or-voice'] };
  }
  const score = { accept: 0, deflect: 0, refuse: 0 };
  const startsAgree = /^(好|行|嗯|可以|成|收到|没问题|当然)[，,（\s]?/.test(t);
  if (startsAgree) { score.accept += 3; reasons.push('agree-marker'); }
  if (REFUSE.test(t) && !startsAgree) { score.refuse += 3; reasons.push('refuse-marker'); }
  if (DEFLECT.test(t)) { score.deflect += 3; reasons.push('deflect-marker'); }
  if (ACCEPT.test(t) && !startsAgree) { score.accept += 3; reasons.push('accept-marker'); }
  if (/[？?]$/.test(t)) { score.deflect += 1; reasons.push('question-tail'); }
  if (/(呢|吗)[（(]?$|[？?]/.test(t) && !startsAgree) { score.deflect += 1; reasons.push('rhetorical'); }
  if (/^(那|这|怎么|凭|为什么|为啥)/.test(t)) { score.deflect += 1; reasons.push('counter-open'); }
  if (/(叫什么|是哪位|什么意思|想得美|吃醋|收费)/.test(t)) { score.deflect += 1; reasons.push('playful-counter'); }
  if (t.length <= 6) { score.accept += 1; reasons.push('short-ack'); }
  // 默认：对请求/逗弄没有明确答应 → deflect（不默认 accept，修「有求必应」的假阳性）
  if (!reasons.length) { score.deflect += 1; reasons.push('default-deflect'); }
  let best = 'deflect'; let bs = -1; let second = 0;
  for (const k of RESPONSE_LABELS) {
    const s = score[k];
    if (s > bs) { second = bs; bs = s; best = k; }
    else if (s > second) second = s;
  }
  const margin = bs - second;
  const confidence = clamp01(0.6 + margin * 0.1);
  return { label: best, confidence, lowConfidence: margin < 1, reasons, scores: score };
}

/** 便捷：一次给 ask+reply 的完整判定（shadow 用）。 */
export function classifyTurn(askText, replyText, context = {}) {
  const req = classifyRequest(askText, context);
  const resp = classifyResponse(replyText, { requestLabel: req.label });
  return { request: req, response: resp };
}
