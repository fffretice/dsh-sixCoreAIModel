// 2026-11-09（task-25 ①）：x/twitter 链接正文预览。
// 只读公开代理域，不把聊天内容发出去，只发 URL 本身。
// 背景：本机到 publish.twitter.com / syndication.twimg.com 超时（oEmbed 不可用），
//   api.fxtwitter.com / api.vxtwitter.com 可用（实测 0.74~1.0s 返回 text/author）。
// 隐私：默认 ownerOnly=true（前 3 天只处理老大发的链接），enabled=false 可一键关。

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_LINK_PREVIEW = {
  enabled: true,
  ownerOnly: true,
  timeoutMs: 2500,
  maxChars: 200,
  cacheTtlDays: 7,
  cacheMax: 500,
  windowMinutes: 30,
  maxPerPrompt: 2,
};

// 支持带协议/裸域、x.com 与 twitter.com；只认 /<user>/status/<id> 形态。
const LINK_RE = /(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,32})\/status\/(\d{5,25})/g;

/** 从一段文本里抽 status 链接（去重）。 */
export function extractStatusLinks(text) {
  const src = String(text ?? '');
  const out = [];
  const seen = new Set();
  for (const m of src.matchAll(LINK_RE)) {
    const statusId = m[2];
    if (seen.has(statusId)) continue;
    seen.add(statusId);
    out.push({ statusId, user: m[1], url: `https://x.com/${m[1]}/status/${statusId}` });
  }
  return out;
}

/** 是否该为这条消息做预览（隐私开关 + ownerOnly）。 */
export function shouldPreviewLink({ isOwner = false, cfg = DEFAULT_LINK_PREVIEW } = {}) {
  const c = { ...DEFAULT_LINK_PREVIEW, ...(cfg || {}) };
  if (c.enabled === false) return false;
  if (c.ownerOnly && !isOwner) return false;
  return true;
}

function cleanTweetText(text, maxChars) {
  return String(text ?? '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, Math.max(20, Number(maxChars) || 200));
}

/** 成功预览 → 写回消息的文本注解。 */
export function formatTweetAnnotation(preview, maxChars = 200) {
  const author = String(preview?.author || '').replace(/^@/, '').slice(0, 32);
  const text = cleanTweetText(preview?.text, maxChars);
  if (!text) return '［链接正文为空］';
  return `［推文${author ? ` @${author}` : ''}：${text}］`;
}

/** 失败/超时/不可达 → 写回消息的失败注解（防止她猜帖子内容）。 */
export function formatPreviewFailure() {
  return '［链接抓取失败，别猜帖子内容］';
}

function pickFromFx(json) {
  const t = json?.tweet;
  if (!t || typeof t !== 'object') return null;
  const author = t.author?.screen_name || t.author?.name || '';
  const text = t.text || t.raw_text?.text || '';
  if (!text) return null;
  return { author, text };
}

function pickFromVx(json) {
  if (!json || typeof json !== 'object') return null;
  const author = json.user_screen_name || json.user_name || '';
  const text = json.text || '';
  if (!text) return null;
  return { author, text };
}

async function fetchJson(fetchImpl, url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res || !res.ok) return { ok: false, status: res?.status || 0 };
    const json = await res.json().catch(() => null);
    return { ok: true, json };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 抓一条推文的正文/作者。先 fxtwitter、失败再 vxtwitter（两个固定域）。
 * 失败返回 { ok:false, error }，由调用方写失败注解。
 */
export async function fetchStatusPreview(link, { fetchImpl = globalThis.fetch, timeoutMs = 2500 } = {}) {
  const statusId = String(link?.statusId || '');
  const user = String(link?.user || 'Twitter').replace(/[^A-Za-z0-9_]/g, '') || 'Twitter';
  if (!statusId) return { ok: false, error: '缺少 statusId' };
  const attempts = [
    { name: 'fx', url: `https://api.fxtwitter.com/${user}/status/${statusId}` },
    { name: 'vx', url: `https://api.vxtwitter.com/${user}/status/${statusId}` }
  ];
  let lastError = '';
  for (const a of attempts) {
    try {
      const got = await fetchJson(fetchImpl, a.url, timeoutMs);
      if (!got.ok) { lastError = `${a.name} HTTP ${got.status || '失败'}`; continue; }
      const parsed = a.name === 'fx' ? pickFromFx(got.json) : pickFromVx(got.json);
      if (!parsed || !String(parsed.text || '').trim()) { lastError = `${a.name} 无正文`; continue; }
      return { ok: true, statusId, author: parsed.author, text: parsed.text, source: a.name };
    } catch (error) {
      lastError = `${a.name} ${error?.name === 'AbortError' ? '超时' : (error?.message ?? error)}`;
    }
  }
  return { ok: false, error: lastError || '抓取失败', statusId };
}

/** statusId → 预览缓存（落盘 state/link-previews.json，TTL 7 天，LRU 500）。 */
export class PreviewCache {
  constructor(file, { ttlDays = 7, max = 500 } = {}) {
    this.file = file;
    this.ttlMs = Math.max(1, Number(ttlDays) || 7) * 24 * 3600e3;
    this.max = Math.max(1, Number(max) || 500);
    this.map = new Map();
    this.loaded = false;
    this.saves = 0;
  }

  load() {
    if (this.loaded) return this;
    this.loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const now = Date.now();
      for (const [id, v] of Object.entries(raw || {})) {
        if (!v || typeof v !== 'object') continue;
        if (now - Number(v.fetchedAt || 0) > this.ttlMs) continue;
        this.map.set(String(id), v);
      }
    } catch {}
    return this;
  }

  get(statusId) {
    this.load();
    const v = this.map.get(String(statusId));
    if (!v) return null;
    if (Date.now() - Number(v.fetchedAt || 0) > this.ttlMs) { this.map.delete(String(statusId)); return null; }
    return v;
  }

  set(statusId, preview) {
    this.load();
    this.map.set(String(statusId), { ...preview, fetchedAt: Date.now() });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    this.save();
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const obj = Object.fromEntries(this.map);
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
      fs.renameSync(tmp, this.file);
      this.saves += 1;
    } catch {}
  }
}
