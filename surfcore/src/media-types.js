/**
 * 表情包 vs 普通图片：类型判定 + 唤醒概率（task-21 §4，2026-11-08）。
 *
 * 根因（审计发现）：桥接的纯图片分支把所有媒体都当同一种东西——
 *   · 入库强制写 '[图片]'（`appendSocialV2Message(key, senderName, '[图片]', …)`），
 *     表情包在上下文里也变成「图片」，她就会去评论/解读一个表情；
 *   · 唤醒概率同一套：`onlyMediaPlaceholder` 同时匹配 [图片]/[表情]，imageProb 一样，
 *     表情包也能把睡着的她按图片的概率叫醒。
 *
 * 这个模块只做纯判断，方便单测：
 *   · mediaTypeOf：从 mediaList（summary/kind/emojiId/subType）或文本占位判类型
 *   · mediaPlaceholder：入库/上下文用的占位文本（[表情] / [图片]）
 *   · stickerWakeProbability：表情唤醒概率（base × 0.3，上限 0.12；见过/收藏过 → 0；
 *     同一人 60 秒内连发 ≥3 张 → 不唤醒）
 * 图片侧保持原概率不变，由 bridge 原逻辑算。
 */
import { findSticker } from './sticker-lib.js';

export const MEDIA_WAKE_DEFAULTS = Object.freeze({
  enabled: true,             // socialV2.mediaWakeSplit.enabled=false 可回退旧行为
  stickerProbFactor: 0.3,    // 表情：图片概率 × 0.3
  stickerProbCap: 0.12,      // 上限 0.12
  burstWindowMs: 60 * 1000,  // 连发窗口
  burstMax: 3,               // 同一人窗口内 ≥3 张表情 → 不唤醒
});

function isStickerItem(m) {
  if (!m || typeof m !== 'object') return false;
  const summary = String(m.summary ?? '');
  const kind = String(m.kind ?? m.type ?? '');
  if (/动画表情/.test(summary)) return true;
  if (/sticker/i.test(kind)) return true;
  if (m.emojiId || m.emoji_id) return true;
  const sub = String(m.subType ?? m.sub_type ?? '');
  if (sub === '1') return true;
  if (/^\[表情/.test(String(m.text ?? m.placeholder ?? ''))) return true;
  return false;
}

/**
 * @param {{mediaList?: Array, textContent?: string}} input
 * @returns {'sticker'|'image'} mediaList 为空时按文本占位判；都没有按 image（保守）
 */
export function mediaTypeOf({ mediaList = [], textContent = '' } = {}) {
  const list = Array.isArray(mediaList) ? mediaList : [];
  if (list.length) return list.some(isStickerItem) ? 'sticker' : 'image';
  const t = String(textContent || '').trim();
  if (/^\[表情/.test(t)) return 'sticker';
  return 'image';
}

/** 入库 / 上下文占位：表情包 → [表情]，其余 → [图片]。 */
export function mediaPlaceholder(type) {
  return type === 'sticker' ? '[表情]' : '[图片]';
}

/** 从 mediaList 取表情 id（', pool-' 开头的本地池 id 不算）。 */
export function stickerEmojiIds(mediaList = []) {
  const out = [];
  for (const m of Array.isArray(mediaList) ? mediaList : []) {
    const id = String(m?.emojiId ?? m?.emoji_id ?? '').trim();
    if (!id || id.startsWith('pool-')) continue;
    out.push(id);
  }
  return out;
}

/** 这些表情里有没有她收藏过/见过的（找到任意一个就算）。 */
export function hasSeenSticker(mediaList = [], entries = []) {
  for (const id of stickerEmojiIds(mediaList)) {
    try {
      if (findSticker(entries, id)) return true;
    } catch {}
  }
  return false;
}

/** 同一发送者最近 windowMs 内发了几张表情（用于连发抑制）。 */
export function countRecentStickers(recentMessages = [], { userId = '', now = Date.now(), windowMs = MEDIA_WAKE_DEFAULTS.burstWindowMs } = {}) {
  const since = Number(now) - Number(windowMs);
  const sid = String(userId || '');
  let n = 0;
  for (const m of Array.isArray(recentMessages) ? recentMessages : []) {
    if (!m || m.isSelf) continue;
    if (sid && String(m.userId ?? m.senderId ?? m.sender ?? '') !== sid) continue;
    const t = Number(m.time ?? m.at ?? 0);
    if (!t || t < since) continue;
    const text = String(m.text ?? m.plain ?? '');
    if (/^\[表情/.test(text)) n += 1;
  }
  return n;
}

/**
 * 表情的唤醒概率。
 * @param {{baseProb?:number, seen?:boolean, recentStickerCount?:number, opts?:object}} args
 */
export function stickerWakeProbability({ baseProb = 0, seen = false, recentStickerCount = 0, opts = {} } = {}) {
  const o = { ...MEDIA_WAKE_DEFAULTS, ...(opts || {}) };
  const base = Math.max(0, Number(baseProb) || 0);
  if (o.enabled === false) return base;
  if (seen) return 0;                                          // 收藏过/见过：不叫醒
  if (Number(recentStickerCount) >= Number(o.burstMax)) return 0; // 连发刷屏：不叫醒
  return Math.max(0, Math.min(Number(o.stickerProbCap), base * Number(o.stickerProbFactor)));
}
