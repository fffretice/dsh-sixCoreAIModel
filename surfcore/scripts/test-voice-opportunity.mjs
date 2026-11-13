#!/usr/bin/env node
// 2026-11-09 单测：语音机会（私聊/群条件、频控、文案软、私聊限定、群 allowlist/shadow）+ V2 路由静态
import fs from 'node:fs';
import path from 'node:path';
import { detectVoiceScene, voiceHintGate, voiceSendBlock, voiceOpportunityLine, recordVoiceHint, recordVoiceSent, normalizeOpp, groupAtmosphereLight, DEFAULT_VOICE_OPPORTUNITY, localDayKey } from '../src/voice-opportunity.js';
import { ttsKey, synthesizeToFile } from '../src/voice-tts.js';
import os from 'node:os';

const ROOT = process.env.SURFCORE_DIR || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
let ok = 0; const cases = [];
const check = (name, pass, got = '') => { cases.push({ name, pass, got }); if (pass) ok += 1; };
const OWNER = 'private:1000000001';
const at = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime(); };
const self = (text) => ({ isSelf: true, text });
const theirs = (text, extra = {}) => ({ isSelf: false, text, ...extra });
const mood = (energy = 0.7, m = 0.5, social = 0.5) => ({ dims: { energy, mood: m, social } });
const cfg = DEFAULT_VOICE_OPPORTUNITY;
const detect = (opts) => detectVoiceScene({ ownerKey: OWNER, cfg, ...opts });

// 1) 私聊场景
check('P1 22:45「晚安」→ late-night', detect({ key: OWNER, now: at(22, 45), mood: mood(), recentMessages: [self('晚安啦')] }).scene === 'late-night');
check('P2 energy<0.35 短句 → low-energy', detect({ key: OWNER, now: at(15, 0), mood: mood(0.2), recentMessages: [self('嗯好')] }).scene === 'low-energy');
check('P3 情绪高 + 短句 → emotion-high', detect({ key: OWNER, now: at(15, 0), mood: mood(0.8, 0.7, 0.7), recentMessages: [self('好耶')] }).scene === 'emotion-high');
check('P4 23:30 后不出现', detect({ key: OWNER, now: at(23, 40), mood: mood(), recentMessages: [self('晚安')] }).scope === '');
check('P5 非 owner 私聊不出现', detect({ key: 'private:999', now: at(22, 45), mood: mood(), recentMessages: [self('晚安')] }).scope === '');
check('P6 长回复不出现（>15 字）', detect({ key: OWNER, now: at(15, 0), mood: mood(0.8, 0.7, 0.7), recentMessages: [self('这是一句特别特别长的话超过十五个字了吧')] }).scope === '');
// 2) 群聊场景（更严）
const lightRecent = [theirs('[图片]', { hasMedia: true }), theirs('哈哈哈哈'), theirs('草'), theirs('这个梗好'), selves()];
function selves() { return { isSelf: true, text: '好耶' }; }
check('G1 860 + 心情好 + 轻松 + 短句 → group', detect({ key: 'group:1000000002', now: at(15, 0), mood: mood(0.8, 0.8, 0.8), recentMessages: lightRecent }).scope === 'group');
check('G2 心情不够 → 无', detect({ key: 'group:1000000002', now: at(15, 0), mood: mood(0.5, 0.5, 0.5), recentMessages: lightRecent }).scope === '');
check('G3 氛围沉重/严肃 → 无', detect({ key: 'group:1000000002', now: at(15, 0), mood: mood(0.8, 0.8, 0.8), recentMessages: [theirs('别吵了'), theirs('这是严肃的事'), selves()] }).scope === '');
check('G4 话题敏感（隐私/地址）→ 无', detect({ key: 'group:1000000002', now: at(15, 0), mood: mood(0.8, 0.8, 0.8), recentMessages: [theirs('别把地址发群里'), selves()] }).scope === '');
check('G5 其他群 650 条件满足 → shadow-group（不注入）', detect({ key: 'group:1000000004', now: at(15, 0), mood: mood(0.8, 0.8, 0.8), recentMessages: lightRecent }).scope === 'shadow-group');
check('G6 回复代理太长（>12）→ 无', detect({ key: 'group:1000000002', now: at(15, 0), mood: mood(0.8, 0.8, 0.8), recentMessages: [...lightRecent, self('这句话明显超过十二个字了吧')] }).scope === '');
// 3) 频控（hint gate / send block）
const today = localDayKey();
const st0 = {};
const stSent1 = { voiceOpportunity: { hinted: [], sent: [{ at: Date.now(), scope: 'group', key: 'group:1000000004' }] } };
const stSent2 = { voiceOpportunity: { hinted: [], sent: [{ at: Date.now(), scope: 'private', key: OWNER }, { at: Date.now(), scope: 'group', key: 'group:1000000004' }] } };
const all = (entries) => entries;
check('F1 无发送 → 可提示', voiceHintGate({ key: OWNER, scene: 'late-night', now: at(22, 45), state: st0, allStates: [], cfg }).ok === true);
check('F2 同场景当天已提示 → 不可', voiceHintGate({ key: OWNER, scene: 'late-night', now: at(22, 45), state: { voiceOpportunity: { hinted: [{ at: Date.now(), scene: 'late-night' }], sent: [] } }, allStates: [], cfg }).ok === false);
check('F3 私聊不受全局满影响（仍可提示）', voiceHintGate({ key: OWNER, scene: 'low-energy', now: at(15, 0), state: stSent2, allStates: all([{ key: 'group:1000000004', state: stSent1 }]), cfg }).ok === true);
check('F3b 群总额已 2 条 → 群提示不可', voiceHintGate({ key: 'group:1000000002', scene: 'group-light', now: at(15, 0), state: {}, allStates: all([{ key: 'group:1000000004', state: stSent2 }]), cfg }).ok === false);
check('F4 群今天已发 1 条 → 群不可', voiceHintGate({ key: 'group:1000000002', scene: 'group-light', now: at(15, 0), state: {}, allStates: all([{ key: 'group:1000000004', state: stSent1 }]), cfg }).ok === false);
check('F5 同群 1 天前发过（<3 天）→ 不可', voiceHintGate({ key: 'group:1000000002', scene: 'group-light', now: at(15, 0), state: { voiceOpportunity: { hinted: [], sent: [{ at: Date.now() - 86400e3, scope: 'group', key: 'group:1000000002' }] } }, allStates: [], cfg }).ok === false);
check('F6 私聊连发 3 条不被拦（无日上限）', voiceSendBlock({ key: OWNER, now: Date.now(), state: { voiceOpportunity: { hinted: [], sent: [{ at: Date.now(), scope: 'private', key: OWNER }, { at: Date.now(), scope: 'private', key: OWNER }, { at: Date.now(), scope: 'private', key: OWNER }] } }, allStates: [], cfg }) === null);
check('F6b 群总额 2 条 → 群第 2 条被拦', /群语音总额/.test(voiceSendBlock({ key: 'group:1000000002', now: Date.now(), state: {}, allStates: [{ key: 'group:1000000004', state: stSent2 }], cfg }) || ''));
check('F7 群跨群 1 条 → 发送被拦', /群语音/.test(voiceSendBlock({ key: 'group:1000000002', now: Date.now(), state: {}, allStates: [{ key: 'group:1000000004', state: stSent1 }], cfg }) || ''));
check('F8 同群 2 天前 → 发送被拦（3 天限制）', /3 天/.test(voiceSendBlock({ key: 'group:1000000002', now: Date.now(), state: { voiceOpportunity: { hinted: [], sent: [{ at: Date.now() - 2 * 86400e3, scope: 'group', key: 'group:1000000002' }] } }, allStates: [], cfg }) || ''));
check('F9 空状态私聊 → 不被拦', voiceSendBlock({ key: OWNER, now: Date.now(), state: {}, allStates: [], cfg }) === null);
// 4) 文案软 + 记录
const lineP = voiceOpportunityLine({ scope: 'private', due: '道晚安', cfg });
const lineG = voiceOpportunityLine({ scope: 'group', due: '群里轻松', cfg });
check('W1 私聊文案含【语音机会】+可发可不发', lineP.includes('【语音机会】') && lineP.includes('可发可不发') && !/必须|一定要/.test(lineP));
check('W2 群文案强调更强表达 + 短语音', lineG.includes('【语音机会】') && lineG.includes('群里发语音是更强的表达') && lineG.includes('可发可不发'));
{
  const s1 = recordVoiceHint({}, { now: Date.now(), scene: 'late-night', key: OWNER });
  const s2 = recordVoiceSent(s1, { now: Date.now(), key: OWNER });
  check('R1 hint/sent 记录累计', normalizeOpp(s2).hinted.length === 1 && normalizeOpp(s2).sent.length === 1);
}
check('A0 氛围判定：轻松 true / 严肃 false', groupAtmosphereLight(lightRecent).light === true && groupAtmosphereLight([theirs('别吵了')]).light === false);
// 5) V2 路由 / A 静态
check('V1 config route=cloud / cloud=8767 / provider=voxd / maxChars=120', CFG.socialV2.voice.tts.route === 'cloud' && CFG.socialV2.voice.tts.endpoints.cloud === 'http://127.0.0.1:8767' && CFG.socialV2.voice.tts.provider === 'voxd' && Number(CFG.socialV2.voice.tts.maxChars) === 120);
check('V2 config opportunity allowGroups=860', Array.isArray(CFG.socialV2.voice.opportunity?.allowGroups) && CFG.socialV2.voice.opportunity.allowGroups.includes('group:1000000002'));
check('V3 ttsKey 含 baseUrl（切云缓存自然失效）', ttsKey({ baseUrl: 'http://127.0.0.1:8766', text: 'x' }) !== ttsKey({ baseUrl: 'http://127.0.0.1:8767', text: 'x' }));
check('V4 bridge 走 endpoints[route] 且 502 提示改回打字', /endpoints\?\.\[vc\.tts\.route\]/.test(SRC) && /改回打字回复，别假装发了语音/.test(SRC));
// 5b) V2 合成请求走 cloud 且错误可读（mock，不依赖 8767 服务）
{
  const outDir = path.join(os.tmpdir(), `v2-tts-${Date.now()}`);
  const calls = [];
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(100, 1)]);
  const res = await synthesizeToFile({ text: '测试一句', baseUrl: 'http://127.0.0.1:8767', outDir, fetchImpl: async (url) => { calls.push(url); return { ok: true, arrayBuffer: async () => wav, headers: { get: () => '1200' } }; } });
  check('V5 合成请求发到 8767 的 /v1/speak/file', calls.length === 1 && calls[0] === 'http://127.0.0.1:8767/v1/speak/file', calls[0]);
  check('V6 合成成功返回本地 wav', fs.existsSync(res.path) && res.path.endsWith('.wav'));
  let errMsg = '';
  try {
    await synthesizeToFile({ text: '失败测试', baseUrl: 'http://127.0.0.1:8767', outDir: path.join(outDir, 'x'), fetchImpl: async () => ({ ok: false, status: 422, json: async () => ({ detail: '无效参数' }) }) });
  } catch (e) { errMsg = e.message; }
  check('V7 V2 422 → 可读错误（供桥接转 502）', /TTS 服务返回 422/.test(errMsg) && /无效参数/.test(errMsg), errMsg);
  fs.rmSync(outDir, { recursive: true, force: true });
}

// 6) bridge 接线静态
check('S1 import 语音机会模块', /from '\.\/voice-opportunity\.js'/.test(SRC));
check('S2 prompt 有语音机会行并拼进 base', /voiceOpportunityPrompt/.test(SRC) && /\+ moodLine \+ voiceOpportunityPrompt \+ patienceTone/.test(SRC));
check('S3 私聊/群判定 + shadow 日志', /detectVoiceScene\(/.test(SRC) && /语音机会\] shadow/.test(SRC));
check('S4 投递后消费 hint + 发送后记账', /recordVoiceHint\(/.test(SRC) && /recordVoiceSent\(/.test(SRC));
check('S5 发送前频控 + voiceOpportunity 落盘', /voiceSendBlock\(/.test(SRC) && /voiceOpportunity: st\.voiceOpportunity/.test(SRC));
check('S6 voiceOpportunity 跨重启加载（load 白名单）', /voiceOpportunity: \(val\.voiceOpportunity && typeof val\.voiceOpportunity === 'object'\)/.test(SRC));

const pass = ok === cases.length;
console.log(`VOICE-OPPORTUNITY TEST ${pass ? 'PASS' : 'FAIL'}（${ok}/${cases.length}）`);
for (const c of cases) console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}${c.pass || !c.got ? '' : ` · got ${c.got}`}`);
process.exitCode = pass ? 0 : 1;
