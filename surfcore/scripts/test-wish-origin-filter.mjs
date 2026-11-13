#!/usr/bin/env node
// 2026-11-09 P1 单测：pendingThoughts 来源标记 + 群 prompt 过滤 private 来源
import fs from 'node:fs';
import path from 'node:path';
import { originKindOf, resolveExcludePrivateOrigin, tagThoughtOrigin, shouldIncludeThought, thoughtLabel, isPrivateOriginInGroup, sortThoughtsForPrompt, thoughtDedupeKey } from '../src/wish-origin.js';

const ROOT = process.env.SURFCORE_DIR || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
let ok = 0; const cases = [];
const check = (name, pass, got = '') => { cases.push({ name, pass, got }); if (pass) ok += 1; };
const P = (originKey, text, at = Date.now()) => tagThoughtOrigin({ text, at }, originKey);
const N = (ms) => Date.now() - Number(ms);

// 1) 群会话默认：private 来源跳过，本群 + room 保留
{
  const items = [P('group:860', '群里的念想'), P('private:1000000001', '私聊里的念想'), { text: '房间目标', goal: true }];
  const exclude = resolveExcludePrivateOrigin({ currentKey: 'group:860', opts: {}, includePrivateInGroup: false });
  const kept = items.filter((it) => shouldIncludeThought({ item: it, currentKey: 'group:860', excludePrivateOrigin: exclude }));
  check('W1 群 prompt 过滤 private 来源，保留本群+room', exclude === true && kept.length === 2 && kept.some((x) => x.text === '群里的念想') && kept.some((x) => x.goal), JSON.stringify(kept.map((x) => x.text)));
}
// 2) 私聊：两个来源都保留（行为不变）
{
  const exclude = resolveExcludePrivateOrigin({ currentKey: 'private:1000000001', opts: {}, includePrivateInGroup: false });
  const items = [P('private:1000000001', '私聊A'), P('group:860', '群B')];
  const kept = items.filter((it) => shouldIncludeThought({ item: it, currentKey: 'private:1000000001', excludePrivateOrigin: exclude }));
  check('W2 私聊 prompt 行为不变（都保留）', exclude === false && kept.length === 2);
}
// 3) 群来源念想正常出现在本群
{
  const exclude = resolveExcludePrivateOrigin({ currentKey: 'group:860', opts: {} });
  check('W3 群来源念想正常保留', shouldIncludeThought({ item: P('group:860', '自己的群念想'), currentKey: 'group:860', excludePrivateOrigin: exclude }) === true);
}
// 4) room 目标任何 key 都保留，标签正确
{
  const room = { text: '目标', goal: true, source: 'room' };
  check('W4 room 目标保留且标签【房间目标】', shouldIncludeThought({ item: room, currentKey: 'group:1', excludePrivateOrigin: true }) === true && thoughtLabel(room) === '【房间目标】');
}
// 5) B 开关：群 prompt 保留 private 来源但标注+降权
{
  const exclude = resolveExcludePrivateOrigin({ currentKey: 'group:860', opts: {}, includePrivateInGroup: true });
  const priv = { ...P('private:1000000001', '私聊念想', N(60 * 60e3)), privateOrigin: true };
  const grp = { ...P('group:860', '群念想', N(2 * 60 * 60e3)) };
  const kept = [priv, grp].filter((it) => shouldIncludeThought({ item: it, currentKey: 'group:860', excludePrivateOrigin: exclude }));
  const sorted = sortThoughtsForPrompt(kept);
  check('W5 B 开关：保留+标注+群来源在前（降权）', exclude === false && kept.length === 2 && thoughtLabel(priv).includes('私聊里想的，群里别提') && sorted[0].text === '群念想' && sorted[1].text === '私聊念想');
  check('W5b isPrivateOriginInGroup 判定', isPrivateOriginInGroup(priv, 'group:860') === true && isPrivateOriginInGroup(priv, 'private:1000000001') === false);
}
// 6) 去重键：前 12 字
check('W6 去重键前 12 字一致', thoughtDedupeKey({ text: '商品页写完了（不是草稿，是能直接贴的那种）' }) === thoughtDedupeKey({ text: '商品页写完了（不是草稿，是别的）' }) && /seen\.has\(`t:\$\{key12\}`\)/.test(SRC));
// 7) 旧数据兼容：raw 无 origin 字段，合并时按来源 key 打标
{
  const tagged = tagThoughtOrigin({ text: '没有来源字段的老念想' }, 'private:1000000001');
  check('W7 旧数据合并时补 origin（无历史字段也能过滤）', tagged.originKind === 'private' && shouldIncludeThought({ item: tagged, currentKey: 'group:860', excludePrivateOrigin: true }) === false);
}
// 8) static：bridge 接入点
check('S1 import wish-origin 模块', /from '\.\/wish-origin\.js'/.test(SRC));
check('S2 wishLines 读取 B 开关且默认 false', /cfg\.socialV2\?\.wish\?\.includePrivateInGroup === true/.test(SRC));
check('S3 合并时打来源标记并过滤', /tagThoughtOrigin\(normalized, k\)/.test(SRC) && /shouldIncludeThought\(\{ item: tagged, currentKey: key, excludePrivateOrigin \}\)/.test(SRC));
check('S4 排序/标签用新 helper', /sortThoughtsForPrompt\(fresh\)/.test(SRC) && /thoughtLabel\(x\)/.test(SRC));
check('S5 两处调用都被默认规则覆盖（base + selfTime all）', /const wishLine = .*wishLines\(key\)/.test(SRC) && /wishLines\(key, 3, \{ all: true, includeOld: true \}\)/.test(SRC) && /const excludePrivateOrigin = resolveExcludePrivateOrigin\(\{ currentKey: key, opts, includePrivateInGroup \}\)/.test(SRC));

const pass = ok === cases.length;
console.log(`WISH-ORIGIN TEST ${pass ? 'PASS' : 'FAIL'}（${ok}/${cases.length}）`);
for (const c of cases) console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}${c.pass || !c.got ? '' : ` · got ${c.got}`}`);
process.exitCode = pass ? 0 : 1;
