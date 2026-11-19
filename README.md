# 远程主机（Remote Host）

在 DeepSeek Harness 里通过 SSH 连接远程主机：浏览与编辑远程文件、执行命令、把某个对话绑定到一台主机的目录上，并把这些连接（含加密保存的凭据）长期留在本机。

三个入口：

- 侧栏图标 → **远程主机** 面板（文件管理器式操作）
- 新建会话行 → **🌐 远程主机** 按钮（把本次对话绑到某台主机的目录）
- Agent 工具 **`remote_fs`**（让模型直接读写远程文件、跑命令）

---

## 一、功能一览

### 连接管理
- 新建 / 编辑 / 删除连接，支持**密码**与**私钥**（含私钥口令）两种认证
- 连接**分组**与搜索（名称 / 用户名 / 主机 / 分组）
- **跳板机**：指定另一台连接作为 ProxyJump 隧道
- **导入 `~/.ssh/config`**：解析 Host / HostName / User / Port / IdentityFile，点选即建
- **导出 / 导入连接**：口令派生密钥（PBKDF2-SHA256 10 万次 + AES-256-GCM）加密整包，可跨机迁移
- **连接测试**、**健康探测**（面板圆点：绿=已连、红=已断、灰=未连）
- 空闲 30 分钟自动断开会话

### 文件操作
- 目录浏览（分页，每页 200）、懒加载**目录树**、多主机**标签页**
- 打开 / 编辑文件，**行号** + **语法高亮**（注释 / 字符串 / 数字 / 关键字），超大文件自动降级
- 保存前 **diff 对照**，可切换「对比本地文件」
- 写入自动生成 `<file>.bak`，面板 `↺` 一键恢复
- 上传（点选 / 拖拽 / **>4MB 自动分块**带进度）、下载、批量删除
- 改权限（`🔑` 八进制）、重命名、目录占用统计
- 拖拽移动：文件 / 目录拖到树节点或文件区即移动
- **多缓冲编辑**：切文件时未保存内容进入暂存 chip 行，不会丢

### 命令与网络
- 命令面板 `⌘`：执行远程命令，回显 stdout / stderr / 退出码，**历史记录**可复用
- 远程 `grep` 搜索（结果可点击直达文件）
- **Git 面板**：分支、变更列表、最近提交
- **系统信息**：内核、登录用户、磁盘、运行时长、CPU 核数
- **端口转发**：`127.0.0.1:本地端口 → 远程主机:端口`，用于本地连远程数据库等

### 远程工作区
- **默认工作区**：一台主机的某个目录（面板 `★`）
- **会话绑定**：每个对话可绑定自己的远程目录，新建会话行直接选
- 重开对话时 `agent/created` 自动重连
- 工具栏可查看 / 解除全部会话绑定

---

## 二、安装与启用

插件以 DSH bundle 形式安装（本地目录即可）：

```
# 已安装：在插件管理器里「关闭 → 开启」即可重载最新代码
# 首次安装：plugin_manager install_bundle(target = 本项目路径)
```

安装后 **刷新页面（Cmd+Shift+R）**，侧栏出现服务器图标。

> 客户端分两部分：`client.js`（行为）与 `client.parts.js`（样式 + 文案分包）。分包加载失败会降级为无样式继续运行，不会白屏。

---

## 三、使用说明

### 1. 添加第一台主机
侧栏「远程主机」→ 连接列表底部「+ 新建连接」→ 填名称、主机、端口、用户名、密码或私钥 → 保存。
保存后点连接即建立 SSH 会话，右侧进入文件浏览。

### 2. 把对话绑到远程目录
- 方式 A：新建会话界面点 **🌐 远程主机** → 选连接 → `📂 浏览` 选目录 → 绑定并连接
- 方式 B：面板里点 `📂 选择远程目录` 定位好，再 `★` 设为默认工作区
- 之后该对话里，模型无需指定连接即可直接操作该目录

> Harness 原生工作区（会话 cwd、本地 bash）始终指向本机；远程路径通过 `remote_fs` 工具访问，表现为「这个对话在这台远程主机上干活」。

### 3. 让模型操作远程文件
直接说需求即可，例如「看看 /www/wwwroot/site 下有哪些文件并跑一下 df -h」。
模型会调用 `remote_fs`，省略 `connection` / `path` 时按「会话绑定 → 默认工作区」回退。

### 4. 凭据库主口令（可选）
侧栏底部输入主口令 →「设置主口令」：
- 所有密码 / 私钥改用 PBKDF2-SHA256（12 万次）派生钥匙加密，并**全量迁移**
- 之后每次启动处于锁定态，需输入主口令解锁
- 可「立即加锁」、「取消主口令」（回退到文件密钥）

> **主口令丢失，已加密的密码与私钥无法恢复。** 请自行保管。

---

## 四、安全模型

| 项 | 做法 |
|---|---|
| 凭据落盘 | 每字段 AES-256-GCM，格式 `enc1.<iv>.<tag>.<data>`；文件密钥 32 字节存 `.secret.key`（0600） |
| 主口令（可选） | PBKDF2-SHA256 12 万次派生，密钥只在内存，进程结束即失效 |
| 主机密钥 | 首次连接记录 `SHA256:` 指纹（TOFU）；之后不匹配**拒绝连接**并提示可能存在中间人攻击；可手动重置 |
| 写操作 | 自动备份 `.bak`；删除目录需显式 `recursive` |
| 危险操作确认 | 单文件删除需二次点击（按钮变红 3 秒内再点） |
| 审计 | 面板与 agent 的所有写操作记入 `audit.jsonl`（0600），成功 / 失败都留痕，每 100 条轮转保留最近 5000 行，可导出 |
| 数据位置 | `~/.dsh/remote-host-store/`：`connections.json`、`bindings.json`、`audit.jsonl`、`vault.json`、`.secret.key` |

---

## 五、Agent 工具 `remote_fs`

| action | 说明 | 主要参数 |
|---|---|---|
| `list_connections` | 列出已保存连接（不含凭据） | — |
| `connect` | 建立 / 复用会话 | `connection` |
| `list` | 列目录（类型、大小、权限、时间） | `path` |
| `read` | 读文本；支持按行分段 | `path`、`offset`、`limit` |
| `write` | 写文本（自动备份） | `path`、`content` |
| `mkdir` / `remove` / `rename` | 建目录 / 删除（目录需 `recursive`）/ 改名 | `path`、`to`、`recursive` |
| `stat` | 属性 | `path` |
| `exec` | 执行命令（含超时与输出上限） | `command`、`cwd`、`timeoutMs` |
| `search` | 远程 `grep` | `pattern`、`path` |
| `chmod` | 改权限 | `path`、`mode` |
| `du` | 目录占用 | `path` |
| `git` | 分支 / 变更 / 最近提交 | `path` |
| `tunnel` | 开 / 关本地端口转发 | `localPort`、`remoteHost`、`remotePort`、`close`、`key` |
| `bind` / `unbind` | 绑定 / 解绑当前对话的远程目录 | `connection`、`path` |
| `workspace` | 查看当前会话的绑定 | — |

---

## 六、RPC 端点（面板 ↔ Host）

前缀 `/remote-host-api`，走 `connection.rpc` 或普通 `POST`，返回 `{ ok, value } | { ok: false, error }`。

```
connections.list | save | delete | test | resetHostKey
connections.export | import | importSshConfig
session.connect | disconnect | status
fs.list | read | write | mkdir | stat | rename | delete | chmod
fs.upload | uploadChunk | download | du | search
exec.run | git.info | sys.info
tunnel.open | close | list
vault.status | enable | unlock | lock | disable
audit.list | clear | export
workspace.get | setDefault | clearDefault
binding.set | get | clear
```

---

## 七、代码结构

```
remote-host-plugin/
├─ entry.js            Host 薄入口（动态 import app.js，改代码免重启）
├─ app.js              Host 实现：RPC 路由、工具、审计、隧道、凭据库对外接口
├─ client.js           面板（slot 注册 + 组件 + 交互）
├─ client.parts.js     样式与双语文案分包（require.async 加载）
├─ lib/
│  ├─ store.js         连接存储（AES-256-GCM、主口令、指纹、迁移）
│  ├─ ssh.js           SSH 连接池（单飞建连、跳板机、重连、SFTP / exec）
│  ├─ bindings.js      工作区与会话绑定
│  └─ audit.js         审计日志（JSONL、轮转）
├─ cordis.patch.yml    bundle 装配行
├─ locale/             zh.json / en.json（面板标题）
└─ icon.svg
```

实现要点：

- 客户端入口必须是 `client.js`；分包名须匹配 `client.<name>.js`，模块 id 为 `<包名>/<文件名>`
- 依赖 `ssh2@1.17`；连接池对同一连接的并发调用共享一次建连（单飞），传输层错误自动重连一次
- 所有资源注册走 `ctx.effect()`，插件卸载时清理会话、隧道与定时器

---

## 八、测试

```bash
cd remote-host-tests
node store.test.mjs        # 存储与加密
node store.fix.test.mjs    # 空口令编辑保留密钥、lastPath
node vault.test.mjs        # 主口令：迁移 / 锁定 / 错误口令 / 关闭还原
node ssh.test.mjs          # SSH 模块单元
node ssh.e2e.mjs           # 真机 e2e：连通 / 读写 / 权限 / 递归删 / 指纹 / 密钥认证 / 重连
node rpc.e2e.test.mjs      # RPC 端到端（证明密码确实解密到 SSH 层）
node exec.test.mjs         # exec 超时与输出上限、grep 引号转义
node workspace.test.mjs    # 默认工作区与会话绑定
node extras.test.mjs       # 分组 / 审计 / 导入导出 / 隧道
node client.smoke.mjs      # 客户端渲染冒烟（桩替换模块系统与 React，驱动事件）
node lint.mjs              # 一致性：语法、端点对齐、文案覆盖、分包契约
```

`lint.mjs` 会拦住三类真实事故：客户端调用了 Host 没有的端点、文案键缺失（界面会显示英文键名）、分包契约不符。

---

## 十一、远程执行世界（真·远程工作目录）

默认情况下会话的工作目录是本机路径，插件通过 `remote_fs` 工具操作远程（工具代理模式）。
如果希望**工作目录本身就是远程路径**——`bash`、`read`、`write`、`edit`、`glob`、`grep` 全在远程执行——可以启用远程 fs 后端。

### 原理

DSH 的 `ctx.fs` 是一个可替换的后端契约，明确支持「remote execution world」：

```
Abstract filesystem provider. Targets must preserve identity across aliases;
resolve()  — a remote/sandboxed backend may need a round-trip to map a path to a stable identity
processPath(target) — the canonical absolute path a subprocess in this
                      filesystem's execution world can open
```

`lib/fs-remote.js` 用 SFTP 实现了这套契约（14 个方法），启用后：

- `workingDirectory.set('/www/wwwroot/site')` 通过校验（`fs.stat` 走远程，路径真实存在）
- 提示里的 cwd、`bash` 的 cwd、文件工具的目标全部是远程路径
- 本地工具不再触碰本机文件

### 启用步骤

1. **停掉本地 fs 后端**（同名服务不能并存）。在 profile 的 `cordis.patch.yml` 加：

```yaml
- id: fs-sandbox
  disabled: true
```

2. **给插件传配置**（同一个文件里的 insert 行）：

```yaml
- insert:
    - id: remote-host
      name: "@local/remote-host"
      config:
        remoteFs:
          enabled: true
          connection: 腾讯云渡鸦    # 可选；省略时用默认工作区的连接
```

3. 重启 DSH（或重载插件）。

### 回滚

删掉上面两段配置即可——`fs-sandbox` 会重新接管，插件回到「工具代理模式」，绑定的远程目录依然可用 `remote_fs` 访问。

> 注意：这一步替换的是**整个进程**的文件系统后端。若远程不可达，依赖 `ctx.fs` 的工具会失败。生产使用前请确认连接凭据可用（面板里先测一次连接）。

### 已知限制

- 不支持目录监听（`watch` 显式拒绝，与契约基类的行为一致）
- 原子写依赖服务器的 `posix-rename@openssh.com` 扩展；不支持时退回「先删后改名」
- SFTP 不提供 inode，`FsVersion` 由 `mtime:size:mode` 推导，极端并发下弱于本地后端

---

## 九、已知限制

- 主口令丢失 → 已加密凭据不可恢复
- 跳板机仅支持一级
- 分块上传按 4MB 切片，不校验远端已存在内容
- 大量文件按页浏览（每页 200），未做虚拟滚动
- 远程目录不能作为 Harness 原生工作区（会话 cwd 恒为本机）
- `client.parts.js` 的运行时取用依赖 DSH 分包机制；HTTP 资源需鉴权，无法在命令行侧直接验证

---

## 十、变更记录（摘要）

| 轮次 | 内容 |
|---|---|
| 1–5 | 基础连接、文件浏览 / 编辑、保存前 diff、远程工作区绑定 |
| 6–8 | 上传下载、权限、批量操作、命令面板、审计、导入导出、隧道、标签页、目录树 |
| 9–10 | 远程目录选择器、拖拽移动、分页、路径补全、Git 面板、行号与语法高亮 |
| 11–12 | 代码重构：单飞建连、断线重连、Modal 复用、分包拆分、客户端冒烟测试、lint |
| 13–14 | 主机指纹（TOFU）、密钥认证验证、跳板机、凭据库主口令、分块上传、命令历史、多缓冲编辑、错误上下文 |