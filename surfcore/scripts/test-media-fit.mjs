#!/usr/bin/env node
// task-19 单测：超限图压缩、失败原因透传、0 送达提示。
// 只读 bridge.js 源码做静态断言；helper 用桩件跑行为测试。
// 用法：node scripts/test-media-fit.mjs  退出码 0=PASS / 1=FAIL。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.SURFCORE_DIR || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const VERIFY = fs.readFileSync(path.join(ROOT, 'scripts', 'verify-image-block.mjs'), 'utf8');
let ok = 0; const cases = [];
const check = (name, pass, got = '') => { cases.push({ name, pass, got }); if (pass) ok += 1; };

// ── 静态断言 ──
check('S1 取数上限放宽到 24MB（仅取原图）', /const MAX_MEDIA_FETCH_BYTES = Math\.max\(MAX_MEDIA_BYTES, 24 \* 1024 \* 1024\)/.test(SRC));
check('S2 有 sips 压缩 helper', /function fitImageBuffer\(/.test(SRC) && /SIPS_BIN = '\/usr\/bin\/sips'/.test(SRC));
check('S3 tryUrls 用 24MB 取数 + fit', /safeFetchBuffer\(url, MAX_MEDIA_FETCH_BYTES\)/.test(SRC) && /fitImageBuffer\(fetched\.buffer, `\$\{label\} URL `\)/.test(SRC));
check('S4 get_image base64 用 24MB + fit', /base64\.length \* 3 \/ 4 <= MAX_MEDIA_FETCH_BYTES/.test(SRC));
check('S5 失败时返回 error（不再只 null）', /return \{ error: failures\[0\] \|\| '本地没有可用的图片数据' \}/.test(SRC));
check('S6 resolveMediaList 失败标签带原因', /（获取失败：\$\{mediaFailureReason\(img\?\.error\)\}）/.test(SRC));
check('S7 fetchMediaData 失败标签带原因', /（\$\{noun\}获取失败：\$\{mediaFailureReason\(img\?\.error\)\}）/.test(SRC));
check('S8 deliverPromptNow 0/部分送达注入提示', /mediaDeliveryNotice\(wantMedia, gotMedia, reasons\)/.test(SRC) && /带图唤醒有图没送达/.test(SRC));
check('S9 verify 脚本按 claim/actual 判定', /claim > p\.images/.test(VERIFY) && /声称 \$\{claim\} 张 \/ 实际送达/.test(VERIFY));

// ── 抽函数 ──
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}
const reasonCode = extractFunction(SRC, 'mediaFailureReason');
const noticeCode = extractFunction(SRC, 'mediaDeliveryNotice');
const fitCode = extractFunction(SRC, 'fitImageBuffer');
const mediaFailureReason = new Function(`${reasonCode}\nreturn mediaFailureReason;`)();
// mediaDeliveryNotice 独立提取（不依赖 reason helper）
const makeNotice = new Function(`${noticeCode}\nreturn mediaDeliveryNotice;`);

// ── B1/B2 失败原因 & 0 送达提示 ──
check('B1 mediaFailureReason 去空白/截断', mediaFailureReason('  图片超过大小限制（8388608 字节）  ') === '图片超过大小限制（8388608 字节）' && mediaFailureReason('').length > 0);
const notice = makeNotice()(3, 1, ['[图片2]（获取失败：超过大小限制）']);
check('B2 0/部分送达提示含关键措辞', /声称带图 3 张/.test(notice) && /实际只有 1 张/.test(notice) && /不要猜/.test(notice) && /重发/.test(notice), notice.replace(/\n/g, ' ').slice(0, 120));

// ── B3~B6 fitImageBuffer 行为（桩件） ──
function buildFit({ sipsExists = true, execThrows = false } = {}) {
  const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
  const MAX_MEDIA_PIXELS = 64_000_000;
  const calls = [];
  const factory = new Function(
    'fs', 'os', 'path', 'execFileSync', 'MAX_MEDIA_BYTES', 'MAX_MEDIA_PIXELS',
    'getImageDimensions', 'acceptImageBuffer', 'mediaFailureReason', 'SIPS_BIN', 'log',
    `${fitCode}\nreturn fitImageBuffer;`
  );
  const fit = factory(
    {
      existsSync: () => sipsExists,
      mkdtempSync: () => '/tmp/fake-fit',
      writeFileSync: () => {},
      readFileSync: () => Buffer.from('compressed-jpeg-bytes'),
      rmSync: () => {}
    },
    { tmpdir: () => '/tmp' },
    { join: (...p) => p.join('/') },
    () => { calls.push(1); if (execThrows) throw new Error('sips: bad image'); },
    MAX_MEDIA_BYTES, MAX_MEDIA_PIXELS,
    () => ({ width: 100, height: 100 }),
    () => ({ buffer: Buffer.from('ok'), mimeType: 'image/jpeg' }),
    (e) => String(e),
    '/usr/bin/sips',
    () => {}
  );
  return { fit, calls };
}
// 小的图直接通过（不调用 sips）
{
  const { fit, calls } = buildFit();
  const r = fit(Buffer.alloc(1024), '图片');
  check('B3 未超限 → 原样通过且不调 sips', r.buffer && !r.resized && calls.length === 0);
}
// 大于 8MB → 调 sips 压缩
{
  const { fit, calls } = buildFit();
  const big = Buffer.alloc(9 * 1024 * 1024);
  const r = fit(big, '图片');
  check('B4 超 8MB → sips 压缩后通过', r.buffer && r.resized === true && r.originalBytes === big.length && calls.length === 1);
}
// 本机没有 sips → 返回 error（回退到失败可见化）
{
  const { fit } = buildFit({ sipsExists: false });
  const r = fit(Buffer.alloc(9 * 1024 * 1024), '图片');
  check('B5 没有 sips → 返回可读错误', !!r.error && /没有/.test(r.error) && /可压缩/.test(r.error), r.error);
}
// sips 执行失败 → 返回压缩失败错误
{
  const { fit } = buildFit({ execThrows: true });
  const r = fit(Buffer.alloc(9 * 1024 * 1024), '图片');
  check('B6 sips 执行失败 → 返回压缩失败错误', !!r.error && /压缩失败/.test(r.error), r.error);
}

const pass = ok === cases.length;
console.log(`MEDIA-FIT TEST ${pass ? 'PASS' : 'FAIL'}（${ok}/${cases.length}）`);
for (const c of cases) console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}${c.pass || !c.got ? '' : ` · got ${c.got}`}`);
process.exitCode = pass ? 0 : 1;
