#!/usr/bin/env node
// 2026-11-10 task-39 单测：事件层首轮兜底接线（shadow/inject/跨天/群私聊视图/互斥）
import fs from 'node:fs';
import path from 'node:path';
import {
  resolveFirstTurnMode, firstTurnMaxChars, firstTurnDay, normalizeBridgeState, markFirstTurnDay,
  rememberFirstTurnToken, recentInjectedTokensFor, decideFirstTurnFallback, firstTurnLineSafe, parseBridgeStateText,
  makePendingFirstTurn, consumePendingFirstTurn,
} from '../src/recent-events-firstturn.js';

const ROOT = process.env.SURFCORE_DIR || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
let ok = 0; const cases = [];
const check = (name, pass, got = '') => { cases.push({ name, pass, got }); if (pass) ok += 1; };
const now = Date.now();
const day = firstTurnDay(now);
const ev = (over = {}) => ({ text: over.text || '香名江话题（11-10 09:00，5人）', tokens: over.tokens || ['香名江'], aliases: over.aliases || ['香名江', '名江'], eventType: over.eventType || '实装', time: over.time || now - 3600e3, participants: over.participants ?? 5, active: true, score: 1, anchorEligible: true, ...over });
const data = (eventsByConv = {}, shared = []) => ({ generatedAt: now, windowHours: 48, conversations: Object.fromEntries(Object.entries(eventsByConv).map(([k, evs]) => [k, { events: evs }])), sharedEvents: shared });
const recent = (...texts) => texts.map((t) => ({ at: now - 1000, text: t }));
const cfgShadow = { mode: 'shadow', maxChars: 120 };
const cfgInject = { mode: 'inject', maxChars: 120 };

// 1) 状态/跨天
check('S1 默认 shadow / maxChars 120', resolveFirstTurnMode(null) === 'shadow' && firstTurnMaxChars(null) === 120);
check('S2 跨天重置（days 覆盖）', (() => { const s = markFirstTurnDay(normalizeBridgeState(null), 'group:1', '2026-11-09'); return s.days['group:1'] === '2026-11-09' && s.days['group:1'] !== day; })());
check('S3 token 只取前 2 天（不含今天）', (() => { let s = normalizeBridgeState(null); s = rememberFirstTurnToken(s, 'group:1', day, 't1'); s = rememberFirstTurnToken(s, 'group:1', '2026-11-08', 't2'); s = rememberFirstTurnToken(s, 'group:1', '2026-10-01', 'old'); const toks = recentInjectedTokensFor(s, 'group:1', { now }); return toks.includes('t2') && !toks.includes('old'); })());

// 2) shadow / inject / 过期 / 已标记
{
  const d = data({ 'group:860': [ev()] });
  const shadow = decideFirstTurnFallback({ data: d, convKey: 'group:860', now, cfg: cfgShadow, recentMessages: recent('香名江实装了') });
  check('S4 shadow: wouldLine 有、line 空', shadow.wouldLine.length > 0 && shadow.line === '' && shadow.mode === 'shadow', shadow.reason);
  const inject = decideFirstTurnFallback({ data: d, convKey: 'group:860', now, cfg: cfgInject, recentMessages: recent('香名江实装了') });
  check('S5 inject: line=wouldLine 且 ≤120', inject.line === inject.wouldLine && inject.line.length <= 120, String(inject.line?.length));
  const off = decideFirstTurnFallback({ data: d, convKey: 'group:860', now, cfg: { mode: 'off' } });
  check('S6 off: 空', off.line === '' && off.wouldLine === '' && off.reason === 'off');
  const stale = decideFirstTurnFallback({ data: { ...d, generatedAt: now - 40 * 60e3 }, convKey: 'group:860', now, cfg: cfgInject, recentMessages: recent('香名江实装了') });
  check('S7 文件过期 >30min: 空', stale.line === '' && stale.stale === true && stale.reason === 'stale-or-missing');
  const marked = decideFirstTurnFallback({ data: d, convKey: 'group:860', now, cfg: cfgInject, recentMessages: recent('香名江实装了'), alreadyMarked: true });
  check('S8 当天已标记: 空', marked.line === '' && marked.reason === 'already-marked-today');
}

// 3) 群/私聊视图（群只自身事件、私聊含 shared）
{
  const d = data({ 'group:860': [ev()] }, [ev({ text: '双人曲话题（11-10 08:00，4人）', tokens: ['双人曲'], aliases: ['双人曲'], eventType: '约定' })]);
  const g = decideFirstTurnFallback({ data: d, convKey: 'group:860', now, cfg: cfgInject, recentMessages: recent('香名江', '双人曲') });
  check('V1 群只取群来源（不含 shared）', g.wouldLine.includes('香名江') && !g.wouldLine.includes('双人曲'), g.wouldLine);
  const p = decideFirstTurnFallback({ data: d, convKey: 'private:1000000001', now, cfg: cfgInject, recentMessages: recent('香名江', '双人曲') });
  check('V2 私聊可取共享事件', p.wouldLine.length > 0, p.wouldLine);
  check('V3 视图安全检查', firstTurnLineSafe('【最近群里在聊】私聊的事', 'group:1') === false && firstTurnLineSafe('【最近群里在聊】香名江', 'group:1') === true && firstTurnLineSafe('x'.repeat(200), 'private:1') === false);
}

// 4) 去重输入（memoryTexts / recentInjectedTokens）与锚点
{
  const d = data({ 'group:860': [ev()] });
  const dedup = decideFirstTurnFallback({ data: d, convKey: 'group:860', now, cfg: cfgInject, recentMessages: recent('香名江实装了'), memoryTexts: ['香名江实装决定'] });
  check('D1 memoryTexts 含专名 → 不重复', dedup.wouldLine === '' && (dedup.reason === 'dedup-hit' || dedup.reason === 'no-qualified-event'), dedup.reason);
  const skip = decideFirstTurnFallback({ data: d, convKey: 'group:860', now, cfg: cfgInject, recentMessages: recent('香名江实装了'), recentInjectedTokens: ['香名江'] });
  check('D2 前 2 天注入过 → 跳过', skip.wouldLine === '' && skip.reason === 'recent-day', skip.reason);
  const noAnchor = decideFirstTurnFallback({ data: d, convKey: 'group:860', now, cfg: cfgInject, recentMessages: recent('今天天气不错') });
  check('D3 无锚点 → 不推', noAnchor.wouldLine === '' && (noAnchor.reason === 'no-recent-anchor' || noAnchor.reason === 'no-qualified-event'), noAnchor.reason);
}

// 4b) 状态文件安全退化（Lead 口径：缺失=正常；损坏=跳过本轮）
{
  const missing = parseBridgeStateText(null);
  check('F1 状态缺失=正常首次', missing.ok === true && missing.missing === true && missing.corrupt === false);
  const corrupt = parseBridgeStateText('{not json');
  check('F2 状态损坏=corrupt（调用方跳过）', corrupt.ok === false && corrupt.corrupt === true);
  const valid = parseBridgeStateText(JSON.stringify({ days: { 'group:1': day }, tokens: { 'group:1': [{ day, token: 'x' }] } }));
  check('F3 合法状态可解析', valid.ok === true && valid.state.days['group:1'] === day);
}
check('F4 bridge 状态损坏时跳过注入', /bridgeRead\.corrupt/.test(SRC) && /本轮跳过注入（宁可少注入一次）/.test(SRC));
check('F5 状态原子写', /atomicWriteJson\(RECENT_EVENTS_FIRSTTURN_STATE_FILE/.test(SRC));

// 4c) P2 修复：pending 只在投递成功消费；预览/dry 不落盘
{
  const shadowP = makePendingFirstTurn({ mode: 'shadow', day, line: '【最近群里在聊】x', event: { text: 'x' }, builtAt: now });
  const injectP = makePendingFirstTurn({ mode: 'inject', day, line: '【最近群里在聊】x', event: null, builtAt: now });
  check('P1 无 line 不生成 pending', makePendingFirstTurn({ mode: 'shadow', day, line: '' }) === null && makePendingFirstTurn({ mode: 'off', day, line: 'x' }) === null);
  check('P2 shadow/inject pending 生成', shadowP?.mode === 'shadow' && injectP?.mode === 'inject' && Boolean(shadowP?.builtAt));
  check('P3 shadow 投递成功即消费（不要求 prompt 含行）', consumePendingFirstTurn(shadowP, { now, promptText: '不含行' }).consume === true);
  check('P4 inject 必须 prompt 含行', consumePendingFirstTurn(injectP, { now, promptText: '不含行' }).consume === false && consumePendingFirstTurn(injectP, { now, promptText: injectP.line }).consume === true);
  check('P5 pending 过期不消费', consumePendingFirstTurn(shadowP, { now: now + 10 * 60e3, promptText: '' }).reason === 'stale-pending');
  const m = new Map([['group:1', shadowP]]);
  const v1 = consumePendingFirstTurn(m.get('group:1'), { now, promptText: '' });
  m.delete('group:1');
  check('P6 一次投递只消费一次（删后无 pending）', v1.consume && !m.get('group:1'));
}
check('P7 无 wouldLine 分支不写 days', !/if \(!wouldLine \|\| !firstTurnLineSafe[\s\S]{0,300}?writeFirstTurnBridgeState/.test(SRC) && /无 wouldLine 不写 days/.test(SRC));
check('P8 shadow 走 pending、build 不落盘', /shadow 也走 pending/.test(SRC) && !/if \(mode === 'shadow'\) \{[\s\S]{0,200}?writeFirstTurnBridgeState/.test(SRC));
check('P9 delivery 标记传到 helper', /delivery: Boolean\(opts\?\.delivery\)/.test(SRC) && (SRC.match(/delivery: true/g) || []).length >= 2);
check('P10 投递成功消费 pending', /consumePendingFirstTurn\(pend, \{ now: Date\.now\(\), promptText: text \}\)/.test(SRC) && /verdict\.write === 'shadow'/.test(SRC));

// 5) bridge 接线静态
check('W1 import 首轮模块', /from '\.\/recent-events-firstturn\.js'/.test(SRC) && /loadRecentEvents/.test(SRC));
check('W2 memoryCardLine 后计算并拼进 base', /const recentEventsFirstTurnAux = recentEventsFirstTurnLine\(key, memoryCardText, \{ dry: dryMode, delivery: Boolean\(opts\?\.delivery\) \}\)/.test(SRC) && /\+ memoryCardLine \+ recentEventsFirstTurnAux \+ topicIndexLine/.test(SRC));
check('W3 shadow/inject 审计路径', /recent-events-firstturn-bridge-shadow\.jsonl/.test(SRC) && /recent-events-firstturn-inject\.jsonl/.test(SRC));
check('W4 投递成功消费（pending）', /pendingRecentEventsFirstTurn/.test(SRC) && /markFirstTurnDay\(stB, ck, day\)/.test(SRC));
check('W5 不做锚点/图片路径（首轮互斥）', !/recentEventsLineFor\(/.test(SRC) && !/imageFallbackDecision\(/.test(SRC));
check('W6 config 默认 shadow', CFG.socialV2?.recentEvents?.firstTurn?.mode === 'shadow' && Number(CFG.socialV2?.recentEvents?.firstTurn?.maxChars) === 120);

const pass = ok === cases.length;
console.log(`FIRSTTURN-WIRING TEST ${pass ? 'PASS' : 'FAIL'}（${ok}/${cases.length}）`);
for (const c of cases) console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}${c.pass || !c.got ? '' : ` · got ${c.got}`}`);
process.exitCode = pass ? 0 : 1;
