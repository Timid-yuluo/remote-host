import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const profileDir = await mkdtemp(path.join(tmpdir(), 'rh-extra-'));
process.env.DSH_PROFILE_DIR = profileDir;

const { apply } = await import('../remote-host-plugin/entry.js');

const registered = { routes: [], tools: [] };
const ctx = {
  get connection() { return { requestRejection: () => undefined }; },
  get webServer() { return { register: (route) => { registered.routes.push(route); return () => {}; } }; },
  get tools() { return { register: (definition) => { registered.tools.push(definition); return () => {}; } }; },
  effect: (fn) => fn(),
  on: () => () => {}
};
await apply(ctx);
const route = registered.routes[0];

function makeRes() { const res = {}; res.writeHead = (s) => { res.status = s; return res; }; res.end = (b) => { res.body = b; return res; }; return res; }
function makeReq(url, body) {
  const chunks = [Buffer.from(JSON.stringify(body))];
  return { method: 'POST', url, headers: { 'content-type': 'application/json' },
    [Symbol.asyncIterator]() { let i = 0; return { next: () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) }; } };
}
async function rpc(endpoint, payload) {
  const res = makeRes();
  await route.handler(makeReq(`/remote-host-api/${endpoint}`, { type: 'client-request', rpcId: 'x', method: endpoint, payload }), res);
  return JSON.parse(res.body).result;
}

// 1. group persists on the public view
let saved = await rpc('connections.save', { name: 'grp-box', host: '127.0.0.1', port: 1, username: 'root', authType: 'password', password: 'pw', group: 'prod' });
if (!saved.ok) throw new Error(`save: ${JSON.stringify(saved)}`);
if (saved.value.connection.group !== 'prod') throw new Error('group not persisted');
console.log('1. connection group persisted OK');

// 2. audit records panel mutations
await rpc('fs.chmod', { id: saved.value.connection.id, path: '/tmp/x', mode: '755' });
await new Promise((r) => setTimeout(r, 30));
const audit = await rpc('audit.list', { limit: 20 });
if (!audit.ok) throw new Error(`audit.list: ${JSON.stringify(audit)}`);
if (audit.value.entries.length === 0) throw new Error('no audit entries recorded');
if (!audit.value.entries.some((entry) => entry.action === 'fs.chmod')) throw new Error(`audit missing chmod: ${JSON.stringify(audit.value.entries)}`);
console.log('2. audit trail recorded panel mutation OK:', audit.value.entries.length, 'entries');
const auditFile = await readFile(path.join(profileDir, 'remote-host-store', 'audit.jsonl'), 'utf8');
if (!auditFile.includes('fs.chmod')) throw new Error('audit.jsonl not written');
console.log('3. audit.jsonl persisted OK');

// 4. export produces an encrypted bundle that imports back
const exported = await rpc('connections.export', { passphrase: 'secret-pass' });
if (!exported.ok) throw new Error(`export: ${JSON.stringify(exported)}`);
if (exported.value.content.includes('pw') && exported.value.content.includes('127.0.0.1') === false) throw new Error('export leaked plaintext');
const bundle = JSON.parse(exported.value.content);
if (bundle.version !== 1 || typeof bundle.data !== 'string') throw new Error('bad bundle shape');
if (exported.value.content.includes('"password":"pw"')) throw new Error('plaintext password in export');
console.log('4. export encrypted OK');

// 5. wrong passphrase is rejected
const wrong = await rpc('connections.import', { passphrase: 'nope-nope', content: exported.value.content });
if (wrong.ok) throw new Error('wrong passphrase should fail');
if (!wrong.error.message.includes('口令错误')) throw new Error(`unexpected error: ${wrong.error.message}`);
console.log('5. wrong passphrase rejected OK');

// 6. correct passphrase imports the connection back
const imported = await rpc('connections.import', { passphrase: 'secret-pass', content: exported.value.content });
if (!imported.ok || imported.value.imported !== 1) throw new Error(`import: ${JSON.stringify(imported)}`);
const list = await rpc('connections.list', {});
if (list.value.connections.length !== 2) throw new Error(`expected 2 connections, got ${list.value.connections.length}`);
const roundtrip = list.value.connections.filter((entry) => entry.group === 'prod');
if (roundtrip.length !== 2) throw new Error('group lost in import');
console.log('6. import round-trip OK (2 connections, group preserved)');

// 7. tool exposes the tunnel action
const tool = registered.tools[0];
if (!tool.parameters.properties.action.enum.includes('tunnel')) throw new Error('tunnel action missing');
console.log('7. tunnel action exposed to the agent OK');

// 7a2. tool output contract (DSH enforces output.schema + output.render at register())
const toolDef = registered.tools[0];
if (toolDef?.output === undefined) throw new Error('tool has no output declaration');
if (typeof toolDef.output.render !== 'function') throw new Error('output.render is not a function');
if (typeof toolDef.output.presentationMeta !== 'function') throw new Error('output.presentationMeta is not a function');
const rendered = toolDef.output.render({ action: 'list', path: '/' }, { path: '/', entries: [1, 2] });
if (!Array.isArray(rendered) || rendered[0]?.type !== 'text') throw new Error('render did not return a text block');
const meta = toolDef.output.presentationMeta({ action: 'list', path: '/' }, { path: '/', entries: [1, 2] });
if (meta.action !== 'list' || meta.entries !== 2) throw new Error(`presentationMeta wrong: ${JSON.stringify(meta)}`);
if (JSON.stringify(meta) === undefined) throw new Error('presentationMeta must stay lossless JSON');
console.log('7a2. tool output contract (schema/render/presentationMeta) OK');

// 7b. git.info endpoint answers (fails cleanly for an unreachable host, not as an unknown endpoint)
const gitResult = await rpc('git.info', { id: saved.value.connection.id, path: '/tmp' });
const gitKnown = gitResult.ok || (gitResult.error && gitResult.error.code !== 'unknown-endpoint');
if (!gitKnown) throw new Error(`git.info not registered: ${JSON.stringify(gitResult)}`);
console.log('7b. git.info endpoint registered OK');

// 8. tunnel.list returns an empty list before any tunnel
const tunnels = await rpc('tunnel.list', {});
if (!tunnels.ok || !Array.isArray(tunnels.value.tunnels)) throw new Error('tunnel.list failed');
console.log('8. tunnel.list OK');

await rm(profileDir, { recursive: true, force: true });
console.log('EXTRAS TESTS PASS');
