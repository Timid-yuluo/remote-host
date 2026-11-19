import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConnectionStore } from '../lib/store.js';

const dir = await mkdtemp(path.join(tmpdir(), 'rh-store-fix-'));
try {
  const store = new ConnectionStore(dir);
  const saved = await store.upsert({
    name: 'fix-check', host: '127.0.0.1', port: 22, username: 'root',
    authType: 'password', password: 'topsecret'
  });

  // 1. resolve() must hand back the decrypted secret (the original bug returned the redacted view)
  const resolved = await store.resolve(saved.id);
  if (resolved?.password !== 'topsecret') throw new Error(`resolve() lost the password: ${JSON.stringify(resolved)}`);
  const byName = await store.resolve('fix-check');
  if (byName?.password !== 'topsecret') throw new Error('resolve() by name lost the password');
  console.log('resolve(id|name) returns decrypted password OK');

  // 2. list() must stay redacted
  const list = await store.list();
  if (list[0].password !== undefined || list[0].hasSecret !== true) throw new Error('list() leaked or lost hasSecret');
  console.log('list() redacted, hasSecret=true OK');

  // 3. editing with an empty password keeps the stored one instead of wiping it
  await store.upsert({ id: saved.id, name: 'fix-check-2', host: '127.0.0.1', port: 22, username: 'root', authType: 'password', password: '' });
  const afterEdit = await store.get(saved.id);
  if (afterEdit?.password !== 'topsecret') throw new Error(`empty edit wiped the password: ${JSON.stringify(afterEdit)}`);
  if (afterEdit.name !== 'fix-check-2') throw new Error('edit did not apply other fields');
  console.log('empty-password edit keeps stored secret OK');

  // 4. a real password change still replaces it
  await store.upsert({ id: saved.id, name: 'fix-check-2', host: '127.0.0.1', port: 22, username: 'root', authType: 'password', password: 'newpass' });
  const changed = await store.get(saved.id);
  if (changed?.password !== 'newpass') throw new Error('password change did not apply');
  console.log('password change applies OK');

  // 5. key auth keeps its own secret
  const keySaved = await store.upsert({ name: 'key-check', host: 'h', port: 22, username: 'u', authType: 'key', privateKey: 'KEYDATA' });
  await store.upsert({ id: keySaved.id, name: 'key-check', host: 'h', port: 22, username: 'u', authType: 'key', privateKey: '' });
  const keyAgain = await store.get(keySaved.id);
  if (keyAgain?.privateKey !== 'KEYDATA') throw new Error('empty edit wiped the private key');
  console.log('private key preserved on empty edit OK');

  // 6. lastPath round-trip used by the panel's "back to last directory"
  await store.setLastPath(saved.id, '/var/www');
  const listed = (await store.list()).find((entry) => entry.id === saved.id);
  if (listed.lastPath !== '/var/www') throw new Error(`lastPath not exposed: ${JSON.stringify(listed)}`);
  console.log('lastPath remembered and exposed OK');

  console.log('STORE FIX TESTS PASS');
} finally {
  await rm(dir, { recursive: true, force: true });
}