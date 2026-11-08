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

// 预置核心主题。keywords 越靠前权重越高。
// 这张表是示例：换成你自己角色群里常聊的话题，主题地图才有用。
export const CORE_TOPICS = [
  { name: '角色设定', keywords: ['设定', '性格', '喜欢', '讨厌'] },
  { name: '头像', keywords: ['头像', 'qlogo', '自拍'] },
  { name: '爱好', keywords: ['新番', '动画', '游戏', '卡池', '演唱会'] },
  { name: '群里的规矩', keywords: ['群里别', '不在群里', '别在群里', '私聊', '转述', '规矩', '规则'] },
  { name: '玩闹', keywords: ['啵', '逗', '玩笑', '耍赖', '欺负', '损'] },
  { name: '表情包', keywords: ['表情'] },
  { name: 'B站和兴趣', keywords: ['B站', 'bili', '视频', 'up主'] },
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

/** 从卡里重建主题文件。返回 { changed: [文件名], topics: n, facts: n } */
export function rebuildTopics(card, memoryDir, now = Date.now()) {
  const paths = resolveTopicPaths(memoryDir);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.mkdirSync(paths.runs, { recursive: true });

  const buckets = new Map(CORE_TOPICS.map((t) => [t.name, []]));
  // 噪声过滤：回顾摘要、体检报告、整理日志都不是「事实」，放进来会让目录变糊
  const NOISE = /(里聊到|你自己说了|没干啥|规则退成印象|体检跑完|记忆整理|助手指令|\[助手\])/;
  for (const record of card?.records || []) {
    if (String(record?.source || '') === 'digest') continue;
    const body = `${record?.title || ''} ${record?.text || ''}`;
    if (NOISE.test(body)) continue;
    const name = classifyRecord(record);
    if (!name) continue;
    buckets.get(name).push(record);
  }

  // 每个主题：按时间倒序，最多 40 条；同一天同一句去重
  const files = new Map();
  const filesMeta = new Map();
  const filesPublicMeta = new Map();
  for (const [name, records] of buckets) {
    const sorted = records.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    const seen = new Set();
    const lines = [];
    // 索引里那行要挑「最重要的一条」，不是最新那条（最新常常是碎片）
    let top = sorted[0];
    for (const r of sorted) if ((Number(r.importance) || 0) > (Number(top?.importance) || 0)) top = r;
    filesMeta.set(name, top);
    // 群聊视角样本：只从 group/public 来源的记录里挑；挑不到 → 这个主题不进群目录。
    let topPublic = null;
    for (const r of sorted) {
      if (!canEnterGroupView(r)) continue;
      if ((Number(r.importance) || 0) > (Number(topPublic?.importance) || 0)) topPublic = r;
    }
    filesPublicMeta.set(name, topPublic);
    for (const r of sorted) {
      const line = factLine(r);
      if (!line || seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
      if (lines.length >= MAX_FACTS_PER_TOPIC) break;
    }
    if (STATE_TOPICS.has(name) && lines.length > 1) {
      for (let i = 1; i < lines.length; i += 1) lines[i] = `${lines[i]}（已被取代）`;
    }
    const body = [
      `# ${name}`,
      '',
      `> 自动从记忆卡整理（${new Date(now).toLocaleString('zh-CN', { hour12: false })}）。带日期，越靠前越新。`,
      '> 想改的话，直接改这个文件；下次重建会保留手写段（`## 手写` 之后的内容）。',
      '',
      ...lines,
      '',
    ].join('\n');
    files.set(name, body);
  }

  const changed = [];
  // 快照 + 写盘
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const snapDir = path.join(paths.snapshots, stamp);
  fs.mkdirSync(snapDir, { recursive: true });
  for (const [name, body] of files) {
    const file = path.join(paths.dir, `${safeName(name)}.md`);
    let old = '';
    try { old = fs.readFileSync(file, 'utf8'); } catch {}
    // 只认「整行就是 ## 手写」的那种小节；之前用 includes 判断，
    // 结果匹配到文件头说明里那串带反引号的文字，每次重建都把正文复制一遍。
    const manualMatch = old.match(/^## 手写\s*$/m);
    const manual = manualMatch ? `\n${old.slice(manualMatch.index).trim()}\n` : '';
    const finalBody = manual ? `${body}${manual}` : body;
    if (finalBody !== old) {
      if (old) fs.writeFileSync(path.join(snapDir, `${safeName(name)}.md`), old, 'utf8');
      fs.writeFileSync(file, finalBody, 'utf8');
      changed.push(`${safeName(name)}.md`);
    }
  }

  // 索引
  const indexLines = ['# 记忆主题索引', '', '> 一行一主题。细节在各主题文件里；记不清就说记不清，别编。', ''];
  for (const [name, body] of files) {
    const facts = body.split('\n').filter((l) => l.startsWith('- '));
    if (!facts.length) continue;
    const latest = facts[0].slice(2, 12);
    const topRec = filesMeta.get(name);
    const topText = String(topRec?.text || '').replace(/\s+/g, ' ').slice(0, 46);
    const sample = topText || facts[0].slice(13).slice(0, 46);
    indexLines.push(`- **${name}**（${facts.length} 条，最近 ${latest}）：${sample}`);
  }
  const indexBody = `${indexLines.join('\n')}\n`;
  let oldIndex = '';
  try { oldIndex = fs.readFileSync(paths.index, 'utf8'); } catch {}
  if (oldIndex !== indexBody) {
    if (oldIndex) fs.writeFileSync(path.join(snapDir, '_index.md'), oldIndex, 'utf8');
    fs.writeFileSync(paths.index, indexBody, 'utf8');
    changed.push('_index.md');
  }

  // 群聊视角目录（task-12）：只列有 group/public 样本的主题，样本也只取群来源记录。
  const groupIndexLines = ['# 记忆主题索引（群聊视角）', '', '> 一行一主题：只列群里发生过/公开的事；没有合适样本的主题不列。', ''];
  let groupTopics = 0;
  for (const [name, body] of files) {
    const facts = body.split('\n').filter((l) => l.startsWith('- '));
    if (!facts.length) continue;
    const pubRec = filesPublicMeta.get(name);
    const sample = String(pubRec?.text || '').replace(/\s+/g, ' ').slice(0, 46);
    if (!sample) continue;
    const latest = facts[0].slice(2, 12);
    groupIndexLines.push(`- **${name}**（${facts.length} 条，最近 ${latest}）：${sample}`);
    groupTopics += 1;
  }
  const groupIndexBody = `${groupIndexLines.join('\n')}\n`;
  let oldGroupIndex = '';
  try { oldGroupIndex = fs.readFileSync(paths.indexGroup, 'utf8'); } catch {}
  if (oldGroupIndex !== groupIndexBody) {
    if (oldGroupIndex) fs.writeFileSync(path.join(snapDir, '_index-group.md'), oldGroupIndex, 'utf8');
    fs.writeFileSync(paths.indexGroup, groupIndexBody, 'utf8');
    changed.push('_index-group.md');
  }

  // 审计
  const audit = {
    at: new Date(now).toISOString(),
    topics: files.size,
    groupTopics,
    facts: [...files.values()].reduce((n, b) => n + b.split('\n').filter((l) => l.startsWith('- ')).length, 0),
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
      .filter((f) => f.endsWith('.md') && f !== '_index.md')
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
