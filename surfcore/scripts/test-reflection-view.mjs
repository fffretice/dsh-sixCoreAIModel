#!/usr/bin/env node
// 2026-11-10 P0 隐私单测：reflections 视图过滤（群不注入私聊反思；旧记录按 private）
import fs from 'node:fs';
import path from 'node:path';
import { reflectionOriginOf, buildReflectionRecord, filterReflectionsForView } from '../src/wish-origin.js';

const ROOT = process.env.SURFCORE_DIR || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
let ok = 0; const cases = [];
const check = (name, pass, got = '') => { cases.push({ name, pass, got }); if (pass) ok += 1; };
const G = 'group:1000000002';
const P = 'private:1000000001';
const legacy = { date: '2026-11-09', text: '旧记录没有 origin', at: 1 };
const priv = buildReflectionRecord({ date: '2026-11-09', text: '私聊项目反思：商品页', at: 2, origin: 'private' });
const grp = buildReflectionRecord({ date: '2026-11-09', text: '群聊后的反思', at: 3, origin: 'group' });

check('R1 旧记录无 origin 按 private 处理', reflectionOriginOf(legacy) === 'private');
check('R2 buildReflectionRecord 默认 private/diary', (() => { const r = buildReflectionRecord({ text: 'x' }); return r.origin === 'private' && r.scope === 'diary'; })());
check('R3 group 视图排除 legacy/private，仅放 group', filterReflectionsForView([legacy, priv, grp], { currentKey: G }).length === 1 && filterReflectionsForView([legacy, priv, grp], { currentKey: G })[0].origin === 'group');
check('R4 private 视图保留全部（含 legacy/group）', filterReflectionsForView([legacy, priv, grp], { currentKey: P }).length === 3);
check('R5 空/异常输入安全', filterReflectionsForView(null, { currentKey: G }).length === 0 && filterReflectionsForView([null, undefined], { currentKey: P }).length === 2);
// 静态：bridge 接线
check('S1 import 反思 helper', /buildReflectionRecord, filterReflectionsForView/.test(SRC));
check('S2 reflectionLine 接收视图并用共用过滤', /function reflectionLine\(viewKey = ''\)/.test(SRC) && /filterReflectionsForView\(recentReflections\(8\), \{ currentKey: viewKey \}\)/.test(SRC));
check('S3 调用处传 key（不再手写空串分支）', /const reflectLine = reflectionLine\(key\);/.test(SRC) && !/String\(key\)\.startsWith\('group:'\) \? '' : reflectionLine/.test(SRC));
check('S4 写入补 origin/scope（日记默认 private）', /buildReflectionRecord\(\{ date: day, text: s, at: nowR, origin: 'private', scope: 'diary' \}\)/.test(SRC));

const pass = ok === cases.length;
console.log(`REFLECTION-VIEW TEST ${pass ? 'PASS' : 'FAIL'}（${ok}/${cases.length}）`);
for (const c of cases) console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}${c.pass || !c.got ? '' : ` · got ${c.got}`}`);
process.exitCode = pass ? 0 : 1;
