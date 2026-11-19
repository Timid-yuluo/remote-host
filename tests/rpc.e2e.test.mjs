import { importPlugin } from './_paths.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const profileDir = await mkdtemp(path.join(tmpdir(), 'rh-rpc-'));
process.env.DSH_PROFILE_DIR = profileDir;

const { apply } = await importPlugin('entry.js');

const registered = { routes: [], tools: [] };
const ctx = {
  get connection() { return { requestRejection: () => undefined }; },
  get webServer() { return { register: (route) => { registered.routes.push(route); return () => {}; } }; },
  get tools() { return { register: (definition) => { registered.tools.push(definition); return () => {}; } }; },
  effect: (fn) => fn(),
  on: () => () => {}
};
const cleanup = await apply(ctx);
const route = registered.routes[0];

function makeRes() {
  const res = { status: null, body: null };
  res.writeHead = (status) => { res.status = status; return res; };
  res.end = (body) => { res.body = body; return res; };
  return res;
}
function makeReq(url, body) {
  const chunks = [Buffer.from(JSON.stringify(body))];
  return {
    method: 'POST', url, headers: { 'content-type': 'application/json' },
    [Symbol.asyncIterator]() {
      let i = 0;
      return { next: () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) };
    }
  };
}
async function rpc(endpoint, payload) {
  const res = makeRes();
  await route.handler(makeReq(`/remote-host-api/${endpoint}`, { type: 'client-request', rpcId: 'x', method: endpoint, payload }), res);
  return JSON.parse(res.body).result;
}

// 1. save with a password
let result = await rpc('connections.save', { name: 'rpc-check', host: '127.0.0.1', port: 1, username: 'root', authType: 'password', password: 'pw-1' });
if (!result.ok) throw new Error(`save failed: ${JSON.stringify(result)}`);
if (result.value.connection.hasSecret !== true) throw new Error('hasSecret should be true after saving a password');
console.log('1. save with password → hasSecret true OK');

// 2. the stored file must carry an encrypted password, never plaintext
const raw = await readFile(path.join(profileDir, 'remote-host-store', 'connections.json'), 'utf8');
const stored = JSON.parse(raw);
if (stored.connections[0].password === undefined) throw new Error('password field missing from disk record');
if (raw.includes('pw-1')) throw new Error('plaintext password leaked to disk');
console.log('2. encrypted password persisted, no plaintext OK');

// 3. connecting to 127.0.0.1:1 must fail on the SOCKET, not on a missing password
const listResult = await rpc('fs.list', { id: stored.connections[0].id, path: '/' });
if (listResult.ok !== false) throw new Error('unexpected success connecting to port 1');
const message = listResult.error.message;
if (message.includes('未保存密码')) throw new Error(`PASSWORD WAS NOT DECRYPTED: ${message}`);
console.log(`3. password reached the SSH layer (error is transport, not credential): ${message}`);

// 4. a new connection without a password is rejected up front
const rejected = await rpc('connections.save', { name: 'no-pw', host: '127.0.0.1', port: 22, username: 'root', authType: 'password' });
if (rejected.ok !== false || rejected.error.message !== '请填写密码') throw new Error(`missing-password save not rejected: ${JSON.stringify(rejected)}`);
console.log('4. new connection without password rejected with 请填写密码 OK');

// 5. editing with an empty password keeps the stored secret
const edit = await rpc('connections.save', { id: stored.connections[0].id, name: 'rpc-check-2', host: '127.0.0.1', port: 1, username: 'root', authType: 'password', password: '' });
if (!edit.ok || edit.value.connection.hasSecret !== true) throw new Error('empty-password edit wiped the secret');
const after = await readFile(path.join(profileDir, 'remote-host-store', 'connections.json'), 'utf8');
if (JSON.parse(after).connections[0].password === undefined) throw new Error('edit removed the stored password');
console.log('5. empty-password edit keeps the stored secret OK');

// entry.js registers its own cleanup through ctx.effect, nothing to call here.
await rm(profileDir, { recursive: true, force: true });
console.log('RPC END-TO-END PASS');