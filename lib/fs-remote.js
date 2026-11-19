/**
 * SSH 远程文件系统后端：把 `ctx.fs` 契约实现在 SFTP 上。
 *
 * 用途：让整个 Harness 的「执行世界」变成远程主机——bash/read/write/edit/glob/grep
 * 以及 workingDirectory 的路径校验都落到远程，因此会话的工作目录可以是真实的远程路径。
 *
 * 注意：`fs` 是进程级单例服务。启用本后端时必须在 profile 里禁用
 * `@deepseek-ai/dsh-fs-local`，否则 `ctx.provide('fs')` 会因重复注册而抛错。
 */

/** 错误码词汇与 @deepseek-ai/dsh-fs 对齐（下游按 code 路由，不解析 message）。 */
const FS_NOT_FOUND = 'FS_NOT_FOUND';
const FS_PERMISSION_DENIED = 'FS_PERMISSION_DENIED';
const FS_NOT_DIRECTORY = 'FS_NOT_DIRECTORY';
const FS_NOT_REGULAR_FILE = 'FS_NOT_REGULAR_FILE';
const FS_TOO_LARGE = 'FS_TOO_LARGE';
const FS_STALE_VERSION = 'FS_STALE_VERSION';
const FS_ALREADY_EXISTS = 'FS_ALREADY_EXISTS';
const FS_IO_ERROR = 'FS_IO_ERROR';
const FS_ABORTED = 'FS_ABORTED';

/** 构造与 FsError 同形的错误：Error + 稳定 code。 */
export function fsError(message, code, cause) {
  const error = new Error(message);
  error.name = 'FsError';
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

/** SFTP 状态码（2 = 文件不存在，3 = 权限不足，4 = 失败）。 */
function sftpCode(error) {
  return typeof error?.code === 'number' ? error.code : undefined;
}

function mapSftpError(error, verb, displayPath) {
  if (error !== null && typeof error === 'object' && typeof error.code === 'string') return error;
  const code = sftpCode(error);
  const detail = error?.message ?? String(error);
  if (code === 2) return fsError(`cannot ${verb} "${displayPath}": not found`, FS_NOT_FOUND, error);
  if (code === 3) return fsError(`cannot ${verb} "${displayPath}": permission denied`, FS_PERMISSION_DENIED, error);
  return fsError(`cannot ${verb} "${displayPath}": ${detail}`, FS_IO_ERROR, error);
}

function assertNotAborted(signal, verb) {
  if (signal?.aborted === true) throw fsError(`${verb} aborted`, FS_ABORTED);
}

/** 规范化远程 POSIX 路径（绝对化、去尾斜杠、收敛 . 与 ..）。 */
export function normalizeRemotePath(input, cwd = '/') {
  const raw = String(input ?? '');
  const base = raw.startsWith('/') ? '' : `${cwd.replace(/\/+$/, '') || ''}/`;
  const parts = `${base}${raw}`.split('/');
  const stack = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return `/${stack.join('/')}`;
}

/** 直接子项判定：使用规范化前缀，不做字符串包含。 */
export function containsPath(parent, child) {
  if (parent === child) return true;
  const prefix = parent === '/' ? '/' : `${parent}/`;
  return child.startsWith(prefix);
}

/** 由 SFTP 属性推导稳定版本令牌（stale 检测依赖它）。 */
function versionOf(attrs) {
  const mtime = typeof attrs?.mtime === 'number' ? attrs.mtime : 0;
  const size = typeof attrs?.size === 'number' ? attrs.size : 0;
  const mode = typeof attrs?.mode === 'number' ? attrs.mode : 0;
  return `${mtime}:${size}:${mode}`;
}

function kindOf(attrs) {
  if (attrs?.isDirectory?.() === true) return 'directory';
  if (attrs?.isFile?.() === true) return 'file';
  if (attrs?.isSymbolicLink?.() === true) return 'symlink';
  return 'other';
}

/** 二进制拒绝：与本地后端一致——含 NUL 视为二进制。 */
function decodeText(buffer, displayPath) {
  if (buffer.includes(0)) {
    throw fsError(`cannot read "${displayPath}": binary content`, FS_IO_ERROR);
  }
  return buffer.toString('utf8');
}

export class RemoteFileSystem {
  #pool;
  #getProfile;
  #maxBytes;

  /**
   * @param options.pool - 现有 SSH 连接池（SshPool）
   * @param options.getProfile - 返回当前使用的连接记录（含凭据）
   * @param options.maxBytes - 单次读取的硬上限，默认 8 MiB
   */
  constructor(options) {
    this.#pool = options.pool;
    this.#getProfile = options.getProfile;
    this.#maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  }

  /** 不施加沙箱：由 tool 层如实展示升级字段。 */
  get sandboxMode() {
    return undefined;
  }

  #sftp(operation) {
    return this.#getProfile().then((profile) => this.#pool.withSftp(profile, operation));
  }

  /* ---------------- 身份与路径 ---------------- */

  async resolve(path, opts = {}) {
    const display = normalizeRemotePath(path, opts.cwd ?? '/');
    if (display.trim() === '' || display === '') {
      throw fsError('file_path must be a non-empty string', FS_NOT_FOUND);
    }
    try {
      const real = await this.#sftp((sftp) => new Promise((res, rej) => {
        sftp.realpath(display, (error, resolved) => (error ? rej(error) : res(resolved)));
      }));
      return { targetKey: real, displayPath: display };
    } catch (error) {
      // 目标不存在：仍要给出稳定 key（父目录真实路径 + 末段），供创建使用
      const parent = display.replace(/\/[^/]+$/, '') || '/';
      const name = display.slice(parent === '/' ? 1 : parent.length + 1);
      if (name === '') throw mapSftpError(error, 'resolve', display);
      try {
        const parentReal = await this.#sftp((sftp) => new Promise((res, rej) => {
          sftp.realpath(parent, (err, resolved) => (err ? rej(err) : res(resolved)));
        }));
        return { targetKey: `${parentReal.replace(/\/$/, '')}/${name}`, displayPath: display };
      } catch (parentError) {
        throw mapSftpError(parentError, 'resolve', display);
      }
    }
  }

  processPath(target) {
    return target.targetKey;
  }

  processPathFromHostPath() {
    return undefined;
  }

  fileUrl(target) {
    return `file://${encodeURI(target.targetKey)}`;
  }

  contains(parent, child) {
    return containsPath(parent.targetKey, child.targetKey);
  }

  /* ---------------- 读取 ---------------- */

  async stat(target, signal) {
    assertNotAborted(signal, 'stat');
    try {
      const attrs = await this.#sftp((sftp) => new Promise((res, rej) => {
        sftp.stat(target.targetKey, (error, info) => (error ? rej(error) : res(info)));
      }));
      const kind = kindOf(attrs);
      return {
        version: versionOf(attrs),
        type: kind === 'symlink' ? 'other' : kind,
        ...(typeof attrs.size === 'number' ? { size: attrs.size } : {})
      };
    } catch (error) {
      if (sftpCode(error) === 2) return undefined;
      throw mapSftpError(error, 'stat', target.displayPath);
    }
  }

  async lstat(path, opts = {}, signal) {
    assertNotAborted(signal, 'lstat');
    const display = normalizeRemotePath(path, opts.cwd ?? '/');
    try {
      const attrs = await this.#sftp((sftp) => new Promise((res, rej) => {
        sftp.lstat(display, (error, info) => (error ? rej(error) : res(info)));
      }));
      return {
        version: versionOf(attrs),
        type: kindOf(attrs),
        ...(typeof attrs.size === 'number' ? { size: attrs.size } : {})
      };
    } catch (error) {
      if (sftpCode(error) === 2) return undefined;
      throw mapSftpError(error, 'lstat', display);
    }
  }

  #readAll(target, signal, verb) {
    assertNotAborted(signal, verb);
    return this.#sftp((sftp) => new Promise((resolve, reject) => {
      sftp.readFile(target.targetKey, (error, buffer) => (error ? reject(error) : resolve(buffer)));
    })).catch((error) => {
      throw mapSftpError(error, verb, target.displayPath);
    });
  }

  async readText(target, signal) {
    return decodeText(await this.#readAll(target, signal, 'read'), target.displayPath);
  }

  async streamText(target, signal) {
    const text = await this.readText(target, signal);
    return (async function* stream() {
      const step = 64 * 1024;
      for (let offset = 0; offset < text.length; offset += step) {
        if (signal?.aborted === true) throw fsError('stream aborted', FS_ABORTED);
        yield text.slice(offset, offset + step);
      }
    })();
  }

  async readBytes(target, signal, maxBytes) {
    assertNotAborted(signal, 'read');
    const info = await this.stat(target, signal);
    if (info === undefined) throw fsError(`cannot read "${target.displayPath}": not found`, FS_NOT_FOUND);
    if (typeof info.size === 'number' && info.size > maxBytes) {
      throw fsError(`cannot read "${target.displayPath}": file is ${info.size} bytes, over the ${maxBytes} byte cap`, FS_TOO_LARGE);
    }
    return new Uint8Array(await this.#readAll(target, signal, 'read'));
  }

  async readByteRange(target, range, signal) {
    assertNotAborted(signal, 'read');
    const info = await this.stat(target, signal);
    if (info === undefined) throw fsError(`cannot read "${target.displayPath}": not found`, FS_NOT_FOUND);
    if (info.type !== 'file') throw fsError(`cannot read "${target.displayPath}": not a regular file`, FS_NOT_REGULAR_FILE);
    const length = Math.max(0, Math.floor(range.length));
    if (length === 0) return new Uint8Array();
    const buffer = await this.#sftp((sftp) => new Promise((resolve, reject) => {
      const chunks = [];
      const stream = sftp.createReadStream(target.targetKey, {
        start: Math.max(0, Math.floor(range.offset)),
        end: Math.max(0, Math.floor(range.offset)) + length - 1
      });
      stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    })).catch((error) => {
      throw mapSftpError(error, 'read', target.displayPath);
    });
    return new Uint8Array(buffer.subarray(0, length));
  }

  async listDir(target, signal) {
    assertNotAborted(signal, 'list');
    const entries = await this.#sftp((sftp) => new Promise((res, rej) => {
      sftp.readdir(target.targetKey, (error, list) => (error ? rej(error) : res(list)));
    })).catch((error) => {
      throw mapSftpError(error, 'list', target.displayPath);
    });
    const base = target.targetKey.replace(/\/$/, '');
    return entries
      .slice()
      .sort((left, right) => (left.filename < right.filename ? -1 : left.filename > right.filename ? 1 : 0))
      .map((entry) => {
        const kind = kindOf(entry.attrs);
        return {
          name: entry.filename,
          type: kind === 'directory' ? 'directory' : kind === 'file' ? 'file' : 'other',
          target: { targetKey: `${base}/${entry.filename}`, displayPath: `${target.displayPath.replace(/\/$/, '')}/${entry.filename}` },
          version: versionOf(entry.attrs),
          ...(typeof entry.attrs?.size === 'number' ? { size: entry.attrs.size } : {})
        };
      });
  }

  /* ---------------- 写入 ---------------- */

  async #writeAtomic(target, content, signal) {
    assertNotAborted(signal, 'write');
    const temporary = `${target.targetKey}.rh-tmp-${Date.now().toString(36)}`;
    await this.#sftp((sftp) => new Promise((resolve, reject) => {
      sftp.writeFile(temporary, Buffer.from(content, 'utf8'), (error) => (error ? reject(error) : resolve()));
    })).catch((error) => {
      throw mapSftpError(error, 'write', target.displayPath);
    });
    // OpenSSH 的标准 SFTP rename 不能覆盖已存在文件，必须走 posix-rename 扩展；
    // 服务器不支持时退回"先删后改名"（放弃原子性但不失败）。
    await this.#sftp((sftp) => new Promise((resolve, reject) => {
      const fallback = (cause) => {
        sftp.unlink(target.targetKey, () => {
          sftp.rename(temporary, target.targetKey, (error) => (error ? reject(error ?? cause) : resolve()));
        });
      };
      if (typeof sftp.ext_openssh_rename === 'function') {
        sftp.ext_openssh_rename(temporary, target.targetKey, (error) => {
          if (error) fallback(error);
          else resolve();
        });
        return;
      }
      sftp.rename(temporary, target.targetKey, (error) => {
        if (error) fallback(error);
        else resolve();
      });
    })).catch(async (error) => {
      await this.#sftp((sftp) => new Promise((resolve) => sftp.unlink(temporary, () => resolve()))).catch(() => {});
      throw mapSftpError(error, 'write', target.displayPath);
    });
  }

  async writeText(target, content, expected, signal) {
    const before = await this.stat(target, signal);
    if (expected?.kind === 'createIfAbsent' && before !== undefined) {
      throw fsError(`cannot write "${target.displayPath}": file already exists`, FS_ALREADY_EXISTS);
    }
    if (expected?.kind === 'replaceIfVersion') {
      if (before === undefined) throw fsError(`cannot write "${target.displayPath}": file changed since it was read`, FS_STALE_VERSION);
      if (before.version !== expected.version) throw fsError(`cannot write "${target.displayPath}": file changed since it was read`, FS_STALE_VERSION);
    }
    const previous = before !== undefined && before.type === 'file'
      ? decodeText(await this.#readAll(target, signal, 'read'), target.displayPath)
      : null;

    await this.#writeAtomic(target, content, signal);
    const after = await this.stat(target, signal);
    return {
      operation: before === undefined ? 'create' : 'update',
      version: after?.version ?? `missing:${target.targetKey}`,
      before: previous,
      after: content
    };
  }

  async editText(target, edit, expected, signal) {
    const before = await this.stat(target, signal);
    if (before === undefined) throw fsError(`cannot edit "${target.displayPath}": file changed since it was read`, FS_STALE_VERSION);
    if (before.type !== 'file') throw fsError(`cannot edit "${target.displayPath}": not a regular file`, FS_NOT_REGULAR_FILE);
    if (expected !== undefined && before.version !== expected.version) {
      throw fsError(`cannot edit "${target.displayPath}": file changed since it was read`, FS_STALE_VERSION);
    }

    const original = decodeText(await this.#readAll(target, signal, 'read'), target.displayPath);
    const needle = String(edit.oldString ?? '');
    const replacement = String(edit.newString ?? '');
    if (needle === '') throw fsError(`cannot edit "${target.displayPath}": old_string must not be empty`, FS_IO_ERROR);

    const positions = [];
    let cursor = original.indexOf(needle);
    while (cursor !== -1) {
      positions.push(cursor);
      if (edit.replaceAll !== true) break;
      cursor = original.indexOf(needle, cursor + needle.length);
    }
    if (positions.length === 0) throw fsError(`cannot edit "${target.displayPath}": old_string not found`, FS_IO_ERROR);
    if (edit.replaceAll !== true && positions.length > 1 && positions[0] !== positions[positions.length - 1]) {
      throw fsError(`cannot edit "${target.displayPath}": old_string appears ${positions.length} times`, FS_IO_ERROR);
    }

    const edited = edit.replaceAll === true
      ? original.split(needle).join(replacement)
      : `${original.slice(0, positions[0])}${replacement}${original.slice(positions[0] + needle.length)}`;

    await this.#writeAtomic(target, edited, signal);
    const after = await this.stat(target, signal);
    return {
      version: after?.version ?? `missing:${target.targetKey}`,
      before: original,
      after: edited
    };
  }

  /** 远程后端不做目录监听：与契约基类一致的显式拒绝。 */
  watch(_target, _changed, signal) {
    signal?.throwIfAborted?.();
    return Promise.reject(fsError('Filesystem watching is not supported by the remote backend.', FS_IO_ERROR));
  }
}

export default RemoteFileSystem;