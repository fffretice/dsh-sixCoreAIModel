/**
 * 记忆首轮兜底 + 卡片卫生（task-60，2026-11-11）—— 纯函数，先审计/shadow，不接线。
 *
 * 首轮兜底：现在 bridge 只调 recentEventsFirstTurnLine；image 唤醒没有 recent-event 时
 * 不会用 imageFallbackDecision → 图片首轮上下文缺失。这里给统一选择器，后续桥接窗口接线。
 * 卡片卫生：统计句已有维护器清理；这里补审计/清理计划（占位、重复、过期、待核），只出计划不改卡。
 */
import { isRecapStatLine, isNoteRecord } from './memory-card.js';

export const HYGIENE_VERSION = 1;

/** 统一首轮兜底选择：recent-events 优先；无事件且本轮带图 → image fallback；互斥。 */
export function pickFirstTurnAux({ eventDecision = null, imageDecision = null, mediaCount = 0, mode = 'shadow' } = {}) {
  const m = mode === 'inject' ? 'inject' : 'shadow';
  const eventLine = eventDecision?.reason === 'inject' && eventDecision?.line ? String(eventDecision.line) : '';
  if (eventLine) {
    return { source: 'recent-events', line: eventLine, wouldInject: true, inject: m === 'inject', mode: m, reason: 'event' };
  }
  const imageLine = Number(mediaCount) > 0 && imageDecision?.reason === 'inject' && imageDecision?.line ? String(imageDecision.line) : '';
  if (imageLine) {
    return { source: 'image', line: imageLine, wouldInject: true, inject: m === 'inject', mode: m, reason: 'image' };
  }
  return { source: 'none', line: '', wouldInject: false, inject: false, mode: m, reason: 'none' };
}

const PLACEHOLDER_RE = /^\[(图片|视频|表情|表情包|语音|文件|转发消息|拍一拍)[^\]]*\]$/;

/** 单条记录的卫生问题（纯函数；duplicate 由组级审计处理）。 */
export function classifyCardHygiene(record, { now = Date.now() } = {}) {
  if (!record) return [];
  const text = String(record.text || '').trim();
  const issues = [];
  if (isRecapStatLine(text)) issues.push('recap_stat');
  if (PLACEHOLDER_RE.test(text)) issues.push('placeholder');
  if (record.status === 'superseded') issues.push('expired');
  if (record.status === 'unconfirmed' && isNoteRecord(record)) issues.push('note_pending');
  const ageDays = (now - Number(Date.parse(String(record.createdAt || '')))) / 86400_000;
  if (!record.pinned && !record.isInitial && Number(record.importance) < 15 && ageDays > 30) issues.push('stale_low_value');
  return issues;
}

/** 组级重复：同日 + 同 source/speaker + 同文。 */
export function findDuplicateGroups(records) {
  const map = new Map();
  for (const r of Array.isArray(records) ? records : []) {
    const key = `${String(r.createdAt || '').slice(0, 10)}|${r.source || ''}|${r.speaker || ''}|${String(r.text || '').replace(/\s+/g, ' ')}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return [...map.values()].filter((g) => g.length > 1);
}

/** 全卡卫生审计：统计 + 样本；不写盘。 */
export function auditCardHygiene(records, { now = Date.now(), maxRecords = 5000 } = {}) {
  const list = Array.isArray(records) ? records : [];
  const counts = { total: list.length, recapStat: 0, placeholder: 0, expired: 0, notePending: 0, staleLowValue: 0 };
  const samples = { recapStat: [], placeholder: [], expired: [], notePending: [] };
  for (const r of list) {
    const issues = classifyCardHygiene(r, { now });
    if (issues.includes('recap_stat')) { counts.recapStat += 1; if (samples.recapStat.length < 5) samples.recapStat.push(r.id); }
    if (issues.includes('placeholder')) { counts.placeholder += 1; if (samples.placeholder.length < 5) samples.placeholder.push(r.id); }
    if (issues.includes('expired')) { counts.expired += 1; if (samples.expired.length < 5) samples.expired.push(r.id); }
    if (issues.includes('note_pending')) { counts.notePending += 1; if (samples.notePending.length < 5) samples.notePending.push(r.id); }
    if (issues.includes('stale_low_value')) counts.staleLowValue += 1;
  }
  const duplicateGroups = findDuplicateGroups(list);
  return {
    version: HYGIENE_VERSION,
    at: new Date(now).toISOString(),
    counts: { ...counts, duplicateGroups: duplicateGroups.length, duplicateDrops: duplicateGroups.reduce((n, g) => n + g.length - 1, 0) },
    capacity: { records: list.length, maxRecords, atCap: list.length >= maxRecords },
    duplicateGroups: duplicateGroups.slice(0, 20).map((g) => ({ keep: g[0].id, drop: g.slice(1).map((r) => r.id), text: String(g[0].text || '').slice(0, 60) })),
    samples,
  };
}

/** 清理计划（纯函数，不改记录）：移除统计句/占位/重复；过期只标记、待核只列表。 */
export function planCardHygiene(records, { now = Date.now() } = {}) {
  const list = Array.isArray(records) ? records : [];
  const removeIds = new Set();
  const reviewIds = new Set();
  const expiredIds = new Set();
  for (const r of list) {
    const issues = classifyCardHygiene(r, { now });
    if (issues.includes('recap_stat') || issues.includes('placeholder')) removeIds.add(r.id);
    if (issues.includes('note_pending')) reviewIds.add(r.id);
    if (issues.includes('expired')) expiredIds.add(r.id);
  }
  const drops = [];
  for (const g of findDuplicateGroups(list)) {
    const sorted = g.slice().sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0));
    for (const r of sorted.slice(1)) { removeIds.add(r.id); drops.push(r.id); }
  }
  return {
    version: HYGIENE_VERSION,
    dryRun: true,
    removeIds: [...removeIds],
    expiredIds: [...expiredIds],
    reviewIds: [...reviewIds],
    duplicateDrops: drops,
    counts: { remove: removeIds.size, review: reviewIds.size, expiredMarked: expiredIds.size },
  };
}
