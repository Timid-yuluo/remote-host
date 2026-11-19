/**
 * 定位插件包目录，兼容两种布局：
 *   - 开发布局：<repo>/remote-host-tests/*.mjs  +  <repo>/remote-host-plugin/
 *   - 发布布局：<repo>/tests/*.mjs              +  <repo>/（包即仓库根）
 *
 * 所有测试都通过这里取路径，避免"改了副本忘了源"这类不一致。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const candidates = [
  path.join(here, '..', 'remote-host-plugin'), // 开发布局
  path.join(here, '..') // 发布布局：仓库根就是插件包
];

const found = candidates.find((dir) => existsSync(path.join(dir, 'package.json')));

if (found === undefined) {
  throw new Error(`无法从 ${here} 定位插件包（既没有 ../remote-host-plugin/package.json，也没有 ../package.json）`);
}

/** 插件包根目录的绝对路径。 */
export const PLUGIN_DIR = found;

/** 动态导入插件包内的一个模块（带缓存破坏）。 */
export function importPlugin(relativePath) {
  const url = pathToFileURL(path.join(PLUGIN_DIR, relativePath)).href;
  return import(`${url}?v=${Date.now()}`);
}

/** 插件包内某个文件的绝对路径。 */
export function pluginPath(...segments) {
  return path.join(PLUGIN_DIR, ...segments);
}