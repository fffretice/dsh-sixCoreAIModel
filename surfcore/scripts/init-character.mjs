#!/usr/bin/env node
// init-character.mjs —— 从模板生成一个新角色
//
// 用法：
//   node scripts/init-character.mjs --name 女儿 --owner 123456789
//   node scripts/init-character.mjs --name 女儿 --owner 123456789 --call 主人 --force
//
// 做三件事：
//   1. roles/<name>.md        ← roles/_TEMPLATE.md（替换 {{NAME}} / {{OWNER_QQ}} / {{OWNER_CALL}}）
//   2. roles/<name>.规则.md    ← roles/_TEMPLATE.规则.md
//   3. state/current-role.json ← {"role": "<name>", "mode": "active"}
//
// 不碰角色卡以外的东西；已存在时默认不覆盖（要覆盖加 --force）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ROLES = path.join(ROOT, 'roles');
const STATE = path.join(ROOT, 'state');

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? String(process.argv[i + 1] ?? '') : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const name = arg('name').trim();
const owner = arg('owner').trim();
const call = arg('call', '主人').trim() || '主人';
const force = has('force');

if (!name) {
  console.error('缺少 --name。用法：node scripts/init-character.mjs --name 女儿 --owner 123456789');
  process.exit(1);
}
if (!/^[\w\u4e00-\u9fff-]{1,24}$/u.test(name)) {
  console.error('角色名只能包含中英文、数字、下划线和短横线，长度 1–24。');
  process.exit(1);
}
if (owner && !/^\d{5,12}$/.test(owner)) {
  console.error('--owner 应该是 QQ 号（纯数字）。不确定就先不填，之后在 roles/<名字>.md 里改。');
  process.exit(1);
}

const tpl = (f) => fs.readFileSync(path.join(ROLES, f), 'utf8');
const personaFile = path.join(ROLES, `${name}.md`);
const rulesFile = path.join(ROLES, `${name}.规则.md`);

for (const f of [personaFile, rulesFile]) {
  if (fs.existsSync(f) && !force) {
    console.error(`已存在：${path.relative(ROOT, f)}（要覆盖请加 --force）`);
    process.exit(1);
  }
}

const fill = (s) =>
  s
    .replaceAll('{{NAME}}', name)
    .replaceAll('{{OWNER_QQ}}', owner || '<你的QQ号>')
    .replaceAll('{{OWNER_CALL}}', call);

fs.writeFileSync(personaFile, fill(tpl('_TEMPLATE.md')));
fs.writeFileSync(rulesFile, fill(tpl('_TEMPLATE.规则.md')));

fs.mkdirSync(STATE, { recursive: true });
fs.writeFileSync(
  path.join(STATE, 'current-role.json'),
  JSON.stringify({ role: name, mode: 'active' }, null, 2) + '\n'
);

console.log(`已创建角色「${name}」：`);
console.log(`  人格：${path.relative(ROOT, personaFile)}`);
console.log(`  规则：${path.relative(ROOT, rulesFile)}`);
console.log(`  当前角色已切换为：${name}`);
console.log('');
console.log('下一步：打开人格卡，把「【填写】」换成你自己的设定。');
console.log('写之前建议先看一眼 ../docs/CHARACTER.md —— 那一节决定她像不像人。');
if (!owner) console.log('提示：没给 --owner，卡里的 {{OWNER_QQ}} 还是占位符，记得自己填。');
