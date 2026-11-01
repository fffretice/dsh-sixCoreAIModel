// 语音包清单的默认值回归（纯离线，不下载、不启动任何语音服务）。
//
// 背景（2026-10-26）：`DEFAULT_MANIFESTS` 里的 `url` 曾经写死成本机绝对路径。
// 换机器/换目录后默认安装源指向不存在的位置，而现象只是"安装失败"——
// 语音功能看起来坏了，日志里却只有一句 502。现在改成相对仓库根解析。
//
// 这条测试钉三件事，都不依赖本机盘符：
//   1. url 是绝对路径，且等于「仓库根的上级 + voice/packages/<id>」；
//   2. 源码里**不许再出现** `X:\...` 这种硬编码盘符（防止改回去）；
//   3. 两个包的 id / 端口没变（端口漂移会让语音路由打到空端口）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = path.join(REPO_ROOT, 'src', 'voice-packs.js');
const { DEFAULT_MANIFESTS } = await import(pathToFileURL(SOURCE).href);

let failures = 0;
const ok = (cond, label) => {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
};

console.log('## 1. 默认安装源 = 仓库上级的 voice/packages/<id>');
{
  const expected = {
    'voice-local': path.resolve(REPO_ROOT, '..', 'voice', 'packages', 'voice-local'),
    'voice-cloud': path.resolve(REPO_ROOT, '..', 'voice', 'packages', 'voice-cloud'),
  };
  for (const manifest of DEFAULT_MANIFESTS) {
    const want = expected[manifest.id];
    ok(Boolean(want), `${manifest.id}: 有预期的默认位置`);
    ok(path.isAbsolute(manifest.url), `${manifest.id}: url 是绝对路径（${manifest.url}）`);
    ok(path.normalize(manifest.url) === path.normalize(want), `${manifest.id}: url 与「仓库上级 + voice/packages/<id>」一致`);
  }
}

console.log('## 2. 源码里不再有硬编码盘符');
{
  const source = fs.readFileSync(SOURCE, 'utf8');
  // 只看字符串字面量/注释里的 `X:\` 或 `X:/`；前面紧跟字母数字的排除掉（`http://` 里的 `p:/`）
  const hardcoded = [...source.matchAll(/(?<![A-Za-z0-9+.-])[A-Za-z]:[\\/][^\s'"`]*/g)].map((m) => m[0]);
  ok(hardcoded.length === 0, `没有硬编码盘符路径${hardcoded.length ? `（发现 ${hardcoded.slice(0, 3).join(', ')}）` : ''}`);
  ok(source.includes('fileURLToPath(import.meta.url)'), '用仓库位置解析默认值（不是 cwd）');
}

console.log('## 3. 端口与 id 没漂移');
{
  const byId = new Map(DEFAULT_MANIFESTS.map((m) => [m.id, m]));
  ok(byId.get('voice-local')?.port === 8765, '本地语音包端口仍是 8765（语音路由/试音台都按它）');
  ok(byId.get('voice-cloud')?.port === 8767, '云端语音包端口仍是 8767');
  ok(byId.get('voice-local')?.startScript === 'run.bat' && byId.get('voice-cloud')?.stopScript === 'stop.bat',
    '启停脚本名未变（安装/启动/停止都按它拼路径）');
  ok(DEFAULT_MANIFESTS.every((m) => m.voices?.length >= 1), '每个包至少声明一个音色（设置页要展示）');
}

console.log(failures === 0 ? '\n✅ 语音包默认值回归通过' : `\n❌ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
