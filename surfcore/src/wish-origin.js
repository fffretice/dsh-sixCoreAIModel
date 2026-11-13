// 2026-11-09（P1 安全/上下文）：pendingThoughts 的来源标记与注入过滤。
// 背景：wishLines 默认把 [当前会话, ownerKey] 的念想合并；ownerKey 是老大私聊，
// 导致群聊 prompt 里出现私聊念想原文（今天 44 条群 prompt 有 32 条命中）。
// 这里只做「来源标记/是否保留/渲染标签/排序」的纯函数，wishLines 负责遍历与状态读取。
// B 开关（socialV2.wish.includePrivateInGroup，默认 false）开启时保留私聊念想但标注+降权。

/** 会话 key → 来源类型：'private' | 'group'。 */
export function originKindOf(conversationKey) {
  return String(conversationKey || '').startsWith('private:') ? 'private' : 'group';
}

/**
 * 是否对当前 prompt 过滤 private 来源念想。
 * 显式 opts.excludePrivateOrigin 优先；否则：群会话默认过滤，私聊不过滤；
 * includePrivateInGroup=true（B 调试开关）时群会话也不过滤（改为标注+降权）。
 */
export function resolveExcludePrivateOrigin({ currentKey, opts = {}, includePrivateInGroup = false } = {}) {
  if (typeof opts.excludePrivateOrigin === 'boolean') return opts.excludePrivateOrigin;
  const isGroup = String(currentKey || '').startsWith('group:');
  if (!isGroup) return false;
  return !includePrivateInGroup;
}

/** 给 normalize 后的念想打来源标记（不落盘，只用于本次渲染）。 */
export function tagThoughtOrigin(item, originKey) {
  if (!item || typeof item !== 'object') return item;
  const originKind = originKindOf(originKey);
  return { ...item, originKey: String(originKey || ''), originKind };
}

/** 是否保留该条念想：群会话 + 不过滤开关时，跳过 private 来源。 */
export function shouldIncludeThought({ item, currentKey, excludePrivateOrigin = false } = {}) {
  if (!item) return false;
  if (excludePrivateOrigin && originKindOf(item.originKey || '') === 'private') return false;
  // 防御：B 开关误开时，私聊 prompt 仍不应把「群」来源当成私聊私念标注
  return true;
}

/** 渲染标签：room 目标 / 私聊来源（B 开关开启时）/ 普通念想。 */
export function thoughtLabel(item) {
  if (!item) return '【念想】';
  if (item.goal) return '【房间目标】';
  if (item.privateOrigin) return '【念想·私聊里想的，群里别提】';
  return '【念想】';
}

/** 群 prompt 里私聊来源是否要加标注（B 开关开启且当前是群会话）。 */
export function isPrivateOriginInGroup(item, currentKey) {
  return !!item && originKindOf(item.originKey || '') === 'private' && String(currentKey || '').startsWith('group:');
}

/** 排序：群/room 来源在前，私聊来源（B 开关）降权排在后面；同组内按时间新→旧。 */
export function sortThoughtsForPrompt(items) {
  return [...(Array.isArray(items) ? items : [])].sort((a, b) => {
    const pa = a?.privateOrigin ? 1 : 0;
    const pb = b?.privateOrigin ? 1 : 0;
    if (pa !== pb) return pa - pb;
    return Number(b?.at || 0) - Number(a?.at || 0);
  });
}

/** 去重键：前 12 字（与原 wishLines 的 seen 逻辑一致，便于单测）。 */
export function thoughtDedupeKey(item) {
  return String(item?.text || '').slice(0, 12);
}

/** 会话 key 是否私聊来源。 */
export function isPrivateConversationKey(conversationKey) {
  return originKindOf(conversationKey) === 'private';
}

/** 记录来源 key：优先 record.key/sourceKey；search-memory 旧行用 causal 的 query→来源回填；解析不出=unknown('')。 */
export function resolveRecordSourceKey(record, { queryOrigins } = {}) {
  if (!record || typeof record !== 'object') return '';
  const direct = String(record.key || record.sourceKey || '').trim();
  if (direct) return direct;
  const q = String(record.q || record.query || '').trim();
  if (!q) return '';
  const origins = queryOrigins instanceof Map ? queryOrigins.get(q) : null;
  if (!origins || origins.size !== 1) return ''; // 多条/无来源都算 unknown（宁缺毋滥）
  return String([...origins][0] || '');
}

export function isPublicRecord(record) {
  return record?.public === true || record?.originKind === 'public' || record?.sourceKey === 'public';
}

/**
 * 群 prompt 只展示「来源明确且属于当前会话」的记录，或显式 public 的记录；
 * unknown（解析不出来）、其他群、private 一律不进群 prompt。私聊视图不过滤。
 * 背景：2026-11-09 memory-watch 发现 860 群 prompt 里混入 group:650 的私事搜索
 *（近变体、不含硬关键词），说明「排除 private」还不够，跨会话内容也不该串群。
 */
export function filterViewRecordsByOrigin(records, { currentKey, queryOrigins } = {}) {
  const list = Array.isArray(records) ? records : [];
  const ck = String(currentKey || '');
  if (!ck.startsWith('group:')) return [...list];
  return list.filter((r) => {
    if (isPublicRecord(r)) return true;
    return resolveRecordSourceKey(r, { queryOrigins }) === ck;
  });
}

/** 构造「查询词 → 来源 keys」映射（search-memory 旧行没有 key 时用于来源回填）。 */
export function buildQueryOrigins(causalLog) {
  const map = new Map();
  for (const e of Array.isArray(causalLog) ? causalLog : []) {
    if (String(e?.source || '') !== 'tool:search') continue;
    const q = String(e?.detail || '').trim();
    if (!q) continue;
    if (!map.has(q)) map.set(q, new Set());
    map.get(q).add(String(e?.key || ''));
  }
  return map;
}

/** search-memory 行是否允许进当前视图：群视图=public 或来源=当前会话；unknown/其他来源不进。 */
export function searchRowVisibleInView(row, { currentKey, queryOrigins } = {}) {
  const ck = String(currentKey || '');
  if (!ck.startsWith('group:')) return true;
  if (isPublicRecord(row)) return true;
  return resolveRecordSourceKey(row, { queryOrigins }) === ck;
}

// 2026-11-10（P0 隐私）：reflections（日记提炼）视图过滤。
// 日记是私聊语境；旧记录没有 origin → 按 private 处理（安全侧：群 prompt 一律不注入）。
// 写入新记录用 buildReflectionRecord({..., origin:'private'|'group', scope:'diary'|'chat'})。
export function reflectionOriginOf(record) {
  return String(record?.origin || '') === 'group' ? 'group' : 'private';
}

export function buildReflectionRecord({ date = '', text = '', at = Date.now(), origin = 'private', scope = 'diary' } = {}) {
  return {
    date: String(date || ''),
    text: String(text || '').slice(0, 400),
    at: Number(at) || Date.now(),
    origin: origin === 'group' ? 'group' : 'private',
    scope: String(scope || 'diary').slice(0, 20),
  };
}

/** 群视图只放 origin=group 的反思；私聊视图全放（含旧记录/private）。 */
export function filterReflectionsForView(records, { currentKey } = {}) {
  const list = Array.isArray(records) ? records : [];
  if (!String(currentKey || '').startsWith('group:')) return [...list];
  return list.filter((r) => reflectionOriginOf(r) === 'group');
}
