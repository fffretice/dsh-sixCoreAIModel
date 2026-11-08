// 安全版 Web Search / Fetch MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露只读工具 `web_search` 与 `web_fetch`：查网络用语/梗/黑话、抓取网页正文。
// - 不暴露任何本地文件、命令执行、写操作。
// - 查询词做基础清洗：去 CQ 码、控制字符、超长截断。
// - 搜索：优先走 **DSH 同一路 DeepSeek 联网搜索**（src/web-search.js：同一端点/模型/
//   服务端 web_search 工具，凭据取 config/env/DSH 的 .credentials.yaml），
//   不可用时回退 Bing（RSS 优先）。搜索词不再默认发给 Bing。
// - `web_fetch` 仅允许 http/https：
//   - 禁止 URL 内嵌凭据；
//   - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址；
//   - 域名会先做 DNS 解析并检查全部解析结果，避免解析到内网；
//   - 手动跟随重定向，每一跳都重新校验；
//   - 响应体按字节流限量读取，避免超大响应拖垮进程。
// - 搜索结果/抓取结果仅作为“候选解释”，最终是否入库仍由控制台人工确认。
import path from 'node:path';
import { safeFetch, safeFetchBuffer } from './safe-fetch.js';
import { htmlToText } from './html-text.js';
import { parseBingImages, extractPageImages } from './image-extract.js';
import { webSearch } from './web-search.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/**
 * 项目根目录（用于读 config.json 的 webSearch 段）。
 *
 * 不能用 `import.meta.url`：离线测试会把本文件塞进 vm 上下文执行（那里没有 import.meta，
 * 直接是语法错误）。DSH 以 `node <本文件绝对路径>` 启动 MCP，所以 argv[1] 就是本文件；
 * 取它的上一级 `src/` 的父目录即可。取不到时退回 cwd（测试环境正好从仓库根运行）。
 */
function projectRoot() {
  try {
    const entry = String(process.argv[1] ?? '');
    if (entry) {
      const dir = path.dirname(path.resolve(entry));
      if (path.basename(dir) === 'src') return path.dirname(dir);
    }
  } catch {}
  return process.cwd();
}

function sanitizeQuery(query) {
  return String(query ?? '')
    // 去掉 CQ 码（[CQ:xxx]）
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

const server = new McpServer({ name: 'web-search-safe', version: '0.2.0-r4' });

server.tool(
  'web_search',
  '只读联网搜索：优先使用与 DSH 相同的 DeepSeek 联网搜索（结果更准、不把群里的词发给搜索引擎广告网络），不可用时自动回退 Bing。返回标题/URL/摘要，不执行任何本地操作。适合查网络用语、梗、事实性问题和热点。',
  { query: z.string().describe('要搜索确认的网络用语/黑话/梗/事实性问题') },
  async ({ query }) => {
    const clean = sanitizeQuery(query);
    if (!clean) {
      return { content: [{ type: 'text', text: '查询词为空，已拒绝。' }], isError: true };
    }
    try {
      const result = await webSearch(clean, { root: projectRoot() });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `搜索失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'web_fetch',
  '只读抓取 HTTP(S) 网页正文：自动识别编码（UTF-8/EUC-JP/Shift_JIS 等），去掉脚本、样式和广告，返回可读正文（表格按行保留）前 50000 字符。禁止访问内网/本机地址，不执行任何本地操作。',
  { url: z.string().describe('要抓取的 http(s) URL') },
  async ({ url }) => {
    try {
      // 多取一些原始 HTML，给正文提取留空间（game8 这种页面表格在 300KB 之后）。
      const result = await safeFetch(url, 500000);
      const isHtml = /html/i.test(result.contentType || '') || /^\s*(<!doctype|<html)/i.test(result.body);
      if (isHtml) {
        const extracted = htmlToText(result.body, { maxChars: 50000 });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              url: result.url,
              statusCode: result.statusCode,
              charset: result.charset,
              title: extracted.title,
              text: extracted.text,
              truncated: Boolean(result.truncated || extracted.truncated),
            }, null, 2),
          }],
        };
      }
      const clipped = result.body.length > 50000
        ? { ...result, body: result.body.slice(0, 50000), truncated: true }
        : result;
      return { content: [{ type: 'text', text: JSON.stringify(clipped, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `抓取失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'web_page_images',
  '只读：打开一个网页，提取里面的主图和正文图片，返回可直接发给 QQ 的图片直链（不下载图片）。'
    + '适合活动页、新闻、wiki、公告：先用 web_search 找到页面，再用它取图，最后用 qq_send_image 发出去。'
    + '优先返回 og:image 和正文 img；懒加载图也会尽量取到。',
  {
    url: z.string().describe('要取图的网页地址（http/https）'),
    limit: z.number().optional().describe('最多返回几张，默认 24')
  },
  async ({ url, limit }) => {
    try {
      const result = await safeFetch(String(url), 800000);
      const ct = String(result.contentType || '');
      if (ct && !/text\/html|application\/xhtml/i.test(ct)) {
        return { content: [{ type: 'text', text: `不是 HTML 页面（content-type=${ct}）` }], isError: true };
      }
      const pageTitle = htmlToText(result.body, { maxChars: 200 }).title || '';
      const images = extractPageImages(result.body, result.url, Number(limit) || 24);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ url: result.url, title: pageTitle, images }, null, 2),
        }],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `取图失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'web_image_search',
  '只读：按关键词搜图片（Bing 图片，安全搜索开启），返回原图直链。'
    + '适合找同人图/海报/活动图；找到后自己先看一眼来源，再用 qq_send_image 发。'
    + '如果是在找某个新闻/活动页里的图，优先用 web_page_images，比泛搜更准。',
  {
    query: z.string().describe('图片关键词，例如「学園アイドルマスター 新イベント」「女仆 同人」'),
    limit: z.number().optional().describe('最多返回几张，默认 8')
  },
  async ({ query, limit }) => {
    try {
      const q = sanitizeQuery(query);
      if (!q) return { content: [{ type: 'text', text: '搜索词为空' }], isError: true };
      const u = 'https://www.bing.com/images/search?q=' + encodeURIComponent(q)
        + '&form=HDRSC2&first=1&adlt=strict&safeSearch=Strict';
      const result = await safeFetch(u, 800000);
      const images = parseBingImages(result.body, Number(limit) || 8);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ query: q, images, count: images.length }, null, 2),
        }],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `图片搜索失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'web_image_preview',
  '只读：把一张网图下载下来看一眼（返回图片本身，不发送）。'
    + '适合在 qq_send_image 之前确认图里到底是什么：颜色、人物、有没有文字/水印。'
    + '一次只看一张；看完再决定发不发。看不到或下载失败就别硬猜，换一张或只发文字。',
  {
    url: z.string().describe('要预览的图片直链（http/https，png/jpg/webp/gif）'),
    maxBytes: z.number().optional().describe('最大字节数，默认 6MB，范围 256KB–12MB')
  },
  async ({ url, maxBytes }) => {
    try {
      const cap = Math.max(256 * 1024, Math.min(12 * 1024 * 1024, Number(maxBytes) || 6 * 1024 * 1024));
      const fetched = await safeFetchBuffer(String(url), cap);
      const b = fetched.buffer;
      let mime = '';
      if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) mime = 'image/png';
      else if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) mime = 'image/jpeg';
      else if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) mime = 'image/gif';
      else if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') mime = 'image/webp';
      if (!mime) return { content: [{ type: 'text', text: '这不是有效的 PNG/JPEG/GIF/WebP 图片' }], isError: true };
      return {
        content: [
          { type: 'image', data: b.toString('base64'), mimeType: mime },
          { type: 'text', text: `图片预览：${fetched.url || url}（${b.length} 字节，${mime}）` }
        ]
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `预览失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

await server.connect(new StdioServerTransport());
