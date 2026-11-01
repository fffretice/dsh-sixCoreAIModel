/**
 * 规则核心的自动写入与遗忘（2026-10-30 主人定的规则）
 *
 *   · 主人教的 → 直接进规则核心，但**语义是「强倾向」而不是硬规则**：
 *     分量比其他习惯重，遇到状态/场合不合适可以只做一半，不必机械执行。
 *   · 其他人/群里学到的 → 先走学习账本，达到门槛才进规则核心
 *   · 规则核心里的条目长期不用 → 删掉，只留一句「印象」
 *     （这样被人问起她可以「诶…好像有这么件事，但记不清了」，比硬编好）
 */

import fs from 'node:fs';
import path from 'node:path';

const MARKERS = {
  owner: '<!-- AUTO:owner -->',
  group: '<!-- AUTO:group -->',
  impression: '<!-- AUTO:impression -->',
};

const SECTIONS = {
  owner: '## 主人教过的（分量最重，但不是命令）',
  group: '## 群里学到的（够了才进来）',
  impression: '## 模糊印象（记得有这么回事，细节忘了）',
};

function readFileSafe(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

/** 把文件按「自动区段」切开；没有标记的文件原样返回。 */
export function parseSections(text) {
  const src = String(text || '');
  const idx = {};
  for (const [k, m] of Object.entries(MARKERS)) idx[k] = src.indexOf(m);
  return { text: src, idx };
}

/** 确保文件里存在三个自动区段（不存在就追加）。 */
export function ensureSections(file) {
  let text = readFileSafe(file);
  let changed = false;
  for (const [key, heading] of Object.entries(SECTIONS)) {
    if (!text.includes(MARKERS[key])) {
      text = `${text.trimEnd()}\n\n${heading}\n${MARKERS[key]}\n`;
      changed = true;
    }
  }
  if (changed) fs.writeFileSync(file, text);
  return text;
}

/** 取某区段里的自动条目（- 开头的行）。 */
export function listAutoRules(text, section) {
  const src = String(text || '');
  const start = src.indexOf(MARKERS[section]);
  if (start < 0) return [];
  const rest = src.slice(start);
  const nextMark = Object.values(MARKERS)
    .map((m) => rest.indexOf(m, MARKERS[section].length))
    .filter((i) => i > 0)
    .sort((a, b) => a - b)[0];
  const block = nextMark ? rest.slice(0, nextMark) : rest;
  return block.split('\n').filter((l) => l.trim().startsWith('- ')).map((l) => l.trim().slice(2));
}

function insertAfterMarker(text, section, line) {
  const marker = MARKERS[section];
  const at = text.indexOf(marker);
  if (at < 0) return text;
  const insertAt = at + marker.length;
  return `${text.slice(0, insertAt)}\n${line}${text.slice(insertAt)}`;
}

function removeLine(text, section, ruleText) {
  const lines = text.split('\n');
  const markerIdx = lines.findIndex((l) => l.includes(MARKERS[section]));
  if (markerIdx < 0) return text;
  for (let i = markerIdx + 1; i < lines.length; i++) {
    if (lines[i].includes('<!-- AUTO:')) break;
    if (lines[i].trim() === `- ${ruleText}` || lines[i].trim().slice(2) === ruleText) {
      lines.splice(i, 1);
      break;
    }
  }
  return lines.join('\n');
}

/** 加一条规则（自动去重）。返回 true 表示真的写进去了。 */
export function addRule(file, { section = 'owner', text, date = new Date() } = {}) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!clean) return false;
  let body = ensureSections(file);
  const existing = listAutoRules(body, section);
  if (existing.some((r) => r.includes(clean) || clean.includes(r))) return false;
  const stamp = `${date.getMonth() + 1}/${date.getDate()}`;
  body = insertAfterMarker(body, section, `- ${clean}（${stamp}）`);
  fs.writeFileSync(file, body);
  return true;
}

/** 降级：从规则区段移除，进「模糊印象」。 */
export function demoteRule(file, { section = 'owner', text } = {}) {
  let body = ensureSections(file);
  const target = String(text || '').trim();
  if (!target) return false;
  if (!listAutoRules(body, section).some((r) => r.includes(target))) return false;
  body = removeLine(body, section, target);
  const impression = target.replace(/（\d+\/\d+）$/, '').trim();
  const line = `- 好像有过「${impression.slice(0, 40)}」这回事，但细节记不清了`;
  body = insertAfterMarker(body, 'impression', line);
  fs.writeFileSync(file, body);
  return true;
}

/** 判定哪些规则该忘（长期没用 + 放得够久）。 */
export function pickForgotten(meta, { now = Date.now(), idleDays = 14, minAgeDays = 14 } = {}) {
  const day = 24 * 3600 * 1000;
  return (meta?.rules || []).filter((r) => {
    const added = Number(r.addedAt) || 0;
    const used = Number(r.lastUsedAt) || added;
    return added > 0 && now - used > idleDays * day && now - added > minAgeDays * day;
  });
}

export const __test = { MARKERS, SECTIONS };
