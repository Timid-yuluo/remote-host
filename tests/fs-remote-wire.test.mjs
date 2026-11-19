// 验证：开启 remoteFs 时插件会 provide('fs')，关闭时不动
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function boot(config) {
  process.env.DSH_PROFILE_DIR = await mkdtemp(path.join(tmpdir(), 'rh-wire-'));
  const mod = await import(new URL('../app.js', import.meta.url).href + `?v=${Math.random()}`);
  const provided = [];
  const ctx = {
    get connection() { return { requestRejection: () => undefined }; },
    get webServer() { return { register: () => () => {} }; },
    get tools() { return { register: () => () => {} }; },
    effect: (fn) => { fn(); return () => {}; },
    on: () => () => {},
    provide: (name, value) => { provided.push({ name, value }); return () => {}; },
    get: () => undefined
  };
  mod.apply(ctx, config);
  return provided;
}

const off = await boot({});
if (off.length !== 0) throw new Error(`remoteFs 关闭时不该 provide，实际: ${off.map((p) => p.name)}`);
console.log('1. 默认关闭：不接管 fs OK');

const on = await boot({ remoteFs: { enabled: true, connection: 'whatever' } });
const fsProvider = on.find((entry) => entry.name === 'fs');
if (fsProvider === undefined) throw new Error('remoteFs 开启时应 provide("fs")');
for (const method of ['resolve', 'stat', 'lstat', 'readText', 'streamText', 'readBytes', 'readByteRange', 'listDir', 'writeText', 'editText', 'watch', 'contains', 'processPath', 'fileUrl']) {
  if (typeof fsProvider.value[method] !== 'function') throw new Error(`fs 后端缺少方法 ${method}`);
}
console.log('2. 开启后 provide("fs")，14 个契约方法齐备 OK');
console.log('WIRE TEST PASS');
