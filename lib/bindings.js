import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

/**
 * 工作区绑定：新会话使用的默认远程工作区，外加可选的按会话绑定。
 * 与连接库存放在一起；这些记录不含机密，因此以明文 JSON（0600）保存。

 */
export class BindingStore {
  #file;
  #chain = Promise.resolve();
  #dir;

  constructor(dir) {
    this.#dir = dir;
    this.#file = path.join(dir, 'bindings.json');
  }

  #enqueue(operation) {
    const run = this.#chain.then(operation, operation);
    this.#chain = run.catch(() => {});
    return run;
  }

  async #read() {
    try {
      const parsed = JSON.parse(await readFile(this.#file, 'utf8'));
      return {
        version: 1,
        default: parsed?.default ?? null,
        sessions: parsed?.sessions ?? {}
      };
    } catch {
      return { version: 1, default: null, sessions: {} };
    }
  }

  async #write(document) {
    await mkdir(this.#dir, { recursive: true });
    const temporary = `${this.#file}.tmp`;
    await writeFile(temporary, JSON.stringify(document, null, 2), { mode: 0o600 });
    await rename(temporary, this.#file);
  }

  /** 新会话使用的默认工作区（未设置时为 null）。 */
  async getDefault() {
    return this.#enqueue(async () => (await this.#read()).default);
  }

  /** 设置默认远程工作区。 */
  async setDefault(binding) {
    return this.#enqueue(async () => {
      const document = await this.#read();
      document.default = {
        connectionId: String(binding.connectionId),
        connectionName: String(binding.connectionName ?? ''),
        path: normalizePath(binding.path),
        boundAt: Date.now()
      };
      await this.#write(document);
      return document.default;
    });
  }

  /** 清除默认远程工作区。 */
  async clearDefault() {
    return this.#enqueue(async () => {
      const document = await this.#read();
      document.default = null;
      await this.#write(document);
      return true;
    });
  }

  /** 某会话的绑定，未绑定时回退到默认工作区。 */
  async resolveForSession(sessionId) {
    return this.#enqueue(async () => {
      const document = await this.#read();
      return document.sessions[String(sessionId)] ?? document.default ?? null;
    });
  }

  /** 精确查询某会话的绑定（不做回退）。 */
  async getSession(sessionId) {
    return this.#enqueue(async () => (await this.#read()).sessions[String(sessionId)] ?? null);
  }

  /** 把一个会话绑定到远程工作区。 */
  async setSession(sessionId, binding) {
    return this.#enqueue(async () => {
      const document = await this.#read();
      const record = {
        connectionId: String(binding.connectionId),
        connectionName: String(binding.connectionName ?? ''),
        path: normalizePath(binding.path),
        boundAt: Date.now()
      };
      document.sessions[String(sessionId)] = record;
      await this.#write(document);
      return record;
    });
  }

  /** 解除某个会话的绑定。 */
  async clearSession(sessionId) {
    return this.#enqueue(async () => {
      const document = await this.#read();
      const existed = document.sessions[String(sessionId)] !== undefined;
      delete document.sessions[String(sessionId)];
      if (existed) await this.#write(document);
      return existed;
    });
  }

  /** 列出全部显式会话绑定。 */
  async listSessions() {
    return this.#enqueue(async () => {
      const document = await this.#read();
      return Object.entries(document.sessions).map(([sessionId, binding]) => ({ sessionId, ...binding }));
    });
  }
}

/** 规范化远程路径：补前导斜杠、去尾斜杠（根目录仍为 "/"）。 */
export function normalizePath(input) {
  const raw = String(input ?? '/').trim();
  if (raw === '' || raw === '.') return '/';
  const prefixed = raw.startsWith('/') ? raw : `/${raw}`;
  const collapsed = prefixed.replace(/\/+/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/$/, '') || '/' : '/';
}