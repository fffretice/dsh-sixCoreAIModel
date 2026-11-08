// 网页图片提取：只做只读解析，不下载图片。
// - 搜索结果：从 Bing Images 的 HTML 里取 murl（原图直链）和 purl（来源页）
// - 页面提取：og:image / twitter:image / img[src|srcset|data-src] / 图片链接

const ENTITY = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  '#39': "'", '#x27': "'", '#34': '"', '#x22': '"',
};

export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code) => {
    const key = String(code).toLowerCase();
    if (key in ENTITY) return ENTITY[key];
    if (key.startsWith('#x')) {
      const n = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    if (key.startsWith('#')) {
      const n = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return m;
  });
}

function cleanUrl(raw) {
  let s = decodeEntities(raw).trim().replace(/^['"]|['"]$/g, '');
  if (!s) return '';
  if (s.startsWith('//')) s = 'https:' + s;
  return s;
}

function isHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 从 Bing Images 搜索结果页提取原图直链。 */
export function parseBingImages(html, limit = 8) {
  const text = String(html ?? '');
  const out = [];
  const seen = new Set();
  const patterns = [
    /murl(?:&quot;|")\s*:\s*(?:&quot;|")(https?:\/\/[^"&]+?)(?:&quot;|")/gi,
    /"murl":"(https?:\/\/[^"]+?)"/gi,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const url = cleanUrl(m[1]);
      if (!url || !isHttpUrl(url) || seen.has(url)) continue;
      if (/\.(svg)(\?|$)/i.test(url)) continue;
      seen.add(url);
      out.push({ imageUrl: url });
      if (out.length >= Math.min(20, Math.max(1, Number(limit) || 8))) return out;
    }
  }
  return out;
}

/** 在一个页面里找主图和正文图；返回绝对地址，按优先级排序。 */
export function extractPageImages(html, baseUrl, limit = 24) {
  const text = String(html ?? '');
  const out = [];
  const seen = new Set();
  const add = (raw, kind, alt = '') => {
    let url = cleanUrl(raw);
    if (!url || url.startsWith('data:')) return;
    if (!isHttpUrl(url)) {
      try { url = new URL(url, baseUrl).toString(); } catch { return; }
    }
    if (!isHttpUrl(url) || seen.has(url)) return;
    if (/\.svg(\?|$)/i.test(url)) return;
    if (/(^|[\/_.-])(pixel|spacer|1x1|transparent|blank)\.(gif|png|jpe?g)/i.test(url)) return;
    if (/tracking\.|ad_count=|\/logo[-_.]|\.gif(\?|$)/i.test(url)) return;
    seen.add(url);
    out.push({ imageUrl: url, kind, alt: String(alt || '').slice(0, 120) });
  };

  // 1) og:image / twitter:image —— 文章主图最靠谱
  for (const m of text.matchAll(/<meta\s+[^>]*(?:property|name)\s*=\s*["'](?:og:image|og:image:url|twitter:image|twitter:image:src)["'][^>]*>/gi)) {
    const tag = m[0];
    const content = /content\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (content) add(content[1], 'og');
  }

  // 2) img 的 src / data-src / srcset；懒加载优先 data-*
  for (const m of text.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const attrs = {};
    for (const a of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*["']([^"']*)["']/g)) {
      attrs[a[1].toLowerCase()] = a[2];
    }
    const alt = attrs.alt || '';
    const candidate = attrs['data-original'] || attrs['data-src'] || attrs['data-lazy-src'] || attrs.src || '';
    if (candidate) add(candidate, 'img', alt);
    const srcset = attrs.srcset || attrs['data-srcset'] || '';
    if (srcset) {
      const best = srcset.split(',').map((x) => x.trim().split(/\s+/)[0]).filter(Boolean).pop();
      if (best) add(best, 'srcset', alt);
    }
  }

  // 3) source[srcset]（picture）
  for (const m of text.matchAll(/<source\b[^>]*srcset\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const best = m[1].split(',').map((x) => x.trim().split(/\s+/)[0]).filter(Boolean).pop();
    if (best) add(best, 'source');
  }

  // 4) 指向图片的链接
  for (const m of text.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+\.(?:png|jpe?g|webp|gif)(?:\?[^"']*)?)["'][^>]*>/gi)) {
    add(m[1], 'link');
  }

  return out.slice(0, Math.min(40, Math.max(1, Number(limit) || 24)));
}
