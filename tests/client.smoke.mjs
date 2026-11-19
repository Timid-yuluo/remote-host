import { pluginPath } from './_paths.mjs';
/**
 * Client-side smoke test: loads the plugin's browser half through a stub of the
 * DSH module system, stubs React with a minimal hook engine, registers the slots
 * against a fake ctx, and renders every registered component once.
 *
 * Purpose: catch structural breakage (renamed helpers, missing bindings, bad
 * h() nesting) in client.js without a browser.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = pluginPath('client.js');

/* ------------------------------------------------------------------ */
/* Minimal React                                                       */
/* ------------------------------------------------------------------ */
const Fragment = Symbol('Fragment');
let hookCursor = 0;
/** Per-component-instance hook storage, keyed by name + render order. */
let hookStates = [];
const instanceStates = new Map();
let instanceCounter = 0;
let pendingEffects = [];

function useState(initial) {
  const index = hookCursor++;
  const store = hookStates; // bind to THIS instance's array, not the global cursor
  if (!(index in store)) store[index] = typeof initial === 'function' ? initial() : initial;
  const setState = (value) => {
    store[index] = typeof value === 'function' ? value(store[index]) : value;
  };
  return [store[index], setState];
}

function useEffect(fn) {
  pendingEffects.push(fn);
}
function useCallback(fn) {
  return fn;
}
function useMemo(factory) {
  return factory();
}
function useRef(initial) {
  const index = hookCursor++;
  const store = hookStates;
  if (!(index in store)) store[index] = { current: initial };
  return store[index];
}

function flatten(children, out) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) flatten(child, out);
    else out.push(child);
  }
  return out;
}

/** Resolve one vnode into { kind, type, props, rendered } without touching the DOM. */
function renderNode(node, depth, stats) {
  if (node === null || node === undefined || node === false || node === true) return null;
  if (typeof node === 'string' || typeof node === 'number') {
    stats.text += 1;
    return { kind: 'text', value: String(node) };
  }
  if (Array.isArray(node)) return flatten(node, []).map((child) => renderNode(child, depth, stats));
  if (typeof node !== 'object') return null;

  const { type, props } = node;
  if (typeof type === 'function') {
    stats.components += 1;
    if (depth > 60) throw new Error('render depth exceeded — component recursion loop?');
    const outerStates = hookStates;
    const outerCursor = hookCursor;
    const instanceKey = `${type.name || 'anon'}@${instanceCounter++}`;
    hookStates = instanceStates.get(instanceKey) ?? [];
    hookCursor = 0;
    let output;
    try {
      output = type(props ?? {});
    } finally {
      instanceStates.set(instanceKey, hookStates);
      hookStates = outerStates;
      hookCursor = outerCursor;
    }
    return renderNode(output, depth + 1, stats);
  }
  if (type === Fragment) return renderNode(flatten([props?.children ?? []], []), depth + 1, stats);
  stats.elements += 1;
  if (props?.className === 'rh-modal') stats.modals += 1;
  const children = flatten([props?.children ?? []], []);
  return { kind: 'element', type, props, children: children.map((child) => renderNode(child, depth + 1, stats)) };
}

function h(type, props, ...children) {
  const merged = { ...(props ?? {}) };
  if (children.length === 1) merged.children = children[0];
  else if (children.length > 1) merged.children = children;
  return { type, props: merged };
}

const ReactShim = {
  createElement: h,
  Fragment,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef
};

/* ------------------------------------------------------------------ */
/* DSH module system stub                                              */
/* ------------------------------------------------------------------ */
const registeredModules = new Map();
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      // 复刻 ClientModuleSystem.register 的键计算：有 chunk 时拼成 `<id>/<chunk>`
      const key = definition.chunk === undefined ? definition.id : `${definition.id}/${definition.chunk}`;
      registeredModules.set(key, definition);
    }
  },
  location: { href: 'http://dsh.invalid/' }
};

await import(`file://${clientPath}`);

const captured = registeredModules.get('@local/remote-host');
if (captured === undefined) throw new Error('client.js did not register a module');
if (captured.id !== '@local/remote-host') throw new Error(`unexpected module id: ${captured.id}`);

const requireStub = (spec) => {
  if (spec === 'react') return ReactShim;
  throw new Error(`unexpected require("${spec}") from the client bundle`);
};
requireStub.async = async (spec) => {
  if (!spec.startsWith('./')) throw new Error(`unexpected require.async("${spec}")`);
  const fileName = spec.slice(2);
  const id = `@local/remote-host/${fileName}`;
  if (!registeredModules.has(id)) {
    const chunkPath = pluginPath(fileName);
    await import(`file://${chunkPath}`);
  }
  const definition = registeredModules.get(id);
  if (definition === undefined) throw new Error(`chunk ${fileName} did not register as ${id}`);
  return definition.factory(requireStub);
};

const mod = captured.factory(requireStub);
if (typeof mod.apply !== 'function') throw new Error('client factory did not return apply()');

/* ------------------------------------------------------------------ */
/* Fake client ctx                                                     */
/* ------------------------------------------------------------------ */
const registered = [];
const services = {
  react: ReactShim,
  connection: { rpc: { call: async () => ({}) } },
  layout: { navigate: () => {} },
  locale: { id: 'zh' },
  slots: null
};

const ctx = {
  get(name) {
    return services[name];
  },
  effect(fn) {
    fn();
    return () => {};
  },
  on() {
    return () => {};
  },
  slots: {
    inject(_slot, callback) {
      callback();
      return () => {};
    },
    register(options, component) {
      registered.push({ options, component });
      return () => {};
    }
  }
};
services.slots = ctx.slots;

await mod.apply(ctx);

if (registered.length < 3) throw new Error(`expected at least 3 slot registrations, got ${registered.length}`);

/** Collect element handlers so the smoke test can drive real interactions. */
function collectHandlers(node, out) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) collectHandlers(child, out);
    return out;
  }
  const props = node.props ?? {};
  for (const key of ['onClick', 'onChange', 'onDrop', 'onDragStart', 'onKeyDown']) {
    if (typeof props[key] === 'function') out.push({ key, fn: props[key], node });
  }
  collectHandlers(node.children, out);
  return out;
}

/** Concatenate the text children of one rendered element. */
function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node !== 'object') return '';
  return textOf(node.children);
}

const OVERLAY_ICONS = ['📋', 'ℹ', '⇄', '⑂', '📂', '🔍', '🗂', '★', '⌘', '📁'];

const eventStub = {
  preventDefault() {},
  stopPropagation() {},
  key: 'Enter',
  target: { value: '/var/www', files: [], checked: true, style: {} },
  currentTarget: {},
  dataTransfer: {
    files: [],
    types: [],
    getData: () => '',
    setData() {},
    dropEffect: 'none',
    effectAllowed: 'none'
  }
};

/* ------------------------------------------------------------------ */
/* Render every registered component                                   */
/* ------------------------------------------------------------------ */
const t = (key) => String(key);
const now = Date.now();
const fakeConnection = {
  id: 'conn-1', name: 'web-01', username: 'root', host: '10.0.0.1', port: 22,
  authType: 'password', group: 'prod', hasSecret: true, lastPath: '/var/www', lastUsedAt: now, createdAt: now
};
const fakeEntries = [
  { name: 'app.js', type: 'file', size: 2048, mode: 0o644, mtime: now },
  { name: 'logs', type: 'dir', size: 0, mode: 0o755, mtime: now },
  { name: 'config.php.bak', type: 'file', size: 512, mode: 0o600, mtime: now },
  { name: 'link', type: 'link', size: 12, mode: 0o777, mtime: now }
];
const call = async (endpoint) => {
  switch (endpoint) {
    case 'connections.list': return { connections: [fakeConnection] };
    case 'session.status': return { active: ['conn-1'], health: [{ id: 'conn-1', healthy: true }] };
    case 'workspace.get': return { default: { connectionId: 'conn-1', connectionName: 'web-01', path: '/var/www' }, sessions: [] };
    case 'fs.list': return { path: '/var/www', entries: fakeEntries };
    case 'audit.list': return { entries: [] };
    case 'tunnel.list': return { tunnels: [] };
    case 'binding.get': return { binding: null };
    case 'git.info': return { isRepo: true, branch: 'main', changes: 2, files: ['M app.js', '?? new.txt'], lastCommit: 'abc123 init' };
    case 'sys.info': return { kernel: 'Linux 5.15', user: 'root', disk: '/dev/vda1 40G', uptime: 'up 3 days', cpu: '4' };
    default: return {};
  }
};

const props = {
  size: 20,
  active: false,
  sessionId: 'session-smoke',
  call,
  t,
  workspaceUi: { openSession: () => {}, startSession: () => {} }
};

for (const entry of registered) {
  const name = entry.options?.name ?? '(unknown slot)';
  const id = entry.options?.id ?? '(no id)';
  if (typeof entry.component !== 'function') {
    throw new Error(`slot ${name}/${id} did not register a function component`);
  }
  instanceStates.clear();
  let lastTree = null;
  let sawModal = 0;
  let stats = { components: 0, elements: 0, text: 0, modals: 0 };
  for (let round = 0; round < 4; round += 1) {
    instanceCounter = 0;
    pendingEffects = [];
    stats = { components: 0, elements: 0, text: 0, modals: 0 };
    try {
      lastTree = renderNode(entry.component({ ...props }), 0, stats);
    } catch (error) {
      console.error(error.stack);
      throw new Error(`rendering slot ${name}/${id} (round ${round}) failed: ${error.message}`);
    }
    for (const effect of pendingEffects) {
      const cleanup = effect();
      if (typeof cleanup === 'function') cleanup();
    }
    await new Promise((resolve) => setTimeout(resolve, 5));

    // open every overlay on purpose, so the shared Modal shell is exercised
    const allHandlers = collectHandlers(lastTree, []);
    for (const handler of allHandlers) {
      const label = textOf(handler.node);
      if (OVERLAY_ICONS.some((icon) => label.startsWith(icon))) {
        try {
          const result = handler.fn(eventStub);
          if (result !== null && typeof result?.then === 'function') await result;
        } catch (error) {
          throw new Error(`overlay opener "${label}" threw: ${error.message}`);
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5));

    // drive one round of interactions to reach deeper JSX branches
    const handlers = allHandlers.slice(0, 24);
    if (process.env.SMOKE_DEBUG === '1') console.log(`    round ${round}: ${handlers.length} handlers, modals so far ${stats.modals}`);
    for (const handler of handlers) {
      try {
        const result = handler.fn(eventStub);
        if (result !== null && typeof result?.then === 'function') await result;
      } catch (error) {
        throw new Error(`handler ${handler.key} threw during round ${round}: ${error.message}`);
      }
    }
    sawModal = Math.max(sawModal, stats.modals);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  console.log(`  ✓ ${name} · ${id} → ${stats.components} components, ${stats.elements} elements, ${sawModal} overlay(s) opened`);
  if (name === 'main' && sawModal === 0) {
    throw new Error('no overlay ever opened — modal routes are dead');
  }
}

console.log(`CLIENT SMOKE PASS (${registered.length} slots rendered)`);
