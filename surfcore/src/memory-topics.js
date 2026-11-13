// 记忆主题层（2026-11-06）
// 起因：claude cookbook 的「dreaming」把记忆做成 wiki 式小文件 + _index.md，
// 下次会话只读挂载。我们的卡是 2000 条平铺记录、注入只能截 2800 字。
// 这里补一层「按主题切文件 + 索引」：索引必看，细节按需读。
//
// 结构：
//   memory/topics/_index.md        一行一主题
//   memory/topics/<主题>.md        带日期的事实行，旧的可以被标 superseded
//   memory/runs/<时间戳>.json      每次重建改了哪些文件（可审计）
//   memory/runs/snapshots/<时间戳>/  重建前的旧文件
import fs from 'node:fs';
import path from 'node:path';
// 2026-11-08（task-12）：主题索引也要分视图——群聊注入只列「群里能说」的样本，
// 私聊样本只在私聊视图的 _index.md 里。来源判断复用 memory-card 的 originKindOf。
import { canEnterGroupView, originKindOf } from './memory-card.js';

// 核心主题：老大定的那几个（B 方案）。keywords 越靠前权重越高。
export const CORE_TOPICS = [
  { name: '群友A', keywords: ['群友A'] },
  { name: '头像', keywords: ['头像', 'qlogo', '自拍'] },
  { name: '学马', keywords: ['学马', '学园偶像大师', '美铃', '千奈', '卡池', 'フェス', '初星'] },
  { name: '群里的规矩', keywords: ['群里别', '不在群里', '别在群里', '私聊', '转述', '规矩', '规则'] },
  { name: '玩闹', keywords: ['啵', '逗', '玩笑', '耍赖', '欺负', '损'] },
  { name: '表情包', keywords: ['表情'] },
  { name: 'B站和兴趣', keywords: ['B站', 'bili', '视频', ''] },
  { name: '画画', keywords: ['画画', '画一', '画了', '生图', '出图', '画张'] },
  { name: '这台机器', keywords: ['DSH', '助手', '桥接', 'token', '额度'] },
];

const MAX_FACTS_PER_TOPIC = 40;

// 「状态型」主题：只有最新一条算数，旧的要标成已被取代（CLAUDE cookbook 里那条「事实会过期」）。
const STATE_TOPICS = new Set(['头像']);

export function resolveTopicPaths(memoryDir) {
  const dir = path.join(memoryDir, 'topics');
  const runs = path.join(memoryDir, 'runs');
  return {
    dir,
    index: path.join(dir, '_index.md'),
    // 群聊视角索引：只含「群里能说」的样本；没有合适样本的主题不列（task-12）。
    indexGroup: path.join(dir, '_index-group.md'),
    runs,
    snapshots: path.join(runs, 'snapshots'),
  };
}

function safeName(name) {
  return String(name || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || '未命名';
}

function dayOf(record) {
  return String(record?.createdAt || '').slice(0, 10) || '';
}

/** 把一条记录归类到主题；命中多个取第一个（核心主题按顺序优先）。 */
export function classifyRecord(record) {
  const body = `${record?.title || ''} ${record?.text || ''}`;
  for (const t of CORE_TOPICS) {
    if (t.keywords.some((k) => body.includes(k))) return t.name;
  }
  return '';
}

/** 一条记录 → 一行事实（去掉换行，压到 80 字）。 */
function factLine(record) {
  const day = dayOf(record);
  const text = String(record?.text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!day || !text) return '';
  return `- ${day} ${text}`;
}

// ── 2026-11-09（task-9 B3）：主题 wiki 升级（累积 + 结论式索引 + 规则档案进目录）──────
// 旧实现每次只从热卡重建：卡里记录一淘汰，旧事实就消失（facts 在 190~250 波动），
// 索引也只是「最原话前 46 字」。现在：
//   · 累积：读现有主题页事实，与新事实合并去重（40 条/主题上限），历史不再随热卡蒸发；
//   · 结论式索引：`- **主题**（N 条，最近 D）：<≤32 字结论>`（## 摘要 > 状态主题最新事实 >
//     规则型短句 > 完整短句 > 截断兜底）；
//   · 规则档案：`规则-*.md`（机制岗 task-8 归档）以「规矩档案」小节进目录，不重写它们；
//   · 群聊目录 `_index-group.md`：结论只从 group/public 来源事实取，避免私聊样本进群。
const MAX_CONCLUSION_CHARS = 32;
const INDEX_SOFT_MAX_CHARS = 1000; // readTopicIndex 注入上限 1100，留余量防截半行
const RULE_LIKE_RE = /记得|以后|别|不要|不准|先|要|规矩|规则|说好|约定|注意|不能|可以|该|最好/;
const SENTENCE_END_RE = /[。！？!?）)]$/;

/** 解析主题页里的一行事实。 */
function parseFactLine(line) {
  const m = String(line).match(/^- (\d{4}-\d{2}-\d{2}) (?:\[([a-z]+)\] )?(.+)$/);
  if (!m) return null;
  const text = String(m[3]).trim();
  return { date: m[1], status: m[2] || '', text, superseded: /（已被取代/.test(text) };
}

function stripMarkers(text) {
  return String(text || '')
    .replace(/（已被取代[^）]*）/g, '')
    .replace(/^（触发：.*$/u, '')
    .trim();
}

function normFactKey(text) {
  return stripMarkers(text).replace(/\s+/g, '').slice(0, 40);
}

function shortenConclusion(text, max = MAX_CONCLUSION_CHARS) {
  let t = String(text || '')
    .replace(/^@[^\s]+[\s:：]*/u, '')
    .replace(/（已被取代[^）]*）/g, '')
    .trim();
  if (t.length <= max) return t;
  const window = t.slice(0, max);
  const sentence = window.match(/^([\s\S]*?[。！？；])/);
  if (sentence && sentence[1].length >= 8) return sentence[1].replace(/[。！？；]$/, '');
  const clause = window.match(/^([\s\S]*?[，,])/);
  if (clause && clause[1].length >= 10) return clause[1].replace(/[，,]$/, '');
  return `${t.slice(0, max - 2)}…`;
}

/** 从一组事实里挑一句「结论」。确定性，无模型。 */
function pickConclusion(facts, { stateTopic = false, isRuleArchive = false, summary = '' } = {}) {
  if (summary) return { text: shortenConclusion(summary, 80), source: 'summary' };
  const list = Array.isArray(facts) ? facts : [];
  if (isRuleArchive && list.length) return { text: shortenConclusion(stripMarkers(list[0].text), 40), source: 'rule-archive' };
  if (stateTopic && list.length) {
    for (const f of list.slice(0, 3)) {
      const t = stripMarkers(f.text);
      if (t.length >= 6 && t.length <= MAX_CONCLUSION_CHARS) return { text: t, source: 'state-latest' };
    }
    return { text: shortenConclusion(list[0].text), source: 'state-latest-trunc' };
  }
  const ruleLike = list.filter((f) => {
    const t = stripMarkers(f.text);
    return t.length >= 12 && t.length <= 34 && RULE_LIKE_RE.test(t);
  });
  ruleLike.sort((a, b) => (Number(SENTENCE_END_RE.test(stripMarkers(b.text))) - Number(SENTENCE_END_RE.test(stripMarkers(a.text)))));
  if (ruleLike.length) return { text: stripMarkers(ruleLike[0].text), source: 'rule-like' };
  const shortSentence = list.filter((f) => {
    const t = stripMarkers(f.text);
    return t.length >= 10 && t.length <= MAX_CONCLUSION_CHARS;
  });
  shortSentence.sort((a, b) => (Number(SENTENCE_END_RE.test(stripMarkers(b.text))) - Number(SENTENCE_END_RE.test(stripMarkers(a.text)))));
  if (shortSentence.length) return { text: stripMarkers(shortSentence[0].text), source: 'short-sentence' };
  if (list.length) return { text: shortenConclusion(list[0].text), source: 'latest-fragment' };
  return { text: '', source: 'empty' };
}

/** 读现有主题页的摘要段/手写段（重建时逐字节保留手写，摘要作为结论优先级最高）。 */
function readPreservedSections(body) {
  const old = String(body || '');
  const manualMatch = old.match(/^## 手写\s*$/m);
  const manual = manualMatch ? `\n${old.slice(manualMatch.index).trim()}\n` : '';
  const summaryMatch = old.match(/^## 摘要\s*\n([\s\S]*?)(?:\n## |\n*$)/m);
  const summary = summaryMatch
    ? summaryMatch[1].split('\n').map((l) => l.replace(/^-\s*/, '').trim()).filter(Boolean)[0] || ''
    : '';
  return { manual, summary };
}

/** 合并现有文件事实 + 卡内新事实（按 日期+归一化文本 去重；现有措辞优先）。 */
function mergeFacts(existingFacts, incomingFacts, cap = MAX_FACTS_PER_TOPIC) {
  const byKey = new Map();
  for (const f of existingFacts) {
    if (!f) continue;
    const key = `${f.date}|${normFactKey(f.text)}`;
    if (!byKey.has(key)) byKey.set(key, { ...f, from: 'file' });
  }
  let added = 0;
  for (const f of incomingFacts) {
    const key = `${f.date}|${normFactKey(f.text)}`;
    if (byKey.has(key)) {
      const cur = byKey.get(key);
      if (!cur.originKind) cur.originKind = f.originKind;
      cur.importance = Math.max(Number(cur.importance) || 0, Number(f.importance) || 0);
      continue;
    }
    byKey.set(key, { ...f, from: 'card' });
    added += 1;
  }
  const merged = [...byKey.values()]
    .sort((a, b) => (String(b.date).localeCompare(String(a.date))) || ((Number(b.importance) || 0) - (Number(a.importance) || 0)));
  return { facts: merged.slice(0, cap), added, total: merged.length };
}

/** 索引行：一行一主题 + 一句结论。 */
function indexLineFor(name, facts, conclusion, { withRulePrefix = false } = {}) {
  const latest = facts.length ? facts[0].date : '—';
  const label = withRulePrefix ? name.replace(/^规则-/, '') : name;
  return `- **${label}**（${facts.length} 条，最近 ${latest}）：${conclusion}`;
}

function writeWithSnapshot(paths, file, body, oldBody, snapDir, name, changed) {
  if (body === oldBody) return false;
  if (oldBody) {
    try { fs.mkdirSync(snapDir, { recursive: true }); fs.writeFileSync(path.join(snapDir, name), oldBody, 'utf8'); } catch {}
  }
  fs.writeFileSync(file, body, 'utf8');
  changed.push(name);
  return true;
}

/** 从卡里重建主题文件（累积 + 结论式索引 + 规则档案进目录）。 */
export function rebuildTopics(card, memoryDir, now = Date.now()) {
  const paths = resolveTopicPaths(memoryDir);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.mkdirSync(paths.runs, { recursive: true });

  // ① 卡内新事实（按核心主题分桶）
  const NOISE = /(里聊到|你自己说了|没干啥|规则退成印象|体检跑完|记忆整理|助手指令|\[助手\])/;
  const buckets = new Map(CORE_TOPICS.map((t) => [t.name, []]));
  for (const record of card?.records || []) {
    if (String(record?.source || '') === 'digest') continue;
    const body = `${record?.title || ''} ${record?.text || ''}`;
    if (NOISE.test(body)) continue;
    const name = classifyRecord(record);
    if (!name) continue;
    const day = dayOf(record);
    const text = String(record?.text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!day || !text) continue;
    buckets.get(name).push({
      date: day,
      text,
      importance: Number(record.importance) || 0,
      originKind: originKindOf(record),
      recordId: record.id,
      createdAt: String(record.createdAt || ''),
    });
  }

  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const snapDir = path.join(paths.snapshots, stamp);
  const changed = [];
  const topicStats = [];
  const groupFactsByTopic = new Map();

  // ② 逐主题：读旧文件 → 合并累积 → 结论 → 写盘（保留摘要/手写段）
  for (const t of CORE_TOPICS) {
    const name = t.name;
    const file = path.join(paths.dir, `${safeName(name)}.md`);
    let old = '';
    try { old = fs.readFileSync(file, 'utf8'); } catch {}
    const preserved = readPreservedSections(old);
    const existingFacts = old.split('\n').filter((l) => l.startsWith('- ')).map(parseFactLine).filter(Boolean);
    const incoming = buckets.get(name) || [];
    const merged = mergeFacts(existingFacts, incoming);
    let facts = merged.facts;
    // 状态型主题：只保留最新一条算数，其余标已取代（先清旧标记再按最新重标）
    if (STATE_TOPICS.has(name) && facts.length > 1) {
      const newestDate = facts[0].date;
      facts = facts.map((f, i) => ({
        ...f,
        text: i === 0 ? stripMarkers(f.text) : `${stripMarkers(f.text)}（已被取代 ${newestDate}）`,
      }));
    }
    // 群聊视角：只用本轮 from=card 且 group/public 来源的事实（旧文件事实来源未知，不进群结论）
    // 群聊视角：只取已知 group/public 来源的事实（旧文件事实若本轮能从卡里匹配到，originKind 会被补上；
    // 匹配不上 = originKind 未知 → 不进群结论，宁缺毋滥）。
    const groupFacts = facts.filter((f) => f.originKind === 'group' || f.originKind === 'public');
    groupFactsByTopic.set(name, groupFacts);
    const conclusion = pickConclusion(facts, { stateTopic: STATE_TOPICS.has(name), summary: preserved.summary });
    const lines = facts.map((f) => {
      const status = f.status ? `[${f.status}] ` : '';
      return `- ${f.date} ${status}${f.text}`;
    });
    const body = [
      `# ${name}`,
      '',
      `> 自动从记忆卡整理（${new Date(now).toLocaleString('zh-CN', { hour12: false })}；累积模式，重建保留历史事实与手写段）。带日期，越靠前越新。`,
      '',
      ...(preserved.summary ? ['## 摘要', `- ${preserved.summary}`, ''] : []),
      ...lines,
      '',
    ].join('\n');
    const finalBody = preserved.manual ? `${body}${preserved.manual}` : body;
    writeWithSnapshot(paths, file, finalBody, old, snapDir, `${safeName(name)}.md`, changed);
    topicStats.push({
      name,
      latest: facts.length ? facts[0].date : '—',
      facts: facts.length,
      beforeFacts: existingFacts.length,
      added: merged.added,
      dropped: merged.total - merged.facts.length,
      conclusion: conclusion.text,
      conclusionSource: conclusion.source,
      hasSummary: Boolean(preserved.summary),
      groupFacts: groupFacts.length,
    });
  }

  // ③ 规则档案（机制岗 task-8 归档页）：不重写，只读进索引
  const ruleArchives = [];
  try {
    for (const f of fs.readdirSync(paths.dir).filter((x) => x.startsWith('规则-') && x.endsWith('.md')).sort()) {
      const body = fs.readFileSync(path.join(paths.dir, f), 'utf8');
      const facts = body.split('\n').filter((l) => l.startsWith('- ')).map(parseFactLine).filter(Boolean);
      const preserved = readPreservedSections(body);
      const conclusion = pickConclusion(facts, { isRuleArchive: true, summary: preserved.summary });
      if (!conclusion.text) continue;
      ruleArchives.push({ name: f.replace(/\.md$/, ''), facts: facts.length, conclusion: conclusion.text, conclusionSource: conclusion.source });
    }
  } catch {}

  // ④ 索引（私聊）：核心主题结论 + 规矩档案小节；软上限 1000 字防注入截半行
  const buildIndex = ({ group = false } = {}) => {
    const lines = [group ? '# 记忆主题索引（群聊视角）' : '# 记忆主题索引', ''];
    lines.push(group
      ? '> 一行一主题：只列群里发生过/公开的事；没有合适样本的主题不列。'
      : '> 一行一主题，带一句结论。细节在各主题文件里；记不清就说记不清，别编。');
    lines.push('');
    let topics = 0;
    for (const stat of topicStats) {
      const groupFacts = groupFactsByTopic.get(stat.name) || [];
      if (group) {
        if (stat.hasSummary) {
          lines.push(indexLineFor(stat.name, groupFacts.length ? groupFacts : [{ date: stat.latest }], stat.conclusion));
          topics += 1;
          continue;
        }
        if (!groupFacts.length) continue;
        const gConc = pickConclusion(groupFacts, { stateTopic: STATE_TOPICS.has(stat.name) });
        lines.push(indexLineFor(stat.name, groupFacts, gConc.text));
        topics += 1;
      } else {
        if (!stat.facts) continue;
        lines.push(`- **${stat.name}**（${stat.facts} 条，最近 ${stat.latest}）：${stat.conclusion}`);
        topics += 1;
      }
    }
    if (ruleArchives.length) {
      lines.push('', '## 规矩档案');
      for (const ra of ruleArchives) lines.push(`- **${ra.name.replace(/^规则-/, '')}**（${ra.facts} 条）：${ra.conclusion}`);
    }
    return { lines, topics };
  };
  const privateIndex = buildIndex({ group: false });
  const groupIndex = buildIndex({ group: true });
  let indexBody = `${privateIndex.lines.join('\n')}\n`;
  let groupIndexBody = `${groupIndex.lines.join('\n')}\n`;

  // 软上限：先压结论长度 → 再从「规矩档案」尾部删 → 再从主题尾部删；绝不把行截一半。
  const HARD_INDEX_MAX = 1080; // readTopicIndex 注入上限 1100，留 20 字余量
  const fitIndex = (body) => {
    let lines = String(body).split('\n');
    const length = () => lines.join('\n').length;
    if (length() <= INDEX_SOFT_MAX_CHARS) return `${lines.join('\n')}\n`;
    // 第一轮：结论压到 20 字
    lines = lines.map((l) => (l.startsWith('- ') ? l.replace(/：(.+)$/, (m, p1) => `：${shortenConclusion(p1, 20)}`) : l));
    if (length() <= INDEX_SOFT_MAX_CHARS) return `${lines.join('\n')}\n`;
    // 第二轮：从后往前删「规矩档案」小节的条目
    const ruleStart = lines.findIndex((l) => l.trim() === '## 规矩档案');
    if (ruleStart >= 0) {
      for (let i = lines.length - 1; i > ruleStart && length() > INDEX_SOFT_MAX_CHARS; i -= 1) {
        if (lines[i].startsWith('- ')) lines.splice(i, 1);
      }
    }
    if (length() <= INDEX_SOFT_MAX_CHARS) return `${lines.join('\n')}\n`;
    // 第三轮：从后往前删主题条目（保头部说明）
    for (let i = lines.length - 1; i > 0 && length() > HARD_INDEX_MAX; i -= 1) {
      if (lines[i].startsWith('- ')) lines.splice(i, 1);
    }
    return `${lines.join('\n')}\n`;
  };
  indexBody = fitIndex(indexBody);
  groupIndexBody = fitIndex(groupIndexBody);

  let oldIndex = '';
  try { oldIndex = fs.readFileSync(paths.index, 'utf8'); } catch {}
  writeWithSnapshot(paths, paths.index, indexBody, oldIndex, snapDir, '_index.md', changed);
  let oldGroupIndex = '';
  try { oldGroupIndex = fs.readFileSync(paths.indexGroup, 'utf8'); } catch {}
  writeWithSnapshot(paths, paths.indexGroup, groupIndexBody, oldGroupIndex, snapDir, '_index-group.md', changed);

  // ⑤ 审计
  const audit = {
    at: new Date(now).toISOString(),
    topics: topicStats.length,
    groupTopics: groupIndex.topics,
    facts: topicStats.reduce((n, t) => n + t.facts, 0),
    factsAdded: topicStats.reduce((n, t) => n + t.added, 0),
    factsDropped: topicStats.reduce((n, t) => n + t.dropped, 0),
    ruleArchives: ruleArchives.length,
    indexChars: indexBody.length,
    groupIndexChars: groupIndexBody.length,
    conclusions: topicStats.reduce((a, t) => { a[t.conclusionSource] = (a[t.conclusionSource] || 0) + 1; return a; }, {}),
    changed,
    snapshot: changed.length ? stamp : null,
  };
  try {
    fs.writeFileSync(path.join(paths.runs, `${stamp}.json`), JSON.stringify(audit, null, 2), 'utf8');
  } catch {}

  return audit;
}

/**
 * 读索引（给提示词注入用）。
 * view='group' 时读群聊视角索引（_index-group.md）：只含群里能说的样本；
 * 文件不存在就返回空——宁可这次没有目录，也不把私聊样本注入群聊。
 */
export function readTopicIndex(memoryDir, maxChars = 1200, { view = 'private' } = {}) {
  const paths = resolveTopicPaths(memoryDir);
  const file = view === 'group' ? paths.indexGroup : paths.index;
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  } catch {
    return '';
  }
}

/** 列出主题（内存里读，给工具用）。 */
export function listTopics(memoryDir) {
  const paths = resolveTopicPaths(memoryDir);
  try {
    return fs.readdirSync(paths.dir)
      .filter((f) => f.endsWith('.md') && f !== '_index.md' && f !== '_index-group.md')
      .map((f) => {
        const body = fs.readFileSync(path.join(paths.dir, f), 'utf8');
        const facts = body.split('\n').filter((l) => l.startsWith('- '));
        return { name: f.replace(/\.md$/, ''), facts: facts.length, latest: facts[0] ? facts[0].slice(2, 12) : '' };
      });
  } catch {
    return [];
  }
}

/** 读一个主题的正文。 */
export function readTopic(memoryDir, name) {
  const paths = resolveTopicPaths(memoryDir);
  const file = path.join(paths.dir, `${safeName(name)}.md`);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** 在主题文件里搜关键词，返回 [{ topic, line }]。 */
export function searchTopics(memoryDir, query, limit = 12) {
  const q = String(query || '').trim();
  if (!q) return [];
  const paths = resolveTopicPaths(memoryDir);
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(paths.dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
  for (const f of files) {
    let body = '';
    try { body = fs.readFileSync(path.join(paths.dir, f), 'utf8'); } catch { continue; }
    for (const line of body.split('\n')) {
      if (!line.startsWith('- ')) continue;
      if (!line.includes(q)) continue;
      out.push({ topic: f.replace(/\.md$/, ''), line: line.slice(2, 140) });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** 把一条新事实写进某个主题（digest 用）。同主题里明显冲突的旧行会被标 superseded。 */
export function appendTopicFact(memoryDir, topicName, fact, { at = new Date(), supersede = [] } = {}) {
  const paths = resolveTopicPaths(memoryDir);
  fs.mkdirSync(paths.dir, { recursive: true });
  const name = safeName(topicName);
  const file = path.join(paths.dir, `${name}.md`);
  let body = '';
  try { body = fs.readFileSync(file, 'utf8'); } catch {}
  if (!body) {
    body = `# ${topicName}\n\n> 自动整理。带日期，越靠前越新。\n\n`;
  }
  const day = at.toISOString().slice(0, 10);
  const line = `- ${day} ${String(fact).replace(/\s+/g, ' ').slice(0, 120)}`;
  const lines = body.split('\n');
  // supersede：把旧行标成「已被取代」
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    if (!l.startsWith('- ') || l.includes('（已被取代')) continue;
    if (supersede.some((k) => l.includes(k))) {
      lines[i] = `${l}（已被取代 ${day}）`;
    }
  }
  // 新行插在第一个空行之后（标题下方），保持“新的在上前”
  const insertAt = Math.max(2, lines.findIndex((l, idx) => idx > 1 && l === ''));
  lines.splice(insertAt + 1, 0, line);
  const out = lines.join('\n');
  fs.writeFileSync(file, out, 'utf8');
  return { file, line };
}
