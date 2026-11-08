// 每日记忆整理 v2（src/memory-digest.js）单测：事件笔记、来源、去统计句、窗口/上限。
// 2026-11-08（task-12）。纯函数测试，不读盘不写盘。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDailyDigestItems } from '../src/memory-digest.js';

const NOW = Date.parse('2026-11-08T20:00:00+08:00');
const STAT_RE = /一共\s*\d+\s*句，你自己说了\s*\d+\s*句|里聊到一些零碎的话/;

function row(overrides = {}) {
  return JSON.stringify({
    at: new Date(NOW - 60_000).toISOString(),
    platform: 'qq',
    kind: 'group',
    sender: '群友A',
    senderId: '1001',
    groupId: '1000000002',
    isOwner: false,
    isSelf: false,
    private: false,
    direct: false,
    conversationKey: 'group:1000000002',
    text: '普通群聊一句话',
    ...overrides,
  });
}

test('digest v2：不再产出统计句，只产出带来源的具体事件笔记', () => {
  const inboxLines = [
    row({ text: '群里今天聊得很杂，一共 58 句，你自己说了 76 句。' }), // 统计句必须被跳过
    row({ text: '明天晚上一起看直播吧，说好了啊', isOwner: true, sender: '主人' }), // 约定
    row({ text: '这个联动海报我翻到啦，明天发群里', isSelf: true }), // 她自己的话，不算事件
    row({ text: '她把联动海报画出来了', isSelf: true, action: true }), // 她做过的动作
    row({ text: '哈哈哈', sender: '群友B' }), // 纯语气词，不该进引用
    row({ text: '私聊里说下回卡池 11/16 更新', conversationKey: 'private:1000000001', private: true, isOwner: true, sender: '主人' }),
  ];
  const items = buildDailyDigestItems({ inboxLines, now: NOW });
  assert.ok(items.length >= 1);
  assert.ok(items.length <= 5);
  assert.ok(!items.some((it) => STAT_RE.test(it.text)), 'digest 笔记不能含统计句');
  assert.ok(!items.some((it) => it.text.includes('哈哈哈')), '纯语气词不该作为事件引用');
  for (const it of items) {
    assert.ok(it.originKind === 'private' || it.originKind === 'group', '每条笔记都要有来源');
    assert.ok(it.conversationKey, '每条笔记都要有会话 key');
    assert.equal(it.importance, 60);
    assert.ok(!it.tags.includes('统计'));
  }
  const priv = items.find((it) => it.originKind === 'private');
  assert.ok(priv, '应有私聊事件笔记');
  assert.match(priv.text, /11\/16/);
  assert.doesNotMatch(priv.text, /群里今天聊得/, '私聊笔记不应混进群聊统计');
  const grp = items.find((it) => it.originKind === 'group');
  assert.ok(grp, '应有群事件笔记');
  assert.match(grp.text, /说好了啊/);
  assert.ok(/她做过「/.test(grp.text), '她做过的动作应记成事件');
});

test('digest v2：私聊没有 inbox 原话时用 synced-facts 兜底', () => {
  const syncedFacts = [
    { at: NOW - 3600_000, who: 'he', text: '以后每天都要早点睡' },
    { at: NOW - 1800_000, who: 'me', text: '好，我尽量' },
    { at: NOW - 900_000, who: 'he', text: '嗯' }, // 太短，不用
  ];
  const items = buildDailyDigestItems({ inboxLines: [], syncedFacts, now: NOW });
  assert.equal(items.length, 1);
  assert.equal(items[0].originKind, 'private');
  assert.match(items[0].text, /他说过「以后每天都要早点睡」/);
  assert.doesNotMatch(items[0].text, /他说过「嗯」/);
});

test('digest v2：窗口外/未来时间/超过 5 条的上限都收住', () => {
  const inboxLines = [
    row({ at: new Date(NOW - 40 * 3600_000).toISOString(), text: '窗口外的旧消息，说好了明天见' }),
    row({ at: new Date(NOW + 3600_000).toISOString(), text: '未来时间不该进' }),
    ...Array.from({ length: 8 }, (_, i) => row({
      at: new Date(NOW - (i + 1) * 60_000).toISOString(),
      text: `第 ${i} 条有约定的消息，说好了以后一起看${i}`,
      conversationKey: `group:${800000 + i}`,
      groupId: String(800000 + i),
      sender: `群友${i}`,
    })),
  ];
  const items = buildDailyDigestItems({ inboxLines, now: NOW });
  assert.ok(items.length <= 5, `最多 5 条，实际 ${items.length}`);
  assert.ok(!items.some((it) => it.text.includes('窗口外')), '窗口外的消息不应进笔记');
  assert.ok(!items.some((it) => it.text.includes('未来时间')), '未来时间的消息不应进笔记');
});

test('digest v2：群事件与私聊事件分属不同笔记（不缝合）', () => {
  const inboxLines = [
    row({ text: '群里在聊 2027 年的新企划，说好了到时候一起看', conversationKey: 'group:1000000002', sender: '群友A' }),
    row({ text: '私聊里答应你明天早点睡', conversationKey: 'private:1000000001', private: true, isOwner: true, sender: '主人' }),
  ];
  const items = buildDailyDigestItems({ inboxLines, now: NOW });
  const grp = items.find((it) => it.originKind === 'group');
  const priv = items.find((it) => it.originKind === 'private');
  assert.ok(grp && priv);
  assert.doesNotMatch(grp.text, /明天早点睡/, '群笔记不能包含私聊内容');
  assert.doesNotMatch(priv.text, /2027/, '私聊笔记不能包含群聊内容');
});
