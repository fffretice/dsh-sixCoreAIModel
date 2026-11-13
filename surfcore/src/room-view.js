// 2026-11-10 task-49：房间「让她看看」服务端链路（纯函数层，不读盘/不发 QQ）。
// 浏览器截图 dataURL/base64 → 校验 PNG/≤2MB → 交给 bridge 走 deliverPromptNow 私聊 prompt+图像上下文。
export const ROOM_VIEW_MAX_BYTES = 2 * 1024 * 1024;
export const ROOM_VIEW_MAX_BODY_BYTES = 4 * 1024 * 1024; // base64 膨胀后仍留有 JSON 余量
export const ROOM_VIEW_DEFAULT_TEXT = '老大让你看看现在的房间……桌上给你摆了示例物件（换成你自己的场景）（爆黄那种），慢慢看，看完跟我说说像不像。';
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 解析 room-view 图片入参：
 *  - 支持 `data:image/png;base64,...` 或纯 base64；
 *  - 只接受 PNG（签名 + dataURL mime 校验），解码后 ≤2MB；
 *  - 返回规范化后的纯 base64（去掉 dataURL 头），供 resolveMediaList 使用。
 */
export function parseRoomViewImage(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'image 不能为空（需要 PNG dataURL 或 base64）' };
  let b64 = raw.trim();
  let declaredMime = 'image/png';
  const m = b64.match(/^data:([^;,]+)?;base64,([\s\S]*)$/i);
  if (m) {
    declaredMime = String(m[1] || '').trim().toLowerCase();
    b64 = m[2];
    if (declaredMime && declaredMime !== 'image/png') return { ok: false, error: `只支持 PNG（收到 ${declaredMime}）` };
  }
  const compact = b64.replace(/\s+/g, '');
  if (!compact) return { ok: false, error: '图片数据为空' };
  if (!/^[A-Za-z0-9+/=_-]+$/.test(compact)) return { ok: false, error: '图片 base64 含非法字符' };
  let buf;
  try { buf = Buffer.from(compact, 'base64'); } catch { return { ok: false, error: '图片 base64 解码失败' }; }
  if (!buf.length) return { ok: false, error: '图片解码后为空' };
  if (buf.length > ROOM_VIEW_MAX_BYTES) return { ok: false, error: `图片超过 2MB（解码后 ${(buf.length / 1048576).toFixed(2)}MB）` };
  if (!buf.subarray(0, 8).equals(PNG_SIG)) return { ok: false, error: '不是有效 PNG（文件签名不匹配）' };
  return { ok: true, base64: buf.toString('base64'), bytes: buf.length, mimeType: 'image/png', name: 'room-view.png' };
}

/** 标题/陪伴文案：空则用默认文案；截断到 500 字防异常输入。 */
export function roomViewPrompt(text) {
  const t = String(text ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, 500);
  return t || ROOM_VIEW_DEFAULT_TEXT;
}

/** 交给 deliverPromptNow 的 media 项；resolveMediaList 会走 fetchOneBotImage 的 data 分支。 */
export function roomViewMedia(parsed) {
  return { type: 'image', mediaType: 'image/png', data: parsed.base64, name: parsed.name || 'room-view.png' };
}
