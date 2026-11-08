#!/usr/bin/env node
/**
 * 夜间全量体检（2026-11-02 老大要求，每天 04:10）
 *
 * 目的：把「开发了但没在正常工作 / 跑歪了 / 触发不了」的功能每天翻一遍，
 *       按优先级列出来，**只记录不修改**。
 *
 * 检查范围：
 *   A 服务与进程      B QQ 健康        C 定时任务心跳
 *   D 状态新鲜度      E 注入块完整性    F 配置一致性
 *   G 学习账本待办    H 日志异常        I 文档路径
 *
 * 输出：state/nightly-audit/YYYY-MM-DD.md（另有 --json）
 * 用法：node scripts/nightly-audit.mjs [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { rebuildRulesMeta } from './rebuild-rules-meta.mjs';

const HOME = os.homedir();
const SURF = path.join(HOME, 'SurfCore');
const STATE = path.join(SURF, 'state');
const OUT_DIR = path.join(STATE, 'nightly-audit');
const now = new Date();
const dayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

/** P0=影响她正常工作 P1=功能没生效/跑歪 P2=隐患 ok=正常 */
const findings = [];
const add = (p, area, title, detail = '', cause = '', fix = '') =>
  findings.push({ p, area, title, detail, cause, fix });
const ok = (area, title, detail = '') => findings.push({ p: 'ok', area, title, detail });

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const hoursAgo = (ms) => (Date.now() - Number(ms || 0)) / 3600000;
const consoleToken = (() => { try { return fs.readFileSync(path.join(STATE, 'console-token'), 'utf8').trim(); } catch { return ''; } })();

async function httpGet(url, headers = {}, timeout = 6000) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, json, text };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// ── A. 服务与进程 ────────────────────────────────────────────────
async function checkServices() {
  const services = [
    ['桥接控制台', 3100],
    ['SnowLuma', 3000],
    ['记忆服务', 8080],
  ];
  for (const [name, port] of services) {
    const r = await httpGet(`http://127.0.0.1:${port}/`, {}, 3000);
    if (r.error) add(0, '服务', `${name} (${port}) 连不上`, r.error, '进程没起或被 launchd 停掉', 'launchctl kickstart gui/$(id -u)/com.fretice.xxx');
    else ok('服务', `${name} (${port}) 在跑`);
  }
  // DSH 状态
  const st = await httpGet('http://127.0.0.1:3100/api/status', { 'x-console-token': consoleToken });
  if (st.json) {
    if (st.json.dshReady) ok('服务', `DSH 已连接（${st.json.dshBaseUrl}，模式 ${st.json.mode}）`);
    else add(0, '服务', 'DSH 未就绪', `dshBaseUrl=${st.json.dshBaseUrl}`, 'DSH 可能重启换了端口', '重启桥接让它重新探测端口');
    if (st.json.mode !== 'reserved2') add(1, '服务', `桥接模式是 ${st.json.mode}，不是 reserved2`, '', '模式被切走了', '控制台切回 reserved2');
  } else {
    add(0, '服务', '桥接 /api/status 拿不到', '', '桥接挂了或令牌不对', '看 state/bridge.log');
  }
}

// ── B. QQ 健康 ───────────────────────────────────────────────────
async function checkQQ() {
  const cfg = readJson(path.join(SURF, 'config.json')) || {};
  const token = cfg.snowluma?.accessToken || '';
  const base = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const r = await httpGet(`${base}/get_login_info`, token ? { authorization: `Bearer ${token}` } : {});
  if (r.json?.status === 'ok' && r.json.data?.user_id) {
    ok('QQ', `登录正常：${r.json.data.nickname}（${r.json.data.user_id}）`);
  } else {
    add(0, 'QQ', '登录状态异常', JSON.stringify(r.json || r.error || '').slice(0, 160), '会话可能失效', '扫码重新登录 SnowLuma');
  }
  // 风控关键词 + 发送失败率
  const logPaths = ['bridge.log', 'bridge.log.1'].map((f) => path.join(STATE, f)).filter(exists);
  let riskHits = 0, sendFail = 0, sendOk = 0, samples = [];
  for (const p of logPaths) {
    let text = '';
    try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (/风控|账号异常|被限制|冻结|频率限制/.test(line)) { riskHits++; if (samples.length < 3) samples.push(line.slice(0, 120)); }
      if (/发送失败|send.*failed|rejected|retcode":100/.test(line)) sendFail++;
      if (/成功 \d+\/\d+ 条|工具发送表情/.test(line)) sendOk++;
    }
  }
  if (riskHits > 0) add(0, 'QQ', `日志里出现 ${riskHits} 次风控相关字样`, samples.join(' ｜ '), '可能被风控盯上', '降低发送频率，检查最近内容');
  else ok('QQ', '没有风控相关日志');
  const total = sendOk + sendFail;
  if (total > 0) {
    const rate = sendFail / total;
    if (rate > 0.1) add(1, 'QQ', `发送失败率 ${(rate * 100).toFixed(1)}%`, `成功 ${sendOk} / 失败 ${sendFail}`, '接口参数或网络问题', '看 bridge.log 里 rejected 的具体 wording');
    else ok('QQ', `发送成功率 ${((1 - rate) * 100).toFixed(1)}%（${sendOk} 成功 / ${sendFail} 失败）`);
  }
  // 表情库一致性
  const stickers = readJson(path.join(STATE, 'stickers.json'));
  const arr = Array.isArray(stickers) ? stickers : (stickers?.items || []);
  if (arr.length) {
    const noLabel = arr.filter((e) => !String(e.content || '').trim()).length;
    const anim = arr.filter((e) => Array.isArray(e.tags) && e.tags.includes('动图')).length;
    if (noLabel > 0) add(2, 'QQ', `表情库有 ${noLabel} 张没有标注`, `共 ${arr.length} 张`, '新同步的表情没写内容', '补标注，否则她挑图时会瞎选');
    else ok('QQ', `表情库 ${arr.length} 张全部有标注（动图 ${anim} 张）`);
  }
}

// ── C. 定时任务心跳 ──────────────────────────────────────────────
function checkTimers() {
  const hb = readJson(path.join(STATE, 'timer-heartbeats.json'));
  if (!hb) { add(1, '定时器', '没有 timer-heartbeats.json', '', '桥接还没写过心跳', '重启桥接后等 10 分钟'); return; }
  const spec = {
    '反思抽取': 10, '因果结算': 5, '驱力': 5, '自己的时间': 5, '额度重分配': 5,
    '日记': 5, '叙事': 5, 'KFC': 10, '主动机会': 5, '学习采集': 10, '目的': 1,
  };
  const saved = hoursAgo(hb.savedAt) * 60;
  if (saved > 30) add(1, '定时器', `心跳文件 ${saved.toFixed(0)} 分钟没更新`, '', '桥接可能挂了', '检查桥接进程');
  const bad = [];
  for (const [name, periodMin] of Object.entries(spec)) {
    const b = hb.beats?.[name];
    if (!b) { bad.push(`${name}（从未）`); continue; }
    // 2026-11-08 PM：心跳快照 savedAt 每 10 分钟才落盘，用 Date.now() 算会把
    // 「上次落盘到现在」的相位差算成「定时器没跑」（目的阈值 6 分钟 → 必然误报）。
    // 用「快照落盘那一刻距上次心跳多久」才对。
    const gap = (Number(hb.savedAt) - Number(b.at)) / 60000;
    if (gap > Math.max(periodMin * 3, 6)) bad.push(`${name}（${gap.toFixed(0)} 分钟没跑）`);
  }
  if (bad.length) add(1, '定时器', `${bad.length} 个定时任务没在正常跑`, bad.join('、'), '回调里提前 return，或定时器没注册', '对照源码检查条件分支');
  else ok('定时器', `${Object.keys(spec).length} 个定时任务心跳正常`);
}

// ── D. 状态新鲜度 ────────────────────────────────────────────────
function checkFreshness() {
  const spec = [
    ['causal.json', 24, '因果核心'],
    ['mood.json', 2, '情绪'],
    ['learn-ledger.json', 48, '学习账本'],
    ['self-pledge.json', 48, '她说过的'],
    ['goals.json', 72, '目标'],
    ['observation.json', 24, '观察'],
    ['learn-candidates.json', 24, '学习候选'],
  ];
  for (const [file, maxH, label] of spec) {
    const p = path.join(STATE, file);
    if (!exists(p)) { add(1, '新鲜度', `${label} 的 ${file} 不存在`, '', '功能可能没跑过', '检查对应定时器'); continue; }
    const h = hoursAgo(fs.statSync(p).mtimeMs);
    if (h > maxH) add(2, '新鲜度', `${label} ${h.toFixed(0)} 小时没更新`, `预期 ${maxH} 小时内至少一次`, '她可能没在用这个功能，或定时器没跑', '观察一天；一直不动就是机制问题');
    else ok('新鲜度', `${label} ${h.toFixed(1)} 小时前更新`);
  }
  for (const [file, label] of [['reflections.jsonl', '反思'], ['narrative.jsonl', '叙事'], ['search-memory.jsonl', '搜索记忆'], ['social-shadow.jsonl', '社交影子']]) {
    const p = path.join(STATE, file);
    if (!exists(p)) { add(2, '新鲜度', `${label}（${file}）不存在`, '', '从没写过', '确认写入代码路径'); continue; }
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).length;
    const h = hoursAgo(fs.statSync(p).mtimeMs);
    if (lines === 0) add(2, '新鲜度', `${label} 文件是空的`, '', '写入没成功', '查写入函数');
    else ok('新鲜度', `${label} ${lines} 条，${h.toFixed(0)} 小时前更新`);
  }
  // 房间笔记
  const roomDir = path.join(STATE, 'room');
  if (exists(roomDir)) {
    const files = fs.readdirSync(roomDir).filter((f) => /\.md$/i.test(f));
    const latest = files.map((f) => fs.statSync(path.join(roomDir, f)).mtimeMs).sort((a, b) => b - a)[0] || 0;
    if (hoursAgo(latest) > 48) add(2, '新鲜度', `房间笔记 ${hoursAgo(latest).toFixed(0)} 小时没写`, '', '她没在用房间工具', '看看是不是被别的注入挤掉了');
    else ok('新鲜度', `房间笔记 ${hoursAgo(latest).toFixed(1)} 小时前写过`);
  }
}

// ── E. 注入块完整性 ─────────────────────────────────────────────
async function checkPromptBlocks() {
  const r = await httpGet('http://127.0.0.1:3100/api/socialV2/wake-prompt?key=group:1000000002&reason=drive&dry=1',
    { 'x-console-token': consoleToken }, 12000);
  const prompt = r.json?.prompt || '';
  if (!prompt) { add(1, '注入块', '拿不到 wake-prompt', JSON.stringify(r.json || r.error || '').slice(0, 120), '接口异常', '手动调一次看看'); return; }
  const required = [
    '【你现在叫角色', '【你现在的状态】', '【可用表情包】', '【表情包策略', '【人格卡',
    '【你自己认的规矩】', '【记忆卡', '【今天的额度】',
  ];
  const missing = required.filter((m) => !prompt.includes(m));
  if (missing.length) add(0, '注入块', `prompt 里缺 ${missing.length} 个关键块`, missing.join('、'), '注入条件不满足或有异常', '查对应 buildXxx 函数');
  else ok('注入块', `关键块齐全（prompt ${prompt.length} 字符）`);
  if (prompt.length > 26000) add(1, '注入块', `prompt 已 ${prompt.length} 字符`, '超过 2.6 万，中段容易被稀释', '内容越堆越多', '考虑按场景裁剪');
  // 空块检测：块标题后紧跟另一个块标题
  // 只认独占行首的块标题；正文里引用块名（比如规则说「看到【表情匹配】就发」）不算
  const blocks = [...prompt.matchAll(/\n【[^】]{2,20}】/g)].map((m) => m[0].trim());
  const counts = {};
  for (const b of blocks) counts[b] = (counts[b] || 0) + 1;
  // 块名在正文里被引用是正常的（比如规则里提到「【表情匹配】」），
  // 只有出现 4 次以上才像真的拼重了。
  const dupes = Object.entries(counts).filter(([, n]) => n >= 4);
  if (dupes.length) add(2, '注入块', `${dupes.length} 个块出现 4 次以上`, dupes.map(([b, n]) => `${b}×${n}`).join('、'), '拼接时可能加了两次', '查 buildPrompt 拼接顺序');
}

// ── F. 配置一致性 ───────────────────────────────────────────────
function checkConfig() {
  const cfg = readJson(path.join(SURF, 'config.json'));
  if (!cfg) { add(0, '配置', 'config.json 读不到或解析失败', '', '', ''); return; }
  let src = '';
  try { src = fs.readFileSync(path.join(SURF, 'src', 'bridge.js'), 'utf8'); } catch { return; }
  // 关键配置项有没有被代码读过
  const keys = [
    ['socialV2.selfTime', 'selfTime'],
    ['socialV2.sticker', 'sticker'],
    ['socialV2.context', 'context'],
    ['socialV2.closure', 'closure'],
  ];
  const unused = keys.filter(([label, field]) => cfg.socialV2?.[field] !== undefined && !src.includes(`socialV2?.${field}`) && !src.includes(`socialV2.${field}`));
  if (unused.length) add(1, '配置', `${unused.length} 个配置节没被代码读取`, unused.map((u) => u[0]).join('、'), '字段名变了或白名单没加', '对照源码的 normalize 函数');
  else ok('配置', '关键配置节都被代码读取');
  // 白名单群 vs 实际会话
  const groups = (cfg.allow?.groups || []).map(String);
  const sv = readJson(path.join(STATE, 'social-v2.json'));
  const convs = Object.keys(sv?.conversations || {});
  const activeGroups = convs.filter((k) => k.startsWith('group:')).map((k) => k.slice(6));
  const notWhitelisted = activeGroups.filter((g) => !groups.includes(g));
  if (notWhitelisted.length) add(2, '配置', `${notWhitelisted.length} 个群有会话但不在白名单`, notWhitelisted.join('、'), '白名单改过', '要么加回去，要么清掉会话');
  else ok('配置', `白名单 ${groups.length} 个群，会话 ${activeGroups.length} 个，一致`);
}

// ── G. 学习账本待办 ─────────────────────────────────────────────
function checkLearnLedger() {
  const led = readJson(path.join(STATE, 'learn-ledger.json'));
  const items = Array.isArray(led) ? led : Object.values(led?.items || {});
  if (!items.length) { ok('学习账本', '账本为空'); return; }
  // 2026-11-08 PM：判据原来写死 weight>=2，不读条目自己的 threshold（2.56 等），
  // 把「还没攒够」的条目永久报成 P1（例：「不要应得太直接了」w=2 / threshold=2.56）。
  // 以条目自己的 threshold 为准；没有 threshold 的老条目才退回 2。
  const pending = items.filter((e) => e.stage !== 'adopted' && Number(e.weight || 0) >= Number(e.threshold ?? 2));
  const byKind = {};
  for (const e of items) byKind[e.kind || '?'] = (byKind[e.kind || '?'] || 0) + 1;
  ok('学习账本', `${items.length} 条（${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join('、')}）`);
  if (pending.length) {
    add(1, '学习账本', `${pending.length} 条攒够了但还没进规则核心`,
      pending.slice(0, 5).map((e) => `「${String(e.topic || e.text || '').slice(0, 24)}」w=${e.weight}`).join('；'),
      '需要她自己在日记里"认"一下才入库', '在日记提示里点一下，或手动帮她过一遍');
  }
  // 规则核心 AUTO 段 vs meta
  try {
    const charDir = path.join(HOME, '.dsh', 'surfcore', 'characters');
    const dirs = fs.readdirSync(charDir).filter((d) => d.startsWith('char-'));
    let rulesFile = '';
    for (const d of dirs) {
      const p = path.join(charDir, d, '规则.md');
      if (exists(p)) { rulesFile = p; break; }
    }
    if (rulesFile) {
      const text = fs.readFileSync(rulesFile, 'utf8');
      const ownerBlock = (text.split('<!-- AUTO:owner -->')[1] || '').split('## 群里学到的')[0] || '';
      const fileRules = ownerBlock.split('\n').filter((l) => l.trim().startsWith('- ')).map((l) => l.trim().slice(2));
      const count = fileRules.length;
      const meta = readJson(path.join(STATE, 'rules-meta.json'));
      const metaRules = (Array.isArray(meta) ? meta : meta?.rules || []).map((r) => String(r.text || ''));
      // 比较前归一化：去日期后缀、标点、空格——否则同一句话会因为标点差异被判成两条
      const norm = (t) => String(t).replace(/（\d+\/\d+）\s*$/, '').replace(/[，。；、！？,.;!?\s]/g, '');
      const fileSet = new Set(fileRules.map(norm));
      const onlyMeta = metaRules.filter((t) => !fileSet.has(norm(t)));
      if (onlyMeta.length > 2) {
        // 2026-11-04：以前只报不修。meta 里留着文件已经没有的句子时，
        // 会出现「索引以为这条规矩在生效、她其实根本没看到」（「只属于你和老大的话」就是这么丢的）。
        // 方向固定为 文件 → meta：文件是权威，反向补回去会把清理掉的旧句子捡回来。
        let healed = '';
        try {
          const r = rebuildRulesMeta({ file: rulesFile, metaPath: path.join(STATE, 'rules-meta.json') });
          healed = r.ok ? `已按文件重建 meta（${r.count} 条）` : `重建失败：${r.reason}`;
        } catch (error) {
          healed = `重建异常：${String(error?.message ?? error).slice(0, 60)}`;
        }
        add(1, '规则核心', `${onlyMeta.length} 条 meta 里有、规则文件里没有`, onlyMeta.slice(0, 4).map((t) => t.slice(0, 30)).join('；'), '删规则/改文案时没同步 meta', healed || '需手动清 meta');
      } else {
        ok('规则核心', `AUTO:owner ${count} 条，meta ${metaRules.length} 条（差异 ${onlyMeta.length}）`);
      }
      // 2026-11-08 PM：上限从 config.role.maxInjectChars 读（当前 7200），
      // 不再硬编码 6000/6200——旧口径会一直报假警报。
      const maxInject = (() => {
        try { return Number(readJson(path.join(SURF, 'config.json'))?.role?.maxInjectChars) || 7200; }
        catch { return 7200; }
      })();
      if (text.length > maxInject * 0.96) add(2, '规则核心', `规则文件 ${text.length} 字符（预算 ${maxInject}）`, '余量不足 4%，新教学可能挤不进去', '', '压缩低频条目');
    }
  } catch {}
}

// ── H. 日志异常 ─────────────────────────────────────────────────
function checkLogs() {
  const p = path.join(STATE, 'bridge.log');
  if (!exists(p)) return;
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  const errs = lines.filter((l) => /失败|错误|异常|Error|timeout/.test(l) && !/按概率唤醒|跳过/.test(l));
  if (errs.length > 20) add(1, '日志', `bridge.log 里 ${errs.length} 条异常`, errs.slice(-3).map((l) => l.slice(0, 100)).join(' ｜ '), '', '看上面对应的模块');
  else if (errs.length > 0) add(2, '日志', `${errs.length} 条异常记录`, errs.slice(-2).map((l) => l.slice(0, 100)).join(' ｜ '));
  else ok('日志', '今天没有异常记录');
}

// ── 记忆体量（2026-11-06 加的）──────────────────────────────────
// 热卡满了会往 full.jsonl 归档；归档涨太大会拖慢 recallFullMemory 的全量扫描。
function checkMemorySizes() {
  const dirs = [];
  try {
    const chars = path.join(HOME, '.dsh', 'surfcore', 'characters');
    for (const d of fs.readdirSync(chars)) {
      const m = path.join(chars, d, 'memory');
      if (fs.existsSync(path.join(m, 'memory-card.json'))) dirs.push(m);
    }
  } catch {}
  if (!dirs.length) { ok('记忆', '没找到记忆卡目录'); return; }
  for (const dir of dirs) {
    const card = path.join(dir, 'memory-card.json');
    const full = path.join(dir, 'memory-card-full.jsonl');
    const mb = (f) => { try { return fs.statSync(f).size / 1024 / 1024; } catch { return 0; } };
    const cardMb = mb(card), fullMb = mb(full);
    let n = 0;
    try { n = (JSON.parse(fs.readFileSync(card, 'utf8')).records || []).length; } catch {}
    const tag = path.basename(path.dirname(dir));
    if (fullMb > 500) add(1, '记忆', `${tag} 归档已 ${fullMb.toFixed(0)} MB`, `热卡 ${n} 条 / ${cardMb.toFixed(1)} MB`, '', '给 full.jsonl 加按日期分段，或提高归档压缩');
    else if (fullMb > 200) add(2, '记忆', `${tag} 归档 ${fullMb.toFixed(0)} MB，开始偏大`, `热卡 ${n} 条 / ${cardMb.toFixed(1)} MB`, '', '考虑按日期分段');
    else if (cardMb > 20) add(2, '记忆', `${tag} 热卡 ${cardMb.toFixed(1)} MB`, `${n} 条`, '', '检查 maxRecords 是否设得过大');
    else ok('记忆', `${tag}：热卡 ${n} 条 / ${cardMb.toFixed(1)} MB，归档 ${fullMb.toFixed(1)} MB`);
  }
}

// ── I. 文档路径 ─────────────────────────────────────────────────
function checkDocs() {
  const memDir = path.join(HOME, '.memory');
  const projDir = path.join(memDir, 'projects');
  if (!exists(projDir)) return;
  let broken = 0, samples = [];
  for (const f of fs.readdirSync(projDir).filter((x) => x.endsWith('.md'))) {
    let text = '';
    try { text = fs.readFileSync(path.join(projDir, f), 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/`([~/][^`\n]{6,80})`/g)) {
      let p = m[1].replace(/^~/, HOME).replace(/[:：].*$/, '').trim();
      if (/[*?{}<>$]/.test(p) || /\s/.test(p)) continue;
      if (/^\/(api|dsh-surfcore)\//.test(p)) continue;   // 那是接口不是文件
      if (!exists(p)) {
        // state/ 下的相对路径也要试一次
        if (!exists(path.join(SURF, p))) { broken++; if (samples.length < 5) samples.push(`${f} → ${m[1]}`); }
      }
    }
  }
  if (broken > 8) add(2, '文档', `记忆文档里有 ${broken} 处路径不存在`, samples.join('；'), '文件被移动或改名', '更新文档里的路径');
  else if (broken > 0) ok('文档', `${broken} 处路径失效（可忽略）`);
  else ok('文档', '记忆里的路径都能对上');
}

// ── 主流程 ──────────────────────────────────────────────────────
await checkServices();
await checkQQ();
checkTimers();
checkFreshness();
await checkPromptBlocks();
checkConfig();
checkLearnLedger();
checkLogs();
checkDocs();
checkMemorySizes();

const order = { 0: 0, 1: 1, 2: 2, ok: 9 };
findings.sort((a, b) => order[a.p] - order[b.p]);
const n0 = findings.filter((f) => f.p === 0).length;
const n1 = findings.filter((f) => f.p === 1).length;
const n2 = findings.filter((f) => f.p === 2).length;
const nOk = findings.filter((f) => f.p === 'ok').length;

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ day: dayKey, at: now.toISOString(), n0, n1, n2, nOk, findings }, null, 2));
  process.exit(0);
}

const label = { 0: '**P0 · 影响她正常工作**', 1: '**P1 · 功能没生效 / 跑歪了**', 2: '**P2 · 隐患（可以等等）**', ok: '**正常**' };
const lines = [];
lines.push(`# 夜间体检 · ${dayKey} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`);
lines.push('');
lines.push(`P0 ${n0} · P1 ${n1} · P2 ${n2} · 正常 ${nOk}`);
lines.push('');
for (const level of [0, 1, 2, 'ok']) {
  const group = findings.filter((f) => f.p === level);
  if (!group.length) continue;
  lines.push(`## ${label[level]}`);
  lines.push('');
  for (const f of group) {
    lines.push(`- **${f.area}** ${f.title}`);
    if (f.detail) lines.push(`  - 现状：${f.detail}`);
    if (f.cause) lines.push(`  - 原因：${f.cause}`);
    if (f.fix) lines.push(`  - 可以做：${f.fix}`);
  }
  lines.push('');
}
const report = lines.join('\n');
try {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `${dayKey}.md`), report + '\n');
} catch {}
console.log(report);
