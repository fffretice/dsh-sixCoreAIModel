// media-types 单测（task-21 §4，2026-11-08）
//
// 覆盖 PM 要求：分类、概率上限、连发抑制、存档占位。
import {
  MEDIA_WAKE_DEFAULTS,
  mediaTypeOf,
  mediaPlaceholder,
  stickerEmojiIds,
  hasSeenSticker,
  countRecentStickers,
  stickerWakeProbability,
} from '../src/media-types.js';

let pass = 0;
const ok = (name, fn) => {
  try { fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}\n     ${String(error?.message ?? error)}`); process.exitCode = 1; }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assert failed'); };
const eq = (a, b, msg) => assert(a === b, `${msg || 'eq'}：${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const now = Date.now();

console.log('—— 分类 mediaTypeOf ——');
ok('subType=1 → 表情', () => eq(mediaTypeOf({ mediaList: [{ subType: '1', summary: '' }] }), 'sticker'));
ok('emoji_id → 表情（sub_type 可能为 0）', () => eq(mediaTypeOf({ mediaList: [{ subType: '0', emojiId: 'abc' }] }), 'sticker'));
ok('summary=[动画表情] → 表情', () => eq(mediaTypeOf({ mediaList: [{ summary: '[动画表情]' }] }), 'sticker'));
ok('普通图片 → 图片', () => eq(mediaTypeOf({ mediaList: [{ summary: '', subType: '0' }] }), 'image'));
ok('文本占位 [表情] → 表情；[图片] → 图片；空 → 保守按图片', () => {
  eq(mediaTypeOf({ textContent: '[表情:某某]' }), 'sticker');
  eq(mediaTypeOf({ textContent: '[图片]' }), 'image');
  eq(mediaTypeOf({}), 'image');
});
ok('mediaList 优先于文本', () => eq(mediaTypeOf({ mediaList: [{ summary: '' }], textContent: '[表情]' }), 'image'));

console.log('—— 存档占位 ——');
ok('[表情]/[图片] 占位正确', () => {
  eq(mediaPlaceholder('sticker'), '[表情]');
  eq(mediaPlaceholder('image'), '[图片]');
});
ok('stickerEmojiIds 过滤 pool- 与空', () => {
  eq(JSON.stringify(stickerEmojiIds([{ emojiId: 'a' }, { emojiId: 'pool-3' }, {}, { emojiId: 'b' }])), '["a","b"]');
});
ok('hasSeenSticker：收藏库命中 → true；没命中 → false', () => {
  const entries = [{ id: 'aaa' }, { id: 'bbb' }];
  eq(hasSeenSticker([{ emojiId: 'bbb' }], entries), true);
  eq(hasSeenSticker([{ emojiId: 'ccc' }], entries), false);
  eq(hasSeenSticker([], entries), false);
});

console.log('—— 连发抑制 countRecentStickers ——');
const mk = (text, userId, t) => ({ text, userId, time: t, isSelf: false });
ok('同一人 60 秒内 3 张 → 3；2 张 → 2', () => {
  const r = [mk('[表情]', 'u1', now - 1000), mk('[表情]', 'u1', now - 2000), mk('[表情]', 'u1', now - 3000), mk('[图片]', 'u1', now - 4000)];
  eq(countRecentStickers(r, { userId: 'u1', now, windowMs: 60000 }), 3);
  eq(countRecentStickers(r.slice(0, 2), { userId: 'u1', now, windowMs: 60000 }), 2);
});
ok('超过窗口的不算、别人发的不算、她自己的不算', () => {
  const r = [mk('[表情]', 'u1', now - 120000), mk('[表情]', 'u2', now - 1000), { text: '[表情]', userId: 'u1', time: now - 500, isSelf: true }];
  eq(countRecentStickers(r, { userId: 'u1', now, windowMs: 60000 }), 0);
});

console.log('—— 概率上限 stickerWakeProbability ——');
ok('图片基线 0.35 的表情 → 0.105（×0.3）', () => eq(stickerWakeProbability({ baseProb: 0.35 }), 0.105));
ok('基线 1.0 也封顶 0.12', () => eq(stickerWakeProbability({ baseProb: 1.0 }), 0.12));
ok('见过/收藏过的表情 → 0', () => eq(stickerWakeProbability({ baseProb: 0.35, seen: true }), 0));
ok('同一人连发 ≥3 张 → 0；2 张仍按公式', () => {
  eq(stickerWakeProbability({ baseProb: 0.35, recentStickerCount: 3 }), 0);
  eq(stickerWakeProbability({ baseProb: 0.35, recentStickerCount: 2 }), 0.105);
});
ok('enabled=false 回退为原图片概率', () => eq(stickerWakeProbability({ baseProb: 0.35, opts: { enabled: false } }), 0.35));
ok('默认参数：×0.3 / 上限 0.12 / 窗口 60s / 连发 3 张', () => {
  eq(MEDIA_WAKE_DEFAULTS.stickerProbFactor, 0.3);
  eq(MEDIA_WAKE_DEFAULTS.stickerProbCap, 0.12);
  eq(MEDIA_WAKE_DEFAULTS.burstWindowMs, 60000);
  eq(MEDIA_WAKE_DEFAULTS.burstMax, 3);
});

console.log(`\n${pass} 项通过${process.exitCode ? '，有失败' : '，全部通过 ✅'}`);
