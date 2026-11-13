#!/usr/bin/env node
// 2026-11-09 P1 规则污染单测：owner 直呼消息的语义闸（13:40 玩笑应被拒进核心）
import fs from 'node:fs';
import path from 'node:path';
import { stripOwnerMentions, hasRuleMarker, looksLikeJokeOrTrade, mentionsOnlyOthers, classifyOwnerRule, stripTeachingLead, routePrivateTeaching, isDirectiveCandidate, buildTeachingShadowEntry } from '../src/owner-rule-gate.js';
import { appendTeachingShadow, readTeachingShadow } from '../src/teaching-shadow.js';
import os from 'node:os';

const ROOT = process.env.SURFCORE_DIR || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

let ok = 0; const cases = [];
const check = (name, pass, got = '') => { cases.push({ name, pass, got }); if (pass) ok += 1; };
const SELF = ['角色昵称', '角色', '角色'];
const JOKE = '@角色昵称 10块90系塞一起我就可以给你本地部署几百B的ds4.1';
const t = (text, opts = {}) => classifyOwnerRule(text, { selfNicknames: SELF, ...opts });

// 1) 事故复现
{
  const r = t(JOKE, { inPrivate: false, direct: true });
  check('G1 13:40 玩笑不进规则核心', r.action !== 'core', JSON.stringify(r));
  check('G2 判为价格/交易玩梗', r.reason === 'price-or-trade' || r.reason === 'joke-or-banter', r.reason);
}
// 2) 真实规则句应进核心
check('G3 「以后…sir yes sir」进核心', t('以后我再我的群里给你下任务的时候你要直接回答 “sir yes sir！”', { inPrivate: false, direct: true }).action === 'core');
check('G4 「别用凭什么」进核心', t('有人讨你、叫你做事：要推就接住话头提条件，别背台词、别用「凭什么」；不想做就不做', { inPrivate: false, direct: true }).action === 'core');
check('G5 认图规则进核心', t('拿不准图里是不是你、是谁：先看 qq_get_self_image / 头像再翻记忆，认不清就说「这像我吗」，别直接认领', { inPrivate: false, direct: true }).action === 'core');
check('G6 私聊带前提的账号规则进核心', t('仔细一想感觉我可以给你弄账号你自己去操作；前提是你要把全部的流程都自己研究清楚', { inPrivate: true, direct: true }).action === 'core');
// 3) 排除项
check('G7 @别人不进核心', t('@oua 10块90系塞一起我就可以给你本地部署几百B', { inPrivate: false, direct: false }).action === 'skip');
check('G8 URL 不进规则', t('以后看 https://x.com/foo/status/1 记得看完', { inPrivate: false, direct: true }).action === 'skip');
check('G9 问句不进规则', t('你觉得这个应该怎么弄？', { inPrivate: false, direct: true }).action === 'skip');
check('G10 超长群句不进规则', t('以后' + '你'.repeat(100), { inPrivate: false, direct: true }).action === 'skip');
check('G11 纯 @ 寒暄不进核心（候选池）', t('@角色昵称 你好啊', { inPrivate: false, direct: true }).action === 'pending');
check('G12 交易梗不进核心（候选池）', t('有要出的直接M我，不砍价一律50元', { inPrivate: false, direct: true }).action === 'pending');
check('G13 群叙述式「我…给你」不进核心', t('我就可以给你本地部署几百B的ds4.1', { inPrivate: false, direct: true }).action === 'pending');
check('G14 「仔细一想/感觉」开头无强规则标记 → 候选', t('仔细一想感觉我可以给你弄点东西', { inPrivate: false, direct: true }).action === 'pending');
check('G15 私聊同一句（含前提）→ 核心', t('仔细一想感觉我可以给你弄账号；前提是你要把流程研究清楚', { inPrivate: true, direct: true }).action === 'core');
// 4) 辅助函数
check('G16 strip @ 昵称', stripOwnerMentions(JOKE) === '10块90系塞一起我就可以给你本地部署几百B的ds4.1');
check('G17 规则标记识别', hasRuleMarker('以后别这样') === true && hasRuleMarker('今天天气不错') === false);
check('G18 价格/玩梗识别', looksLikeJokeOrTrade(JOKE).any === true && looksLikeJokeOrTrade('以后记得带称呼').any === false);
check('G19 @别人判定', mentionsOnlyOthers('@oua 你好', SELF) === true && mentionsOnlyOthers('@角色昵称 你好', SELF) === false);
check('G20 关闭开关可回退', classifyOwnerRule('随便说说', { inPrivate: false, direct: true, cfg: { enabled: false } }).action === 'core');

// 5) task-30 A：私聊两级路由（core/teaching-ish/junk）
{
  const route = (x) => routePrivateTeaching(x, { selfNicknames: [...SELF, 'deepseek'], cfg: { enabled: true } });
  check('A1 「以后不准说谎」→ core', route('以后不准说谎').action === 'core');
  check('A2 「以后大半夜…别留言」→ core', route('以后大半夜尽量做自己的事情吧，你给我留言但是我在睡觉的话，会因为不回复你导致你心情变差的').action === 'core');
  check('A3 「以后…小小使坏」→ core', route('好，以后遇到有人故意整你就这样小小使坏一把，但是要注意道德分寸哦').action === 'core');
  const r4 = route('哦那个不是我的群，不管');
  check('A4 色图 case → teaching-ish（不丢）', r4.action === 'teaching-ish' && r4.gate.reason === 'no-rule-marker', JSON.stringify(r4));
  check('A5 甜甜圈「不要插话…记得」→ core', route('平时就是聊做模型和甜甜圈，但是当他们聊到甜甜圈的时候你看看就行不要插话，或者跟风发一个他们都在发的表情图就行，记得啊不要插话').action === 'core');
  check('A6 「不要回答的太直接」→ core', route('孩儿啊，在群里别人问你东西的时候你不要回答的太直接了').action === 'core');
  check('A7 纯闲聊 → junk(pure-chat)', route('今天天气不错').action === 'junk', JSON.stringify(route('今天天气不错')));
  check('A8 碎片 → junk(junk)', routePrivateTeaching('啊', { selfNicknames: SELF, cfg: { enabled: true }, isJunk: true }).action === 'junk');
}
// 6) task-30 C：前导连词（只判不改）
check('C1 剥「而且」后 core', stripTeachingLead('而且记得是要发消息的图') === '记得是要发消息的图' && classifyOwnerRule('而且记得是要发消息的图', { inPrivate: true, direct: true }).action === 'core');
check('C2 连用两层（还有+而且）', stripTeachingLead('还有，而且记得以后别这样') === '记得以后别这样');
for (const w of ['而且', '还有', '还有就是', '不过', '然后', '所以', '但是', '但', '并且', '另外', '顺便', '对了', '话说', '其实']) {
  check(`C3 剥「${w}」`, stripTeachingLead(`${w}，以后别这样`) === '以后别这样');
}
// 7) task-30 B：extract-null 候选判定 + 静态接线
check('B1 「不管」色图 case 是候选', isDirectiveCandidate('哦那个不是我的群，不管') === true);
check('B2 纯闲聊不是候选', isDirectiveCandidate('今天天气不错') === false);
check('B3 指令句是候选', isDirectiveCandidate('以后不准说谎') === true && isDirectiveCandidate('不要插话') === true);
check('S6 bridge B 分支：owner 私聊 extract-null → 候选池+日志', /source: 'owner-extract-miss'/.test(SRC) && /\[教学\] 提取失败，进候选池/.test(SRC) && /noteTeachingShadow\(\{ key, stage: 'recordTeaching'/.test(SRC));
// 8) task-30 D：shadow schema + append/轮转
{
  const e = buildTeachingShadowEntry({ key: 'private:1', stage: 'queue', action: 'junk', reason: 'no-rule-marker', text: '今天天气不错', gate: { action: 'pending', reason: 'no-rule-marker' } });
  check('D1 shadow 行 schema（stage/action/gate）', e.stage === 'queue' && e.action === 'junk' && e.gate.action === 'pending' && e.text.length <= 80 && /^\d{4}-\d{2}-\d{2}T/.test(e.at));
  const file = path.join(os.tmpdir(), `teach-shadow-${Date.now()}.jsonl`);
  for (let i = 0; i < 6; i += 1) appendTeachingShadow(file, buildTeachingShadowEntry({ key: 'k', stage: 'queue', action: 'junk', reason: 't', text: `第${i}条` }), { maxBytes: 256, keepLines: 3 });
  const rows = readTeachingShadow(file);
  check('D2 append + 超限轮转保留最后 3 行', rows.length === 3 && rows[rows.length - 1].text === '第5条', JSON.stringify(rows.map((x) => x.text)));
  fs.rmSync(file, { force: true });
}
check('S7 bridge A-C-D 接线（route/shadow/enabled=false 回退）', /routePrivateTeaching\(line/.test(SRC) && /teaching-drop-shadow\.jsonl/.test(SRC) && /if \(gateCfg\.enabled === false\)/.test(SRC) && /noteTeachingShadow\(\{ key, stage: 'queue'/.test(SRC));

// 9) bridge 接线静态断言（2026-11-09 已接线，未部署）
check('S1 bridge 引入 classifyOwnerRule', /import \{[^}]*classifyOwnerRule[^}]*\} from '\.\/owner-rule-gate\.js'/.test(SRC));
check('S2 仅群聊生效（私聊保持现状）', /if \(isOwner && !inPrivate\) \{/.test(SRC) && /direct: directTalk/.test(SRC));
check('S3 语义闸日志 + pending 转候选池', /\[规则\] 语义闸（\$\{gate\.reason\}）/.test(SRC) && /pendingRules\.add\(String\(cleanText\)\.slice\(0, 80\)/.test(SRC));
check('S4 规则写入带审计字段', /gate: 'semantic-v1'/.test(SRC) && /gateReason: String\(audit\.reason/.test(SRC) && /fromKey: String\(audit\.key/.test(SRC));
check('S5 config rulesGate.enabled 默认 true', CFG.socialV2?.rulesGate?.enabled === true);

const pass = ok === cases.length;
console.log(`OWNER-RULE-GATE TEST ${pass ? 'PASS' : 'FAIL'}（${ok}/${cases.length}）`);
for (const c of cases) console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}${c.pass || !c.got ? '' : ` · got ${c.got}`}`);
process.exitCode = pass ? 0 : 1;
