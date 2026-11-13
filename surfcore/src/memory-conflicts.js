/**
 * 旧口径保留 + 口径冲突检测（task-28，2026-11-09）—— 纯逻辑模块（不读盘、不注入）
 *
 * 目标：她记得「你之前不是说不……」——同一主题新旧口径相反时成对登记，
 * 私聊/owner 唤醒时以线索形式提示（≤2 对/120 字），群聊不注入。
 *
 * 记录层字段（在 B2 status 字段上扩展，可选）：
 *   supersededAt   旧口径失效时间（ISO）
 *   supersededBy   取代它的新记录 id
 *   conflictWith   与之冲突的成对记录 id 数组
 *   topicKey       归一化主题（如 video_afterthought / group_intel_forward / image_caption）
 *   stance         该记录的口径极性：allow | forbid | restrict | neutral
 *
 * 本模块只做数据/渲染，不写盘、不改 bridge；接入等桥接窗口。
 */

export const MEMORY_CONFLICT_VERSION = 1;

// 主题：patterns 用于归类；label 用于渲染
export const CONFLICT_TOPICS = Object.freeze([
  {
    key: 'video_afterthought',
    label: '视频观后感',
    patterns: [/观后感/, /看完(写|说|讲)/, /(不要在群里|别在群里)(讲|说).*视频/, /刷.*视频.*审核/],
  },
  {
    key: 'image_caption',
    label: '发图时配话',
    patterns: [/发图.*(一句话|配话|配一句|别说|说话)/, /(发了?海报|图片往群里发).*(一句话|配一句|说话)/, /一句话别说/],
  },
  {
    key: 'private_in_group',
    label: '私聊内容进群',
    patterns: [/私聊的事/, /私聊.*(记录|内容|事).*群/, /群里别提/, /不要转述/, /别在群里说/],
  },
  {
    key: 'group_intel_forward',
    label: '往群里发情报',
    patterns: [/新情报/, /转发/, /(新图|联动|情报).*(发|往|转|群)/, /(发|转|问).*(情报)/, /kuri群|小兴群/],
  },
  {
    key: 'address_name',
    label: '称呼/名字',
    patterns: [/称呼/, /叫我/, /叫老大/, /叫主人/, /名字.*(改|换|叫)/],
  },
]);

// 口径极性
const ALLOW_RE = /(可以|能|行|允许|配一句|说一句|写点观后感|发吧|带一个来源链接|像正常人一样)/;
const FORBID_RE = /(别|不要|不准|不能|不许|只私聊|只聊天|一句话别说|别提|别发|别讲|只发老大的群)/;

export function classifyTopic(text) {
  const body = String(text || '');
  for (const t of CONFLICT_TOPICS) {
    if (t.patterns.some((re) => re.test(body))) return t.key;
  }
  return '';
}

export function topicLabel(key) {
  return (CONFLICT_TOPICS.find((t) => t.key === key) || {}).label || key;
}

/**
 * 极性判定：restrict = 部分允许但加条件（只发老大群/只私聊/发群不配话）；
 * forbid = 整体禁止/别提；allow = 允许。
 */
export function classifyStance(text) {
  const body = String(text || '');
  const allow = ALLOW_RE.test(body);
  const forbid = FORBID_RE.test(body);
  const onlyPattern = /只(发|往|在|私聊|聊天|丢)/.test(body);
  // 允许 + 禁止同句，或「只…」限定 → 收紧；纯允许/纯禁止按原意
  if (allow && forbid) return 'restrict';
  if (forbid && onlyPattern) return 'restrict';
  if (forbid) return 'forbid';
  if (allow) return 'allow';
  return 'neutral';
}

const DIRECTIVE_RE = /(以后|记得|不要|别|不准|不能|可以|只|前提|审核|必须|应该|允许|改成|改掉|往|发到|配一句)/;
const QUESTION_RE = /(吗|呢|不|？|\?)\s*$/;

function dayOf(iso) { return String(iso || '').slice(0, 10); }

/** 来源标注（符合记忆来源规则）：owner/规则 = 老大改的；manual/digest = 她自己记/改的。 */
export function sourceLabel(source) {
  const s = String(source || '');
  if (s === 'rule' || s === 'qq-owner') return '老大';
  if (s === 'manual' || s === 'digest' || s === 'qq-self') return '你';
  return '记录';
}

/** 从记录里抽出「口径类」版本记录（可含 source:'rule' 的虚拟记录）。 */
export function extractVersionedRecords(records, { sources = ['qq-owner', 'rule', 'manual', 'digest'] } = {}) {
  const out = [];
  for (const r of Array.isArray(records) ? records : []) {
    const text = String(r?.text ?? '');
    if (!text.trim()) continue;
    if (!sources.includes(String(r?.source ?? ''))) continue; // 只看 owner 口径/规则快照，不看她的自述/群闲聊
    if (QUESTION_RE.test(text.trim())) continue;              // 问句不是口径
    if (!DIRECTIVE_RE.test(text)) continue;                   // 没有指令性
    const topicKey = classifyTopic(text);
    if (!topicKey) continue;
    const stance = classifyStance(text);
    if (stance === 'neutral') continue;
    out.push({
      id: String(r.id ?? ''),
      source: String(r.source ?? ''),
      topicKey,
      stance,
      at: String(r.createdAt ?? ''),
      day: dayOf(r.createdAt),
      text: text.replace(/\s+/g, ' ').trim(),
      status: String(r.status ?? ''),
      supersededAt: String(r.supersededAt ?? ''),
      supersededBy: String(r.supersededBy ?? ''),
      conflictWith: Array.isArray(r.conflictWith) ? r.conflictWith.map(String) : [],
    });
  }
  return out;
}

/**
 * 冲突配对（每个主题最多 1 对，取「最新口径 vs 最近一次相反口径」）：
 *   · 把版本按 allow / 非 allow（forbid|restrict）分组；
 *   · 各取最新一条；日期不同且极性不同 → 成对（旧在前、新在后）；
 *   · 中间反复改口的旧记录保留在 card（不删），但只登记最终一对，避免刷屏。
 */
export function detectConflicts(records) {
  const versions = extractVersionedRecords(records)
    .filter((v) => v.at)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const byTopic = new Map();
  for (const v of versions) {
    if (!byTopic.has(v.topicKey)) byTopic.set(v.topicKey, []);
    byTopic.get(v.topicKey).push(v);
  }
  const conflicts = [];
  for (const [topicKey, list] of byTopic) {
    const allow = list.filter((v) => v.stance === 'allow');
    const nonAllow = list.filter((v) => v.stance !== 'allow');
    if (!allow.length || !nonAllow.length) continue;
    const latestAllow = allow[allow.length - 1];
    const latestNonAllow = nonAllow[nonAllow.length - 1];
    let older; let newer;
    if (String(latestAllow.at) >= String(latestNonAllow.at)) { older = latestNonAllow; newer = latestAllow; } else { older = latestAllow; newer = latestNonAllow; }
    if (!older || !newer || older.id === newer.id) continue;
    if (older.day === newer.day && older.stance === newer.stance) continue;
    conflicts.push({
      id: `cf_${topicKey}_${older.id}_${newer.id}`,
      topicKey,
      topicLabel: topicLabel(topicKey),
      old: { id: older.id, day: older.day, at: older.at, stance: older.stance, text: older.text.slice(0, 120), source: older.source, sourceLabel: sourceLabel(older.source) },
      new: { id: newer.id, day: newer.day, at: newer.at, stance: newer.stance, text: newer.text.slice(0, 120), source: newer.source, sourceLabel: sourceLabel(newer.source) },
      confidence: 0.8,
    });
  }
  return conflicts.sort((a, b) => String(b.new.at).localeCompare(String(a.new.at)));
}

/** 按主题/文本查冲突（供唤醒时用）。 */
export function conflictsForTopic(query, records) {
  const q = String(query || '').trim();
  const topicKey = classifyTopic(q);
  const all = detectConflicts(records);
  if (!q) return all;
  return all.filter((c) => (topicKey && c.topicKey === topicKey) || String(c.topicKey).includes(q) || c.topicLabel.includes(q)
    || c.old.text.includes(q) || c.new.text.includes(q));
}

/** 纯函数：给记录打上版本字段（旧 → supersededAt/supersededBy/conflictWith；新 → conflictWith）。不写盘。 */
export function linkVersionFields(records, conflicts) {
  const list = Array.isArray(records) ? records : [];
  const byId = new Map(list.map((r, i) => [String(r?.id ?? ''), i]));
  const next = list.map((r) => ({ ...r }));
  for (const c of Array.isArray(conflicts) ? conflicts : []) {
    const oi = byId.get(c.old.id);
    const ni = byId.get(c.new.id);
    if (oi === undefined || ni === undefined) continue;
    next[oi].supersededAt = next[oi].supersededAt || c.new.at;
    next[oi].supersededBy = next[oi].supersededBy || c.new.id;
    next[oi].conflictWith = [...new Set([...(next[oi].conflictWith || []), c.new.id])];
    next[ni].conflictWith = [...new Set([...(next[ni].conflictWith || []), c.old.id])];
    next[ni].topicKey = next[ni].topicKey || c.topicKey;
    next[oi].topicKey = next[oi].topicKey || c.topicKey;
  }
  return next;
}

function shorten(s, max = 26) {
  const t = String(s || '').replace(/^@[^\s]+[\s:：]*/u, '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * 渲染「口径变更」块（仅私聊/owner 唤醒使用；群聊不调用）。
 * ≤2 对、总长 ≤maxChars（默认 120）；措辞是线索不是命令，允许她「诶，你之前不是说过…」。
 */
export function renderConflictBlock(conflicts, { maxChars = 120 } = {}) {
  const list = (Array.isArray(conflicts) ? conflicts : []).slice(0, 2).filter((c) => c?.old && c?.new);
  if (!list.length) return '';
  const header = '【口径变更·先别急着道歉】';
  const tail = '——想起旧说法可以先愣一下，想不起就按新的来';
  const pairText = (c) => {
    const dir = c.new.stance === 'allow' ? '（现在允许）' : (c.new.stance === 'restrict' ? '（现在收紧了）' : '（现在不行）');
    const oldWho = c.old.sourceLabel || sourceLabel(c.old.source);
    const newWho = c.new.sourceLabel || sourceLabel(c.new.source);
    const who = oldWho === newWho ? oldWho : `${oldWho}→${newWho}`;
    return `${c.topicLabel}：${who} ${c.old.day.slice(5)}「${shorten(c.old.text, 14)}」→ ${c.new.day.slice(5)}「${shorten(c.new.text, 14)}」${dir}`;
  };
  // 先放第一对；放得下 tail 就放；第二对只在总长仍 ≤max 时加入（保证线索措辞不被截掉）
  let out = header + pairText(list[0]);
  if ((out + tail).length <= maxChars) out += tail;
  if (list[1]) {
    const cand = `${header}${pairText(list[0])}；${pairText(list[1])}${tail}`;
    if (cand.length <= maxChars) out = cand;
  }
  if (out.length > maxChars) out = `${out.slice(0, Math.max(0, maxChars - 1))}…`;
  return out;
}

/**
 * 唤醒时入口（纯函数）：只有 owner/私聊 + 当前上下文命中主题时才返回块；群聊返回 ''。
 */
export function conflictsForWake({ text = '', convKey = '', isOwner = false, records = [], maxChars = 120 } = {}) {
  const key = String(convKey || '');
  const ownerContext = isOwner === true || key.startsWith('private:');
  if (!ownerContext) return '';
  if (!String(text || '').trim()) return '';
  const topicKey = classifyTopic(text);
  if (!topicKey) return '';
  const conflicts = conflictsForTopic(topicKey, records);
  if (!conflicts.length) return '';
  return renderConflictBlock(conflicts, { maxChars });
}
