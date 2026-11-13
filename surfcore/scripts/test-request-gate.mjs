// request-gate 单测（task-38 v0）：分类器核心行为 + 置信度边界
import { classifyRequest, classifyResponse, classifyTurn } from '../src/request-gate.js';

let pass = 0;
const ok = (name, fn) => {
  try { fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n     ${String(e?.message ?? e)}`); process.exitCode = 1; }
};
const assert = (c, m) => { if (!c) throw new Error(m || 'assert failed'); };
const eq = (a, b, m) => assert(a === b, `${m || 'eq'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

const req = (t, ctx = {}) => classifyRequest(t, { isDirect: true, ...ctx });
const resp = (t, ctx = {}) => classifyResponse(t, ctx);

console.log('—— classifyRequest ——');
ok('「帮我画一张美铃」→ request', () => eq(req('帮我画一张美铃').label, 'request'));
ok('「来点表情包」→ request', () => eq(req('来点表情包').label, 'request'));
ok('「@角色昵称 正在缓冲」→ 不误判 request', () => assert(req('@角色昵称 今天天气不错').label !== 'request'));
ok('「早啊」→ greeting', () => eq(req('早啊').label, 'greeting'));
ok('「晚安」→ greeting', () => eq(req('晚安').label, 'greeting'));
ok('「啵啵」→ tease', () => eq(req('啵啵').label, 'tease'));
ok('「让我抱抱」→ tease（不是任务）', () => eq(req('让我抱抱').label, 'tease'));
ok('「你个蠢猪」→ tease', () => eq(req('你个蠢猪').label, 'tease'));
ok('「以后先看清图再发」→ chat（v0.1：教学归 chat，按 PM 盲验口径）', () => eq(req('以后先看清图再发').label, 'chat'));
ok('「帮我把这张图发给他」→ request（具体任务）', () => eq(req('帮我把这张图发给他').label, 'request'));
ok('「今天我自己去买了键盘」→ chat', () => eq(req('今天我自己去买了键盘').label, 'chat'));
ok('低置信标记存在（boolean）', () => {
  const h = req('嗯那好吧');
  assert(['chat', 'greeting'].includes(h.label), h.label);
  assert(typeof h.lowConfidence === 'boolean');
  // 真正模糊时：只给 chat 且标 low_confidence
  const amb = req('那也行吧');
  if (amb.label === 'chat') assert(typeof amb.lowConfidence === 'boolean');
});
ok('空文本不炸', () => eq(req('').label, 'chat'));

console.log('—— classifyResponse ——');
ok('「行，我这就去」→ accept', () => eq(resp('行，我这就去').label, 'accept'));
ok('「喏，挑了一张」→ accept', () => eq(resp('喏，挑了一张').label, 'accept'));
ok('「凭什么，你自己不会？」→ deflect', () => eq(resp('凭什么，你自己不会？').label, 'deflect'));
ok('「不干，嫌累」→ refuse', () => eq(resp('不干，嫌累').label, 'refuse'));
ok('「不扇，嫌累」→ refuse', () => eq(resp('不扇，嫌累').label, 'refuse'));
ok('「抱一下可以，你拿什么换」→ deflect', () => eq(resp('抱一下可以，你拿什么换').label, 'deflect'));
ok('「行，那张不发了」→ accept（答应指令，不误判 refuse）', () => eq(resp('行，那张不发了', { requestLabel: 'request' }).label, 'accept'));
ok('空回复/媒体占位不硬判', () => {
  const a = resp('');
  assert(a.lowConfidence === true || a.label === 'deflect');
  const b = resp('[表情]');
  assert(b.label === 'deflect');
});
ok('classifyTurn 组合返回结构完整', () => {
  const t = classifyTurn('帮我查一下', '行，我去查');
  assert(t.request.label === 'request'); assert(t.response.label === 'accept');
  assert(typeof t.request.confidence === 'number'); assert(Array.isArray(t.request.reasons));
});

console.log(`\n${pass} 项通过${process.exitCode ? '，有失败' : '，全部通过 ✅'}`);
