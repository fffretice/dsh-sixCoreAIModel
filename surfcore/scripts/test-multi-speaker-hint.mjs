#!/usr/bin/env node
// task-20 M2 单测：群聊多说话人窗口的指代自检「只在群聊 + ≥2 个不同说话人时出现」
// 用法：node scripts/test-multi-speaker-hint.mjs  退出码 0=PASS / 1=FAIL
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.SURFCORE_DIR || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
let ok = 0; const cases = [];
const check = (name, pass, got = '') => { cases.push({ name, pass, got }); if (pass) ok += 1; };

// ── 静态 ──
check('S1 helper 存在', /function multiSpeakerHintLine\(key, recentMessages = \[\]\)/.test(SRC));
check('S2 只对 group: 生效', /if \(!String\(key\)\.startsWith\('group:'\)\) return '';/.test(SRC));
check('S3 阈值是 ≥2 个说话人', /if \(speakers\.size < 2\) return '';/.test(SRC));
check('S4 已拼进 wake prompt base', /\+\s*quoteHint \+ multiSpeakerLine \+ (ownerUnansweredLine \+ )?(lateTurnLine \+ recentLinksLine \+ )?taskAnnounce/.test(SRC));
check('S5 文案含引用/称呼要求', /默认带上 replyToMessageId 或称呼/.test(SRC) && /好几个人在说话/.test(SRC));
check('S6 末尾含 M4 信息指引（29 字）', /最近几条是谁说的、几点的，看上面的引用列表，别只看最后一条/.test(SRC));

// ── 抽 helper ──
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  let paren = 0; let paramEnd = -1;
  for (let i = start + 1; i < src.length; i += 1) {
    if (src[i] === '(') paren += 1;
    else if (src[i] === ')') { paren -= 1; if (paren === 0) { paramEnd = i; break; } }
  }
  if (paramEnd < 0) return null;
  const open = src.indexOf('{', paramEnd);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}
const code = extractFunction(SRC, 'multiSpeakerHintLine');
const fn = new Function(`${code}\nreturn multiSpeakerHintLine;`)();
const now = Date.now();
const msg = (sender, minsAgo = 1, isSelf = false) => ({ sender, isSelf, time: now - minsAgo * 60e3 });

// ── 行为 ──
const g2 = fn('group:123', [msg('群友A'), msg('老大'), msg('群友A')]);
check('B1 群聊 2 个说话人 → 出现', g2.length > 0 && /好几个人在说话/.test(g2) && /默认带上 replyToMessageId 或称呼/.test(g2));
const g3 = fn('group:123', [msg('群友A'), msg('老大'), msg('Tan.')]);
check('B2 群聊 3 个说话人 → 人数正确', /刚有 3 个人在说话/.test(g3), g3.slice(0, 40));
const g1 = fn('group:123', [msg('群友A'), msg('群友A', 2), msg('群友A', 3)]);
check('B3 群聊只有 1 个说话人 → 不出现', g1 === '');
const priv = fn('private:999', [msg('老大'), msg('群友A')]);
check('B4 私聊即使多 sender → 不出现', priv === '');
const old = fn('group:123', [msg('群友A', 25), msg('老大', 26)]);
check('B5 窗口外的旧消息 → 不出现', old === '');
const selfOnly = fn('group:123', [msg('我', 1, true), msg('我', 2, true)]);
check('B6 只有她自己 → 不出现', selfOnly === '');
check('B7 空/非法输入 → 空串', fn('group:123', []) === '' && fn('group:123', null) === '' && fn('group:123', [{}]) === '');

const pass = ok === cases.length;
console.log(`MULTI-SPEAKER-HINT TEST ${pass ? 'PASS' : 'FAIL'}（${ok}/${cases.length}）`);
for (const c of cases) console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}${c.pass || !c.got ? '' : ` · got ${c.got}`}`);
process.exitCode = pass ? 0 : 1;
