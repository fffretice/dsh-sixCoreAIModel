#!/usr/bin/env node
// 2026-11-10 task-49：房间「让她看看」服务端链路单测（纯函数 + 接线静态，不启动 bridge/roomlab）。
import fs from 'node:fs';
import path from 'node:path';
import { parseRoomViewImage, roomViewPrompt, roomViewMedia, ROOM_VIEW_DEFAULT_TEXT, ROOM_VIEW_MAX_BYTES } from '../src/room-view.js';

const ROOT = process.env.SURFCORE_DIR || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const BRIDGE = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const ROOMLAB_PATH = process.env.ROOMLAB_SERVER || path.join(process.env.HOME || '', 'roomlab', 'server.mjs');
const ROOMLAB = fs.existsSync(ROOMLAB_PATH) ? fs.readFileSync(ROOMLAB_PATH, 'utf8') : '';
let ok = 0; const cases = [];
const check = (name, pass, got = '') => { cases.push({ name, pass, got }); if (pass) ok += 1; };

// 1x1 透明 PNG
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=';
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;

const p1 = parseRoomViewImage(PNG_B64);
check('P1 纯 base64 PNG 通过', p1.ok && p1.bytes > 0 && p1.base64 === PNG_B64 && p1.mimeType === 'image/png', JSON.stringify(p1.error || ''));
const p2 = parseRoomViewImage(PNG_DATA_URL);
check('P2 dataURL PNG 通过', p2.ok && p2.base64 === PNG_B64);
check('P3 非 PNG 签名拒绝', parseRoomViewImage(Buffer.from('hello world').toString('base64')).ok === false);
check('P4 JPEG dataURL 拒绝', parseRoomViewImage('data:image/jpeg;base64,' + PNG_B64).ok === false);
check('P5 空/非法拒绝', parseRoomViewImage('').ok === false && parseRoomViewImage('!!!notbase64!!!').ok === false);
const big = Buffer.alloc(ROOM_VIEW_MAX_BYTES + 1); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(big, 0);
const pBig = parseRoomViewImage(big.toString('base64'));
check('P6 >2MB 拒绝', pBig.ok === false && /2MB/.test(pBig.error), pBig.error);
check('P7 默认文案/自定义', roomViewPrompt('') === ROOM_VIEW_DEFAULT_TEXT && roomViewPrompt('看看我的蟹') === '看看我的蟹' && roomViewPrompt('x'.repeat(900)).length === 500);
const media = roomViewMedia(p1);
check('P8 media 形状', media.type === 'image' && media.mediaType === 'image/png' && media.data === PNG_B64 && media.name === 'room-view.png');

// 2) bridge 接线静态
check('B1 adminOnly 含 room-view + import', /adminOnlyV2Paths = \[[^\]]*'\/api\/socialV2\/room-view'/.test(BRIDGE) && /from '\.\/room-view\.js'/.test(BRIDGE));
check('B2 readBody 自定义上限 + 端点校验', /readBody = \(maxBytes = 1_000_000\)/.test(BRIDGE) && /readBody\(ROOM_VIEW_MAX_BODY_BYTES\)/.test(BRIDGE) && /parseRoomViewImage\(body\?\.image\)/.test(BRIDGE));
const segStart = BRIDGE.indexOf("url.pathname === '/api/socialV2/room-view'");
const segEnd = BRIDGE.indexOf("// 上线补历史：控制台手动触发一次", segStart);
const seg = segStart >= 0 && segEnd > segStart ? BRIDGE.slice(segStart, segEnd) : '';
check('B3 端点调用 deliverPromptNow(media/wakeReason/extraText)', /deliverPromptNow\(ownerKey, promptText, \{/.test(seg) && /media: \[roomViewMedia\(parsed\)\]/.test(seg) && /wakeReason: 'admin'/.test(seg) && /extraText: promptText/.test(seg));
check('B4 端点不发 QQ', seg.length > 0 && !/sendToQQ|sendMessagesV2|sendGroupMessage|sendPrivateMessage|sendStickerV2/.test(seg), seg.slice(0, 80));
check('B5 wakeReason 重建后 extraText 不丢', /opts\.extraText/.test(BRIDGE) && /promptText = `\$\{promptText\}\\n\\n\$\{String\(opts\.extraText\)\}`/.test(BRIDGE));
check('B6 resolveMediaList 走 data 分支', /media\.data && \(media\.type === 'image'/.test(BRIDGE) && /fitImageBuffer\(raw, 'room-view 图片'\)/.test(BRIDGE));

// 3) roomlab 接线静态
check('R1 roomlab 有 /api/room-view', ROOMLAB.length > 0 && /p === '\/api\/room-view'/.test(ROOMLAB) && /readBodyLimited\(req\)/.test(ROOMLAB));
check('R2 从 SurfCore config 读 token、带 x-console-token 转发', /surfcoreConsoleToken/.test(ROOMLAB) && /SurfCore', 'config.json'/.test(ROOMLAB) && /'x-console-token': token/.test(ROOMLAB) && /127\.0\.0\.1:3100\/api\/socialV2\/room-view/.test(ROOMLAB));
check('R3 body ≤3MB + 不回传 token', /ROOM_VIEW_BODY_MAX = 3 \* 1024 \* 1024/.test(ROOMLAB) && !/res\.end\([^)]*token/.test(ROOMLAB));

const pass = ok === cases.length;
console.log(`ROOM-VIEW TEST ${pass ? 'PASS' : 'FAIL'}（${ok}/${cases.length}）`);
for (const c of cases) console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}${c.pass || !c.got ? '' : ` · ${String(c.got).slice(0, 120)}`}`);
process.exitCode = pass ? 0 : 1;
