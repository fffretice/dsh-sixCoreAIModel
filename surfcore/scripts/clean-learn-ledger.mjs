#!/usr/bin/env node
/**
 * 用收紧后的规则重扫学习账本（2026-11-02）。
 * 每条拿 examples 里的原文重跑 extractTeaching，提不出合格 topic 的整条删掉。
 * 带 --dry 只看不写。
 */
import fs from 'node:fs';
import { __test } from '~/SurfCore/src/learn-ledger.js';
const { extractTeaching } = __test;
const P = '~/SurfCore/state/learn-ledger.json';
const dry = process.argv.includes('--dry');

const raw = JSON.parse(fs.readFileSync(P, 'utf8'));
const items = raw.items || {};
const keep = {}, drop = [];
for (const [k, v] of Object.entries(items)) {
  const exs = Array.isArray(v.examples) ? v.examples : [];
  // 用新规则**重新提取** topic，而不是沿用旧的（旧 topic 本身就是碎片）
  let re = null;
  for (const ex of exs) {
    const hit = extractTeaching(ex);
    if (hit && hit.topic.length >= 3) { re = hit; break; }
  }
  if (re) keep[k] = { ...v, topic: re.topic, raw: re.raw };
  else drop.push({ k, topic: v.topic, ex: (exs[0] || '').slice(0, 50) });
}
console.log(`原 ${Object.keys(items).length} 条 → 留 ${Object.keys(keep).length} 条，删 ${drop.length} 条`);
console.log('被删的样例：');
for (const d of drop.slice(0, 12)) console.log('  -', d.topic, '|', d.ex);
if (!dry) {
  fs.writeFileSync(P + '.bak-clean', JSON.stringify(raw, null, 1));
  fs.writeFileSync(P, JSON.stringify({ ...raw, items: keep }, null, 1));
  console.log('已写入（原文件备份为 learn-ledger.json.bak-clean）');
} else {
  console.log('（--dry，没有写）');
}
