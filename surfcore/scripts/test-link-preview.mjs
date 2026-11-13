#!/usr/bin/env node
// task-25 ① 单测：链接识别 / 预览抓取（fx→vx 回退 / 404 / 超时）/ 注解 / 缓存 / ownerOnly / 关闭开关
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractStatusLinks, shouldPreviewLink, formatTweetAnnotation, formatPreviewFailure, fetchStatusPreview, PreviewCache, DEFAULT_LINK_PREVIEW } from '../src/link-preview.js';

let ok = 0; const cases = [];
const check = (name, pass, got = '') => { cases.push({ name, pass, got }); if (pass) ok += 1; };
const res = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json });

// 链接识别
{
  const links = extractStatusLinks('看看 https://x.com/kurage_8210/status/2119432571281158628?s=46&t=abc 这个，还有 https://twitter.com/foo/status/1234567890 和裸域 x.com/bar/status/999999999 以及 https://x.com/foo 不是 status');
  check('L1 识别 x/twitter/裸域 status 链接', links.length === 3, JSON.stringify(links.map((x) => x.statusId)));
  check('L2 去重 + user/url 正确', links[0].statusId === '2119432571281158628' && links[0].user === 'kurage_8210' && links[0].url === 'https://x.com/kurage_8210/status/2119432571281158628');
  check('L3 非 status 链接忽略', !links.some((x) => x.statusId === 'foo'));
}
// 注解
check('F1 注解含作者与正文', formatTweetAnnotation({ author: 'Kurage_8210', text: 'これには燐羽もびっくり🦋 #氷渡香名江実装決定' }).includes('@Kurage_8210') && formatTweetAnnotation({ author: 'a', text: 'x' }).includes('推文'));
check('F2 正文截断 ≤200 且去 URL', formatTweetAnnotation({ author: 'a', text: 'https://t.co/x ' + '字'.repeat(500) }, 200).replace(/^［.*：/, '').length <= 201);
check('F3 失败注解明确别猜', /别猜/.test(formatPreviewFailure()));
// 开关/隐私
check('P1 默认 ownerOnly 只处理 owner', shouldPreviewLink({ isOwner: true }) === true && shouldPreviewLink({ isOwner: false }) === false);
check('P2 ownerOnly=false 放开', shouldPreviewLink({ isOwner: false, cfg: { ...DEFAULT_LINK_PREVIEW, ownerOnly: false } }) === true);
check('P3 enabled=false 全关', shouldPreviewLink({ isOwner: true, cfg: { ...DEFAULT_LINK_PREVIEW, enabled: false } }) === false);
// 抓取：fx 成功
const fxJson = { code: 200, tweet: { text: 'これには燐羽もびっくり🦋\n#氷渡香名江実装決定', author: { name: '倉〜下', screen_name: 'Kurage_8210' } } };
const link = { statusId: '2119432571281158628', user: 'kurage_8210' };
{
  const calls = [];
  const r = await fetchStatusPreview(link, { timeoutMs: 500, fetchImpl: async (url) => { calls.push(url); return res(200, fxJson); } });
  check('F4 fx 成功返回作者/正文/来源', r.ok === true && r.author === 'Kurage_8210' && r.text.includes('氷渡香名江') && r.source === 'fx', JSON.stringify(r).slice(0, 100));
  check('F5 只请求固定域', calls.length === 1 && calls[0].startsWith('https://api.fxtwitter.com/'), calls[0]);
}
// 抓取：fx 404 → vx 回退
{
  const calls = [];
  const r = await fetchStatusPreview(link, { timeoutMs: 500, fetchImpl: async (url) => { calls.push(url); return url.includes('fxtwitter') ? res(404, { code: 404 }) : res(200, { text: 'vx 正文', user_screen_name: 'vx_author' }); } });
  check('F6 fx 失败回退 vx', r.ok === true && r.source === 'vx' && r.author === 'vx_author' && calls.length === 2);
}
// 抓取：全失败
{
  const r = await fetchStatusPreview(link, { timeoutMs: 200, fetchImpl: async () => res(503, {}) });
  check('F7 全失败返回可读 error', r.ok === false && typeof r.error === 'string' && r.error.length > 0, r.error);
}
// 抓取：超时（fetch 抛 AbortError）
{
  const r = await fetchStatusPreview(link, { timeoutMs: 200, fetchImpl: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; } });
  check('F8 超时被捕获（不抛）', r.ok === false && /超时/.test(r.error), r.error);
}
// 缓存
{
  const file = path.join(os.tmpdir(), `lp-test-${Date.now()}.json`);
  const c = new PreviewCache(file, { ttlDays: 7, max: 3 });
  c.set('1', { ok: true, author: 'a', text: 't' });
  check('C1 cache 命中', c.get('1')?.ok === true);
  const c2 = new PreviewCache(file, { ttlDays: 7, max: 3 });
  check('C2 落盘后重载命中', c2.get('1')?.author === 'a');
  c.set('2', { ok: true }); c.set('3', { ok: true }); c.set('4', { ok: true });
  check('C3 LRU 上限生效', c.map.size <= 3 && !c.get('1'), String(c.map.size));
  const stale = new PreviewCache(file, { ttlDays: 1, max: 3 });
  stale.map.set('9', { ok: true, fetchedAt: Date.now() - 3 * 86400e3 });
  check('C4 TTL 过期失效', stale.get('9') === null);
  fs.rmSync(file, { force: true });
}

const pass = ok === cases.length;
console.log(`LINK-PREVIEW TEST ${pass ? 'PASS' : 'FAIL'}（${ok}/${cases.length}）`);
for (const c of cases) console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}${c.pass || !c.got ? '' : ` · got ${c.got}`}`);
process.exitCode = pass ? 0 : 1;
