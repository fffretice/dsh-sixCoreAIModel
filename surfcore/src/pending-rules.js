/**
 * 候选规则池（2026-11-05）
 *
 * 老大的话分两路：
 *   私聊 / @她 / 带「你」 → 立刻进规则核心（准确率高，他就是在跟她说）
 *   其他（群里旁听来的）  → 进这里，等她自己在日记里认
 *
 * 为什么要有这个池子：文本判断「是不是在教她」天花板很低
 * （实测 9/17，误收 3 条、误拦 0 条），继续加正则只会越写越歪。
 * 但也不能全都直接进——11-04 一天就混进 16 条闲聊，把规则核心顶到 6323 字符（上限 6000）。
 *
 * 设计上跟表情包整理同一个思路：不替她判断，只把东西摆到她面前，让她自己认。
 */
import fs from 'fs';
import path from 'path';

const FILE = 'pending-rules.json';
const EXPIRE_MS = 7 * 24 * 60 * 60 * 1000;   // 7 天没人认就丢

function read(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { items: [] }; }
}
function write(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch {}
}

export function createPendingRules({ stateDir, log = () => {} }) {
  const file = path.join(stateDir, FILE);
  const load = () => {
    const d = read(file);
    const now = Date.now();
    const items = (Array.isArray(d.items) ? d.items : []).filter((x) => x && now - Number(x.at || 0) < EXPIRE_MS);
    return { items };
  };
  const save = (d) => write(file, d);

  return {
    /** 收一条候选。同样的文本不重复收。 */
    add(text, { context = '', source = 'group' } = {}) {
      const body = String(text || '').trim();
      if (!body) return false;
      const d = load();
      if (d.items.some((x) => x.text === body)) return false;
      d.items.push({ text: body, context: String(context || '').slice(-120), source, at: Date.now(), seen: 0 });
      save(d);
      log(`[候选] 进池：${body.slice(0, 30)}（池里 ${d.items.length} 条）`);
      return true;
    },

    /** 取最多 n 条没展示过的，供 prompt 注入。 */
    take(n = 2) {
      const d = load();
      const picked = d.items.slice().sort((a, b) => Number(a.seen || 0) - Number(b.seen || 0) || a.at - b.at).slice(0, n);
      for (const p of picked) p.seen = Number(p.seen || 0) + 1;
      save(d);
      return picked;
    },

    /** 她认了 → 交给调用方写进规则核心，然后从池里删掉。 */
    confirm(text) {
      const d = load();
      const i = d.items.findIndex((x) => x.text === String(text || '').trim());
      if (i < 0) return null;
      const [gone] = d.items.splice(i, 1);
      save(d);
      log(`[候选] 她认了：${gone.text.slice(0, 30)}`);
      return gone;
    },

    /** 她说不认 → 直接删。 */
    reject(text) {
      const d = load();
      const i = d.items.findIndex((x) => x.text === String(text || '').trim());
      if (i < 0) return false;
      d.items.splice(i, 1);
      save(d);
      return true;
    },

    list() { return load().items; },
    size() { return load().items.length; },
  };
}
