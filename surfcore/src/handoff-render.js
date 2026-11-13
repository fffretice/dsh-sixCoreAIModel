/**
 * 当前交接覆盖块（task-42，2026-11-10）—— 纯渲染逻辑，不读盘、不注入。
 *
 * 字段：doing（正在做/刚在做）、next（下一步）、blocked（卡住/等回复）、updatedAt。
 * 覆盖写：同会话只保留最新一块（写入器原子替换，不追加）。
 * 视图：私聊版可含 private/room/diary/narrative；群版只含 public/group，拿不准一律只私聊。
 */

export const HANDOFF_MAX_CHARS = 200;
export const HANDOFF_VERSION = 1;

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
function cut(text, max) {
  const t = norm(text);
  if (t.length <= max) return t;
  return max <= 1 ? '…' : `${t.slice(0, max - 1)}…`;
}
function timeLabel(now) {
  const d = new Date(Number(now) || Date.now());
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function firstSentence(text, max = 60) {
  const t = norm(text);
  const m = t.match(/^[^。！？!?；;]{1,80}[。！？!?；;]?/);
  return cut((m ? m[0] : t).replace(/[。！？!?；;]$/, ''), max);
}
function itemText(x) { return norm(typeof x === 'string' ? x : x?.text || ''); }
function blockedClause(text) {
  const m = String(text || '').match(/(?:等(?:他|她|它|你|老大|回复|账号)?[^。！？；;，,]{0,24}|还没[^。！？；;，,]{0,24}|没做完[^。！？；;，,]{0,24}|卡(?:在|住)?[^。！？；;，,]{0,24})/);
  return m ? norm(m[0]).slice(0, 30) : '';
}
function itemOrigin(x) { return String(typeof x === 'string' ? 'private' : x?.origin || 'unknown'); }

/** 视图过滤：群版只保留 public/group；unknown/private/room/diary/narrative 一律不进群（拿不准只私聊）。 */
export function filterHandoffItems(items, view) {
  const list = (Array.isArray(items) ? items : []).filter((x) => itemText(x));
  if (view !== 'group') return list;
  return list.filter((x) => ['public', 'group'].includes(itemOrigin(x)));
}

/** 从 diary/narrative 里找「下一步」（明天试着/明天想试/下次…）。 */
export function extractNextFromText(text) {
  const m = String(text || '').match(/(?:明天试着|明天想试|下次|回头|接下来)[：:，,\s]*([^。！？\n]{2,50})/);
  return m ? norm(m[1]).slice(0, 50) : '';
}

/**
 * 渲染交接块（纯函数）。
 * @param {{pendingThoughts?:Array, goals?:Array, roomLines?:Array, diary?:string, narrative?:string, view?:'private'|'group', now?:number, maxChars?:number}} input
 * @returns {{text:string, chars:number, view:string, fields:{doing:string,next:string,blocked:string}, updatedAt:string}}
 */
export function renderHandoffBlock(input = {}) {
  const view = input.view === 'group' ? 'group' : 'private';
  const maxChars = Math.min(Number(input.maxChars) || HANDOFF_MAX_CHARS, HANDOFF_MAX_CHARS);
  const now = Number(input.now) || Date.now();
  const thoughts = filterHandoffItems(input.pendingThoughts, view).map((x) => ({ text: itemText(x), at: Number(x?.at || x?.createdAt || 0) })).sort((a, b) => (b.at - a.at));
  const goals = filterHandoffItems(input.goals, view).map((x) => ({ text: itemText(x), status: String(x?.status || 'open'), at: Number(x?.createdAt || 0) })).filter((x) => x.status !== 'done');
  const room = filterHandoffItems(input.roomLines, view).map(itemText);
  // 群版：没有具体公开目标/事项时整块省略（不凑「陪群里聊天」）
  if (view === 'group' && thoughts.length === 0 && goals.length === 0 && room.length === 0) {
    return { text: '', chars: 0, view, fields: { doing: '—', next: '—', blocked: '—' }, updatedAt: timeLabel(now), omitted: true };
  }
  const diary = view === 'private' ? norm(input.diary) : '';
  const narrative = view === 'private' ? norm(input.narrative) : '';

  // doing：最新 pendingThought 的第一句（不塞整段）> 最新 open goal > diary 第一句 > room 最新一句
  let doing = thoughts[0] ? firstSentence(thoughts[0].text, 36) : (goals[0] ? cut(goals[0].text, 36) : '') || (diary ? firstSentence(diary, 36) : '') || cut(room[0] || '按手头的事推进', 36);
  // next：目标里第二条/第一条、diary/narrative 的「明天/下次」、room 里「下次/回头」
  let next = goals[1] ? cut(goals[1].text, 36) : (goals[0] ? cut(goals[0].text, 36) : '');
  next = next || extractNextFromText(diary) || extractNextFromText(narrative);
  if (!next) {
    const roomNext = room.map(extractNextFromText).find(Boolean);
    next = roomNext ? cut(roomNext, 36) : (goals[0] ? cut(goals[0].text, 36) : '');
  }
  // blocked：只抽「等他/还没/卡在」短句，绝不整段回填（避免和 doing 重复）
  const blockedFromThoughts = thoughts.map((t) => blockedClause(t.text)).find(Boolean) || '';
  let blocked = blockedFromThoughts
    || [diary, narrative, ...room.map((x) => x.text || x)].map((t) => blockedClause(t)).find(Boolean)
    || '';
  // 群版私密源通常为空 → 给安全的通用句
  // doing 里若含 blocked 同一句，剥掉，避免两栏重复
  if (blocked && doing.includes(blocked)) {
    const stripped = doing.replace(blocked, '').replace(/[，,；;]\s*$/, '').trim();
    if (stripped.length >= 4) doing = stripped;
  }
  // 四字段互斥：同一句不得同时出现在 做/下一步/卡住；blocked 没有就 —（不拿 doing 兜底）
  doing = norm(doing); next = norm(next); blocked = norm(blocked);
  if (blocked && next && (next.includes(blocked) || blocked.includes(next))) {
    const stripped = next.replace(blocked, '').replace(/[，,；;]\s*$/, '').trim();
    next = stripped.length >= 2 ? stripped : '';
  }
  if (next && doing && (doing.includes(next) || next.includes(doing))) next = '';
  if (blocked && doing && (doing.includes(blocked) || blocked.includes(doing))) blocked = '';
  const fields = { doing: doing || '—', next: next || '—', blocked: blocked || '—' };
  const updatedAt = timeLabel(now);
  const build = (f) => `【当前交接】做：${f.doing}；下一步：${f.next}；卡住：${f.blocked}（更新 ${updatedAt}）`;
  let text = build(fields);
  if (text.length > maxChars) {
    // 超出就逐步压缩字段（保证 ≤200，保留字段语义）
    for (const budget of [26, 20, 14, 10]) {
      const f = { doing: cut(fields.doing, budget), next: cut(fields.next, budget), blocked: cut(fields.blocked, Math.max(6, budget - 4)) };
      text = build(f);
      if (text.length <= maxChars) break;
    }
  }
  if (text.length > maxChars) text = cut(text, maxChars);
  return { text, chars: text.length, view, fields, updatedAt };
}

/** 同时渲染私聊/群两版（群版空源时仍给安全通用块）。 */
export function renderHandoffViews(input = {}) {
  const privateBlock = renderHandoffBlock({ ...input, view: 'private' });
  const groupBlock = renderHandoffBlock({ ...input, view: 'group' });
  return { private: privateBlock, group: groupBlock, updatedAt: privateBlock.updatedAt };
}

/** 覆盖写（原子替换，不追加）：blocks = {private, group, updatedAt}。返回写盘后的对象。 */
export function writeHandoffAtomic(fs, file, blocks) {
  const payload = { version: HANDOFF_VERSION, updatedAt: blocks?.updatedAt || timeLabel(Date.now()), private: blocks?.private || null, group: blocks?.group || null };
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return payload;
}
