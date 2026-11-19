import { PLUGIN_DIR } from './_paths.mjs';
/**
 * Static consistency gate for the Remote Host plugin.
 *
 * `node --check` only proves each file parses; this script also proves the two
 * halves agree with each other:
 *   1. every file parses
 *   2. every endpoint the client calls exists on the host
 *   3. the zh/en dictionaries have identical key sets
 *   4. the client chunk obeys the DSH chunk contract (name + module id + files[])
 *   5. no leftover debugger/console-noise in the shipped bundle
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = PLUGIN_DIR;
const node = process.execPath;

const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}
function read(name) {
  return readFileSync(path.join(pluginDir, name), 'utf8');
}

/* 1. syntax --------------------------------------------------------- */
const files = ['entry.js', 'app.js', 'client.js', 'client.parts.js', 'lib/store.js', 'lib/ssh.js', 'lib/bindings.js', 'lib/audit.js'];
for (const file of files) {
  try {
    execFileSync(node, ['--check', path.join(pluginDir, file)], { stdio: 'pipe' });
  } catch (error) {
    fail(`${file}: syntax error\n${error.stderr?.toString() ?? error.message}`);
  }
}

/* 2. client → host endpoint coverage -------------------------------- */
const clientSource = read('client.js');
const hostSource = read('app.js');

const called = new Set();
for (const match of clientSource.matchAll(/\bcall\(\s*'([\w.]+)'/g)) called.add(match[1]);

const defined = new Set();
for (const match of hostSource.matchAll(/^\s{4}async '([\w.]+)'\(/gm)) defined.add(match[1]);

const missing = [...called].filter((endpoint) => !defined.has(endpoint));
if (missing.length > 0) fail(`client calls endpoints the host does not define: ${missing.join(', ')}`);

const unused = [...defined].filter((endpoint) => !called.has(endpoint) && !hostSource.includes(`'${endpoint}'`) === false);
const neverCalled = [...defined].filter((endpoint) => !called.has(endpoint));
if (neverCalled.length > 0) notes.push(`host endpoints not called by the panel: ${neverCalled.join(', ')}`);

/* 3. dictionary parity ---------------------------------------------- */
const dictMatch = /const DICTS = \{([\s\S]*?)\n    \};/.exec(read('client.parts.js'));
if (dictMatch === null) {
  fail('client.parts.js: DICTS block not found');
} else {
  const block = dictMatch[1];
  const keysIn = (name) => {
    const start = block.indexOf(`${name}: {`);
    if (start === -1) return null;
    const end = block.indexOf('\n      }', start);
    const slice = block.slice(start, end === -1 ? block.length : end);
    const keys = new Set();
    for (const match of slice.matchAll(/^\s+([\w]+):/gm)) keys.add(match[1]);
    return keys;
  };
  const zh = keysIn('zh');
  const en = keysIn('en');
  if (zh === null || en === null) {
    fail('client.parts.js: zh/en dictionaries not both present');
  } else {
    const onlyZh = [...zh].filter((key) => !en.has(key));
    const onlyEn = [...en].filter((key) => !zh.has(key));
    if (onlyZh.length > 0) fail(`dictionary keys missing from en: ${onlyZh.join(', ')}`);
    if (onlyEn.length > 0) fail(`dictionary keys missing from zh: ${onlyEn.join(', ')}`);
    notes.push(`dictionary keys: ${zh.size}`);
  }
}

/* 3b. every t('…') key must exist in both dictionaries ------------- */
{
  const used = new Set();
  for (const match of clientSource.matchAll(/\bt\(\s*'([\w]+)'/g)) used.add(match[1]);
  const dictSource = read('client.parts.js');
  const block = /const DICTS = \{([\s\S]*?)\n    \};/.exec(dictSource)?.[1] ?? '';
  const keysIn = (name) => {
    const start = block.indexOf(`${name}: {`);
    if (start === -1) return new Set();
    const end = block.indexOf('\n      }', start);
    const slice = block.slice(start, end === -1 ? block.length : end);
    return new Set([...slice.matchAll(/^\s+([\w]+):/gm)].map((m) => m[1]));
  };
  const zhKeys = keysIn('zh');
  const enKeys = keysIn('en');
  const missingZh = [...used].filter((key) => !zhKeys.has(key));
  const missingEn = [...used].filter((key) => !enKeys.has(key));
  if (missingZh.length > 0) fail(`t() keys missing from zh (would render the raw key): ${missingZh.join(', ')}`);
  if (missingEn.length > 0) fail(`t() keys missing from en: ${missingEn.join(', ')}`);
  const unusedKeys = [...zhKeys].filter((key) => !used.has(key));
  if (unusedKeys.length > 0) notes.push(`dictionary keys never used: ${unusedKeys.join(', ')}`);
  notes.push(`translation coverage: ${used.size} keys used by the panel`);
}

/* 3c. 工具定义必须满足 DSH 注册契约（output.schema + render）------ */
{
  const appSource = hostSource;
  if (!/output:\s*\{/.test(appSource)) fail('工具定义缺少 output 声明（DSH register() 会直接抛错）');
  if (!/render\(/.test(appSource)) fail('output 缺少 render()');
  if (!/presentationMeta\(/.test(appSource)) notes.push('未提供 output.presentationMeta（工具卡片信息较少）');
}

/* 4. chunk contract -------------------------------------------------- */
const pkg = JSON.parse(read('package.json'));
const chunkName = 'client.parts.js';
if (!/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(chunkName)) fail(`chunk name violates the DSH pattern: ${chunkName}`);
if (!existsSync(path.join(pluginDir, chunkName))) fail(`missing chunk file: ${chunkName}`);
if (!Array.isArray(pkg.files) || !pkg.files.includes(chunkName)) fail(`package.json#files does not ship ${chunkName}`);
const chunkSource = read(chunkName);
// DSH 0.2.x 的 ClientBundleRegistration 契约：id 为包名，chunk 为包内文件名
if (!chunkSource.includes(`id: '${pkg.name}'`)) fail(`chunk must declare id: '${pkg.name}'`);
if (!chunkSource.includes(`chunk: '${chunkName}'`)) fail(`chunk must declare chunk: '${chunkName}'`);
const idDecl = /id:\s*'([^']*)'/.exec(chunkSource);
if (idDecl !== null && idDecl[1] !== pkg.name) {
  fail(`chunk 的 id 应为包名 '${pkg.name}'（当前 '${idDecl[1]}'）；文件名放到 chunk 字段`);
}
if (pkg.icon !== undefined && !existsSync(path.join(pluginDir, pkg.icon))) fail(`package.json#icon 指向不存在的文件: ${pkg.icon}`);
if (pkg.engines?.dsh === undefined) notes.push('未声明 engines.dsh（兼容范围）');
if (!clientSource.includes(`require.async('./${chunkName}')`)) fail(`entry never loads ./${chunkName}`);
if (!chunkSource.includes('try') && !clientSource.includes('catch')) {
  fail('chunk load has no failure fallback');
}

/* 5. shipping hygiene ------------------------------------------------ */
for (const file of ['client.js', 'app.js', 'lib/ssh.js', 'lib/store.js']) {
  const source = read(file);
  if (/\bdebugger\b/.test(source)) fail(`${file}: contains a debugger statement`);
  if (/console\.log\(/.test(source)) fail(`${file}: contains console.log`);
}

/* report ------------------------------------------------------------- */
if (notes.length > 0) for (const note of notes) console.log(`note: ${note}`);

if (failures.length > 0) {
  console.error(`LINT FAILED (${failures.length})`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

console.log(`LINT OK — ${files.length} files parse, ${called.size} endpoints matched, dictionaries aligned, chunk contract valid`);