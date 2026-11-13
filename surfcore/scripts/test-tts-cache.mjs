#!/usr/bin/env node
// 2026-11-10 task-34：TTS 缓存情绪快照单测（mood 变化后不复用旧情绪音频）
import fs from 'node:fs';
import path from 'node:path';
import { ttsKey, emotionSnapshotFrom } from '../src/voice-tts.js';

const ROOT = process.env.SURFCORE_DIR || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
let ok = 0; const cases = [];
const check = (name, pass, got = '') => { cases.push({ name, pass, got }); if (pass) ok += 1; };

check('E1 文本晚安关键词 → sleepy', emotionSnapshotFrom('晚安啦', { energy: 0.9, mood: 0.9, social: 0.9 }) === 'sleepy');
check('E2 文本开心关键词 → happy', emotionSnapshotFrom('哈哈好耶', { energy: 0.9, mood: 0.2, social: 0.2 }) === 'happy');
check('E3 低 energy → sleepy', emotionSnapshotFrom('普通一句话', { energy: 0.2, mood: 0.9, social: 0.9 }) === 'sleepy');
check('E4 mood/social 闸门 → happy', emotionSnapshotFrom('普通一句话', { energy: 0.8, mood: 0.85, social: 0.7 }) === 'happy');
check('E5 默认 normal', emotionSnapshotFrom('普通一句话', { energy: 0.8, mood: 0.5, social: 0.5 }) === 'normal');
check('E6 env 阈值覆盖', emotionSnapshotFrom('普通一句话', { energy: 0.4, mood: 0.1, social: 0.1 }, { V2_SLEEPY_ENERGY_MAX: '0.5' }) === 'sleepy');
check('E7 坏 dims 不抛', emotionSnapshotFrom('x', null) === 'normal' && emotionSnapshotFrom('x', {}) === 'normal');
// 缓存 key 必须按情绪分桶
const base = { baseUrl: 'http://127.0.0.1:8767', text: '同一句话', character: '', voice: '', cacheVersion: 0 };
check('E8 不同 emotion → 不同 ttsKey', ttsKey({ ...base, style: { emotion: 'happy' } }) !== ttsKey({ ...base, style: { emotion: 'normal' } }));
check('E9 同 emotion 稳定命中', ttsKey({ ...base, style: { emotion: 'happy' } }) === ttsKey({ ...base, style: { emotion: 'happy' } }));
// bridge 接线静态
check('S1 import emotionSnapshotFrom', /synthesizeToFile, synthesizeMimoToFile, emotionSnapshotFrom/.test(SRC));
check('S2 合成时按 mood 生成 style 快照并传入缓存 key', /emotionSnapshotFrom\(say, loadMood\(\)\?\.dims \|\| \{\}\)/.test(SRC) && /style: emoStyle/.test(SRC));
check('S3 cloud 仍走 8767/voxd（既有 A 验收不回归）', /endpoints\?\.\[vc\.tts\.route\]/.test(SRC));

const pass = ok === cases.length;
console.log(`TTS-CACHE TEST ${pass ? 'PASS' : 'FAIL'}（${ok}/${cases.length}）`);
for (const c of cases) console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}${c.pass || !c.got ? '' : ` · got ${c.got}`}`);
process.exitCode = pass ? 0 : 1;
