// 记忆卡容量通知端点修复的最小验证（2026-11-08，③）
// 不启动桥接：静态断言 + readBody 契约 mock + 从源码里抽出纯函数 memoryCardNotifyMessage 真测。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');

test('bridge /api/memory-card/notify：不再对已解析对象二次 JSON.parse', () => {
  // 契约：桥接的 readBody() resolve 的是**对象**（src/bridge.js 里 done(parsed)）
  assert.match(bridge, /done\(parsed\);/, 'readBody 应 resolve 已解析对象');
  // 端点里必须直接接对象
  assert.match(bridge, /const body = \(await readBody\(\)\) \|\| \{\};/, 'notify 端点应使用 (await readBody()) || {}');
  // 活跃源码里不应再出现同样的错误写法（历史快照/备份文件不算）
  const activeBad = [...bridge.matchAll(/JSON\.parse\(await readBody/g)];
  assert.equal(activeBad.length, 0, `bridge.js 仍有 ${activeBad.length} 处 JSON.parse(await readBody`);

  // 复现旧写法的错误信息，证明这就是插件日志里那条
  const readBodyMock = async () => ({ level: 3, percent: 252.1 });
  (async () => {
    let oldMessage = '';
    try { JSON.parse(await readBodyMock() || '{}'); } catch (error) { oldMessage = String(error?.message ?? error); }
    assert.match(oldMessage, /\[object Object\]/i, '旧写法应抛 [object Object] is not valid JSON');
    const fixed = (await readBodyMock()) || {};
    assert.equal(fixed.level, 3);
    assert.equal(fixed.percent, 252.1);
  })();
});

test('bridge：失败/未配置 ownerQQ 走 1 小时退避（内存 Map，不写盘）', () => {
  assert.match(bridge, /const memoryCardNotifyFailAt = new Map\(\)/, '缺少失败退避 Map');
  assert.match(bridge, /MEMORY_CARD_NOTIFY_BACKOFF_MS = 60 \* 60 \* 1000/, '退避时长应为 1 小时');
  assert.match(bridge, /skipped: 'notify-backoff'/, '退避命中时应返回 skipped=notify-backoff');
  assert.match(bridge, /skipped: 'no-owner'/, '未配置 ownerQQ 应返回 skipped=no-owner');
  assert.match(bridge, /memoryCardNotifyFailAt\.set\(level, now\)/, '发送失败时应记录失败时间');
  assert.match(bridge, /memoryCardNotifyFailAt\.delete\(level\)/, '发送成功时应清掉失败记录');
});

test('bridge：通知文案按真实口径，不再出现「x/0 字」', () => {
  // 从源码里抽出纯函数（不依赖全局）实测
  const match = bridge.match(/function memoryCardNotifyMessage\(\{[\s\S]*?\n\}/);
  assert.ok(match, '找不到 memoryCardNotifyMessage');
  // eslint-disable-next-line no-new-func
  const fn = new Function(`${match[0]}\nreturn memoryCardNotifyMessage;`)();
  const recordsMsg = fn({ percent: 57.4, chars: 151277, maxChars: 0, records: 2872, maxRecords: 5000, basis: 'records' });
  assert.match(recordsMsg, /2872\/5000 条/, '不设字符上限时应按条数口径');
  assert.doesNotMatch(recordsMsg, /\/0 字/, '不能出现 x/0 字');
  const charsMsg = fn({ percent: 88, chars: 8800, maxChars: 10000, records: 0, maxRecords: 0, basis: 'chars' });
  assert.match(charsMsg, /8800\/10000 字/);
  const percentMsg = fn({ percent: 43, chars: 151277, maxChars: 0, records: 0, maxRecords: 0, basis: 'percent' });
  assert.match(percentMsg, /整卡约 151277 字符/);
});

test('bridge：条数口径的记录数/上限可从 body 或现读卡补上', () => {
  assert.match(bridge, /let records = Math\.max\(0, Number\(body\.records\) \|\| 0\)/, '应先读插件传来的 records');
  assert.match(bridge, /loadMemoryCard\(MEMORY_CARD_PATHS\)\?\.records\?\.length/, '旧插件没传 records 时应现读卡补');
  assert.match(bridge, /memoryCardMaxRecordsNow\(\)/, 'maxRecords 缺省时应读配置补');
  assert.match(bridge, /const basis = maxChars > 0 \? 'chars'/, '口径选择应优先字符制');
});
