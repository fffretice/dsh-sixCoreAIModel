/**
 * 每日记忆整理（dreaming 第一遍）——具体事件笔记 v2（2026-11-08，task-12）
 *
 * 背景（老大 11-08 傍晚反馈 + memory-upgrade.md P1）：
 *   旧的整理只写「私聊里聊到…；一共 58 句，你自己说了 76 句」这种**统计句**：
 *   · 没有信息量，却占掉注入预算（「永远不会忘的」5/5 行都是它）；
 *   · 混着私聊和群聊内容，群聊记忆卡里也会出现私聊摘要 → 她在群里说「上午还在等11/16」；
 *   · 全部 pin 住，永远挤不掉。
 *
 * 现在只产出「具体事件笔记」：谁说了什么（原话 ≤30 字）/ 约定 / 情绪浓度高的事件 / 她做过的动作。
 *   · 每条笔记带结构化来源 originKind（private / group）+ conversationKey；
 *   · 不再写任何统计句；不再 pin；importance 60（不占「永远不会忘的」）；
 *   · 每个会话最多 2–3 个要点，一天最多 5 条；没事件就不写（宁可空一天，不写废话）。
 *
 * 本模块是纯函数（不读盘、不写盘）：桥接 05:30 的定时器读 inbox 后调用它；
 * 单测 / 验证脚本可以直接喂真实 inbox 行。
 */
import { detectEmotionScore, isRecapStatLine } from './memory-card.js';

export const DIGEST_VERSION = 2;

/** 约定 / 承诺 / 道歉 / 和好——这些比普通闲聊更值得记成事件。 */
export const DIGEST_PROMISE_RE = /答应|约定|说好|以后|下次|记得|不要忘|别忘了|发誓|保证|我会/;
export const DIGEST_CONFLICT_RE = /吵架|生气|道歉|对不起|和好|误会|不理你|冷战|凶你|原谅/;
/** 情绪浓度高的句子（和 memory-card 的 EMOTION_STRONG_RE 同源，但这里只判「值得记」）。 */
const DIGEST_EMOTION_RE = /喜欢|想念|想你|舍不得|难过|委屈|哭|心疼|感动|害怕|孤单|抱歉|对不起|谢谢|抱抱|亲亲|陪伴|永远|最爱|在乎|重要/;

function localDayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function clip(text, max = 30) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 群标签：群 <群号> → 只留「群 <群号>」；私聊 → 「私聊」。 */
function labelOf(conversationKey) {
  const key = String(conversationKey || '');
  if (key.startsWith('group:')) return `群 ${key.slice('group:'.length)}`;
  if (key === 'pet') return '桌宠';
  return '私聊';
}

function originKindOfKey(conversationKey) {
  const key = String(conversationKey || '');
  if (key.startsWith('group:')) return 'group';
  if (key === 'pet') return 'pet';
  return 'private';
}

function pickQuote(row, { minChars = 4 } = {}) {
  const text = String(row?.text ?? '').replace(/^@[^\s]+\s*/u, '').trim();
  if (!text || text.length < minChars) return '';
  if (isRecapStatLine(text)) return '';
  // 纯语气词/应答（「确实」「挺好的」「好」）没有信息量，不作为事件引用
  if (text.replace(/[\s，。！？!?～~（）()「」]/g, '').length < 6) return '';
  return clip(text, 30);
}

/** 引用打分：越长越具体、含约定/矛盾/情绪词的优先；同分取更近的。 */
function quoteScore(text) {
  let score = Math.min(18, String(text ?? '').length);
  if (DIGEST_PROMISE_RE.test(text)) score += 12;
  if (DIGEST_CONFLICT_RE.test(text)) score += 10;
  if (DIGEST_EMOTION_RE.test(text)) score += 8;
  return score;
}

/** 从候选行里挑最多 n 条引用：按分数倒序、去重、保留最近时间。 */
function pickTopQuotes(rows, n = 2) {
  const scored = rows
    .map((row) => ({ row, quote: pickQuote(row) }))
    .filter((x) => x.quote)
    .map((x) => ({ ...x, score: quoteScore(x.quote) + Math.min(6, Number(x.row.at) / 1e13) }))
    .sort((a, b) => b.score - a.score);
  const out = [];
  const seen = new Set();
  for (const item of scored) {
    const key = item.quote.replace(/[\s，。！？!?～~（）()「」]/g, '').slice(0, 16);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= n) break;
  }
  return out;
}

function speakerOf(row) {
  const who = String(row?.sender || row?.speaker || '').replace(/\s+/g, ' ').trim();
  if (!who) return '有人';
  return who.length > 12 ? `${who.slice(0, 12)}…` : who;
}

/**
 * 从一段时间窗内的 inbox 行 + synced-facts 生成事件笔记。
 *
 * @param {object} opts
 * @param {string[]} opts.inboxLines   memory-inbox.jsonl 的原始行（JSON 字符串）
 * @param {Array}   [opts.syncedFacts] state/synced-facts.json 的 items（私聊「他说过/我说过」兜底）
 * @param {number}  [opts.now]
 * @param {number}  [opts.windowMs]    默认 30 小时（和旧 digest 一致）
 * @param {number}  [opts.maxNotes]    默认 5
 * @returns {Array<{title:string,text:string,originKind:string,conversationKey:string,importance:number,tags:string[]}>}
 */
export function buildDailyDigestItems({
  inboxLines = [],
  syncedFacts = [],
  now = Date.now(),
  windowMs = 30 * 3600 * 1000,
  maxNotes = 5,
} = {}) {
  const since = now - Math.max(3600 * 1000, Number(windowMs) || 0);
  const rows = [];
  for (const line of inboxLines) {
    const raw = typeof line === 'string' ? line : '';
    if (!raw.trim()) continue;
    let row;
    try { row = JSON.parse(raw); } catch { continue; }
    if (!row || typeof row !== 'object') continue;
    const at = Date.parse(String(row.at ?? ''));
    if (!Number.isFinite(at) || at < since || at > now + 5 * 60 * 1000) continue;
    const text = String(row.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text || isRecapStatLine(text)) continue;
    rows.push({ ...row, at, text });
  }

  const byConv = new Map();
  for (const row of rows) {
    const key = String(row.conversationKey || (row.groupId ? `group:${row.groupId}` : 'private:unknown'));
    const list = byConv.get(key) || [];
    list.push(row);
    byConv.set(key, list);
  }

  const notes = [];
  for (const [key, list] of byConv) {
    const originKind = originKindOfKey(key);
    if (originKind === 'pet') continue; // 桌宠是私下相处，不进每日回顾
    const label = labelOf(key);
    const sorted = list.slice().sort((a, b) => a.at - b.at);
    const parts = [];

    // ① 主人/管理员说的话（按信息量挑，最多 2 句；「确实」「挺好的」这种会被过滤）
    const ownerPicks = pickTopQuotes(sorted.filter((r) => !r.isSelf && r.isOwner === true), 2);
    const ownerQuotes = ownerPicks.map((x) => x.quote);
    for (const quote of ownerQuotes) parts.push(`老大说「${quote}」`);

    // ② 值得记的群友发言：约定 / 情绪 / 矛盾（最多 2 句，去重）
    const notablePicks = pickTopQuotes(sorted
      .filter((r) => !r.isSelf && r.isOwner !== true)
      .filter((r) => DIGEST_PROMISE_RE.test(r.text) || DIGEST_CONFLICT_RE.test(r.text)
        || DIGEST_EMOTION_RE.test(r.text) || detectEmotionScore(r.text) >= 8), 2);
    for (const item of notablePicks) parts.push(`${speakerOf(item.row)}说「${item.quote}」`);

    // ③ 她做过的动作（换头像、画画、发语音……最多 1 件）
    const actionPicks = pickTopQuotes(sorted.filter((r) => r.isSelf && r.action === true), 1);
    for (const item of actionPicks) parts.push(`她做过「${item.quote}」`);

    // ④ 她自己说的、情绪浓度高/带约定的话（最多 1 句）
    const herPicks = pickTopQuotes(sorted
      .filter((r) => r.isSelf && r.action !== true)
      .filter((r) => DIGEST_PROMISE_RE.test(r.text) || DIGEST_CONFLICT_RE.test(r.text)
        || DIGEST_EMOTION_RE.test(r.text) || detectEmotionScore(r.text) >= 8), 1);
    for (const item of herPicks) parts.push(`她说「${item.quote}」`);

    // ⑤ 私聊兜底：inbox 里没抓到主人原话时，用 synced-facts 的「他说过/我说过」
    if (originKind === 'private' && !ownerQuotes.length) {
      const items = (Array.isArray(syncedFacts) ? syncedFacts : [])
        .filter((x) => x && Number(x.at) >= since)
        .slice(-6);
      const cleanFact = (x) => {
        const text = String(x.text ?? '').replace(/\s+/g, ' ').trim();
        return text.length >= 6 ? clip(text, 30) : '';
      };
      const his = items.filter((x) => x.who === 'he').slice(-2).map(cleanFact).filter(Boolean);
      const mine = items.filter((x) => x.who === 'me').slice(-1).map(cleanFact).filter(Boolean);
      if (his.length) parts.push(`他说过${his.map((t) => `「${t}」`).join('')}`);
      if (mine.length) parts.push(`她说「${mine[0]}」`);
    }

    if (!parts.length) continue;
    notes.push({
      title: `最近回顾 · ${label}`,
      text: `${localDayKey(now)} ${label}：${parts.join('；')}。`,
      originKind,
      conversationKey: key,
      importance: 60,
      tags: ['回顾', '事件'],
      lastAt: sorted.length ? sorted[sorted.length - 1].at : now,
    });
  }

  // ⑤ 兜底：inbox 里完全没抓到私聊行时，用 synced-facts 生成一条私聊笔记
  const hasPrivate = notes.some((n) => n.originKind === 'private');
  if (!hasPrivate) {
    const items = (Array.isArray(syncedFacts) ? syncedFacts : []).filter((x) => x && Number(x.at) >= since);
    const cleanFact = (x) => {
      const text = String(x.text ?? '').replace(/\s+/g, ' ').trim();
      return text.length >= 6 ? clip(text, 30) : '';
    };
    const his = items.filter((x) => x.who === 'he').slice(-2).map(cleanFact).filter(Boolean);
    const mine = items.filter((x) => x.who === 'me').slice(-1).map(cleanFact).filter(Boolean);
    const parts = [];
    if (his.length) parts.push(`他说过${his.map((t) => `「${t}」`).join('')}`);
    if (mine.length) parts.push(`她说「${mine[0]}」`);
    if (parts.length) {
      notes.push({
        title: '最近回顾 · 私聊',
        text: `${localDayKey(now)} 私聊：${parts.join('；')}。`,
        originKind: 'private',
        conversationKey: 'private:unknown',
        importance: 60,
        tags: ['回顾', '事件'],
        lastAt: now,
      });
    }
  }

  // 排序：私聊优先（主人是最重要的线索），其余按最近活动时间倒序；一天最多 maxNotes 条。
  notes.sort((a, b) => {
    const pa = a.originKind === 'private' ? 1 : 0;
    const pb = b.originKind === 'private' ? 1 : 0;
    return (pb - pa) || (b.lastAt - a.lastAt);
  });
  return notes.slice(0, Math.max(1, Math.min(10, Number(maxNotes) || 5))).map(({ lastAt, ...item }) => item);
}
