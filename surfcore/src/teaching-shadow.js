// 2026-11-09（task-30 D）：teaching-drop-shadow 只读观测落盘。
// 记录被丢弃/降级/候选化的 owner 教学句，供周覆盖统计（目标覆盖 ≥90%、静默丢 <5%）。
// 注意：只 append/轮转，不参与判定；文件 >1MB 保留最后 5000 行。
import fs from 'node:fs';
import path from 'node:path';

export const TEACHING_SHADOW_FILE = 'teaching-drop-shadow.jsonl';
export const DEFAULT_SHADOW_LIMITS = { maxBytes: 1024 * 1024, keepLines: 5000 };

export function appendTeachingShadow(filePath, entry, { maxBytes = DEFAULT_SHADOW_LIMITS.maxBytes, keepLines = DEFAULT_SHADOW_LIMITS.keepLines } = {}) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
    if (fs.statSync(filePath).size > maxBytes) {
      const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(filePath, lines.slice(-keepLines).join('\n') + '\n');
    }
    return true;
  } catch { return false; }
}

export function readTeachingShadow(filePath, { maxLines = 0 } = {}) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    const picked = maxLines > 0 ? lines.slice(-maxLines) : lines;
    return picked.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
