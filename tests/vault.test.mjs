import { importPlugin } from './_paths.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const profileDir = await mkdtemp(path.join(tmpdir(), 'rh-vault-'));
process.env.DSH_PROFILE_DIR = profileDir;

const { ConnectionStore } = await importPlugin('lib/store.js');
const dir = path.join(profileDir, 'remote-host-store');

// 1. plain store: secrets encrypted with the file key
let store = new ConnectionStore(dir);
const saved = await store.upsert({ name: 'box', host: '10.0.0.9', username: 'root', authType: 'password', password: 'pw-plain' });
let status = await store.vaultStatus();
if (status.enabled) throw new Error('vault should start disabled');
const plaintext = await readFile(path.join(dir, 'connections.json'), 'utf8');
if (plaintext.includes('pw-plain')) throw new Error('password leaked to disk');
console.log('1. baseline: encrypted with the file key OK');

// 2. enable the vault → every secret re-encrypted with the passphrase key
await store.enableVault('correct-horse-battery');
status = await store.vaultStatus();
if (!status.enabled || status.locked) throw new Error(`unexpected status after enable: ${JSON.stringify(status)}`);
const afterUpgrade = await store.get(saved.id);
if (afterUpgrade.password !== 'pw-plain') throw new Error('secret unreadable right after enabling the vault');
console.log('2. vault enabled and secrets migrated OK');

// 3. a fresh process cannot read secrets until unlocked
store = new ConnectionStore(dir);
status = await store.vaultStatus();
if (!status.locked) throw new Error('a new process should see a locked vault');
const locked = await store.get(saved.id).then(() => null, (error) => error);
if (locked === null || !locked.message.includes('已加锁')) throw new Error(`expected a locked error, got ${locked?.message}`);
console.log('3. locked vault refuses to hand out secrets OK');

// 4. wrong passphrase is rejected, right one unlocks
const wrong = await store.unlockVault('nope-nope-nope').then(() => null, (error) => error);
if (wrong === null || !wrong.message.includes('主口令错误')) throw new Error(`wrong passphrase not rejected: ${wrong?.message}`);
await store.unlockVault('correct-horse-battery');
const unlocked = await store.get(saved.id);
if (unlocked.password !== 'pw-plain') throw new Error('unlock did not restore the secret');
console.log('4. wrong passphrase rejected, correct one unlocks OK');

// 5. re-saving through the vault keeps working and stays encrypted
await store.upsert({ id: saved.id, name: 'box', host: '10.0.0.9', username: 'root', authType: 'password', password: 'pw-rotated' });
const rotated = await store.get(saved.id);
if (rotated.password !== 'pw-rotated') throw new Error('rotating a secret through the vault failed');
const disk = await readFile(path.join(dir, 'connections.json'), 'utf8');
if (disk.includes('pw-rotated')) throw new Error('vault-written secret leaked to disk');
console.log('5. secrets written through the vault stay encrypted OK');

// 6. disable returns to the file key
await store.disableVault('correct-horse-battery');
store = new ConnectionStore(dir);
const plainAgain = await store.vaultStatus();
if (plainAgain.enabled) throw new Error('vault still enabled after disable');
const finalRead = await store.get(saved.id);
if (finalRead.password !== 'pw-rotated') throw new Error('secret lost while disabling the vault');
console.log('6. disabling the vault keeps every secret readable OK');

await rm(profileDir, { recursive: true, force: true });
console.log('VAULT TESTS PASS');
