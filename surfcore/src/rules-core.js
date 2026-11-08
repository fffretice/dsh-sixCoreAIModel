/**
 * 规则核心的自动写入与遗忘（2026-10-30 老大定的规则）
 *
 *   · 老大教的 → 直接进规则核心，但**语义是「强倾向」而不是硬规则**：
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
  owner: '## 老大教过的（分量最重，但不是命令）',
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
  body = trimAutoRules(body, section, section === 'owner' ? 18 : 12);
  fs.writeFileSync(file, body);
  return true;
}

/** 自动区段封顶：只留最新的 N 条，旧的直接丢掉（不进印象，避免越堆越多）。 */
function trimAutoRules(text, section, max) {
  const marker = MARKERS[section];
  const at = text.indexOf(marker);
  if (at < 0) return text;
  const head = text.slice(0, at + marker.length);
  const rest = text.slice(at + marker.length);
  const lines = rest.split('\n');
  let kept = 0;
  const out = [];
  for (const line of lines) {
    if (line.trim().startsWith('- ')) {
      if (kept < max) { out.push(line); kept += 1; }
      continue;
    }
    if (line.includes('<!-- AUTO:') && line !== marker) {
      out.push(...lines.slice(lines.indexOf(line)));
      break;
    }
    out.push(line);
  }
  return head + out.join('\n');
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
  // 2026-11-06：降级从 14 天缩到 48 小时后，这节会涨得很快。
  // 只留最近 15 条——细节反正都写进记忆库了，这里只负责「提醒有这么回事」。
  body = trimImpressionSection(body, 15);
  fs.writeFileSync(file, body);
  return true;
}

/** 判定哪些规则该忘（长期没用 + 放得够久）。 */
/** 只保留 impression 段最近 n 条，防止它撑爆规则文件。 */
function trimImpressionSection(body, keep = 15) {
  const marker = MARKERS.impression;
  const at = body.indexOf(marker);
  if (at < 0) return body;
  const head = body.slice(0, at + marker.length);
  const rest = body.slice(at + marker.length);
  const nextSection = rest.search(/\n## /);
  const secBody = nextSection >= 0 ? rest.slice(0, nextSection) : rest;
  const tail = nextSection >= 0 ? rest.slice(nextSection) : '';
  const lines = secBody.split('\n').filter((l) => l.trim().startsWith('- '));
  if (lines.length <= keep) return body;
  return head + '\n' + lines.slice(-keep).join('\n') + '\n' + tail;
}

export function pickForgotten(meta, { now = Date.now(), idleDays = 2, minAgeDays = 2 } = {}) {
  // 2026-11-06 老大要求：从 14 天缩到 48 小时。
  // 规则核心常年贴着 6000 上限（今天还超限截掉了三条真规则），
  // 那些几十天没碰过的条目不腾地方，新规则就进不来。
  // 降级不是删除——印象会写进记忆库，她以后遇到类似情况能翻到。
  const day = 24 * 3600 * 1000;
  return (meta?.rules || []).filter((r) => {
    const added = Number(r.addedAt) || 0;
    const used = Number(r.lastUsedAt) || added;
    return added > 0 && now - used > idleDays * day && now - added > minAgeDays * day;
  });
}

export const __test = { MARKERS, SECTIONS };
