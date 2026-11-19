import { appendFile, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

/**
 * 远程变更的追加式 JSONL 审计轨迹。每次操作一行，
 * 与连接库放在一起，事后复查无需翻 Host 控制台。
 */
export class AuditLog {
  #dir;
  #file;
  #chain = Promise.resolve();
  /** 控制文件规模：轮转时丢弃较旧的行。 */
  maxLines = 5000;

  constructor(dir) {
    this.#dir = dir;
    this.#file = path.join(dir, 'audit.jsonl');
  }

  #enqueue(operation) {
    const run = this.#chain.then(operation, operation);
    this.#chain = run.catch(() => {});
    return run;
  }

  /** 记录一次操作。永不抛错：审计不能影响正常动作。 */
  async record(entry) {
    return this.#enqueue(async () => {
      try {
        await mkdir(this.#dir, { recursive: true });
        const line = JSON.stringify({ at: Date.now(), ...entry }) + '\n';
        await appendFile(this.#file, line, { mode: 0o600 });
      } catch {
        /* 审计尽力而为 */
      }
      return true;
    });
  }

  /** 最近若干条记录，最新的在前。 */
  async tail(limit = 100) {
    return this.#enqueue(async () => {
      try {
        const raw = await readFile(this.#file, 'utf8');
        const lines = raw.split('\n').filter((line) => line.trim() !== '');
        const slice = lines.slice(Math.max(0, lines.length - Math.max(1, limit)));
        return slice.reverse().map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return { raw: line };
          }
        });
      } catch {
        return [];
      }
    });
  }

  /** 行数超过 maxLines 时丢弃较旧的行。 */
  async rotate() {
    return this.#enqueue(async () => {
      try {
        const raw = await readFile(this.#file, 'utf8');
        const lines = raw.split('\n').filter((line) => line.trim() !== '');
        if (lines.length <= this.maxLines) return false;
        const kept = lines.slice(lines.length - this.maxLines).join('\n') + '\n';
        const temporary = `${this.#file}.tmp`;
        await writeFile(temporary, kept, { mode: 0o600 });
        await rename(temporary, this.#file);
        return true;
      } catch {
        return false;
      }
    });
  }

  /** 清空整份审计。 */
  async clear() {
    return this.#enqueue(async () => {
      try {
        await mkdir(this.#dir, { recursive: true });
        await writeFile(this.#file, '', { mode: 0o600 });
        return true;
      } catch {
        return false;
      }
    });
  }
}