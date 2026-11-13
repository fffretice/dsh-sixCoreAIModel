/**
 * Dreaming 第二遍（task-9 P5）—— 纯逻辑骨架（2026-11-10）
 *
 * 职责：夜间离线体检/去重/状态核对/主题合并计划，只产出「计划」不写盘；
 * `scripts/memory-dream.mjs` 负责 dry-run 报告（--apply 待 PM 批）。
 * 安全原则：不删记录（只标 status/superseded/归档）；单日每类上限；唯一 id 不减。
 */
import { isRecapStatLine, isNoteRecord } from './memory-card.js';

export const DREAM_VERSION = 1;
export const DREAM_LIMITS = Object.freeze({ maxChangePerCategory: 20, similarity: 0.7, minFragmentChars: 6, days: 7, maxTopicFacts: 40 });

const norm = (s) => String(s || '').replace(/\s+/g, ' ').replace(/^@[^\s]+[\s:：]*/u, '').trim();

/** 字符 2-gram Jaccard 相似度（中文友好，无模型）。 */
export function textSimilarity(a, b) {
  const ga = bigrams(norm(a)), gb = bigrams(norm(b));
  if (!ga.size || !gb.size) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter += 1;
  return inter / (ga.size + gb.size - inter);
}
function bigrams(text) {
  const s = String(text || '').replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i + 2 <= s.length; i += 1) out.add(s.slice(i, i + 2));
  return out;
}
const dayOf = (r) => String(r?.createdAt || '').slice(0, 10);

/** 低价值条目：回顾统计句 / 纯占位符 / 极短碎片 / 重复的 pinned 摘要。 */
export function lowValueCandidates(records) {
  const out = { recapStats: [], placeholders: [], tooShort: [], pinnedNotes: [] };
  for (const r of Array.isArray(records) ? records : []) {
    const text = String(r?.text || '').trim();
    if (!text) continue;
    if (isRecapStatLine(text)) { out.recapStats.push(r); continue; }
    if (/^\[(图片|视频|表情|表情包|语音|文件|转发消息|拍一拍)[^\]]*\]$/.test(text)) { out.placeholders.push(r); continue; }
    if (norm(text).length < DREAM_LIMITS.minFragmentChars) { out.tooShort.push(r); continue; }
    if (r.pinned === true && isNoteRecord(r)) out.pinnedNotes.push(r);
  }
  return out;
}

/** 同日 + 文本相似度 > 阈值 → 重复组（保留 importance 最高/pinned 的那条作为 keep）。 */
export function dedupeGroups(records, { threshold = DREAM_LIMITS.similarity, maxGroups = DREAM_LIMITS.maxChangePerCategory } = {}) {
  const list = (Array.isArray(records) ? records : []).filter((r) => norm(r?.text || '').length >= DREAM_LIMITS.minFragmentChars);
  const used = new Set();
  const groups = [];
  for (let i = 0; i < list.length && groups.length < maxGroups; i += 1) {
    const a = list[i];
    if (used.has(a.id)) continue;
    const group = [a];
    for (let j = i + 1; j < list.length; j += 1) {
      const b = list[j];
      if (used.has(b.id) || dayOf(a) !== dayOf(b)) continue;
      if (textSimilarity(a.text, b.text) >= threshold) { group.push(b); used.add(b.id); }
    }
    if (group.length >= 2) {
      used.add(a.id);
      group.sort((x, y) => (Number(y.importance) || 0) - (Number(x.importance) || 0) || Number(y.pinned) - Number(x.pinned));
      groups.push({ keep: group[0], drop: group.slice(1), similarity: Number(textSimilarity(group[0].text, group[1].text).toFixed(2)) });
    }
  }
  return groups;
}

/** 状态核对计划：unconfirmed 且无 verifiedAt 的笔记 → 待核对；superseded 的笔记 → 待归档。 */
export function statusReviewPlan(records) {
  const review = []; const superseded = [];
  for (const r of Array.isArray(records) ? records : []) {
    if (!isNoteRecord(r)) continue;
    if (r.status === 'unconfirmed' && !r.verifiedAt) review.push(r);
    if (r.status === 'superseded') superseded.push(r);
  }
  return { reviewNoteIds: review.map((r) => r.id), supersededNoteIds: superseded.map((r) => r.id) };
}

/** 主题合并计划：同主题内相似事实合并（保留新/重要），状态主题旧事实标 superseded，超过 40 条提示截断。 */
export function topicMergePlan(topicFacts, { maxFacts = DREAM_LIMITS.maxTopicFacts, stateTopics = new Set(['头像']) } = {}) {
  const facts = (Array.isArray(topicFacts) ? topicFacts : []).slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const merges = [];
  const used = new Set();
  for (let i = 0; i < facts.length; i += 1) {
    if (used.has(i)) continue;
    for (let j = i + 1; j < facts.length; j += 1) {
      if (used.has(j)) continue;
      if (textSimilarity(facts[i].text, facts[j].text) >= DREAM_LIMITS.similarity) {
        merges.push({ keep: facts[i], drop: [facts[j]], similarity: Number(textSimilarity(facts[i].text, facts[j].text).toFixed(2)) });
        used.add(j);
        if (merges.length >= DREAM_LIMITS.maxChangePerCategory) break;
      }
    }
    if (merges.length >= DREAM_LIMITS.maxChangePerCategory) break;
  }
  return { merges, overCap: Math.max(0, facts.length - maxFacts), stateTopicOldCount: stateTopics.size ? facts.length - 1 : 0 };
}

/** 汇总一份 dreaming 计划（dry-run 报告用）。 */
export function buildDreamPlan({ records = [], topicFactsByTopic = {}, now = Date.now() } = {}) {
  const low = lowValueCandidates(records);
  const duplicates = dedupeGroups(records);
  const status = statusReviewPlan(records);
  const topics = {};
  for (const [name, facts] of Object.entries(topicFactsByTopic)) {
    const plan = topicMergePlan(facts);
    if (plan.merges.length || plan.overCap) topics[name] = plan;
  }
  return {
    version: DREAM_VERSION,
    at: new Date(now).toISOString(),
    counts: {
      records: records.length,
      recapStats: low.recapStats.length,
      placeholders: low.placeholders.length,
      tooShort: low.tooShort.length,
      pinnedNotes: low.pinnedNotes.length,
      duplicateGroups: duplicates.length,
      duplicateDrops: duplicates.reduce((n, g) => n + g.drop.length, 0),
      notesToReview: status.reviewNoteIds.length,
      notesSuperseded: status.supersededNoteIds.length,
      topicsWithMerge: Object.keys(topics).length,
    },
    sample: {
      recapStats: low.recapStats.slice(0, 3).map((r) => ({ id: r.id, text: String(r.text).slice(0, 60) })),
      duplicateGroups: duplicates.slice(0, 3).map((g) => ({ keep: g.keep.id, drop: g.drop.map((r) => r.id), similarity: g.similarity, keepText: String(g.keep.text).slice(0, 60) })),
      reviewNoteIds: status.reviewNoteIds.slice(0, 5),
      topics: Object.keys(topics).slice(0, 5),
    },
    limits: { ...DREAM_LIMITS },
  };
}
