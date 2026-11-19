/**
 * 远程 fs 后端测试：优先对真实主机跑（用已保存的连接），没有可用连接时自动跳过。
 * 只读写 /tmp 下的临时文件，结束时清理。
 */
import { ConnectionStore } from '../lib/store.js';
import { SshPool } from '../lib/ssh.js';
import { RemoteFileSystem, normalizeRemotePath, containsPath } from '../lib/fs-remote.js';

delete process.env.DSH_PROFILE_DIR; // 使用真实存储目录 ~/.dsh/remote-host-store
const storeDir = `${process.env.HOME}/.dsh/remote-host-store`;

/* ---------------- 纯函数先测（不依赖网络） ---------------- */
const cases = [
  ['/var/www/../log/./x', '/root', '/var/log/x'],
  ['a/b', '/root', '/root/a/b'],
  ['/../etc/passwd', '/root', '/etc/passwd'],
  ['/', '/root', '/'],
];
for (const [input, cwd, expected] of cases) {
  const actual = normalizeRemotePath(input, cwd);
  if (actual !== expected) throw new Error(`normalize(${input}) = ${actual}, expected ${expected}`);
}
if (!containsPath('/', '/anything')) throw new Error('root should contain everything');
if (containsPath('/var', '/varnish')) throw new Error('prefix must be segment-aware');
console.log('1. 路径规范化与包含判定 OK');

/* ---------------- 真实主机端到端 ---------------- */
const store = new ConnectionStore(storeDir);
let connections = [];
try {
  connections = await store.list();
} catch {
  connections = [];
}
if (connections.length === 0) {
  console.log('FS-REMOTE TESTS SKIPPED（没有已保存的连接）');
  process.exit(0);
}

const pool = new SshPool({
  onHostKey: (id, fingerprint) => { void store.setHostKey(id, fingerprint); }
});
const connectionId = connections[0].id;
const provider = new RemoteFileSystem({
  pool,
  getProfile: () => store.resolve(connectionId)
});

const target = await provider.resolve('/tmp');
if (target.targetKey !== '/tmp') throw new Error(`resolve('/tmp') = ${target.targetKey}`);
console.log('2. resolve OK:', target.targetKey);

const info = await provider.stat(target);
if (info === undefined || info.type !== 'directory') throw new Error(`stat('/tmp') = ${JSON.stringify(info)}`);
console.log('3. stat OK:', info.type, 'version', info.version.slice(0, 24));

const listing = await provider.listDir(target);
if (!Array.isArray(listing) || listing.length === 0) throw new Error('listDir(/tmp) returned nothing');
const names = listing.map((entry) => entry.name);
const sorted = [...names].sort();
if (names.join('|') !== sorted.join('|')) throw new Error('listDir must be name-sorted');
console.log(`4. listDir OK: ${listing.length} 项，有序`);

const file = await provider.resolve('/tmp/rh-fs-remote-test.txt');
await pool.exec(await store.resolve(connectionId), `rm -f /tmp/rh-fs-remote-test.txt`);

const written = await provider.writeText(file, 'line-1\nline-2\nline-3\n', { kind: 'createIfAbsent' });
if (written.operation !== 'create') throw new Error(`first write should create, got ${written.operation}`);
if (written.before !== null) throw new Error('create must report before=null');
console.log('5. writeText(createIfAbsent) OK');

const text = await provider.readText(file);
if (text !== 'line-1\nline-2\nline-3\n') throw new Error(`readText mismatch: ${JSON.stringify(text)}`);
console.log('6. readText OK');

// 6b. createIfAbsent on an existing file must fail with FS_ALREADY_EXISTS
const existsError = await provider.writeText(file, 'x', { kind: 'createIfAbsent' }).then(() => null, (e) => e);
if (existsError === null || existsError.code !== 'FS_ALREADY_EXISTS') {
  throw new Error(`expected FS_ALREADY_EXISTS, got ${existsError?.code ?? 'no error'}`);
}
console.log('7. createIfAbsent 拒绝覆盖 OK');

// 7b. version guard: stale write must fail, current version must succeed
const current = await provider.stat(file);
const staleError = await provider.writeText(file, 'stale', { kind: 'replaceIfVersion', version: '0:0:0' }).then(() => null, (e) => e);
if (staleError === null || staleError.code !== 'FS_STALE_VERSION') {
  throw new Error(`expected FS_STALE_VERSION, got ${staleError?.code ?? 'no error'}`);
}
const replaced = await provider.writeText(file, 'fresh-content\n', { kind: 'replaceIfVersion', version: current.version });
if (replaced.operation !== 'update') throw new Error('guarded write on an existing file must report update');
console.log('8. replaceIfVersion 版本守卫 OK');

// 8b. editText：单次字面替换
const beforeEdit = await provider.stat(file);
const edited = await provider.editText(file, { oldString: 'fresh', newString: 'edited', replaceAll: false }, { version: beforeEdit.version });
if (edited.after !== 'edited-content\n') throw new Error(`editText result: ${JSON.stringify(edited.after)}`);
console.log('9. editText OK');

// 9b. editText 使用过期版本必须报 stale
const staleEdit = await provider.editText(file, { oldString: 'edited', newString: 'x', replaceAll: false }, { version: beforeEdit.version }).then(() => null, (e) => e);
if (staleEdit === null || staleEdit.code !== 'FS_STALE_VERSION') {
  throw new Error(`expected stale edit, got ${staleEdit?.code ?? 'no error'}`);
}
console.log('10. editText 版本守卫 OK');

// 10b. readByteRange 只取窗口
const window = await provider.readByteRange(file, { offset: 0, length: 6 }, undefined);
if (Buffer.from(window).toString('utf8') !== 'edited') throw new Error(`readByteRange: ${Buffer.from(window).toString('utf8')}`);
console.log('11. readByteRange OK');

// 10c. readBytes 超过上限必须报 FS_TOO_LARGE
const tooLarge = await provider.readBytes(file, undefined, 2).then(() => null, (e) => e);
if (tooLarge === null || tooLarge.code !== 'FS_TOO_LARGE') {
  throw new Error(`expected FS_TOO_LARGE, got ${tooLarge?.code ?? 'no error'}`);
}
console.log('12. readBytes 上限 OK');

// 10d. 目录列举包含新文件，且 contains/processPath/fileUrl 语义正确
const after = await provider.listDir(target);
if (!after.some((entry) => entry.name === 'rh-fs-remote-test.txt')) throw new Error('new file missing from listing');
if (!provider.contains(target, file)) throw new Error('contains(/tmp, /tmp/file) should be true');
if (provider.processPath(file) !== '/tmp/rh-fs-remote-test.txt') throw new Error('processPath mismatch');
if (!provider.fileUrl(file).startsWith('file:///tmp/')) throw new Error('fileUrl mismatch');
console.log('13. 列举 / contains / processPath / fileUrl OK');

// 11b. watch 必须显式拒绝
const watcher = await provider.watch(file, () => {}, new AbortController().signal).then(() => null, (e) => e);
if (watcher === null || watcher.code !== 'FS_IO_ERROR') throw new Error('watch should reject with FS_IO_ERROR');
console.log('14. watch 显式拒绝 OK');

await pool.exec(await store.resolve(connectionId), `rm -f /tmp/rh-fs-remote-test.txt`);
pool.disconnect(connectionId);
console.log('FS-REMOTE TESTS PASS');
