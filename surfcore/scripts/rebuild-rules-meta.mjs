#!/usr/bin/env node
/**
 * 从规则文件重建 rules-meta.json（2026-11-02，2026-11-04 修路径）。
 *
 * meta 是「规则索引」，给降级统计用；真正的权威是**规则文件**。
 * 文件被改写（清理、合并、重排）之后 meta 会留着旧句子，两边对不上——
 * 于是出现过「meta 里有这条规矩、文件里没有」：她根本没看到，索引却以为它生效了。
 *
 * 方向只有一个：**文件 → meta**。反过来（把 meta 补回文件）会把已经清理掉的
 * 旧句子（「至少一年不关机可以轻松做到」这类）又捡回来。
 *
 * 2026-11-04：以前写死 `roles/角色.规则.md`（迁移前的旧路径），而活的文件在
 * `~/.dsh/surfcore/characters/<当前角色>/规则.md`，所以这脚本一跑就拿着过期文件重建。
 * 现在先解析当前角色，找不到再回落旧路径。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SECTIONS = [
  ['owner', '<!-- AUTO:owner -->'],
  ['group', '<!-- AUTO:group -->'],
  ['forgot', '<!-- AUTO:forgot -->'],
];

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const CHAR_DIR = path.join(DSH_HOME, 'surfcore', 'characters');
const LEGACY_FILE = path.join(os.homedir(), 'SurfCore', 'roles', '角色.规则.md');
const META = path.join(os.homedir(), 'SurfCore', 'state', 'rules-meta.json');

/** 当前角色的规则文件：current.json → 目录/规则.md；找不到再回落旧路径。 */
export function resolveRulesFile({ charDir = CHAR_DIR, legacy = LEGACY_FILE } = {}) {
  try {
    const cur = JSON.parse(fs.readFileSync(path.join(charDir, 'current.json'), 'utf8'));
    if (cur?.id) {
      const p = path.join(charDir, String(cur.id), '规则.md');
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  try {
    for (const d of fs.readdirSync(charDir).filter((x) => x.startsWith('char-'))) {
      const p = path.join(charDir, d, '规则.md');
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  return fs.existsSync(legacy) ? legacy : '';
}

/** 从规则文件文本解析出条目（section + text + 日期）。 */
export function parseRules(text, { year = new Date().getFullYear() } = {}) {
  const rules = [];
  for (const [section, marker] of SECTIONS) {
    const i = text.indexOf(marker);
    if (i < 0) continue;
    const rest = text.slice(i + marker.length);
    const nxt = rest.indexOf('<!-- AUTO:');
    const block = nxt < 0 ? rest : rest.slice(0, nxt);
    for (const line of block.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('- ')) continue;
      let body = t.slice(2).trim();
      let at = Date.now();
      const m = body.match(/[（(](\d{1,2})\/(\d{1,2})[）)]\s*$/);
      if (m) {
        body = body.replace(/[（(]\d{1,2}\/\d{1,2}[）)]\s*$/, '').trim();
        const d = new Date(year, Number(m[1]) - 1, Number(m[2]), 12, 0, 0);
        if (!Number.isNaN(d.getTime())) at = d.getTime();
      }
      if (body) rules.push({ section, text: body.slice(0, 120), source: section, addedAt: at, lastUsedAt: 0 });
    }
  }
  return rules;
}

/** 重建并写盘。返回 { ok, file, count, reason? }，供夜间体检调用。 */
export function rebuildRulesMeta({ file = '', metaPath = META, dry = false, now = new Date() } = {}) {
  const rulesFile = file || resolveRulesFile();
  if (!rulesFile || !fs.existsSync(rulesFile)) return { ok: false, file: rulesFile, count: 0, reason: '规则文件不存在' };
  const rules = parseRules(fs.readFileSync(rulesFile, 'utf8'), { year: now.getFullYear() });
  if (!rules.length) return { ok: false, file: rulesFile, count: 0, reason: '规则文件里没解析到条目' };
  if (!dry) {
    try {
      const old = fs.existsSync(metaPath) ? fs.readFileSync(metaPath, 'utf8') : '';
      if (old) fs.writeFileSync(`${metaPath}.bak-rebuild`, old);
      fs.writeFileSync(metaPath, JSON.stringify({ rules, lastDecayDate: now.toISOString().slice(0, 10) }, null, 2));
    } catch (error) {
      return { ok: false, file: rulesFile, count: rules.length, reason: String(error?.message ?? error) };
    }
  }
  return { ok: true, file: rulesFile, count: rules.length };
}

// ── CLI ───────────────────────────────────────────────────────────
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
const selfPath = path.resolve(new URL(import.meta.url).pathname);
if (invoked && invoked === selfPath) {
  const dry = process.argv.includes('--dry');
  const file = resolveRulesFile();
  console.log('规则文件:', file || '（没找到）');
  const r = rebuildRulesMeta({ file, dry });
  if (!r.ok) {
    console.error('重建失败:', r.reason);
    process.exit(1);
  }
  console.log(`从文件重建 ${r.count} 条${dry ? '（--dry，没写）' : '，已写入 meta'}`);
}
