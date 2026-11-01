/**
 * 学习账本（2026-10-30 主人定的：
 *   「教了就学太乖了，和懒的性格不符；现实里要先不情愿，被教多次才真学会，
 *     而且这个『多次』不该是某个具体数值。」
 *
 * 所以：
 *   · 每条要学的东西有自己的阈值，**随机生成**（2.2~4.6），不是一个固定次数；
 *   · 主人的话权重 1.0，群友的话 0.35（她更听主人的）；
 *   · 和已有习惯冲突的，学得更慢（×0.6）；
 *   · 阶段由「权重 / 阈值」推出来，用来决定她话里的态度，而不是硬写次数。
 */

const STAGES = ['resisting', 'aware', 'adopted'];

/** 阈值：同一个主题只生成一次，之后固定（不然她每次表现都不一样）。 */
function thresholdFor(topic, rngSeed = 0) {
  let h = 2166136261 ^ rngSeed;
  for (const ch of String(topic)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  const r = ((h >>> 0) % 1000) / 1000;          // 0~1 稳定伪随机
  return 1.4 + r * 1.6;                          // 1.4 ~ 3.0（原 2.2~4.6：群友要 7~13 次，实际学不会）
}

function normalizeTopic(text) {
  let s = String(text || '')
    .replace(/[「」“”"'（）()、，。！？!?～~\s]/g, '')
    .replace(/^(主人|你|她|喂)+/, '')
    .replace(/^(老是|总是|总|一直|再|又|还|以后|下次|然后|要先)+/, '')
    .replace(/(了|啦|吧|哦|呀|嘛|啊|就行|就好了)+$/, '');
  return s.slice(0, 18);
}

/** 判断一句话是不是在「教她」。命中返回提取出的主题，否则 null。 */
function extractTeaching(text) {
  const s = String(text || '').trim();
  if (s.length < 4) return null;
  const m = s.match(/(?:不要|别再|别在|别老|别总|别|不许|不准|不能|应该|要记着|记得|以后|下次|必须)([^，。！？!?]{2,24})/);
  if (!m) return null;
  const topic = normalizeTopic(m[1]);
  if (!topic || topic.length < 2) return null;
  return { topic, raw: s.slice(0, 80) };
}


/** 字符集合相似度：把「老是在群里发视频」和「在群里发视频」并成同一条。 */
function similarity(a, b) {
  const sa = new Set(String(a)), sb = new Set(String(b));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const c of sa) if (sb.has(c)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

function learnState(item) {
  const thr = Number(item?.threshold) || 3;
  const w = Number(item?.weight) || 0;
  const ratio = thr > 0 ? w / thr : 1;
  if (ratio >= 1) return 'adopted';
  if (ratio >= 0.5) return 'aware';
  return 'resisting';
}

/** 记一次「被教」：返回更新后的条目（纯函数，不改入参）。 */
export function recordTeaching(ledger, { text, isOwner = false, at = Date.now() } = {}) {
  const hit = extractTeaching(text);
  if (!hit) return null;
  const items = { ...(ledger?.items || {}) };
  // 先看有没有「说的是同一件事」的老条目（说法不同也只算同一条）
  let key = hit.topic;
  for (const [k, v] of Object.entries(items)) {
    if (k !== key && similarity(k, hit.topic) >= 0.5) { key = k; break; }
  }
  const prev = items[key] || {
    topic: hit.topic,
    weight: 0,
    taught: 0,
    firstAt: at,
    sources: [],
    threshold: 0,
    examples: [],
  };
  const threshold = prev.threshold || thresholdFor(hit.topic);
  const conflict = prev.stage === 'adopted' && /不要|别再|不能|不许/.test(text) ? 0.6 : 1;
  const gain = (isOwner ? 1.0 : 0.6) * conflict;   // 群友 0.35 → 0.6：原值下同一句要 7~13 次
  const next = {
    ...prev,
    threshold,
    weight: Math.round((Number(prev.weight) + gain) * 100) / 100,
    taught: Number(prev.taught || 0) + 1,
    lastAt: at,
    sources: Array.from(new Set([...(prev.sources || []), isOwner ? 'owner' : 'group'])).slice(-4),
    examples: [...(prev.examples || []), hit.raw].slice(-3),
  };
  next.stage = learnState(next);
  items[key] = next;
  return { ledger: { ...ledger, items }, item: next, changed: !prev.stage || prev.stage !== next.stage };
}

/** 生成注入行：让她知道自己「正处在学的哪个阶段」，态度由阶段决定。 */
export function learnPromptLine(ledger, { limit = 3 } = {}) {
  const items = Object.entries(ledger?.items || {})
    .map(([k, v]) => ({ key: k, ...v, stage: v.stage || learnState(v) }))
    // 2026-11-01：从「最近被教」改成「最可能在用的优先」——
    // 已经成习惯的（adopted）先出现，其次有印象的，最后是还没当回事的；同阶段按时间。
    // 但留一个口子：最近 3 天新教的东西至少出现一条，否则新学永远轮不到。
    .sort((a, b) => {
      const rank = (it) => (it.stage === 'adopted' ? 2 : it.stage === 'aware' ? 1 : 0);
      return (rank(b) - rank(a)) || ((b.lastAt || 0) - (a.lastAt || 0));
    })
    .slice(0, limit);
  // 最近的新条目如果被挤出榜单，用它替换最后一条，保证新学的至少露一次脸
  try {
    const all = Object.entries(ledger?.items || {})
      .map(([k, v]) => ({ key: k, ...v, stage: v.stage || learnState(v) }));
    const fresh = all.filter((x) => Date.now() - Number(x.lastAt || 0) < 3 * 24 * 3600e3)
      .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))[0];
    if (fresh && !items.some((x) => x.key === fresh.key) && items.length) {
      items[items.length - 1] = fresh;
    }
  } catch {}
  if (!items.length) return '';
  // 2026-11-01：不再报「被说过几次」——那会让她把学习当成绩单。
  // 被别人问「你学了啥」时，她 10-26 就是列清单，被群友说「鱼八股」。
  const rows = items.map((it) => {
    if (it.stage === 'resisting') return `- 「${it.key}」：你还没太当回事。`;
    if (it.stage === 'aware') return `- 「${it.key}」：有点印象，但还会忘。`;
    return `- 「${it.key}」：已经习惯了。`;
  });
  return `【最近有人跟你说过的】\n${rows.join('\n')}\n（这不是成绩单，别拿去汇报，也别报「被说过几次」。别人问起，说「记不清了」「就那样」都行；没到习惯之前，允许自己嫌麻烦、忘掉。）\n\n`;
}

export const __test = { thresholdFor, normalizeTopic, extractTeaching, learnState };
