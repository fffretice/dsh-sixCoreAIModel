#!/usr/bin/env node
// release-audit.mjs —— 发布前自检：隐私 / 凭据 / 个人标识 / 大文件
//
// 用法：
//   node scripts/release-audit.mjs            # 扫整个仓库（跳过 .git / node_modules / state）
//   node scripts/release-audit.mjs --strict   # 有任何命中就以退出码 1 结束
//
// 设计原则：**只报告，不改文件**；输出里对疑似凭据做打码，避免报告本身泄漏。
// 它不是万能的——正则抓不到「用自然语言写进去的隐私」。发布前仍然要人过一遍。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'state', 'dist', 'backups', '.cache']);
const TEXT = new Set(['.md', '.js', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.sh', '.ps1', '.html', '.css', '.txt', '.example', '']);
const strict = process.argv.includes('--strict');

const RULES = [
  { id: 'mac-user-path', re: /\/Users\/(?!\{|\$|you\b|username\b|your)[A-Za-z0-9._-]{2,}/g, level: 'high', note: 'macOS 本机用户路径' },
  { id: 'win-user-path', re: /[A-Za-z]:\\\\?Users\\\\?(?!\{|\$|you\b|username\b|<)[^\\/\s"']+/g, level: 'high', note: 'Windows 本机用户路径' },
  { id: 'qq-number', re: /(?<![0-9])[1-9][0-9]{8,10}(?![0-9])/g, level: 'mid', note: '像 QQ 号的长数字（也可能是别的 ID，人工确认）' },
  { id: 'api-key', re: /\b(sk|pk|ak)-[A-Za-z0-9_-]{16,}\b/g, level: 'high', note: '疑似 API key' },
  { id: 'bearer', re: /Bearer\s+[A-Za-z0-9._-]{20,}/g, level: 'high', note: '疑似 Bearer token' },
  { id: 'long-hex', re: /\b[0-9a-f]{32,}\b/gi, level: 'mid', note: '长十六进制串（可能是 token/哈希）' },
  { id: 'private-ip', re: /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g, level: 'mid', note: '内网 IP（127.0.0.1 不算）' },
  { id: 'mac-addr', re: /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g, level: 'high', note: 'MAC 地址' },
  { id: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, level: 'low', note: '邮箱地址' },
  { id: 'example-qq', re: /(?:1000000001|1000000002|123456789)\b/g, level: 'low', note: '占位 QQ（示例值，确认不是真的）' },
];

// 明确的占位值：扫描时直接跳过（文档里的示例 QQ 就该是这些）
const PLACEHOLDERS = new Set(['1000000001', '1000000002', '1000000003', '1000000004', '123456789', '1234567890']);

const mask = (s) => {
  const t = String(s);
  if (t.length <= 8) return t;
  return t.slice(0, 4) + '***' + t.slice(-2);
};

const findings = [];
let scanned = 0;

function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.') && ent.name !== '.gitignore') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      walk(p);
      continue;
    }
    const ext = path.extname(ent.name).toLowerCase();
    if (!TEXT.has(ext)) continue;
    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    if (text.length > 2_000_000) continue;
    scanned += 1;
    const lines = text.split('\n');
    for (const rule of RULES) {
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].includes('release-audit: allow')) continue;
        rule.re.lastIndex = 0;
        const m = rule.re.exec(lines[i]);
        // 明显是占位/示例的值，直接跳过
        if (m && PLACEHOLDERS.has(m[0])) continue;
        if (m && rule.id === 'qq-number' && /^100000+\d{0,4}$/.test(m[0])) continue;
        if (m && /[\\/]Users[\\/](x|xxx|you|user|username|your|\.\.\.)$/i.test(m[0])) continue;
        if (m && rule.id === 'api-key' && /(test|fake|example|placeholder|abcdefghij)/i.test(m[0])) continue;
        if (m) {
          findings.push({
            file: path.relative(ROOT, p),
            line: i + 1,
            rule: rule.id,
            level: rule.level,
            note: rule.note,
            sample: mask(m[0]),
          });
        }
      }
    }
  }
}

walk(ROOT);

const byLevel = { high: 0, mid: 0, low: 0 };
for (const f of findings) byLevel[f.level] += 1;

console.log(`扫描文件 ${scanned} 个，命中 ${findings.length} 条（high ${byLevel.high} / mid ${byLevel.mid} / low ${byLevel.low}）\n`);
if (!findings.length) {
  console.log('没有命中。注意：这只说明「没撞上这些正则」，不代表没有隐私。');
} else {
  const order = { high: 0, mid: 1, low: 2 };
  const sorted = [...findings].sort((a, b) => order[a.level] - order[b.level]);
  const show = sorted.slice(0, 60);
  for (const f of show) {
    console.log(`${f.level.toUpperCase().padEnd(4)} ${f.file}:${f.line}  [${f.rule}] ${f.note}  → ${f.sample}`);
  }
  if (findings.length > show.length) console.log(`\n…还有 ${findings.length - show.length} 条，未显示。`);
  console.log('\n逐条确认：示例/占位可以留，真实标识必须删。删完再跑一遍。');
}

if (strict && findings.some((f) => f.level === 'high' || f.level === 'mid')) process.exit(1);
