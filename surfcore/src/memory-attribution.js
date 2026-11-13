/**
 * 记忆来源标注（task-52，2026-11-10）—— 纯函数，先离线/shadow，不改生产渲染。
 *
 * 问题：私聊 prompt 里把群来源记录平铺成普通事实，丢了 speaker/groupId，
 * 她可能把群友的话当成老大说的（LOL 案例）。
 * 规则：私聊视图里所有群来源记录必须带 `【群<号>·<群友>】`；无 speaker 不注入；
 * 群视图不重复标注（当前群上下文已隐含来源），但跨群记录仍应标。
 */

export const SOURCE_HINT = '群里的话是群友说的，不等于老大说的；引用前先看说话人。';
export const ATTRIBUTION_VERSION = 1;

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

export function isGroupSourced(record) {
  if (!record) return false;
  if (record.originKind === 'group') return true;
  if (record.source === 'qq-group') return true;
  if (String(record.groupId || '').trim()) return true;
  return /^group:/.test(String(record.conversationKey || ''));
}

export function groupNumberOf(record) {
  const fromKey = String(record?.conversationKey || '').match(/^group:(\d+)/)?.[1];
  return String(record?.groupId || fromKey || '').trim();
}

/** 群来源记录的说话人；无 speaker 或占位「群友」视为缺失。 */
export function speakerOf(record) {
  const sp = norm(record?.speaker || '');
  if (!sp || sp === '群友' || sp === '角色') return '';
  return sp;
}

/** 徽标：群来源 → `【群<号>·<群友>】`；非群源返回 ''；群来源无 speaker 返回 null（不可注入）。 */
export function attributionBadge(record) {
  if (!isGroupSourced(record)) return '';
  const speaker = speakerOf(record);
  if (!speaker) return null;
  const gid = groupNumberOf(record);
  return `【群${gid || '?'}·${speaker}】`;
}

/**
 * 在给定视图渲染一行记忆；群来源记录按规则加徽标。
 * @returns {string|null} null = 群来源缺 speaker，调用方应跳过（不注入）
 */
export function formatRecordLineWithAttribution(record, { view = 'private', currentGroupId = '', body = '' } = {}) {
  if (!record) return null;
  const text = body || norm(record.text || record.title || '');
  if (!text) return null;
  const badge = attributionBadge(record);
  if (badge === null) return null; // 群来源但说不出是谁 → 不注入
  if (!badge) return text;
  // 群视图且同群：上下文已隐含，不必每条加；跨群仍标
  const sameGroup = view === 'group' && currentGroupId && groupNumberOf(record) === String(currentGroupId);
  const prefix = sameGroup ? '' : badge;
  return `${prefix}${prefix ? ' ' : ''}${text}`;
}

/** 审计 prompt 文本：找群来源记录在 prompt 中出现却无徽标/无 speaker 的行。 */
export function auditPromptAttribution(promptText, records, { view = 'private', maxSamples = 50 } = {}) {
  const prompt = String(promptText || '');
  const lines = prompt.split('\n');
  const result = { total: 0, attributed: 0, unattributed: 0, missingSpeaker: 0, violations: [], samples: [] };
  for (const r of Array.isArray(records) ? records : []) {
    if (!isGroupSourced(r)) continue;
    const text = norm(r.text || '').slice(0, 24);
    if (text.length < 6) continue;
    const line = lines.find((l) => l.includes(text));
    if (!line) continue;
    result.total += 1;
    const sp = speakerOf(r);
    if (!sp) { result.missingSpeaker += 1; if (result.samples.length < maxSamples) result.samples.push({ id: r.id, groupId: groupNumberOf(r), speaker: '', line: line.slice(0, 120), issue: 'missing_speaker' }); continue; }
    const badge = attributionBadge(r);
    const ok = line.includes(badge) || (view === 'group' && groupNumberOf(r) === String(r.currentGroupId || ''));
    if (ok) result.attributed += 1;
    else {
      result.unattributed += 1;
      if (result.violations.length < maxSamples) result.violations.push({ id: r.id, groupId: groupNumberOf(r), speaker: sp, expectedBadge: badge, line: line.slice(0, 140) });
    }
  }
  return result;
}

/** 把记录行批量按视图加徽标；缺 speaker 的群记录直接丢弃。 */
export function renderAttributedLines(records, opts = {}) {
  const out = [];
  for (const r of Array.isArray(records) ? records : []) {
    const body = typeof r === 'string' ? r : (r?.body || r?.text || '');
    const line = typeof r === 'string' ? body : formatRecordLineWithAttribution(r, { ...opts, body });
    if (line && line.trim()) out.push(line);
  }
  return out;
}

/** recall API item 补来源字段（供 /api/memory/recall 修复用；纯函数）。 */
export function annotateRecallItem(item, record) {
  const out = { ...(item || {}) };
  if (!record) return out;
  if (isGroupSourced(record)) {
    out.speaker = speakerOf(record);
    out.groupId = groupNumberOf(record);
    out.originKind = 'group';
  } else {
    out.originKind = record.originKind || (record.private ? 'private' : 'unknown');
    if (record.speaker) out.speaker = speakerOf(record) || String(record.speaker);
  }
  return out;
}

/** 私聊 prompt 尾部软提醒（enforce 才加；shadow 由调用方只记录 would-add）。 */
export function appendSourceHint(prompt, { mode = 'shadow' } = {}) {
  const body = String(prompt || '').trimEnd();
  if (mode !== 'enforce' || !body || body.includes(SOURCE_HINT)) return body;
  return `${body}\n\n（${SOURCE_HINT}）`;
}
