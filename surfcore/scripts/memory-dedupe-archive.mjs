#!/usr/bin/env node
/**
 * 全量记忆归档去重（task-9 P0，2026-11-08）
 *
 * 背景（memory-upgrade.md §1.4 / §9）：
 *   normalizeCard 硬帽 2000 与 config maxRecords=5000 不一致 + inboxSeen 3000 < 读取窗口 4000，
 *   导致同一批记录被反复「重新摄入 → 再归档」。实测 139,936 行里只有 5,497 个唯一 id
 *   （96.1% 重复，文件 116MB，真实内容约 4.5MB）。
 *
 * 本脚本：流式两遍扫描，**同 id 只保留最后一条**（字段最全、archivedAt 最新），
 * 写临时文件 → 校验（行数 = 唯一 id 数、id 集合一致、抽样正文一致）→ 原子替换。
 *
 * 安全默认：**dry-run**（只报告不写）；--apply 才写，且先备份原文件到 backups/。
 * 只读约束之外的唯一写入：目标 jsonl（原子替换）、stats json、backups/.bak 文件。
 *
 * 用法：
 *   node scripts/memory-dedupe-archive.mjs [--file PATH] [--stats PATH] [--apply]
 *        [--out report.json] [--backup-dir DIR] [--force]
 *
 *   # 副本验证（推荐第一次这么跑）
 *   mkdir -p /tmp/mem-dedupe-test
 *   cp memory-card-full.jsonl /tmp/mem-dedupe-test/
 *   cp memory-card-full-stats.json /tmp/mem-dedupe-test/
 *   node scripts/memory-dedupe-archive.mjs --file /tmp/mem-dedupe-test/memory-card-full.jsonl --apply
 *
 * 生产执行窗口（lead 2026-11-08 定）：停桥接 → 通知老大重启 DSH → DSH 停着时跑 --apply
 *   → 校验 → 起 DSH。脚本本身 2 遍扫描 ≈ 数秒。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.HOME || os.homedir();
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh');

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : '';
}
const apply = process.argv.includes('--apply');
const force = process.argv.includes('--force');
const outFile = argValue('--out');
const backupDirArg = argValue('--backup-dir');

function fmtBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
function sha1File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    fs.createReadStream(file).on('data', (d) => hash.update(d)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}
function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
function sectionOf(record) {
  if (record.platform === 'pet') return 'pet';
  if (Array.isArray(record.tags) && record.tags.includes('owner')) return 'owner';
  if (record.platform === 'bili') return 'bili';
  if (record.platform === 'qq') return 'qq';
  return 'other';
}

// ── 解析目标文件 ──────────────────────────────────────────────────────────
async function resolveTarget() {
  const fileArg = argValue('--file');
  if (fileArg) return { file: path.resolve(fileArg), source: 'cli' };
  const { readCurrentCharacter, activeMemoryPaths } = await import(path.join(ROOT, 'src', 'character-persona.js'));
  const { resolveMemoryCardPaths } = await import(path.join(ROOT, 'src', 'memory-card.js'));
  const cur = readCurrentCharacter();
  if (!cur) return null;
  const paths = resolveMemoryCardPaths(activeMemoryPaths().dir);
  return { file: paths.fullJsonl, source: 'active-character', dir: paths.dir };
}

/** 第一遍：id → 最后一次出现的字节偏移与长度（保留最后一条）。 */
async function scanLastOccurrence(file) {
  const idx = new Map(); // id → { offset, length, count }
  let offset = 0;
  let lines = 0;
  let bytes = 0;
  let corrupt = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // +1 = '\n'
    bytes += lineBytes;
    if (!line.trim()) { offset += lineBytes; continue; }
    lines += 1;
    let rec;
    try { rec = JSON.parse(line); } catch { corrupt += 1; offset += lineBytes; continue; }
    const id = String(rec?.id ?? '');
    if (!id) { corrupt += 1; offset += lineBytes; continue; }
    const prev = idx.get(id);
    if (prev) prev.count += 1;
    idx.set(id, { offset, length: lineBytes, count: prev ? prev.count + 1 : 1, text: String(rec.text ?? ''), createdAt: rec.createdAt });
    offset += lineBytes;
  }
  return { idx, lines, bytes, corrupt };
}

/** 第二遍：只写「最后出现」的行；校验 id 集合一致。 */
async function writeDeduped(file, outFileTmp, idx) {
  const out = fs.createWriteStream(outFileTmp, { mode: 0o600 });
  let offset = 0;
  let written = 0;
  const writtenIds = new Set();
  const samples = []; // [id, text] 抽样，用于正文一致性校验
  const sampleIds = new Set([...idx.keys()].slice(0, 20));
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let ok = true;
  for await (const line of rl) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    if (line.trim()) {
      const target = (() => { try { return idx.get(String(JSON.parse(line)?.id ?? '')); } catch { return null; } })();
      if (target && target.offset === offset) {
        if (!out.write(`${line}\n`)) await new Promise((r) => out.once('drain', r));
        written += 1;
        const id = String(JSON.parse(line).id);
        writtenIds.add(id);
        if (sampleIds.has(id)) samples.push({ id, text: String(JSON.parse(line).text ?? '') });
      }
    }
    offset += lineBytes;
  }
  await new Promise((r) => out.end(r));
  // 校验 1：写入行数 = 唯一 id 数
  if (written !== idx.size) { ok = false; }
  // 校验 2：id 集合一致
  if (writtenIds.size !== idx.size) ok = false;
  // 校验 3：抽样正文与第一遍记录一致
  for (const s of samples) {
    const rec = idx.get(s.id);
    if (!rec || rec.text !== s.text) { ok = false; break; }
  }
  return { written, ok, samples: samples.length, ids: writtenIds.size };
}

/** 从去重后的 jsonl 重算 stats（保留旧 stats 的元信息）。 */
async function recomputeStats(file, oldStats) {
  const base = {
    version: oldStats?.version ?? 2,
    kind: 'full',
    createdAt: oldStats?.createdAt ?? new Date().toISOString(),
    lastArchiveAt: oldStats?.lastArchiveAt ?? null,
    lastMigratedAt: oldStats?.lastMigratedAt ?? null,
  };
  const stat = { ...base, updatedAt: new Date().toISOString(), records: 0, chars: 0, bytes: 0, counts: { owner: 0, bili: 0, qq: 0, other: 0, pet: 0 } };
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      stat.records += 1;
      stat.chars += String(rec.text ?? '').length;
      const key = sectionOf(rec);
      stat.counts[key] = (stat.counts[key] || 0) + 1;
    } catch {}
  }
  // 保持旧字段（如果旧 stats 有别的字段，保留它们，但计数以重算为准）
  const merged = { ...(oldStats || {}), ...stat, counts: { ...(oldStats?.counts || {}), ...stat.counts } };
  merged.bytes = fs.statSync(file).size;
  merged.updatedAt = new Date().toISOString();
  return merged;
}

// ── 主流程 ────────────────────────────────────────────────────────────────
const started = Date.now();
const target = await resolveTarget();
if (!target) { console.error('找不到当前角色的记忆目录，也没有 --file'); process.exit(2); }
const file = target.file;
if (!fs.existsSync(file)) { console.error(`归档不存在：${file}`); process.exit(2); }
const statsPath = argValue('--stats') || file.replace(/\.jsonl$/i, '-stats.json');
const beforeBytes = fs.statSync(file).size;
const beforeStats = readJson(statsPath, null);
const backupDir = backupDirArg || path.join(path.dirname(file), 'backups');

console.log(`# 归档去重 ${apply ? '（APPLY）' : '（dry-run）'}`);
console.log(`文件：${file}`);
console.log(`大小：${fmtBytes(beforeBytes)}   stats：${statsPath}  ${beforeStats ? `(stats.records=${beforeStats.records})` : '(无)'}`);
console.log('扫描第 1 遍（统计唯一 id / 最后出现位置）…');
const t1 = Date.now();
const scan = await scanLastOccurrence(file);
console.log(`  行数 ${scan.lines.toLocaleString()} / 唯一 id ${scan.idx.size.toLocaleString()} / 坏行 ${scan.corrupt} / 用时 ${Date.now() - t1}ms`);

const duplicateLines = scan.lines - scan.idx.size;
const dupPct = scan.lines ? Math.round((duplicateLines / scan.lines) * 1000) / 10 : 0;
// 粗略估算去重后大小：唯一 id 的「最后一行」字节数之和
let expectedBytes = 0;
for (const v of scan.idx.values()) expectedBytes += v.length;

const report = {
  at: new Date().toISOString(),
  mode: apply ? 'apply' : 'dry-run',
  file,
  statsPath,
  before: { bytes: beforeBytes, lines: scan.lines, uniqueIds: scan.idx.size, duplicateLines, dupRatioPct: dupPct, corruptLines: scan.corrupt },
  expectedAfter: { bytes: expectedBytes, lines: scan.idx.size },
  statsBefore: beforeStats ? { records: beforeStats.records, bytes: beforeStats.bytes, chars: beforeStats.chars } : null,
};

if (scan.idx.size < 100 && !force) {
  console.error(`唯一 id 只有 ${scan.idx.size}，看起来不像正常归档；拒绝执行（--force 可强跑）`);
  report.ok = false;
  report.error = 'too-few-unique-ids';
  if (outFile) writeJsonAtomic(path.resolve(outFile), report);
  process.exit(1);
}

console.log(`重复行 ${duplicateLines.toLocaleString()}（${dupPct}%），预计去重后 ${fmtBytes(expectedBytes)}`);

if (!apply) {
  console.log('dry-run：不写任何文件。加 --apply 执行（会先备份原文件）。');
  report.ok = true;
  report.tookMs = Date.now() - started;
  if (outFile) { writeJsonAtomic(path.resolve(outFile), report); console.log(`报告：${path.resolve(outFile)}`); }
  process.exit(0);
}

// ── apply：写临时文件 → 校验 → 备份 → 原子替换 → 重算 stats ─────────────
const tmpPath = `${file}.dedupe-${process.pid}.tmp`;
console.log('扫描第 2 遍（写临时文件）…');
const t2 = Date.now();
const writeResult = await writeDeduped(file, tmpPath, scan.idx);
console.log(`  写入 ${writeResult.written.toLocaleString()} 行 / id ${writeResult.ids} / 抽样校验 ${writeResult.samples} 条 / 用时 ${Date.now() - t2}ms`);
report.after = { bytes: fs.statSync(tmpPath).size, lines: writeResult.written, uniqueIds: writeResult.ids };
report.checks = {
  linesEqualUniqueIds: writeResult.written === scan.idx.size,
  idsComplete: writeResult.ids === scan.idx.size,
  samplesMatch: writeResult.ok,
  sha1Before: await sha1File(file),
  sha1Temp: await sha1File(tmpPath),
};
if (!writeResult.ok) {
  try { fs.rmSync(tmpPath, { force: true }); } catch {}
  console.error('校验失败：去重结果不完整，未替换原文件。');
  report.ok = false;
  report.error = 'verify-failed';
  if (outFile) writeJsonAtomic(path.resolve(outFile), report);
  process.exit(1);
}

fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupFile = path.join(backupDir, `memory-card-full.jsonl.bak-dedupe-${stamp}`);
console.log(`备份原文件 → ${backupFile}`);
fs.copyFileSync(file, backupFile);
if (fs.statSync(backupFile).size !== beforeBytes) {
  console.error('备份大小不一致，中止（原文件未动）');
  try { fs.rmSync(tmpPath, { force: true }); } catch {}
  report.ok = false;
  report.error = 'backup-size-mismatch';
  if (outFile) writeJsonAtomic(path.resolve(outFile), report);
  process.exit(1);
}

fs.renameSync(tmpPath, file);
console.log(`已替换：${fmtBytes(beforeBytes)} → ${fmtBytes(fs.statSync(file).size)}`);

// stats：先备份旧 stats，再原子写新的
let statsBackup = '';
if (fs.existsSync(statsPath)) {
  statsBackup = path.join(backupDir, `memory-card-full-stats.json.bak-dedupe-${stamp}`);
  fs.copyFileSync(statsPath, statsBackup);
}
const newStats = await recomputeStats(file, beforeStats);
newStats.dedupe = {
  at: new Date().toISOString(),
  keep: 'last',
  fromLines: scan.lines,
  fromBytes: beforeBytes,
  keptLines: writeResult.written,
  keptBytes: newStats.bytes,
  backup: backupFile,
};
writeJsonAtomic(statsPath, newStats);
report.statsAfter = { records: newStats.records, bytes: newStats.bytes, chars: newStats.chars, counts: newStats.counts };
report.backupFile = backupFile;
report.statsBackup = statsBackup;
report.ok = true;
report.tookMs = Date.now() - started;
if (outFile) writeJsonAtomic(path.resolve(outFile), report);

console.log('校验：');
console.log(`  - 行数 = 唯一 id 数：${report.checks.linesEqualUniqueIds ? 'OK' : 'FAIL'}（${writeResult.written}）`);
console.log(`  - id 集合完整：${report.checks.idsComplete ? 'OK' : 'FAIL'}`);
console.log(`  - 抽样正文一致：${report.checks.samplesMatch ? 'OK' : 'FAIL'}（${writeResult.samples} 条）`);
console.log(`stats：records=${newStats.records} bytes=${fmtBytes(newStats.bytes)} counts=${JSON.stringify(newStats.counts)}`);
console.log(`完成，用时 ${Date.now() - started}ms`);
if (outFile) console.log(`报告：${path.resolve(outFile)}`);
process.exit(0);
