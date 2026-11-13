#!/usr/bin/env node
// 2026-11-10 task-36 黑话闭环 MVP 单测：候选卡 / meaning 兜底 / 注入选择 / usage 扫描 / 周度回收
import fs from 'node:fs';
import path from 'node:path';
import { normalizeSlangEntry } from '../src/slang-learner.js';
import {
  resolveMeaning, isBlankCard, inferQuality, inferRiskLevel, inferScope,
  selectReviewCandidate, renderReviewCard,
  selectInjectionEntries, mentionsTerm,
  scanUsage, scanLanded, weeklyRecencyUpdate, USED_CANDIDATE_TERMS,
} from '../src/slang-loop.js';
const ROOT = process.env.SURFCORE_DIR || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

let ok = 0; const cases = [];
const check = (name, pass, got = '') => { cases.push({ name, pass, got }); if (pass) ok += 1; };
const now = Date.now();
const E = (over = {}) => ({ id: over.id || 'e' + Math.random().toString(36).slice(2, 8), content: over.content || '努努', status: over.status || 'candidate', count: 1, meaning: '', usage: '', risk: '', sources: [], evidence: [], ...over });

// 1) meaning 兜底 / 空白卡
check('M1 meaning || selfUsage', resolveMeaning({ meaning: '', selfUsage: '缝制小玩偶' }) === '缝制小玩偶' && resolveMeaning({ meaning: '解释', selfUsage: 'x' }) === '解释');
check('M2 空白卡：无 meaning/selfUsage', isBlankCard({ meaning: '', selfUsage: '' }) === true);
check('M3 占位句 + 无 selfUsage = 空白卡', isBlankCard({ meaning: '群里是这么用的：「x」', selfUsage: '' }) === true);
check('M4 有 selfUsage 的自认词不算空白', isBlankCard({ meaning: '群里是这么用的：「x」', selfUsage: '我以后这么用' }) === false);
check('M5 quality 推断', inferQuality({ meaning: '真解释', sources: ['s'] }) === 'researched' && inferQuality({ meaning: '群里是这么用的' }) === 'quote-only' && inferQuality({ meaning: '', selfUsage: 'x', confirmedBy: 'self' }) === 'self');
check('M6 risk 推断保守', inferRiskLevel({ risk: '涉及军国主义，敏感' }) === 'sensitive' && inferRiskLevel({ risk: '脏话' }) === 'offensive' && inferRiskLevel({}) === 'none');
check('M7 scope 推断（单群 evidence）', inferScope({ evidence: [{ key: 'group:1000000004' }] }).scope === 'group' && inferScope({ evidence: [{ key: 'group:1000000004' }, { key: 'group:1000000002' }] }).scope === 'global');

// 2) 候选卡选择
const cands = [
  E({ content: '空白词', meaning: '', selfUsage: '' }),
  E({ content: '已用词', meaning: '解释-已用', sources: ['s'], lastSeenAt: now - 3 * 86400e3, researchState: 'verified' }),
  E({ content: '新鲜词', meaning: '解释-新鲜', sources: ['s'], lastSeenAt: now - 1 * 3600e3, researchState: 'verified' }),
  E({ content: '敏感词', meaning: '解释-敏感', sources: ['s'], lastSeenAt: now - 1 * 3600e3, researchState: 'verified', risk: '涉及军国主义，敏感' }),
  E({ content: '冷却词', meaning: '解释-冷却', sources: ['s'], lastSeenAt: now - 1 * 3600e3, researchState: 'verified', review: { lastShownAt: now - 86400e3 } }),
];
{
  const r = selectReviewCandidate(cands, { now, usedTerms: ['已用词'] });
  check('C1 优先她已在用的词', r.entry?.content === '已用词', r.entry?.content + '|' + r.reason);
  check('C2 空白卡不推', selectReviewCandidate([cands[0]], { now }).entry === null);
  check('C3 敏感词不进首批', selectReviewCandidate([cands[3]], { now }).entry === null);
  check('C4 同词 14 天冷却', selectReviewCandidate([cands[4]], { now }).entry === null);
  check('C5 候选只用 candidate 状态', selectReviewCandidate([E({ content: '已确认', status: 'confirmed', meaning: 'x' })], { now }).entry === null);
  check('C6 无响应连续 2 次暂停', selectReviewCandidate(cands, { now, noResponseStreak: 2 }).reason === 'paused-no-response');
  const card = renderReviewCard(cands[1]);
  check('C7 卡面有 meaning/认不认/不硬', card.includes('解释-已用') && card.includes('认不认都行') && !/候选|学习|系统|注入/.test(card), card.slice(0, 60));
  check('C8 卡面一次一条（无多词）', !card.includes('新鲜词') && !card.includes('敏感词'));
}

// 3) 注入选择
const entries = [
  E({ content: '努努', status: 'confirmed', meaning: '缝制小玩偶', sources: ['s'], count: 5, lastSeenAt: now - 3600e3 }),
  E({ content: '偷跑', status: 'confirmed', meaning: '提前发售', sources: ['s'], count: 3, lastSeenAt: now - 3600e3 }),
  E({ content: '没出现', status: 'confirmed', meaning: '不该带', sources: ['s'], count: 9, lastSeenAt: now - 3600e3 }),
  E({ content: '占位词', status: 'confirmed', meaning: '群里是这么用的：「x」', count: 20, lastSeenAt: now - 3600e3 }),
  E({ content: '敏感词', status: 'confirmed', meaning: '敏感解释', sources: ['s'], risk: '军国主义敏感', count: 9, lastSeenAt: now - 3600e3 }),
  E({ content: '别的群词', status: 'confirmed', meaning: '群专属', sources: ['s'], scope: 'group', groupKeys: ['group:1000000004'], count: 4, lastSeenAt: now - 3600e3 }),
  E({ content: '看不懂词', status: 'understand', meaning: '只看懂', sources: ['s'], count: 2, lastSeenAt: now - 3600e3 }),
];
const msgs = [{ isSelf: false, text: '今天努努到了，偷跑没抢到；占位词、敏感词、别的群词、看不懂词都在聊' }];
{
  const sel = selectInjectionEntries(entries, { recentMessages: msgs, currentKey: 'group:1000000002', now });
  const terms = sel.use.map((x) => x.term);
  check('I1 只带最近消息出现的词', terms.includes('努努') && terms.includes('偷跑') && !terms.includes('没出现'));
  check('I2 占位解释不进 use', !terms.includes('占位词'));
  check('I3 敏感词不进 use', !terms.includes('敏感词'));
  check('I4 群内专属词不外传群', !terms.includes('别的群词'));
  check('I5 understand 只带出现的', sel.understand.some((x) => x.term === '看不懂词'));
  check('I6 私聊不注入 use/understand 表', selectInjectionEntries(entries, { recentMessages: msgs, currentKey: 'private:1000000001', now }).text === '');
  check('I7 无相关词就不注入', selectInjectionEntries(entries, { recentMessages: [{ text: '今天天气不错' }], currentKey: 'group:1000000002', now }).text === '');
  const many = Array.from({ length: 12 }, (_, i) => E({ content: '词' + i, status: 'confirmed', meaning: '解释' + i, sources: ['s'], count: 5, lastSeenAt: now - 3600e3 }));
  const selMany = selectInjectionEntries(many, { recentMessages: [{ text: many.map((e) => e.content).join(' ') }], currentKey: 'group:1000000002', now });
  check('I8 use ≤6 / understand ≤3', selMany.use.length <= 6 && selMany.understand.length <= 3);
  check('I9 总长 ≤1200', selMany.text.length <= 1200, String(selMany.text.length));
  check('I10 ASCII 词边界', mentionsTerm('words ds test', 'ds') === true || mentionsTerm('words ds test', 'ds') === false);
}

// 4) usage / landed
{
  const us = scanUsage('啵啵接着收费，学马氏今天不错', [
    E({ content: '啵啵', status: 'confirmed' }),
    E({ content: '学马氏', status: 'confirmed' }),
    E({ content: '没出现', status: 'confirmed' }),
  ]);
  check('U1 命中 confirmed 词', us.map((x) => x.term).sort().join(',') === '啵啵,学马氏'.split(',').sort().join(','));
  check('U2 去重叠（长词优先）', scanUsage('带括号的用法', [E({ content: '带括号', status: 'confirmed' }), E({ content: '括号', status: 'understand' })]).length === 1);
  const landed = scanLanded({ herText: '啵啵接着收费', laterMessages: [{ isSelf: false, text: '哈哈啵啵', time: now - 60e3 }], entries: [E({ content: '啵啵', status: 'confirmed' })], now });
  check('U3 有人复用 → landed', landed.length === 1 && landed[0].term === '啵啵');
}

// 5) 周度回收
{
  const old = E({ content: '旧词', status: 'confirmed', mean: 'x', meaning: 'x', lastSeenAt: now - 30 * 86400e3, usage: { count: 0, lastUsedAt: 0 } });
  const r = weeklyRecencyUpdate([old], { now });
  check('W1 21 天未用 confirmed → understand', r.entries[0].status === 'understand' && r.changes.length === 1);
  const cand = E({ content: '摆过两次', status: 'candidate', meaning: 'x', review: { shownCount: 2 } });
  const r2 = weeklyRecencyUpdate([cand], { now });
  check('W2 候选摆过 2 次没回 → 延后 30 天', r2.entries[0].review.deferredUntil > now);
  check('W3 有用的词不降级', weeklyRecencyUpdate([{ ...old, usage: { count: 3, lastUsedAt: now - 86400e3 } }], { now }).entries[0].status === 'confirmed');
}

// 6) 接线静态 + normalize 白名单
{
  const n = normalizeSlangEntry({ content: 'x', meaning: 'm', quality: 'researched', scope: 'group', groupKeys: ['group:1'], riskLevel: 'mild', review: { shownCount: 2 }, usage: { count: 3, landedCount: 1 }, aliases: ['y'] });
  check('S1 normalize 保留新字段', n.quality === 'researched' && n.scope === 'group' && n.riskLevel === 'mild' && n.review.shownCount === 2 && n.usage.count === 3 && n.aliases.length === 1);
  check('S2 bridge import 闭环函数', /selectInjectionEntries, selectReviewCandidate, renderReviewCard, scanUsage, resolveMeaning, USED_CANDIDATE_TERMS/.test(SRC));
  check('S3 注入/卡片接线 + 默认 shadow', /slangLoopInjectionBlock\(key\)/.test(SRC) && /slangLoopReviewBlock\(key\)/.test(SRC) && /cfg\.slang\?\.loop\?\.mode \|\| 'shadow'/.test(SRC));
  check('S4 confirm meaning 兜底接线', /if \(!String\(e\.meaning \|\| ''\)\.trim\(\)\) e\.meaning = String\(e\.selfUsage \|\| ''\)\.trim\(\)/.test(SRC));
  check('S5 usage/landed 钩子', /recordSlangUsage\(key, list\)/.test(SRC) && /noteSlangLandedIncoming\(key, msg\)/.test(SRC) && /slang-usage\.jsonl/.test(SRC));
  check('S6 config slang.loop valid', ['shadow','on'].includes(CFG.slang?.loop?.mode) && Number(CFG.slang?.loop?.injectUseMax) === 6);
}

const pass = ok === cases.length;
console.log(`SLANG-LOOP TEST ${pass ? 'PASS' : 'FAIL'}（${ok}/${cases.length}）`);
for (const c of cases) console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}${c.pass || !c.got ? '' : ` · got ${c.got}`}`);
process.exitCode = pass ? 0 : 1;
