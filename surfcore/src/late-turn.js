// 2026-11-09（task-25 ②）：回合进行中新到消息的补上下文块。
// 背景：09:43 老大发链接/漫画时她在回合中，bridge 记「会话繁忙，暂存唤醒原因」只存 reason；
// 她 close(throughSeq=3935) 把 3928–3935 标已读，下一轮 prompt unread=1/recent=4/quote=6，
// 中途的链接/漫画行全被窗口切掉。这里把「上一轮 prompt 之后到达、且没在上一轮窗口出现过」的消息
// 在下一轮 prompt 里显式列出来（≤5 条，按 messageId 去重）。

export const DEFAULT_LATE_TURN = { enabled: true, maxItems: 5, windowMinutes: 20 };

function fmtTime(ms) {
  try { return new Date(Number(ms)).toTimeString().slice(0, 5); } catch { return ''; }
}

/**
 * 生成「你上一轮回复时，这几条还没到」块。
 * @param messages 入站消息环形缓冲（每条含 messageId/seq/sender/time/text/media/hasMedia/linkPreview）
 * @param opts { lastPromptAt, now, maxItems, windowMinutes, renderedIds }
 * @returns { block, ids, imageIds }（block 为空串表示没有）
 */
export function buildLateTurnBlock(messages, opts = {}) {
  const lastPromptAt = Number(opts.lastPromptAt || 0);
  const now = Number(opts.now || Date.now());
  const maxItems = Math.max(1, Number(opts.maxItems) || DEFAULT_LATE_TURN.maxItems);
  const windowMs = Math.max(1, Number(opts.windowMinutes) || DEFAULT_LATE_TURN.windowMinutes) * 60e3;
  const renderedIds = opts.renderedIds instanceof Set ? opts.renderedIds : new Set(opts.renderedIds || []);
  const seen = new Set();
  const picked = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || m.isSelf) continue;
    const t = Number(m.time || 0);
    if (!t) continue;
    if (t <= lastPromptAt) continue;            // 上一轮 prompt 之前就有的，不算「中途新到」
    if (now - t > windowMs) continue;           // 太旧的忽略
    const id = String(m.messageId || '');
    const key = id || `seq:${m.seq}`;
    if (seen.has(key) || renderedIds.has(key)) continue;
    seen.add(key);
    picked.push({ ...m, _id: key, _time: t });
  }
  picked.sort((a, b) => a._time - b._time);
  const list = picked.slice(-maxItems);         // 最多 5 条，优先最近的
  if (!list.length) return { block: '', ids: [], imageIds: [] };
  const rows = list.map((m) => {
    const media = Array.isArray(m.media) ? m.media : [];
    const img = media.find((x) => x && x.kind === 'image');
    const sticker = media.find((x) => x && x.kind === 'sticker');
    const kind = img ? '图' : (sticker ? '表情' : '话');
    const idText = String(m.messageId || '').trim();
    const preview = m.linkPreview && m.linkPreview.ok ? `［推文 @${String(m.linkPreview.author || '').replace(/^@/, '')}：${String(m.linkPreview.text || '').slice(0, 80)}］` : '';
    const text = String(m.text || '').replace(/\s+/g, ' ').slice(0, 40);
    const hint = img && idText ? `（图可用 qq_get_message_images 看，id ${idText}）` : '';
    return `- ${fmtTime(m.time)} ${String(m.sender || '某人').slice(0, 12)}（${kind}）${text}${preview ? ` ${preview}` : ''}${hint}${idText ? ` · id ${idText}` : ''}`;
  });
  const block = `\n【你上一轮回复时，这几条还没到】\n${rows.join('\n')}\n（这些是刚才那轮里后来才到的；有图可以先用 qq_get_message_images 看一眼，有链接正文已附在消息里。别拿它们猜内容。）\n`;
  return { block, ids: list.map((m) => m._id), imageIds: list.filter((m) => Array.isArray(m.media) && m.media.some((x) => x && x.kind === 'image')).map((m) => String(m.messageId || '')).filter(Boolean) };
}

/** 供下一轮取图优先级：返回「晚到消息」里的图片 messageId（按时间升序）。 */
export function collectLateImageIds(messages, opts = {}) {
  return buildLateTurnBlock(messages, opts).imageIds;
}
