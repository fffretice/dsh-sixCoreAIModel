/**
 * 通用 OpenAI 兼容 TTS 客户端（默认小米 MiMo）。
 *
 * 设计约束（主人 2026-10-29 明确要求，别自作聪明改）：
 *   1. 请求头/请求体是**用户编辑的原文**，只做占位符替换，原样发送：
 *      - 请求头：解析成键值后只替换占位符，原样作为 HTTP 头；**不自动补 Content-Type / Authorization**。
 *      - 请求体：替换后原样作为字节发送；**不 JSON.parse 再序列化、不 pretty-print、不加减任何前后缀**。
 *   2. 落盘保存的也是这两段原文，往返字节一致。
 *   3. 占位符：{model} {text} {format} {apiKey} {voice} {refAudio}
 *   4. 三种模式共用一套模板，只是「用哪套默认模板」和「界面显示什么」不同：
 *      prompt（文字提示语音）/ preset（官方预设音色）/ clone（上传音频克隆）
 */
import fs from 'node:fs';
import path from 'node:path';

export const TTS_CONFIG_FILE = 'tts-openai.json';

/** 官方 MiMo-TTS 系列（2026-10 文档）。前端用它做快捷选择。 */
export const MIMO_MODELS = [
  { id: 'mimo-v2.5-tts-voicedesign', label: '文字描述音色（推荐）', hint: 'user 消息写音色描述，assistant 消息写台词' },
  { id: 'mimo-v2.5-tts', label: '内置音色', hint: '用 voice 字段选内置音色' },
  { id: 'mimo-v2.5-tts-voiceclone', label: '声音克隆', hint: 'voice 字段传 mp3/wav 的 base64' },
];

/** 内置音色（mimo-v2.5-tts 可用）。 */
export const MIMO_VOICES = ['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'];

export const DEFAULT_PROMPT_BODY = `{
  "model": "{model}",
  "messages": [
    {
      "role": "user",
      "content": "14岁女孩的声音，音色黏糊偏高，带奶音和轻微气声；语速轻快，句尾常轻轻上扬，咬字软。"
    },
    {
      "role": "assistant",
      "content": "{text}"
    }
  ],
  "audio": {
    "format": "{format}"
  }
}`;

export const DEFAULT_HEADERS = `{
  "api-key": "{apiKey}",
  "Content-Type": "application/json"
}`;

export function defaultConfig() {
  return {
    baseUrl: 'https://api.xiaomimimo.com/v1/chat/completions',
    apiKey: '',
    model: '',
    mode: 'prompt',
    headers: DEFAULT_HEADERS,
    body: DEFAULT_PROMPT_BODY,
    outputFormat: 'mp3',
    presetVoice: '',
    cloneRef: null,
    lastCheck: null,
  };
}

export function loadConfig(surfcoreDir) {
  const file = path.join(surfcoreDir, 'state', TTS_CONFIG_FILE);
  const base = defaultConfig();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...base, ...raw };
  } catch {
    return base;
  }
}

/** 原样落盘（不做任何格式化：headers/body 保持用户写的字节）。 */
export function saveConfig(surfcoreDir, next) {
  const file = path.join(surfcoreDir, 'state', TTS_CONFIG_FILE);
  const base = loadConfig(surfcoreDir);
  const merged = { ...base, ...next };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merged, null, 2));
  return merged;
}

/** 只替换占位符，别的一律不动。 */
export function fillTemplate(tpl, vars) {
  let out = String(tpl ?? '');
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{${k}}`).join(String(v ?? ''));
  }
  return out;
}

/**
 * 把「用户写的请求头原文」解析成数组 [[name, value], ...]。
 * 支持 JSON 对象，也支持逐行 `Name: value`（宽容解析，但仍然不补任何头）。
 */
export function parseHeaderText(text) {
  const src = String(text ?? '').trim();
  if (!src) return [];
  if (src.startsWith('{')) {
    try {
      const obj = JSON.parse(src);
      return Object.entries(obj).map(([k, v]) => [k, String(v)]);
    } catch { /* 落到逐行解析 */ }
  }
  const out = [];
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf(':');
    if (i <= 0) continue;
    out.push([t.slice(0, i).trim(), t.slice(i + 1).trim()]);
  }
  return out;
}

export function modelsUrl(baseUrl) {
  const u = String(baseUrl || '').trim();
  if (!u) return '';
  try {
    const url = new URL(u);
    url.pathname = url.pathname.replace(/\/chat\/completions\/?$/, '/models');
    url.search = '';
    return url.toString();
  } catch {
    return u.replace(/\/chat\/completions\/?$/, '/models');
  }
}

/** 拉模型列表（按用户请求头原样发）。 */
export async function listModels(cfg) {
  const url = modelsUrl(cfg.baseUrl);
  if (!url) throw new Error('还没填接口地址');
  const vars = { apiKey: cfg.apiKey, model: cfg.model, text: '', format: cfg.outputFormat, voice: cfg.presetVoice || '' };
  const headers = Object.fromEntries(parseHeaderText(fillTemplate(cfg.headers, vars)));
  const res = await fetch(url, { method: 'GET', headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`拉模型失败 HTTP ${res.status}：${text.slice(0, 200)}`);
  try {
    const data = JSON.parse(text);
    return Array.isArray(data?.data) ? data.data.map((m) => ({ id: m.id, owned_by: m.owned_by ?? '' })) : [];
  } catch {
    throw new Error(`返回不是 JSON：${text.slice(0, 120)}`);
  }
}

/** 从响应里找音频：兼容 base64 字段与二进制响应。 */
function extractAudio(res, buffer) {
  const ct = String(res.headers.get('content-type') || '');
  if (/^audio\//i.test(ct) || /octet-stream/i.test(ct)) return { kind: 'binary', buffer };
  let data;
  try { data = JSON.parse(buffer.toString('utf8')); } catch { return { kind: 'json', data: null }; }
  const cand =
    data?.choices?.[0]?.message?.audio?.data ??
    data?.choices?.[0]?.message?.audio ??
    data?.audio?.data ?? data?.audio ??
    data?.data?.[0]?.audio ?? data?.data?.[0]?.b64_json ??
    null;
  if (typeof cand === 'string') return { kind: 'b64', b64: cand, data };
  return { kind: 'json', data };
}

/**
 * 试合成：按原文模板发请求，返回 { buffer, ext, requestPreview }。
 * 任何一步失败都把「实际发出的样子」带回来，方便界面显示。
 */
export async function synthesize(cfg, { text, format, voice, refAudio } = {}) {
  const fmt = format || cfg.outputFormat || 'mp3';
  const vars = {
    apiKey: cfg.apiKey,
    model: cfg.model,
    text: text ?? '',
    format: fmt,
    voice: voice ?? cfg.presetVoice ?? '',
    refAudio: refAudio ?? '',
  };
  const headerText = fillTemplate(cfg.headers, vars);
  const bodyText = fillTemplate(cfg.body, vars);
  const headers = Object.fromEntries(parseHeaderText(headerText));
  const res = await fetch(cfg.baseUrl, { method: 'POST', headers, body: bodyText });
  const buffer = Buffer.from(await res.arrayBuffer());
  const extracted = extractAudio(res, buffer);
  const preview = {
    url: cfg.baseUrl,
    headers: Object.keys(headers),
    body: bodyText,
    status: res.status,
  };
  if (!res.ok) {
    throw Object.assign(new Error(`合成失败 HTTP ${res.status}：${buffer.toString('utf8').slice(0, 300)}`), { preview });
  }
  if (extracted.kind === 'b64') {
    const b64 = extracted.b64.replace(/^data:[^;]+;base64,/, '');
    return { buffer: Buffer.from(b64, 'base64'), ext: fmt, preview, raw: extracted.data };
  }
  if (extracted.kind === 'binary') return { buffer, ext: fmt, preview };
  throw Object.assign(new Error(`没在响应里找到音频：${JSON.stringify(extracted.data)?.slice(0, 300)}`), { preview });
}

/** 保存音频到 state/tts-out/，返回相对路径。 */
export function saveAudio(surfcoreDir, buffer, ext) {
  const dir = path.join(surfcoreDir, 'state', 'tts-out');
  fs.mkdirSync(dir, { recursive: true });
  const name = `tts-${Date.now()}.${String(ext || 'mp3').replace(/[^a-z0-9]/gi, '')}`;
  fs.writeFileSync(path.join(dir, name), buffer);
  return { name, abs: path.join(dir, name) };
}
