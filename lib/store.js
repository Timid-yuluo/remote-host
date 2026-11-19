import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

const ENC_PREFIX = 'enc1.';
const KEY_BYTES = 32;

/**
 * Encrypted connection store. One JSON document per profile directory; every
 * 密字段（password / privateKey / passphrase）以 AES-256-GCM 加密，
 * 密钥为每套安装随机生成、存放于 0600 权限的密钥文件。
 */
export class ConnectionStore {
  #dir;
  #file;
  #keyFile;
  #key = null;
  #chain = Promise.resolve();
  /** Optional passphrase layer for every secret field. */
  #vaultMeta = null;
  #vaultKey = null;

  constructor(dir) {
    this.#dir = dir;
    this.#file = path.join(dir, 'connections.json');
    this.#keyFile = path.join(dir, '.secret.key');
  }

  /** 所有操作串行经过同一条 Promise 链（单进程互斥）。 */
  #enqueue(operation) {
    const run = this.#chain.then(operation, operation);
    this.#chain = run.catch(() => {});
    return run;
  }

  async #loadKey() {
    if (this.#key) return this.#key;
    await mkdir(this.#dir, { recursive: true });
    let raw;
    try {
      raw = await readFile(this.#keyFile);
      if (raw.byteLength !== KEY_BYTES) throw new Error('密钥文件长度异常');
    } catch {
      raw = randomBytes(KEY_BYTES);
      await writeFile(this.#keyFile, raw, { mode: 0o600 });
      await chmod(this.#keyFile, 0o600);
    }
    this.#key = raw;
    return raw;
  }

  /** 密字段实际使用的钥匙：启用主口令后即为凭据库钥匙。 */
  #secretKey() {
    return this.#vaultKey ?? this.#key;
  }

  #encryptWith(key, text) {
    if (text === undefined || text === null || text === '') return undefined;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
    return `${ENC_PREFIX}${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
  }

  #decryptWith(key, value) {
    if (value === undefined || value === null || value === '') return undefined;
    if (!value.startsWith(ENC_PREFIX)) return value;
    const [ivPart, tagPart, dataPart] = value.slice(ENC_PREFIX.length).split('.');
    if (!ivPart || !tagPart || !dataPart) throw new Error('加密字段格式损坏');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataPart, 'base64url')), decipher.final()]).toString('utf8');
  }

  encrypt(text) {
    if (text === undefined || text === null || text === '') return undefined;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#secretKey(), iv);
    const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
    return `${ENC_PREFIX}${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
  }

  decrypt(value) {
    if (value === undefined || value === null || value === '') return undefined;
    if (!value.startsWith(ENC_PREFIX)) return value;
    const [ivPart, tagPart, dataPart] = value.slice(ENC_PREFIX.length).split('.');
    if (!ivPart || !tagPart || !dataPart) throw new Error('加密字段格式损坏');
    const decipher = createDecipheriv('aes-256-gcm', this.#secretKey(), Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataPart, 'base64url')), decipher.final()]).toString('utf8');
  }

  async #read() {
    try {
      const raw = await readFile(this.#file, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.connections) ? parsed : { version: 1, connections: [] };
    } catch {
      return { version: 1, connections: [] };
    }
  }

  async #write(document) {
    const payload = JSON.stringify(document, null, 2);
    const temporary = `${this.#file}.tmp`;
    await writeFile(temporary, payload, { mode: 0o600 });
    await rename(temporary, this.#file);
    await chmod(this.#file, 0o600).catch(() => {});
  }

  /** Remove secret fields from a record for transport to the client. */
  static publicView(record) {
    return {
      id: record.id,
      name: record.name,
      host: record.host,
      port: record.port,
      username: record.username,
      authType: record.authType,
      group: record.group ?? '',
      hasSecret: Boolean(record.password ?? record.privateKey),
      hasPassphrase: Boolean(record.passphrase),
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt,
      lastPath: record.lastPath ?? '/',
      hostKey: record.hostKey ?? ''
    };
  }

  /** Every stored connection without secret fields. */
  async list() {
    return this.#enqueue(async () => {
      await this.#loadKey();
      const document = await this.#read();
      return document.connections.map(ConnectionStore.publicView);
    });
  }

  /** Decrypt one stored record into a full profile (secrets included). */
  #full(record) {
    return {
      ...record,
      password: this.decrypt(record.password),
      privateKey: this.decrypt(record.privateKey),
      passphrase: this.decrypt(record.passphrase)
    };
  }

  /** Full record (decrypted secrets included) for one id. */
  async get(id) {
    await this.#requireUnlocked();
    return this.#enqueue(async () => {
      await this.#loadKey();
      const document = await this.#read();
      const record = document.connections.find((entry) => entry.id === id);
      return record === undefined ? undefined : this.#full(record);
    });
  }

  /** Insert or update one connection; returns the public view. */
  async upsert(input) {
    return this.#enqueue(async () => {
      await this.#loadKey();
      const document = await this.#read();
      const now = Date.now();
      const existing = input.id === undefined ? undefined : document.connections.find((entry) => entry.id === input.id);
      const record = {
        id: existing?.id ?? `conn_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`,
        name: String(input.name ?? '').trim() || `${input.username ?? 'user'}@${input.host ?? 'host'}`,
        host: String(input.host ?? ''),
        port: Number.isSafeInteger(input.port) && input.port > 0 ? input.port : 22,
        username: String(input.username ?? ''),
        authType: input.authType === 'key' ? 'key' : 'password',
        group: String(input.group ?? '').trim(),
        password: input.password === undefined || input.password === '' ? existing?.password : this.encrypt(input.password),
        privateKey: input.privateKey === undefined || input.privateKey === '' ? existing?.privateKey : this.encrypt(input.privateKey),
        passphrase: input.passphrase === undefined || input.passphrase === '' ? existing?.passphrase : this.encrypt(input.passphrase),
        jumpId: String(input.jumpId ?? existing?.jumpId ?? '').trim(),
        hostKey: existing?.hostKey ?? '',
        lastPath: existing?.lastPath ?? '/',
        createdAt: existing?.createdAt ?? now,
        lastUsedAt: now
      };
      const next = existing === undefined
        ? [record, ...document.connections]
        : document.connections.map((entry) => (entry.id === record.id ? record : entry));
      await this.#write({ version: 1, connections: next });
      return ConnectionStore.publicView(record);
    });
  }

  /** Remove one connection by id. */
  async remove(id) {
    return this.#enqueue(async () => {
      await this.#loadKey();
      const document = await this.#read();
      const next = document.connections.filter((entry) => entry.id !== id);
      await this.#write({ version: 1, connections: next });
      return next.length !== document.connections.length;
    });
  }


  /* ------------------------------------------------------------------ */
  /* Optional passphrase vault                                           */
  /* ------------------------------------------------------------------ */

  #vaultFile() {
    return path.join(this.#dir, 'vault.json');
  }

  #derive(passphrase, salt) {
    return pbkdf2Sync(String(passphrase), salt, 120000, KEY_BYTES, 'sha256');
  }

  /** 供界面使用的凭据库状态：是否启用、是否锁定。 */
  async vaultStatus() {
    if (this.#vaultMeta === null) {
      try {
        this.#vaultMeta = JSON.parse(await readFile(this.#vaultFile(), 'utf8'));
      } catch {
        this.#vaultMeta = { enabled: false };
      }
    }
    return {
      enabled: this.#vaultMeta.enabled === true,
      locked: this.#vaultMeta.enabled === true && this.#vaultKey === null
    };
  }

  /** 凭据库未解锁前不允许读取密字段。 */
  async #requireUnlocked() {
    const status = await this.vaultStatus();
    if (status.enabled && status.locked) {
      throw new Error('凭据库已加锁：请先输入主口令解锁');
    }
  }

  /** 把全部密字段从一把钥匙重加密到另一把。 */
  async #migrate(fromKey, toKey) {
    const document = await this.#read();
    const next = document.connections.map((record) => ({
      ...record,
      password: this.#reencrypt(record.password, fromKey, toKey),
      privateKey: this.#reencrypt(record.privateKey, fromKey, toKey),
      passphrase: this.#reencrypt(record.passphrase, fromKey, toKey)
    }));
    await this.#write({ version: 1, connections: next });
    return next.length;
  }

  #reencrypt(value, fromKey, toKey) {
    if (value === undefined || value === null || value === '') return value;
    return this.#encryptWith(toKey, this.#decryptWith(fromKey, value));
  }

  /** 启用主口令凭据库（会迁移全部已存密字段）。 */
  async enableVault(passphrase) {
    if (String(passphrase).length < 8) throw new Error('主口令至少 8 位');
    return this.#enqueue(async () => {
      await this.#loadKey();
      const status = await this.vaultStatus();
      if (status.enabled) throw new Error('凭据库已经加锁，无需重复设置');
      const salt = randomBytes(16);
      const key = this.#derive(passphrase, salt);
      await this.#migrate(this.#key, key);
      this.#vaultKey = key;
      this.#vaultMeta = { enabled: true, salt: salt.toString('base64'), createdAt: Date.now() };
      await writeFile(this.#vaultFile(), JSON.stringify(this.#vaultMeta), { mode: 0o600 });
      return { enabled: true, locked: false };
    });
  }

  /** 派生并校验凭据库钥匙；调用方自行持有队列。 */
  async #unlockKey(passphrase) {
    const status = await this.vaultStatus();
    if (!status.enabled) return { enabled: false, locked: false };
    const key = this.#derive(passphrase, Buffer.from(this.#vaultMeta.salt, 'base64'));
    // prove the passphrase by decrypting the first stored secret
    const document = await this.#read();
    const sample = document.connections.find((record) => typeof record.password === 'string' || typeof record.privateKey === 'string');
    if (sample !== undefined) {
      try {
        this.#reencrypt(sample.password ?? sample.privateKey, key, key);
      } catch {
        throw new Error('主口令错误');
      }
    }
    this.#vaultKey = key;
    return { enabled: true, locked: false };
  }

  /** 为当前进程解锁凭据库。 */
  async unlockVault(passphrase) {
    return this.#enqueue(() => this.#unlockKey(passphrase));
  }

  /** 丢弃内存中的钥匙（密字段重新不可读）。 */
  lockVault() {
    this.#vaultKey = null;
    return { enabled: this.#vaultMeta?.enabled === true, locked: true };
  }

  /** 去掉主口令层，回到仅用文件密钥。 */
  async disableVault(passphrase) {
    return this.#enqueue(async () => {
      await this.#unlockKey(passphrase);
      await this.#loadKey();
      await this.#migrate(this.#vaultKey, this.#key);
      this.#vaultKey = null;
      this.#vaultMeta = { enabled: false };
      await unlink(this.#vaultFile()).catch(() => {});
      return { enabled: false, locked: false };
    });
  }

  /** 记录受信任的主机密钥指纹（首次信任）。 */
  async setHostKey(id, hostKey) {
    return this.#enqueue(async () => {
      const document = await this.#read();
      let changed = false;
      for (const entry of document.connections) {
        if (entry.id === id && entry.hostKey !== hostKey) {
          entry.hostKey = String(hostKey ?? '');
          changed = true;
        }
      }
      if (changed) await this.#write(document);
      return changed;
    });
  }

  /** 清除已存指纹，下次连接重新信任。 */
  async clearHostKey(id) {
    return this.setHostKey(id, '');
  }

  /** 记住某连接上次浏览的目录。 */
  async setLastPath(id, lastPath) {
    return this.#enqueue(async () => {
      const document = await this.#read();
      let changed = false;
      for (const entry of document.connections) {
        if (entry.id === id) {
          entry.lastPath = String(lastPath ?? '/');
          changed = true;
        }
      }
      if (changed) await this.#write(document);
      return changed;
    });
  }

  /** Mark one connection as recently used. */
  async touch(id) {
    return this.#enqueue(async () => {
      const document = await this.#read();
      let changed = false;
      for (const entry of document.connections) {
        if (entry.id === id) {
          entry.lastUsedAt = Date.now();
          changed = true;
        }
      }
      if (changed) await this.#write(document);
      return changed;
    });
  }

  /** Resolve one connection by id or exact name, secrets included. */
  async resolve(idOrName) {
    await this.#requireUnlocked();
    return this.#enqueue(async () => {
      await this.#loadKey();
      const document = await this.#read();
      const record = document.connections.find((entry) => entry.id === idOrName)
        ?? document.connections.find((entry) => entry.name === idOrName);
      return record === undefined ? undefined : this.#full(record);
    });
  }
}
