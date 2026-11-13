#!/usr/bin/env node
// task-20 M3 单测：群里对老大说的事 2~8h 没回应 → 提示私聊/带名字
// 用法：node scripts/test-m3-unanswered.mjs  退出码 0=PASS / 1=FAIL
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.SURFCORE_DIR || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
let ok = 0; const cases = [];
const check = (name, pass, got = '') => { cases.push({ name, pass, got }); if (pass) ok += 1; };

// ── 静态 ──
check('S1 纯函数 ownerUnansweredNotice 存在', /function ownerUnansweredNotice\(key, now, recent, privateRecent, ownerQQ\)/.test(SRC));
check('S2 与 M2 显式互斥', /if \(multiSpeakerLine\) return '';/.test(SRC));
check('S3 小时数动态填充', /你 \$\{hours\} 小时前在群里问老大的事/.test(SRC));
check('S4 已拼进 base（紧跟 M2）', /\+\s*quoteHint \+ multiSpeakerLine \+ ownerUnansweredLine \+ (lateTurnLine \+ recentLinksLine \+ )?taskAnnounce/.test(SRC));
check('S5 冷却读取 + 投递后标记（双构建安全）', /ownerUnansweredHintDay\.get\(key\) === day/.test(SRC) && /【群里问老大的事还没回】'\)\) ownerUnansweredHintDay\.set\(key/.test(SRC) && !/if \(!dryMode\) ownerUnansweredHintDay\.set\(key, day\)/.test(SRC));
check('S6 私聊最近 2h 老大没回也算条件', /privateRecent \|\| \[\]\)\.some\(\(x\) => isOwnerMsg\(x\)/.test(SRC));

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
const fn = new Function(`${extractFunction(SRC, 'ownerUnansweredNotice')}\nreturn ownerUnansweredNotice;`)();
const NOW = Date.parse('2026-11-09T08:00:00+08:00');
const h = (hoursAgo, extra = {}) => ({ isSelf: false, time: NOW - hoursAgo * 3600e3, ...extra });
const mine = (hoursAgo, text, extra = {}) => ({ isSelf: true, time: NOW - hoursAgo * 3600e3, text, ...extra });
const OWNER = '1000000001';
const own = (hoursAgo, id) => ({ isSelf: false, isOwner: true, userId: OWNER, time: NOW - hoursAgo * 3600e3, messageId: id || 'o' + hoursAgo });

// ── 行为 ──
{
  const line = fn('group:1', NOW, [mine(3, '老大，那套双人曲你打算订吗（')], [], OWNER);
  check('B1 3 小时前问老大、无人回 → 出现且小时数=3', /3 小时前/.test(line) && /私聊他/.test(line), line.slice(0, 60));
}
check('B2 1.5h 太新 → 不出现', fn('group:1', NOW, [mine(1.5, '老大在吗')], [], OWNER) === '');
check('B3 9h 太旧 → 不出现', fn('group:1', NOW, [mine(9, '老大在吗')], [], OWNER) === '');
check('B4 老大在群里回了 → 不出现', fn('group:1', NOW, [mine(3, '老大在吗'), own(2)], [], OWNER) === '');
check('B5 老大私聊回了 → 不出现', fn('group:1', NOW, [mine(3, '老大在吗')], [own(2)], OWNER) === '');
check('B6 私聊会话 key → 不出现', fn('private:999', NOW, [mine(3, '老大在吗')], [], OWNER) === '');
check('B7 没提老大/没引用 → 不出现', fn('group:1', NOW, [mine(3, '今晚吃啥')], [], OWNER) === '');
{
  const line = fn('group:1', NOW, [mine(4, '那个事你定了吗（', { replyToMessageId: 'msg-o-1' }), own(5, 'msg-o-1')], [], OWNER);
  check('B8 引用老大消息 → 出现（即使没写「老大」）', /4 小时前/.test(line), line.slice(0, 40));
}
{
  const line = fn('group:1', NOW, [mine(5, '老大这事'), mine(3, '老大那事')], [], OWNER);
  check('B9 多条候选取最新（3h）', /3 小时前/.test(line) && !/5 小时前/.test(line), line.slice(0, 30));
}
check('B10 小时数按最近整数（2.2→2）', /2 小时前/.test(fn('group:1', NOW, [mine(2.2, '老大在吗')], [], OWNER)));
check('B11 小时数上限 8（7.8→8）', /8 小时前/.test(fn('group:1', NOW, [mine(7.8, '老大在吗')], [], OWNER)));
check('B12 群主身份用 userId 也认（isOwner 缺省）', fn('group:1', NOW, [mine(3, '老大在吗'), { isSelf: false, userId: OWNER, time: NOW - 2 * 3600e3 }], [], OWNER) === '');

const pass = ok === cases.length;
console.log(`M3-UNANSWERED TEST ${pass ? 'PASS' : 'FAIL'}（${ok}/${cases.length}）`);
for (const c of cases) console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}${c.pass || !c.got ? '' : ` · got ${c.got}`}`);
process.exitCode = pass ? 0 : 1;
