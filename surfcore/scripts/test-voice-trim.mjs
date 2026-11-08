// voice-trim 提示文案测试（2026-11-08，task-11）
//
// 背景：老大反馈一句带价钱的报价被 [voice-fact] 拦下后，她按旧提示「挑一半说就行」
// 只留后半，发出「这价那还挑什么」，群里不懂「这价」是多少；long 拦截重写后也有指代悬空。
//
// 这个测试只校验「提示文本」与「判据没被改坏」：
//   A. 新提示必须包含：两种安全改法、指代/前提要说清、压完自检；
//   B. 旧文案「挑一半说就行」不许回来；
//   C. 判据阈值不许被改动（防止「只改提示」时顺手动了 maxChars/minChars）。
//
// 用法：node scripts/test-voice-trim.mjs
import assert from 'node:assert/strict';
import {
  VOICE_TRIM_DEFAULTS, FACT_COMMENT_DEFAULTS, __test,
} from '../src/voice-trim.js';

const {
  shouldTrim, trimHint, looksLikeFactComment, factCommentHint,
} = __test;

let pass = 0;
const ok = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}\n     ${String(error?.message ?? error)}`);
    process.exitCode = 1;
  }
};

const includesAll = (text, needles) => {
  const missing = needles.filter((n) => !String(text).includes(n));
  assert.equal(missing.length, 0, `缺：${missing.join(' / ')}`);
};

// ── A. 新提示内容 ────────────────────────────────────────────────
ok('trimHint 包含「独立看懂」要求', () => {
  includesAll(trimHint({ chars: 31, sentences: 1 }), ['独立看懂']);
});
ok('trimHint 要求指代有落脚点', () => {
  includesAll(trimHint({ chars: 31, sentences: 1 }), ['指代', '落脚点']);
});
ok('trimHint 含「压完自检：没看前文的人能看懂吗」', () => {
  includesAll(trimHint({ chars: 31, sentences: 1 }), ['压完自己读一遍', '没看到前文的人']);
});
ok('trimHint 含「补不出前提就别压/换一句」', () => {
  includesAll(trimHint({ chars: 31, sentences: 1 }), ['补不出前提', '不压', '换一句']);
});
ok('trimHint 仍显示字数/句数', () => {
  includesAll(trimHint({ chars: 31, sentences: 1 }), ['31 字']);
  includesAll(trimHint({ chars: 40, sentences: 3 }), ['40 字、3 句']);
});

ok('factCommentHint 写明两种安全改法', () => {
  includesAll(factCommentHint(), ['只留前半', '只留后半']);
});
ok('factCommentHint 要求只留后半时补主语/说清指代', () => {
  includesAll(factCommentHint(), ['把指代说清', '「这价」要写成「15一只的价」']);
});
ok('factCommentHint 含「补不出前提就换一句」', () => {
  includesAll(factCommentHint(), ['补不出前提', '换一句']);
});
ok('factCommentHint 含正反例（15一只 / 这价直接一笼上汽）', () => {
  includesAll(factCommentHint(), ['✅「15一只，那还挑什么」', '❌「这价直接一笼上汽」']);
});
ok('factCommentHint 含「压完自检」', () => {
  includesAll(factCommentHint(), ['压完自己读一遍', '不知道前一句的人']);
});

// ── B. 旧文案不许回来 ─────────────────────────────────────────────
ok('旧文案「挑一半说就行」已删除', () => {
  assert.equal(trimHint({ chars: 31, sentences: 1 }).includes('挑一半说就行'), false);
  assert.equal(factCommentHint().includes('挑一半说就行'), false);
});

// ── C. 提示长度（别把提示写成小作文） ─────────────────────────────
ok('两条提示都 ≤ 400 字符', () => {
  assert.ok(trimHint({ chars: 31, sentences: 1 }).length <= 400, `trimHint ${trimHint({ chars: 31, sentences: 1 }).length}`);
  assert.ok(factCommentHint().length <= 400, `factCommentHint ${factCommentHint().length}`);
});

// ── D. 判据/阈值没被改（回归保护） ───────────────────────────────
ok('VOICE_TRIM_DEFAULTS 阈值未变（28 字 / 3 句）', () => {
  assert.equal(VOICE_TRIM_DEFAULTS.minChars, 28);
  assert.equal(VOICE_TRIM_DEFAULTS.minSentences, 3);
});
ok('FACT_COMMENT_DEFAULTS.maxChars 未变（30）', () => {
  assert.equal(FACT_COMMENT_DEFAULTS.maxChars, 30);
});
ok('原始事件句仍会被判成「事实+评论」（判据没坏）', () => {
  assert.equal(looksLikeFactComment('15一只，那还挑什么，直接一笼上汽（'), true);
});
ok('只留后半的「这价直接一笼上汽（」不会被 fact 判据误拦', () => {
  assert.equal(looksLikeFactComment('这价直接一笼上汽（'), false);
});
ok('long 判据：31 字群消息仍会拦（reason=long）', () => {
  const long = '上午还在盼着11/16的卡池，下午就看到2027的联动了（';
  assert.ok([...long.replace(/\s+/g, '')].length > 28, '样本需 >28 字');
  const r = shouldTrim(long, { key: 'group:1000000002' });
  assert.equal(r.trim, true);
  assert.equal(r.reason, 'long');
});
ok('long 判据：短句不拦 / 私聊不拦', () => {
  assert.equal(shouldTrim('这价直接一笼上汽（', { key: 'group:1' }).trim, false);
  const long = '上午还在盼着11/16的卡池，下午就看到2027的联动了（';
  assert.equal(shouldTrim(long, { key: 'private:1000000001' }).trim, false);
});

console.log(`\n${pass} 项通过${process.exitCode ? '，有失败' : '，全部通过 ✅'}`);
