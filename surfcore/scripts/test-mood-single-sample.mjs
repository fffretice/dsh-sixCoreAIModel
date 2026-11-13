#!/usr/bin/env node
// task-23 A 单测：行为只抽一次（注入 == 落盘）
// 用法：node scripts/test-mood-single-sample.mjs  退出码 0=PASS / 1=FAIL
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.SURFCORE_DIR || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const MOOD = fs.readFileSync(path.join(ROOT, 'src', 'mood.js'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
let ok = 0; const cases = [];
const check = (name, pass, got = '') => { cases.push({ name, pass, got }); if (pass) ok += 1; };

// ── 静态 ──
check('S1 moodPromptLine 接受外部 behavior', /export function moodPromptLine\(mood, \{ behavior \} = \{\}\) \{/.test(MOOD));
check('S2 有 behavior 时不再内部抽样', /const b = behavior \|\| sampleBehavior\(mood\);/.test(MOOD));
check('S3 bridge 一轮只抽一次', (BRIDGE.match(/moodSampleBehavior\(moodSnapshot\)/g) || []).length === 1, String((BRIDGE.match(/moodSampleBehavior\(/g) || []).length));
check('S4 bridge 把同一份传给 moodPromptLine', /const behavior = moodSampleBehavior\(moodSnapshot\);\n\s+const moodLine = moodPromptLine\(moodSnapshot, \{ behavior \}\);/.test(BRIDGE));
check('S5 bridge 落盘用同一份 behavior', /saveMood\(\{ \.\.\.moodSnapshot, lastBehavior: behavior, lastPromptAt: Date\.now\(\) \}\)/.test(BRIDGE));
check('S6 dry 仍不落盘', /if \(!opts\.dry\) saveMood\(\{ \.\.\.moodSnapshot, lastBehavior: behavior/.test(BRIDGE));

// ── 抽 moodPromptLine ──
function extractFunction(src, name) {
  const start = src.indexOf(`export function ${name}(`);
  if (start < 0) return null;
  // 先找到参数列表的右括号（签名里可能有 { behavior } 解构），再找函数体的左花括号。
  let paren = 0;
  let paramEnd = -1;
  for (let i = start + 1; i < src.length; i += 1) {
    if (src[i] === '(') paren += 1;
    else if (src[i] === ')') { paren -= 1; if (paren === 0) { paramEnd = i; break; } }
  }
  if (paramEnd < 0) return null;
  const open = src.indexOf('{', paramEnd);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}
const code = (extractFunction(MOOD, 'moodPromptLine') || '').replace(/^export /, '');
const DEFAULTS = { energy: 0.5, patience: 0.8, mood: 0.6, social: 0.5 };
let sampleCalls = 0;
const make = (sampleResult) => new Function('DEFAULTS', 'sampleBehavior', 'Date',
  `${code}\nreturn moodPromptLine;`)(DEFAULTS, () => { sampleCalls += 1; return sampleResult; }, Date);
const stubBehavior = { procrastinate: true, pushCount: 3, research: false, talky: false, initiate: false, terse: false };
const mood = { dims: { ...DEFAULTS } };

// B1：传入 behavior → 0 次内部抽样，且内容反映该 behavior
{
  sampleCalls = 0;
  const fn = make({ procrastinate: false, pushCount: 0, research: false, talky: false, initiate: false, terse: false });
  const line = fn(mood, { behavior: stubBehavior });
  check('B1 传入 behavior 时内部 0 次抽样', sampleCalls === 0, String(sampleCalls));
  check('B2 注入文本使用传入的 behavior（推两三次）', /推个两三次/.test(line), line.slice(0, 80));
}
// B3：同一份 behavior 连续两次 → 文本完全一致（确定）
{
  const fn = make(stubBehavior);
  const a = fn(mood, { behavior: stubBehavior });
  const b = fn(mood, { behavior: stubBehavior });
  check('B3 同一行为对象两次调用文本一致', a === b);
}
// B4：不传 behavior → 仍内部抽 1 次（兼容旧调用）
{
  sampleCalls = 0;
  const fn = make({ procrastinate: false, pushCount: 0, research: false, talky: false, initiate: false, terse: false });
  fn(mood);
  check('B4 不传 behavior 时内部抽 1 次（旧调用兼容）', sampleCalls === 1, String(sampleCalls));
}
// B5：行为不同 → 注入不同（说明确实是传入那份在生效）
{
  const fn = make(stubBehavior);
  const a = fn(mood, { behavior: stubBehavior });
  const b = fn(mood, { behavior: { ...stubBehavior, procrastinate: false } });
  check('B5 不同 behavior 生成不同文本', a !== b);
}
// B6：睡着分支不抽样（不消耗）
{
  sampleCalls = 0;
  const fn = make(stubBehavior);
  fn({ dims: { ...DEFAULTS }, asleep: true, sleepUntil: Date.now() + 3600e3 });
  check('B6 睡着分支不抽样', sampleCalls === 0, String(sampleCalls));
}

const pass = ok === cases.length;
console.log(`MOOD-SINGLE-SAMPLE TEST ${pass ? 'PASS' : 'FAIL'}（${ok}/${cases.length}）`);
for (const c of cases) console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}${c.pass || c.got === '' ? '' : ` · got ${c.got}`}`);
process.exitCode = pass ? 0 : 1;
