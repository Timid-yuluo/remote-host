import { importPlugin } from './_paths.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const profileDir = await mkdtemp(path.join(tmpdir(), 'rh-ws-'));
process.env.DSH_PROFILE_DIR = profileDir;

// exercise the thin entry: it dynamic-imports app.js with a cache-busting URL
const { apply } = await importPlugin('entry.js');

const registered = { routes: [], tools: [] };
const handlers = { 'agent/created': [] };
const promptContexts = [];
const systemPromptStub = {
  context: (entry) => { promptContexts.push(entry); return () => {}; },
  getContextOrder: () => 50
};
const ctx = {
  get connection() { return { requestRejection: () => undefined }; },
  get webServer() { return { register: (route) => { registered.routes.push(route); return () => {}; } }; },
  get tools() { return { register: (definition) => { registered.tools.push(definition); return () => {}; } }; },
  effect: (fn) => { const dispose = fn(); return dispose; },
  get(name) { return name === 'systemPrompt' ? systemPromptStub : undefined; },
  on: (name, listener) => { (handlers[name] ??= []).push(listener); return () => {}; }
};
await apply(ctx);
const route = registered.routes[0];
const tool = registered.tools[0];
if (tool === undefined) throw new Error('tool not registered');

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

// 1. save a connection, then make it the default workspace
let result = await rpc('connections.save', { name: 'ws-box', host: '127.0.0.1', port: 1, username: 'root', authType: 'password', password: 'pw' });
if (!result.ok) throw new Error(`save: ${JSON.stringify(result)}`);
const connectionId = result.value.connection.id;

result = await rpc('workspace.setDefault', { connection: connectionId, path: '/var/www/' });
if (!result.ok) throw new Error(`setDefault: ${JSON.stringify(result)}`);
if (result.value.default.path !== '/var/www') throw new Error(`path not normalized: ${result.value.default.path}`);
console.log('1. workspace.setDefault normalizes path OK:', result.value.default.path);

result = await rpc('workspace.get', {});
if (result.value.default?.connectionName !== 'ws-box') throw new Error('workspace.get default missing');
console.log('2. workspace.get returns default OK');

// 3. tool: bind this conversation, then read the binding back
const exec = { agent: { id: 'sess-1' } };
const bound = await tool.execute({ action: 'bind', connection: 'ws-box', path: '/etc' }, exec);
if (!bound.ok || bound.binding.path !== '/etc') throw new Error(`bind: ${JSON.stringify(bound)}`);
const view = await tool.execute({ action: 'workspace' }, exec);
if (view.binding?.path !== '/etc') throw new Error(`workspace view: ${JSON.stringify(view)}`);
console.log('3. tool bind → workspace view OK:', view.binding.connectionName + ':' + view.binding.path);

// 3b. binding.get returns exactly this session's binding
const fetched = await rpc('binding.get', { sessionId: 'sess-1' });
if (fetched.value.binding?.path !== '/etc') throw new Error(`binding.get: ${JSON.stringify(fetched)}`);
const missing = await rpc('binding.get', { sessionId: 'sess-x' });
if (missing.value.binding !== null) throw new Error('binding.get should be null for an unbound session');
console.log('3b. binding.get returns session binding OK');

// 4. omitting connection resolves through the session binding and reaches SSH
const listResult = await tool.execute({ action: 'list' }, exec).then((value) => ({ ok: true, value }), (error) => ({ ok: false, message: error.message }));
if (listResult.ok) throw new Error('unexpected success connecting to port 1');
if (listResult.message.includes('未指定 connection')) throw new Error(`binding not used: ${listResult.message}`);
console.log('4. connection omitted → session binding used (transport error proves resolution):', listResult.message);

// 5. unbind falls back to the default workspace
const removed = await tool.execute({ action: 'unbind' }, exec);
if (!removed.removed) throw new Error('unbind failed');
const fallback = await tool.execute({ action: 'workspace' }, exec);
if (fallback.binding?.path !== '/var/www') throw new Error(`fallback to default failed: ${JSON.stringify(fallback)}`);
console.log('5. unbind → falls back to default workspace OK');

// 6. agent/created prewarms the bound connection (fire-and-forget, must not throw)
const resumeHooks = handlers['agent/created'] ?? [];
if (resumeHooks.length !== 1) throw new Error(`expected one agent/created listener, got ${resumeHooks.length}`);
await resumeHooks[0]({ agent: { id: 'sess-1' }, source: 'resume' });
console.log('6. agent/created resume hook ran without throwing OK');

// 7. bindings persisted on disk
const raw = JSON.parse(await readFile(path.join(profileDir, 'remote-host-store', 'bindings.json'), 'utf8'));
if (raw.default?.path !== '/var/www') throw new Error('bindings file missing default');
console.log('7. bindings.json persisted OK');

// 8. clearing the default
result = await rpc('workspace.clearDefault', {});
if (!result.ok) throw new Error('clearDefault failed');
const after = await rpc('workspace.get', {});
if (after.value.default !== null) throw new Error('default not cleared');
console.log('8. workspace.clearDefault OK');

// 9. fs.list records the remembered directory for the connection
const listing = await rpc('fs.list', { id: connectionId, path: '/tmp' });
if (listing.ok) {
  const saved = (await rpc('connections.list', {})).value.connections.find((entry) => entry.id === connectionId);
  if (saved !== undefined && saved.lastPath === undefined) throw new Error('lastPath not exposed');
  console.log('9. fs.list remembered directory OK');
}

// 9. 绑定的远程工作区必须出现在每轮系统提示里（否则模型不会去用 remote_fs）
await tool.execute({ action: 'bind', connection: 'ws-box', path: '/etc' }, { agent: { id: 'sess-1' } });
const assemble = (handlers['system-prompt/assemble'] ?? [])[0];
if (assemble === undefined) throw new Error('system-prompt/assemble listener not registered');
if (promptContexts.length === 0) throw new Error('prompt context slot not registered');
const assembly = { sections: [], contexts: [], tools: [], variables: {} };
const out = await assemble(assembly, { agent: { id: 'sess-1' } }, async () => assembly);
const injected = (out.contexts ?? []).find((entry) => entry.name === 'remote-host:workspace');
if (injected === undefined) throw new Error('bound workspace not injected into the prompt');
if (!injected.text.includes('ws-box')) throw new Error(`prompt text missing connection: ${injected.text}`);
if (!injected.text.includes('/etc')) throw new Error('prompt text missing path');
console.log('9. bound workspace injected into system prompt OK');

// 10. 没有会话绑定时退回默认工作区（默认工作区也要对模型可见）
await rpc('workspace.setDefault', { connection: 'ws-box', path: '/var/www' });
const defaultAssembly = { sections: [], contexts: [], tools: [], variables: {} };
const withDefault = await assemble(defaultAssembly, { agent: { id: 'sess-unbound' } }, async () => defaultAssembly);
const fallbackEntry = (withDefault.contexts ?? []).find((entry) => entry.name === 'remote-host:workspace');
if (fallbackEntry === undefined) throw new Error('default workspace not injected');
if (!fallbackEntry.text.includes('/var/www')) throw new Error(`default path missing: ${fallbackEntry.text}`);
if (!fallbackEntry.text.includes('默认')) throw new Error('default workspace should be labelled as such');
console.log('10. default workspace injected for unbound sessions OK');

// 11. 完全没有工作区时不注入（避免噪音）
await rpc('workspace.clearDefault', {});
const bareAssembly = { sections: [], contexts: [], tools: [], variables: {} };
const bare = await assemble(bareAssembly, { agent: { id: 'sess-unbound' } }, async () => bareAssembly);
const bareEntry = (bare.contexts ?? []).find((entry) => entry.name === 'remote-host:workspace');
if (bareEntry !== undefined && bareEntry.text !== '') throw new Error('no workspace should mean no injection');
console.log('11. no workspace → no prompt noise OK');

await rm(profileDir, { recursive: true, force: true });
console.log('WORKSPACE BINDING TESTS PASS');