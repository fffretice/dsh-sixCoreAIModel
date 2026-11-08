// HTML → 可读文本：给 web_fetch 用。
// 目标不是完美还原页面，而是让模型能读到正文和表格，而不是 50k 字符的 script/广告。
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…',
  copy: '©', reg: '®', trade: '™', yen: '¥', times: '×', divide: '÷',
};

export function decodeHtmlEntities(input) {
  return String(input || '').replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (m, body) => {
    const key = String(body).toLowerCase();
    if (key[0] === '#') {
      const code = key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : m;
  });
}

export function htmlToText(html, { maxChars = 50000 } = {}) {
  const source = String(html || '');
  const titleRaw = (source.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  let text = source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|aside|blockquote|pre)>/gi, '\n')
    .replace(/<\/(td|th)>/gi, '\t')
    .replace(/<[^>]+>/g, ' ');
  text = decodeHtmlEntities(text)
    .replace(/\r/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const tooLong = Array.from(text).length > maxChars;
  if (tooLong) text = Array.from(text).slice(0, maxChars).join('');
  return {
    title: decodeHtmlEntities(titleRaw).replace(/\s+/g, ' ').trim(),
    text,
    truncated: tooLong,
  };
}
