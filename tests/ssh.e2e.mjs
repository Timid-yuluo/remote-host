import { importPlugin } from './_paths.mjs';

import { constants, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, renameSync, mkdirSync as mkd, rmdirSync, unlinkSync, existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ssh2 from 'ssh2'; const { Server } = ssh2; const { OPEN_MODE, STATUS_CODE } = await import('ssh2/lib/protocol/SFTP.js');
import { createRequire } from 'node:module'; const require2 = createRequire(import.meta.url); const { SshPool } = await importPlugin('lib/ssh.js');

const root = await mkdtemp(path.join(tmpdir(), 'rh-ssh-root-'));
mkdirSync(path.join(root, 'sub'));
writeFileSync(path.join(root, 'hello.txt'), '你好，远程主机 hello\n'.repeat(3));
writeFileSync(path.join(root, 'sub', 'inner.txt'), 'inner');

// generate a throwaway host key next to the sandbox (ssh2 rejects PKCS8/Ed25519 PEM)
const hostKeyPath = path.join(tmpdir(), `rh-hostkey-${process.pid}-${Date.now()}`);
const { execFileSync } = await import('node:child_process');
execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', hostKeyPath, '-q']);
const hostKey = readFileSync(hostKeyPath);

/** Map a client path onto the sandbox root (no escaping). */
function resolveInRoot(rootDir, requestPath) {
  const clean = String(requestPath ?? '/').split('/').filter((part) => part !== '' && part !== '.');
  const resolved = [];
  for (const part of clean) {
    if (part === '..') continue;
    resolved.push(part);
  }
  return path.join(rootDir, ...resolved);
}

function attrsFor(target) {
  const stats = statSync(target);
  return { mode: stats.mode, uid: 0, gid: 0, size: stats.size, atime: Math.floor(stats.atimeMs / 1000), mtime: Math.floor(stats.mtimeMs / 1000) };
}

function longname(target, name) {
  const stats = statSync(target);
  const type = stats.isDirectory() ? 'd' : stats.isSymbolicLink() ? 'l' : '-';
  const mode = (stats.mode & 0o777).toString(8).padStart(3, '0').split('').join('');
  const perms = mode.split('').map((n) => ({ '7': 'rwx', '6': 'rw-', '5': 'r-x', '4': 'r--', '0': '---' })[n] ?? '---').join('');
  return `${type}${perms} 1 root root ${stats.size} Jan 1 00:00 ${name}`;
}

let lastServerClient = null;
const server = new Server({ hostKeys: [hostKey] }, (client) => {
  lastServerClient = client;
  // a destroyed transport must not surface as an unhandled error
  client.on('error', () => {});
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.username === 'tester' && ctx.password === 'testpw') return ctx.accept();
    // publickey: accept the probe so the client signs, then accept the signed attempt
    if (ctx.method === 'publickey' && ctx.username === 'tester') return ctx.accept();
    ctx.reject();
  }).on('ready', () => {
    client.on('session', (accept) => {
      const session = accept();
      session.on('sftp', (accept) => {
        const sftp = accept();
        const openFiles = new Map();
        const openDirs = new Map();
        let handleCount = 0;
        const newHandle = (store, value) => {
          const handle = Buffer.alloc(4);
          handle.writeUInt32BE(handleCount++, 0);
          store.set(handle.toString('hex'), value);
          return handle;
        };

        sftp.on('REALPATH', (reqid, requestPath) => {
          const resolved = resolveInRoot(root, requestPath);
          sftp.name(reqid, [{ filename: resolved === root ? '/' : resolved.slice(root.length), longname: resolved, attrs: {} }]);
        }).on('STAT', (reqid, requestPath) => {
          const target = resolveInRoot(root, requestPath);
          console.error('[srv] STAT reqid', reqid, requestPath, 'exists', existsSync(target));
          if (!existsSync(target)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
          const a = attrsFor(target);
          console.error('[srv] STAT reqid', reqid, 'attrs size', a.size);
          sftp.attrs(reqid, a);
        }).on('FSTAT', (reqid, handle) => {
          const entry = openFiles.get(handle.toString('hex'));
          if (entry === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE);
          try {
            const stats = fstatSync(entry.fd);
            sftp.attrs(reqid, { mode: stats.mode, uid: 0, gid: 0, size: stats.size, atime: Math.floor(stats.atimeMs / 1000), mtime: Math.floor(stats.mtimeMs / 1000) });
          } catch { sftp.status(reqid, STATUS_CODE.FAILURE); }
        }).on('LSTAT', (reqid, requestPath) => {
          console.error('[srv] LSTAT reqid', reqid, requestPath, 'exists', existsSync(resolveInRoot(root, requestPath)));
          const target = resolveInRoot(root, requestPath);
          if (!existsSync(target)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
          sftp.attrs(reqid, attrsFor(target));
        }).on('OPENDIR', (reqid, requestPath) => {
          console.error('[srv] OPENDIR reqid', reqid, requestPath);
          const target = resolveInRoot(root, requestPath);
          try {
            const names = readdirSync(target);
            sftp.handle(reqid, newHandle(openDirs, { target, names, sent: false }));
          } catch {
            sftp.status(reqid, STATUS_CODE.FAILURE);
          }
        }).on('READDIR', (reqid, handle) => {
          console.error('[srv] READDIR reqid', reqid, 'known', openDirs.has(handle.toString('hex')));
          const entry = openDirs.get(handle.toString('hex'));
          if (entry === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE);
          if (entry.sent) return sftp.status(reqid, STATUS_CODE.EOF);
          entry.sent = true;
          const listing = entry.names.map((name) => {
            const full = path.join(entry.target, name);
            let attrs = {};
            try { attrs = attrsFor(full); } catch { /* gone */ }
            return { filename: name, longname: longname(full, name), attrs };
          });
          sftp.name(reqid, listing);
        }).on('OPEN', (reqid, requestPath, flags) => {
          const target = resolveInRoot(root, requestPath);
          try {
            const writeMode = (flags & OPEN_MODE.WRITE) !== 0 || (flags & OPEN_MODE.CREAT) !== 0;
            let fd;
            if (writeMode) fd = openSyncForWrite(target);
            else fd = openForRead(target);
            sftp.handle(reqid, newHandle(openFiles, { fd, target, writeMode }));
          } catch {
            sftp.status(reqid, STATUS_CODE.FAILURE);
          }
        }).on('READ', (reqid, handle, offset, length) => {
          const entry = openFiles.get(handle.toString('hex'));
          if (entry === undefined || entry.writeMode) return sftp.status(reqid, STATUS_CODE.FAILURE);
          const buffer = Buffer.alloc(length);
          let read = 0;
          try { read = readSyncFd(entry.fd, buffer, offset); } catch { return sftp.status(reqid, STATUS_CODE.FAILURE); }
          if (read === 0) return sftp.status(reqid, STATUS_CODE.EOF);
          sftp.data(reqid, buffer.subarray(0, read));
        }).on('WRITE', (reqid, handle, offset, data) => {
          const entry = openFiles.get(handle.toString('hex'));
          console.error('[srv] WRITE known', openFiles.has(handle.toString('hex')), 'writeMode', entry && entry.writeMode, 'len', data && data.byteLength, 'dataIsBuf', Buffer.isBuffer(data));
          if (entry === undefined || !entry.writeMode) return sftp.status(reqid, STATUS_CODE.FAILURE);
          try {
            const n = writeAtFd(entry.fd, data, offset);
            console.error('[srv] WRITE wrote', n, 'size now', statSync(entry.target).size);
            sftp.status(reqid, STATUS_CODE.OK);
          } catch (e) {
            console.error('[srv] WRITE error', e.message);
            sftp.status(reqid, STATUS_CODE.FAILURE);
          }
        }).on('CLOSE', (reqid, handle) => {
          const key = handle.toString('hex');
          console.error('[srv] CLOSE known-files', openFiles.has(key), 'known-dirs', openDirs.has(key));
          if (openFiles.has(key)) {
            closeFd(openFiles.get(key).fd);
            openFiles.delete(key);
            return sftp.status(reqid, STATUS_CODE.OK);
          }
          if (openDirs.has(key)) {
            openDirs.delete(key);
            return sftp.status(reqid, STATUS_CODE.OK);
          }
          sftp.status(reqid, STATUS_CODE.FAILURE);
        }).on('SETSTAT', (reqid) => { console.error('[srv] SETSTAT (unhandled)'); sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED); })
          .on('FSETSTAT', (reqid) => { console.error('[srv] FSETSTAT (unhandled)'); sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED); })
          .on('FSYNC', (reqid) => { console.error('[srv] FSYNC (unhandled)'); sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED); })
          .on('READLINK', (reqid) => { console.error('[srv] READLINK (unhandled)'); sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED); })
          .on('SYMLINK', (reqid) => { console.error('[srv] SYMLINK (unhandled)'); sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED); })
          .on('EXTENDED', (reqid) => { console.error('[srv] EXTENDED (unhandled)'); sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED); })
          .on('MKDIR', (reqid, requestPath) => {
          try { mkd(resolveInRoot(root, requestPath)); sftp.status(reqid, STATUS_CODE.OK); }
          catch { sftp.status(reqid, STATUS_CODE.FAILURE); }
        }).on('RMDIR', (reqid, requestPath) => {
          try { rmdirSync(resolveInRoot(root, requestPath)); sftp.status(reqid, STATUS_CODE.OK); }
          catch { sftp.status(reqid, STATUS_CODE.FAILURE); }
        }).on('REMOVE', (reqid, requestPath) => {
          console.error('[srv] UNLINK', requestPath);
          try { unlinkSync(resolveInRoot(root, requestPath)); sftp.status(reqid, STATUS_CODE.OK); }
          catch (e) { console.error('[srv] UNLINK error', e.message); sftp.status(reqid, STATUS_CODE.FAILURE); }
        }).on('RENAME', (reqid, from, to) => {
          console.error('[srv] RENAME', from, '→', to);
          try { renameSync(resolveInRoot(root, from), resolveInRoot(root, to)); sftp.status(reqid, STATUS_CODE.OK); }
          catch (e) { console.error('[srv] RENAME error', e.message); sftp.status(reqid, STATUS_CODE.FAILURE); }
        });
      });
    });
  });
});

import { openSync, readSync, writeSync, closeSync, fstatSync } from 'node:fs';
function openForRead(target) { return openSync(target, 'r'); }
function openSyncForWrite(target) { return openSync(target, 'w'); }
function readSyncFd(fd, buffer, offset) { return readSync(fd, buffer, 0, buffer.byteLength, offset); }
function writeAtFd(fd, data, offset) { writeSync(fd, data, 0, data.byteLength, offset); }
function closeFd(fd) { try { closeSync(fd); } catch { /* gone */ } }



await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const port = server.address().port;
console.log('loopback sshd on 127.0.0.1:' + port);

const recordedKeys = [];
const recordedMismatches = [];
const pool = new SshPool({
  onHostKey: (id, fingerprint) => recordedKeys.push({ id, fingerprint }),
  onHostKeyMismatch: (id, info) => recordedMismatches.push({ id, ...info })
});
const profile = {
  id: 't1', host: '127.0.0.1', port, username: 'tester', authType: 'password', password: 'testpw'
};

try {
  const listing = await pool.list(profile, '/');
  console.log('list /:', listing.entries.map((entry) => `${entry.type}:${entry.name}`).join(', '));
  if (!listing.entries.some((entry) => entry.name === 'hello.txt')) throw new Error('readdir missing hello.txt');

  const read = await pool.read(profile, '/hello.txt');
  if (read.binary || !read.content.includes('你好，远程主机')) throw new Error('read mismatch');
  console.log('read ok, size', read.size, 'truncated', read.truncated);

  const big = await pool.read(profile, '/hello.txt', 8);
  if (!big.truncated) throw new Error('truncation flag missing');
  console.log('bounded read ok, kept', big.content.length, 'bytes');

  const directStat = await pool.stat(profile, '/uploaded.txt').catch((e) => ({ error: e.message }));
  console.log('direct stat before write:', JSON.stringify(directStat));
  const written = await pool.write(profile, '/uploaded.txt', 'written-by-pool 你好');
  const back = await pool.read(profile, '/uploaded.txt');
  if (back.content !== 'written-by-pool 你好') throw new Error('write/read mismatch');
  console.log('write ok, size', written.size);

  await pool.mkdir(profile, '/made');
  const after = await pool.list(profile, '/');
  if (!after.entries.some((entry) => entry.name === 'made')) throw new Error('mkdir missing');

  await pool.rename(profile, '/uploaded.txt', '/renamed.txt');
  if (!existsSync(path.join(root, 'renamed.txt'))) throw new Error('rename failed');

  const stats = await pool.stat(profile, '/renamed.txt');
  if (stats.type !== 'file') throw new Error('stat type mismatch');

  await pool.remove(profile, '/sub', true);
  if (existsSync(path.join(root, 'sub'))) throw new Error('recursive remove failed');

  await pool.remove(profile, '/made', false);
  await pool.remove(profile, '/renamed.txt');
  await pool.remove(profile, '/hello.txt');

  const finalListing = await pool.list(profile, '/');
  if (finalListing.entries.length !== 0) throw new Error('cleanup failed');


  // ---- host key trust on first use ----
  if (recordedKeys.length === 0) throw new Error('onHostKey was never called — TOFU did not record a fingerprint');
  const tofu = recordedKeys[0].fingerprint;
  if (!tofu.startsWith('SHA256:')) throw new Error(`unexpected fingerprint format: ${tofu}`);
  console.log('host key recorded on first use:', tofu.slice(0, 24) + '…');

  // ---- same fingerprint is accepted silently ----
  await pool.disconnect(profile.id);
  recordedKeys.length = 0;
  await pool.list({ ...profile, hostKey: tofu }, '/');
  if (recordedKeys.length !== 0) throw new Error('a known fingerprint should not be re-recorded');
  console.log('known fingerprint accepted without re-recording OK');

  // ---- a changed fingerprint is refused ----
  await pool.disconnect(profile.id);
  const wrongFingerprint = 'SHA256:' + 'A'.repeat(43);
  const mismatch = await pool.list({ ...profile, hostKey: wrongFingerprint }, '/').then(() => null, (error) => error);
  if (mismatch === null) throw new Error('a changed host key must be refused');
  if (!mismatch.message.includes('主机密钥已改变')) throw new Error(`unexpected mismatch error: ${mismatch.message}`);
  if (recordedMismatches.length === 0) throw new Error('onHostKeyMismatch was never called');
  console.log('changed host key refused with a clear error OK');

  // ---- key authentication ----
  await pool.disconnect(profile.id);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const keyDir = await mkdtemp(path.join(tmpdir(), 'rh-key-'));
  const keyPath2 = path.join(keyDir, 'id_ed25519');
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath2, '-q']);
  const privateKey = readFileSync(keyPath2, 'utf8');
  const keyProfile = {
    id: 't-key', host: '127.0.0.1', port, username: 'tester', authType: 'key', privateKey: privateKey.slice(0, 0) + privateKey
  };
  const keyListing = await pool.list(keyProfile, '/');
  if (!Array.isArray(keyListing.entries)) throw new Error('key auth list failed');
  console.log('key authentication connected OK');
  await pool.disconnect(keyProfile.id);
  execFileSync('rm', ['-rf', keyDir]);

  // ---- reconnects after the transport dies ----
  await new Promise((resolve) => setTimeout(resolve, 120));
  await pool.list(profile, '/');
  // ssh2 server-side Client exposes end(); socket teardown is the hard drop
  const dropped = lastServerClient;
  if (typeof dropped?.end === 'function') dropped.end();
  else if (typeof dropped?._sock?.destroy === 'function') dropped._sock.destroy();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const afterDrop = await pool.list(profile, '/');
  if (!Array.isArray(afterDrop.entries)) throw new Error('reconnect list failed');
  console.log('reconnected after the transport dropped OK');

  pool.disconnect(profile.id);
  if (pool.isActive(profile.id)) throw new Error('disconnect failed');
  console.log('SSH END-TO-END PASS (connect, list, read, bounded-read, write, mkdir, rename, stat, recursive remove, host-key TOFU, mismatch refusal, key auth, reconnect, disconnect)');
} finally {
  server.close();
  await rm(root, { recursive: true, force: true });
}
