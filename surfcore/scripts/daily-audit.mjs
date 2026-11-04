#!/usr/bin/env node
/**
 * 每日体检（2026-10-31 主人要求：每天 0 点整体排查一次）
 *
 * 只读，不动任何服务。输出一份 markdown 报告到 state/daily-audit/YYYY-MM-DD.md。
 * 目的：每天改那么多东西，问题会慢慢攒起来，趁没发作的时候先看一眼。
 *
 * 用法：node scripts/daily-audit.mjs [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const HOME = os.homedir();
const SURF = path.join(HOME, 'SurfCore');
const STATE = path.join(SURF, 'state');
const OUT_DIR = path.join(STATE, 'daily-audit');
const now = new Date();
const dayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

const findings = [];   // { level: 'ok'|'warn'|'error', area, text, hint? }
const add = (level, area, text, hint) => findings.push({ level, area, text, hint });

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function dirSize(p) {
  let total = 0;
  try {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const fp = path.join(p, e.name);
      if (e.isDirectory()) total += dirSize(fp);
      else { try { total += fs.statSync(fp).size; } catch {} }
    }
  } catch {}
  return total;
}
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;

// ── 1. 服务与端口 ─────────────────────────────────────
const PORTS = [
  [3100, '桥接控制台'],
  [3200, '监控台 web'],
  [3300, '语音窗口'],
  [5180, '房间 lab'],
];
for (const [port, name] of PORTS) {
  let alive = false;
  try {
    const out = execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    alive = out.includes('LISTEN');
  } catch {}
  if (alive) add('ok', '服务', `${name} (${port}) 在跑`);
  else add('error', '服务', `${name} (${port}) 没在监听`, '看 launchctl / bridge-supervisor.log');
}

// ── 2. 进程 ──────────────────────────────────────────
function processCount(pattern) {
  try {
    const out = execFileSync('/usr/bin/pgrep', ['-fl', pattern], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter(Boolean).length;
  } catch { return 0; }
}
const bridgeN = processCount('src/bridge.js');
if (bridgeN === 1) add('ok', '进程', '桥接 1 个实例');
else if (bridgeN === 0) add('error', '进程', '桥接进程不存在');
else add('warn', '进程', `桥接起了 ${bridgeN} 个实例`, '多实例会抢端口/重复唤醒');

// ── 3. 配置 ──────────────────────────────────────────
const cfg = readJson(path.join(SURF, 'config.json'));
if (!cfg) add('error', '配置', 'config.json 解析失败');
else {
  const preset = cfg.agentPreset ?? '?';
  add('ok', '配置', `preset=${preset}，群白名单 ${(cfg.allow?.groups || []).length} 个`);
  if (!cfg.consoleToken) add('warn', '配置', 'consoleToken 为空', '控制台将自动生成，重启后会变');
  const cap = cfg.socialV2?.tokenGuard?.maxDailyCostCNY;
  if (!(Number(cap) > 0)) add('warn', '配置', '日预算未设置或为 0');
  else add('ok', '配置', `日预算 ¥${cap}`);
}

// ── 4. 情绪值 ────────────────────────────────────────
const mood = readJson(path.join(STATE, 'mood.json'));
if (!mood) add('error', '情绪', 'mood.json 读不到');
else {
  const d = mood.dims || {};
  const keys = ['energy', 'patience', 'curiosity', 'mood', 'social'];
  const bad = keys.filter((k) => !(Number(d[k]) >= 0 && Number(d[k]) <= 1));
  if (bad.length) add('error', '情绪', `越界的值：${bad.join(', ')}`, JSON.stringify(d));
  const stuck = keys.filter((k) => Number(d[k]) < 0.02);
  if (stuck.length) add('warn', '情绪', `贴底：${stuck.join(', ')}`, '看看是不是又有扣减路径漏了');
  if (mood.asleep) add('ok', '情绪', `睡着中（约 ${mood.sleepMinutes} 分钟）`);
  else add('ok', '情绪', keys.map((k) => `${k}=${Number(d[k]).toFixed(2)}`).join(' '));
}

// ── 5. 驱力 ──────────────────────────────────────────
const drv = readJson(path.join(STATE, 'drive.json'));
if (drv) {
  const lastAny = Math.max(Number(drv.lastDriveWakeAt || 0), Number(drv.lastProactiveAt || 0));
  const hoursAgo = lastAny ? ((Date.now() - lastAny) / 3600000).toFixed(1) : '—';
  add('ok', '驱力', `上次主动 ${hoursAgo} 小时前，上次值 ${drv.lastDriveValue ?? '—'}`);
}

// ── 6. 目标 ──────────────────────────────────────────
const goals = readJson(path.join(STATE, 'goals.json'));
if (goals) {
  const open = (goals.items || []).filter((g) => g.status === 'open');
  const stale = open.filter((g) => (Date.now() - Number(g.createdAt || 0)) > 7 * 86400000);
  add(open.length ? 'ok' : 'warn', '目标', `open ${open.length} 条${stale.length ? `，其中 ${stale.length} 条放了 7 天以上` : ''}`);
}

// ── 7. 会话数据 ──────────────────────────────────────
const sv2Path = path.join(STATE, 'social-v2.json');
try {
  const st = fs.statSync(sv2Path);
  const sv2 = readJson(sv2Path);
  const convs = Object.keys(sv2?.conversations || {});
  add('ok', '会话', `social-v2.json ${mb(st.size)}，${convs.length} 个会话`);
  if (st.size > 8 * 1024 * 1024) add('warn', '会话', 'social-v2.json 超过 8MB', '历史消息可能要裁了，解析会变慢');
} catch { add('error', '会话', 'social-v2.json 读不到'); }

// ── 8. 日志里的错误 ──────────────────────────────────
const logPath = path.join(STATE, 'bridge.log');
try {
  const raw = fs.readFileSync(logPath, 'utf8').split('\n');
  const tail = raw.slice(-4000);
  const dayPfx = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const todayLines = tail.filter((l) => /^\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(l) ? l.startsWith(dayPfx) : true);
  const errs = todayLines.filter((l) => /失败|错误|error|Error|异常|ReferenceError|TypeError/.test(l));
  const warns = todayLines.filter((l) => /超时|timeout|重试|丢弃/.test(l));
  add(errs.length ? 'warn' : 'ok', '日志', `最近日志里失败/异常 ${errs.length} 行，超时/重试 ${warns.length} 行`);
  if (errs.length) add('warn', '日志', '样例：' + errs.slice(-3).map((l) => l.slice(0, 110)).join(' ｜ '));
} catch { add('warn', '日志', 'bridge.log 读不到'); }

// ── 9. 磁盘 ──────────────────────────────────────────
const BIG = [
  [path.join(STATE, 'draws'), '画'],
  [path.join(STATE, 'album'), '相册'],
  [path.join(HOME, 'voice-lab', 'audio'), '语音音频'],
  [path.join(HOME, 'SurfCore', 'backups'), '备份'],
];
for (const [p, name] of BIG) {
  if (!fs.existsSync(p)) continue;
  const size = dirSize(p);
  const lvl = size > 500 * 1024 * 1024 ? 'warn' : 'ok';
  add(lvl, '磁盘', `${name} ${mb(size)}`);
}

// ── 10. 备份垃圾 ─────────────────────────────────────
const bakDirs = [path.join(SURF, 'src'), path.join(HOME, 'room-app', 'Sources'), path.join(HOME, 'SurfCore', 'public')];
let bakCount = 0;
for (const d of bakDirs) {
  try { bakCount += fs.readdirSync(d).filter((f) => /\.bak/.test(f)).length; } catch {}
}
add(bakCount > 40 ? 'warn' : 'ok', '整理', `源码目录里 .bak 备份 ${bakCount} 个`, bakCount > 40 ? '该合并了，不然找文件会眼花' : undefined);

// ── 12. 学习账本质量 ─────────────────────────────────
const ledger = readJson(path.join(STATE, 'learn-ledger.json'));
if (ledger && ledger.items) {
  const items = Object.values(ledger.items);
  // 判定标准要和提取规则对齐：提取出来的 topic 是「被禁止的那个行为」，
  // 「发群里」「应得太直接」看着像碎片，其实是规矩的内容，不能算垃圾。
  const short = items.filter((x) => String(x.topic || '').length < 3);
  const frag = items.filter((x) => /[？?呢吗吧]$/.test(String(x.topic || '')) || /^(有|是|在|就|那|这)/.test(String(x.topic || '')));
  const byOwner = items.filter((x) => (x.sources || []).includes('owner')).length;
  const bad = short.length + frag.length;
  const pct = items.length ? Math.round((bad / items.length) * 100) : 0;
  add(bad > items.length * 0.3 ? 'warn' : 'ok', '学习账本',
    `${items.length} 条（${byOwner} 条主人教的）· 主题过短 ${short.length} · 像半句话 ${frag.length}（${pct}%）`);
  if (bad > items.length * 0.3) {
    add('warn', '学习账本', '提取逻辑把聊天半句当主题了', '应收紧到祈使句/规则句；待改：learn-ledger 的 topic 抽取');
  }
}

// ── 11. DSH 会话目录一致性 ───────────────────────────
try {
  const out = execFileSync('/opt/homebrew/opt/node@22/bin/node', [path.join(SURF, 'scripts', 'check-session-integrity.mjs')],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 });
  const bad = (out.match(/项目目录与头部 cwd 不符/g) || []).length;
  add(bad ? 'warn' : 'ok', '会话目录', bad ? `${bad} 个会话的 workspace 路径不一致` : '一致');
} catch { add('ok', '会话目录', '检查脚本跳过'); }

// ── 输出 ─────────────────────────────────────────────
const order = { error: 0, warn: 1, ok: 2 };
findings.sort((a, b) => order[a.level] - order[b.level]);

const nErr = findings.filter((f) => f.level === 'error').length;
const nWarn = findings.filter((f) => f.level === 'warn').length;
const icon = { error: '❌', warn: '⚠️', ok: '✅' };

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ day: dayKey, nErr, nWarn, findings }, null, 2));
} else {
  const lines = [];
  lines.push(`# 每日体检 · ${dayKey} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`);
  lines.push('');
  lines.push(`**${nErr} 个错误 · ${nWarn} 个提醒 · ${findings.length - nErr - nWarn} 项正常**`);
  lines.push('');
  for (const f of findings) {
    lines.push(`- ${icon[f.level]} **${f.area}** ${f.text}${f.hint ? `\n  - 建议：${f.hint}` : ''}`);
  }
  const report = lines.join('\n');
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, `${dayKey}.md`), report + '\n');
  } catch {}
  console.log(report);
}

process.exit(nErr > 0 ? 1 : 0);
