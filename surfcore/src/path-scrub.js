// 出站文本的本机路径清洗：把「长得像本机文件路径」的片段摘掉，再交给 SENSITIVE_RE 判定。
//
// 为什么需要它：她（和模型）经常在回复里顺口写出 /Users/xxx/.memory 这类路径，
// 整条回复就会被安全闸拦下、一个字都发不出去，聊天体验很差。
// 但路径本身对聊天没用，**抹掉比拦掉更合理**：用户要的是「别让我看见路径」，不是「别说话」。
//
// 三条约束：
//   1. **URL 必须原样保留**——https://... 里也有斜杠，不能误伤；
//   2. 只摘「本机路径形态」的片段（/Users /Volumes /opt …、C:\…、~/\…），
//      普通分数、和/或、日期都不动；
//   3. 洗完仍可能命中凭据类规则（token/密码/密钥…），那部分**照旧拦截**，
//      这里只负责路径，不放宽任何凭据判定。
const URL_RE = /https?:\/\/[^\s<>"'）)】]*/gi;
const URL_PLACEHOLDER = '\u0000URL\u0000';

const PATH_RES = [
  /(?<![A-Za-z0-9])\/Users\/[^\s"'<>|，。；、）)】]*/g,
  /(?<![A-Za-z0-9])\/home\/[^\s"'<>|，。；、）)】]*/g,
  /(?<![A-Za-z0-9])\/Volumes\/[^\s"'<>|，。；、）)】]*/g,
  /(?<![A-Za-z0-9])\/Applications\/[^\s"'<>|，。；、）)】]*/g,
  /(?<![A-Za-z0-9])\/private\/[^\s"'<>|，。；、）)】]*/g,
  /(?<![A-Za-z0-9])\/Library\/[^\s"'<>|，。；、）)】]*/g,
  /(?<![A-Za-z0-9])\/opt\/[^\s"'<>|，。；、）)】]*/g,
  /(?<![A-Za-z0-9])\/etc\/[^\s"'<>|，。；、）)】]*/g,
  /(?<![A-Za-z0-9])\/var\/[^\s"'<>|，。；、）)】]*/g,
  /(?<![A-Za-z0-9])\/root\/[^\s"'<>|，。；、）)】]*/g,
  /(?<![A-Za-z0-9])\/tmp\/[^\s"'<>|，。；、）)】]*/g,
  /(?<![A-Za-z0-9])~\/[^\s"'<>|，。；、）)】]*/g,
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>|，。；、）)】]*/g,
];

/** 抹掉本机路径，返回 { text, removed }。removed 是被摘掉的片段数。 */
export function scrubLocalPaths(input) {
  let text = String(input ?? '');
  if (!text) return { text, removed: 0 };

  // 1) 先把 URL 藏起来，避免被路径规则误伤
  const urls = [];
  text = text.replace(URL_RE, (m) => {
    urls.push(m);
    return `${URL_PLACEHOLDER}${urls.length - 1}\u0000`;
  });

  // 2) 摘路径
  let removed = 0;
  for (const re of PATH_RES) {
    text = text.replace(re, () => {
      removed += 1;
      return '';
    });
  }

  // 3) 收拾残留的空白/标点（「写进了 。」→「写进了。」）
  text = text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([，。；：、！？）)】」』])/g, '$1')
    .replace(/([，。；：、！？])\s+/g, '$1')
    .replace(/([（(【「『])\s+/g, '$1')
    .replace(/。{2,}/g, '。')
    .replace(/^[，。；：、\s]+/, '');

  // 4) URL 放回来
  text = text.replace(new RegExp(`${URL_PLACEHOLDER}(\\d+)\u0000`, 'g'), (_, i) => urls[Number(i)] ?? '');

  return { text: text.trim(), removed };
}
