// doc-path-check 单测（2026-11-09，P2 旧路径 19→0）
//
// 目标：19 条已知误报全部跳过；真正的文件系统路径（哪怕不存在）仍然会被查。
import {
  DOC_PATH_EXEMPT,
  isFsLikeDocPath,
  isDocPathNoise,
  isDocPathExempt,
  shouldCheckDocPath,
} from '../src/doc-path-check.js';

let pass = 0;
const ok = (name, fn) => {
  try { fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}\n     ${String(error?.message ?? error)}`); process.exitCode = 1; }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assert failed'); };
const eq = (a, b, msg) => assert(a === b, `${msg || 'eq'}：${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

// 2026-11-09 夜间体检报的 19 处（全部不应再被当失效）
const NOISE_19 = [
  '/__bili/status',
  '~/.dsh/surfcore/token-budget.json',
  '~/SurfCore/state/daily-audit/YYYY-MM-DD.md',
  '/home/ubuntu/.dsh/media/onebot/memes',
  '/Volumes/RickAshley/DSH_Transfer',
  '/player',
  '/笨|傻|蠢|废物|没用|滚/',
  '/chat/test',
  '/complete',
  '/combo.html',
  '/user/balance',
  '/Users/{{USER}}/x',
  '~/.dsh-fish',
  '/v1/audio/transcriptions',
  '~/video-lab/dsh-video-storyboard',
  '/v1/speak/file',
  '/v1/health',
  '/v1/voices',
  // 第 19 条的重复项（/chat/test 出现两次）
  '/chat/test',
];

console.log('—— 19 处误报全部跳过 ——');
ok('19 处都不该被 exists() 检查', () => {
  for (const ref of NOISE_19) eq(shouldCheckDocPath(ref), false, ref);
});
ok('分类：接口/命令/正则/页面 不是文件系统路径', () => {
  for (const ref of ['/__bili/status', '/player', '/chat/test', '/complete', '/combo.html', '/user/balance', '/v1/health', '/笨|傻|蠢|废物|没用|滚/']) {
    eq(isFsLikeDocPath(ref), false, ref);
  }
});
ok('分类：模板/示例是噪声', () => {
  eq(isDocPathNoise('~/SurfCore/state/daily-audit/YYYY-MM-DD.md'), true);
  eq(isDocPathNoise('/Users/{{USER}}/x'), true);
});
ok('分类：历史/计划/运行时路径在豁免表', () => {
  eq(isDocPathExempt('/Volumes/RickAshley/DSH_Transfer'), true);
  eq(isDocPathExempt('~/.dsh-fish'), true);
  eq(isDocPathExempt('~/video-lab/dsh-video-storyboard'), true);
  eq(isDocPathExempt('~/.dsh/surfcore/token-budget.json'), true);
  eq(DOC_PATH_EXEMPT.size, 4);
});

console.log('—— 真失效路径仍然要查（不放宽检测）——');
ok('用户目录里不存在的文件 → true（仍会被报）', () => {
  eq(shouldCheckDocPath('~/.dsh/surfcore/no-such-file-abc123.json'), true);
  eq(shouldCheckDocPath('/Users/{{USER}}/SurfCore/state/no-such.json'), true);
});
ok('不存在的卷 / 系统目录 → true', () => {
  eq(shouldCheckDocPath('/Volumes/NoSuchVolume/backup.zip'), true);
  eq(shouldCheckDocPath('/opt/homebrew/opt/no-such-pkg'), true);
});
ok('真实存在的文件也会进检查（没被误豁免）', () => {
  eq(shouldCheckDocPath('~/SurfCore/config.json'), true);
});
ok('带空格的路径仍按原逻辑跳过（原有规则不变）', () => {
  // checkDocs 上游先 /\\s/ 过滤；模块本身只看前缀，这里确认前缀判定独立
  eq(isFsLikeDocPath('~/some file.txt'), true);
});

console.log(`\n${pass} 项通过${process.exitCode ? '，有失败' : '，全部通过 ✅'}`);
