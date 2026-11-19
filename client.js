window.__ModuleLoader__.load({
  id: '@local/remote-host',
  factory(require) {
    const React = require('react');
    const { useState, useEffect, useCallback, useMemo, useRef } = React;
    const h = React.createElement;

    /* ------------------------------------------------------------------ */
    /* 语言与文案                                                          */
    /* ------------------------------------------------------------------ */

    let DICTS = { zh: {}, en: {} };

    function makeT(locale) {
      return (key) => {
        const id = locale?.getLocale?.().id ?? '';
        const dict = DICTS[id.startsWith('en') ? 'en' : 'zh'];
        return dict[key] ?? key;
      };
    }

    /** Map common English transport/SSH errors onto Chinese explanations. */
    const ERROR_ZH = [
      [/all authentication methods failed/i, '认证失败：用户名或密码/密钥不正确'],
      [/authentication/i, '认证失败：用户名或密码/密钥不正确'],
      [/econnrefused/i, '连接被拒绝：目标端口没有监听或被防火墙拦截'],
      [/enotfound|getaddrinfo/i, '无法解析主机名：请检查主机地址'],
      [/etimedout|timed out|timeout/i, '连接超时：主机不可达或端口错误'],
      [/econnreset|socket.*closed/i, '连接被重置：远程主机关闭了连接'],
      [/host key verification failed/i, '主机密钥验证失败'],
      [/encrypted private key/i, '私钥已加密：请填写私钥口令'],
      [/cannot parse privatekey|unsupported key format/i, '私钥格式不受支持：请使用 PEM/OpenSSH 格式'],
      [/keepalive/i, '连接超时断开：请重新连接'],
      [/permission denied/i, '权限不足：远程拒绝访问'],
      [/no such file/i, '远程文件或目录不存在'],
      [/failure/i, '远程操作失败']
    ];
    function friendlyError(error) {
      const endpoint = error?.details?.endpoint;
      const prefix = typeof endpoint === 'string' && endpoint !== '' ? `[${endpoint}] ` : '';
      const message = error instanceof Error ? error.message : String(error);
      for (const [pattern, text] of ERROR_ZH) {
        if (pattern.test(message)) return `${prefix}${text}（原始信息：${message}）`;
      }
      return `${prefix}${message}`;
    }

    /* ------------------------------------------------------------------ */
    /* 样式（仅使用主题令牌）                                              */
    /* ------------------------------------------------------------------ */

    let CSS = '';

    /* ------------------------------------------------------------------ */
    /* 小组件                                                              */
    /* ------------------------------------------------------------------ */

    function PanelIcon(props) {
      const size = props.size ?? 20;
      return h('button', {
        type: 'button',
        title: '远程主机',
        'aria-label': '远程主机',
        onClick: () => props.open(),
        style: {
          width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: 'none', background: 'none', cursor: 'pointer', padding: 0, borderRadius: 8,
          color: props.active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)'
        }
      }, h('svg', { viewBox: '0 0 64 64', width: size - 4, height: size - 4, 'aria-hidden': true },
        h('rect', { x: 6, y: 8, width: 52, height: 20, rx: 5, fill: 'currentColor', opacity: props.active ? 1 : 0.75 }),
        h('rect', { x: 6, y: 36, width: 52, height: 20, rx: 5, fill: 'currentColor', opacity: props.active ? 0.85 : 0.5 }),
        h('circle', { cx: 16, cy: 18, r: 3.2, fill: 'var(--dsw-alias-state-success-primary)' }),
        h('circle', { cx: 16, cy: 46, r: 3.2, fill: 'var(--dsw-alias-state-success-primary)', opacity: props.active ? 1 : 0.6 }),
        h('rect', { x: 25, y: 15.5, width: 24, height: 5, rx: 2.5, fill: 'var(--dsw-alias-bg-base)', opacity: 0.85 }),
        h('rect', { x: 25, y: 43.5, width: 24, height: 5, rx: 2.5, fill: 'var(--dsw-alias-bg-base)', opacity: 0.7 })
      ));
    }

    function Field(props) {
      return h('div', { className: 'rh-field' },
        h('label', null, props.label),
        props.options !== undefined
          ? h('select', { value: props.value, onChange: (e) => props.onChange(e.target.value) },
              props.options.map((opt) => h('option', { key: opt.value, value: opt.value }, opt.label)))
          : props.multiline
            ? h('textarea', { value: props.value ?? '', placeholder: props.placeholder, onChange: (e) => props.onChange(e.target.value) })
            : h('input', {
                type: props.type ?? 'text', value: props.value ?? '', placeholder: props.placeholder,
                onChange: (e) => props.onChange(e.target.value)
              }));
    }

    function formatSize(bytes) {
      if (bytes === undefined || bytes === null) return '';
      if (bytes < 1024) return `${bytes} B`;
      const units = ['KiB', 'MiB', 'GiB', 'TiB'];
      let value = bytes;
      let unit = 'B';
      for (const next of units) {
        if (value < 1024) break;
        value /= 1024;
        unit = next;
      }
      return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
    }

    function formatTime(ms) {
      if (!ms) return '';
      const date = new Date(ms);
      const pad = (n) => String(n).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    /** Repeated inline styles, hoisted so React can diff stable objects. */
    const S_CODE_BLOCK = {
      margin: 0, maxHeight: '42vh', overflow: 'auto',
      background: 'var(--dsw-alias-bg-layer-1)',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: 8, padding: 10, fontSize: 12,
      whiteSpace: 'pre-wrap', wordBreak: 'break-all'
    };

    const S_SCROLL_BOX = {
      maxHeight: '42vh', overflow: 'auto',
      background: 'var(--dsw-alias-bg-layer-1)',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: 8, padding: 8
    };

    const S_ROW_ACTIONS = { display: 'inline-flex', gap: 2 };

    const HL_KEYWORDS = new Set([
      'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break',
      'continue', 'class', 'extends', 'new', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'await',
      'async', 'import', 'export', 'from', 'default', 'null', 'undefined', 'true', 'false', 'this', 'super',
      'def', 'elif', 'pass', 'lambda', 'None', 'True', 'False', 'with', 'as', 'yield', 'in', 'not', 'and', 'or',
      'echo', 'fi', 'then', 'esac', 'done', 'export', 'local', 'readonly', 'sudo', 'cd', 'cat', 'grep', 'sed', 'awk'
    ]);

    /** 词法分析护栏：压缩过的文件不得卡住面板。 */
    const HL_MAX_TOKENS = 20000;
    const HL_MAX_LINE = 2000;

    /** 低成本预检：形状上不适合高亮的输入直接拒绝。 */
    function highlightCost(text) {
      if (text.length > 200000) return false;
      let lineStart = 0;
      let lines = 1;
      for (let index = 0; index < text.length; index += 1) {
        if (text.charCodeAt(index) === 10) {
          if (index - lineStart > HL_MAX_LINE) return false;
          lineStart = index + 1;
          lines += 1;
          if (lines > 3000) return false;
        }
      }
      return text.length - lineStart <= HL_MAX_LINE;
    }

    /** 极简词法器：注释、字符串、数字、关键字。 */
    function tokenizeCode(text) {
      const tokens = [];
      let index = 0;
      let truncated = false;
      const push = (type, value) => {
        if (tokens.length >= HL_MAX_TOKENS) {
          truncated = true;
          return false;
        }
        tokens.push({ type, value });
        return true;
      };
      while (index < text.length) {
        if (tokens.length >= HL_MAX_TOKENS) {
          truncated = true;
          break;
        }
        const char = text[index];
        if (char === '/' && text[index + 1] === '/') {
          let end = text.indexOf('\n', index);
          if (end === -1) end = text.length;
          push('comment', text.slice(index, end));
          index = end;
          continue;
        }
        if (char === '/' && text[index + 1] === '*') {
          let end = text.indexOf('*/', index + 2);
          end = end === -1 ? text.length : end + 2;
          push('comment', text.slice(index, end));
          index = end;
          continue;
        }
        if (char === '#' && (index === 0 || text[index - 1] === '\n')) {
          let end = text.indexOf('\n', index);
          if (end === -1) end = text.length;
          push('comment', text.slice(index, end));
          index = end;
          continue;
        }
        if (char === '"' || char === "'" || char === '`') {
          let end = index + 1;
          while (end < text.length && text[end] !== char) {
            if (text[end] === '\\') end += 1;
            end += 1;
          }
          end = Math.min(end + 1, text.length);
          push('string', text.slice(index, end));
          index = end;
          continue;
        }
        if (/[0-9]/.test(char)) {
          let end = index;
          while (end < text.length && /[0-9a-fA-FxX._]/.test(text[end])) end += 1;
          push('number', text.slice(index, end));
          index = end;
          continue;
        }
        if (/[A-Za-z_$]/.test(char)) {
          let end = index;
          while (end < text.length && /[A-Za-z0-9_$-]/.test(text[end])) end += 1;
          const word = text.slice(index, end);
          push(HL_KEYWORDS.has(word) ? 'keyword' : 'plain', word);
          index = end;
          continue;
        }
        let end = index;
        while (end < text.length && !/[A-Za-z0-9_$"'`/#]/.test(text[end])) end += 1;
        if (end === index) end += 1;
        push('plain', text.slice(index, end));
        index = end;
      }
      if (truncated && index < text.length) {
        tokens.push({ type: 'plain', value: text.slice(index) });
      }
      return tokens;
    }

    const HL_CLASS = {
      comment: 'hl-comment', string: 'hl-string', number: 'hl-number', keyword: 'hl-keyword', plain: undefined
    };

    /** 编辑器缓冲的统一结构，open-by-entry 与 open-by-path 共用。 */
    function makeFileState(target, name, result) {
      const binary = result.binary === true;
      return {
        path: target,
        name,
        binary,
        mime: imageMime(name),
        content: binary ? result.base64 : result.content,
        original: binary ? '' : result.content,
        truncated: result.truncated === true,
        size: result.size,
        dirty: false
      };
    }

    const IMAGE_MIME = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon'
    };

    function imageMime(name) {
      const ext = String(name ?? '').split('.').pop()?.toLowerCase() ?? '';
      return IMAGE_MIME[ext];
    }

    function parentPath(path) {
      if (path === undefined || path === '' || path === '/') return '/';
      const trimmed = path.replace(/\/+$/, '');
      const index = trimmed.lastIndexOf('/');
      return index <= 0 ? '/' : trimmed.slice(0, index);
    }

    function joinPath(dir, name) {
      return `${dir.replace(/\/$/, '')}/${name}`;
    }

    /* ------------------------------------------------------------------ */
    /* Connection form                                                     */
    /* ------------------------------------------------------------------ */

    function ConnectionForm(props) {
      const { t, draft, onClose, onSave, onTest, jumpOptions, onResetHostKey } = props;
      const [form, setForm] = useState({
        id: draft?.id, name: draft?.name ?? '', host: draft?.host ?? '', port: draft?.port ?? 22,
        username: draft?.username ?? '', authType: draft?.authType ?? 'password',
        group: draft?.group ?? '',
        jumpId: draft?.jumpId ?? '',
        password: '', privateKey: '', passphrase: ''
      });
      const [busy, setBusy] = useState(false);
      const [result, setResult] = useState(null);
      const set = (key) => (value) => setForm((prev) => ({ ...prev, [key]: value }));

      const save = async () => {
        if (!form.host.trim() || !form.username.trim()) { setResult({ error: t('requiredName') }); return; }
        setBusy(true);
        try {
          await onSave(form);
          onClose();
        } catch (error) {
          setResult({ error: friendlyError(error) });
        } finally {
          setBusy(false);
        }
      };

      const test = async () => {
        setBusy(true);
        setResult(null);
        try {
          const outcome = await onTest(form);
          setResult({ ok: outcome.message });
        } catch (error) {
          setResult({ error: friendlyError(error) });
        } finally {
          setBusy(false);
        }
      };

      return h('div', { className: 'rh-modal', onMouseDown: (e) => { if (e.target === e.currentTarget) onClose(); } },
        h('div', { className: 'rh-form' },
          h('h3', null, draft?.id ? `${t('edit')} · ${draft.name}` : t('newConnection')),
          h(Field, { label: t('name'), value: form.name, onChange: set('name'), placeholder: 'web-01' }),
          h('div', { className: 'rh-row2' },
            h(Field, { label: t('host'), value: form.host, onChange: set('host'), placeholder: 'example.com' }),
            h(Field, { label: t('port'), value: form.port, onChange: (v) => set('port')(Number(v) || 22), type: 'number' })),
          h('div', { className: 'rh-row2' },
            h(Field, { label: t('username'), value: form.username, onChange: set('username'), placeholder: 'root' }),
            h(Field, { label: t('group'), value: form.group, onChange: set('group'), placeholder: 'prod' })),
          h(Field, {
            label: t('authType'), value: form.authType, onChange: set('authType'),
            options: [{ value: 'password', label: t('authPassword') }, { value: 'key', label: t('authKey') }]
          }),
          h(Field, {
            label: t('jumpHost'), value: form.jumpId, onChange: set('jumpId'),
            options: [{ value: '', label: t('jumpNone') }, ...(jumpOptions ?? []).map((item) => ({ value: item.id, label: item.name }))]
          }),
          form.authType === 'password'
            ? h(Field, { label: t('password'), value: form.password, onChange: set('password'), type: 'password', placeholder: draft?.hasSecret ? '••••••（留空保持不变）' : '' })
            : [
                h(Field, { key: 'key', label: t('privateKey'), value: form.privateKey, onChange: set('privateKey'), multiline: true, placeholder: draft?.hasSecret ? '-----BEGIN OPENSSH PRIVATE KEY-----（留空保持不变）' : '-----BEGIN...' }),
                h(Field, { key: 'pass', label: t('passphrase'), value: form.passphrase, onChange: set('passphrase'), type: 'password' })
              ],
          draft?.hostKey
            ? h('div', { className: 'rh-inline', style: { gap: 6, fontSize: 11, opacity: 0.85 } },
                h('span', { className: 'rh-dim' }, `${t('hostKey')}: `),
                h('span', { className: 'rh-mono' }, draft.hostKey),
                h('button', {
                  className: 'rh-btn', style: { fontSize: 11 },
                  title: t('resetHostKey'),
                  onClick: async () => {
                    if (onResetHostKey !== undefined) await onResetHostKey(draft.id);
                  }
                }, t('resetHostKey')))
            : h('div', { className: 'rh-dim', style: { fontSize: 11 } }, `${t('hostKey')}: ${t('hostKeyEmpty')}`),
          result?.error ? h('div', { className: 'rh-error' }, result.error) : null,
          result?.ok ? h('div', { className: 'rh-ok' }, `✓ ${result.ok}`) : null,
          h('div', { className: 'rh-actions' },
            h('button', { className: 'rh-btn', onClick: onClose }, t('cancel')),
            h('button', { className: 'rh-btn', disabled: busy, onClick: test }, busy ? t('testing') : t('test')),
            h('button', { className: 'rh-btn primary', disabled: busy, onClick: save }, t('save')))));
    }

    /** 通用弹层外壳：遮罩 + 居中卡片 + 标题。 */
    function Modal(props) {
      const { title, width, onClose, children } = props;
      return h('div', {
        className: 'rh-modal',
        onMouseDown: (e) => { if (e.target === e.currentTarget) onClose(); }
      },
        h('div', {
          className: 'rh-form',
          style: width === undefined ? undefined : { width, maxWidth: '96vw' }
        },
          title === undefined ? null : h('h3', null, title),
          children));
    }

    /* ------------------------------------------------------------------ */
    /* 远程目录选择器                                                      */
    /* ------------------------------------------------------------------ */

    function RemotePathPicker(props) {
      const { call, t, connectionId, initialPath, title, onPick, onCancel } = props;
      const [current, setCurrent] = useState(initialPath === undefined || initialPath === '' ? '/' : initialPath);
      const [input, setInput] = useState(initialPath === undefined || initialPath === '' ? '/' : initialPath);
      const [entries, setEntries] = useState([]);
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState(null);

      const load = useCallback(async (target) => {
        if (connectionId === undefined || connectionId === null || connectionId === '') {
          setError(t('noConnections'));
          return;
        }
        setLoading(true);
        setError(null);
        try {
          const result = await call('fs.list', { id: connectionId, path: target });
          setCurrent(result.path);
          setInput(result.path);
          setEntries(result.entries.filter((entry) => entry.type === 'dir'));
        } catch (e) {
          setError(friendlyError(e));
        } finally {
          setLoading(false);
        }
      }, [call, connectionId, t]);

      useEffect(() => { load(initialPath === undefined || initialPath === '' ? '/' : initialPath); }, [load, initialPath]);

      const parent = current === '/' || current === '' ? '/' : (current.replace(/\/[^/]+$/, '') || '/');

      return h('div', { className: 'rh-modal', onMouseDown: (e) => { if (e.target === e.currentTarget) onCancel(); } },
        h('style', null, CSS),
        h('div', { className: 'rh-form', style: { width: 600, maxWidth: '94vw' } },
          h('h3', null, title ?? t('pickDir')),
          h('div', { className: 'rh-inline', style: { gap: 6 } },
            h('button', { className: 'rh-btn', onClick: () => load(parent) }, `↑ ${t('up')}`),
            h('input', {
              className: 'rh-path', value: input, placeholder: t('pathPlaceholder'),
              onChange: (e) => setInput(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') load(input); }
            }),
            h('button', { className: 'rh-btn', onClick: () => load(input) }, t('go'))),
          h('div', {
            style: {
              maxHeight: '46vh', overflow: 'auto', border: '1px solid var(--dsw-alias-border-l1)',
              borderRadius: 8, padding: 4
            }
          },
            loading
              ? h('div', { className: 'rh-empty' }, t('loading'))
              : entries.length === 0
                ? h('div', { className: 'rh-empty' }, t('empty'))
                : entries.map((entry) => h('button', {
                    key: entry.name,
                    className: 'rh-tree-node',
                    style: { display: 'block', padding: '5px 8px' },
                    onDoubleClick: () => load(joinPath(current, entry.name)),
                    onClick: () => load(joinPath(current, entry.name))
                  }, `📁 ${entry.name}`))),
          h('div', { className: 'rh-dim rh-mono', style: { fontSize: 11 } }, current),
          error !== null ? h('div', { className: 'rh-error' }, error) : null,
          h('div', { className: 'rh-actions' },
            h('button', { className: 'rh-btn', onClick: onCancel }, t('cancel')),
            h('button', { className: 'rh-btn primary', disabled: loading, onClick: () => onPick(current) }, t('confirmPick')))));
    }

    /* ------------------------------------------------------------------ */
    /* 新建会话的远程工作区选项                                            */
    /* ------------------------------------------------------------------ */

    function RemoteWorkspaceOption(props) {
      const { call, t, sessionId } = props;
      const [binding, setBinding] = useState(null);
      const [open, setOpen] = useState(false);
      const [connections, setConnections] = useState([]);
      const [draft, setDraft] = useState({ connection: '', path: '/' });
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const [pickerOpen, setPickerOpen] = useState(false);
      const [warning, setWarning] = useState(null);

      const load = useCallback(async () => {
        try {
          const [bindingResult, listResult] = await Promise.all([
            call('binding.get', { sessionId }),
            call('connections.list')
          ]);
          setBinding(bindingResult.binding);
          setConnections(listResult.connections);
          return listResult.connections;
        } catch (e) {
          setError(friendlyError(e));
          return [];
        }
      }, [call, sessionId]);

      useEffect(() => { if (open) load(); }, [open, load]);

      const commit = async () => {
        if (draft.connection === '') { setError(t('noConnections')); return; }
        setBusy(true);
        setError(null);
        setWarning(null);

        // 绑定本身必须先落库：连不上主机不应该让绑定失效
        try {
          await call('binding.set', {
            sessionId,
            connection: draft.connection,
            path: draft.path === '' ? '/' : draft.path
          });
        } catch (e) {
          setError(friendlyError(e));
          setBusy(false);
          return;
        }

        // 连接是尽力而为：失败只提示，不回滚绑定
        try {
          await call('session.connect', { id: draft.connection });
        } catch (e) {
          setWarning(`${t('boundButConnectFailed')}：${friendlyError(e)}`);
        }

        try {
          setBinding((await call('binding.get', { sessionId })).binding);
        } catch {
          /* 读取绑定失败不影响已写入的结果 */
        }
        setOpen(false);
        setBusy(false);
      };

      const unbind = async () => {
        setBusy(true);
        setError(null);
        try {
          await call('binding.clear', { sessionId });
          setBinding(null);
          setOpen(false);
        } catch (e) {
          setError(friendlyError(e));
        } finally {
          setBusy(false);
        }
      };

      const label = binding === null
        ? `🌐 ${t('remoteWorkspace')}`
        : `🌐 ${binding.connectionName}:${binding.path}`;

      return h(React.Fragment, null,
        h('style', null, CSS),
        h('button', {
          type: 'button',
          className: 'rh-btn',
          title: binding === null ? t('pickRemote') : `${t('boundSession')}: ${binding.connectionName}:${binding.path}`,
          onClick: async () => {
            setOpen(true);
            const list = await load();
            if (list.length > 0) setDraft((prev) => ({ ...prev, connection: prev.connection === '' ? list[0].id : prev.connection }));
          }
        }, label),
        warning !== null
          ? h('div', {
              style: { fontSize: 11, color: 'var(--dsw-alias-state-warn-primary)', maxWidth: 320, lineHeight: 1.4 }
            }, `⚠ ${warning}`)
          : null,
        open ? h(Modal, { title: t('pickRemote'), onClose: () => setOpen(false) },
            connections.length === 0
              ? h('div', { className: 'rh-note' }, t('noConnections'))
              : [
                  h('div', { className: 'rh-field', key: 'conn' },
                    h('label', null, t('connections')),
                    h('select', {
                      value: draft.connection,
                      onChange: (e) => setDraft((prev) => ({ ...prev, connection: e.target.value }))
                    }, connections.map((entry) => h('option', { key: entry.id, value: entry.id }, `${entry.name} · ${entry.username}@${entry.host}`)))),
                  (() => {
                    const picked = connections.find((entry) => entry.id === draft.connection);
                    return picked !== undefined && picked.hasSecret !== true
                      ? h('div', { className: 'rh-note', style: { color: 'var(--dsw-alias-state-warn-primary)' } },
                          `${t('noSecretHint')}`)
                      : null;
                  })(),
                  h('div', { className: 'rh-field', key: 'path' },
                    h('label', null, t('pathPlaceholder')),
                    h('div', { className: 'rh-inline', style: { gap: 6 } },
                      h('input', {
                        className: 'rh-path', value: draft.path,
                        placeholder: '/www/wwwroot/site',
                        onChange: (e) => setDraft((prev) => ({ ...prev, path: e.target.value }))
                      }),
                      h('button', {
                        className: 'rh-btn', disabled: draft.connection === '',
                        onClick: () => setPickerOpen(true)
                      }, `📂 ${t('browse')}`)))
                ],
            error !== null ? h('div', { className: 'rh-error' }, error) : null,
            h('div', { className: 'rh-actions' },
              binding !== null ? h('button', { className: 'rh-btn danger', disabled: busy, onClick: unbind }, t('unbindAction')) : null,
              h('button', { className: 'rh-btn', onClick: () => setOpen(false) }, t('cancel')),
              h('button', { className: 'rh-btn primary', disabled: busy || connections.length === 0, onClick: commit },
                busy ? t('loading') : t('bindAndConnect')))) : null,
        pickerOpen ? h(RemotePathPicker, {
          call, t,
          connectionId: draft.connection,
          initialPath: draft.path === '' ? '/' : draft.path,
          title: t('pickDir'),
          onCancel: () => setPickerOpen(false),
          onPick: (picked) => { setDraft((prev) => ({ ...prev, path: picked })); setPickerOpen(false); }
        }) : null);
    }

    /* ------------------------------------------------------------------ */
    /* 主面板                                                              */
    /* ------------------------------------------------------------------ */

    function App(props) {
      const { call, t } = props;
      const [connections, setConnections] = useState([]);
      const [activeIds, setActiveIds] = useState([]);
      const [health, setHealth] = useState([]);
      const [selected, setSelected] = useState(null);
      const [path, setPath] = useState('');
      const [pathInput, setPathInput] = useState('');
      const [listing, setListing] = useState(null);
      const [file, setFile] = useState(null);
      const [draft, setDraft] = useState(null);
      const [workspace, setWorkspace] = useState(null);
      const [bindingCount, setBindingCount] = useState(0);
      const [query, setQuery] = useState('');
      const [checked, setChecked] = useState([]);
      const [terminal, setTerminal] = useState(null);
      const [chmodTarget, setChmodTarget] = useState(null);
      const [chmodValue, setChmodValue] = useState('644');
      const [editorHeight, setEditorHeight] = useState('42%');
      const [bindingsOpen, setBindingsOpen] = useState(false);
      const [bindingList, setBindingList] = useState([]);
      const [searchState, setSearchState] = useState(null);
      const [dragging, setDragging] = useState(false);
      const [openTabs, setOpenTabs] = useState([]);
      const [tabsPath, setTabsPath] = useState({});
      const [treeOpen, setTreeOpen] = useState(false);
      const [treeData, setTreeData] = useState({});
      const [auditOpen, setAuditOpen] = useState(false);
      const [auditList, setAuditList] = useState([]);
      const [sysOpen, setSysOpen] = useState(false);
      const [sysInfo, setSysInfo] = useState(null);
      const [ioOpen, setIoOpen] = useState(null);
      const [ioPass, setIoPass] = useState('');
      const [ioContent, setIoContent] = useState('');
      const [tunnelOpen, setTunnelOpen] = useState(false);
      const [tunnelList, setTunnelList] = useState([]);
      const [tunnelForm, setTunnelForm] = useState({ localPort: 0, remoteHost: '127.0.0.1', remotePort: '' });
      const [diffOpen, setDiffOpen] = useState(false);
      const importInput = useRef(null);
      const [picker, setPicker] = useState(null);
      const [highlight, setHighlight] = useState(true);
      const [suggest, setSuggest] = useState([]);
      const [gitOpen, setGitOpen] = useState(false);
      const [gitInfo, setGitInfo] = useState(null);
      const [page, setPage] = useState(0);
      const [pendingRemove, setPendingRemove] = useState(null);
      const [sshOpen, setSshOpen] = useState(false);
      const [vault, setVault] = useState({ enabled: false, locked: false });
      const [vaultPass, setVaultPass] = useState('');
      const [history, setHistory] = useState([]);
      const [progress, setProgress] = useState(null);
      const [stash, setStash] = useState([]);
      const [localFile, setLocalFile] = useState(null);
      const localInput = useRef(null);
      const [sshHosts, setSshHosts] = useState([]);
      const gutterRef = useRef(null);
      const overlayRef = useRef(null);
      const fileInput = useRef(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const [confirmId, setConfirmId] = useState(null);
      const [renaming, setRenaming] = useState(null);
      const [renameValue, setRenameValue] = useState('');
      const [creating, setCreating] = useState(null);
      const [createValue, setCreateValue] = useState('');
      const [tick, setTick] = useState(0);
      const [connectingId, setConnectingId] = useState(null);
      const confirmTimer = useRef(null);

      /** 面板动作共用的「忙碌 + 报错」漏斗。 */
      const run = useCallback(async (task) => {
        setBusy(true);
        setError(null);
        try {
          return await task();
        } catch (e) {
          setError(friendlyError(e));
          return undefined;
        } finally {
          setBusy(false);
        }
      }, []);

      const refreshConnections = useCallback(async () => {
        try {
          const [list, status] = await Promise.all([call('connections.list'), call('session.status')]);
          setConnections(list.connections);
          setActiveIds(status.active ?? []);
          setHealth(status.health ?? []);
          setVault(await call('vault.status').catch(() => ({ enabled: false, locked: false })));
        } catch (e) { setError(friendlyError(e)); }
      }, [call]);

      useEffect(() => {
        refreshConnections();
        call('workspace.get')
          .then((result) => {
            setWorkspace(result.default);
            setBindingCount((result.sessions ?? []).length);
          })
          .catch(() => {});
      }, [refreshConnections, call, tick]);
      useEffect(() => () => clearTimeout(confirmTimer.current), []);

      const openDirectory = useCallback(async (connectionId, target) => {
        setBusy(true);
        setError(null);
        try {
          const result = await call('fs.list', { id: connectionId, path: target });
          setListing(result);
          setPath(result.path);
          setPathInput(result.path);
          setTabsPath((prev) => ({ ...prev, [connectionId]: result.path }));
          setPage(0);
          setChecked([]);
        } catch (e) {
          setError(friendlyError(e));
        } finally {
          setBusy(false);
        }
      }, [call]);

      const connect = useCallback(async (connection) => {
        setError(null);
        setConnectingId(connection.id);
        try {
          await call('session.connect', { id: connection.id });
          setSelected(connection.id);
          setOpenTabs((prev) => (prev.some((tab) => tab.id === connection.id) ? prev : [...prev, { id: connection.id, name: connection.name }]));
          await refreshConnections();
          await openDirectory(connection.id, tabsPath[connection.id] ?? connection.lastPath ?? '.');
          setTreeData({});
        } catch (e) {
          setError(friendlyError(e));
        } finally {
          setConnectingId(null);
        }
      }, [call, refreshConnections, openDirectory, tabsPath]);

      /** 暂存当前脏缓冲，使切换导航永不丢编辑。 */
      const parkBuffer = () => {
        if (file === null || file.dirty !== true) return;
        setStash((prev) => {
          const rest = prev.filter((item) => item.path !== file.path);
          return [{ path: file.path, name: file.name, content: file.content, original: file.original }, ...rest].slice(0, 8);
        });
      };

      const unlockVault = useCallback(async () => {
        await run(async () => {
          await call('vault.unlock', { passphrase: vaultPass });
          setVaultPass('');
          setVault(await call('vault.status'));
          await refreshConnections();
        });
      }, [run, call, vaultPass, refreshConnections]);

      const toggleVault = useCallback(async () => {
        await run(async () => {
          if (vault.enabled) await call('vault.disable', { passphrase: vaultPass });
          else await call('vault.enable', { passphrase: vaultPass });
          setVaultPass('');
          setVault(await call('vault.status'));
          await refreshConnections();
        });
      }, [run, call, vault, vaultPass, refreshConnections]);

      const lockVaultNow = useCallback(async () => {
        await run(async () => {
          setVault(await call('vault.lock'));
        });
      }, [run, call]);

      const guardDirty = () => {
        if (file !== null && file.dirty === true) parkBuffer();
        return true;
      };

      const restoreStashed = (entry) => {
        parkBuffer();
        setFile({
          path: entry.path, name: entry.name, binary: false, mime: imageMime(entry.name),
          content: entry.content, original: entry.original ?? '', truncated: false,
          size: entry.content.length, dirty: true
        });
        setStash((prev) => prev.filter((item) => item.path !== entry.path));
      };

      const openFile = useCallback(async (entry) => {
        if (selected === null) return;
        const target = joinPath(path, entry.name);
        setBusy(true);
        setError(null);
        try {
          const result = await call('fs.read', { id: selected, path: target });
          setFile(makeFileState(target, entry.name, result));
        } catch (e) {
          setError(friendlyError(e));
        } finally {
          setBusy(false);
        }
      }, [call, selected, path]);

      const saveFile = useCallback(async (skipConfirm = false) => {
        if (file === null || file.binary) return;
        if (skipConfirm !== true) {
          setDiffOpen(true);
          return;
        }
        setBusy(true);
        setError(null);
        try {
          await call('fs.write', { id: selected, path: file.path, content: file.content });
          setFile((prev) => ({ ...prev, dirty: false, original: prev.content }));
          setStash((prev) => prev.filter((item) => item !== undefined && item.path !== file.path));
          await openDirectory(selected, path);
        } catch (e) {
          setError(friendlyError(e));
        } finally {
          setBusy(false);
        }
      }, [call, selected, file, path, openDirectory]);

      const doRemove = useCallback(async (entry) => {
        if (selected === null) return;
        setBusy(true);
        setError(null);
        try {
          await call('fs.delete', { id: selected, path: joinPath(path, entry.name), recursive: true });
          if (file?.path === joinPath(path, entry.name)) setFile(null);
          await openDirectory(selected, path);
        } catch (e) {
          setError(friendlyError(e));
        } finally {
          setBusy(false);
        }
      }, [call, selected, path, file, openDirectory]);

      const requestRemove = useCallback((entry) => {
        if (pendingRemove === entry.name) {
          setPendingRemove(null);
          void doRemove(entry);
          return;
        }
        setPendingRemove(entry.name);
        setTimeout(() => setPendingRemove((prev) => (prev === entry.name ? null : prev)), 3000);
      }, [pendingRemove, doRemove]);


      const doRename = useCallback(async (entry, nextName) => {
        if (selected === null || !nextName) return;
        setBusy(true);
        setError(null);
        try {
          await call('fs.rename', { id: selected, from: joinPath(path, entry.name), to: joinPath(path, nextName) });
          setRenaming(null);
          await openDirectory(selected, path);
        } catch (e) {
          setError(friendlyError(e));
        } finally {
          setBusy(false);
        }
      }, [call, selected, path, openDirectory]);

      const doCreate = useCallback(async (kind, name) => {
        if (selected === null || !name) return;
        setBusy(true);
        setError(null);
        try {
          const target = joinPath(path, name);
          if (kind === 'folder') await call('fs.mkdir', { id: selected, path: target });
          else await call('fs.write', { id: selected, path: target, content: '' });
          setCreating(null);
          await openDirectory(selected, path);
        } catch (e) {
          setError(friendlyError(e));
        } finally {
          setBusy(false);
        }
      }, [call, selected, path, openDirectory]);

      const saveConnection = useCallback(async (form) => {
        await call('connections.save', form);
        await refreshConnections();
      }, [call, refreshConnections]);

      const removeConnection = useCallback(async (id) => {
        try {
          await call('connections.delete', { id });
          if (selected === id) { setSelected(null); setListing(null); setFile(null); }
          await refreshConnections();
        } catch (e) { setError(friendlyError(e)); }
      }, [call, selected, refreshConnections]);

      const setDefaultWorkspace = useCallback(() => {
        if (selected === null) return;
        setPicker({ mode: 'workspace', initial: path === '' ? '/' : path });
      }, [selected, path]);

      const commitWorkspace = useCallback(async (picked) => {
        if (selected === null) return;
        setBusy(true);
        setError(null);
        try {
          const result = await call('workspace.setDefault', { connection: selected, path: picked });
          setWorkspace(result.default);
        } catch (e) {
          setError(friendlyError(e));
        } finally {
          setBusy(false);
        }
      }, [call, selected]);

      const clearDefaultWorkspace = useCallback(async () => {
        setError(null);
        try {
          await call('workspace.clearDefault');
          setWorkspace(null);
        } catch (e) {
          setError(friendlyError(e));
        }
      }, [call]);

      const disconnect = useCallback(async () => {
        if (selected === null) return;
        try {
          await call('session.disconnect', { id: selected });
          setActiveIds((prev) => prev.filter((id) => id !== selected));
        } catch (e) { setError(friendlyError(e)); }
      }, [call, selected]);

      const toggleChecked = (name) => setChecked((prev) => (prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name]));

      const selectAll = () => {
        const names = pageRows.map((entry) => entry.name);
        setChecked((prev) => (names.length > 0 && names.every((name) => prev.includes(name)) ? [] : names));
      };

      const removeChecked = useCallback(async () => {
        if (selected === null || checked.length === 0) return;
        await run(async () => {
          for (const name of checked) {
            await call('fs.delete', { id: selected, path: joinPath(path, name), recursive: true });
          }
          setChecked([]);
          await openDirectory(selected, path);
        });
      }, [run, call, selected, checked, path, openDirectory]);

      const applyChmod = useCallback(async () => {
        if (selected === null || chmodTarget === null) return;
        await run(async () => {
          await call('fs.chmod', { id: selected, path: chmodTarget.path, mode: chmodValue });
          setChmodTarget(null);
          await openDirectory(selected, path);
        });
      }, [run, call, selected, chmodTarget, chmodValue, path, openDirectory]);

      const pushHistory = useCallback((command) => {
        const entry = String(command ?? '').trim();
        if (entry === '') return;
        try {
          const raw = window.localStorage.getItem('remote-host:cmd-history');
          const previous = raw === null ? [] : JSON.parse(raw);
          const next = [entry, ...previous.filter((item) => item !== entry)].slice(0, 40);
          window.localStorage.setItem('remote-host:cmd-history', JSON.stringify(next));
          setHistory(next);
        } catch {
          /* storage unavailable: history is a convenience, not a requirement */
        }
      }, []);

      const runCommand = useCallback(async () => {
        if (selected === null || terminal === null) return;
        const command = String(terminal.command ?? '').trim();
        if (command === '') return;
        pushHistory(command);
        setTerminal((prev) => ({ ...prev, running: true, output: '' }));
        try {
          const result = await call('exec.run', { id: selected, command, cwd: path });
          const text = `${result.stdout ?? ''}${result.stderr ? `\n[stderr]\n${result.stderr}` : ''}\n[exit ${result.exitCode}${result.timedOut ? ' timeout' : ''}]`;
          setTerminal((prev) => ({ ...prev, running: false, output: text }));
        } catch (e) {
          setTerminal((prev) => ({ ...prev, running: false, output: friendlyError(e) }));
        }
      }, [call, selected, terminal, path, pushHistory]);

      const downloadFile = useCallback(async (entry) => {
        if (selected === null) return;
        setBusy(true);
        setError(null);
        try {
          const result = await call('fs.download', { id: selected, path: joinPath(path, entry.name) });
          const binary = atob(result.base64);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
          const url = URL.createObjectURL(new Blob([bytes]));
          const link = document.createElement('a');
          link.href = url;
          link.download = result.name;
          link.click();
          URL.revokeObjectURL(url);
        } catch (e) {
          setError(friendlyError(e));
        } finally {
          setBusy(false);
        }
      }, [call, selected, path]);

      const uploadFileList = useCallback(async (files) => {
        if (selected === null || files.length === 0) return;
        setBusy(true);
        setError(null);
        /** 大文件走 4MB 切片，内存占用保持平稳。 */
        const CHUNK = 4 * 1024 * 1024;
        try {
          for (const file of files) {
            if (file.size !== undefined && file.size > CHUNK) {
              const target = joinPath(path, file.name);
              let offset = 0;
              setProgress({ name: file.name, done: 0, total: file.size });
              while (offset < file.size) {
                const slice = file.slice(offset, Math.min(offset + CHUNK, file.size));
                const base64 = await new Promise((resolve, reject) => {
                  const reader = new FileReader();
                  reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
                  reader.onerror = () => reject(new Error('读取本地文件失败'));
                  reader.readAsDataURL(slice);
                });
                await call('fs.uploadChunk', { id: selected, path: target, base64, offset, truncate: offset === 0 });
                offset += CHUNK;
                setProgress({ name: file.name, done: Math.min(offset, file.size), total: file.size });
              }
              setProgress(null);
              continue;
            }
            const base64 = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result ?? '').split(',')[1] ?? '');
              reader.onerror = () => reject(new Error('读取本地文件失败'));
              reader.readAsDataURL(file);
            });
            await call('fs.upload', { id: selected, path: joinPath(path, file.name), base64 });
          }
          await openDirectory(selected, path);
        } catch (e) {
          setError(friendlyError(e));
        } finally {
          setBusy(false);
        }
      }, [call, selected, path, openDirectory]);

      const uploadFiles = useCallback(async (event) => {
        const files = Array.from(event.target.files ?? []);
        event.target.value = '';
        await uploadFileList(files);
      }, [uploadFileList]);

      const openByPath = useCallback(async (target) => {
        if (selected === null) return;
        if (!guardDirty()) return;
        setBusy(true);
        setError(null);
        try {
          const name = String(target).split('/').pop() ?? '';
          const result = await call('fs.read', { id: selected, path: target });
          setFile(makeFileState(target, name, result));
        } catch (e) {
          setError(friendlyError(e));
        } finally {
          setBusy(false);
        }
      }, [call, selected, guardDirty]);

      const restoreBackup = useCallback(async (entry) => {
        if (selected === null) return;
        await run(async () => {
          await call('fs.rename', {
            id: selected,
            from: joinPath(path, entry.name),
            to: joinPath(path, entry.name.replace(/\.bak$/, ''))
          });
          await openDirectory(selected, path);
        });
      }, [run, call, selected, path, openDirectory]);

      const openBindings = useCallback(async () => {
        setBindingsOpen(true);
        try {
          const result = await call('workspace.get');
          setBindingList(result.sessions ?? []);
        } catch (e) {
          setError(friendlyError(e));
        }
      }, [call]);

      const dropBinding = useCallback(async (sessionId) => {
        try {
          await call('binding.clear', { sessionId });
          setBindingList((prev) => prev.filter((item) => item.sessionId !== sessionId));
          setBindingCount((prev) => Math.max(0, prev - 1));
        } catch (e) {
          setError(friendlyError(e));
        }
      }, [call]);

      const runSearch = useCallback(async () => {
        if (selected === null || searchState === null) return;
        const pattern = String(searchState.pattern ?? '').trim();
        if (pattern === '') return;
        setSearchState((prev) => ({ ...prev, running: true, output: '' }));
        try {
          const result = await call('fs.search', { id: selected, pattern, path: (searchState.path ?? '').trim() || path });
          setSearchState((prev) => ({
            ...prev,
            running: false,
            count: result.count,
            matches: result.matches ?? [],
            output: result.count === 0 ? (result.note ?? '') : ''
          }));
        } catch (e) {
          setSearchState((prev) => ({ ...prev, running: false, output: friendlyError(e) }));
        }
      }, [call, selected, searchState, path]);

      const closeTab = useCallback((id) => {
        setOpenTabs((prev) => {
          const next = prev.filter((tab) => tab.id !== id);
          if (selected === id) {
            if (next.length > 0) {
              void connect({ id: next[next.length - 1].id, name: next[next.length - 1].name, lastPath: tabsPath[next[next.length - 1].id] });
            } else {
              setSelected(null);
              setListing(null);
              setFile(null);
            }
          }
          return next;
        });
      }, [selected, connect, tabsPath]);

      const loadTree = useCallback(async (targetPath) => {
        if (selected === null) return;
        setTreeData((prev) => ({ ...prev, [targetPath]: { ...(prev[targetPath] ?? {}), loading: true } }));
        try {
          const result = await call('fs.list', { id: selected, path: targetPath });
          setTreeData((prev) => ({
            ...prev,
            [targetPath]: {
              children: result.entries.filter((entry) => entry.type === 'dir'),
              loading: false,
              expanded: true
            }
          }));
        } catch (e) {
          setTreeData((prev) => ({ ...prev, [targetPath]: { error: friendlyError(e), loading: false } }));
        }
      }, [call, selected]);

      const openAudit = useCallback(async () => {
        setAuditOpen(true);
        try {
          const result = await call('audit.list', { limit: 200 });
          setAuditList(result.entries ?? []);
        } catch (e) {
          setError(friendlyError(e));
        }
      }, [call]);

      const openSys = useCallback(async () => {
        if (selected === null) return;
        setSysOpen(true);
        setSysInfo(null);
        try {
          setSysInfo(await call('sys.info', { id: selected }));
        } catch (e) {
          setError(friendlyError(e));
        }
      }, [call, selected]);

      const exportConnections = useCallback(async () => {
        if (ioPass.length < 6) { setError(t('passphraseForFile')); return; }
        try {
          const result = await call('connections.export', { passphrase: ioPass });
          const url = URL.createObjectURL(new Blob([result.content], { type: 'application/json' }));
          const link = document.createElement('a');
          link.href = url;
          link.download = result.filename;
          link.click();
          URL.revokeObjectURL(url);
          setIoOpen(null);
          setIoPass('');
        } catch (e) {
          setError(friendlyError(e));
        }
      }, [call, ioPass, t]);

      const importConnections = useCallback(async () => {
        if (ioPass.length < 6) { setError(t('passphraseForFile')); return; }
        try {
          const result = await call('connections.import', { passphrase: ioPass, content: ioContent });
          setIoOpen(null);
          setIoPass('');
          setIoContent('');
          await refreshConnections();
          setError(null);
          return result.imported;
        } catch (e) {
          setError(friendlyError(e));
        }
      }, [call, ioPass, ioContent, refreshConnections, t]);

      const openTunnels = useCallback(async () => {
        setTunnelOpen(true);
        try {
          const result = await call('tunnel.list');
          setTunnelList(result.tunnels ?? []);
        } catch (e) {
          setError(friendlyError(e));
        }
      }, [call]);

      const createTunnel = useCallback(async () => {
        if (selected === null) return;
        await run(async () => {
          const result = await call('tunnel.open', {
            id: selected,
            localPort: Number(tunnelForm.localPort) || 0,
            remoteHost: tunnelForm.remoteHost,
            remotePort: Number(tunnelForm.remotePort)
          });
          setTunnelList(result.tunnels ?? []);
        });
      }, [run, call, selected, tunnelForm]);

      const destroyTunnel = useCallback(async (key) => {
        await run(async () => {
          const result = await call('tunnel.close', { key });
          setTunnelList(result.tunnels ?? []);
        });
      }, [run, call]);

      const TreeNode = ({ nodePath, label, depth }) => {
        const node = treeData[nodePath];
        const expanded = node?.expanded === true;
        return h('div', null,
          h('button', {
            className: 'rh-tree-node',
            style: { paddingLeft: 4 + depth * 12 },
            draggable: true,
            onDragStart: (event) => {
              event.dataTransfer.setData('text/rh-path', nodePath);
              event.dataTransfer.effectAllowed = 'move';
            },
            onDragOver: (event) => {
              if (event.dataTransfer.types.includes('text/rh-path')) {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
              }
            },
            onDrop: async (event) => {
              event.preventDefault();
              event.stopPropagation();
              const source = event.dataTransfer.getData('text/rh-path');
              if (source !== '') await moveInto(source, nodePath);
            },
            onClick: () => {
              if (expanded) setTreeData((prev) => ({ ...prev, [nodePath]: { ...prev[nodePath], expanded: false } }));
              else if (node?.children !== undefined) setTreeData((prev) => ({ ...prev, [nodePath]: { ...prev[nodePath], expanded: true } }));
              else loadTree(nodePath);
            }
          }, `${expanded ? '▾' : '▸'} ${label}`),
          expanded && node?.children !== undefined
            ? h('div', null, node.children.map((child) => h(TreeNode, {
                key: child.name,
                nodePath: joinPath(nodePath, child.name),
                label: child.name,
                depth: depth + 1
              })))
            : null,
          node?.error !== undefined ? h('div', { className: 'rh-dim', style: { paddingLeft: 16, fontSize: 11 } }, node.error) : null);
      };

      const updateSuggest = useCallback(async (value) => {
        if (selected === null || value === '' || value === '/') {
          setSuggest([]);
          return;
        }
        const cut = value.lastIndexOf('/');
        const dir = cut <= 0 ? '/' : value.slice(0, cut);
        const prefix = cut === -1 ? value : value.slice(cut + 1);
        try {
          const result = await call('fs.list', { id: selected, path: dir });
          const options = result.entries
            .filter((entry) => entry.type === 'dir' && entry.name.toLowerCase().startsWith(prefix.toLowerCase()))
            .slice(0, 8)
            .map((entry) => joinPath(dir === '' ? '/' : dir, entry.name));
          setSuggest(options);
        } catch {
          setSuggest([]);
        }
      }, [call, selected]);

      const openGit = useCallback(async () => {
        if (selected === null) return;
        setGitOpen(true);
        setGitInfo(null);
        try {
          setGitInfo(await call('git.info', { id: selected, path }));
        } catch (e) {
          setError(friendlyError(e));
        }
      }, [call, selected, path]);

      const moveInto = useCallback(async (source, targetDir) => {
        if (selected === null) return;
        const name = String(source).split('/').filter(Boolean).pop();
        if (name === undefined || name === '' || source === '') return;
        const destination = joinPath(targetDir, name);
        if (destination === source) return;
        setBusy(true);
        setError(null);
        try {
          await call('fs.rename', { id: selected, from: source, to: destination });
          await openDirectory(selected, path);
          setTreeData({});
        } catch (e) {
          setError(friendlyError(e));
        } finally {
          setBusy(false);
        }
      }, [call, selected, path, openDirectory]);

      const healthMap = {};
      for (const item of health) healthMap[item.id] = item.healthy;

      const PAGE_SIZE = 200;
      const pageRows = listing === null
        ? []
        : listing.entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
      const totalPages = listing === null ? 1 : Math.max(1, Math.ceil(listing.entries.length / PAGE_SIZE));

      const visibleConnections = query === ''
        ? connections
        : connections.filter((entry) => `${entry.name} ${entry.username} ${entry.host} ${entry.group ?? ''}`.toLowerCase().includes(query.toLowerCase()));

      const editorLineNumbers = useMemo(() => {
        if (file === null) return '';
        const count = String(file.content ?? '').split('\n').length;
        return Array.from({ length: count }, (_, index) => index + 1).join('\n');
      }, [file]);

      const showHighlight = useMemo(() => {
        if (file === null || file.binary === true || file.truncated === true) return false;
        if (highlight !== true) return false;
        return highlightCost(String(file.content ?? ''));
      }, [file, highlight]);

      const highlightedNodes = useMemo(() => {
        if (!showHighlight || file === null) return null;
        return tokenizeCode(String(file.content ?? '')).map((token, index) =>
          h('span', { key: index, className: HL_CLASS[token.type] }, token.value));
      }, [showHighlight, file]);

      const isActive = selected !== null && activeIds.includes(selected);
      const active = connections.find((entry) => entry.id === selected) ?? null;

      return h('div', { className: 'rh-app' },
        h('style', null, CSS),
        h('header', { className: 'rh-header' },
          h('h2', null, t('panelTitle')),
          h('span', { className: 'rh-sub' }, t('panelHint')),
          h('div', { style: { flex: 1 } }),
          active !== null ? h('span', { className: 'rh-inline' },
            h('span', { className: `rh-dot ${healthMap[selected] === false ? 'err' : isActive ? 'on' : ''}` }),
            h('span', { className: 'rh-dim' }, `${active.name} · ${active.username}@${active.host}`),
            h('button', { className: 'rh-btn', onClick: disconnect }, t('disconnect'))) : null),
        error !== null
          ? h('div', { className: 'rh-error', style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('span', { style: { flex: 1 } }, error),
              h('button', { className: 'rh-iconbtn', title: t('close'), onClick: () => setError(null) }, '✕'))
          : null,
        openTabs.length > 1
          ? h('div', { className: 'rh-tabs' },
              openTabs.map((tab) => h('span', { key: tab.id, className: `rh-tab ${selected === tab.id ? 'sel' : ''}` },
                h('span', {
                  style: { cursor: 'pointer' },
                  onClick: () => { if (tab.id !== selected && guardDirty()) connect({ id: tab.id, name: tab.name, lastPath: tabsPath[tab.id] }); }
                }, tab.name),
                h('span', {
                  style: { marginLeft: 6, opacity: 0.6, cursor: 'pointer' },
                  title: t('closeTab'),
                  onClick: () => closeTab(tab.id)
                }, '✕'))))
          : null,
        vault.enabled && vault.locked
          ? h('div', {
              key: 'vault-lock',
              className: 'rh-inline',
              style: {
                padding: '8px 12px', gap: 8, flexWrap: 'wrap',
                borderBottom: '1px solid var(--dsw-alias-border-l1)',
                background: 'var(--dsw-alias-bg-layer-1)'
              }
            },
              h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-state-warn-primary)' } }, t('vaultLocked')),
              h('input', {
                className: 'rh-path', type: 'password', value: vaultPass,
                placeholder: t('vaultPassphrase'),
                style: { width: 220 },
                onChange: (e) => setVaultPass(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') unlockVault(); }
              }),
              h('button', { className: 'rh-btn primary', onClick: unlockVault }, t('unlock')))
          : null,
        h('div', { className: 'rh-body' },
          h('aside', { className: 'rh-aside' },
            h('div', { className: 'rh-aside-head' },
              h('span', null, t('connections')),
              h('button', { className: 'rh-btn', onClick: () => setDraft({}) }, `+ ${t('newConnection')}`)),
            h('div', { style: { padding: '0 8px 6px' } },
              h('input', {
                className: 'rh-path', value: query, placeholder: t('searchConnections'),
                onChange: (e) => setQuery(e.target.value)
              })),
            h('div', { className: 'rh-conn-list' },
              visibleConnections.map((connection) => h('div', { key: connection.id, style: { position: 'relative' } },
                h('button', {
                  className: `rh-conn ${selected === connection.id ? 'sel' : ''}`,
                  onClick: () => { if (guardDirty()) connect(connection); },
                  title: `${connection.username}@${connection.host}:${connection.port}`
                },
                  h('span', {
                    className: `rh-dot ${healthMap[connection.id] === false ? 'err' : activeIds.includes(connection.id) ? 'on' : ''}`
                  }),
                  h('span', { style: { flex: 1, minWidth: 0 } },
                    h('span', { className: 'rh-name', style: { display: 'block' } }, connection.name),
                    h('span', { className: 'rh-host', style: { display: 'block' } }, `${connection.username}@${connection.host}`),
                    connection.group
                      ? h('span', { style: { display: 'block', fontSize: 10, color: 'var(--dsw-alias-brand-primary)' } }, `#${connection.group}`)
                      : null,
                    connection.hostKey
                      ? h('span', {
                          className: 'rh-mono',
                          title: `${t('hostKey')}: ${connection.hostKey}`,
                          style: { display: 'block', fontSize: 9, color: 'var(--dsw-alias-label-secondary)', opacity: 0.75 }
                        }, connection.hostKey.slice(0, 20) + '…')
                      : null,
                  connection.hasSecret === false
                    ? h('span', { title: '未保存密码/私钥，点右侧 ✎ 填写后再连接', style: { display: 'block', fontSize: 11, color: 'var(--dsw-alias-state-warn-primary)' } }, '未设凭据')
                    : null),
                  connectingId === connection.id ? h('span', { className: 'rh-dim' }, t('connecting')) : null),
                h('span', { style: { position: 'absolute', right: 8, top: 6, display: 'flex', gap: 2 } },
                  h('button', { className: 'rh-iconbtn', title: t('edit'), onClick: (e) => { e.stopPropagation(); setDraft(connection); } }, '✎'),
                  h('button', {
                    className: 'rh-iconbtn danger', title: t('delete'),
                    onClick: (e) => {
                      e.stopPropagation();
                      if (confirmId === connection.id) {
                        clearTimeout(confirmTimer.current);
                        setConfirmId(null);
                        removeConnection(connection.id);
                      } else {
                        setConfirmId(connection.id);
                        clearTimeout(confirmTimer.current);
                        confirmTimer.current = setTimeout(() => setConfirmId(null), 3000);
                      }
                    }
                  }, confirmId === connection.id ? t('confirmDelete') : '✕')))),
              connections.length === 0
                ? h('div', { className: 'rh-empty' }, t('newConnection'))
                : visibleConnections.length === 0
                  ? h('div', { className: 'rh-empty' }, t('noMatch'))
                  : null),
            h('div', { style: { display: 'flex', gap: 6, padding: 8, borderTop: '1px solid var(--dsw-alias-border-l1)' } },
              h('button', { className: 'rh-btn', style: { flex: 1 }, onClick: () => { setIoOpen('export'); setIoPass(''); } }, t('exportConnections')),
              h('button', { className: 'rh-btn', style: { flex: 1 }, onClick: () => { setIoOpen('import'); setIoPass(''); setIoContent(''); } }, t('importConnections'))),
            h('div', { style: { padding: '0 8px 8px' } },
              h('button', {
                className: 'rh-btn', style: { width: '100%' },
                onClick: async () => {
                  await run(async () => {
                    const result = await call('connections.importSshConfig');
                    if ((result.hosts ?? []).length === 0) { setError(t('noSshHosts')); return; }
                    setSshHosts(result.hosts);
                    setSshOpen(true);
                  });
                }
              }, t('importSsh'))),
            h('div', { style: { padding: '0 8px 8px', display: 'flex', gap: 6 } },
              h('input', {
                className: 'rh-path', type: 'password', value: vaultPass,
                placeholder: t('vaultPassphrase'),
                style: { flex: 1, minWidth: 0 },
                onChange: (e) => setVaultPass(e.target.value)
              }),
              h('button', {
                className: `rh-btn${vault.enabled ? '' : ' primary'}`,
                title: t('vaultHint'),
                onClick: toggleVault
              }, vault.enabled ? t('disableVault') : t('enableVault')),
              vault.enabled
                ? h('button', { className: 'rh-btn', onClick: lockVaultNow }, t('lockNow'))
                : null)),
          treeOpen && selected !== null
            ? h('div', { className: 'rh-tree' }, h(TreeNode, { nodePath: path === '' ? '/' : path, label: path === '' ? '/' : path, depth: 0 }))
            : null,
          h('section', { className: 'rh-main' },
            selected !== null ? [
              h('div', { className: 'rh-toolbar', key: 'toolbar' },
                h('button', { className: 'rh-btn', disabled: busy || path === '/' || path === '', onClick: () => { if (guardDirty()) openDirectory(selected, parentPath(path)); } }, `↑ ${t('up')}`),
                h('div', { style: { position: 'relative', flex: 1, minWidth: 160, display: 'flex' } },
                  h('input', {
                    className: 'rh-path', value: pathInput, placeholder: t('pathPlaceholder'),
                    style: { width: '100%' },
                    onChange: (e) => { setPathInput(e.target.value); void updateSuggest(e.target.value); },
                    onBlur: () => setTimeout(() => setSuggest([]), 150),
                    onKeyDown: (e) => {
                      if (e.key === 'Enter' && guardDirty()) { setSuggest([]); openDirectory(selected, pathInput); }
                      if (e.key === 'Escape') setSuggest([]);
                    }
                  }),
                  suggest.length > 0
                    ? h('div', {
                        style: {
                          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30, marginTop: 2,
                          background: 'var(--dsw-alias-bg-overlay)', border: '1px solid var(--dsw-alias-border-l2)',
                          borderRadius: 8, overflow: 'hidden', boxShadow: '0 6px 18px rgba(0,0,0,.18)'
                        }
                      }, suggest.map((option) => h('button', {
                        key: option, className: 'rh-tree-node', style: { display: 'block', padding: '5px 10px' },
                        onMouseDown: (event) => { event.preventDefault(); setPathInput(option); setSuggest([]); }
                      }, `📁 ${option}`)))
                    : null),
                h('button', { className: 'rh-btn', disabled: busy, onClick: () => { if (guardDirty()) openDirectory(selected, pathInput); } }, t('go')),
                h('button', { className: 'rh-btn', disabled: busy, onClick: () => { if (guardDirty()) openDirectory(selected, path); } }, t('refresh')),
                h('button', { className: 'rh-btn', disabled: busy, onClick: () => { setCreating('folder'); setCreateValue(''); } }, t('newFolder')),
                h('button', { className: 'rh-btn', disabled: busy, onClick: () => { setCreating('file'); setCreateValue(''); } }, t('newFile')),
                h('button', { className: 'rh-btn', disabled: busy, onClick: () => setTerminal({ command: '', output: '', running: false }) }, `⌘ ${t('command')}`),
                h('button', { className: 'rh-btn', disabled: busy, onClick: () => setSearchState({ pattern: '', path: '', output: '', running: false }) }, `🔍 ${t('searchRemote')}`),
                h('button', { className: 'rh-btn', onClick: () => { setTreeOpen((prev) => !prev); if (!treeOpen) loadTree(path || '/'); } }, `🗂 ${t('tree')}`),
                h('button', { className: 'rh-btn', disabled: selected === null, onClick: () => setPicker({ mode: 'navigate', initial: path === '' ? '/' : path }) }, `📂 ${t('pickDir')}`),
                h('button', { className: 'rh-btn', onClick: openAudit }, `📋 ${t('audit')}`),
                h('button', { className: 'rh-btn', disabled: selected === null, onClick: openSys }, `ℹ ${t('sysInfo')}`),
                h('button', { className: 'rh-btn', disabled: selected === null, onClick: openGit }, `⑂ ${t('git')}`),
                h('button', { className: 'rh-btn', disabled: selected === null, onClick: openTunnels }, `⇄ ${t('tunnels')}`),
                h('button', { className: 'rh-btn', disabled: busy, onClick: () => fileInput.current?.click() }, `↑ ${t('upload')}`),
                h('input', { ref: fileInput, type: 'file', multiple: true, style: { display: 'none' }, onChange: uploadFiles }),
                checked.length > 0
                  ? h('button', { className: 'rh-btn danger', disabled: busy, onClick: removeChecked }, `${t('batchDelete')} (${checked.length})`)
                  : null,
                h('button', { className: 'rh-btn', disabled: busy || selected === null, title: t('workspaceAuto'), onClick: setDefaultWorkspace }, `★ ${t('setWorkspace')}`),
                workspace !== null
                  ? h('span', { className: 'rh-inline', style: { marginLeft: 'auto', gap: 6 } },
                      h('button', { className: 'rh-btn', style: { fontSize: 11 }, title: t('boundSession'), onClick: openBindings }, `${t('workspaceDefault')}: ${workspace.connectionName}:${workspace.path}（${bindingCount} ${t('binds')}）`),
                      h('button', { className: 'rh-iconbtn', title: t('clearWorkspace'), onClick: clearDefaultWorkspace }, '✕'))
                  : null),
              h('div', {
                className: 'rh-files', key: 'files',
                onDragOver: (e) => {
                  e.preventDefault();
                  if (e.dataTransfer?.types?.includes('text/rh-path')) e.dataTransfer.dropEffect = 'move';
                  else setDragging(true);
                },
                onDragLeave: () => setDragging(false),
                onDrop: async (e) => {
                  e.preventDefault();
                  setDragging(false);
                  const files = Array.from(e.dataTransfer?.files ?? []);
                  if (files.length > 0) {
                    await uploadFileList(files);
                    return;
                  }
                  const source = e.dataTransfer?.getData('text/rh-path') ?? '';
                  if (source !== '') await moveInto(source, path);
                },
                style: dragging ? { outline: '2px dashed var(--dsw-alias-brand-primary)', outlineOffset: -4 } : undefined
              },
                listing === null
                  ? h('div', { className: 'rh-empty' }, busy ? t('loading') : t('downloadTip'))
                  : listing.entries.length === 0
                    ? h('div', { className: 'rh-empty' }, t('empty'))
                    : h('table', { className: 'rh-table' },
                        h('thead', null, h('tr', null,
                          h('th', { style: { width: 24 } },
                            h('input', {
                              type: 'checkbox',
                              checked: pageRows.length > 0 && pageRows.every((entry) => checked.includes(entry.name)),
                              onChange: selectAll
                            })),
                          h('th', null, t('name')), h('th', null, t('type')), h('th', null, t('permissions')),
                          h('th', null, t('size')), h('th', null, t('modified')), h('th', null, ''))),
                        h('tbody', null, pageRows.map((entry) => h('tr', {
                          key: entry.name,
                          className: 'rh-row',
                          draggable: true,
                          onDragStart: (event) => {
                            event.dataTransfer.setData('text/rh-path', joinPath(path, entry.name));
                            event.dataTransfer.effectAllowed = 'move';
                          }
                        },
                          h('td', null, h('input', { type: 'checkbox', checked: checked.includes(entry.name), onChange: () => toggleChecked(entry.name) })),
                          h('td', null, renaming === entry.name
                            ? h('input', {
                                className: 'rh-path', autoFocus: true, value: renameValue,
                                onChange: (e) => setRenameValue(e.target.value),
                                onKeyDown: (e) => {
                                  if (e.key === 'Enter') doRename(entry, renameValue);
                                  if (e.key === 'Escape') setRenaming(null);
                                },
                                onBlur: () => setRenaming(null),
                                style: { width: '100%' }
                              })
                            : h('button', { className: 'rh-filebtn', onDoubleClick: () => {
                                if (entry.type === 'dir') openDirectory(selected, joinPath(path, entry.name));
                              }, onClick: () => {
                                if (!guardDirty()) return;
                                if (entry.type === 'dir') openDirectory(selected, joinPath(path, entry.name));
                                else openFile(entry);
                              } },
                              (entry.type === 'dir' ? '📁 ' : entry.type === 'link' ? '🔗 ' : '📄 ') + entry.name)),
                          h('td', { className: 'rh-dim' }, t(entry.type)),
                          h('td', { className: 'rh-dim rh-mono' }, entry.mode === undefined || entry.mode === 0 ? '' : entry.mode.toString(8).padStart(3, '0')),
                          h('td', { className: 'rh-dim rh-mono' }, entry.type === 'file' ? formatSize(entry.size) : ''),
                          h('td', { className: 'rh-dim rh-mono' }, formatTime(entry.mtime)),
                          h('td', null,
                            h('span', { style: S_ROW_ACTIONS },
                              h('button', {
                                className: 'rh-iconbtn', title: t('chmod'),
                                onClick: () => {
                                  setChmodTarget({ path: joinPath(path, entry.name), name: entry.name });
                                  setChmodValue(entry.mode === undefined || entry.mode === 0 ? '644' : entry.mode.toString(8).padStart(3, '0'));
                                }
                              }, '🔑'),
                              entry.type === 'file'
                                ? h('button', { className: 'rh-iconbtn', title: t('download'), onClick: () => downloadFile(entry) }, '⤓')
                                : null,
                              entry.name.endsWith('.bak')
                                ? h('button', { className: 'rh-iconbtn', title: t('restoreBak'), onClick: () => restoreBackup(entry) }, '↺')
                                : null,
                              h('button', { className: 'rh-iconbtn', title: t('rename'), onClick: () => { setRenaming(entry.name); setRenameValue(entry.name); } }, '✎'),
                              h('button', {
                                className: `rh-iconbtn danger${pendingRemove === entry.name ? ' armed' : ''}`,
                                title: pendingRemove === entry.name ? t('confirmRemove') : t('remove'),
                                onClick: () => requestRemove(entry)
                              }, pendingRemove === entry.name ? '✕!' : '✕')))))))),
              progress !== null
                ? h('div', {
                    key: 'progress',
                    className: 'rh-inline',
                    style: { padding: '4px 12px', borderTop: '1px solid var(--dsw-alias-border-l1)', gap: 8 }
                  },
                    h('span', { className: 'rh-dim', style: { fontSize: 11 } }, `${t('uploading')} ${progress.name}`),
                    h('div', { style: { flex: 1, height: 4, background: 'var(--dsw-alias-bg-layer-1)', borderRadius: 2 } },
                      h('div', {
                        style: {
                          width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%`,
                          height: '100%', background: 'var(--dsw-alias-brand-primary)', borderRadius: 2
                        }
                      })))
                : null,
              listing !== null && listing.entries.length > PAGE_SIZE
                ? h('div', {
                    key: 'pager',
                    className: 'rh-inline',
                    style: { padding: '4px 12px', borderTop: '1px solid var(--dsw-alias-border-l1)', justifyContent: 'flex-end', gap: 6 }
                  },
                    h('button', { className: 'rh-btn', disabled: page === 0, onClick: () => setPage((prev) => Math.max(0, prev - 1)) }, '‹'),
                    h('span', { className: 'rh-dim', style: { fontSize: 12 } }, `${page + 1} / ${totalPages} ${t('page')}`),
                    h('button', { className: 'rh-btn', disabled: page >= totalPages - 1, onClick: () => setPage((prev) => Math.min(totalPages - 1, prev + 1)) }, '›'))
                : null,
              creating !== null ? h(Modal, { title: creating === 'folder' ? t('newFolderName') : t('newFileName'), key: 'create', onClose: () => setCreating(null) },
                  h('input', {
                    className: 'rh-path', autoFocus: true, value: createValue,
                    onChange: (e) => setCreateValue(e.target.value),
                    onKeyDown: (e) => { if (e.key === 'Enter') doCreate(creating, createValue); }
                  }),
                  h('div', { className: 'rh-actions' },
                    h('button', { className: 'rh-btn', onClick: () => setCreating(null) }, t('cancel')),
                    h('button', { className: 'rh-btn primary', onClick: () => doCreate(creating, createValue) }, t('save')))) : null,
              stash.length > 0
                ? h('div', {
                    key: 'stash',
                    className: 'rh-inline',
                    style: { padding: '4px 12px', borderTop: '1px solid var(--dsw-alias-border-l1)', gap: 6, flexWrap: 'wrap' }
                  },
                    h('span', { className: 'rh-dim', style: { fontSize: 11 } }, `${t('stashDirty')}:`),
                    stash.map((entry) => h('button', {
                      key: entry.path,
                      className: 'rh-btn',
                      style: { fontSize: 11, padding: '2px 8px' },
                      title: entry.path,
                      onClick: () => restoreStashed(entry)
                    }, `● ${entry.name}`)))
                : null,
              file !== null ? h('div', { className: 'rh-editor', key: 'editor', style: { height: editorHeight } },
                h('div', { className: 'rh-editor-head' },
                  h('strong', null, t('editorTitle')),
                  h('span', { className: 'rh-file' }, file.path),
                  file.dirty ? h('span', { className: 'rh-dim' }, '●') : null,
                  h('span', { className: 'rh-dim rh-mono' }, formatSize(file.size)),
                  h('div', { style: { flex: 1 } }),
                  file.binary ? null : h('button', { className: 'rh-btn', onClick: () => setHighlight((prev) => !prev) }, `✦ ${t('highlight')} ${highlight ? t('on') : t('off')}`),
                  file.binary ? null : h('button', { className: 'rh-btn primary', disabled: busy || file.truncated, onClick: () => saveFile() }, t('saveFile')),
                  h('button', { className: 'rh-iconbtn', title: t('close'), onClick: () => setFile(null) }, '✕')),
                file.binary
                  ? (file.mime !== undefined
                      ? h('div', { key: 'img', style: { padding: 10, overflow: 'auto', minHeight: 0 } },
                          h('img', { src: `data:${file.mime};base64,${file.content}`, alt: t('imagePreview'), style: { maxWidth: '100%', borderRadius: 8 } }))
                      : h('div', { className: 'rh-note' }, `${t('editorBinary')} ${file.content.slice(0, 64)}…`))
                  : [
                      h('div', { className: 'rh-editor-head', style: { borderBottom: 'none', paddingTop: 0 } },
                  h('div', { style: { flex: 1 } }),
                  h('button', {
                    className: 'rh-btn',
                    onClick: () => setEditorHeight(editorHeight === '42%' ? '58%' : editorHeight === '58%' ? '75%' : '42%')
                  }, `${t('editorSize')} ${editorHeight}`)),
                file.truncated ? h('div', { className: 'rh-note', key: 'warn' }, t('editorTruncated')) : null,
                      h('div', {
                        key: 'area',
                        style: { flex: 1, display: 'flex', minHeight: 0, position: 'relative', background: 'var(--dsw-alias-bg-layer-1)' }
                      },
                        h('pre', {
                          ref: gutterRef,
                          style: {
                            margin: 0, padding: '10px 6px 10px 10px', textAlign: 'right', color: 'var(--dsw-alias-label-secondary)',
                            fontSize: 12, lineHeight: '1.5', fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace',
                            overflow: 'hidden', userSelect: 'none', opacity: 0.65,
                            borderRight: '1px solid var(--dsw-alias-border-l1)'
                          }
                        }, editorLineNumbers),
                        h('div', { style: { flex: 1, minWidth: 0, position: 'relative' } },
                          showHighlight
                            ? h('pre', {
                                ref: overlayRef,
                                style: {
                                  position: 'absolute', inset: 0, margin: 0, padding: '10px 12px', overflow: 'hidden',
                                  fontSize: 12, lineHeight: '1.5', fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace',
                                  whiteSpace: 'pre-wrap', wordBreak: 'break-word', pointerEvents: 'none'
                                }
                              }, highlightedNodes)
                            : null,
                          h('textarea', {
                            value: file.content, readOnly: file.truncated, spellCheck: false,
                            onScroll: (e) => {
                              if (gutterRef.current !== null) gutterRef.current.scrollTop = e.target.scrollTop;
                              if (overlayRef.current !== null) {
                                overlayRef.current.scrollTop = e.target.scrollTop;
                                overlayRef.current.scrollLeft = e.target.scrollLeft;
                              }
                            },
                            onChange: (e) => setFile((prev) => ({ ...prev, content: e.target.value, dirty: true })),
                            style: {
                              position: 'absolute', inset: 0, resize: 'none', border: 'none', padding: '10px 12px',
                              background: 'transparent', fontSize: 12, lineHeight: '1.5', outline: 'none',
                              fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace',
                              color: showHighlight ? 'transparent' : 'inherit',
                              caretColor: 'var(--dsw-alias-label-primary)',
                              whiteSpace: 'pre-wrap', wordBreak: 'break-word'
                            }
                          })
                        ))
                    ]) : null]
              : h('div', { className: 'rh-empty', style: { margin: 'auto' } }, t('noConnection')))),
        gitOpen ? h(Modal, { title: `${t('git')} · ${path}`, key: 'git', width: 720, onClose: () => setGitOpen(false) },
            gitInfo === null
              ? h('div', { className: 'rh-note' }, t('loading'))
              : gitInfo.isRepo === false
                ? h('div', { className: 'rh-note' }, t('notRepo'))
                : [
                    h('div', { key: 'branch', className: 'rh-mono', style: { fontSize: 12 } },
                      `${t('branch')}: ${gitInfo.branch}　${t('changes')}: ${gitInfo.changes}`),
                    h('div', { key: 'commit', className: 'rh-dim rh-mono', style: { fontSize: 11 } },
                      `${t('lastCommit')}: ${gitInfo.lastCommit || '-'}`),
                    h('div', {
                      key: 'files',
                      style: S_SCROLL_BOX
                    }, (gitInfo.files ?? []).length === 0
                      ? h('span', { className: 'rh-dim' }, '—')
                      : (gitInfo.files ?? []).map((line, index) => h('div', {
                          key: `${index}-${line}`,
                          className: 'rh-mono',
                          style: { fontSize: 11, whiteSpace: 'pre' }
                        }, line)))
                  ],
            h('div', { className: 'rh-actions' },
              h('button', { className: 'rh-btn', onClick: () => setGitOpen(false) }, t('close')))) : null,
        picker !== null ? h(RemotePathPicker, {
          key: 'picker',
          call, t, connectionId: selected,
          initialPath: picker.initial,
          title: picker.mode === 'workspace' ? t('setWorkspace') : t('pickDir'),
          onCancel: () => setPicker(null),
          onPick: async (picked) => {
            setPicker(null);
            if (picker.mode === 'workspace') await commitWorkspace(picked);
            else if (guardDirty()) await openDirectory(selected, picked);
          }
        }) : null,
        auditOpen ? h(Modal, { title: t('audit'), key: 'audit', width: 780, onClose: () => setAuditOpen(false) },
            auditList.length === 0
              ? h('div', { className: 'rh-note' }, t('noAudit'))
              : h('div', { style: { maxHeight: '56vh', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 4 } },
                  auditList.map((entry, index) => h('div', {
                    key: `${entry.at ?? index}-${index}`,
                    className: 'rh-mono',
                    style: { fontSize: 11, borderBottom: '1px solid var(--dsw-alias-border-l1)', paddingBottom: 4 }
                  },
                    h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, `${new Date(entry.at ?? Date.now()).toLocaleString()} `),
                    h('span', { style: { color: entry.source === 'agent' ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-primary)' } }, `[${entry.source ?? 'panel'}] `),
                    h('span', { style: { color: entry.ok === false ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)' } }, entry.ok === false ? '✗ ' : '✓ '),
                    h('span', null, `${entry.action ?? ''} ${entry.connection ? `@${entry.connection} ` : ''}${entry.detail ?? ''}`)))),
            h('div', { className: 'rh-actions' },
              h('button', {
                className: 'rh-btn',
                onClick: async () => {
                  const result = await call('audit.export', { limit: 5000 });
                  const url = URL.createObjectURL(new Blob([result.content], { type: 'application/x-ndjson' }));
                  const link = document.createElement('a');
                  link.href = url;
                  link.download = result.filename;
                  link.click();
                  URL.revokeObjectURL(url);
                }
              }, t('exportAudit')),
              h('button', { className: 'rh-btn danger', onClick: async () => { await call('audit.clear'); setAuditList([]); } }, t('clearAudit')),
              h('button', { className: 'rh-btn', onClick: () => setAuditOpen(false) }, t('close')))) : null,
        sysOpen ? h(Modal, { title: t('sysInfo'), key: 'sys', onClose: () => setSysOpen(false) },
            sysInfo === null
              ? h('div', { className: 'rh-note' }, t('loading'))
              : h('div', { className: 'rh-mono', style: { fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 } },
                  h('div', null, `${t('sysKernel')}：${sysInfo.kernel || '-'}`),
                  h('div', null, `${t('sysUser')}：${sysInfo.user || '-'}`),
                  h('div', null, `${t('sysDisk')}：${sysInfo.disk || '-'}`),
                  h('div', null, `${t('sysUptime')}：${sysInfo.uptime || '-'}`),
                  h('div', null, `${t('sysCpu')}：${sysInfo.cpu || '-'}`)),
            h('div', { className: 'rh-actions' },
              h('button', { className: 'rh-btn', onClick: () => setSysOpen(false) }, t('close')))) : null,
        tunnelOpen ? h(Modal, { title: t('tunnels'), key: 'tunnel', width: 560, onClose: () => setTunnelOpen(false) },
            h('div', { className: 'rh-row2' },
              h(Field, { label: t('localPort'), value: tunnelForm.localPort, onChange: (value) => setTunnelForm((prev) => ({ ...prev, localPort: Number(value) || 0 })), type: 'number' }),
              h(Field, { label: t('remotePort'), value: tunnelForm.remotePort, onChange: (value) => setTunnelForm((prev) => ({ ...prev, remotePort: value })), type: 'number' })),
            h(Field, { label: t('remoteHost'), value: tunnelForm.remoteHost, onChange: (value) => setTunnelForm((prev) => ({ ...prev, remoteHost: value })) }),
            tunnelList.length === 0
              ? h('div', { className: 'rh-note' }, t('noBindings'))
              : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, maxHeight: '30vh', overflow: 'auto' } },
                  tunnelList.map((tunnel) => h('div', {
                    key: tunnel.key, className: 'rh-inline',
                    style: { justifyContent: 'space-between', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, padding: '6px 8px' }
                  },
                    h('span', { className: 'rh-mono', style: { fontSize: 12 } }, `127.0.0.1:${tunnel.localPort} → ${tunnel.remoteHost}:${tunnel.remotePort}`),
                    h('span', { className: 'rh-dim', style: { fontSize: 11 } }, tunnel.connectionName ?? ''),
                    h('button', { className: 'rh-iconbtn danger', title: t('closeTunnel'), onClick: () => destroyTunnel(tunnel.key) }, '✕')))),
            h('div', { className: 'rh-actions' },
              h('button', { className: 'rh-btn', onClick: () => setTunnelOpen(false) }, t('close')),
              h('button', { className: 'rh-btn primary', disabled: selected === null, onClick: createTunnel }, t('openTunnel')))) : null,
        ioOpen !== null ? h(Modal, { title: ioOpen === 'export' ? t('exportConnections') : t('importConnections'), key: 'io', onClose: () => setIoOpen(null) },
            h(Field, { label: t('passphraseForFile'), value: ioPass, onChange: setIoPass, type: 'password' }),
            ioOpen === 'import'
              ? h('div', { className: 'rh-field' },
                  h('label', null, t('importConnections')),
                  h('button', { className: 'rh-btn', onClick: () => importInput.current?.click() }, t('upload')),
                  h('input', {
                    ref: importInput, type: 'file', accept: 'application/json', style: { display: 'none' },
                    onChange: async (event) => {
                      const picked = event.target.files?.[0];
                      event.target.value = '';
                      if (picked === undefined) return;
                      setIoContent(await picked.text());
                    }
                  }),
                  ioContent !== '' ? h('span', { className: 'rh-ok' }, `✓ ${ioContent.length} 字符`) : null)
              : null,
            h('div', { className: 'rh-actions' },
              h('button', { className: 'rh-btn', onClick: () => setIoOpen(null) }, t('cancel')),
              h('button', {
                className: 'rh-btn primary', disabled: ioPass.length < 6 || (ioOpen === 'import' && ioContent === ''),
                onClick: ioOpen === 'export' ? exportConnections : importConnections
              }, ioOpen === 'export' ? t('exportConnections') : t('importConnections')))) : null,
        diffOpen && file !== null ? h(Modal, { title: `${t('saveConfirm')} · ${file.path}`, key: 'diff', width: 920, onClose: () => setDiffOpen(false) },
            h('div', { style: { display: 'flex', gap: 8, minHeight: 0 } },
              h('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', gap: 4 } },
                h('div', { className: 'rh-inline', style: { gap: 6 } },
                  h('span', { className: 'rh-dim' }, localFile === null ? t('original') : `${t('localFile')}: ${localFile.name}`),
                  h('button', { className: 'rh-btn', style: { fontSize: 11 }, onClick: () => localInput.current?.click() }, t('compareLocal')),
                  h('input', {
                    ref: localInput, type: 'file', style: { display: 'none' },
                    onChange: async (event) => {
                      const picked = event.target.files?.[0];
                      event.target.value = '';
                      if (picked === undefined) return;
                      setLocalFile({ name: picked.name, content: await picked.text() });
                    }
                  })),
                h('textarea', {
                  readOnly: true, value: localFile === null ? (file.original ?? '') : localFile.content,
                  style: {
                    height: '40vh', background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)',
                    borderRadius: 8, padding: 8, fontSize: 12, color: 'inherit', fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace'
                  }
                })),
              h('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', gap: 4 } },
                h('span', { className: 'rh-dim' }, t('modified')),
                h('textarea', {
                  readOnly: true, value: file.content,
                  style: {
                    height: '40vh', background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-brand-primary)',
                    borderRadius: 8, padding: 8, fontSize: 12, color: 'inherit', fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace'
                  }
                }))),
            h('div', { className: 'rh-actions' },
              h('button', { className: 'rh-btn', onClick: () => { setDiffOpen(false); setLocalFile(null); } }, t('cancel')),
              h('button', { className: 'rh-btn primary', onClick: async () => { setDiffOpen(false); await saveFile(true); } }, t('confirmSave')))) : null,
        searchState !== null ? h(Modal, { title: `${t('searchRemote')} · ${path}`, key: 'search', width: 680, onClose: () => setSearchState(null) },
            h('input', {
              className: 'rh-path', autoFocus: true, value: searchState.pattern, placeholder: t('searchHint'),
              onChange: (e) => setSearchState((prev) => ({ ...prev, pattern: e.target.value })),
              onKeyDown: (e) => { if (e.key === 'Enter') runSearch(); }
            }),
            h('input', {
              className: 'rh-path', value: searchState.path, placeholder: `${t('pathPlaceholder')}（留空=当前目录）`,
              onChange: (e) => setSearchState((prev) => ({ ...prev, path: e.target.value }))
            }),
            (searchState.matches ?? []).length > 0
              ? h('div', {
                  style: S_SCROLL_BOX
                }, searchState.matches.map((line, index) => {
                  const matched = /^(.*?):(\d+):(.*)$/.exec(line);
                  const target = matched === null ? null : matched[1];
                  return h('button', {
                    key: `${index}-${line.slice(0, 20)}`,
                    className: 'rh-tree-node',
                    style: { display: 'block', fontSize: 11 },
                    title: target ?? line,
                    onClick: async () => {
                      setSearchState(null);
                      if (target !== null) await openByPath(target);
                    }
                  }, h('span', { className: 'rh-mono' }, line));
                }))
              : searchState.output !== ''
                ? h('pre', {
                    style: S_CODE_BLOCK
                  }, searchState.output)
                : null,
            h('div', { className: 'rh-actions' },
              searchState.count !== undefined ? h('span', { className: 'rh-dim', style: { marginRight: 'auto', fontSize: 12 } }, `${searchState.count} ${t('matches')}`) : null,
              h('button', { className: 'rh-btn', onClick: () => setSearchState(null) }, t('close')),
              h('button', { className: 'rh-btn primary', disabled: searchState.running === true, onClick: runSearch },
                searchState.running === true ? t('loading') : t('searchRemote')))) : null,
        bindingsOpen ? h(Modal, { title: t('boundSession'), key: 'bindings', width: 560, onClose: () => setBindingsOpen(false) },
            bindingList.length === 0
              ? h('div', { className: 'rh-note' }, t('noBindings'))
              : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: '50vh', overflow: 'auto' } },
                  bindingList.map((item) => h('div', {
                    key: item.sessionId, className: 'rh-inline',
                    style: { justifyContent: 'space-between', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, padding: '6px 8px' }
                  },
                    h('span', { className: 'rh-mono', style: { fontSize: 12 } }, `${item.connectionName}:${item.path}`),
                    h('span', { className: 'rh-dim', style: { fontSize: 11 } }, String(item.sessionId).slice(0, 8)),
                    h('button', { className: 'rh-iconbtn danger', title: t('unbindAction'), onClick: () => dropBinding(item.sessionId) }, '✕')))),
            h('div', { className: 'rh-actions' },
              h('button', { className: 'rh-btn', onClick: () => setBindingsOpen(false) }, t('close')))) : null,
        sshOpen ? h(Modal, {
          key: 'ssh-config', title: t('importSsh'), width: 560,
          onClose: () => setSshOpen(false)
        },
          h('div', { style: { ...S_SCROLL_BOX, maxHeight: '46vh', display: 'flex', flexDirection: 'column', gap: 4 } },
            sshHosts.map((host) => h('button', {
              key: host.alias,
              className: 'rh-tree-node',
              style: { display: 'block' },
              onClick: async () => {
                await run(async () => {
                  await call('connections.save', {
                    name: host.alias,
                    host: host.host,
                    port: host.port,
                    username: host.username === '' ? 'root' : host.username,
                    authType: 'key',
                    privateKey: '',
                    group: 'ssh-config'
                  });
                  await refreshConnections();
                  setSshHosts((prev) => prev.filter((item) => item.alias !== host.alias));
                });
              }
            }, `${host.alias} → ${host.username || '?'}@${host.host}:${host.port}`))),
          h('div', { className: 'rh-actions' },
            h('button', { className: 'rh-btn', onClick: () => setSshOpen(false) }, t('close')))) : null,
        chmodTarget !== null ? h(Modal, { title: `${t('chmod')} · ${chmodTarget.name}`, key: 'chmod', onClose: () => setChmodTarget(null) },
            h('input', {
              className: 'rh-path', autoFocus: true, value: chmodValue, placeholder: t('chmodHint'),
              onChange: (e) => setChmodValue(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') applyChmod(); }
            }),
            h('div', { className: 'rh-actions' },
              h('button', { className: 'rh-btn', onClick: () => setChmodTarget(null) }, t('cancel')),
              h('button', { className: 'rh-btn primary', disabled: busy, onClick: applyChmod }, t('save')))) : null,
        terminal !== null ? h(Modal, { title: `${t('command')} · ${path}`, key: 'terminal', width: 680, onClose: () => setTerminal(null) },
            h('input', {
              className: 'rh-path', autoFocus: true, value: terminal.command, placeholder: t('commandHint'),
              onChange: (e) => setTerminal((prev) => ({ ...prev, command: e.target.value })),
              onKeyDown: (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runCommand(); }
            }),
            history.length > 0
              ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
                  h('span', { className: 'rh-dim', style: { fontSize: 11, marginRight: 4 } }, `${t('history')}:`),
                  history.slice(0, 12).map((entry) => h('button', {
                    key: entry,
                    className: 'rh-btn',
                    style: { fontSize: 11, padding: '2px 8px', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                    title: entry,
                    onClick: () => setTerminal((prev) => ({ ...prev, command: entry }))
                  }, entry)),
                  h('button', {
                    className: 'rh-btn', style: { fontSize: 11 },
                    onClick: () => {
                      try { window.localStorage.removeItem('remote-host:cmd-history'); } catch { /* ignore */ }
                      setHistory([]);
                    }
                  }, t('clearHistory')))
              : null,
            terminal.output !== ''
              ? h('pre', {
                  style: S_CODE_BLOCK
                }, terminal.output)
              : null,
            h('div', { className: 'rh-actions' },
              h('button', { className: 'rh-btn', onClick: () => setTerminal(null) }, t('close')),
              h('button', { className: 'rh-btn primary', disabled: terminal.running === true, onClick: runCommand },
                terminal.running === true ? t('loading') : t('runCommand')))) : null,
        draft !== null ? h(ConnectionForm, {
          key: draft.id ?? 'new', t, draft, onClose: () => setDraft(null),
          onSave: saveConnection,
          jumpOptions: connections.filter((entry) => entry.id !== draft?.id),
          onResetHostKey: async (id) => {
            await run(async () => {
              await call('connections.resetHostKey', { id });
              await refreshConnections();
            });
          },
          onTest: async (form) => call('connections.test', { ...form, draft: true })
        }) : null);
    }

    /* ------------------------------------------------------------------ */
    /* 插件注册                                                            */
    /* ------------------------------------------------------------------ */

    return {
      // 只硬依赖 slot 注册表；其余服务均为可选读取，
      // 缺少它们的 profile 也能挂起面板。
      inject: ['slots'],
      async apply(ctx) {
        // 样式与文案位于包内分包。分包加载失败也不能拖垮整个面板：
        // 继续以无样式方式运行。
        try {
          const parts = await require.async('./client.parts.js');
          if (parts?.CSS) CSS = parts.CSS;
          if (parts?.DICTS) DICTS = parts.DICTS;
        } catch (error) {
          console.warn('[remote-host] client.parts.js failed to load, continuing unstyled:', error);
        }

        const connection = ctx.get('connection');
        const layout = ctx.get('layout');
        const locale = ctx.get('locale');
        const t = makeT(locale);

        /** Host RPC call with a plain-fetch fallback. */
        async function call(endpoint, payload) {
          const rpc = connection?.rpc;
          if (rpc?.call) {
            const result = await rpc.call('/remote-host-api', endpoint, payload ?? {});
            if (result?.ok) return result.value;
            throw new Error(result?.error?.message ?? String(result?.error?.code ?? 'RPC failed'));
          }
          const rpcId = `rh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
          const response = await fetch(`remote-host-api/${endpoint}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: payload ?? null })
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const full = await response.json();
          if (full?.result?.ok) return full.result.value;
          throw new Error(full?.result?.error?.message ?? 'RPC failed');
        }

        const openPanel = () => layout?.selectPanel?.('remote-host');

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: 'remote-host', order: 20, label: '远程主机' },
          (props) => PanelIcon({ ...props, open: openPanel })
        ));

        ctx.slots.inject('conversation.hero.options', () => ctx.slots.register(
          { name: 'conversation.hero.options', id: 'remote-host', order: 5, label: '远程主机' },
          (slotProps) => h(RemoteWorkspaceOption, { ...slotProps, call, t })
        ));

        ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: 'remote-host' },
          () => h(App, { call, t })
        ));
      }
    };
  },
});
