import { importPlugin } from './_paths.mjs';
import net from 'node:net';
const { SshPool } = await importPlugin('lib/ssh.js');

/** Probe whether a local sshd is listening. */
function probe(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.setTimeout(1500);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

const hasSshd = await probe(22);
console.log('local sshd on :22 →', hasSshd);

// SshPool lifecycle without a server: active/isActive/disconnect must be safe.
const pool = new SshPool();
if (pool.active().length !== 0) throw new Error('pool should start empty');
if (pool.isActive('nope') !== false) throw new Error('isActive mismatch');
pool.disconnect('nope');
await pool.disposeAll();
console.log('SSH POOL LIFECYCLE PASS');

// connectOptions: password profile
const options = (await importPlugin('lib/ssh.js')).connectOptions({
  host: 'h', port: 2222, username: 'u', authType: 'password', password: 'pw'
});
if (options.password !== 'pw' || options.port !== 2222) throw new Error('connectOptions mismatch');
try {
  (await importPlugin('lib/ssh.js')).connectOptions({ host: 'h', username: 'u', authType: 'key' });
  throw new Error('missing key should throw');
} catch (e) {
  if (!String(e.message).includes('私钥')) throw e;
}
console.log('CONNECT OPTIONS PASS');

if (hasSshd) {
  console.log('NOTE: local sshd present — live connect test skipped here (needs credentials); use the Web panel to add a connection and test.');
} else {
  console.log('NOTE: no local sshd; live SSH verified only through user-supplied hosts.');
}
console.log('SSH MODULE TESTS DONE');
