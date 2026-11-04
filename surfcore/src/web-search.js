// 联网搜索（MCP `web_search` 的实现）。
//
// 设计目标：**优先复用 DSH 原本的联网搜索能力**，而不是自己抓 Bing 的搜索结果页。
//
// DSH 的 `web_search` 工具背后是 `@deepseek-ai/dsh-web-search-deepseek`：
// 向 DeepSeek 的 Anthropic 兼容 Messages 端点发一次带 `web_search_20250305`
// 服务端工具的请求，从 `web_search_tool_result` 里取结构化结果。本模块照同一
// 端点/模型/工具参数实现一份最小客户端，于是 QQ 里的 AI 和 DSH 里的 AI 拿到的是
// **同一路搜索结果**；搜索词只发给 DeepSeek（也就是本来就在处理这段对话的同一家），
// 不再把群聊里提炼出来的词发给 Bing。
//
// 凭据解析顺序与 DSH 一致：
//   1. config.json 的 `webSearch.apiKey`（不推荐，明文）
//   2. 环境变量 `DEEPSEEK_API_KEY`（可用 `webSearch.apiKeyEnv` 改）
//   3. DSH 的 `$DSH_HOME/.credentials.yaml` → `refs.<ref>`（DSH 的 Models 页写入的 key）
// 都没有时：回退 Bing（`cn.bing.com` 的 RSS，失败再退回 HTML），保证"永远有一个能用的搜索"。
//
// 安全边界：
// - API key 只发往**校验过**的 HTTPS 端点：必须是 https、必须解析到公网地址
//   （防止把 key 发到 localhost/内网），且禁止跟随重定向（`redirect: error`）。
// - key 永远不写日志、不进错误信息、不进返回结果。
// - 响应体有大小上限；请求有总超时；查询词在 MCP 层已清洗。
// - Bing 走 safe-fetch（SSRF 防护 + 多地址故障切换）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { URL } from 'node:url';
import YAML from 'js-yaml';
import { resolveSafeAddresses, safeFetch } from './safe-fetch.js';

const DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic/v1';
const DEFAULT_MODEL = 'deepseek-v4-flash';
const DEFAULT_API_VERSION = '2023-06-01';
const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY';
const DEFAULT_TIMEOUT_MS = 35000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 64;
// Anthropic 兼容响应里文本块/结果块都可能有；这里只要结构化结果。
const SEARCH_TOOL_TYPE = 'web_search_20250305';

const defaultConfig = Object.freeze({
  provider: 'auto',
  apiKey: '',
  apiKeyEnv: DEFAULT_API_KEY_ENV,
  baseURL: '',
  model: DEFAULT_MODEL,
  maxUses: 5,
  maxTokens: 4096,
  maxResults: 8,
  timeoutMs: DEFAULT_TIMEOUT_MS
});

function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 读取 config.json 里的 webSearch 段（不存在就用默认值）。 */
export function loadSearchConfig(root) {
  let file = {};
  try {
    const text = fs.readFileSync(path.join(root, 'config.json'), 'utf8');
    file = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {}
  const raw = file?.webSearch && typeof file.webSearch === 'object' && !Array.isArray(file.webSearch) ? file.webSearch : {};
  const provider = raw.provider === 'deepseek' || raw.provider === 'bing' ? raw.provider : 'auto';
  return {
    ...defaultConfig,
    provider,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '',
    apiKeyEnv: typeof raw.apiKeyEnv === 'string' && raw.apiKeyEnv.trim() ? raw.apiKeyEnv.trim() : DEFAULT_API_KEY_ENV,
    baseURL: typeof raw.baseURL === 'string' ? raw.baseURL.trim().replace(/\/+$/, '') : '',
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : DEFAULT_MODEL,
    maxUses: num(raw.maxUses, defaultConfig.maxUses, 1, 5),
    maxTokens: num(raw.maxTokens, defaultConfig.maxTokens, 256, 8192),
    maxResults: num(raw.maxResults, defaultConfig.maxResults, 1, 20),
    timeoutMs: num(raw.timeoutMs, defaultConfig.timeoutMs, 5000, 120000)
  };
}

/** DSH home：与 dsh-client 的判定保持一致（`DSH_HOME` 优先）。 */
export function resolveDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/**
 * 从 DSH 的凭据文件里取 key。
 * 结构：`refs: { <名称>: <明文值> }`（实测；不是记录 id）。只看指定 ref，绝不遍历其它凭据。
 */
export function readDshCredential(ref) {
  const name = String(ref ?? '').trim();
  if (!name) return '';
  try {
    const doc = YAML.load(fs.readFileSync(path.join(resolveDshHome(), '.credentials.yaml'), 'utf8'));
    const value = doc?.refs?.[name];
    return typeof value === 'string' ? value.trim() : '';
  } catch {
    return '';
  }
}

/** 解析搜索用的 DeepSeek key；返回 { key, source } —— key 只在这里出现，不落日志。 */
export function resolveSearchApiKey(config) {
  const literal = String(config?.apiKey ?? '').trim();
  if (literal) return { key: literal, source: 'config' };
  const envName = String(config?.apiKeyEnv || DEFAULT_API_KEY_ENV);
  const fromEnv = String(process.env[envName] ?? '').trim();
  if (fromEnv) return { key: fromEnv, source: 'env' };
  const fromDsh = readDshCredential(envName);
  if (fromDsh) return { key: fromDsh, source: 'dsh-credentials' };
  return { key: '', source: 'none' };
}

function normalizeSearchUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!/^https?:\/\//i.test(s)) return '';
  // DeepSeek 的结果 URL 会带 `#1` 这类"第几条"的锚点（不是页面真实片段），去掉更干净；
  // 但真实的 `#section` 也可能有意义，所以只去纯数字锚点。
  const cleaned = s.replace(/#\d+$/, '');
  try {
    const url = new URL(cleaned);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (url.username || url.password) return '';
    return url.toString();
  } catch {
    return '';
  }
}

/** 把 Anthropic Messages 响应映射成统一结果（参照 dsh-web-search-deepseek 的实现）。 */
export function mapDeepSeekResponse(response, maxResults = 8) {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  const resultBlocks = blocks.filter((block) => block?.type === 'web_search_tool_result');
  if (!resultBlocks.length) {
    throw Object.assign(new Error('DeepSeek 没有返回 web_search_tool_result（可能未触发联网搜索）'), { code: 'NO_RESULT_BLOCK' });
  }
  const snippets = new Map();
  for (const block of blocks) {
    if (block?.type !== 'text') continue;
    for (const cite of block.citations ?? []) {
      const url = normalizeSearchUrl(cite?.url);
      if (!url || snippets.has(url)) continue;
      const text = String(cite?.cited_text ?? '').trim();
      if (text) snippets.set(url, text);
    }
  }
  const seen = new Set();
  const results = [];
  for (const block of resultBlocks) {
    for (const item of block?.content ?? []) {
      if (item?.type !== 'web_search_result') continue;
      const url = normalizeSearchUrl(item.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const title = String(item.title ?? '').trim().slice(0, 200);
      const snippet = String(snippets.get(url) ?? '').trim().slice(0, 500);
      results.push({
        title,
        url,
        ...(snippet ? { snippet } : {}),
        ...(item.page_age ? { publishedAt: String(item.page_age).slice(0, 40) } : {})
      });
      if (results.length >= maxResults) return results;
    }
  }
  return results;
}

/** 校验搜索端点：https + 公网地址。返回 { url, addresses }。 */
async function validateSearchEndpoint(baseURL) {
  let url;
  try {
    url = new URL(String(baseURL ?? '').trim());
  } catch {
    throw new Error('webSearch.baseURL 无效');
  }
  if (url.protocol !== 'https:') throw new Error('webSearch.baseURL 必须是 https（API key 只能发给加密端点）');
  if (url.username || url.password) throw new Error('webSearch.baseURL 不能包含凭据');
  const addresses = await resolveSafeAddresses(url.hostname);
  return { url, addresses };
}

/**
 * 向搜索端点 POST JSON（单个已校验地址）。
 * 不复用 safeFetch（它只做 GET）：这里需要 POST、禁止重定向，并把 key 只交给校验过的地址。
 * 网络层失败（连接/超时/中断）由 postJson() 换地址重试；HTTP 状态是结果，不在这里重试。
 */
function postJsonOnce(url, address, { headers, body, timeoutMs, maxBytes = MAX_RESPONSE_BYTES }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    let response;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      const error = new Error(`联网搜索请求超时（${Math.round(timeoutMs / 1000)}s）`);
      finish(error);
      req?.destroy(error);
      response?.destroy();
    }, timeoutMs);
    try {
      req = https.request({
        hostname: address,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          ...headers,
          host: url.host,
          'content-length': Buffer.byteLength(body)
        },
        // 证书校验用真实域名（SNI/Host 与站点一致），连接目标才是固定 IP。
        servername: url.hostname,
        rejectUnauthorized: true,
        timeout: timeoutMs
      }, (res) => {
        response = res;
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400) {
          finish(new Error(`联网搜索端点返回重定向（HTTP ${status}），已拒绝跟随`));
          res.destroy();
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          if (settled) return;
          size += chunk.length;
          if (size > maxBytes) {
            finish(new Error('联网搜索响应体过大，已中止'));
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', (error) => finish(error));
        res.on('aborted', () => finish(new Error('联网搜索响应中断')));
        res.on('close', () => { if (!res.complete) finish(new Error('联网搜索响应中断')); });
        res.on('end', () => {
          if (settled) return;
          const text = Buffer.concat(chunks).toString('utf8');
          finish(null, { status, text });
        });
      });
      req.on('timeout', () => {
        const error = new Error(`联网搜索请求超时（${Math.round(timeoutMs / 1000)}s）`);
        finish(error);
        req.destroy(error);
        response?.destroy();
      });
      req.on('error', (error) => finish(error));
      req.end(body);
    } catch (error) {
      finish(error);
      req?.destroy();
    }
  });
}

/** 依次尝试前两个已校验地址（同一失败形态：DNS 先给 IPv6、本机没有 IPv6 出口）。 */
async function postJson(url, addresses, options) {
  const list = (Array.isArray(addresses) ? addresses : [addresses]).filter(Boolean);
  if (!list.length) throw new Error('没有任何可用地址');
  const deadline = Date.now() + options.timeoutMs;
  const attempts = Math.min(list.length, 2);
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 500) break;
    const budget = attempts === 1 ? options.timeoutMs : Math.min(remaining, Math.ceil(options.timeoutMs / 2));
    try {
      return await postJsonOnce(url, list[i], { ...options, timeoutMs: budget });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('联网搜索请求失败');
}


// ── 用量记账（2026-10-31）──────────────────────────────
// 主人要在监控台里单列「自发性上网」的花费，所以每次搜索都把真实 usage 记一行。
// 价格是估算口径，可在 config.webSearch.pricing 里改（不是官方账单）。
function usageFile() {
  const root = process.env.SURFCORE_DIR || process.cwd();
  return path.join(root, 'state', 'search-usage.jsonl');
}

// ── 搜索记忆（2026-11-02）────────────────────────────
// 主人：「她看到群里的内容会自己搜，但搜出来并没有学会，不划算。」
// 所以把「搜过什么、搜到哪些条目」留一份，注入时让她看得见自己的检索史。
// 注意：这里只留标题/摘要，不留全文；只为「想起来查过什么」，不是给她照抄。
function searchMemoryFile() {
  const root = process.env.SURFCORE_DIR || process.cwd();
  return path.join(root, 'state', 'search-memory.jsonl');
}

export function rememberSearchResult({ query, provider, results, note = '' }, { keep = 300 } = {}) {
  try {
    const hits = (Array.isArray(results) ? results : [])
      .slice(0, 3)
      .map((r) => String(r.title || r.text || r.content || '').replace(/\s+/g, ' ').trim().slice(0, 90))
      .filter(Boolean);
    if (!hits.length && !note) return false;
    const f = searchMemoryFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), q: String(query || '').slice(0, 60), p: provider || '', hits, note: String(note || '').slice(0, 120) }) + '\n');
    // 只留最近 keep 条，文件不会无限长
    try {
      const rows = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
      if (rows.length > keep) fs.writeFileSync(f, rows.slice(-keep).join('\n') + '\n');
    } catch {}
    return true;
  } catch {
    return false;
  }
}

function pricingOf(config) {
  const p = (config && config.pricing) || {};
  return {
    inputPerM: Number(p.inputPerM ?? 1.0),
    cacheReadPerM: Number(p.cacheReadPerM ?? 0.2),
    outputPerM: Number(p.outputPerM ?? 2.0),
    perSearch: Number(p.perSearch ?? 0.01)
  };
}

/** 估算一次搜索调用的花费（元）。 */
export function estimateSearchCost(usage = {}, config = defaultConfig) {
  const pr = pricingOf(config);
  const input = Number(usage.input_tokens || 0);
  const cacheRead = Number(usage.cache_read_input_tokens || 0);
  const output = Number(usage.output_tokens || 0);
  const searches = Number(usage.web_search_requests || 0) || 1;
  return (input / 1e6) * pr.inputPerM
    + (cacheRead / 1e6) * pr.cacheReadPerM
    + (output / 1e6) * pr.outputPerM
    + searches * pr.perSearch;
}

export function recordSearchUsage({ provider, query, results = 0, usage = null, ms = 0, error = '' }, config = defaultConfig) {
  try {
    const row = {
      at: Date.now(),
      provider,
      query: String(query).slice(0, 120),
      results,
      ms,
      ...(error ? { error: String(error).slice(0, 160) } : {}),
      ...(usage ? {
        inputTokens: Number(usage.input_tokens || 0),
        cacheReadTokens: Number(usage.cache_read_input_tokens || 0),
        outputTokens: Number(usage.output_tokens || 0),
        searches: Number(usage.web_search_requests || 0),
        costCNY: Math.round(estimateSearchCost(usage, config) * 10000) / 10000
      } : { costCNY: 0 })
    };
    fs.mkdirSync(path.dirname(usageFile()), { recursive: true });
    fs.appendFileSync(usageFile(), JSON.stringify(row) + '\n');
  } catch {}
}

/** DeepSeek 原生联网搜索。失败时抛出带稳定 code 的错误，由调用方决定是否回退。 */
export async function deepseekSearch(query, config = defaultConfig) {
  const startedAt = Date.now();
  const { key } = resolveSearchApiKey(config);
  if (!key) {
    throw Object.assign(new Error('没有可用的 DeepSeek API key'), { code: 'NO_KEY' });
  }
  const baseURL = config.baseURL || process.env.DEEPSEEK_SEARCH_BASE_URL || DEFAULT_BASE_URL;
  const { url, addresses } = await validateSearchEndpoint(baseURL);
  const endpoint = new URL(`${url.toString().replace(/\/+$/, '')}/messages`);
  const body = JSON.stringify({
    model: config.model || DEFAULT_MODEL,
    max_tokens: config.maxTokens || defaultConfig.maxTokens,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }]
    }],
    tools: [{
      type: SEARCH_TOOL_TYPE,
      name: 'web_search',
      max_uses: config.maxUses || defaultConfig.maxUses
    }]
  });
  const response = await postJson(endpoint, addresses, {
    headers: {
      'x-api-key': key,
      authorization: `Bearer ${key}`,
      'anthropic-version': DEFAULT_API_VERSION,
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'qq-bridge-web-search/0.2.0'
    },
    body,
    timeoutMs: config.timeoutMs || DEFAULT_TIMEOUT_MS
  });
  if (response.status < 200 || response.status >= 300) {
    // 只回显 HTTP 状态与主体里的简短错误，绝不拼接请求头（里面是 key）。
    let detail = '';
    try {
      const parsed = JSON.parse(response.text);
      const message = typeof parsed?.error === 'string' ? parsed.error : parsed?.error?.message ?? parsed?.message;
      if (typeof message === 'string') detail = message.slice(0, 200);
    } catch {}
    throw Object.assign(
      new Error(`DeepSeek 搜索接口 HTTP ${response.status}${detail ? `：${detail}` : ''}`),
      { code: 'HTTP_ERROR', status: response.status }
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw Object.assign(new Error('DeepSeek 搜索接口返回了无法解析的响应'), { code: 'BAD_BODY' });
  }
  const mapped = mapDeepSeekResponse(parsed, config.maxResults || defaultConfig.maxResults);
  // 把真实 usage 挂在数组上（数组也是对象），供上层统一记账
  mapped.__usage = parsed.usage || null;
  mapped.__ms = Date.now() - startedAt;
  return mapped;
}

function decodeEntities(text) {
  return String(text ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickTag(block, tag) {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return match ? decodeEntities(match[1]) : '';
}

/** Bing 的 RSS 结果（比 HTML 页面稳定：没有 JS、结构固定）。 */
export function parseBingRss(xml, maxResults = 8) {
  const results = [];
  const seen = new Set();
  for (const match of String(xml ?? '').matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = match[1];
    const url = normalizeSearchUrl(pickTag(block, 'link'));
    if (!url || seen.has(url)) continue;
    const title = pickTag(block, 'title').slice(0, 200);
    const snippet = pickTag(block, 'description').slice(0, 500);
    seen.add(url);
    results.push({ title: title || url, url, ...(snippet ? { snippet } : {}) });
    if (results.length >= maxResults) break;
  }
  return results;
}

/** Bing 的 HTML 结果页（RSS 不可用时的兜底，保持旧实现的解析口径）。 */
export function parseBingHtml(html, maxResults = 8) {
  const results = [];
  const seen = new Set();
  const blocks = String(html ?? '').split('<li class="b_algo"').slice(1);
  for (const block of blocks) {
    const hrefMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    if (!hrefMatch) continue;
    const url = normalizeSearchUrl(decodeEntities(hrefMatch[1]));
    if (!url || seen.has(url)) continue;
    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? decodeEntities(titleMatch[1]).slice(0, 200) : '';
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? decodeEntities(snippetMatch[1]).slice(0, 500) : '';
    seen.add(url);
    results.push({ title: title || url, url, ...(snippet ? { snippet } : {}) });
    if (results.length >= maxResults) break;
  }
  return results;
}

/** Bing 搜索（RSS 优先，HTML 兜底）。 */
export async function bingSearch(query, config = defaultConfig) {
  const maxResults = config.maxResults || defaultConfig.maxResults;
  const rss = new URL('https://cn.bing.com/search');
  rss.searchParams.set('q', query);
  rss.searchParams.set('format', 'rss');
  rss.searchParams.set('count', String(Math.min(20, maxResults)));
  rss.searchParams.set('setlang', 'zh-hans');
  rss.searchParams.set('cc', 'CN');
  try {
    const res = await safeFetch(rss.toString(), 512000);
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const results = parseBingRss(res.body, maxResults);
      if (results.length) return results;
    }
  } catch {}
  const html = new URL('https://cn.bing.com/search');
  html.searchParams.set('q', query);
  html.searchParams.set('count', String(Math.min(20, maxResults)));
  html.searchParams.set('setlang', 'zh-hans');
  html.searchParams.set('cc', 'CN');
  const res = await safeFetch(html.toString(), 512000);
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`Bing 搜索 HTTP ${res.statusCode}`);
  return parseBingHtml(res.body, maxResults);
}

const cache = new Map(); // `${provider}|${query}` -> { at, value }

export function clearSearchCache() {
  cache.clear();
}


// ── 360 搜索兜底（2026-10-31）────────────────────────────
// 背景：DeepSeek 搜索没凭据；Bing 在这台机器上返回「查询词被丢掉」的通用页（她搜
// 举例：把「学马氏」搜成学信网就是这条路的锅）；搜狗对非浏览器请求直接跳 antispider。
// 360 的网页结果里带 data-mdurl（真实地址），不需要解跳转，最稳。
const SO_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function httpTextSimple(target, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const req = https.get(target, {
      headers: {
        'user-agent': SO_UA,
        'accept-language': 'zh-CN,zh;q=0.9',
        accept: 'text/html,application/xhtml+xml'
      },
      timeout: timeoutMs
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 1200000) { req.destroy(); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => { req.destroy(new Error('360 搜索请求超时')); });
    req.on('error', reject);
  });
}

/** 从 360 结果页提取标题/真实链接/摘要。 */
export function parseSoHtml(html, maxResults = 8) {
  const results = [];
  const seen = new Set();
  const re = /<h3\s+class="res-title">\s*<a[^>]*?(?:data-mdurl="([^"]+)"|href="(https?:[^"]+)")[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && results.length < maxResults) {
    const url = decodeEntities(m[1] || m[2] || '');
    if (!/^https?:\/\//.test(url) || seen.has(url)) continue;
    const title = decodeEntities(m[3].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (!title) continue;
    const tail = html
      .slice(m.index + m[0].length, m.index + m[0].length + 900)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
    seen.add(url);
    results.push({ title: title.slice(0, 200), url, ...(tail ? { snippet: decodeEntities(tail) } : {}) });
  }
  return results;
}

export async function soSearch(query, config = defaultConfig) {
  const u = 'https://www.so.com/s?q=' + encodeURIComponent(query);
  const html = await httpTextSimple(u);
  const results = parseSoHtml(html, config.maxResults || defaultConfig.maxResults);
  if (!results.length) throw new Error('360 搜索没解析到结果');
  return results;
}

/** 结果是否和查询词沾边：Bing 偶尔会返回「查询词被丢掉」的通用页，这种结果不该被信任。 */
function looksRelevant(results, query) {
  if (!Array.isArray(results) || !results.length) return false;
  const tokens = String(query).toLowerCase().split(/[\s,，、]+/).filter((x) => x.length >= 2);
  if (!tokens.length) return true;
  // 用最长的那个词（通常是作品名）核对标题：光看「学园」这种泛词会被 Bing 骗过去。
  const longest = tokens.slice().sort((a, b) => b.length - a.length)[0];
  return results.some((r) => {
    const title = String(r.title || '').toLowerCase();
    const hay = `${title} ${String(r.snippet || '').toLowerCase()}`;
    if (title.includes(longest)) return true;
    return longest.length >= 3 && hay.includes(longest) && tokens.length === 1;
  });
}

/**
 * 统一入口：按配置选择 provider；`auto` 先试 DeepSeek（与 DSH 同源），失败回退 Bing。
 * @returns {{query:string, provider:'deepseek'|'bing', results:object[], fallbackFrom?:string, note?:string}}
 */
export async function webSearch(query, options = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('查询词为空');
  const config = { ...loadSearchConfig(options.root ?? process.cwd()), ...(options.config ?? {}) };
  const wanted = options.provider ?? config.provider;
  const cacheKey = `${wanted}|${q}|${config.maxResults}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const attemptDeepSeek = async () => {
    const results = await deepseekSearch(q, config);
    return { query: q, provider: 'deepseek', results };
  };
  const attemptBing = async () => {
    const results = await bingSearch(q, config);
    return { query: q, provider: 'bing', results };
  };

  let value;
  if (wanted === 'deepseek') {
    value = await attemptDeepSeek();
  } else if (wanted === 'bing') {
    value = await attemptBing();
  } else {
    try {
      value = await attemptDeepSeek();
    } catch (error) {
      const reason = error?.code === 'NO_KEY' ? '未配置 DeepSeek 搜索凭据' : `DeepSeek 搜索不可用：${error?.message ?? error}`;
      // Bing 在这台机器上不可信：同一个查询它返回过「学信网」「扇贝英语」这种完全无关的页面
      // （查询词像是被丢掉了）。所以顺序改成 360 → Bing，Bing 只作最后兜底。
      try {
        const soResults = await soSearch(q, config);
        value = { query: q, provider: '360', results: soResults, fallbackFrom: 'deepseek', note: `${reason}，已改用 360 搜索` };
      } catch (soError) {
        let bingValue = null;
        try { bingValue = await attemptBing(); } catch {}
        if (!bingValue || !looksRelevant(bingValue.results, q)) {
          // 宁可明确说「搜不到」，也不要把 Bing 的无关结果给她 —— 她会当真、还会转述给群友。
          // 这条 note 指向一个现在就能用的替代路径：她的 bili_watch 搜索。
          value = {
            query: q,
            provider: 'none',
            results: [],
            fallbackFrom: 'deepseek',
            note: `${reason}；360 搜索也被反爬拦了（${soError?.message ?? soError}）。现在没有可用的通用搜索：要查 B 站/二次元内容，改用 bili_watch 的 search；要彻底修好，得配一个搜索 API key（DeepSeek 或 Bocha 都行）。`
          };
        } else {
          value = { ...bingValue, fallbackFrom: 'deepseek', note: `${reason}；360 不可用，回退 Bing（结果仅供参考）` };
        }
      }
    }
  }
  // 空结果必须显式说明：以前直接返回 `results: []`，模型分不清「真没搜到」和
  // 「搜索接口静默失效」，会一直换关键词重试（issue #17）。现在给出可操作的下一步。
  // ⚠️ 这段必须在 `cache.set` **之前**：note 走的是「新建对象」而不是原地改，
  // 而缓存里存的是**引用**。反过来写（先缓存、后加 note）时，5 分钟内的重复查询会命中
  // 那个没有 note 的旧对象 —— 恰好是模型最容易开始重试的场景（同一句 query 连着问）。
  if (Array.isArray(value.results) && value.results.length === 0) {
    value = { ...value, note: [value.note, '没有搜到结果（可换个说法/加限定词；仍为空就不要再重复搜索）'].filter(Boolean).join('；') };
  }
  // 只在真正发起请求时记账（缓存命中不花钱）
  try {
    recordSearchUsage({
      provider: value.provider,
      query: q,
      results: Array.isArray(value.results) ? value.results.length : 0,
      usage: Array.isArray(value.results) ? value.results.__usage || null : null,
      ms: Array.isArray(value.results) ? value.results.__ms || 0 : 0
    }, config);
  } catch {}
  // 同时留一份「搜过什么」，给注入用（缓存命中时也记，因为那是她真实的一次检索）
  try {
    rememberSearchResult({ query: q, provider: value.provider, results: value.results, note: value.note || '' }, config?.memory || {});
  } catch {}
  cache.set(cacheKey, { at: Date.now(), value });
  if (cache.size > CACHE_MAX_ENTRIES) {
    for (const key of [...cache.keys()].slice(0, cache.size - CACHE_MAX_ENTRIES)) cache.delete(key);
  }
  return value;
}
