// 记忆卡（src/memory-card.js）的离线单测。
// 覆盖：重要度评分 / 主人锚点 / QQ inbox / B站摄取 / 清晰度衰减 / 压缩 / 容量告警 / 隐私边界。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  DAY_MS, INITIAL_WINDOW_DAYS, addMemoryRecord, appendMemoryInboxEvent, applyDailyDecay,
  archiveDecayedToFull, clearFirstMeeting, compactMemoryCard, createEmptyCard, designateFirstMeeting,
  fullMemoryCardStatus, ingestBiliEntries, ingestInboxLines, initialProbabilityForOffset, loadMemoryCard,
  maintainMemoryCard, memoryCardStatus, mergeMemories, normalizeMemoryCardConfig, readAllFullRecords,
  recallFullMemory, redactForMemory, refreshInitialState, renderFullMemoryCard, renderMemoryCard,
  resolveMemoryCardPaths, scoreMemory, shouldNotifyOwner, targetClarity,
  NORMALIZE_RECORDS_SAFETY_CAP, INBOX_SEEN_KEEP,
  originKindOf, canEnterGroupView, isRecapStatLine,
  isNoteRecord, normalizeRecordStatus, extractQuotes, addManualMemory,
} from '../src/memory-card.js';

const temps = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-card-test-'));
  temps.push(dir);
  return dir;
}
after(() => {
  for (const dir of temps) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

const NOW = Date.parse('2026-10-22T12:00:00+08:00');
const CFG = normalizeMemoryCardConfig({ maxChars: 4000, injectMaxChars: { qq: 900, bili: 700 } });

test('重要度：和主人的情绪互动最重，第一次见面是永久锚点', () => {
  const first = scoreMemory({
    text: '主人第一次对wo说：以后就是一家人了，最喜欢角色',
    isOwner: true, isPrivate: true, direct: true, isFirst: true,
  });
  assert.equal(first.importance, 100);
  assert.equal(first.pinned, true);
  assert.equal(first.kind, 'first');
  assert.ok(first.reasons.some((r) => r.includes('主人')));
  assert.ok(first.reasons.some((r) => r.includes('情绪')));

  const ownerEmotion = scoreMemory({
    text: '主人说今天有点难过，想抱抱角色',
    isOwner: true, isPrivate: true, direct: true,
  });
  const ownerCasual = scoreMemory({
    text: '主人：在吗，帮我看看这个报错',
    isOwner: true, isPrivate: true, direct: true,
  });
  const groupChatter = scoreMemory({
    text: '哈哈哈这个视频好好笑',
    isOwner: false, isPrivate: false, direct: false,
  });
  assert.ok(ownerEmotion.importance > ownerCasual.importance);
  assert.ok(ownerCasual.importance > groupChatter.importance);
  assert.ok(ownerEmotion.importance >= CFG.minOwnerImportance);
});

test('QQ inbox：投递一次就入库；重复不重复占容量；第一句主人消息被钉成锚点', () => {
  const card = createEmptyCard(NOW);
  const lines = [
    JSON.stringify({ at: '2026-10-20T10:00:00+08:00', kind: 'group', sender: 'omm', senderId: '1000000007', text: '角色在吗', isOwner: false, direct: true }),
    JSON.stringify({ at: '2026-10-20T10:01:00+08:00', kind: 'private', sender: '主人', senderId: '10001', text: '角色，今天过得怎么样呀', isOwner: true, private: true, direct: true }),
    // 同一句话隔天重复：不重复占容量（同一段 2 天窗口内按文本去重）
    JSON.stringify({ at: '2026-10-21T10:01:00+08:00', kind: 'private', sender: '主人', senderId: '10001', text: '角色，今天过得怎么样呀', isOwner: true, private: true, direct: true }),
    JSON.stringify({ at: '2026-10-21T23:00:00+08:00', kind: 'private', sender: '主人', senderId: '10001', text: '晚安，角色', isOwner: true, private: true, direct: true }),
  ];
  const result = ingestInboxLines(card, lines, CFG, NOW);
  assert.equal(result.added, 3);
  const owners = card.records.filter((r) => r.tags.includes('owner'));
  assert.equal(owners.length, 2);
  const anchor = card.records.find((r) => r.pinned);
  assert.ok(anchor);
  assert.equal(anchor.kind, 'first');
  assert.equal(anchor.importance, 100);
  assert.equal(anchor.text, '角色，今天过得怎么样呀');
  // 再投一次同样的行 → inboxSeen 去重
  const again = ingestInboxLines(card, lines, CFG, NOW);
  assert.equal(again.added, 0);
});

test('B站摄取出模块，且 sourceId 去重；时政/八卦只留在本地不进提示词', () => {
  const card = createEmptyCard(NOW);
  const entries = [
    { id: 'bv:BV1aaa', type: 'video', title: '招牌词娘学黑话', text: '有趣', reason: 'AI 运营号自己学黑话，诚实又好笑', score: 14, favorite: false, at: '2026-10-21T20:00:00+08:00' },
    { id: 'bv:BV1bbb', type: 'dynamic', title: '午mer', text: '今天看到一条很好笑的二创', score: 12, favorite: true, at: '2026-10-22T09:00:00+08:00' },
    { id: 'bv:BV1ccc', type: 'video', title: '某国大选新闻', text: '时政', reason: '新闻', score: 3, at: '2026-10-22T08:00:00+08:00' },
  ];
  const result = ingestBiliEntries(card, entries, CFG, NOW);
  assert.equal(result.added, 3);
  assert.equal(card.records.filter((r) => r.platform === 'bili').length, 3);
  const again = ingestBiliEntries(card, entries, CFG, NOW);
  assert.equal(again.added, 0);
  const biliPrompt = renderMemoryCard(card, { config: CFG, platform: 'bili', maxChars: 2000, now: NOW });
  assert.match(biliPrompt, /招牌词娘学黑话/);
  assert.doesNotMatch(biliPrompt, /某国大选新闻/);
  const full = renderMemoryCard(card, { config: CFG, full: true, now: NOW + 10 * DAY_MS });
  assert.match(full, /B站（冲浪）/);
});

test('隐私：QQ 私事默认不进 B站 提示词；密钥/手机号在入库前被隐藏', () => {
  const card = createEmptyCard(NOW);
  ingestInboxLines(card, [
    JSON.stringify({
      at: '2026-10-22T10:00:00+08:00', kind: 'private', sender: '主人', senderId: '10001',
      text: '这个 token=sk-abcdefghijklmnop 和手机 13800138000 别发出去；今天想你了', isOwner: true, private: true, direct: true, // release-audit: allow（测试夹具，假值）
    }),
  ], CFG, NOW);
  const owner = card.records.find((r) => r.tags.includes('owner'));
  assert.ok(owner);
  assert.doesNotMatch(owner.text, /sk-abcdefghijklmnop/);   // release-audit: allow（测试夹具，假值）
  assert.doesNotMatch(owner.text, /13800138000/);
  assert.match(owner.text, /\[已隐藏\]|\[手机号已隐藏\]/);
  const biliPrompt = renderMemoryCard(card, { config: CFG, platform: 'bili', maxChars: 2000, now: NOW });
  assert.doesNotMatch(biliPrompt, /今天想你了/);
  const qqPrompt = renderMemoryCard(card, { config: CFG, platform: 'qq', maxChars: 2000, now: NOW });
  assert.match(qqPrompt, /今天想你了/);
});

test('遗忘：不重要的一天降一档，最后彻底忘掉；主人重要记忆和锚点不动', () => {
  const card = createEmptyCard(NOW - 90 * DAY_MS);
  const oldUnimportant = addMemoryRecord(card, {
    source: 'bili-video', sourceId: 'bili:old', text: '看过一个很普通的视频，没什么特别的',
    title: '很普通的视频', score: 2, scope: 'bili', platform: 'bili',
    createdAt: NOW - 80 * DAY_MS, lastSeenAt: NOW - 80 * DAY_MS,
  }, CFG, NOW - 80 * DAY_MS).record;
  const oldImportant = addMemoryRecord(card, {
    source: 'qq-owner', data: '', text: '主人：不管以后怎么样，我都会陪着你，别难过',
    isOwner: true, isPrivate: true, direct: true,
    createdAt: NOW - 80 * DAY_MS, lastSeenAt: NOW - 80 * DAY_MS,
  }, CFG, NOW - 80 * DAY_MS).record;
  const anchor = addMemoryRecord(card, {
    source: 'qq-owner', text: '最早的一句话', isOwner: true, isPrivate: true, direct: true, isFirst: true,
    createdAt: NOW - 100 * DAY_MS, lastSeenAt: NOW - 100 * DAY_MS,
  }, CFG, NOW - 100 * DAY_MS).record;
  assert.ok(oldUnimportant && oldImportant && anchor);
  // 逐日推进 12 天（每次 force 都算一天）
  for (let i = 0; i < 12; i += 1) {
    applyDailyDecay(card, CFG, NOW + i * DAY_MS, { force: true });
  }
  assert.equal(card.records.some((r) => r.id === anchor.id), true);
  assert.equal(card.records.find((r) => r.id === anchor.id).clarity, 'vivid');
  const ownerNow = card.records.find((r) => r.id === oldImportant.id);
  assert.ok(ownerNow);
  assert.ok(['vivid', 'clear'].includes(ownerNow.clarity), `主人重要记忆不应模糊，实际 ${ownerNow.clarity}`);
  const unimportantNow = card.records.find((r) => r.id === oldUnimportant.id);
  assert.equal(unimportantNow, undefined, '80 天前的不重要记忆最终应该被忘掉');
  assert.ok(card.stats.forgotten >= 1);
});

test('清晰度目标：最近的事至少清楚；pinned 永远清晰', () => {
  const recent = { pinned: false, importance: 5, createdAt: new Date(NOW - 1 * DAY_MS).toISOString(), lastSeenAt: new Date(NOW - 1 * DAY_MS).toISOString(), recallCount: 0, tags: [], clarity: 'clear' };
  assert.equal(targetClarity(recent, CFG, NOW), 'clear');
  const pinned = { ...recent, pinned: true, importance: 1 };
  assert.equal(targetClarity(pinned, CFG, NOW), 'vivid');
});

test('压缩：容量回到目标内，且不会动置顶 / 主人重要记忆', () => {
  const card = createEmptyCard(NOW);
  for (let i = 0; i < 90; i += 1) {
    addMemoryRecord(card, {
      source: 'bili-video', sourceId: `bili:${i}`, text: `第 ${i} 个普通视频，记录一点没什么重要的内容，只是为了把容量撑大一点。`,
      title: `普通视频 ${i}`, score: 1, scope: 'bili', platform: 'bili',
      createdAt: NOW - (i + 1) * DAY_MS, lastSeenAt: NOW - (i + 1) * DAY_MS,
    }, CFG, NOW);
  }
  const anchor = addMemoryRecord(card, {
    source: 'qq-owner', text: '最早和主人说话，这件事永远记得', isOwner: true, isPrivate: true, direct: true, isFirst: true,
    createdAt: NOW - 100 * DAY_MS,
  }, CFG, NOW).record;
  const ownerImportant = addMemoryRecord(card, {
    source: 'qq-owner', text: '主人说最喜欢角色了，抱抱', isOwner: true, isPrivate: true, direct: true,
    createdAt: NOW - 90 * DAY_MS,
  }, CFG, NOW).record;
  const before = renderMemoryCard(card, { config: CFG, full: true, now: NOW }).length;
  assert.ok(before > CFG.maxChars, `前置条件：压缩前应超容量，实际 ${before}`);
  const steps = compactMemoryCard(card, CFG, { targetRatio: 0.8, now: NOW });
  assert.ok(steps > 0);
  const afterChars = renderMemoryCard(card, { config: CFG, full: true, now: NOW }).length;
  assert.ok(afterChars < before);
  assert.ok(card.records.some((r) => r.id === anchor.id && r.pinned && r.clarity === 'vivid'));
  const owner = card.records.find((r) => r.id === ownerImportant.id);
  assert.ok(owner, '主人重要记忆不能被压缩删掉');
  assert.ok(owner.importance >= CFG.minOwnerImportance);
});

test('容量告警：80 / 90 / 100% 三档 + 通知节流', () => {
  const card = createEmptyCard(NOW);
  for (let i = 0; i < 40; i += 1) {
    addMemoryRecord(card, {
      source: 'bili-video', sourceId: `cap:${i}`,
      text: `用来测容量的记忆 ${i}：这是一段长度中等的文字，让它占掉一部分容量，重复多次后就能跨过阈值。`,
      title: `容量测试 ${i}`, score: 1, scope: 'bili', platform: 'bili',
      createdAt: NOW - i * 60_000, lastSeenAt: NOW - i * 60_000,
    }, normalizeMemoryCardConfig({ maxChars: 3000 }), NOW);
  }
  const small = normalizeMemoryCardConfig({ maxChars: 3000 });
  const status = memoryCardStatus(card, small, NOW);
  assert.ok(status.percent >= 80, `实际 ${status.percent}%`);
  assert.ok(status.level >= 1);
  assert.equal(shouldNotifyOwner({ alerts: { lastNotified: {} } }, 1, NOW), true);
  assert.equal(shouldNotifyOwner({ alerts: { lastNotified: { 1: NOW - 60_000 } } }, 1, NOW), false);
});

test('渲染：QQ / B站 注入块都不超过各自 maxChars，且带“记忆卡”标识', () => {
  const card = createEmptyCard(NOW);
  for (let i = 0; i < 30; i += 1) {
    addMemoryRecord(card, {
      source: 'qq-owner', text: `主人和角色的第 ${i} 次聊天，说了一些很长很长的话，用来测试提示词裁剪是否生效。`,
      isOwner: true, isPrivate: true, direct: true,
      createdAt: NOW - i * DAY_MS, lastSeenAt: NOW - i * DAY_MS,
    }, CFG, NOW);
  }
  for (const platform of ['qq', 'bili']) {
    const max = platform === 'qq' ? 900 : 700;
    const text = renderMemoryCard(card, { config: CFG, platform, maxChars: max, now: NOW });
    assert.ok(text.length <= max, `${platform} 注入 ${text.length} > ${max}`);
  }
  assert.match(renderMemoryCard(card, { config: CFG, platform: 'qq', maxChars: 900, now: NOW }), /记忆卡/);
});

test('脱敏：共享 scope 隐藏 5-12 位数字，QQ scope 保留；链接/长串被去掉', () => {
  const qq = redactForMemory('QQ 10001 在群里说 https://example.com/x token=abcdef123456', { scope: 'qq' });
  assert.match(qq, /10001/);
  assert.doesNotMatch(qq, /https:\/\//);
  const shared = redactForMemory('QQ 10001 和 mid 20003', { scope: 'shared' });
  assert.doesNotMatch(shared, /10001|20003/);
});

test('inbox 文件：只追加脱敏后的 JSON 行', () => {
  const dir = tempDir();
  const paths = resolveMemoryCardPaths(dir);
  appendMemoryInboxEvent(paths, {
    at: NOW, kind: 'private', sender: '主人', senderId: '10001', isOwner: true, private: true,
    text: '密码是 hunter2，手机 13800138000', direct: true,
  });
  const lines = fs.readFileSync(paths.inbox, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const item = JSON.parse(lines[0]);
  assert.equal(item.isOwner, true);
  assert.doesNotMatch(item.text, /hunter2|13800138000/);
});

test('维护：写 4 份文件；第二次维护幂等（不重复摄取）', () => {
  const dir = tempDir();
  const paths = resolveMemoryCardPaths(dir);
  const inboxLines = [JSON.stringify({ at: '2026-10-22T10:00:00+08:00', kind: 'private', sender: '主人', text: '今天也最喜欢角色了', isOwner: true, private: true, direct: true })];
  const biliEntries = [{ id: 'bv:keep', type: 'video', title: '一个视频', reason: '很好看', score: 15, at: '2026-10-21T20:00:00+08:00' }];
  const first = maintainMemoryCard({ paths, config: CFG, inboxLines, biliEntries, now: NOW });
  assert.equal(first.qq, 1);
  assert.equal(first.bili, 1);
  for (const file of [paths.json, paths.markdown, paths.promptQq, paths.promptBili]) {
    assert.equal(fs.existsSync(file), true, `缺少 ${file}`);
  }
  assert.ok(loadMemoryCard(paths));
  const second = maintainMemoryCard({ paths, config: CFG, inboxLines, biliEntries, now: NOW + 60_000 });
  assert.equal(second.qq, 0);
  assert.equal(second.bili, 0);
});

test('补跑：DSH 关了几天后，一次整理能按错过天数连续降档', () => {
  const card = createEmptyCard(NOW - 30 * DAY_MS);
  const record = addMemoryRecord(card, {
    source: 'bili-video', sourceId: 'bili:catchup', text: '一条不太重要的旧视频记录，用来测试补跑',
    title: '旧视频', score: 1, scope: 'bili', platform: 'bili',
    createdAt: NOW - 20 * DAY_MS, lastSeenAt: NOW - 20 * DAY_MS,
  }, CFG, NOW - 20 * DAY_MS).record;
  assert.ok(record);
  const before = record.clarity;
  applyDailyDecay(card, CFG, NOW, { force: true, steps: 4 });
  const after = card.records.find((item) => item.id === record.id);
  assert.ok(!after || ['fuzzy', 'trace'].includes(after.clarity), `补跑后应明显变模糊，实际 ${after?.clarity ?? '已遗忘'}（之前 ${before}）`);
});

test('全量卡：衰减卡遗忘后，JSONL 仍保留完整正文且永远清晰', () => {
  const dir = tempDir();
  const paths = resolveMemoryCardPaths(dir);
  const card = createEmptyCard(NOW - 30 * DAY_MS);
  const old = addMemoryRecord(card, {
    source: 'bili-video', sourceId: 'full:old', text: '这条记忆会被衰减卡忘掉，但全量卡必须保留：和老群友一起看过的冷门视频。',
    title: '冷门视频', score: 1, scope: 'bili', platform: 'bili',
    createdAt: NOW - 70 * DAY_MS, lastSeenAt: NOW - 70 * DAY_MS,
  }, CFG, NOW).record;
  assert.equal(archiveDecayedToFull(paths, card, CFG, NOW), 1);
  let fullRecords = readAllFullRecords(paths);
  assert.equal(fullRecords.length, 1);
  assert.equal(fullRecords[0].clarity, 'vivid');
  // 反复衰减直到衰减卡忘掉这条
  for (let i = 0; i < 10; i += 1) applyDailyDecay(card, CFG, NOW + i * DAY_MS, { force: true, steps: 1 });
  assert.equal(card.records.find((r) => r.id === old.id), undefined, '衰减卡应最终遗忘');
  fullRecords = readAllFullRecords(paths);
  assert.equal(fullRecords.find((r) => r.id === old.id)?.text.includes('冷门视频'), true);
  const fullText = renderFullMemoryCard(fullRecords, { now: NOW });
  assert.match(fullText, /冷门视频/);
  assert.match(fullText, /全量存档/);
  // 衰减卡的提示词不能再出现已忘内容
  assert.doesNotMatch(renderMemoryCard(card, { config: CFG, platform: 'qq', maxChars: 2000, now: NOW }), /冷门视频/);
  // 全量卡没有 prompt 注入文件
  assert.equal(Object.prototype.hasOwnProperty.call(paths, 'promptFull'), false);
});

test('全量卡：归档在衰减之前；补跑也不会漏档', () => {
  const dir = tempDir();
  const paths = resolveMemoryCardPaths(dir);
  const oldAt = new Date(NOW - 90 * DAY_MS).toISOString();
  const result = maintainMemoryCard({
    paths,
    config: CFG,
    inboxLines: [JSON.stringify({ at: oldAt, kind: 'private', sender: '主人', isOwner: true, private: true, direct: true, text: '很久以前第一次说的话，不能被补跑忘掉' })],
    biliEntries: [{ id: 'bv:catch', type: 'video', title: '一条很老的视频', reason: '普通', score: 1, at: oldAt }],
    now: NOW,
    forceDecay: false,
    fullPaths: paths,
    fullConfig: CFG,
  });
  assert.ok(result.full);
  assert.ok(result.full.added >= 2);
  assert.equal(readAllFullRecords(paths).length >= 2, true);
  assert.equal(loadMemoryCard(paths).records.length >= 2, true);
  // 衰减卡里的记录已被标记 fullArchivedAt，二次维护不重复追加
  const again = maintainMemoryCard({ paths, config: CFG, now: NOW + 60_000, fullPaths: paths, fullConfig: CFG });
  assert.equal(again.full.added, 0);
});

test('全量卡：按关键词召回，容量按 JSONL 字节数算', () => {
  const dir = tempDir();
  const paths = resolveMemoryCardPaths(dir);
  const card = createEmptyCard(NOW);
  addMemoryRecord(card, {
    source: 'qq-owner', text: '主人说：第一次见到你的时候，你还在 B站 刷视频', isOwner: true, isPrivate: true, direct: true,
    createdAt: NOW - 2 * DAY_MS,
  }, CFG, NOW);
  addMemoryRecord(card, {
    source: 'bili-video', sourceId: 'bili:recall', text: '在 B站 看了《招牌词娘学黑话》，很好笑', title: '招牌词娘学黑话', score: 12, scope: 'bili', platform: 'bili',
    createdAt: NOW - DAY_MS,
  }, CFG, NOW);
  assert.equal(archiveDecayedToFull(paths, card, CFG, NOW), 2);
  const owner = recallFullMemory(paths, '第一次', { limit: 5 });
  assert.ok(owner.length >= 1);
  assert.match(owner[0].text, /第一次见到你/);
  const bili = recallFullMemory(paths, '招牌词娘', { limit: 5 });
  assert.ok(bili.length >= 1);
  assert.match(bili[0].text, /招牌词娘/);
  const status = fullMemoryCardStatus(paths, normalizeMemoryCardConfig({ fullMaxBytes: 10 * 1024 * 1024 }), NOW);
  assert.equal(status.records, 2);
  assert.ok(status.bytes > 0);
  assert.equal(status.level, 0);
  assert.equal(status.unlimited, false);
  const unlimited = fullMemoryCardStatus(paths, normalizeMemoryCardConfig({ fullMaxBytes: 0 }), NOW);
  assert.equal(unlimited.unlimited, true);
  assert.equal(unlimited.percent, 0);
});

const FIRST_CONTACT_AT = NOW - 60 * DAY_MS;
function addOwnerRecord(card, offsetDays, text) {
  const at = FIRST_CONTACT_AT + offsetDays * DAY_MS;
  return addMemoryRecord(card, {
    source: 'qq-owner',
    text,
    isOwner: true,
    isPrivate: true,
    direct: true,
    createdAt: at,
    lastSeenAt: at,
  }, CFG, NOW).record;
}

test('最初：仅主人互动，前10/中10/后10/30天后概率递减', () => {
  assert.equal(INITIAL_WINDOW_DAYS, 30);
  assert.equal(initialProbabilityForOffset(0), 0.9);
  assert.equal(initialProbabilityForOffset(9), 0.9);
  assert.equal(initialProbabilityForOffset(10), 0.55);
  assert.equal(initialProbabilityForOffset(19), 0.55);
  assert.equal(initialProbabilityForOffset(20), 0.3);
  assert.equal(initialProbabilityForOffset(29), 0.3);
  assert.equal(initialProbabilityForOffset(30), 0.03);
  assert.equal(initialProbabilityForOffset(365), 0.03);

  const card = createEmptyCard(NOW - 60 * DAY_MS);
  const day0 = addOwnerRecord(card, 0, '第一次和主人说话');
  const day5 = addOwnerRecord(card, 5, '和主人聊了喜欢的东西');
  const day15 = addOwnerRecord(card, 15, '主人说今天有点累');
  const day25 = addOwnerRecord(card, 25, '和主人约好周末看电影');
  const day40 = addOwnerRecord(card, 40, '很久以后又一次聊天');
  const bili = addMemoryRecord(card, {
    source: 'bili-video', sourceId: 'bili:not-owner', text: '在 B 站看了一个视频', title: '视频',
    score: 5, scope: 'bili', platform: 'bili', createdAt: NOW - 2 * DAY_MS, lastSeenAt: NOW - 2 * DAY_MS,
  }, CFG, NOW).record;
  card.meta.firstOwnerAt = day0.createdAt;
  refreshInitialState(card);

  assert.equal(day0.firstMet, true, '最早的主人互动自动成为初次相遇');
  assert.equal(day0.initialTier, 'first-meet');
  assert.equal(day0.initialProbability, 1);
  assert.equal(day5.initialTier, 'first10');
  assert.equal(day5.initialProbability, 0.9);
  assert.equal(day15.initialTier, 'mid10');
  assert.equal(day15.initialProbability, 0.55);
  assert.equal(day25.initialTier, 'late10');
  assert.equal(day25.initialProbability, 0.3);
  assert.equal(day40.initialTier, 'after');
  assert.equal(day40.initialProbability, 0.03);
  // 非主人互动永远不参与「最初」
  assert.equal(bili.isInitial, false);
  assert.equal(bili.initialTier, '');
});

test('初次相遇：可单条指定、也可多条合并为一个事件；可恢复自动', () => {
  const card = createEmptyCard(NOW - 50 * DAY_MS);
  const a = addOwnerRecord(card, 0, '最早认识的那天');
  const b = addOwnerRecord(card, 3, '一起在群里聊到很晚');
  const c = addOwnerRecord(card, 8, '主人夸了我');
  refreshInitialState(card);
  assert.equal(a.firstMet, true, '默认自动取最早一条');

  const single = designateFirstMeeting(card, [b.id], { now: NOW });
  assert.equal(single.ok, true);
  assert.equal(b.firstMet, true);
  assert.equal(b.importance, 100);
  assert.equal(b.pinned, true);
  assert.equal(card.meta.firstMetSource, 'manual');
  assert.equal(card.meta.firstMetEventId, b.id);
  assert.equal(a.firstMet, false, '改指定后旧的最早一条不再是初次相遇');

  const cleared = clearFirstMeeting(card);
  assert.equal(cleared.ok, true);
  assert.equal(card.meta.firstMetSource, 'auto');
  assert.equal(a.firstMet, true, '恢复自动后回到最早一条');

  const merged = designateFirstMeeting(card, [a.id, b.id, c.id], { now: NOW });
  assert.equal(merged.ok, true);
  assert.equal(merged.merged, 3);
  assert.equal(card.records.length, 1, '三条原始互动合并成一个事件');
  const event = card.records[0];
  assert.equal(event.firstMet, true);
  assert.equal(event.kind, 'firstMeet');
  assert.equal(event.pinned, true);
  assert.equal(event.mergedFrom.length, 3);
  assert.match(event.text, /最早认识的那天/);
  assert.match(event.text, /一起在群里聊到很晚/);
  assert.equal(card.meta.firstMetRecordIds.length, 3);
  assert.equal(card.meta.firstMetEventId, event.id);
});

test('最初：渲染独立分区，且不会被彻底遗忘', () => {
  const card = createEmptyCard(NOW - 40 * DAY_MS);
  const first = addOwnerRecord(card, 0, '初次见面');
  const early = addOwnerRecord(card, 5, '最初那几天常聊天');
  refreshInitialState(card);
  early.isInitial = true;
  early.tags = [...new Set([...early.tags, 'initial'])];
  const text = renderMemoryCard(card, { config: CFG, full: true, now: NOW });
  assert.match(text, /## 初次相遇/);
  assert.match(text, /## 最初的日子/);
  assert.match(text, /初次见面/);
  assert.match(text, /最初那几天常聊天/);

  const oldInitial = {
    ...early,
    pinned: false,
    importance: 10,
    createdAt: new Date(NOW - 200 * DAY_MS).toISOString(),
    lastSeenAt: new Date(NOW - 200 * DAY_MS).toISOString(),
    isInitial: true,
    clarity: 'clear',
  };
  assert.equal(targetClarity(oldInitial, CFG, NOW), 'clear', '最初记忆最差保持清楚，不会遗忘');
  assert.equal(first.firstMet, true);
});

test('合并事件：任意多条记忆可合并为一个，默认置顶，不改变初次相遇', () => {
  const card = createEmptyCard(NOW - 40 * DAY_MS);
  const owner = addOwnerRecord(card, 0, '最初的主人互动');
  const b1 = addMemoryRecord(card, {
    source: 'bili-video', sourceId: 'merge:b1', text: '在 B 站看了《招牌词娘》', title: '招牌词娘',
    score: 10, scope: 'bili', platform: 'bili', createdAt: NOW - 10 * DAY_MS, lastSeenAt: NOW - 10 * DAY_MS,
  }, CFG, NOW).record;
  const b2 = addMemoryRecord(card, {
    source: 'bili-video', sourceId: 'merge:b2', text: '在 B 站看了《猫猫》', title: '猫猫',
    score: 8, scope: 'bili', platform: 'bili', createdAt: NOW - 9 * DAY_MS, lastSeenAt: NOW - 9 * DAY_MS,
  }, CFG, NOW).record;
  refreshInitialState(card);
  const firstBefore = card.meta.firstMetEventId;

  const merged = mergeMemories(card, [b1.id, b2.id], { title: '周末刷到的两个视频', pinned: true, now: NOW });
  assert.equal(merged.ok, true);
  assert.equal(merged.merged, 2);
  assert.equal(merged.removed, 2);
  assert.equal(card.records.length, 2, '两条原始 B站记忆替换为一个事件 + 保留主人记录');
  const event = card.records.find((record) => record.id === merged.event.id);
  assert.equal(event.title, '周末刷到的两个视频');
  assert.equal(event.pinned, true);
  assert.equal(event.tags.includes('merged'), true);
  assert.equal(event.scope, 'bili');
  assert.match(event.text, /招牌词娘/);
  assert.match(event.text, /猫猫/);
  assert.equal(card.meta.firstMetEventId, firstBefore, '合并普通记忆不应改变初次相遇');
  assert.equal(owner.firstMet, true);

  // 非主人 + 主人混合：scope 收紧为 QQ，且不自动继承 owner 标签
  const mixed = mergeMemories(card, [owner.id, event.id], { title: '混合事件', pinned: false, now: NOW });
  assert.equal(mixed.ok, false, '初次相遇记录不能合并');
  // 先恢复自动会重新把最早 owner 设成初次相遇，仍不能选；用普通 B站+手动记忆测试混合
  const manual = addMemoryRecord(card, {
    source: 'manual', text: '手动记的一条 QQ 事', title: 'QQ 手动', scope: 'qq', platform: 'qq',
    createdAt: NOW - 2 * DAY_MS, lastSeenAt: NOW - 2 * DAY_MS,
  }, CFG, NOW).record;
  const mixed2 = mergeMemories(card, [event.id, manual.id], { title: '混合', pinned: false, now: NOW });
  assert.equal(mixed2.ok, true);
  assert.equal(mixed2.event.scope, 'qq');
  assert.equal(mixed2.event.tags.includes('owner'), false, '混合事件不应继承 owner 标签');
  assert.equal(mixed2.event.pinned, false);
});

test('QQ 记忆包含她自己的发言：主人记录合并回复；没有对应主人时单独记 self', () => {
  const card = createEmptyCard(NOW - 10 * DAY_MS);
  const ownerLine = JSON.stringify({
    at: new Date(NOW - 5 * 60_000).toISOString(), kind: 'private', sender: '主人', senderId: '1',
    isOwner: true, private: true, direct: true, conversationKey: 'private:1', text: '今天有点想你了',
  });
  const selfLine = JSON.stringify({
    at: new Date(NOW - 4 * 60_000).toISOString(), kind: 'private', sender: '角色', senderId: '2',
    isSelf: true, private: true, conversationKey: 'private:1', text: 'wo也想你，抱抱',
  });
  const first = ingestInboxLines(card, [ownerLine, selfLine], CFG, NOW);
  assert.equal(first.added, 1, 'self 应并进主人记录，不新增第二条');
  const owner = card.records.find((record) => record.tags.includes('owner'));
  assert.ok(owner);
  assert.equal(owner.botReply, 'wo也想你，抱抱');
  assert.equal(owner.conversationKey, 'private:1');

  const selfOnly = ingestInboxLines(card, [JSON.stringify({
    at: new Date(NOW - 60_000).toISOString(), kind: 'group', sender: '角色', senderId: '2',
    isSelf: true, private: false, conversationKey: 'group:9', text: '这个视频好可爱呀',
  })], CFG, NOW);
  assert.equal(selfOnly.added, 1);
  const selfRecord = card.records.find((record) => record.isSelf);
  assert.ok(selfRecord);
  assert.equal(selfRecord.source, 'qq-self');
  assert.equal(selfRecord.scope, 'qq');
  const rendered = renderMemoryCard(card, { config: CFG, full: true, now: NOW });
  assert.match(rendered, /她回：wo也想你/);
  assert.match(rendered, /这个视频好可爱呀/);
});

test('配置收敛：坏值回默认/夹到安全范围，不产生 NaN', () => {
  const cfg = normalizeMemoryCardConfig({ maxChars: -1, recentDays: 'x', injectMaxChars: { qq: 0 }, dailyHour: 999 });
  assert.equal(cfg.maxChars, 0); // 非法值回默认「无上限」
  assert.equal(cfg.warnChars, 60000);
  assert.equal(cfg.recentDays, 7);
  assert.equal(cfg.injectMaxChars.qq, 400);
  assert.equal(cfg.dailyHour, 23);
  // 衰减卡字数：0 = 无上限；正数不设硬上限；只有警告值
  assert.equal(normalizeMemoryCardConfig({ maxChars: 5000 }).maxChars, 5000);
  assert.equal(normalizeMemoryCardConfig({ maxChars: 999999 }).maxChars, 999999);
  assert.equal(normalizeMemoryCardConfig({ maxChars: 0 }).maxChars, 0);
  assert.equal(normalizeMemoryCardConfig({ maxChars: 0, warnChars: 30000 }).warnChars, 30000);
  // 全量卡默认 10GB，0 = 不限制
  assert.equal(normalizeMemoryCardConfig({}).fullMaxBytes, 10 * 1024 ** 3);
  assert.equal(normalizeMemoryCardConfig({ fullMaxBytes: 0 }).fullMaxBytes, 0);
});

test('衰减卡无上限：以警告值为百分比，不自动压缩/删除', () => {
  const card = createEmptyCard();
  const cfg = normalizeMemoryCardConfig({ maxChars: 0, warnChars: 2000 });
  const status = memoryCardStatus(card, cfg, NOW);
  assert.equal(status.unlimited, true);
  assert.equal(status.maxChars, 0);
  assert.equal(status.warnChars, 2000);
  assert.equal(status.ratio, 0);
  assert.ok(status.percent >= 0);
  assert.match(renderMemoryCard(card, { config: cfg, full: true, now: NOW }), /上限不限（警告 2000 字）/);
});

test('桌宠对话：同一张记忆卡、platform/scope 独立，默认不进 B站 注入块', () => {
  const card = createEmptyCard(NOW);
  const t0 = NOW;
  const lines = [
    JSON.stringify({ at: new Date(t0).toISOString(), platform: 'pet', kind: 'private', sender: '主人', isOwner: true, private: true, direct: true, conversationKey: 'pet', text: '今天桌面上陪我一会儿好不好呀' }),
    JSON.stringify({ at: new Date(t0 + 30_000).toISOString(), platform: 'pet', kind: 'private', sender: '角色', isSelf: true, private: true, conversationKey: 'pet', text: 'hao呀，wo就在桌面上陪你 mer' }),
    JSON.stringify({ at: new Date(t0 + 60 * 60_000).toISOString(), platform: 'pet', kind: 'private', sender: '角色', isSelf: true, private: true, conversationKey: 'pet', text: '咪…突然想跟你说句话，今天有点想黏你' }),
  ];
  const res = ingestInboxLines(card, lines, CFG, t0 + 2 * 60 * 60_000);
  assert.equal(res.added, 2, '主人一条 + 主动搭话一条；她的回复并进主人记录');

  const owner = card.records.find((record) => record.source === 'pet-owner');
  assert.ok(owner, '应该有 pet-owner 记录');
  assert.equal(owner.platform, 'pet');
  assert.equal(owner.scope, 'pet');
  assert.match(owner.botReply, /陪你/);

  const self = card.records.find((record) => record.source === 'pet-self');
  assert.ok(self, '主动搭话应该单独记一条 pet-self');
  assert.equal(self.platform, 'pet');

  const cfg = normalizeMemoryCardConfig({ maxChars: 4000, injectMaxChars: { qq: 2000, bili: 1200 } });
  const qqPrompt = renderMemoryCard(card, { platform: 'qq', config: cfg, now: t0 + 3 * 60 * 60_000 });
  assert.match(qqPrompt, /桌宠（私下相处）/);
  assert.match(qqPrompt, /陪你/);
  const biliPrompt = renderMemoryCard(card, { platform: 'bili', config: cfg, now: t0 + 3 * 60 * 60_000 });
  assert.doesNotMatch(biliPrompt, /桌宠（私下相处）/, '桌宠私事默认不进 B站 注入块');
  const full = renderFullMemoryCard(card.records, { now: t0 + 3 * 60 * 60_000 });
  assert.match(full, /桌宠（私下相处）/);

  // inbox 追加也要带 platform，否则维护器会按 QQ 语义入库。
  const paths = resolveMemoryCardPaths(tempDir());
  assert.equal(appendMemoryInboxEvent(paths, { platform: 'pet', text: '桌宠 inbox 测试', isOwner: true, private: true, conversationKey: 'pet' }), true);
  const line = JSON.parse(fs.readFileSync(paths.inbox, 'utf8').trim());
  assert.equal(line.platform, 'pet');
});

test('桌宠记忆在提示词预算里不会被普通最近记忆挤掉', () => {
  const card = createEmptyCard(NOW);
  for (let i = 0; i < 30; i += 1) {
    addMemoryRecord(card, {
      source: 'qq-owner',
      text: `普通主人记忆第 ${i} 条：今天聊了很多工作上的事情，内容比较长，占预算，占预算。`,
      isOwner: true,
      isPrivate: true,
      direct: true,
      createdAt: NOW - i * 60_000,
      lastSeenAt: NOW - i * 60_000,
    }, CFG, NOW);
  }
  for (let i = 0; i < 20; i += 1) {
    addMemoryRecord(card, {
      source: 'qq-group',
      text: `群里的普通消息第 ${i} 条，也很长很长，用来把提示词预算占满。`,
      createdAt: NOW - i * 60_000,
      lastSeenAt: NOW - i * 60_000,
    }, CFG, NOW);
  }
  ingestInboxLines(card, [JSON.stringify({
    at: new Date(NOW).toISOString(), platform: 'pet', kind: 'private', sender: '主人',
    isOwner: true, private: true, direct: true, conversationKey: 'pet',
    text: '桌宠预算验证：这句话必须留在提示词里',
  })], CFG, NOW);
  const cfg = normalizeMemoryCardConfig({ maxChars: 0, injectMaxChars: { qq: 900, bili: 600 }, recentDays: 7 });
  const out = renderMemoryCard(card, { platform: 'qq', config: cfg, maxChars: 900, now: NOW + 60_000 });
  assert.match(out, /桌宠（私下相处）/, '桌宠小节必须出现在 QQ 注入块里');
  assert.match(out, /桌宠预算验证/, '预算紧张时也不能先砍掉桌宠记忆');
});

// ── 2026-11-08（记忆机制升级 P0）：两条防回归 ─────────────────────────────
// 历史 bug：normalizeCard 硬帽 2000（config 已 5000）+ inboxSeen 3000（读取窗口 4000），
// 导致老记录每 10 分钟被重新摄入、重归档，全量归档 96% 是重复行。
test('P0：loadMemoryCard 不再把卡砍回 2000（交给 config maxRecords）', () => {
  assert.equal(NORMALIZE_RECORDS_SAFETY_CAP, 20000);
  const paths = resolveMemoryCardPaths(tempDir());
  const raw = createEmptyCard(NOW);
  for (let i = 0; i < 2500; i += 1) {
    raw.records.push({
      id: `mem_p0_${i}`,
      source: 'qq-group',
      text: `第 ${i} 条旧记忆，用来验证 load 不再硬裁 2000。`,
      createdAt: new Date(NOW - i * 1000).toISOString(),
      lastSeenAt: new Date(NOW - i * 1000).toISOString(),
    });
  }
  fs.writeFileSync(paths.json, JSON.stringify(raw));
  const loaded = loadMemoryCard(paths);
  assert.equal(loaded.records.length, 2500, 'loadMemoryCard 不应再把 2500 条裁成 2000');
});

test('P0：inboxSeen 至少保留 5000 键（≥ 插件 4000 行读取窗口）', () => {
  assert.equal(INBOX_SEEN_KEEP, 5000);
  const card = createEmptyCard(NOW);
  // 模拟「已经看过 3000 行」的旧卡：新摄入一行后键集合必须继续增长（旧实现会卡在 3000）
  card.meta.inboxSeen = Array.from({ length: 3000 }, (_, i) => `seedkey${i}`);
  const line = {
    at: new Date(NOW).toISOString(),
    platform: 'qq', kind: 'group', sender: '群友', senderId: '42',
    conversationKey: 'group:456', private: false, direct: false,
    text: '这一行用于验证 inboxSeen 不再卡在 3000 键',
  };
  ingestInboxLines(card, [JSON.stringify(line)], CFG, NOW);
  assert.equal(card.meta.inboxSeen.length, 3001, 'inboxSeen 应该保留超过 3000 键（旧实现会砍回 3000）');
  const before = card.meta.inboxSeen.length;
  ingestInboxLines(card, [JSON.stringify(line)], CFG, NOW + 60_000);
  assert.equal(card.meta.inboxSeen.length, before, '已摄入过的行不应重复进 inboxSeen');
});

// ── 2026-11-08（task-12）：跨会话分视图 + 统计句清理 ─────────────────────
test('task-12：originKind 推断与群视图准入', () => {
  assert.equal(originKindOf({ conversationKey: 'private:123' }), 'private');
  assert.equal(originKindOf({ conversationKey: 'group:456' }), 'group');
  assert.equal(originKindOf({ private: true }), 'private');
  assert.equal(originKindOf({ groupId: '456' }), 'group');
  assert.equal(originKindOf({ platform: 'bili' }), 'public');
  assert.equal(originKindOf({}), 'unknown');
  assert.equal(originKindOf({ originKind: 'mixed', conversationKey: 'group:1' }), 'mixed');
  assert.equal(canEnterGroupView({ conversationKey: 'group:456' }), true);
  assert.equal(canEnterGroupView({ platform: 'bili' }), true);
  assert.equal(canEnterGroupView({ conversationKey: 'private:123' }), false);
  assert.equal(canEnterGroupView({}), false);
});

test('task-12：群聊视图排除私聊/未知来源，私聊视图不筛', () => {
  const card = createEmptyCard(NOW);
  addMemoryRecord(card, {
    source: 'qq-owner', text: '私聊里说的卡池11/16，群友不懂', isOwner: true, isPrivate: true,
    direct: true, conversationKey: 'private:123', private: true, createdAt: NOW, lastSeenAt: NOW,
  }, CFG, NOW);
  addMemoryRecord(card, {
    source: 'qq-group', text: '群里聊的2027年新企划', conversationKey: 'group:456',
    createdAt: NOW, lastSeenAt: NOW,
  }, CFG, NOW);
  addMemoryRecord(card, {
    source: 'manual', text: '来源不明确的旧记录', manual: true, createdAt: NOW, lastSeenAt: NOW,
  }, CFG, NOW);
  addMemoryRecord(card, {
    source: 'bili-video', text: 'B站刷到的公开视频', scope: 'bili', platform: 'bili',
    createdAt: NOW, lastSeenAt: NOW,
  }, CFG, NOW);

  const group = renderMemoryCard(card, { config: CFG, platform: 'qq', maxChars: 3000, perspective: 'group', now: NOW });
  assert.match(group, /2027年新企划/, '群聊记录应出现在群视图');
  assert.match(group, /B站刷到的公开视频/, '公开来源应出现在群视图');
  assert.doesNotMatch(group, /卡池11\/16/, '私聊记录不应出现在群视图');
  assert.doesNotMatch(group, /来源不明确的旧记录/, '未知来源默认不进群视图');
  assert.doesNotMatch(group, /私聊里的，群里别提/, '不该再靠文本标签兜底');
  assert.match(group, /群聊/);

  const priv = renderMemoryCard(card, { config: CFG, platform: 'qq', maxChars: 3000, now: NOW });
  assert.match(priv, /卡池11\/16/, '私聊视图应保留私聊内容');
  assert.match(priv, /2027年新企划/, '私聊视图也应能看到群聊内容');
  assert.match(priv, /来源不明确的旧记录/, '私聊视图不筛旧记录');
});

test('task-12：统计句不再进注入视图（即使卡里残留）', () => {
  const card = createEmptyCard(NOW);
  addMemoryRecord(card, {
    source: 'qq-group', text: '私聊里聊到「x」；一共 3 句，你自己说了 89 句。',
    title: '最近回顾 · 私聊', conversationKey: 'group:456', manualImportance: 72,
    createdAt: NOW, lastSeenAt: NOW,
  }, CFG, NOW);
  const prompt = renderMemoryCard(card, { config: CFG, platform: 'qq', maxChars: 3000, now: NOW });
  assert.doesNotMatch(prompt, /一共 3 句/, '注入视图不应包含统计句');
  const full = renderMemoryCard(card, { config: CFG, full: true, now: NOW });
  assert.match(full, /一共 3 句/, '完整卡（管理端）仍保留原始记录');
});

test('task-12：迁移清统计句 + 旧回顾补来源 + 取消置顶 + 迁移前备份', () => {
  const paths = resolveMemoryCardPaths(tempDir());
  const card = createEmptyCard(NOW);
  const stat = addMemoryRecord(card, {
    source: 'manual', text: '私聊里聊到「x」；一共 3 句，你自己说了 89 句。',
    title: '最近回顾 · 私聊', manualImportance: 72, createdAt: NOW, lastSeenAt: NOW,
  }, CFG, NOW);
  stat.record.pinned = true;
  stat.record.anchor = true;
  const legacyPriv = addMemoryRecord(card, {
    source: 'manual', text: '他说过「下次早点睡」；我说过「好」。',
    title: '昨天你们聊过（私聊）', manualImportance: 72, createdAt: NOW, lastSeenAt: NOW,
  }, CFG, NOW);
  legacyPriv.record.pinned = true;
  const legacyGroup = addMemoryRecord(card, {
    source: 'manual', text: '群里聊到「卡池」和「周年」。',
    title: '最近回顾 · 群 1000000002', manualImportance: 72, createdAt: NOW, lastSeenAt: NOW,
  }, CFG, NOW);
  legacyGroup.record.pinned = true;
  fs.writeFileSync(paths.json, JSON.stringify(card)); // 测试夹具：模拟生产卡（测试环境临时目录）

  const result = maintainMemoryCard({ paths, config: CFG, inboxLines: [], now: NOW + 60_000 });
  const out = result.card;
  assert.equal(out.records.filter((r) => isRecapStatLine(r.text)).length, 0, '统计句应从热卡清掉');
  const priv = out.records.find((r) => r.title === '昨天你们聊过（私聊）');
  assert.equal(originKindOf(priv), 'private', '旧私聊回顾应补成 private');
  const grp = out.records.find((r) => String(r.title).startsWith('最近回顾 · 群'));
  assert.equal(originKindOf(grp), 'group', '旧群回顾应补成 group');
  assert.equal(grp.conversationKey, 'group:1000000002', '旧群回顾应补上 conversationKey');
  assert.equal(priv.pinned, false, '回顾摘要不应继续置顶');
  assert.equal(grp.pinned, false, '回顾摘要不应继续置顶');
  assert.ok(out.meta.crossViewMigrationAt, '应写入迁移时间戳');
  assert.ok(out.meta.crossViewMigration.backup, '应记录迁移前备份路径');
  assert.ok(fs.existsSync(out.meta.crossViewMigration.backup), '迁移前备份文件应存在');
});

// ── 2026-11-09（task-9 B2）：记录状态 checked/unconfirmed/superseded ─────────────
test('B2：状态默认——原始 transcript=checked，manual/回顾笔记=unconfirmed', () => {
  const card = createEmptyCard(NOW);
  const raw = addMemoryRecord(card, {
    source: 'qq-group', text: '群里的一句原话', conversationKey: 'group:1', createdAt: NOW, lastSeenAt: NOW,
  }, CFG, NOW);
  assert.equal(raw.record.status, 'checked');
  assert.equal(raw.record.statusSource, 'transcript');
  assert.equal(isNoteRecord(raw.record), false);
  const note = addManualMemory(card, { text: '昨天你们聊过（私聊）他说过「早点睡」', title: '最近回顾 · 私聊' }, CFG, NOW);
  assert.equal(note.record.status, 'unconfirmed');
  assert.equal(isNoteRecord(note.record), true);
  assert.equal(normalizeRecordStatus('nonsense'), '');
  assert.deepEqual(extractQuotes('他说过「今晚早点睡」；还说过「明天再见」'), ['今晚早点睡', '明天再见']);
});

test('B2：注入视图只给笔记加 [未核实]，原始记录不加；superseded 不进注入但完整卡保留', () => {
  const card = createEmptyCard(NOW);
  addMemoryRecord(card, {
    source: 'qq-group', text: '原始记录：今天群里聊了学马卡池', conversationKey: 'group:1', createdAt: NOW, lastSeenAt: NOW,
  }, CFG, NOW);
  const note = addManualMemory(card, { text: '资料源：学马剧情 wiki 可用', title: '资料源：学马剧情' }, CFG, NOW);
  note.record.status = 'unconfirmed';
  const obsolete = addManualMemory(card, { text: '过期的旧笔记：头像还是默认图', title: '资料源：头像旧笔记' }, CFG, NOW);
  obsolete.record.status = 'superseded';
  const prompt = renderMemoryCard(card, { config: CFG, platform: 'qq', maxChars: 3000, now: NOW });
  assert.match(prompt, /\[未核实\]/, '未核实笔记应有标记');
  assert.doesNotMatch(prompt, /\[未核实\] 原始记录/, '原始记录不应被标记');
  assert.doesNotMatch(prompt, /过期的旧笔记/, 'superseded 笔记不进注入视图');
  const full = renderMemoryCard(card, { config: CFG, full: true, now: NOW });
  assert.match(full, /过期的旧笔记/, '完整卡仍保留 superseded 笔记');
  assert.match(full, /\[已过期\]/, '完整卡能看到已过期标记');
});

test('B2：迁移做笔记引文核对——能在原话语料里找到→checked+verifiedAt，找不到保持 unconfirmed', () => {
  const paths = resolveMemoryCardPaths(tempDir());
  const card = createEmptyCard(NOW);
  const okNote = addManualMemory(card, { text: '管理员说过「以后接住这个词别用了」', title: '资料源：说话习惯' }, CFG, NOW);
  okNote.record.status = 'unconfirmed';
  const badNote = addManualMemory(card, { text: '管理员说过「这句原话根本不存在」', title: '资料源：不存在的笔记' }, CFG, NOW);
  badNote.record.status = 'unconfirmed';
  fs.writeFileSync(paths.json, JSON.stringify(card)); // 测试夹具（临时目录）
  const inboxLines = [JSON.stringify({ at: new Date(NOW).toISOString(), kind: 'group', sender: '管理员', text: '以后接住这个词别用了' })];
  const result = maintainMemoryCard({ paths, config: CFG, inboxLines, now: NOW + 60_000 });
  const out = result.card;
  const ok = out.records.find((r) => r.title === '资料源：说话习惯');
  const bad = out.records.find((r) => r.title === '资料源：不存在的笔记');
  assert.equal(ok.status, 'checked', '引文能对上应升级 checked');
  assert.ok(ok.verifiedAt, '应有 verifiedAt');
  assert.equal(bad.status, 'unconfirmed', '引文对不上应保持 unconfirmed');
  assert.equal(bad.verifiedAt, '', '未核对不应有 verifiedAt');
});

test('task-28：口径版本字段 round-trip（supersededAt/conflictWith/topicKey/stance）', () => {
  const dir = tempDir();
  const paths = resolveMemoryCardPaths(dir);
  const card = createEmptyCard(NOW);
  const { record } = addMemoryRecord(card, {
    source: 'qq-owner', text: '以后发图之前先看一眼内容', conversationKey: 'private:1', createdAt: NOW - 86400000, lastSeenAt: NOW,
  }, CFG, NOW);
  record.supersededAt = new Date(NOW).toISOString();
  record.supersededBy = 'mem_new';
  record.conflictWith = ['mem_new'];
  record.topicKey = 'image_caption';
  record.stance = 'forbid';
  fs.writeFileSync(paths.json, JSON.stringify(card));
  const loaded = loadMemoryCard(paths);
  const got = loaded.records.find((r) => r.id === record.id);
  assert.equal(got.supersededAt, record.supersededAt);
  assert.equal(got.supersededBy, 'mem_new');
  assert.deepEqual(got.conflictWith, ['mem_new']);
  assert.equal(got.topicKey, 'image_caption');
  assert.equal(got.stance, 'forbid');
});
