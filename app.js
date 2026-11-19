import os from 'node:os';
import { readFile as fsReadFile } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import path from 'node:path';
import { ConnectionStore } from './lib/store.js';
import { BindingStore, normalizePath } from './lib/bindings.js';
import { AuditLog } from './lib/audit.js';
import { RemoteFileSystem } from './lib/fs-remote.js';
import { SshPool } from './lib/ssh.js';

const DEFAULT_MAX_READ_BYTES = 2 * 1024 * 1024;

/** 解析存储目录：优先当前 profile，否则回退到用户主目录。 */
function storeDirectory() {
  const profileDir = process.env.DSH_PROFILE_DIR;
  const base = profileDir !== undefined && profileDir !== '' ? profileDir : path.join(os.homedir(), '.dsh');
  return path.join(base, 'remote-host-store');
}

function fail(code, message) {
  return { ok: false, error: { code, message, details: {} } };
}

/**
 * remote-host 的 Host 半部分：加密连接库、SSH 会话池、
 * 供 Web 面板使用的已认证 `/remote-host-api` RPC 通道，
 * 以及一个把同样能力暴露给 agent 的工具。
 */
export function apply(ctx, config = {}) {
  const store = new ConnectionStore(storeDirectory());
  const pool = new SshPool({
    onHostKey: (id, fingerprint) => {
      void store.setHostKey(id, fingerprint).catch(() => {});
    }
  });
  const bindings = new BindingStore(storeDirectory());
  const audit = new AuditLog(storeDirectory());

  /**
   * 远程执行世界：开启后 ctx.fs 指向远程主机，bash/read/write/edit 与
   * workingDirectory 的路径校验全部落在远程，会话工作目录可以是真实远程路径。
   * 前提：profile 里必须禁用 @deepseek-ai/dsh-fs-local，否则同名服务注册冲突。
   */
  const remoteFsConfig = config?.remoteFs ?? {};
  const remoteFsEnabled = remoteFsConfig.enabled === true;
  const remoteFsProvider = remoteFsEnabled
    ? new RemoteFileSystem({
      pool,
      getProfile: async () => {
        const configured = remoteFsConfig.connection;
        if (configured !== undefined && configured !== '') return resolveProfile(configured);
        const fallback = await bindings.getDefault();
        if (fallback === null) throw new Error('远程文件系统未指定连接，且没有默认工作区');
        return resolveProfile(fallback.connectionId);
      }
    })
    : null;

  if (remoteFsProvider !== null && typeof ctx.provide === 'function') {
    ctx.effect(() => ctx.provide('fs', remoteFsProvider), 'remote-host: remote fs provider');
  }

  const tunnels = new Map();

  async function resolveProfile(idOrName) {
    const profile = await store.resolve(idOrName);
    if (profile === undefined) throw new Error(`找不到连接 ${JSON.stringify(idOrName)}`);
    const hasCredential = (record) => record.authType === 'key'
      ? Boolean(record.privateKey)
      : Boolean(record.password);
    if (profile.authType === 'key') {
      if (!profile.privateKey) throw new Error('该连接未保存私钥，请编辑连接填写私钥');
    } else if (!profile.password) {
      throw new Error('该连接未保存密码，请编辑连接填写密码');
    }
    if (profile.jumpId !== undefined && profile.jumpId !== '') {
      if (profile.jumpId === profile.id) throw new Error('跳板机不能指向自身');
      if (!hasCredential(profile)) throw new Error('目标连接缺少凭据');
      const jump = await store.get(profile.jumpId);
      if (jump === undefined) throw new Error('跳板机连接不存在，请先在连接列表里配置');
      if (jump.jumpId !== undefined && jump.jumpId !== '') throw new Error('暂只支持一级跳板机');
      if (!hasCredential(jump)) {
        throw new Error(`跳板机「${jump.name}」未保存${jump.authType === 'key' ? '私钥' : '密码'}`);
      }
      profile.jump = jump;
    }
    return profile;
  }

  /** 更新最近使用时间，失败也不影响主流程。 */
  const touch = (id) => store.touch(id).catch(() => {});

  /** 解析某次调用所用的连接，执行操作，再标记为最近使用。 */
  const withProfile = (payload, operation) => {
    return (async () => {
      const profile = await resolveProfile(payload?.id);
      const value = await operation(profile);
      await touch(profile.id);
      return value;
    })();
  };

  const api = {
    async 'connections.list'() {
      return { connections: await store.list() };
    },

    async 'connections.save'(payload) {
      if (payload.host === undefined || String(payload.host).trim() === '') throw new Error('主机地址不能为空');
      if (String(payload.username ?? '').trim() === '') throw new Error('用户名不能为空');
      const authType = payload.authType === 'key' ? 'key' : 'password';
      const existing = payload.id === undefined ? undefined : await store.get(payload.id);
      const incoming = authType === 'key' ? payload.privateKey : payload.password;
      const stored = authType === 'key' ? existing?.privateKey : existing?.password;
      if (!incoming && !stored) throw new Error(authType === 'key' ? '请填写私钥' : '请填写密码');
      const connection = await store.upsert(payload);
      return { connection };
    },

    async 'connections.delete'(payload) {
      const removed = await store.remove(payload.id);
      if (removed) pool.disconnect(payload.id);
      return { removed };
    },

    async 'connections.resetHostKey'(payload) {
      await store.clearHostKey(String(payload.id ?? ''));
      await pool.disconnect(String(payload.id ?? '')).catch(() => {});
      return { ok: true };
    },

    async 'connections.test'(payload) {
      const profile = payload.draft === true
        ? {
            id: 'draft',
            host: String(payload.host ?? ''),
            port: Number(payload.port ?? 22),
            username: String(payload.username ?? ''),
            authType: payload.authType === 'key' ? 'key' : 'password',
            password: payload.password,
            privateKey: payload.privateKey,
            passphrase: payload.passphrase
          }
        : await resolveProfile(payload.id);
      const started = Date.now();
      await pool.ensure(profile);
      return { ok: true, message: `连接成功（${Date.now() - started}ms）` };
    },

    async 'session.connect'(payload) {
      const profile = await resolveProfile(payload.id);
      await pool.ensure(profile);
      await touch(profile.id);
      return { ok: true, id: profile.id, name: profile.name };
    },

    async 'session.disconnect'(payload) {
      pool.disconnect(payload.id);
      return { ok: true };
    },

    async 'fs.list'(payload) {
      const profile = await resolveProfile(payload.id);
      const listing = await pool.list(profile, payload.path);
      await touch(profile.id);
      await store.setLastPath(profile.id, listing.path).catch(() => {});
      return listing;
    },

    async 'fs.read'(payload) {
      return withProfile(payload, (profile) =>
        pool.read(profile, payload.path, Math.min(Number(payload.maxBytes ?? DEFAULT_MAX_READ_BYTES), 8 * 1024 * 1024)));
    },

    async 'fs.write'(payload) {
      return withProfile(payload, (profile) => pool.write(profile, payload.path, String(payload.content ?? '')));
    },

    async 'fs.mkdir'(payload) {
      return withProfile(payload, (profile) =>
        pool.mkdir(profile, payload.path));
    },

    async 'fs.stat'(payload) {
      return withProfile(payload, (profile) =>
        pool.stat(profile, payload.path));
    },

    async 'fs.rename'(payload) {
      return withProfile(payload, (profile) =>
        pool.rename(profile, payload.from, payload.to));
    },

    async 'fs.delete'(payload) {
      return withProfile(payload, (profile) =>
        pool.remove(profile, payload.path, payload.recursive !== false));
    },

    async 'fs.chmod'(payload) {
      return withProfile(payload, (profile) =>
        pool.chmod(profile, payload.path, payload.mode));
    },

    async 'fs.upload'(payload) {
      return withProfile(payload, (profile) =>
        pool.upload(profile, payload.path, payload.base64));
    },

    async 'fs.download'(payload) {
      return withProfile(payload, (profile) =>
        pool.download(profile, payload.path, Math.min(Number(payload.maxBytes ?? 8 * 1024 * 1024), 32 * 1024 * 1024)));
    },

    async 'fs.du'(payload) {
      return withProfile(payload, (profile) =>
        pool.du(profile, payload.path));
    },

    async 'session.status'() {
      const ids = pool.active();
      const health = [];
      for (const id of ids) {
        const profile = await store.get(id);
        let healthy = false;
        if (profile !== undefined) {
          try {
            await pool.ensure(profile);
            healthy = true;
          } catch {
            healthy = false;
          }
        }
        health.push({ id, healthy });
      }
      return { active: ids, health };
    },

    async 'exec.run'(payload) {
      return withProfile(payload, (profile) =>
        pool.exec(profile, String(payload.command ?? ''), {
          cwd: payload.cwd,
          timeoutMs: payload.timeoutMs,
          maxOutput: payload.maxOutput
        }));
    },

    async 'fs.search'(payload) {
      return withProfile(payload, (profile) =>
        pool.search(profile, {
          pattern: payload.pattern,
          path: payload.path,
          maxLines: payload.maxLines,
          cwd: payload.cwd
        }));
    },

    async 'fs.uploadChunk'(payload) {
      const buffer = Buffer.from(String(payload.base64 ?? ''), 'base64');
      return withProfile(payload, (profile) =>
        pool.uploadChunk(profile, payload.path, buffer, Number(payload.offset ?? 0), payload.truncate === true));
    },

    async 'connections.importSshConfig'() {
      const home = os.homedir();
      const configPath = path.join(home, '.ssh', 'config');
      let text = '';
      try {
        text = await fsReadFile(configPath, 'utf8');
      } catch {
        throw new Error('没有找到 ~/.ssh/config');
      }
      const hosts = [];
      let current = null;
      for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (line === '' || line.startsWith('#')) continue;
        const match = /^(\S+)\s+(.*)$/.exec(line);
        if (match === null) continue;
        const keyword = match[1].toLowerCase();
        const value = match[2].trim();
        if (keyword === 'host') {
          const names = value.split(/\s+/).filter((name) => name !== '' && !name.includes('*') && !name.includes('?'));
          current = names.length === 0 ? null : { alias: names[0], host: names[0], port: 22, username: '', identityFile: '' };
          if (current !== null) hosts.push(current);
          continue;
        }
        if (current === null) continue;
        if (keyword === 'hostname') current.host = value;
        else if (keyword === 'user') current.username = value;
        else if (keyword === 'port') current.port = Number(value) || 22;
        else if (keyword === 'identityfile') current.identityFile = value.replace(/^~/, os.homedir());
        else if (keyword === 'proxyjump') current.proxyJump = value;
      }
      return { path: configPath, hosts };
    },

    async 'audit.export'(payload) {
      const entries = await audit.tail(Math.min(Number(payload.limit ?? 5000), 5000));
      const lines = entries.reverse().map((entry) => JSON.stringify(entry)).join('\n');
      return {
        filename: `remote-host-audit-${new Date().toISOString().slice(0, 10)}.jsonl`,
        content: lines === '' ? '' : lines + '\n',
        count: entries.length
      };
    },

    async 'vault.status'() {
      return store.vaultStatus();
    },

    async 'vault.enable'(payload) {
      const result = await store.enableVault(String(payload.passphrase ?? ''));
      recordAudit({ source: 'panel', action: 'vault.enable', ok: true, detail: '凭据库已加锁' });
      return result;
    },

    async 'vault.unlock'(payload) {
      return store.unlockVault(String(payload.passphrase ?? ''));
    },

    async 'vault.lock'() {
      return store.lockVault();
    },

    async 'vault.disable'(payload) {
      const result = await store.disableVault(String(payload.passphrase ?? ''));
      recordAudit({ source: 'panel', action: 'vault.disable', ok: true, detail: '凭据库已解锁为常驻' });
      return result;
    },

    async 'audit.list'(payload) {
      return { entries: await audit.tail(Math.min(Number(payload.limit ?? 100), 500)) };
    },

    async 'audit.clear'() {
      return { ok: await audit.clear() };
    },

    async 'git.info'(payload) {
      const profile = await resolveProfile(payload.id);
      const dir = payload.path === undefined || payload.path === '' ? '.' : String(payload.path);
      const result = await pool.exec(
        profile,
        "git rev-parse --abbrev-ref HEAD 2>/dev/null; echo '---'; git status --porcelain 2>/dev/null | head -n 80; echo '---'; git log -1 --format='%h %s' 2>/dev/null",
        { cwd: dir, timeoutMs: 15000 }
      );
      const lines = result.stdout.split('\n');
      const first = lines.indexOf('---');
      const last = lines.lastIndexOf('---');
      const branch = (first === -1 ? [] : lines.slice(0, first)).join(' ').trim();
      const status = first === -1 || last === -1 ? [] : lines.slice(first + 1, last).filter((line) => line.trim() !== '');
      const commit = last === -1 ? '' : lines.slice(last + 1).join(' ').trim();
      return {
        path: dir,
        branch: branch === '' ? '' : branch,
        isRepo: branch !== '',
        changes: status.length,
        files: status.slice(0, 80),
        lastCommit: commit
      };
    },

    async 'sys.info'(payload) {
      const profile = await resolveProfile(payload.id);
      const result = await pool.exec(
        profile,
        'uname -sr; whoami; (df -h / 2>/dev/null | tail -n 1); uptime 2>/dev/null | head -n 1; nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null',
        { timeoutMs: 15000 }
      );
      const lines = result.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
      return {
        kernel: lines[0] ?? '',
        user: lines[1] ?? '',
        disk: lines[2] ?? '',
        uptime: lines[3] ?? '',
        cpu: lines[4] ?? ''
      };
    },

    async 'tunnel.open'(payload) {
      const profile = await resolveProfile(payload.id);
      const tunnel = await pool.openTunnel(profile, {
        localPort: payload.localPort ?? 0,
        remoteHost: payload.remoteHost ?? '127.0.0.1',
        remotePort: payload.remotePort
      });
      const key = `${profile.id}:${tunnel.localPort}`;
      tunnels.set(key, { key, connectionId: profile.id, connectionName: profile.name, ...tunnel });
      recordAudit({ source: 'panel', action: 'tunnel.open', connection: profile.name, detail: `127.0.0.1:${tunnel.localPort} → ${tunnel.remoteHost}:${tunnel.remotePort}` });
      return { tunnels: [...tunnels.values()].map(({ server, ...rest }) => rest) };
    },

    async 'tunnel.close'(payload) {
      const key = String(payload.key ?? '');
      const tunnel = tunnels.get(key);
      if (tunnel === undefined) return { tunnels: [...tunnels.values()].map(({ server, ...rest }) => rest) };
      await new Promise((resolve) => tunnel.server.close(resolve));
      tunnels.delete(key);
      return { tunnels: [...tunnels.values()].map(({ server, ...rest }) => rest) };
    },

    async 'tunnel.list'() {
      return { tunnels: [...tunnels.values()].map(({ server, ...rest }) => rest) };
    },

    async 'connections.export'(payload) {
      const passphrase = String(payload.passphrase ?? '');
      if (passphrase.length < 6) throw new Error('导出密码至少 6 位');
      const records = [];
      for (const item of await store.list()) {
        const full = await store.get(item.id);
        if (full === undefined) continue;
        records.push({
          name: full.name, host: full.host, port: full.port, username: full.username,
          authType: full.authType, group: full.group ?? '',
          password: full.password, privateKey: full.privateKey, passphrase: full.passphrase
        });
      }
      if (records.length === 0) throw new Error('没有可导出的连接');
      const salt = randomBytes(16);
      const key = pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([
        cipher.update(JSON.stringify({ version: 1, exportedAt: Date.now(), connections: records }), 'utf8'),
        cipher.final()
      ]);
      return {
        filename: `remote-host-export-${new Date().toISOString().slice(0, 10)}.json`,
        content: JSON.stringify({
          version: 1, kdf: 'pbkdf2-sha256-100000',
          salt: salt.toString('base64'), iv: iv.toString('base64'),
          tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64')
        }, null, 2)
      };
    },

    async 'connections.import'(payload) {
      const passphrase = String(payload.passphrase ?? '');
      let bundle;
      try {
        bundle = JSON.parse(String(payload.content ?? ''));
      } catch {
        throw new Error('导入文件不是有效的 JSON');
      }
      if (bundle?.version !== 1 || typeof bundle.data !== 'string') throw new Error('导入文件格式不支持');
      let plain;
      try {
        const key = pbkdf2Sync(passphrase, Buffer.from(bundle.salt, 'base64'), 100000, 32, 'sha256');
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(bundle.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(bundle.tag, 'base64'));
        plain = Buffer.concat([decipher.update(Buffer.from(bundle.data, 'base64')), decipher.final()]).toString('utf8');
      } catch {
        throw new Error('口令错误或文件已损坏');
      }
      const parsed = JSON.parse(plain);
      let imported = 0;
      for (const item of parsed?.connections ?? []) {
        await store.upsert(item);
        imported += 1;
      }
      return { imported };
    },

    async 'workspace.get'() {
      const [defaultBinding, sessions] = await Promise.all([bindings.getDefault(), bindings.listSessions()]);
      return { default: defaultBinding, sessions };
    },

    async 'workspace.setDefault'(payload) {
      const profile = await resolveProfile(payload.connection ?? payload.connectionId);
      const binding = await bindings.setDefault({
        connectionId: profile.id,
        connectionName: profile.name,
        path: payload.path ?? '/'
      });
      return { default: binding };
    },

    async 'workspace.clearDefault'() {
      await bindings.clearDefault();
      return { ok: true };
    },

    async 'binding.set'(payload) {
      const profile = await resolveProfile(payload.connection ?? payload.connectionId);
      const binding = await bindings.setSession(String(payload.sessionId), {
        connectionId: profile.id,
        connectionName: profile.name,
        path: payload.path ?? '/'
      });
      return { binding };
    },

    async 'binding.get'(payload) {
      return { binding: await bindings.getSession(String(payload.sessionId)) };
    },

    async 'binding.clear'(payload) {
      const removed = await bindings.clearSession(String(payload.sessionId));
      return { removed };
    }
  };

  /** 解析操作目标：优先显式参数，否则用会话绑定 / 默认工作区。 */
  async function effectiveTarget(args, exec) {
    if (args.connection !== undefined && String(args.connection).trim() !== '') {
      const profile = await resolveProfile(String(args.connection));
      return { profile, path: args.path };
    }
    const sessionId = exec?.agent === undefined ? '' : String(exec.agent.id);
    const binding = sessionId === '' ? await bindings.getDefault() : await bindings.resolveForSession(sessionId);
    if (binding === null || binding === undefined) {
      throw new Error('未指定 connection，且当前对话没有绑定的远程工作区（可用 action=bind 绑定，或在面板设置默认工作区）');
    }
    const profile = await resolveProfile(binding.connectionId);
    return { profile, path: args.path ?? binding.path, binding };
  }

  /** 记录一次变更操作；不阻塞、不影响调用方。 */
  let auditWrites = 0;
  const recordAudit = (entry) => {
    void audit.record(entry).then(() => {
      auditWrites += 1;
      if (auditWrites % 100 === 0) void audit.rotate();
    });
  };

  const AUDITED = new Set(['fs.write', 'fs.upload', 'fs.delete', 'fs.rename', 'fs.chmod', 'exec.run']);

  /** 返回一个 server-response 信封。 */
  const respond = (res, rpcId, result) => {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ type: 'server-response', rpcId, result }));
  };

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/remote-host-api',
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection({ headers: req.headers });
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
      const endpoint = pathname.startsWith('/remote-host-api/') ? pathname.slice('/remote-host-api/'.length) : undefined;
      const validEndpoint = endpoint !== undefined && endpoint !== '' && !endpoint.split('/').some((part) => part === '' || part === '.' || part === '..' || !/^[A-Za-z0-9_$.-]+$/.test(part));
      if (!validEndpoint) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        res.writeHead(415, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('content type must be application/json');
        return;
      }
      let body;
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('body is not JSON');
        return;
      }
      const rpcId = typeof body?.rpcId === 'string' ? body.rpcId : 'invalid-request';
      if (body?.type !== 'client-request' || typeof body.method !== 'string') {
        respond(res, rpcId, { ok: false, error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: {} } });
        return;
      }
      if (body.method !== endpoint) {
        respond(res, rpcId, { ok: false, error: { code: 'gateway/bad-request', message: `method ${JSON.stringify(body.method)} does not match endpoint ${JSON.stringify(endpoint)}`, details: {} } });
        return;
      }
      const operation = api[endpoint];
      if (operation === undefined) {
        respond(res, rpcId, fail('unknown-endpoint', `未知操作 ${endpoint}`));
        return;
      }
      try {
        const value = await operation(body.payload ?? {});
        if (AUDITED.has(endpoint)) {
          recordAudit({
            source: 'panel',
            action: endpoint,
            ok: true,
            detail: JSON.stringify(body.payload ?? {}).slice(0, 300)
          });
        }
        respond(res, rpcId, { ok: true, value });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (AUDITED.has(endpoint)) {
          recordAudit({
            source: 'panel',
            action: endpoint,
            ok: false,
            detail: `${JSON.stringify(body.payload ?? {}).slice(0, 240)} → ${message}`
          });
        }
        respond(res, rpcId, fail('remote-host-error', message, { endpoint }));
      }
    }
  }), 'remote-host: /remote-host-api route');

  /** 工具主体以闭包实现：错误包装不得依赖 `this`。 */
  const runTool = async (args, exec) => {
      const action = String(args.action ?? '');
      if (action === 'list_connections') return api['connections.list']();
      const sessionId = exec?.agent === undefined ? '' : String(exec.agent.id);

      if (action === 'workspace') {
        const binding = sessionId === '' ? await bindings.getDefault() : await bindings.resolveForSession(sessionId);
        // 模型在本会话看到的远程工作区提示（null 表示没有注入）
        const prompt = sessionId === '' ? null : await workspacePromptText(sessionId);
        return {
          sessionId: sessionId === '' ? null : sessionId,
          binding,
          prompt: prompt === null ? null : prompt.text
        };
      }
      if (action === 'bind') {
        if (sessionId === '') throw new Error('绑定远程工作区需要在对话中调用（缺少会话标识）');
        const target = await effectiveTarget({ connection: args.connection, path: args.path }, exec);
        const binding = await bindings.setSession(sessionId, {
          connectionId: target.profile.id,
          connectionName: target.profile.name,
          path: target.path ?? '/'
        });
        return { ok: true, sessionId, binding };
      }
      if (action === 'unbind') {
        if (sessionId === '') throw new Error('解除绑定需要会话标识');
        return { ok: true, removed: await bindings.clearSession(sessionId) };
      }

      const target = await effectiveTarget(args, exec);
      const profile = target.profile;
      const targetPath = target.path;
      switch (action) {
        case 'connect': {
          await pool.ensure(profile);
          await touch(profile.id);
          return {
            ok: true,
            connection: profile.name,
            host: `${profile.username}@${profile.host}:${profile.port}`,
            workspace: target.binding === undefined ? null : { path: target.binding.path }
          };
        }
        case 'list':
          return pool.list(profile, targetPath);
        case 'read': {
          if (args.offset !== undefined) {
            return pool.readLines(profile, targetPath, args.offset, args.limit ?? 200);
          }
          const result = await pool.read(profile, targetPath, Math.min(Number(args.maxBytes ?? DEFAULT_MAX_READ_BYTES), 8 * 1024 * 1024));
          if (result.binary === true) {
            return {
              ...result,
              base64: String(result.base64 ?? '').slice(0, 4096),
              truncated: true,
              note: '二进制内容：仅返回前 4KB 的 Base64；需要完整文件请用 exec + base64 命令'
            };
          }
          const limit = 40000;
          if (typeof result.content === 'string' && result.content.length > limit) {
            return {
              ...result,
              content: result.content.slice(0, limit),
              truncated: true,
              note: `内容过长已截断到 ${limit} 字符（原 ${result.content.length} 字符）；可传 maxBytes 或分段读取`
            };
          }
          return result;
        }
        case 'exec': {
          if (typeof args.command !== 'string' || args.command.trim() === '') throw new Error('exec 需要 command 参数');
          const execResult = await pool.exec(profile, args.command, { cwd: args.cwd, timeoutMs: args.timeoutMs });
          recordAudit({ source: 'agent', sessionId: sessionId || null, action: 'exec', connection: profile.name, detail: String(args.command).slice(0, 300) });
          return execResult;
        }
        case 'search':
          return pool.search(profile, { pattern: args.pattern, path: targetPath, maxLines: args.maxLines, cwd: args.cwd });
        case 'chmod': {
          const chmodResult = await pool.chmod(profile, targetPath, args.mode);
          recordAudit({ source: 'agent', sessionId: sessionId || null, action: 'chmod', connection: profile.name, detail: `${targetPath} → ${args.mode}` });
          return chmodResult;
        }
        case 'du':
          return pool.du(profile, targetPath);
        case 'git':
          return api['git.info']({ id: profile.id, path: targetPath });
        case 'tunnel': {
          if (args.close === true) {
            const key = String(args.key ?? '');
            const tunnel = tunnels.get(key);
            if (tunnel !== undefined) {
              await new Promise((resolve) => tunnel.server.close(resolve));
              tunnels.delete(key);
            }
            return { closed: key, tunnels: [...tunnels.values()].map(({ server, ...rest }) => rest) };
          }
          const opened = await pool.openTunnel(profile, {
            localPort: args.localPort ?? 0,
            remoteHost: args.remoteHost ?? '127.0.0.1',
            remotePort: args.remotePort
          });
          const tunnelKey = `${profile.id}:${opened.localPort}`;
          tunnels.set(tunnelKey, { key: tunnelKey, connectionId: profile.id, connectionName: profile.name, ...opened });
          recordAudit({ source: 'agent', sessionId: sessionId || null, action: 'tunnel.open', connection: profile.name, detail: `127.0.0.1:${opened.localPort} → ${opened.remoteHost}:${opened.remotePort}` });
          return { key: tunnelKey, localPort: opened.localPort, remoteHost: opened.remoteHost, remotePort: opened.remotePort };
        }
        case 'write': {
          if (typeof args.content !== 'string') throw new Error('write 操作需要 content 参数（完整文件内容）');
          const writeResult = await pool.write(profile, targetPath, args.content, { backup: true });
          recordAudit({ source: 'agent', sessionId: sessionId || null, action: 'write', connection: profile.name, detail: `${targetPath} (${writeResult.size} bytes${writeResult.backup ? ', backup' : ''})` });
          return writeResult;
        }
        case 'mkdir':
          return pool.mkdir(profile, targetPath);
        case 'remove': {
          const removeResult = await pool.remove(profile, targetPath, args.recursive === true);
          recordAudit({ source: 'agent', sessionId: sessionId || null, action: 'remove', connection: profile.name, detail: `${targetPath}${args.recursive === true ? ' (recursive)' : ''}` });
          return removeResult;
        }
        case 'rename': {
          const renameResult = await pool.rename(profile, targetPath, args.to);
          recordAudit({ source: 'agent', sessionId: sessionId || null, action: 'rename', connection: profile.name, detail: `${targetPath} → ${args.to}` });
          return renameResult;
        }
        case 'stat':
          return pool.stat(profile, targetPath);
        default:
          throw new Error(`未知 action ${action}`);
      }
    };

  const tool = {
    name: 'remote_fs',
    description: [
      '通过已保存的 SSH 连接操作远程主机文件系统。',
      'action=list_connections 列出已保存连接；connect 建立会话；list 浏览目录；read 读取文件内容；',
      'write 写入/覆盖文件；mkdir 新建目录；remove 删除文件或目录；rename 重命名；stat 查看属性。',
      'connection 参数填已保存连接的名称或 id（可先用 list_connections 查询）。',
      '省略 connection 时使用当前对话绑定的远程工作区；action=bind 把指定主机目录绑定到当前对话，',
      'action=workspace 查看当前绑定，action=unbind 解除绑定。',
      'exec 在远程执行 shell 命令（可传 cwd）；search 用 grep -rn 在远程搜索文本。',
      'write 默认先把原文件备份为 <path>.bak；remove 删除非空目录需显式 recursive:true。',
      'chmod 改权限（mode 如 755）；du 查目录占用。',
      'read 支持 offset/limit 按行分段读取大文件（如 offset=1 limit=200）。',
      'git 查看远程目录的 Git 分支/变更/最近提交。',
      'tunnel 在本地开一个 TCP 转发（如把远程 3306 映射到本地），close:true + key 关闭。'
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list_connections', 'connect', 'list', 'read', 'write', 'mkdir', 'remove', 'rename', 'stat', 'exec', 'search', 'chmod', 'du', 'git', 'tunnel', 'bind', 'unbind', 'workspace'],
          description: '要执行的操作。'
        },
        connection: { type: 'string', description: '已保存连接的名称或 id；省略时使用当前对话绑定的远程工作区。' },
        path: { type: 'string', description: '远程绝对路径（list/read/write/mkdir/remove/stat 必填；list 可省略表示登录目录）。' },
        content: { type: 'string', description: 'write 操作的完整文件内容（UTF-8 文本）。' },
        to: { type: 'string', description: 'rename 操作的目标路径。' },
        recursive: { type: 'boolean', description: 'remove 操作是否递归删除目录，默认 true。' },
        maxBytes: { type: 'integer', description: 'read 操作的最大读取字节数，默认 2 MiB，上限 8 MiB。' },
        command: { type: 'string', description: 'exec 操作要执行的远程 shell 命令。' },
        cwd: { type: 'string', description: 'exec/search 的工作目录（可选，默认登录目录）。' },
        pattern: { type: 'string', description: 'search 操作的 grep -E 正则。' },
        maxLines: { type: 'integer', description: 'search 返回的最大匹配行数，默认 200。' },
        timeoutMs: { type: 'integer', description: 'exec 超时毫秒数，默认 30000。' },
        mode: { type: 'string', description: 'chmod 的八进制权限，例如 755、644。' },
        offset: { type: 'integer', description: 'read 的起始行号（从 1 开始）；配合 limit 分段读取大文件。' },
        limit: { type: 'integer', description: 'read 一次返回的最大行数，默认 200（仅在有 offset 时生效）。' },
        localPort: { type: 'integer', description: 'tunnel 的本地监听端口（0 表示自动分配）。' },
        remotePort: { type: 'integer', description: 'tunnel 转发的远程端口。' },
        remoteHost: { type: 'string', description: 'tunnel 转发的远程主机，默认 127.0.0.1。' },
        close: { type: 'boolean', description: 'tunnel 传 true 表示关闭（配合 key）。' },
        key: { type: 'string', description: '关闭 tunnel 时使用的隧道标识。' }
      },
      required: ['action']
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        return [{ type: 'text', text }];
      },
      // 原生与嵌套调用的展示投影（DSH 0.2.x 的 ToolOutputDefinition.presentationMeta）。
      // 只返回无损 JSON，不参与业务逻辑。
      presentationMeta(args, value) {
        const meta = { action: String(args?.action ?? '') };
        if (args?.connection !== undefined) meta.connection = String(args.connection);
        if (args?.path !== undefined) meta.path = String(args.path);
        if (args?.to !== undefined) meta.to = String(args.to);
        if (args?.pattern !== undefined) meta.pattern = String(args.pattern);
        if (args?.command !== undefined) meta.command = String(args.command).slice(0, 120);
        if (value !== null && typeof value === 'object') {
          if (Array.isArray(value.entries)) meta.entries = value.entries.length;
          if (Array.isArray(value.matches)) meta.matches = value.matches.length;
          if (value.path !== undefined) meta.resolvedPath = String(value.path);
          if (value.exitCode !== undefined) meta.exitCode = Number(value.exitCode);
          if (value.truncated === true) meta.truncated = true;
        }
        return meta;
      }
    },
    isConcurrencySafe: () => false,
    presentCall(args) {
      const titles = {
        list_connections: '列出已保存的远程主机连接',
        connect: `连接远程主机 ${args.connection ?? ''}`.trim(),
        list: `浏览远程目录 ${args.path ?? '.'}`,
        read: `读取远程文件 ${args.path ?? ''}`.trim(),
        write: `写入远程文件 ${args.path ?? ''}`.trim(),
        mkdir: `新建远程目录 ${args.path ?? ''}`.trim(),
        remove: `删除远程文件 ${args.path ?? ''}`.trim(),
        rename: `重命名远程文件 ${args.path ?? ''}`.trim(),
        stat: `查看远程文件属性 ${args.path ?? ''}`.trim(),
        exec: `执行远程命令 ${String(args.command ?? '').slice(0, 60)}`,
        search: `搜索远程内容 ${String(args.pattern ?? '')}`,
        chmod: `修改权限 ${String(args.path ?? '')} → ${String(args.mode ?? '')}`,
        tunnel: `端口转发 ${String(args.localPort ?? '')} → ${String(args.remoteHost ?? '')}:${String(args.remotePort ?? '')}`,
        du: `统计目录占用 ${String(args.path ?? '')}`,
        git: `查看 Git 状态 ${String(args.path ?? '')}`,
        bind: `绑定远程工作区 ${String(args.connection ?? '')} ${String(args.path ?? '')}`.trim(),
        unbind: '解除当前对话的远程工作区绑定',
        workspace: '查看当前对话的远程工作区'
      };
      return {
        card: 'generic',
        title: titles[args.action] ?? `remote_fs ${String(args.action ?? '')}`,
        kind: args.action === 'write' || args.action === 'remove' || args.action === 'rename' ? 'edit'
          : args.action === 'exec' ? 'execute'
            : args.action === 'search' ? 'search'
              : args.action === 'read' || args.action === 'list' ? 'read' : 'other',
        rawInput: args.action === 'write' ? { ...args, content: `<${String(args.content ?? '').length} chars>` } : args
      };
    },
    async execute(args, exec) {
      try {
        return await runTool(args, exec);
      } catch (error) {
        const action = String(args.action ?? '');
        const where = args.path === undefined || args.path === '' ? '' : ` (${args.path})`;
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`remote_fs ${action} 失败${where}：${reason}`);
      }
    },

  };

  ctx.effect(() => ctx.tools.register(tool), 'remote-host: remote_ssh tool');
  ctx.effect(() => () => {
    for (const tunnel of tunnels.values()) {
      try {
        tunnel.server.close();
      } catch {
        /* already closed */
      }
    }
    tunnels.clear();
    pool.disposeAll();
  }, 'remote-host: ssh session pool + tunnels');

  /** 某个会话会看到的「远程工作区」提示文本（无工作区时返回 null）。 */
  const workspacePromptText = async (agentId) => {
    const sessionBinding = await bindings.getSession(String(agentId)).catch(() => null);
    const binding = sessionBinding ?? await bindings.getDefault().catch(() => null);
    if (binding === null) return null;
    const scopeLabel = sessionBinding !== null ? '本对话已绑定远程工作区' : '本机默认远程工作区';
    return {
      binding,
      sessionScoped: sessionBinding !== null,
      text: [
        `${scopeLabel}：${binding.connectionName}:${binding.path}`,
        '该目录位于远程主机，不在本机：',
        '- 浏览、读取、写入、搜索该目录请用 remote_fs 工具；省略 connection/path 即使用此工作区。',
        '- 远程执行命令用 remote_fs action=exec；本地 bash 与 read/write/glob/grep 只作用于本机。'
      ].join('\n')
    };
  };

  // 把「本对话绑定的远程工作区」注入每轮系统提示。
  // 没有这一步，模型只会看到本机 cwd，不会去用 remote_fs——表现为「绑定了但对话用不上」。
  const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined;
  if (systemPrompt !== undefined && typeof systemPrompt.context === 'function') {
    let contextOrder = 100;
    try {
      contextOrder = systemPrompt.getContextOrder('WORKING_DIRECTORY') + 1;
    } catch {
      /* 排序名变化时退回默认值 */
    }

    ctx.effect(() => systemPrompt.context({
      name: 'remote-host:workspace',
      order: contextOrder,
      required: false,
      interpolate: false,
      // 真实文本由 assemble 事件按会话写入；这里的占位永不参与渲染
      text: () => ''
    }), 'remote-host: prompt context slot');

    ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      const result = await next();
      const agentId = context?.agent?.id;
      if (agentId === undefined) return result;

      const resolved = await workspacePromptText(agentId);
      if (resolved === null) return result;
      const { text } = resolved;

      const contexts = result.contexts ?? (result.contexts = []);
      const entry = contexts.find((item) => item.name === 'remote-host:workspace');
      if (entry === undefined) {
        contexts.unshift({ name: 'remote-host:workspace', text, interpolate: false });
      } else {
        entry.text = text;
        entry.interpolate = false;
      }
      return result;
    }, { prepend: true });
  }

  // 重新打开对话（启动/恢复）时，先重连它绑定的远程工作区，
  // 赶在第一次工具调用之前。此处失败保持静默：
  // 只有在真正使用该连接时才会暴露真实错误。
  ctx.on('agent/created', async (payload) => {
    try {
      const agent = payload?.agent;
      if (agent === undefined) return;
      const binding = await bindings.resolveForSession(String(agent.id));
      if (binding === null) return;
      const profile = await store.get(binding.connectionId);
      if (profile === undefined) return;
      void pool.ensure(profile).catch(() => {});

      // 远程执行世界已开启：把本会话的工作目录切到真实远程路径
      if (remoteFsProvider !== null) {
        const workingDirectory = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined;
        if (workingDirectory !== undefined && typeof workingDirectory.set === 'function') {
          await workingDirectory.set(agent, binding.path);
        }
      }
    } catch {
      /* auto-connect must never break session creation */
    }
  });
}
