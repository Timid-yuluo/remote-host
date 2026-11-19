import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConnectionStore } from '../lib/store.js';

const dir = await mkdtemp(path.join(tmpdir(), 'rh-store-test-'));
try {
  const store = new ConnectionStore(dir);
  const saved = await store.upsert({
    name: 'test-1', host: '127.0.0.1', port: 2222, username: 'root',
    authType: 'password', password: 'p@ssw0rd中文', passphrase: undefined
  });
  console.log('publicView:', JSON.stringify(saved));
  const list = await store.list();
  if (list.length !== 1 || list[0].password !== undefined) throw new Error('public view leaked secret');
  const full = await store.get(saved.id);
  console.log('decrypted password:', full.password);
  if (full.password !== 'p@ssw0rd中文') throw new Error('roundtrip mismatch');
  const raw = await readFile(path.join(dir, 'connections.json'), 'utf8');
  if (raw.includes('p@ssw0rd')) throw new Error('plaintext leaked to disk');
  const keyStat = await stat(path.join(dir, '.secret.key'));
  console.log('key mode:', (keyStat.mode & 0o777).toString(8));
  const docStat = await stat(path.join(dir, 'connections.json'));
  console.log('store mode:', (docStat.mode & 0o777).toString(8));
  // update path
  const updated = await store.upsert({ id: saved.id, name: 'test-1b', host: '127.0.0.1', port: 2223, username: 'root', authType: 'key', privateKey: 'KEYDATA' });
  const again = await store.get(updated.id);
  if (again.privateKey !== 'KEYDATA' || again.port !== 2223) throw new Error('update mismatch');
  const resolved = await store.resolve('test-1b');
  if (resolved?.id !== saved.id) throw new Error('resolve by name failed');
  const removed = await store.remove(saved.id);
  if (!removed || (await store.list()).length !== 0) throw new Error('remove failed');
  console.log('STORE TEST PASS');
} finally {
  await rm(dir, { recursive: true, force: true });
}
