/**
 * 学习账本（2026-10-30 老大定的：
 *   「教了就学太乖了，和懒的性格不符；现实里要先不情愿，被教多次才真学会，
 *     而且这个『多次』不该是某个具体数值。」
 *
 * 所以：
 *   · 每条要学的东西有自己的阈值，**随机生成**（2.2~4.6），不是一个固定次数；
 *   · 主人的话权重 1.0，群友的话 0.35（她更听老大的）；
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
  // 2026-11-02：原来会把标点全删掉再截 18 字，结果账本里全是「是不会理解的」这种半句。
  // 现在只去掉首尾的引号/标点和称呼，中间保留——topic 是要给人（和她）看的，不是哈希。
  let s = String(text || '')
    .replace(/^[「」“”"'（）()【】\s、，。！？!?～~]+/, '')
    .replace(/^(老大|主人|角色|喂)+/, '')
    .replace(/^(老是|总是|总|一直|再|又|还|以后|下次|然后|要先)+/, '')
    .replace(/[「」“”"'（）()【】\s]+$/, '')
    .replace(/(啦|哦|呀|嘛|啊|就行了|就好了)+$/, '');
  return s.slice(0, 40);
}

/**
 * 判断一句话是不是在「教她」。命中返回提取出的主题，否则 null。
 *
 * 2026-11-02 分两档（老大之前那句「只有否定句算教学，大多数教学会被略过」是对的）：
 *
 *   strict = true   只认否定 / 禁止句。给**群里**用——群友的闲聊、玩梗、复读很容易
 *                   长得像「教」，严一点宁可漏。
 *   strict = false  认「教学语气」：不要/别/应该/以后/记得/可以…。给**老大**用——
 *                   他教的大多数是正面表述（「心情好可以给我发语音包」「看到复读就跟着复读」），
 *                   只认否定句会把它们全漏掉。他有事就说，本来就少，放宽的代价很低。
 *
 * 两档共用同一组安全闸：问句、太短、语气词结尾、纯虚词、半截连词。
 */
function extractTeaching(text, { strict = true } = {}) {
  const s = String(text || '').trim();
  if (s.length < 4) return null;
  // ① 问句不是规矩：「有什么想法呢？」「碰的我模型吗」「别人和你啵你就啵了吗」
  if (/[？?]\s*$/.test(s)) return null;
  const KEYS = strict
    ? /(?:不要|别再|别在|别老|别总|别这样|别把|别给|不许|不准|不能|绝对不能|绝不能|不可以)([^，。！？!?]{2,30})/
    : /(?:不要|别再|别在|别老|别总|别这样|别把|别给|不许|不准|不能|不可以|应该|以后|下次|记得|记住|千万别|绝不|要记着|可以)([^，。！？!?]{2,30})/;
  const m = s.match(KEYS);
  if (!m) return null;
  // 2026-11-02：原来 topic = 关键词后面那截 30 字，于是
  //   「不要挑着看，看主线要连贯着看」 → 「挑着看」
  //   「拒绝人太明显啦，其实可以反问的」 → 「反问的」
  // 现在改成「含关键词的完整一句」；太短就往前带一句补主语。
  const parts = s.split(/[，,。！!；;]/).map((x) => x.trim()).filter(Boolean);
  let line = parts.find((p) => KEYS.test(p)) || s;
  if (line.length < 8 && parts.length > 1) {
    const i = parts.indexOf(line);
    if (i > 0) line = `${parts[i - 1]}，${line}`;
  }
  let topic = normalizeTopic(line);
  // ② 太短的没信息量，但「别这样」「发群里」这种短的也可能是真规矩，门槛放到 3
  if (!topic || topic.length < 3) return null;
  // ③ 语气词结尾 = 没说完
  // 2026-11-04：「吧」单独处理。它是祈使句里最常见的软化词
  //（「以后大半夜尽量做自己的事情吧」「半夜别给我留言吧」），
  // 一刀切会把真规矩漏掉——老大 11-04 早上教的那句就是这么丢的。
  // 去掉「吧」之后太短、又没有禁止词的，才是真的没说完。
  if (/[呢吗呀啊嘛]$/.test(topic)) return null;
  if (/吧$/.test(topic)) {
    const core = topic.replace(/[吧\s]+$/, '');
    const prohibitive = /(不要|别|不许|不准|不能|不可以)/.test(core);
    if (core.length < 3) return null;
    if (core.length < 6 && !prohibitive) return null;
    topic = core;
  }
  // ④ 纯虚词 / 单独一个动作
  if (/^(就|那|这|来|去|看|做|是|有|在|要|能|会|想|说|回应)$/.test(topic)) return null;
  // ⑤ 只拦明显截断在一半的（以连词结尾）；「…不能说的」这种省略句是正常的
  if (/[和把被]$/.test(topic)) return null;
  return { topic, raw: s.slice(0, 80) };
}

/**
 * 这条教学和她最近在干的事沾不沾边（2026-11-03）。
 *
 * 老大的原话：「加进账本之前能不能反思一下值不值得，学会了有什么用」。
 * 因果核心的 detail 只存工具参数（搜索词），拿它当语料不合适；
 * 真正能当证据的是**她自己最近说过的话**——教到点上的事她一定聊过。
 *
 * 只做加权，不做拦截：
 *   沾边（≥1 个实词出现在她最近说过的话里）→ 1.35（更快到 adopted）
 *   不沾边 + 含技术词                  → 0.5（大概率是老大在跟别人聊技术）
 *   其余                                → 1.0
 */
const TECH_WORDS = /(代码|接口|token|Token|模型|内存|API|api|AI|ai|部署|仓库|commit|prompt|提示词|参数|日志|服务|进程|端口|显卡|显存)/;

// 虚词不进匹配——不排除的话「的/了/不/可/以」会让任何两句都「沾边」
// 只放真正的虚词/代词/副词。「到、给、对、把、上、下、中」这些能当实词用（「翻不到」「找到」），
// 放进停用词会让本该匹配的两句话判成不沾边。
const STOP_CHARS = new Set('的了是在有和就都也还很太不没我你他她它们之与及或但如果因为所以可以要会能被让从对于关于什么怎么吗呢吧啊呀哦嘛一大小多少'.split(''));
const contentChars = (x) => new Set(
  String(x || '').replace(/[^\u4e00-\u9fa5]/g, '').split('').filter((c) => c && !STOP_CHARS.has(c))
);

export function relevanceBoost(topic, corpus = '') {
  const t = String(topic || '');
  if (!t) return 1;
  const a = contentChars(t);
  if (!a.size) return 1;
  const b = contentChars(corpus);
  let hit = 0;
  for (const c of a) if (b.has(c)) hit += 1;
  // 至少两个实字重合才算「沾边」——一个字太容易撞（「翻」「看」这种到处都有）
  if (hit >= 2) return 1.35;
  if (TECH_WORDS.test(t)) return 0.5;
  return 1.0;
}

/** 字符集合相似度：把「老是在群里发视频」和「在群里发视频」并成同一条。 */
function similarity(a, b) {
  const strip = (x) => String(x || '').replace(/[，,。！？!?；;、\s「」“”"'（）()【】]/g, '');
  const sa = new Set(strip(a)), sb = new Set(strip(b));
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
export function recordTeaching(ledger, { text, isOwner = false, at = Date.now(), corpus = '', context = '' } = {}) {
  // 老大教的放宽（认「可以/以后/记得」这类正面表述），群里教的收紧（只认否定句）
  let hit = extractTeaching(text, { strict: !isOwner });
  let fromContext = false;
  // 2026-11-04：真人说话是连着的——「可以把她当小孩逗」→「越坏越好」→「多欺负欺负」，
  // 后两句单看什么都不是，接在上一句后面才明显是指令。
  // 单独判定不过时，把上一句（只要 20 字）拼在前面再判一次；判定用的是拼起来的整句，
  // 存下来的 topic 也跟着带上下文，免得以后她醒来只看到一句没头没尾的「多欺负欺负」。
  if (!hit && isOwner && String(context || '').trim()) {
    const raw = String(text || '').trim();
    const ctx = String(context).replace(/\s+/g, '').slice(-40);
    // 只接短句：长句子单独判不过，多半本来就不是指令
    // 问句、语气词结尾的不算（「你在干嘛」接在教学后面也不是规矩）
    const short = raw.replace(/\s+/g, '').length <= 16 && !/[？?呢吗呀啊嘛吧]$/.test(raw);
    // 上下文里得有真·教学（否则「今天天气不错」也会被当成规矩）
    const ctxIsTeaching = Boolean(extractTeaching(ctx, { strict: false }));
    if (short && ctxIsTeaching) {
      const topic = normalizeTopic(raw);
      if (topic && topic.length >= 2) {
        // 存的时候把上下文带上——以后她醒来光看「多欺负欺负」不知道在说谁
        hit = { topic, raw: `${ctx}，${raw}`.slice(0, 80) };
        fromContext = true;
      }
    }
  }
  // 2026-11-04：句子里有「她/他/它」时，必须带上上一句——否则存成「可以把她当小孩逗」，
  // 她过一会儿在群里看到这句，根本不知道「她」是谁（今晚就是这么丢的）。
  if (hit && isOwner && /[她他它]/.test(String(text || '')) && String(context || '').trim()) {
    const ctx = String(context).replace(/\s+/g, '').slice(-40);
    if (ctx && !hit.raw.includes(ctx)) hit = { ...hit, raw: `${ctx}，${hit.raw}`.slice(0, 80) };
  }
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
  const boost = relevanceBoost(hit.topic, corpus);
  const gain = (isOwner ? 1.0 : 0.6) * conflict * boost;   // 群友 0.35 → 0.6：原值下同一句要 7~13 次
  const next = {
    ...prev,
    threshold,
    weight: Math.round((Number(prev.weight) + gain) * 100) / 100,
    taught: Number(prev.taught || 0) + 1,
    lastAt: at,
    sources: Array.from(new Set([...(prev.sources || []), isOwner ? 'owner' : 'group'])).slice(-4),
    examples: [...(prev.examples || []), hit.raw].slice(-3),
    lastBoost: boost,
  };
  next.stage = learnState(next);
  items[key] = next;
  return { ledger: { ...ledger, items }, item: next, fromContext, changed: !prev.stage || prev.stage !== next.stage };
}

/** 生成注入行：让她知道自己「正处在学的哪个阶段」，态度由阶段决定。 */
export function learnPromptLine(ledger, { limit = 3 } = {}) {
  const items = Object.entries(ledger?.items || {})
    .map(([k, v]) => ({ key: k, ...v, stage: v.stage || learnState(v) }))
    // 2026-11-02：老大说过的**直接进规则核心**（noteTeaching 里就是这么干的），账本再列一遍
    // 只会和她说的相反——规则核心写「这是你的习惯」，账本写「有点印象，但还会忘」。
    // 所以老大的条目从这里让位，账本只管「群里学的」那一档。
    .filter((it) => !(Array.isArray(it.sources) && it.sources.includes('owner')))
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
      .map(([k, v]) => ({ key: k, ...v, stage: v.stage || learnState(v) }))
      .filter((x) => !(Array.isArray(x.sources) && x.sources.includes('owner')));
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
