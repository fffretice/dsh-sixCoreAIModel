/**
 * 文档路径体检的「该不该查」判定（2026-11-09，P2 旧路径 19→0）。
 *
 * 背景：nightly-audit 的 checkDocs() 原来会把 `~/.memory/projects/*.md` 里
 * 所有反引号 `[~/]…` 都当文件路径，于是接口端点、正则字面量、模板占位、
 * 历史/计划路径全被算成「路径不存在」（2026-11-09 共 19 处，全部是误报/预期不存在）。
 *
 * 职责边界：
 *   · 只做「是否值得当作文件系统路径去查」的过滤，**不包含文件系统访问**；
 *   · 真正的文件路径（用户目录 / 卷 / 常见系统目录）照旧会被查，查不到仍算失效；
 *   · 接口（/v1/…、/chat/test、/player）、正则（/笨|傻/）、模板（YYYY-MM-DD）、
 *     示例（/Users/{{USER}}/x）、以及明确的历史/计划/运行时按需路径 → 跳过。
 */
export const DOC_PATH_EXEMPT = Object.freeze(new Set([
  '/Volumes/RickAshley/DSH_Transfer',      // 迁移来源卷：已迁完，卷已不挂载（历史记录）
  '~/.dsh-fish',                           // 旧插件：未安装，只在文档里当历史线索
  '~/video-lab/dsh-video-storyboard',      // 计划中的本地工具：尚未落地
  '~/.dsh/surfcore/token-budget.json',     // 额度覆盖文件：不存在=用默认额度（按需创建）
]));

/** 看起来像「文件系统路径」：用户目录 / 卷 / 常见系统目录。 */
export function isFsLikeDocPath(ref) {
  return /^(~\/|\/Users\/|\/Volumes\/|\/opt\/|\/usr\/local\/|\/Applications\/|\/private\/|\/tmp\/)/.test(String(ref || ''));
}

/** 不是文件路径的写法：正则字面量、模板占位、示例。 */
export function isDocPathNoise(ref) {
  const s = String(ref || '');
  if (/^\/[^/]*\|/.test(s)) return true;                    // /笨|傻|蠢/
  if (/YYYY|MM-DD|<[^>]+>|\bxxx?\b|\/x$/.test(s)) return true; // YYYY-MM-DD / <参数> / xxx / /x
  return false;
}

/** 明确「不存在是预期」的路径（历史/计划/运行时按需文件）。 */
export function isDocPathExempt(ref) {
  return DOC_PATH_EXEMPT.has(String(ref || ''));
}

/** checkDocs 是否应该对这个反引号引用做 exists() 检查。 */
export function shouldCheckDocPath(ref) {
  const s = String(ref || '').trim();
  if (!s) return false;
  if (!isFsLikeDocPath(s)) return false;
  if (isDocPathNoise(s)) return false;
  if (isDocPathExempt(s)) return false;
  return true;
}
