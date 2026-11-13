#!/usr/bin/env node
// 2026-11-09 P1 同源泄漏（含 P2 跨群残留）：搜索/工作经历的来源视图过滤单测
// 规则：群 prompt 只展示「来源=当前会话」或显式 public；unknown / 其他群 / private 一律不进。
import fs from 'node:fs';
import path from 'node:path';
import { isPrivateConversationKey, resolveRecordSourceKey, isPublicRecord, filterViewRecordsByOrigin, buildQueryOrigins, searchRowVisibleInView } from '../src/wish-origin.js';

const ROOT = process.env.SURFCORE_DIR || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
let ok = 0; const cases = [];
const check = (name, pass, got = '') => { cases.push({ name, pass, got }); if (pass) ok += 1; };
const G860 = 'group:1000000002';
const G650 = 'group:1000000004';
const PRIV = 'private:1000000001';
const causal = [
  { key: G650, source: 'tool:search', detail: '2026 新手 在小红书 B站 公众号 发内容 门槛 实名认证 起号' },
  { key: G650, source: 'tool:bili', detail: '文案写作 入门 方法' },
  { key: G860, source: 'tool:search', detail: '学園アイドルマスター 新ガシャ 2026年11月' },
  { key: PRIV, source: 'tool:search', detail: '闲鱼 文案代写 技能服务 规则 会被下架吗' },
];

check('V1 isPrivateConversationKey', isPrivateConversationKey(PRIV) === true && isPrivateConversationKey(G860) === false);
// 2) 群视图：只留当前群；其他群/private 剔除；public 保留
{
  const records = [
    { key: G860, text: '本群搜索' },
    { key: G650, text: '小红书 B站 起号' },
    { key: PRIV, text: '闲鱼 文案代写' },
    { key: G650, text: '公开内容', public: true },
  ];
  const kept = filterViewRecordsByOrigin(records, { currentKey: G860 });
  check('V2 群 prompt 只留当前群来源（跨群/private 剔除、public 保留）', kept.length === 2 && kept.some((r) => r.text === '本群搜索') && kept.some((r) => r.public === true), JSON.stringify(kept.map((r) => r.text)));
  check('V3 群 prompt 不含私事片段（闲鱼/文案代写/商品页/账号弄好）', !kept.some((r) => /闲鱼|文案代写|商品页|账号弄好/.test(r.text)));
}
// 3) 私聊：全部保留
{
  const kept = filterViewRecordsByOrigin(causal.map((r) => ({ ...r })), { currentKey: PRIV });
  check('V4 私聊 prompt 保留全部（含私事）', kept.length === 4 && kept.some((r) => /闲鱼/.test(r.detail)));
}
// 4) sourceKey 解析：直接字段 / 旧行 causal 回填 / 歧义=unknown
{
  const origins = buildQueryOrigins(causal);
  check('V5 sourceKey 直接字段优先', resolveRecordSourceKey({ sourceKey: G860 }) === G860 && resolveRecordSourceKey({ key: PRIV }) === PRIV);
  check('V6 旧行用 causal 回填（唯一来源）', resolveRecordSourceKey({ q: '学園アイドルマスター 新ガシャ 2026年11月' }, { queryOrigins: origins }) === G860);
  check('V7 无来源/多来源=unknown', resolveRecordSourceKey({ q: '从没搜过的问题' }, { queryOrigins: origins }) === '' && resolveRecordSourceKey({ q: '' }) === '');
  const mixed = new Map([['两条来源', new Set([G650, PRIV])]]);
  check('V8 多来源算 unknown（宁缺毋滥）', resolveRecordSourceKey({ q: '两条来源' }, { queryOrigins: mixed }) === '');
}
// 5) search-memory 行：unknown 不进群 / group 进群 / private 不进群 / public 进群
{
  const origins = buildQueryOrigins(causal);
  const row = (q, extra = {}) => ({ q, ...extra });
  check('V9 unknown 行不进群 prompt', searchRowVisibleInView(row('从没搜过的问题'), { currentKey: G860, queryOrigins: origins }) === false);
  check('V10 本群来源行进群 prompt', searchRowVisibleInView(row('学園アイドルマスター 新ガシャ 2026年11月'), { currentKey: G860, queryOrigins: origins }) === true);
  check('V11 其他群/private 来源行不进群 prompt', searchRowVisibleInView(row('2026 新手 在小红书 B站 公众号 发内容 门槛 实名认证 起号'), { currentKey: G860, queryOrigins: origins }) === false && searchRowVisibleInView(row('闲鱼 文案代写 技能服务 规则 会被下架吗'), { currentKey: G860, queryOrigins: origins }) === false);
  check('V12 新行 sourceKey 字段可用', searchRowVisibleInView(row('公开新行', { sourceKey: G860 }), { currentKey: G860 }) === true && searchRowVisibleInView(row('未知新行', { sourceKey: '' }), { currentKey: G860 }) === false);
  check('V13 public 行进群 prompt（公开内容不受影响）', searchRowVisibleInView(row('B站/学马公开搜索', { public: true }), { currentKey: G860, queryOrigins: origins }) === true);
  check('V14 私聊视图不过滤（unknown/私事都保留）', searchRowVisibleInView(row('从没搜过的问题'), { currentKey: PRIV }) === true && searchRowVisibleInView(row('闲鱼 文案代写 技能服务 规则 会被下架吗'), { currentKey: PRIV, queryOrigins: origins }) === true);
}
// 6) static：bridge 接线
check('S1 引入 sourceKey/过滤 helper', /filterViewRecordsByOrigin, buildQueryOrigins, searchRowVisibleInView/.test(SRC) && /from '\.\/wish-origin\.js'/.test(SRC));
check('S2 searchMemoryLine 按 key + queryOrigins 过滤', /function searchMemoryLine\(key\)/.test(SRC) && /searchRowVisibleInView\(x, \{ currentKey: key, queryOrigins \}\)/.test(SRC) && /searchMemoryLine\(key\)/.test(SRC));
check('S3 outcomesPromptLine 按当前会话过滤', /function outcomesPromptLine\(key\)/.test(SRC) && /filterViewRecordsByOrigin\(/.test(SRC) && /outcomesPromptLine\(key\)/.test(SRC));
check('S4 doneHistoryLine 群会话只聚合当前会话（其他群/private 不串）', /k === key/.test(SRC) && /2026-11-09（P1 同源泄漏）：群会话只聚合/.test(SRC));
check('S5 黑话「查过的词」也按来源过滤', /searchRowVisibleInView\(r, \{ currentKey: key, queryOrigins \}\)/.test(SRC));

const pass = ok === cases.length;
console.log(`PRIVATE-VIEW TEST ${pass ? 'PASS' : 'FAIL'}（${ok}/${cases.length}）`);
for (const c of cases) console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}${c.pass || !c.got ? '' : ` · got ${c.got}`}`);
process.exitCode = pass ? 0 : 1;
