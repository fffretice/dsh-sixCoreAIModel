#!/usr/bin/env node
// task-25 ② 单测：晚到消息块（窗口/去重/上限/已渲染/图片/链接预览）+ bridge 集成静态断言
import fs from 'node:fs';
import path from 'node:path';
import { buildLateTurnBlock, collectLateImageIds, DEFAULT_LATE_TURN } from '../src/late-turn.js';

const ROOT = process.env.SURFCORE_DIR || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
let ok = 0; const cases = [];
const check = (name, pass, got = '') => { cases.push({ name, pass, got }); if (pass) ok += 1; };
const NOW = Date.parse('2026-11-09T09:50:00+08:00');
const H = 3600e3;
const msg = (id, minsAgo, extra = {}) => ({ messageId: String(id), seq: Number(id) || 1, sender: '老大', time: NOW - minsAgo * 60e3, text: `消息${id}`, media: [], hasMedia: false, isSelf: false, ...extra });

// 基本块
{
  const msgs = [msg(-631886813, 2, { text: '[图片]', media: [{ kind: 'image' }], hasMedia: true }), msg(-1839214146, 1.5, { text: '现在推上也都在骂' })];
  const r = buildLateTurnBlock(msgs, { lastPromptAt: NOW - 10 * 60e3, now: NOW, maxItems: 5, windowMinutes: 20 });
  check('L1 生成块含两条 + id', r.block.includes('-631886813') && r.block.includes('-1839214146') && r.ids.length === 2);
  check('L2 图片提示 qq_get_message_images', /qq_get_message_images/.test(r.block) && r.imageIds.length === 1, JSON.stringify(r.imageIds));
}
// 窗口过滤
check('L3 上一轮 prompt 之前的消息排除', buildLateTurnBlock([msg('1', 15)], { lastPromptAt: NOW - 5 * 60e3, now: NOW, windowMinutes: 20 }).block === '');
check('L4 超出 windowMinutes 排除', buildLateTurnBlock([msg('2', 30)], { lastPromptAt: NOW - 60 * 60e3, now: NOW, windowMinutes: 20 }).block === '');
// 去重 / 上限 / 已渲染
{
  const dup = [msg(-1, 1), msg(-1, 1), msg(-2, 2)];
  check('L5 同 messageId 去重', buildLateTurnBlock(dup, { lastPromptAt: 0, now: NOW, maxItems: 5, windowMinutes: 20 }).ids.length === 2);
  const many = Array.from({ length: 7 }, (_, i) => msg(-100 - i, 7 - i));
  const r = buildLateTurnBlock(many, { lastPromptAt: 0, now: NOW, maxItems: 5, windowMinutes: 20 });
  check('L6 最多 5 条（取最近）', r.ids.length === 5 && r.block.includes('-106') && !r.block.includes('-100'), r.ids.join(','));
  const rendered = new Set(['-100']);
  const r2 = buildLateTurnBlock([msg(-100, 1), msg(-101, 2)], { lastPromptAt: 0, now: NOW, maxItems: 5, windowMinutes: 20, renderedIds: rendered });
  check('L7 已渲染过的跳过', r2.ids.length === 1 && r2.ids[0] === '-101');
}
check('L8 空输入返回空块', buildLateTurnBlock([], { lastPromptAt: 0, now: NOW }).block === '');
// 链接预览
{
  const m = msg(-9, 1, { text: 'https://x.com/a/status/1', linkPreview: { ok: true, author: 'Kurage_8210', text: '正文测试' } });
  const r = buildLateTurnBlock([m], { lastPromptAt: 0, now: NOW, windowMinutes: 20 });
  check('L9 块里带推文预览', /@Kurage_8210/.test(r.block) && /正文测试/.test(r.block));
}
// 图片收集
{
  const arr = Array.from({ length: 7 }, (_, i) => msg(-200 - i, 7 - i, { media: i % 2 === 0 ? [{ kind: 'image' }] : [], hasMedia: i % 2 === 0 }));
  const ids = collectLateImageIds(arr, { lastPromptAt: 0, now: NOW, maxItems: 5, windowMinutes: 20 });
  check('L10 图片 id 只来自入选的 5 条', ids.length > 0 && ids.every((id) => /^-20[2-6]$/.test(id)), ids.join(','));
}

// ── bridge 集成静态断言 ──
check('S1 已 import 两个模块', /from '\.\/link-preview\.js'/.test(SRC) && /from '\.\/late-turn\.js'/.test(SRC));
check('S2 入站登记晚到 + 链接预览', /noteLateInbound\(key, msg\)/.test(SRC) && /queueLinkPreviewForMessage\(key, msg/.test(SRC));
check('S3 投递成功记录 lastPromptAt', /lastPromptAt\.set\(canonicalV2Key\(key\) \?\? key, Date\.now\(\)\)/.test(SRC));
check('S4 prompt 含晚到块与最近链接块', /lateTurnLine/.test(SRC) && /recentLinksLine/.test(SRC) && /\+ lateTurnLine \+ recentLinksLine \+ taskAnnounce/.test(SRC));
check('S5 quoteHint 已扩到 8 条', /\.slice\(-8\)\s*\/\/ 2026-11-09（task-25 ②）/.test(SRC) || /\.slice\(-8\)/.test(SRC));
check('S6 晚到图片优先合并', /latePriority/.test(SRC) && /addMediaPairs\(latePriority\.media, latePriority\.sources\)/.test(SRC));
check('S7 ownerOnly 过滤接入（shouldPreviewLink）', /shouldPreviewLink\(\{ isOwner, cfg: c \}\)/.test(SRC));
check('S8 config wakeRecentLimit=6', CFG.socialV2?.context?.wakeRecentLimit === 6, String(CFG.socialV2?.context?.wakeRecentLimit));
check('S9 默认配置在模块里', DEFAULT_LATE_TURN.enabled === true && DEFAULT_LATE_TURN.maxItems === 5);
check('S10 双构建安全：构建时不消费、投递后统一消费', /function markPromptSideEffectsConsumed/.test(SRC) && /text\.includes\(id\)\) rendered\.add\(id\)/.test(SRC) && !/for \(const id of r\.ids\) rendered\.add\(id\);/.test(SRC));

const pass = ok === cases.length;
console.log(`LATE-TURN TEST ${pass ? 'PASS' : 'FAIL'}（${ok}/${cases.length}）`);
for (const c of cases) console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}${c.pass || !c.got ? '' : ` · got ${c.got}`}`);
process.exitCode = pass ? 0 : 1;
