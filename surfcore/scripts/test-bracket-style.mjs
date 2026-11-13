// 半括号机制单测（task-47）：统计/软自检行/冷却/研究检测/记录 schema
import { splitSentences, endsWithHalfBracket, containsBracket, bracketStyleStats, bracketStyleLine, shouldShowBracketLine, detectBracketResearch, bracketShadowRecord, BRACKET_DEFAULTS, BRACKET_CFG_DEFAULTS, resolveBracketStyleConfig, collectRecentSelfTexts, bracketStyleEmit } from '../src/bracket-style.js';

let pass = 0;
const ok = (name, fn) => { try { fn(); pass += 1; console.log(`PASS ${name}`); } catch (e) { console.error(`FAIL ${name}\n     ${e?.message ?? e}`); process.exitCode = 1; } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || 'eq'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
const assert = (c, m) => { if (!c) throw new Error(m || 'assert'); };

console.log('—— 句子/句尾判定 ——');
ok('splitSentences 保留语气并按 。！？；\\n 拆', () => {
  eq(splitSentences('粘死多省事（\n玩的时候得戴护目镜（'), ['粘死多省事（', '玩的时候得戴护目镜（']);
  eq(splitSentences('好的。收到！'), ['好的。', '收到！']);
});
ok('句尾半括号识别：半个算、完整不算、句号结尾不算', () => {
  eq(endsWithHalfBracket('粘死多省事（'), true);
  eq(endsWithHalfBracket('粘死多省事 ('), true);
  eq(endsWithHalfBracket('好的（。）'), false);
  eq(endsWithHalfBracket('好的。'), false);
});

console.log('—— 括号率统计 ——');
ok('最近 20 句比例 ≥60% → high(rate)', () => {
  const msgs = Array.from({ length: 20 }, (_, i) => `第${i}句随便说点什么（`);
  const st = bracketStyleStats(msgs);
  eq(st.window.length, 20); eq(st.trailing, 20); eq(st.rate, 1); eq(st.high, true); eq(st.reason, 'rate');
});
ok('连续 3 句句尾带（ → high(consecutive)', () => {
  const msgs = ['随便说一句', '第二句', '第三句', '粘死多省事（', '玩的时候得戴护目镜（', '夹着不会松吗（'];
  const st = bracketStyleStats(msgs);
  eq(st.consecutive, 3); eq(st.high, true); eq(st.reason, 'consecutive');
});
ok('比例低且不连续 → 不高', () => {
  const msgs = ['好的', '收到（', '今天天不错', '嗯嗯'];
  const st = bracketStyleStats(msgs);
  eq(st.trailing, 1); eq(st.high, false);
});
ok('窗口默认 20 句，只统计最近 N', () => {
  eq(BRACKET_DEFAULTS.windowSentences, 20);
  const msgs = [...Array(25)].map((_, i) => (i < 5 ? '不带括号' : '带括号（'));
  eq(bracketStyleStats(msgs).window.length, 20);
});

console.log('—— 句中「（」/消息级含率（20:00 修） ——');
ok('containsBracket 认句中括号：「看得见（ 有点羞」', () => {
  eq(containsBracket('不过你怎么连我躺床上都看得见（ 有点羞'), true);
  eq(containsBracket('那就好，我看着有点不对就来跟你说一声'), false);
});
ok('句中括号不算句尾，但消息含率会触发 high(message-contain)', () => {
  const msgs = ['不过…看得见（ 有点羞', '这次站起来了（ 我这是在自己屋里溜达呢', '行吧，监护人（ 看归看别笑我'];
  const st = bracketStyleStats(msgs);
  eq(st.trailing, 0); eq(st.consecutive, 0);
  eq(st.messageContain, 3); eq(st.messageContainRate, 1);
  eq(st.high, true); eq(st.reason, 'message-contain');
  const r = bracketStyleLine(msgs);
  assert(r.line.includes('句子中间'), r.line);
  assert(r.examples.length >= 2);
});
ok('连续 3 句含「（」（即使不是句尾）→ high(consecutive-contain)', () => {
  const msgs = ['好的', '收到', '第一句', '第二句', '第三句', '第四句', '这句看得见（ 有点羞', '这句也带着（ 中间有字', '还有这句（ 后面还有话'];
  const st = bracketStyleStats(msgs);
  eq(st.trailing, 0); eq(st.messageContainRate, 0.333);
  eq(st.consecutiveContain, 3); eq(st.high, true); eq(st.reason, 'consecutive-contain');
});
ok('消息含率阈值可配（containRateThreshold=0.8 时 3/5 不触发消息级）', () => {
  const msgs = ['a（ 后字', 'b（ 后字', 'c（ 后字', 'd（ 后字', 'e'];
  eq(bracketStyleStats(msgs).high, true); // 4/5=0.8，默认 0.7 触发
  eq(bracketStyleStats(msgs, { containRateThreshold: 0.85 }).high, false);
});

console.log('—— 软自检行 ——');
ok('高括号率生成软提示：含她自己的 2~3 个例子 + 开放问题', () => {
  const msgs = ['粘死多省事（', '玩的时候得戴护目镜（', '夹着不会松吗（'];
  const r = bracketStyleLine(msgs);
  assert(r && r.line, 'line');
  assert(r.examples.length >= 2 && r.examples.length <= 3, 'examples');
  assert(r.line.includes('粘死多省事'), 'real example');
  assert(r.line.includes('这是玩笑') || r.line.includes('玩笑'), 'open question');
  assert(r.line.length <= 200, 'not too long');
});
ok('文案不命令、不否定习惯（无必须/应该/不要/戒/少用/别用）', () => {
  const r = bracketStyleLine(['粘死多省事（', '玩的时候得戴护目镜（', '夹着不会松吗（']);
  const banned = /(必须|应该|不要|不准|禁止|别再|改掉|戒|少用|别用|尽量少)/;
  assert(!banned.test(r.line), r.line);
});
ok('不高返回 null', () => { eq(bracketStyleLine(['好的', '收到']), null); });

console.log('—— 冷却 ——');
ok('3h 内只提示一次（纯函数判定）', () => {
  const now = 1000 * 1000;
  eq(shouldShowBracketLine({ now, lastShownAt: null }), true);
  eq(shouldShowBracketLine({ now, lastShownAt: now - 60 * 60 * 1000 }), false);
  eq(shouldShowBracketLine({ now, lastShownAt: now - 3 * 60 * 60 * 1000 }), true);
});

console.log('—— 研究闭环检测（只检测不代写） ——');
ok('房间出现「研究：括号」→ 检测到，结论只摘录不重写', () => {
  const room = '## 16:00\n研究：括号\n我觉得括号是语气软化的标记，正经事可以不用。';
  const r = detectBracketResearch({ roomTexts: [room] });
  eq(r.detected, true); assert(r.herConclusion.includes('我觉得括号'), 'quote');
  assert(r.memoryHandoff && r.memoryHandoff.doNotRewrite === true);
});
ok('goal done 也识别；没痕迹时不误报', () => {
  eq(detectBracketResearch({ goal: { status: 'done', text: '研究括号用法' } }).detected, true);
  eq(detectBracketResearch({ selfTexts: ['今天天气不错'], roomTexts: ['吃了饭'] }).detected, false);
});

console.log('—— shadow schema ——');
ok('记录含 stats/high/emitted/line，可 JSON 序列化', () => {
  const r = bracketStyleLine(['粘死多省事（', '玩的时候得戴护目镜（', '夹着不会松吗（']);
  const rec = bracketShadowRecord({ at: Date.now(), key: 'group:1', result: r, emitted: true });
  eq(rec.t, 'bracket-style'); eq(rec.high, true); eq(rec.emitted, true);
  assert(rec.line.length > 0); JSON.stringify(rec);
});

console.log('—— 注入接线（纯函数） ——');
ok('config 默认 off，未知值→off，shadow/inject 识别', () => {
  eq(resolveBracketStyleConfig({}).mode, 'off');
  eq(resolveBracketStyleConfig({ socialV2: { bracketStyle: { mode: 'yes' } } }).mode, 'off');
  eq(resolveBracketStyleConfig({ socialV2: { bracketStyle: { mode: 'shadow' } } }).mode, 'shadow');
  eq(resolveBracketStyleConfig({ socialV2: { bracketStyle: { mode: 'inject' } } }).mode, 'inject');
});
ok('config 兼容 bridge 现在传入的 bracketStyle 子对象（不是完整 cfg）', () => {
  const sub = resolveBracketStyleConfig({ mode: 'shadow', windowMessages: 10, containRateThreshold: 0.8 });
  eq(sub.mode, 'shadow'); eq(sub.windowMessages, 10); eq(sub.containRateThreshold, 0.8);
  const full = resolveBracketStyleConfig({ socialV2: { bracketStyle: { mode: 'shadow', windowMessages: 12 } } });
  eq(full.mode, 'shadow'); eq(full.windowMessages, 12);
});
ok('config 数值覆盖/边界', () => {
  const c = resolveBracketStyleConfig({ socialV2: { bracketStyle: { mode: 'shadow', windowSentences: 99, rateThreshold: 0.1, cooldownMs: 1 } } });
  eq(c.windowSentences, 80); eq(c.rateThreshold, 0.3); eq(c.cooldownMs, 60000);
});
ok('collectRecentSelfTexts 只取 isSelf、过滤媒体、保序+限长', () => {
  const st = collectRecentSelfTexts([
    { isSelf: true, text: '第一句（' }, { isSelf: false, text: '别人的' },
    { isSelf: true, text: '[表情]' }, { isSelf: true, text: '第二句（' },
  ], 10);
  eq(st, ['第一句（', '第二句（']);
});
ok('mode=off：不统计不写日志不进 prompt', () => {
  const out = bracketStyleEmit({ cfg: { ...BRACKET_CFG_DEFAULTS, mode: 'off' }, recentSelfMessages: ['a（', 'b（', 'c（'] });
  eq(out.mode, 'off'); eq(out.show, false); eq(out.shadowRecord, null); eq(out.line, '');
});
ok('mode=shadow：高括号率写 shadowRecord，但不注入', () => {
  const out = bracketStyleEmit({ cfg: { ...BRACKET_CFG_DEFAULTS, mode: 'shadow' }, recentSelfMessages: ['粘死多省事（', '玩的时候得戴护目镜（', '夹着不会松吗（'] });
  eq(out.mode, 'shadow'); eq(out.show, false); assert(out.shadowRecord && out.shadowRecord.high, 'rec'); eq(out.shadowRecord.emitted, false); eq(out.line, '');
});
ok('mode=inject：冷却通过才 show + 冷却内不注入', () => {
  const msgs = ['粘死多省事（', '玩的时候得戴护目镜（', '夹着不会松吗（'];
  const now = 1000 * 3600 * 24;
  const a = bracketStyleEmit({ cfg: { ...BRACKET_CFG_DEFAULTS, mode: 'inject' }, recentSelfMessages: msgs, now, lastShownAt: null });
  eq(a.show, true); assert(a.line.includes('粘死多省事'), 'line'); eq(a.shadowRecord.emitted, true);
  const b = bracketStyleEmit({ cfg: { ...BRACKET_CFG_DEFAULTS, mode: 'inject' }, recentSelfMessages: msgs, now: now + 60 * 60 * 1000, lastShownAt: now });
  eq(b.show, false); eq(b.reason, 'cooldown');
});
ok('shadowRecord 带 mode/source，供 bridge 日志用', () => {
  const out = bracketStyleEmit({ cfg: { ...BRACKET_CFG_DEFAULTS, mode: 'shadow' }, recentSelfMessages: ['a（', 'b（', 'c（'], key: 'group:1' });
  eq(out.shadowRecord.mode, 'shadow'); eq(out.shadowRecord.source, 'bridge'); eq(out.shadowRecord.key, 'group:1');
});

console.log(`\n${pass} 项通过${process.exitCode ? '，有失败' : '，全部通过 ✅'}`);
