/**
 * 远程主机面板的静态部分：跟随主题的样式表，
 * 以及双语文案。以包内分包形式经 require.async 加载，
 * 让入口包专注行为逻辑。
 */
window.__ModuleLoader__.load({
  // 显式 chunk 字段（DSH 0.2.x 的 ClientBundleRegistration 契约）：
  // id 为包名，chunk 为包内文件名，加载器会拼成 `<包名>/<文件名>` 作为模块键。
  id: '@local/remote-host',
  chunk: 'client.parts.js',
  factory(require) {
    const DICTS = {
      zh: {
        panelTitle: '远程主机',
        panelHint: 'SSH 连接与远程文件管理',
        connections: '连接',
        newConnection: '新建连接',
        edit: '编辑',
        delete: '删除',
        confirmDelete: '删除？',
        save: '保存',
        cancel: '取消',
        test: '测试连接',
        testing: '测试中…',
        connecting: '连接中…',
        connected: '已连接',
        disconnected: '未连接',
        disconnect: '断开',
        name: '名称',
        host: '主机',
        port: '端口',
        username: '用户名',
        authType: '认证方式',
        password: '密码',
        privateKey: '私钥 (PEM)',
        passphrase: '私钥口令',
        authPassword: '密码',
        authKey: '私钥',
        connect: '连接',
        refresh: '刷新',
        up: '上级',
        newFolder: '新建文件夹',
        newFile: '新建文件',
        rename: '重命名',
        remove: '删除',
        downloadTip: '点击文件名打开编辑器',
        pathPlaceholder: '远程路径，如 /var/www',
        go: '转到',
        editorTitle: '编辑文件',
        editorBinary: '二进制文件，仅可查看 Base64 前缀，不支持编辑保存。',
        editorTruncated: '文件过大，仅加载前一部分；直接保存会截断远端文件！',
        saveFile: '保存到远程',
        saved: '已保存',
        fileContent: '文件内容',
        empty: '空目录',
        noConnection: '← 选择或新建一个连接',
        loading: '加载中…',
        requiredName: '请填写名称、主机和用户名',
        newFileName: '新文件名',
        newFolderName: '新文件夹名',
        renameTo: '重命名为',
        close: '关闭',
        type: '类型',
        size: '大小',
        modified: '修改时间',
        dir: '目录',
        file: '文件',
        link: '链接',
        other: '其他',
        setWorkspace: '设为默认工作区',
        workspaceDefault: '默认工作区',
        clearWorkspace: '清除默认工作区',
        workspaceAuto: '新对话会自动连接该目录',
        discardChanges: '有未保存的修改，确定丢弃？',
        imagePreview: '图片预览',
        searchConnections: '搜索连接…',
        permissions: '权限',
        chmod: '改权限',
        chmodHint: '八进制，如 755',
        batchDelete: '删除所选',
        selected: '已选',
        command: '命令',
        commandHint: '输入远程命令，Cmd/Ctrl+Enter 执行',
        runCommand: '执行',
        output: '输出',
        upload: '上传文件',
        download: '下载',
        editorSize: '高度',
        binds: '个对话绑定',
        noMatch: '没有匹配的连接',
        remoteWorkspace: '远程主机',
        pickRemote: '选择远程工作目录',
        bindAndConnect: '绑定并连接',
        unbindAction: '解除绑定',
        boundSession: '本对话远程工作区',
        noConnections: '还没有连接：请先在侧栏「远程主机」面板里添加',
        restoreBak: '恢复备份（覆盖同名文件）',
        searchRemote: '远程搜索',
        searchHint: 'grep -E 正则，如 TODO|FIXME',
        matches: '条匹配',
        openSession: '打开对话',
        noBindings: '还没有对话绑定远程工作区',
        dropHere: '松开即可上传到当前目录',
        lastDir: '回到上次目录',
        tabs: '已打开',
        tree: '目录树',
        audit: '审计',
        jumpHost: '跳板机',
        jumpNone: '不使用跳板机',
        hostKey: '主机指纹',
        hostKeyEmpty: '首次连接时自动记录',
        resetHostKey: '重置指纹',
        noSshHosts: '~/.ssh/config 里没有可导入的 Host',
        importSsh: '导入 ~/.ssh/config',
        vault: '凭据库',
        vaultLocked: '凭据库已加锁，输入主口令后可用',
        vaultPassphrase: '主口令（至少 8 位）',
        vaultHint: '开启后所有密码与私钥都用主口令加密，每次启动需解锁',
        unlock: '解锁',
        lockNow: '立即加锁',
        enableVault: '设置主口令',
        disableVault: '取消主口令',
        uploading: '上传中',
        stashDirty: '未保存的编辑',
        exportAudit: '导出审计',
        localFile: '本地文件',
        compareLocal: '对比本地文件',
        history: '历史',
        clearHistory: '清空',
        sysKernel: '内核',
        sysUser: '登录用户',
        sysDisk: '磁盘',
        sysUptime: '运行时长',
        sysCpu: 'CPU 核数',
        highlight: '高亮',
        on: '开',
        off: '关',
        sysInfo: '系统信息',
        exportConnections: '导出连接',
        importConnections: '导入连接',
        tunnels: '端口转发',
        openTunnel: '开隧道',
        closeTunnel: '关闭',
        localPort: '本地端口（0=自动）',
        remotePort: '远程端口',
        remoteHost: '远程主机',
        passphraseForFile: '导出/导入口令（≥6 位）',
        noAudit: '还没有操作记录',
        saveConfirm: '保存确认',
        original: '原始内容',
        modified: '修改后',
        confirmSave: '确认保存',
        group: '分组',
        clearAudit: '清空记录',
        closeTab: '关闭标签',
        confirmPick: '选择此目录',
        pickDir: '选择远程目录',
        browse: '浏览',
        git: 'Git',
        branch: '分支',
        changes: '变更文件',
        lastCommit: '最近提交',
        notRepo: '该目录不是 Git 仓库',
        page: '页',
        confirmRemove: '再点一次确认删除'
      },
      en: {
        panelTitle: 'Remote Host',
        panelHint: 'SSH connections and remote file management',
        connections: 'Connections',
        newConnection: 'New connection',
        edit: 'Edit',
        delete: 'Delete',
        confirmDelete: 'Delete?',
        save: 'Save',
        cancel: 'Cancel',
        test: 'Test connection',
        testing: 'Testing…',
        connecting: 'Connecting…',
        connected: 'Connected',
        disconnected: 'Offline',
        disconnect: 'Disconnect',
        name: 'Name',
        host: 'Host',
        port: 'Port',
        username: 'Username',
        authType: 'Auth',
        password: 'Password',
        privateKey: 'Private key (PEM)',
        passphrase: 'Key passphrase',
        authPassword: 'Password',
        authKey: 'Private key',
        connect: 'Connect',
        refresh: 'Refresh',
        up: 'Up',
        newFolder: 'New folder',
        newFile: 'New file',
        rename: 'Rename',
        remove: 'Delete',
        downloadTip: 'Click a file name to open the editor',
        pathPlaceholder: 'Remote path, e.g. /var/www',
        go: 'Go',
        editorTitle: 'Edit file',
        editorBinary: 'Binary file; showing Base64 prefix only, editing disabled.',
        editorTruncated: 'File is large; only a prefix is loaded — saving would truncate the remote file!',
        saveFile: 'Save to remote',
        saved: 'Saved',
        fileContent: 'File content',
        empty: 'Empty directory',
        noConnection: '← Pick or create a connection',
        loading: 'Loading…',
        requiredName: 'Name, host and username are required',
        newFileName: 'New file name',
        newFolderName: 'New folder name',
        renameTo: 'Rename to',
        close: 'Close',
        type: 'Type',
        size: 'Size',
        modified: 'Modified',
        dir: 'Directory',
        file: 'File',
        link: 'Link',
        other: 'Other',
        setWorkspace: 'Set default workspace',
        workspaceDefault: 'Default workspace',
        clearWorkspace: 'Clear default workspace',
        workspaceAuto: 'New conversations reconnect this directory',
        discardChanges: 'Discard unsaved changes?',
        imagePreview: 'Image preview',
        searchConnections: 'Search connections…',
        permissions: 'Mode',
        chmod: 'Chmod',
        chmodHint: 'Octal, e.g. 755',
        batchDelete: 'Delete selected',
        selected: 'Selected',
        command: 'Command',
        commandHint: 'Type a remote command, Cmd/Ctrl+Enter to run',
        runCommand: 'Run',
        output: 'Output',
        upload: 'Upload file',
        download: 'Download',
        editorSize: 'Height',
        binds: 'conversations bound',
        noMatch: 'No matching connections',
        remoteWorkspace: 'Remote host',
        pickRemote: 'Pick a remote working directory',
        bindAndConnect: 'Bind & connect',
        unbindAction: 'Unbind',
        boundSession: 'Remote workspace for this conversation',
        noConnections: 'No connections yet: add one in the Remote Host panel first',
        restoreBak: 'Restore backup (overwrites the file)',
        searchRemote: 'Remote search',
        searchHint: 'grep -E pattern, e.g. TODO|FIXME',
        matches: 'matches',
        openSession: 'Open conversation',
        noBindings: 'No conversation is bound to a remote workspace yet',
        dropHere: 'Drop to upload into this directory',
        lastDir: 'Back to last directory',
        tabs: 'Open',
        tree: 'Tree',
        audit: 'Audit',
        jumpHost: 'Jump host',
        jumpNone: 'No jump host',
        hostKey: 'Host key',
        hostKeyEmpty: 'Recorded on first connect',
        resetHostKey: 'Reset fingerprint',
        noSshHosts: 'No importable Host entries in ~/.ssh/config',
        importSsh: 'Import ~/.ssh/config',
        vault: 'Credential vault',
        vaultLocked: 'Vault is locked — enter the passphrase to continue',
        vaultPassphrase: 'Passphrase (at least 8 characters)',
        vaultHint: 'Encrypts every password and private key with your passphrase; unlock on each start',
        unlock: 'Unlock',
        lockNow: 'Lock now',
        enableVault: 'Set passphrase',
        disableVault: 'Remove passphrase',
        uploading: 'Uploading',
        stashDirty: 'Unsaved edits',
        exportAudit: 'Export audit',
        localFile: 'Local file',
        compareLocal: 'Compare local file',
        history: 'History',
        clearHistory: 'Clear',
        sysKernel: 'Kernel',
        sysUser: 'User',
        sysDisk: 'Disk',
        sysUptime: 'Uptime',
        sysCpu: 'CPU cores',
        highlight: 'Highlight',
        on: 'on',
        off: 'off',
        sysInfo: 'System',
        exportConnections: 'Export connections',
        importConnections: 'Import connections',
        tunnels: 'Port forwards',
        openTunnel: 'Open tunnel',
        closeTunnel: 'Close',
        localPort: 'Local port (0 = auto)',
        remotePort: 'Remote port',
        remoteHost: 'Remote host',
        passphraseForFile: 'Passphrase (≥6 chars)',
        noAudit: 'No operations recorded yet',
        saveConfirm: 'Confirm save',
        original: 'Original',
        modified: 'Modified',
        confirmSave: 'Save anyway',
        group: 'Group',
        clearAudit: 'Clear trail',
        closeTab: 'Close tab',
        confirmPick: 'Use this directory',
        pickDir: 'Pick a remote directory',
        browse: 'Browse',
        git: 'Git',
        branch: 'Branch',
        changes: 'Changed files',
        lastCommit: 'Last commit',
        notRepo: 'Not a Git repository',
        page: 'page',
        confirmRemove: 'Click again to delete'
      }
    };

    const CSS = `
.rh-app{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);
  font-size:13px;line-height:1.45;background:var(--dsw-alias-bg-base);}
.rh-header{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);}
.rh-header h2{margin:0;font-size:14px;font-weight:600;}
.rh-header .rh-sub{color:var(--dsw-alias-label-secondary);font-size:12px;}
.rh-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none;}
.rh-dot.on{background:var(--dsw-alias-state-success-primary);}
.rh-dot.err{background:var(--dsw-alias-state-error-primary);}
.rh-body{flex:1;display:flex;min-height:0;}
.rh-aside{width:230px;flex:none;display:flex;flex-direction:column;border-right:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-specific-sidebar-fill);min-height:0;}
.rh-aside-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px 6px;
  font-size:12px;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.04em;}
.rh-conn-list{flex:1;overflow:auto;padding:0 8px 8px;min-height:0;}
.rh-conn{display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:1px solid transparent;border-radius:8px;
  background:none;padding:7px 8px;cursor:pointer;color:inherit;font:inherit;}
.rh-conn:hover{background:var(--dsw-alias-bg-layer-1);}
.rh-conn.sel{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2);}
.rh-conn .rh-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;}
.rh-conn .rh-host{color:var(--dsw-alias-label-secondary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.rh-iconbtn{border:none;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:6px;
  padding:2px 4px;font-size:12px;line-height:1;flex:none;}
.rh-iconbtn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);}
.rh-iconbtn.danger:hover{color:var(--dsw-alias-state-error-primary);}
.rh-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  border-radius:8px;padding:5px 10px;cursor:pointer;font:inherit;font-size:12px;white-space:nowrap;}
.rh-btn:hover{background:var(--dsw-alias-bg-layer-2);}
.rh-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff;}
.rh-btn.danger{color:var(--dsw-alias-state-error-primary);}
.rh-btn:disabled{opacity:.5;cursor:default;}
.rh-main{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;}
.rh-toolbar{display:flex;align-items:center;gap:6px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap;}
.rh-path{flex:1;min-width:160px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 9px;
  background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}
.rh-path:focus{outline:none;border-color:var(--dsw-alias-brand-primary);}
.rh-files{flex:1;overflow:auto;min-height:0;}
.rh-table{width:100%;border-collapse:collapse;}
.rh-table th{position:sticky;top:0;text-align:left;font-weight:500;font-size:11px;color:var(--dsw-alias-label-secondary);
  padding:6px 10px;background:var(--dsw-alias-bg-base);border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap;}
.rh-table td{padding:5px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap;}
.rh-row:hover td{background:var(--dsw-alias-bg-layer-1);}
.rh-filebtn{border:none;background:none;color:inherit;font:inherit;cursor:pointer;padding:0;text-align:left;}
.rh-filebtn:hover{color:var(--dsw-alias-brand-primary);text-decoration:underline;}
.rh-dim{color:var(--dsw-alias-label-secondary);}
.rh-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;}
.rh-editor{border-top:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;min-height:0;}
.rh-editor-head{display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);}
.rh-editor-head .rh-file{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;}
.rh-editor textarea{flex:1;resize:none;border:none;padding:10px 12px;background:var(--dsw-alias-bg-layer-1);
  color:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.5;min-height:0;}
.rh-editor textarea:focus{outline:none;}
.rh-note{padding:4px 12px 8px;font-size:12px;color:var(--dsw-alias-state-warn-primary);}
.rh-empty{padding:28px;text-align:center;color:var(--dsw-alias-label-secondary);}
.rh-modal{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:60;}
.rh-form{width:400px;max-width:92vw;max-height:88vh;overflow:auto;background:var(--dsw-alias-bg-overlay);
  border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px;}
.rh-form h3{margin:0 0 2px;font-size:14px;}
.rh-field{display:flex;flex-direction:column;gap:4px;}
.rh-field label{font-size:12px;color:var(--dsw-alias-label-secondary);}
.rh-field input,.rh-field textarea,.rh-field select{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;
  padding:6px 9px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;font-size:13px;}
.rh-field textarea{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;min-height:88px;resize:vertical;}
.rh-field input:focus,.rh-field textarea:focus,.rh-field select:focus{outline:none;border-color:var(--dsw-alias-brand-primary);}
.rh-row2{display:flex;gap:10px;}
.rh-row2 .rh-field{flex:1;}
.rh-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px;}
.rh-error{margin:0 12px;padding:6px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-size:12px;}
.rh-ok{color:var(--dsw-alias-state-success-primary);font-size:12px;}
.rh-inline{display:inline-flex;align-items:center;gap:6px;}
.hl-comment{color:var(--dsw-alias-label-secondary);font-style:italic;}
.hl-string{color:var(--dsw-alias-state-success-primary);}
.hl-number{color:var(--dsw-alias-state-warn-primary);}
.hl-keyword{color:var(--dsw-alias-brand-primary);font-weight:600;}
.rh-iconbtn.armed{background:var(--dsw-alias-state-error-primary);color:#fff;border-color:var(--dsw-alias-state-error-primary);}
.rh-tabs{display:flex;gap:4px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);overflow-x:auto;flex:none;}
.rh-tab{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:inherit;
  border-radius:999px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;}
.rh-tab.sel{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff;}
.rh-tree{width:200px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);overflow:auto;padding:6px;font-size:12px;min-height:0;}
.rh-tree-node{border:none;background:none;color:inherit;font:inherit;cursor:pointer;text-align:left;width:100%;
  padding:2px 4px;border-radius:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.rh-tree-node:hover{background:var(--dsw-alias-bg-layer-1);}
.rh-group{font-size:11px;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.04em;padding:8px 6px 2px;}
`;

    return { DICTS, CSS };
  }
});
