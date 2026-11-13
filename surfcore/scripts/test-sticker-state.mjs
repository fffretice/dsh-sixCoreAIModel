#!/usr/bin/env node
// task-18 单测：lastStickerSent 持久化 + 自动补图取消判断
// 只读 bridge.js 源码做静态断言；再用桩件跑 saveSocialV2State 的 roundtrip。
// 用法：node scripts/test-sticker-state.mjs
// 退出码：0=PASS，1=FAIL。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.SURFCORE_DIR || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
let passed = 0; const cases = [];
const check = (name, ok, got = '') => { cases.push({ name, ok, got }); if (ok) passed += 1; };

// ── 静态断言：A 持久化 3 处 + B helper + C 日志 ──
check('A1 save 白名单含 lastStickerSent', /lastStickerSent:\s*\(st\.lastStickerSent && Number\(st\.lastStickerSent\.at\) > 0\)/.test(SRC));
check('A2 load 归一化含 lastStickerSent（旧状态→null）', /lastStickerSent:\s*\(val\.lastStickerSent && Number\(val\.lastStickerSent\.at\) > 0\)/.test(SRC));
check('A3 getSocialV2State 初始化 lastStickerSent: null', /lastStickerSent:\s*null,/.test(SRC));
check('B1 存在纯函数 lastStickerSentAt', /function lastStickerSentAt\(st\)/.test(SRC));
check('B2 预检闸用 lastStickerSentAt', /const lastSent0 = lastStickerSentAt\(st\);/.test(SRC));
check('B3 timer 取消判断用 lastStickerSentAt', /const lastSent = lastStickerSentAt\(st2\);/.test(SRC));
check('C1 原生表情日志改成「传输开始（非独立发送）」', /传输开始（非独立发送/.test(SRC));
check('C2 发送完成行（auto|tool）', /\[sticker\] 发送完成 \$\{key\}: #\$\{.*\}（\$\{options\.auto \? 'auto' : 'tool'\}）/.test(SRC));
check('C3 sendStickerV2 末尾仍写 lastStickerSent（原生/图片共用）', /st\.lastStickerSent = \{ no: updated\.entry\.no, at: Date\.now\(\) \};/.test(SRC));
check('C4 工具入口仍写 lastStickerSent', /stx\.lastStickerSent = \{ no: sent\.entry\?\.no \|\| null, at: Date\.now\(\) \};/.test(SRC));

// ── 抽函数工具 ──
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

// ── B 行为：lastStickerSentAt 口径 ──
const helperCode = extractFunction(SRC, 'lastStickerSentAt');
const lastStickerSentAt = helperCode
  ? new Function(`${helperCode}\nreturn lastStickerSentAt;`)()
  : () => { throw new Error('lastStickerSentAt 不存在'); };
check('B4 合法字段 → {at,no}', (() => {
  const r = lastStickerSentAt({ lastStickerSent: { no: '#31', at: 1794123456789 } });
  return r && r.at === 1794123456789 && r.no === '#31';
})());
check('B5 缺 at / at<=0 / 非数字 → null', [undefined, null, {}, { at: 0 }, { at: -1 }, { at: 'abc' }, { at: NaN }].every((v) => lastStickerSentAt({ lastStickerSent: v }) === null));
check('B6 at 字符串数字可归一化', lastStickerSentAt({ lastStickerSent: { no: 31, at: '1794123456789' } })?.at === 1794123456789);

// ── B 行为：取消判断（原生表情发出后，排队中的自动补图应取消） ──
const scheduledAt = 1794123456000;
const cancelIf = (st) => { const last = lastStickerSentAt(st); return !!(last && last.at > scheduledAt); };
check('B7 原生表情在排期后发出 → 取消', cancelIf({ lastStickerSent: { no: '#31', at: scheduledAt + 1 } }) === true);
check('B8 表情在排期前发出 → 不取消', cancelIf({ lastStickerSent: { no: '#31', at: scheduledAt - 1000 } }) === false);
check('B9 从没发过表情 → 不取消', cancelIf({}) === false);

// ── A 行为：saveSocialV2State roundtrip（桩件） ──
const saveCode = extractFunction(SRC, 'saveSocialV2State');
function runSave(st) {
  let captured = null;
  const socialV2 = { paused: false, conversations: new Map([['group:123', st]]) };
  const factory = new Function('SOCIAL_V2_FILE', 'atomicWriteJson', 'socialV2', 'seenForwardIds', 'log',
    `${saveCode}\nreturn saveSocialV2State;`);
  const save = factory('x.json', (file, obj) => { captured = obj; }, socialV2, new Map(), () => {});
  save();
  return captured?.conversations?.['group:123'];
}
const baseSt = {
  wakeConfig: {}, recentMessages: [], unread: [], lastWakeReason: '', lastAiReplyAt: 0, lastActionAt: 0,
  agentToken: 'tk', bootstrapSent: false, lastKfcDate: null, echoWake: null, textSinceSticker: 0,
  wakeTimes: [], sendTimes: [], stickerCollectTimes: [], lastIncomingAt: 0, lastHistoryMessageTime: 0,
  lastHistoryCheckedAt: 0, lastHistoryCatchup: null, resetMarkedAt: 0, preSleepWaitSatisfiedAt: 0,
  preSleepWaitObservedAt: 0, preSleepWaitAccumMs: 0, lastUnreadSeq: 0, lastReadThroughSeq: 0,
  activeTopics: [], pendingThoughts: [], pendingRequest: null, focusHit: null, postChatReflection: null,
  pendingTeachingReview: null, memberImpressions: {}, fishGuardLog: []
};
const savedValid = runSave({ ...baseSt, lastStickerSent: { no: '#31', at: 1794123456789 } });
check('A4 save roundtrip：合法 lastStickerSent 落盘', savedValid?.lastStickerSent?.no === '#31' && savedValid?.lastStickerSent?.at === 1794123456789, JSON.stringify(savedValid?.lastStickerSent));
const savedInvalid = runSave({ ...baseSt, lastStickerSent: { no: '#31', at: 0 } });
check('A5 save roundtrip：at<=0 → null', savedInvalid?.lastStickerSent === null, JSON.stringify(savedInvalid?.lastStickerSent));
const savedMissing = runSave({ ...baseSt, lastStickerSent: undefined });
check('A6 save roundtrip：旧状态无字段 → null', savedMissing?.lastStickerSent === null, JSON.stringify(savedMissing?.lastStickerSent));

// ── 输出 ──
const ok = passed === cases.length;
console.log(`STICKER-STATE TEST ${ok ? 'PASS' : 'FAIL'}（${passed}/${cases.length}）`);
for (const c of cases) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.ok || !c.got ? '' : ` · got ${c.got}`}`);
process.exitCode = ok ? 0 : 1;
