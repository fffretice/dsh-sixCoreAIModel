#!/usr/bin/env node
// task-20 M1 单测：跨会话发送护栏（owner 私聊豁免 / crossKey 显式确认 / 同会话放行）
// 用法：node scripts/test-crosskey-guard.mjs  退出码 0=PASS / 1=FAIL
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.SURFCORE_DIR || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const MCP = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
let ok = 0; const cases = [];
const check = (name, pass, got = '') => { cases.push({ name, pass, got }); if (pass) ok += 1; };

// ── 静态断言 ──
check('S1 token→会话 helper 存在', /const agentTokenOwnerKey = \(token\) =>/.test(SRC));
check('S2 跨会话护栏 helper 存在', /const crossSendGuard = \(targetKey, token, crossKeyFlag\) =>/.test(SRC));
check('S3 审计 helper 存在且写 [跨会话] 日志', /const auditCrossSend = \(targetKey, guard, summary\) =>/.test(SRC) && /\[跨会话\]/.test(SRC));
check('S4 owner 私聊豁免逻辑存在', /target === ownerPrivateKey\(\)\) return \{ allow: true, cross: true, exempt: true/.test(SRC));
check('S5 发送端点接入 ≥6 处', (SRC.match(/const crossGuard = crossSendGuard\(key, req\.headers\['x-agent-token'\], body\.crossKey === true\)/g) || []).length >= 6, String((SRC.match(/crossSendGuard\(key/g) || []).length));
check('S6 MCP qq_send_message 支持 crossKey', /async \(\{ key, token, messages, replyToMessageId, atUserId, gapMode, gapMs, gaps, crossKey \}\)/.test(MCP) && /crossKey: true/.test(MCP));
check('S7 MCP qq_send_burst 支持 crossKey', /async \(\{ groupId, token, messages, crossKey \}\)/.test(MCP));

// ── 抽 helper ──
function extractFunction(src, name) {
  const start = src.indexOf(`const ${name} = (`);
  if (start < 0) return null;
  const end = src.indexOf('\n    };', start);
  if (end < 0) return null;
  return src.slice(start, end + '\n    };'.length);
}
const ownerKeyCode = extractFunction(SRC, 'agentTokenOwnerKey');
const guardCode = extractFunction(SRC, 'crossSendGuard');
const make = (sessions) => new Function('tokenEq', 'socialV2', 'canonicalV2Key', 'ownerPrivateKey',
  `${ownerKeyCode}\n${guardCode}\nreturn { agentTokenOwnerKey, crossSendGuard };`)(
  (a, b) => a === b,
  { conversations: new Map(Object.entries(sessions)) },
  (k) => String(k ?? ''),
  () => 'private:999'
);
const g = make({
  'group:111': { agentToken: 'tokA' },
  'group:222': { agentToken: 'tokC' },
  'private:999': { agentToken: 'tokB' }
});

// ── 行为断言 ──
{
  const r = g.crossSendGuard('group:111', 'tokA', false);
  check('B1 同会话发送放行', r.allow === true && r.cross === false);
}
{
  const r = g.crossSendGuard('private:999', 'tokA', false);
  check('B2 群→owner私聊：豁免放行（汇报路径不断）', r.allow === true && r.exempt === true && r.source === 'group:111');
}
{
  const r = g.crossSendGuard('group:222', 'tokB', false);
  check('B3 私聊→群 未带 crossKey：拒绝', r.allow === false && /跨会话发送被拦截/.test(r.reason || '') && /crossKey:true/.test(r.reason || ''));
}
{
  const r = g.crossSendGuard('group:222', 'tokB', true);
  check('B4 私聊→群 带 crossKey:true：放行且审计', r.allow === true && r.audited === true);
}
{
  const r = g.crossSendGuard('group:222', 'tokA', true);
  check('B5 群A→群B 带 crossKey:true：放行', r.allow === true && r.cross === true && r.source === 'group:111');
}
{
  const r = g.crossSendGuard('group:222', 'tokUnknown', false);
  check('B6 未知 token（非会话调用/管理端）：放行不审计', r.allow === true && r.cross === false);
}
{
  const r = g.crossSendGuard('private:999', 'tokB', false);
  check('B7 私聊→自己私聊：正常放行', r.allow === true && r.cross === false);
}

const pass = ok === cases.length;
console.log(`CROSSKEY-GUARD TEST ${pass ? 'PASS' : 'FAIL'}（${ok}/${cases.length}）`);
for (const c of cases) console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}${c.pass || !c.got ? '' : ` · got ${c.got}`}`);
process.exitCode = pass ? 0 : 1;
