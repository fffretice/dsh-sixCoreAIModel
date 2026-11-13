#!/usr/bin/env node
// 2026-11-10 task-52：memory 来源归因接线静态/纯函数测试（不改真实 prompt/卡）。
import fs from 'node:fs';
import path from 'node:path';
import { annotateRecallItem, SOURCE_HINT, auditPromptAttribution } from '../src/memory-attribution.js';

const ROOT = process.env.SURFCORE_DIR || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const BRIDGE = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const MEMCARD = fs.readFileSync(path.join(ROOT, 'src', 'memory-card.js'), 'utf8');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
let ok = 0; const cases = [];
const check = (name, pass, got = '') => { cases.push({ name, pass, got }); if (pass) ok += 1; };

const group = { id: 'g1', source: 'qq-group', originKind: 'group', speaker: '群友A', groupId: '1000000002', text: '今天群里聊了联动' };
const priv = { id: 'p1', source: 'qq-owner', originKind: 'private', speaker: '老大', text: '以后别熬夜' };

const gi = annotateRecallItem({ from: 'card', text: group.text }, group);
const pi = annotateRecallItem({ from: 'card', text: priv.text }, priv);
check('A1 recall item 群来源补 speaker/groupId/originKind', gi.speaker === '群友A' && gi.groupId === '1000000002' && gi.originKind === 'group');
check('A2 recall item 非群来源仍带 originKind/speaker', pi.originKind === 'private' && pi.speaker === '老大');
check('A3 无 record 时原样返回', annotateRecallItem({ from: 'archive', text: 'x' }, null).text === 'x');

check('W1 bridge import + recall 两处 annotate', /from '\.\/memory-attribution\.js'/.test(BRIDGE) && (BRIDGE.match(/annotateRecallItem\(/g) || []).length >= 2);
check('W2 bridge 私聊 shadow 审计（只写 live-shadow，不改 prompt）', /memory-attribution-live-shadow\.jsonl/.test(BRIDGE) && /auditPromptAttribution\(text, card\.records/.test(BRIDGE) && /来源归因\] shadow 私聊 prompt/.test(BRIDGE));
check('W3 bridge 审计只在私聊视图（非 group）', /isPrivateView = !String\(convKey \|\| ''\)\.startsWith\('group:'\)/.test(BRIDGE));
check('W4 config memory.attribution.mode=shadow', CFG.memory?.attribution?.mode === 'shadow');
check('W5 memory-card 支持 view/attributionMode 且 enforce 才改行', /attributionMode = 'shadow'/.test(MEMCARD) && /view = 'private'/.test(MEMCARD) && /attributionMode === 'enforce'\) return null/.test(MEMCARD) && /attributionMode === 'enforce'\) badge =/.test(MEMCARD));
check('W6 软提醒 enforce 才追加（shadow 只记录）', /appendSourceHint\(out, \{ mode: 'enforce' \}\)/.test(MEMCARD) && /onWouldChange\?\.\(\{ action: 'add_source_hint'/.test(MEMCARD));
check('W7 当前 prompt 审计可算 would-badge/skip', (() => { const a = auditPromptAttribution('- 2026-11-10 [清楚] 今天群里聊了联动', [group], { view: 'private' }); return a.total === 1 && a.unattributed === 1; })());

const pass = ok === cases.length;
console.log(`MEMORY-ATTRIBUTION-WIRING TEST ${pass ? 'PASS' : 'FAIL'}（${ok}/${cases.length}）`);
for (const c of cases) console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}${c.pass || !c.got ? '' : ` · ${String(c.got).slice(0, 120)}`}`);
process.exitCode = pass ? 0 : 1;
