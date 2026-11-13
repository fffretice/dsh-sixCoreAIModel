// 请求闸 v0（task-61）纯函数单测
import { detectRequest, extractWant, buildRequestInfoLine, classifyOutcome, outcomeToCausalSource, buildShadowRecord, REQUEST_KINDS, OUTCOMES } from '../src/request-intent-v0.js';

let pass = 0;
const ok = (name, fn) => { try { fn(); pass += 1; console.log(`PASS ${name}`); } catch (e) { console.error(`FAIL ${name}\n     ${e?.message ?? e}`); process.exitCode = 1; } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || 'eq'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
const assert = (c, m) => { if (!c) throw new Error(m || 'assert'); };
const D = (text, ctx = {}) => detectRequest(text, { isDirect: true, conversationKey: 'group:1', sender: '群友A', ...ctx });

console.log('—— 请求识别（do/answer/tease/none） ——');
ok('「帮我查一下明天天气」→ do', () => {
  const r = D('帮我查一下明天天气');
  eq(r.kind, 'do'); assert(r.want.includes('查'), r.want); eq(r.requesterRole, 'member');
});
ok('「能帮我查一下吗」仍是 do，不是 answer', () => eq(D('能帮我查一下吗').kind, 'do'));
ok('「你知不知道轰雷是什么」→ answer', () => eq(D('你知不知道轰雷是什么').kind, 'answer'));
ok('「等会5:14的时候你往群里发这张图」→ do', () => eq(D('等会5:14的时候你往群里发这张图').kind, 'do'));
ok('「这个前几天你发过，再找找？」→ do', () => eq(D('这个前几天你发过，再找找？').kind, 'do'));
ok('「助手小姐帮你弄好了，你再试试看」→ do', () => eq(D('助手小姐帮你弄好了，你再试试看').kind, 'do'));
ok('「啵啵」→ tease', () => eq(D('啵啵').kind, 'tease'));
ok('「今天天气不错」→ none', () => eq(D('今天天气不错').kind, 'none'));
ok('媒体占位 → none', () => eq(D('[图片]').kind, 'none'));
ok('owner 私聊请求：role=owner，拒绝余地低-中', () => {
  const r = D('等会帮我把图发群里', { isOwner: true, conversationKey: 'private:1', sender: '老大' });
  eq(r.kind, 'do'); eq(r.requesterRole, 'owner'); eq(r.refusalRoom, '低-中');
});
ok('群里没点她的陈述不误判 do（无信号→none）', () => eq(D('他昨天去钓鱼了', { isDirect: false }).kind, 'none'));

console.log('—— want / 拒绝余地 / 文案 ——');
ok('extractWant 去掉「帮我/能不能」保留动作', () => { assert(extractWant('能不能帮我查一下天气').includes('查一下天气')); });
ok('问事拒绝余地=高；群友请求=中-高', () => {
  eq(D('你知不知道轰雷是什么').refusalRoom, '高');
  eq(D('帮我查一下明天天气').refusalRoom, '中-高');
});
ok('文案只给信息：含谁/想要什么/你定，无命令词', () => {
  const r = D('帮我查一下明天天气');
  const line = buildRequestInfoLine(r);
  assert(line.includes('群友A'), line); assert(line.includes('你定'), line); assert(line.length <= 150);
  const banned = /(必须|应该|不准|禁止|一定要|赶紧)/; // 注意「要不要」是期望措辞
  assert(!banned.test(line), line);
});
ok('问事文案不强制回答', () => {
  const line = buildRequestInfoLine(D('你知不知道轰雷是什么'));
  assert(line.includes('答不答')); assert(!/(必须|应该)/.test(line));
});

console.log('—— 结果回收枚举 ——');
ok('do + 「行，我去查」→ accept → request:accept', () => {
  const x = classifyOutcome('行，我去查', { kind: 'do' });
  eq(x.outcome, 'accept'); eq(outcomeToCausalSource(x.outcome), 'request:accept');
});
ok('do + 「凭什么，你自己不会？」→ deflect', () => {
  const x = classifyOutcome('凭什么，你自己不会？', { kind: 'do' });
  eq(x.outcome, 'deflect'); eq(outcomeToCausalSource(x.outcome), 'request:deflect');
});
ok('do + 「不干，嫌累」→ refuse', () => {
  const x = classifyOutcome('不干，嫌累', { kind: 'do' });
  eq(x.outcome, 'refuse'); eq(outcomeToCausalSource(x.outcome), 'request:refuse');
});
ok('answer + 「是轰雷」→ answer', () => {
  const x = classifyOutcome('是轰雷', { kind: 'answer' });
  eq(x.outcome, 'answer'); eq(outcomeToCausalSource(x.outcome), 'request:answer');
});
ok('无回复 → ignore（不映射因果）', () => {
  const x = classifyOutcome('', { kind: 'do' });
  eq(x.outcome, 'ignore'); eq(outcomeToCausalSource(x.outcome), null);
});
ok('无标记 → unclear（不映射）', () => {
  const x = classifyOutcome('哦这样啊', { kind: 'do' });
  eq(x.outcome, 'unclear'); eq(outcomeToCausalSource(x.outcome), null);
});
ok('枚举完整', () => { eq(REQUEST_KINDS, ['do', 'answer', 'tease', 'none']); eq(OUTCOMES, ['accept', 'deflect', 'answer', 'refuse', 'ignore', 'unclear']); });

console.log('—— shadow 记录 ——');
ok('记录含 request/infoLine/wouldInject/outcome/causalSource', () => {
  const r = D('帮我查一下明天天气');
  const line = buildRequestInfoLine(r);
  const rec = buildShadowRecord({ at: Date.now(), key: 'group:1', detection: r, reply: '行，我去查', outcome: classifyOutcome('行，我去查', r), infoLine: line, wouldInject: true });
  eq(rec.t, 'request-intent'); eq(rec.mode, 'shadow'); eq(rec.request.kind, 'do');
  eq(rec.outcome.label, 'accept'); eq(rec.outcome.causalSource, 'request:accept');
  assert(rec.infoLine.length > 0); JSON.stringify(rec);
});

console.log(`\n${pass} 项通过${process.exitCode ? '，有失败' : '，全部通过 ✅'}`);
