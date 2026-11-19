import net from 'node:net';
import { createHash } from 'node:crypto';
import { Client } from 'ssh2';

const CONNECT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_READ_BYTES = 2 * 1024 * 1024;

/** 把一个 SFTP 回调式调用 Promise 化。 */
function call(sftp, method, ...args) {
  return new Promise((resolve, reject) => {
    sftp[method](...args, (error, result) => (error === undefined || error === null ? resolve(result) : reject(error)));
  });
}

/** 把一个 SFTP 流读到结束的 Promise 化封装（只结算一次）。 */
function drain(stream, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error !== undefined) reject(error);
      else resolve(value);
    };
    stream.on('data', (chunk) => {
      if (settled) return;
      total += chunk.byteLength;
      chunks.push(chunk);
      if (limitBytes !== undefined && total >= limitBytes) {
        const value = Buffer.concat(chunks).subarray(0, limitBytes);
        stream.destroy();
        finish(undefined, value);
      }
    });
    stream.on('error', (error) => finish(error));
    stream.on('end', () => finish(undefined, Buffer.concat(chunks)));
    stream.on('close', () => finish(undefined, Buffer.concat(chunks)));
  });
}

/** 判断缓冲区是否像文本（无 NUL、控制字节很少）。 */
function looksLikeText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.byteLength, 8192));
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  }
  return control / Math.max(sample.byteLength, 1) < 0.05;
}

/** 建立一个 SSH 客户端，ready 时结算。 */
function connectClient(options) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) {
        client.end();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(() => finish(new Error(`连接超时（${CONNECT_TIMEOUT_MS / 1000}s 内未完成握手）`)), CONNECT_TIMEOUT_MS);
    client.on('ready', () => finish(undefined, client));
    client.on('error', (error) => finish(error instanceof Error ? error : new Error(String(error))));
    client.connect(options);
  });
}

/** 为 POSIX shell 转义一个字符串。 */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** 由已保存的连接记录构造 ssh2 连接参数。 */
/** 按 OpenSSH 惯例计算一个主机密钥 blob 的 SHA256 指纹。 */
export function fingerprintOf(key) {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/** 这些错误说明「隧道断了」，而不是「操作非法」。 */
const TRANSPORT_ERROR = /ECONNRESET|ECONNABORTED|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|socket hang up|Connection lost|No response from server|client is not connected|Channel open failure|Keepalive timeout/i;

export function connectOptions(profile, hooks = {}) {
  const options = {
    host: profile.host,
    port: profile.port ?? 22,
    username: profile.username,
    readyTimeout: CONNECT_TIMEOUT_MS,
    keepaliveInterval: 10000,
    keepaliveCountMax: 6
  };
  // 首次信任（TOFU）：首次记录指纹，此后一旦变化即拒绝。
  options.hostVerifier = (key) => {
    const fingerprint = fingerprintOf(key);
    const known = profile.hostKey;
    if (known === undefined || known === '') {
      hooks.onHostKey?.(fingerprint);
      return true;
    }
    if (known === fingerprint) return true;
    hooks.onHostKeyMismatch?.({ expected: known, actual: fingerprint });
    return false;
  };

  if (profile.authType === 'key') {
    if (profile.privateKey === undefined || profile.privateKey === '') throw new Error('该连接未保存私钥');
    options.privateKey = profile.privateKey;
    if (profile.passphrase) options.passphrase = profile.passphrase;
  } else {
    if (profile.password === undefined) throw new Error('该连接未保存密码');
    options.password = profile.password;
  }
  return options;
}

function entryKind(attrs) {
  if (attrs.isDirectory()) return 'dir';
  if (attrs.isFile()) return 'file';
  if (attrs.isSymbolicLink()) return 'link';
  return 'other';
}

/**
 * 按连接维护的 SSH 会话池：首次操作时惰性建立，
 * 由 Web 面板与 agent 工具共同复用。
 */
export class SshPool {
  #sessions = new Map();
  #pending = new Map();
  #idle = new Map();
  #sweep = null;
  /** 超过该时长未活动的会话将被关闭（30 分钟）。 */
  idleMs = 30 * 60 * 1000;

  #onHostKey;
  #onHostKeyMismatch;

  constructor(hooks = {}) {
    this.#onHostKey = hooks.onHostKey;
    this.#onHostKeyMismatch = hooks.onHostKeyMismatch;
    this.#sweep = setInterval(() => this.#reapIdle(), 60000);
    this.#sweep.unref?.();
  }

  /**
   * 在活会话上执行一次操作；传输层断开时重连一次再重试。
   * 通道死亡不属于用户错误。
   */
  async #run(profile, operation) {
    const session = await this.ensure(profile);
    try {
      return await operation(session);
    } catch (error) {
      if (!TRANSPORT_ERROR.test(String(error?.message ?? error))) throw error;
      this.#close(profile.id);
      return await operation(await this.ensure(profile));
    }
  }

  #touch(id) {
    this.#idle.set(id, Date.now());
  }

  #reapIdle() {
    const now = Date.now();
    for (const [id, last] of this.#idle) {
      if (now - last > this.idleMs) this.#close(id);
    }
  }

  /** 当前存活的会话 id。 */
  active() {
    return [...this.#sessions.keys()];
  }

  /** 某连接当前是否有存活会话。 */
  isActive(id) {
    return this.#sessions.has(id);
  }

  /** 打开（或复用）某个连接的会话；返回 { client, sftp }。 */
  async ensure(profile) {
    const existing = this.#sessions.get(profile.id);
    if (existing !== undefined) {
      try {
        await call(existing.sftp, 'realpath', '.');
        this.#touch(profile.id);
        return existing;
      } catch {
        this.#close(profile.id);
      }
    }
    // 每个连接同一时刻只允许一次建连：并发调用共享同一次尝试，
    // 而不是各自开一条 SSH 会话。
    const pending = this.#pending.get(profile.id);
    if (pending !== undefined) return pending;
    const attempt = this.#connect(profile).finally(() => {
      this.#pending.delete(profile.id);
    });
    this.#pending.set(profile.id, attempt);
    return attempt;
  }

  async #connect(profile) {
    // 跳板机支持：把 TCP 流经已连接的主机转发出去。
    let sock = null;
    if (profile.jump !== undefined && profile.jump !== null) {
      const jump = await this.ensure(profile.jump);
      sock = await new Promise((resolve, reject) => {
        jump.client.forwardOut('127.0.0.1', 0, profile.host, profile.port ?? 22, (error, stream) => {
          if (error) reject(new Error(`跳板机转发失败：${error.message}`));
          else resolve(stream);
        });
      });
    }

    let mismatch = null;
    const baseOptions = connectOptions(profile, {
      onHostKey: (fingerprint) => this.#onHostKey?.(profile.id, fingerprint),
      onHostKeyMismatch: (info) => {
        mismatch = info;
        this.#onHostKeyMismatch?.(profile.id, info);
      }
    });
    if (sock !== null) {
      delete baseOptions.host;
      delete baseOptions.port;
      baseOptions.sock = sock;
    }
    const client = await connectClient(baseOptions).catch((error) => {
      if (mismatch !== null) {
        throw new Error(
          `主机密钥已改变，连接被拒绝（可能存在中间人攻击）。已记录 ${mismatch.expected}，本次 ${mismatch.actual}；` +
          `确认主机重装过可重置该连接的指纹。`
        );
      }
      throw error;
    });
    try {
      const sftp = await new Promise((resolve, reject) => {
        client.sftp((error, handle) => (error ? reject(error) : resolve(handle)));
      });
      const session = { client, sftp };
      this.#sessions.set(profile.id, session);
      this.#touch(profile.id);
      client.on('close', () => this.#close(profile.id));
      client.on('end', () => this.#close(profile.id));
      return session;
    } catch (error) {
      client.end();
      throw error;
    }
  }

  /** 关闭一个会话（幂等）。 */
  disconnect(id) {
    return this.#close(id);
  }

  /** 开本地 TCP 转发：127.0.0.1:本地端口 → 远程主机:端口，经受管连接转发。 */
  async openTunnel(profile, options = {}) {
    const localPort = Number(options.localPort ?? 0);
    const remoteHost = String(options.remoteHost ?? '127.0.0.1');
    const remotePort = Number(options.remotePort ?? 0);
    if (!Number.isInteger(remotePort) || remotePort <= 0 || remotePort > 65535) throw new Error('远程端口无效');
    if (!Number.isInteger(localPort) || localPort < 0 || localPort > 65535) throw new Error('本地端口无效');
    const { client } = await this.ensure(profile);
    const server = net.createServer((socket) => {
      client.forwardOut('127.0.0.1', socket.remotePort ?? 0, remoteHost, remotePort, (error, stream) => {
        if (error) {
          socket.destroy();
          return;
        }
        socket.pipe(stream).pipe(socket);
        stream.on('error', () => socket.destroy());
        socket.on('error', () => stream.destroy());
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(localPort, '127.0.0.1', resolve);
    });
    const bound = server.address();
    const port = typeof bound === 'object' && bound !== null ? bound.port : localPort;
    return { server, localPort: port, remoteHost, remotePort };
  }

  /** 关闭所有会话并停止空闲扫描。 */
  disposeAll() {
    for (const id of [...this.#sessions.keys()]) this.#close(id);
    if (this.#sweep !== null) {
      clearInterval(this.#sweep);
      this.#sweep = null;
    }
  }

  #close(id) {
    const session = this.#sessions.get(id);
    if (session === undefined) {
      this.#idle.delete(id);
      return false;
    }
    this.#sessions.delete(id);
    this.#idle.delete(id);
    try {
      session.client.end();
    } catch {
      /* already gone */
    }
    return true;
  }

  /** 在某连接的 SFTP 上执行操作，按需建立会话。 */
  async withSftp(profile, operation) {
    return this.#run(profile, ({ sftp }) => operation(sftp));
  }

  /** 列出一个目录。 */
  async list(profile, dirPath) {
    return this.withSftp(profile, async (sftp) => {
      const resolved = dirPath === undefined || dirPath === '' ? '.' : dirPath;
      const raw = await call(sftp, 'readdir', resolved);
      const entries = raw.map((entry) => ({
        name: entry.filename,
        type: entryKind(entry.attrs),
        size: Number(entry.attrs.size ?? 0),
        mode: Number(entry.attrs.mode ?? 0) & 0o7777,
        mtime: Number(entry.attrs.mtime ?? 0) * 1000
      }));
      entries.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
      let absolute = resolved;
      try {
        absolute = await call(sftp, 'realpath', resolved);
      } catch {
        /* keep the requested path */
      }
      return { path: absolute, requested: resolved, entries };
    });
  }

  /** 读一个文件（有上限）；二进制返回 base64。 */
  async read(profile, filePath, maxBytes = DEFAULT_MAX_READ_BYTES) {
    return this.withSftp(profile, async (sftp) => {
      const stats = await call(sftp, 'stat', filePath);
      if (stats.isDirectory()) throw new Error('目标是一个目录');
      const bounded = Math.min(stats.size, maxBytes);
      let buffer;
      if (stats.size <= maxBytes) {
        buffer = await call(sftp, 'readFile', filePath);
      } else {
        buffer = await drain(sftp.createReadStream(filePath, { start: 0, end: bounded - 1 }), bounded);
      }
      if (looksLikeText(buffer)) {
        return {
          path: filePath,
          size: Number(stats.size),
          truncated: stats.size > buffer.byteLength,
          binary: false,
          content: buffer.toString('utf8')
        };
      }
      return {
        path: filePath,
        size: Number(stats.size),
        truncated: stats.size > buffer.byteLength,
        binary: true,
        base64: buffer.toString('base64')
      };
    });
  }

  /** 写（新建或覆盖）一个文本文件；`backup` 会把原内容保留在旁边。 */
  async write(profile, filePath, content, options = {}) {
    return this.withSftp(profile, async (sftp) => {
      let backupPath;
      if (options.backup === true) {
        const existing = await call(sftp, 'stat', filePath).catch(() => undefined);
        if (existing !== undefined && existing.isFile()) {
          const previous = await call(sftp, 'readFile', filePath);
          backupPath = `${filePath}.bak`;
          await sftp.writeFile(backupPath, previous);
        }
      }
      await sftp.writeFile(filePath, content, 'utf8');
      const stats = await call(sftp, 'stat', filePath);
      return { path: filePath, size: Number(stats.size), backup: backupPath };
    });
  }

  /** 读取文本文件的某个行区间（用于大文件分段读）。 */
  async readLines(profile, filePath, offsetLine = 1, limitLines = 200) {
    const start = Math.max(1, Number(offsetLine) || 1);
    const count = Math.min(Math.max(1, Number(limitLines) || 200), 2000);
    const end = start + count - 1;
    const result = await this.exec(profile, `sed -n '${start},${end}p' ${shellQuote(filePath)}`);
    const lines = result.stdout.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return {
      path: filePath,
      offset: start,
      limit: count,
      nextOffset: lines.length === count ? end + 1 : null,
      lines: lines.length,
      content: lines.join('\n')
    };
  }

  /** 在绝对偏移处写入一段数据（'w' 会先截断）。 */
  async uploadChunk(profile, filePath, buffer, offset = 0, truncate = false) {
    return this.withSftp(profile, (sftp) => new Promise((resolve, reject) => {
      const flags = truncate ? 'w' : 'r+';
      sftp.open(filePath, flags, (openError, handle) => {
        if (openError) {
          reject(openError);
          return;
        }
        sftp.write(handle, buffer, 0, buffer.length, offset, (writeError) => {
          sftp.close(handle, () => {
            if (writeError) reject(writeError);
            else resolve({ path: filePath, wrote: buffer.length, offset });
          });
        });
      });
    }));
  }

  /** 新建目录（父目录需已存在）。 */
  async mkdir(profile, dirPath) {
    return this.withSftp(profile, async (sftp) => {
      await call(sftp, 'mkdir', dirPath);
      return { path: dirPath };
    });
  }

  /** 经 exec 通道执行一条命令（输出有上限）。 */
  async exec(profile, command, options = {}) {
    const timeoutMs = Number(options.timeoutMs ?? 30000);
    const maxOutput = Number(options.maxOutput ?? 200000);
    const full = options.cwd === undefined || options.cwd === ''
      ? String(command)
      : `cd ${shellQuote(options.cwd)} && ${command}`;
    return this.#run(profile, ({ client }) => this.#execOn(client, full, timeoutMs, maxOutput));
  }

  #execOn(client, full, timeoutMs, maxOutput) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish({ stdout: '', stderr: '', exitCode: null, timedOut: true, truncated: false }), timeoutMs);
      client.exec(full, (error, stream) => {
        if (error) {
          clearTimeout(timer);
          reject(error);
          return;
        }
        let stdout = '';
        let stderr = '';
        let truncated = false;
        const push = (text, into) => {
          const combined = into + text;
          if (combined.length > maxOutput) {
            truncated = true;
            return { text: combined.slice(0, maxOutput), truncated: true };
          }
          return { text: combined, truncated };
        };
        stream.on('data', (chunk) => {
          const next = push(chunk.toString('utf8'), stdout);
          stdout = next.text;
          truncated = truncated || next.truncated;
        });
        stream.stderr.on('data', (chunk) => {
          const next = push(chunk.toString('utf8'), stderr);
          stderr = next.text;
          truncated = truncated || next.truncated;
        });
        stream.on('close', (code) => finish({ stdout, stderr, exitCode: code ?? 0, timedOut: false, truncated }));
        stream.on('error', (streamError) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(streamError);
        });
      });
    });
  }

  /** 修改某路径的权限位（八进制，如 0o755）。 */
  async chmod(profile, target, mode) {
    const bits = typeof mode === 'number' ? mode : Number.parseInt(String(mode ?? ''), 8);
    if (!Number.isInteger(bits) || bits < 0 || bits > 0o7777) throw new Error('权限值无效（请用八进制，如 755）');
    return this.withSftp(profile, async (sftp) => {
      await call(sftp, 'chmod', target, bits);
      return { path: target, mode: bits.toString(8).padStart(3, '0') };
    });
  }

  /** Upload one base64 payload to a remote path (binary safe). */
  async upload(profile, filePath, base64) {
    const buffer = Buffer.from(String(base64 ?? ''), 'base64');
    if (buffer.byteLength === 0) throw new Error('上传内容为空');
    return this.withSftp(profile, async (sftp) => {
      await sftp.writeFile(filePath, buffer);
      const stats = await call(sftp, 'stat', filePath);
      return { path: filePath, size: Number(stats.size) };
    });
  }

  /** Download one remote file as base64 (bounded). */
  async download(profile, filePath, maxBytes = 8 * 1024 * 1024) {
    return this.withSftp(profile, async (sftp) => {
      const stats = await call(sftp, 'stat', filePath);
      if (stats.isDirectory()) throw new Error('目标是一个目录');
      if (stats.size > maxBytes) throw new Error(`文件过大（${stats.size} 字节），超过下载上限 ${maxBytes} 字节`);
      const buffer = await call(sftp, 'readFile', filePath);
      return {
        path: filePath,
        size: buffer.byteLength,
        name: filePath.split('/').pop() ?? 'download',
        base64: buffer.toString('base64')
      };
    });
  }

  /** Disk usage of one path through `du`. */
  async du(profile, target) {
    const result = await this.exec(profile, `du -sh ${shellQuote(target ?? '.')} 2>/dev/null | head -n 1`);
    const line = result.stdout.trim();
    const [size, ...rest] = line.split(/\s+/);
    if (size === undefined || size === '') throw new Error('无法获取目录大小（远程可能缺少 du）');
    return { path: rest.join(' ') || target, size };
  }

  /** Search file contents on the remote host with grep. */
  async search(profile, options = {}) {
    const pattern = String(options.pattern ?? '');
    if (pattern === '') throw new Error('search 需要 pattern 参数');
    const target = options.path === undefined || options.path === '' ? '.' : String(options.path);
    const maxLines = Math.min(Number(options.maxLines ?? 200) || 200, 1000);
    const command = `grep -rnI -E --max-count=3 ${shellQuote(pattern)} ${shellQuote(target)} 2>/dev/null | head -n ${maxLines}`;
    const result = await this.exec(profile, command, { timeoutMs: options.timeoutMs ?? 60000, cwd: options.cwd });
    const matches = result.stdout.split('\n').filter((line) => line !== '');
    return {
      pattern,
      path: target,
      matches,
      count: matches.length,
      truncated: result.truncated,
      note: matches.length === 0 ? '没有匹配（或远程缺少 grep）' : undefined
    };
  }

  /** Stat one path. */
  async stat(profile, target) {
    return this.withSftp(profile, async (sftp) => {
      const stats = await call(sftp, 'stat', target);
      return {
        path: target,
        type: entryKind(stats),
        size: Number(stats.size),
        mtime: Number(stats.mtime ?? 0) * 1000
      };
    });
  }

  /** Rename/move one path. */
  async rename(profile, from, to) {
    return this.withSftp(profile, async (sftp) => {
      await call(sftp, 'rename', from, to);
      return { from, to };
    });
  }

  /** Remove one file or directory (recursive for directories). */
  async remove(profile, target, recursive = true) {
    return this.withSftp(profile, async (sftp) => {
      const stats = await call(sftp, 'lstat', target);
      if (stats.isDirectory()) {
        if (!recursive) {
          const children = await call(sftp, 'readdir', target);
          if (children.length > 0) throw new Error('目录非空；请允许递归删除');
          await call(sftp, 'rmdir', target);
        } else {
          await this.#removeTree(sftp, target);
        }
      } else {
        await call(sftp, 'unlink', target);
      }
      return { path: target };
    });
  }

  async #removeTree(sftp, target) {
    const stats = await call(sftp, 'lstat', target).catch(() => undefined);
    if (stats === undefined) return;
    if (stats.isDirectory()) {
      const children = await call(sftp, 'readdir', target);
      for (const child of children) {
        await this.#removeTree(sftp, `${target.replace(/\/$/, '')}/${child.filename}`);
      }
      await call(sftp, 'rmdir', target);
    } else {
      await call(sftp, 'unlink', target);
    }
  }
}
