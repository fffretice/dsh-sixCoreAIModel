// recent-events 提取/渲染单测（task-26，2026-11-09）。纯函数，不读生产数据。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  candidateTokens, extractEventsForMessages, extractRecentEvents, renderRecentEventsLine,
  renderRecentEventsLineFor, recentEventsLineFor, aliasesFor, eventMatchesText,
  imageFallbackDecision, firstTurnFallbackDecision, eventIsFresh, IMAGE_FALLBACK, FRESH_EVENT_HOURS,
  MAX_EVENT_CHARS, DEFAULT_HOURS,
} from '../src/recent-events.js';

const NOW = Date.parse('2026-11-09T10:00:00+08:00');
const msg = (at, sender, text, extra = {}) => ({ at, conversationKey: 'group:860', sender, text, isSelf: false, ...extra });
const H = 3600_000;

test('候选专名：中文 ngram / 片假名 / 引号 / 英文；停用词与泛词不在', () => {
  const toks = candidateTokens('昨晚学马実装了氷渡 香名江，「双人曲」也公布了，syngup 刷屏');
  assert.ok(toks.includes('香名江'));
  assert.ok(toks.includes('氷渡'), '中文段里的「氷渡」应成为候选');
  assert.ok(toks.some((t) => /双人曲/.test(t)));
  assert.ok(toks.some((t) => /syngup/i.test(t)));
  assert.ok(!toks.includes('今天'), '停用词不应成为候选');
});

test('提取：香名江実装场景（多人 × 重复 × 事件词）→ 一条事件，≤40 字', () => {
  const messages = [
    msg(NOW - 38 * H, '白铅鸮', '我听说学马那实装了某个意想不到的女人'),
    msg(NOW - 38 * H, '群友A', '香名江吧，千奈家那个女仆'),
    msg(NOW - 37 * H, '老大', '最有可能实装之人被不知哪来的女仆超车了，香名江实装了吗'),
    msg(NOW - 36 * H, '老大', '香名江 vs 0哈 笑死'),
    msg(NOW - 12 * H, '没有对象的野指针', '新角色实装公布前的41秒，香名江明白自己再也没有机会'),
    msg(NOW - 30 * H, '白铅鸮', '香名江的情报谁有'),
  ];
  const events = extractEventsForMessages(messages, { now: NOW, knownNames: [] });
  const hit = events.find((e) => e.text.includes('香名江'));
  assert.ok(hit, `应提取到香名江事件，实际：${events.map((e) => e.text).join(' / ')}`);
  assert.equal(hit.eventType, '实装');
  assert.ok(hit.participants >= 2, `参与人数应 ≥2，实际 ${hit.participants}`);
  assert.ok(hit.text.length <= MAX_EVENT_CHARS, `事件应 ≤40 字：${hit.text}（${hit.text.length}）`);
  assert.match(hit.text, /香名江实装（\d{2}-\d{2} \d{2}:\d{2}，\d+人）/);
});

test('过滤：自己发言/群昵称碎片/事件描述词/纯泛词都不算事件', () => {
  const messages = [
    msg(NOW - 2 * H, '角色昵称', '香名江实装了吗', { isSelf: true }),
    msg(NOW - 2 * H, '角色昵称', '香名江实装了吗', { isSelf: true }),
    msg(NOW - 1 * H, '群友A', '哦哦哦神秘在线装傻', {}),
    msg(NOW - 1 * H, '群友B', '哦哦哦神秘在线装傻', {}),
    msg(NOW - 1 * H, '群友A', '账号公布了吗', {}),
    msg(NOW - 1 * H, '群友B', '账号公布了吗', {}),
    msg(NOW - 1 * H, '群友A', '还想还想', {}),
    msg(NOW - 1 * H, '群友B', '还想还想', {}),
  ];
  const events = extractEventsForMessages(messages, { now: NOW });
  assert.equal(events.length, 0, `不应提取到事件，实际：${events.map((e) => e.text).join(' / ')}`);
});

test('排序：多人 > 单人；新 > 旧；真正规名优先', () => {
  const messages = [
    // 旧事件（多人）：甜甜圈
    msg(NOW - 40 * H, 'A', '甜甜圈要成精了吗'),
    msg(NOW - 40 * H, 'B', '甜甜圈成精了'),
    msg(NOW - 40 * H, 'C', '甜甜圈 甜甜圈'),
    msg(NOW - 40 * H, 'D', '甜甜圈该不会是群宠吧'),
    // 新事件（多人）：香名江实装
    msg(NOW - 2 * H, 'A', '香名江实装了吗'),
    msg(NOW - 2 * H, 'B', '香名江实装确定了吗'),
    msg(NOW - 2 * H, 'C', '香名江实装'),
  ];
  const events = extractEventsForMessages(messages, { now: NOW, knownNames: ['甜甜圈'] });
  assert.ok(events.length >= 2, `应至少 2 条，实际 ${events.map((e) => e.text).join(' / ')}`);
  assert.ok(events[0].time >= events[1].time, '新事件应排在旧事件前（同分时）');
  const xnj = events.find((e) => e.text.includes('香名江'));
  assert.ok(xnj, '应有香名江事件');
});

test('去重：同一专名同类型只留一条（含子串重叠）', () => {
  const messages = [
    msg(NOW - 5 * H, 'A', '香名江实装'),
    msg(NOW - 5 * H, 'B', '香名江实装'),
    msg(NOW - 5 * H, 'C', '冰渡香名江实装'),
    msg(NOW - 5 * H, 'D', '冰渡香名江实装'),
    msg(NOW - 5 * H, 'E', '冰渡香名江实装'),
  ];
  const events = extractEventsForMessages(messages, { now: NOW });
  const xnj = events.filter((e) => e.text.includes('香名江') || e.tokens.some((t) => t.includes('香名江')));
  assert.equal(xnj.length, 1, `应去重为 1 条，实际 ${xnj.map((e) => e.text).join(' / ')}`);
});

test('渲染：群只取本群、私聊含共享群事件；≤maxChars；无事件为空', () => {
  const messages = [
    msg(NOW - 2 * H, 'A', '香名江实装了吗'),
    msg(NOW - 2 * H, 'B', '香名江实装确定'),
    msg(NOW - 2 * H, 'C', '香名江实装'),
    { at: NOW - H, conversationKey: 'private:1000000001', sender: '私聊', text: '双人曲什么时候出', isSelf: false },
    { at: NOW - H, conversationKey: 'private:1000000001', sender: '私聊2', text: '双人曲公布了', isSelf: false },
  ];
  const data = extractRecentEvents(messages, { now: NOW });
  const groupLine = renderRecentEventsLine(data, 'group:860', 120);
  assert.match(groupLine, /【最近群里在聊】/);
  assert.match(groupLine, /香名江实装/);
  const privateLine = renderRecentEventsLine(data, 'private:1000000001', 120);
  assert.match(privateLine, /【最近群里\/私聊在聊】/);
  assert.ok(privateLine.includes('香名江') || privateLine.includes('双人曲'), '私聊应能取到共享群事件');
  assert.equal(renderRecentEventsLine(data, 'group:unknown', 120), '');
  const short = renderRecentEventsLine(data, 'group:860', 20);
  assert.ok(short.length <= 20, `应 ≤20 字，实际 ${short.length}`);
});

test('排序：多人 > 单人（同时间）；片假名/英文专名 > 普通中文词', () => {
  const t = NOW - 3 * H;
  const messages = [
    // 3 人事件（旧一点点）
    msg(t - H, 'A', '缶詰実装了吗'), msg(t - H, 'B', '缶詰実装确定'), msg(t - H, 'C', '缶詰実装'), msg(t - H, 'D', '缶詰実装'),
    // 2 人事件（同时间）
    msg(t, 'A', '学马实装了吗'), msg(t, 'B', '学马实装确定'), msg(t, 'C', '学马实装'),
    // 片假名专名（3 人）
    msg(t, 'C', 'ホシノ実装'), msg(t, 'D', 'ホシノ実装确定'), msg(t, 'E', 'ホシノ実装'),
  ];
  const events = extractEventsForMessages(messages, { now: NOW, knownNames: ['学马', '缶詰'] });
  const can = events.find((e) => e.tokens.includes('缶詰'));
  const xm = events.find((e) => e.tokens.includes('学马'));
  const hs = events.find((e) => e.tokens.includes('ホシノ'));
  assert.ok(can && xm, '多条事件应都提取到');
  assert.ok(can.score > xm.score, '3 人事件应比 2 人事件分高（多人 > 单人）');
  if (hs && xm) assert.ok(hs.score > xm.score, '片假名专名应比普通中文词分高');
});

test('B+：别名表与锚点触发（有锚点才注入、无锚点空、热度兜底 1 条）', () => {
  const aliases = aliasesFor('香名江');
  for (const a of ['香名江', '名江', '氷渡', 'ひめ']) assert.ok(aliases.includes(a), `别名应含 ${a}`);
  assert.ok(aliases.length <= 8);

  const messages = [
    msg(NOW - 2 * H, 'A', '氷渡香名江实装了吗'),
    msg(NOW - 2 * H, 'B', '香名江实装确定'),
    msg(NOW - 2 * H, 'C', '香名江'),
    msg(NOW - 2 * H, 'D', '香名江实装'),
    // 无锚点热度兜底事件
    msg(NOW - 3 * H, 'A', '甜甜圈要成精了吗'), msg(NOW - 3 * H, 'B', '甜甜圈成精'),
    msg(NOW - 3 * H, 'C', '甜甜圈群宠'), msg(NOW - 3 * H, 'D', '甜甜圈'),
  ];
  const data = extractRecentEvents(messages, { now: NOW });
  const ev = (data.conversations['group:860']?.events || []).find((e) => e.text.includes('香名江'));
  assert.ok(ev, '应提取到香名江事件');
  assert.ok(Array.isArray(ev.aliases) && ev.aliases.includes('氷渡'), '事件条目应带 aliases[]');
  assert.equal(ev.active, true, '2h 内提出的事件应 active');

  // 有锚点：氷渡香名江 → 注入
  const line = renderRecentEventsLineFor(data, 'group:860', '氷渡香名江实装了吗', 120);
  assert.match(line, /香名江/);
  // 无锚点但满足热度兜底（4 人 × 6h 内 3 次）→ 最多 1 条背景
  const hotLine = renderRecentEventsLineFor(data, 'group:860', '今天吃什么', 120);
  assert.match(hotLine, /香名江|甜甜圈/, '热度兜底应给 1 条背景');
  assert.ok(hotLine.split('；').length <= 2, '兜底最多 1 条');
  // 无锚点、且事件都超过 6h（heat 为 0）→ 空
  const oldOnly = extractRecentEvents(messages.map((m) => ({ ...m, at: m.at - 8 * H })), { now: NOW });
  assert.equal(renderRecentEventsLineFor(oldOnly, 'group:860', '今天吃什么', 120), '');
  // 群不注入私聊事件 / 空会话空
  assert.equal(renderRecentEventsLineFor(data, 'group:unknown', '香名江', 120), '');
});

test('图片唤醒兜底：严格门槛 + 限频 + 私聊不启用', () => {
  const makeData = ({ participants = 5, ageH = 1, token = '香气江', aliases = ['香气江', '氷渡'] } = {}) => ({
    conversations: {
      'group:860': { events: [{ text: `${token}实装（11-09 08:00，${participants}人）`, tokens: [token], aliases, eventType: '实装', active: true, participants, time: NOW - ageH * H, heat6h: 0, score: 20 }] },
    },
    sharedEvents: [],
  });
  const text = '（图片）'; // 无文本锚点

  // 正常注入
  assert.match(imageFallbackDecision({ data: makeData(), convKey: 'group:860', text, now: NOW }).line, /香气江/);
  // 私聊不启用
  assert.equal(imageFallbackDecision({ data: makeData(), convKey: 'private:1', text, now: NOW }).line, '');
  // participants 不足
  assert.equal(imageFallbackDecision({ data: makeData({ participants: 3 }), convKey: 'group:860', text, now: NOW }).line, '');
  // 事件超过 12h
  assert.equal(imageFallbackDecision({ data: makeData({ ageH: 13 }), convKey: 'group:860', text, now: NOW }).line, '');
  // 4h 内已经兜底过一次
  assert.equal(imageFallbackDecision({ data: makeData(), convKey: 'group:860', text, now: NOW, lastFallbackAt: NOW - 1 * H }).line, '');
  assert.match(imageFallbackDecision({ data: makeData(), convKey: 'group:860', text, now: NOW, lastFallbackAt: NOW - 5 * H }).line, /香气江/);
  // 本轮有文本锚点 → 走主路径，不走图片兜底
  const anchorLine = recentEventsLineFor('氷渡香气江实装了吗', 'group:860', 120, { data: makeData(), imageWake: true, now: NOW });
  assert.match(anchorLine, /香气江/);
  assert.equal(imageFallbackDecision({ data: makeData(), convKey: 'group:860', text: '氷渡香气江', now: NOW }).reason, 'has-anchor');
  // 参数常量
  assert.equal(IMAGE_FALLBACK.minParticipants, 4);
  assert.equal(IMAGE_FALLBACK.maxEventAgeH, 12);
  assert.equal(IMAGE_FALLBACK.cooldownH, 4);
});

test('fresh 过滤：锚点只认 active 且 12h 内被提到的事件', () => {
  const ev = (time, participants = 4) => ({ text: '香名江实装（11-08 21:14，4人）', tokens: ['香名江'], aliases: ['香名江'], active: time > NOW - 24 * H, participants, time, heat6h: 0, score: 20 });
  const freshData = { conversations: { 'group:1': { events: [ev(NOW - 2 * H)] } }, sharedEvents: [] };
  const staleData = { conversations: { 'group:1': { events: [ev(NOW - 13 * H)] } }, sharedEvents: [] };
  assert.equal(eventIsFresh(ev(NOW - 2 * H), NOW), true);
  assert.equal(eventIsFresh(ev(NOW - 13 * H), NOW), false);
  assert.match(renderRecentEventsLineFor(freshData, 'group:1', '香名江在聊什么', 120, { now: NOW }), /香名江/);
  assert.equal(renderRecentEventsLineFor(staleData, 'group:1', '香名江在聊什么', 120, { now: NOW }), '', '旧事件不应被锚点注入');
  assert.equal(FRESH_EVENT_HOURS, 12);
});

test('计划/约定模板：卡池日期、双人曲（可来自她自己的发言）', () => {
  const messages = [
    { at: NOW - 2 * H, conversationKey: 'group:860', sender: '她', isSelf: true, text: '刚把 game8 那页翻完了，下回卡池 11/16 更新，正好撞上 2.5 周年' },
    { at: NOW - 2 * H, conversationKey: 'group:860', sender: '群友A', isSelf: false, text: '11/16 卡池是什么' },
    { at: NOW - 3 * H, conversationKey: 'group:860', sender: '她', isSelf: true, text: '上次问你的双人曲还没回我呢（ 学马的双人曲专辑第二弹' },
    { at: NOW - 3 * H, conversationKey: 'group:860', sender: '群友A', isSelf: false, text: '双人曲是指哪个？我没对上号' },
  ];
  const events = extractEventsForMessages(messages, { now: NOW, knownNames: [] });
  const pool = events.find((e) => e.eventType === '卡池' || (e.tokens || []).some((t) => t.includes('卡池')));
  assert.ok(pool, `应提取到卡池计划事件，实际：${events.map((e) => e.text).join(' / ')}`);
  assert.ok(pool.aliases.includes('11/16') || pool.aliases.some((a) => a.includes('11/16')), '卡池别名应含 11/16');
  assert.ok(pool.planned === true, '应标记 planned');
  const duet = events.find((e) => (e.tokens || []).some((t) => t.includes('双人曲')));
  assert.ok(duet, '应提取到双人曲事件');
  const data = extractRecentEvents(messages, { now: NOW });
  const line = renderRecentEventsLineFor(data, 'group:860', '双人曲专辑第二弹什么时候', 120, { now: NOW });
  assert.match(line, /双人曲/);
});

test('首轮兜底：最近对话锚点 + 类型权重（不用 age 时间窗）', () => {
  const make = (participants, time, token = '香名江', type = '实装') => ({ text: `${token}实装（11-09 08:00，${participants}人）`, tokens: [token], aliases: [token], eventType: type, active: true, participants, time, heat6h: 0, score: 20, planned: false });
  const data = {
    conversations: {
      'group:860': { events: [make(3, NOW - 2 * H, '香气江'), make(4, NOW - 10 * H, '香名江')] },
    },
    sharedEvents: [],
  };
  // 最近 10 条消息里提到 香名江（10h 前的事件也算：不用 age 时间窗）
  const anchorRows = [{ at: NOW - 30 * 60000, text: '昨晚香名江实装了吗' }];
  const d = firstTurnFallbackDecision({ data, convKey: 'group:860', now: NOW, recentMessages: anchorRows });
  assert.equal(d.reason, 'inject');
  assert.match(d.line, /香名江/);
  // 最近消息里没有锚点 → 不注入（即使事件 active/fresh）
  const noAnchor = firstTurnFallbackDecision({ data, convKey: 'group:860', now: NOW, recentMessages: [{ at: NOW - 60000, text: '今天吃什么' }] });
  assert.equal(noAnchor.line, '');
  assert.equal(noAnchor.reason, 'no-recent-anchor');
  // 最近 2 小时消息也算锚点（不在最近 10 条里但 2h 内）
  const twoHour = [{ at: NOW - 90 * 60000, text: '香名江群里在聊' }, ...Array.from({ length: 12 }, (_, i) => ({ at: NOW - (20 - i) * 60000, text: `闲聊${i}` }))];
  assert.match(firstTurnFallbackDecision({ data, convKey: 'group:860', now: NOW, recentMessages: twoHour }).line, /香名江/);
  // participants 不足 3 → 不进首轮
  const few = { conversations: { 'group:860': { events: [make(2, NOW - 2 * H)] } }, sharedEvents: [] };
  assert.equal(firstTurnFallbackDecision({ data: few, convKey: 'group:860', now: NOW, recentMessages: anchorRows }).line, '');
});

test('计划/约定模板：卡池日期、双人曲（可来自她自己的发言）', () => {
  const messages = [
    { at: NOW - 2 * H, conversationKey: 'group:860', sender: '她', isSelf: true, text: '刚把 game8 那页翻完了，下回卡池 11/16 更新，正好撞上 2.5 周年' },
    { at: NOW - 2 * H, conversationKey: 'group:860', sender: '群友A', isSelf: false, text: '11/16 卡池是什么' },
    { at: NOW - 3 * H, conversationKey: 'group:860', sender: '她', isSelf: true, text: '上次问你的双人曲还没回我呢（ 学马的双人曲专辑第二弹' },
    { at: NOW - 3 * H, conversationKey: 'group:860', sender: '群友A', isSelf: false, text: '双人曲是指哪个？我没对上号' },
  ];
  const events = extractEventsForMessages(messages, { now: NOW, knownNames: [] });
  const pool = events.find((e) => e.eventType === '卡池' || (e.tokens || []).some((t) => t.includes('卡池')));
  assert.ok(pool, `应提取到卡池计划事件，实际：${events.map((e) => e.text).join(' / ')}`);
  assert.ok(pool.aliases.includes('11/16') || pool.aliases.some((a) => a.includes('11/16')), '卡池别名应含 11/16');
  assert.ok(pool.planned === true, '应标记 planned');
  const duet = events.find((e) => (e.tokens || []).some((t) => t.includes('双人曲')));
  assert.ok(duet, '应提取到双人曲事件');
  const data = extractRecentEvents(messages, { now: NOW });
  const line = renderRecentEventsLineFor(data, 'group:860', '双人曲专辑第二弹什么时候', 120, { now: NOW });
  assert.match(line, /双人曲/);
});

test('首轮/图片类型权重：同等参与者时 实装 > 梗；图片兜底每天 1 次', () => {
  const ev = (token, type, score, participants = 4) => ({ text: `${token}${type}（11-09 08:00，${participants}人）`, tokens: [token], aliases: [token], eventType: type, active: true, participants, time: NOW - 2 * H, heat6h: 0, score, planned: false });
  const data = { conversations: { 'group:860': { events: [ev('大小姐', '梗', 20.6), ev('香名江', '实装', 20.2)] } }, sharedEvents: [] };
  const first = firstTurnFallbackDecision({ data, convKey: 'group:860', now: NOW, recentMessages: [{ at: NOW - 60000, text: '香名江和大小姐都在聊' }] });
  assert.match(first.line, /香名江/, `实装应优先于梗：${first.line}`);
  const img = imageFallbackDecision({ data, convKey: 'group:860', text: '（图片）', now: NOW });
  assert.match(img.line, /香名江/);
  assert.equal(imageFallbackDecision({ data, convKey: 'group:860', text: '（图片）', now: NOW, lastFallbackDay: new Date(NOW).toLocaleDateString('sv-SE') }).reason, 'daily-limit');
});

test('首轮补丁 A：静默 ≥2h 免锚点；静默 <2h 必须对话锚点', () => {
  const ev = { text: '香名江实装（11-09 08:00，4人）', tokens: ['香名江'], aliases: ['香名江'], eventType: '实装', active: true, participants: 4, time: NOW - 10 * H, heat6h: 0, score: 20, planned: false };
  const data = { conversations: { 'group:860': { events: [ev] } }, sharedEvents: [] };
  // 静默 3h、最近消息没有锚点 → 免锚点，注入（覆盖 07:40 隔夜首轮）
  const silent = firstTurnFallbackDecision({ data, convKey: 'group:860', now: NOW, recentMessages: [{ at: NOW - 3 * H, text: '今天吃什么' }] });
  assert.equal(silent.reason, 'inject');
  assert.equal(silent.anchorRequired, false);
  // 静默 10 分钟、没有锚点 → 不注入（防 00:42 常服噪音）
  const active = firstTurnFallbackDecision({ data, convKey: 'group:860', now: NOW, recentMessages: [{ at: NOW - 10 * 60000, text: '今天吃什么' }] });
  assert.equal(active.line, '');
  assert.equal(active.reason, 'no-recent-anchor');
  assert.equal(active.anchorRequired, true);
});

test('首轮新鲜度：免锚点路径也排除 >12h 旧事件（16.1h 旧梗）', () => {
  const old = { text: '招牌词梗（11-03 15:10，4人）', tokens: ['招牌词'], aliases: ['招牌词'], eventType: '梗', active: true, participants: 4, time: NOW - 16.1 * H, heat6h: 0, mentions24h: 4, score: 20, planned: false };
  const fresh = { text: '香名江实装（11-08 21:14，3人）', tokens: ['香名江'], aliases: ['香名江'], eventType: '实装', active: true, participants: 3, time: NOW - 10.4 * H, heat6h: 0, mentions24h: 4, score: 20, planned: false };
  const data = { conversations: { 'group:860': { events: [old, fresh] } }, sharedEvents: [] };
  // 静默 3h、无锚点 → 旧梗被 fresh 过滤掉，只剩 10.4h 香名江
  const d = firstTurnFallbackDecision({ data, convKey: 'group:860', now: NOW, recentMessages: [{ at: NOW - 3 * H, text: '今天吃什么' }] });
  assert.match(d.line, /香名江/);
  const onlyOld = { conversations: { 'group:860': { events: [old] } }, sharedEvents: [] };
  assert.equal(firstTurnFallbackDecision({ data: onlyOld, convKey: 'group:860', now: NOW, recentMessages: [{ at: NOW - 3 * H, text: '今天吃什么' }] }).line, '');
});
