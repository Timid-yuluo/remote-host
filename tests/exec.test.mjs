import { PLUGIN_DIR, importPlugin } from './_paths.mjs';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const requireFromBundle = createRequire(path.join(PLUGIN_DIR, 'package.json'));
const ssh2 = requireFromBundle('ssh2');
const { Server } = ssh2;

const { SshPool } = await importPlugin('lib/ssh.js');

// 每次运行生成一次性主机密钥，避免 /tmp 残留导致签名不匹配
const keyDir = await mkdtemp(path.join(tmpdir(), 'rh-exec-'));
const keyPath = path.join(keyDir, 'hostkey');
execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath, '-q']);
const hostKey = readFileSync(keyPath);

const seen = [];
const server = new Server({ hostKeys: [hostKey] }, (client) => {
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.username === 'tester' && ctx.password === 'pw') return ctx.accept();
    ctx.reject();
  }).on('ready', () => {
    client.on('session', (accept) => {
      const session = accept();
      session.on('sftp', (sftpAccept) => {
        const sftp = sftpAccept();
        sftp.on('REALPATH', (reqid, requestPath) => {
          sftp.name(reqid, [{ filename: requestPath === '.' ? '/' : requestPath, longname: requestPath, attrs: {} }]);
        }).on('CLOSE', (reqid) => {
          sftp.status(reqid, STATUS_CODE.OK);
        });
      });
      session.on('exec', (execAccept, _reject, info) => {
        seen.push(info.command);
        const stream = execAccept();
        if (info.command.includes('sleep')) {
          setTimeout(() => { stream.write('too late\n'); stream.exit(0); stream.end(); }, 4000);
          return;
        }
        if (info.command.startsWith('grep')) {
          stream.write('src/a.js:12:const foo = 1\n');
          stream.write('src/b.js:7:function foo() {}\n');
          stream.exit(0);
          stream.end();
          return;
        }
        stream.write(`ran: ${info.command}\n`);
        stream.stderr.write('');
        stream.exit(0);
        stream.end();
      });
    });
  });
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const port = server.address().port;
const pool = new SshPool();
const profile = { id: 'exec-1', host: '127.0.0.1', port, username: 'tester', authType: 'password', password: 'pw' };

try {
  const plain = await pool.exec(profile, 'echo hi');
  if (!plain.stdout.includes('ran: echo hi') || plain.exitCode !== 0) throw new Error(`exec failed: ${JSON.stringify(plain)}`);
  console.log('1. exec() runs a command OK:', plain.stdout.trim());

  const withCwd = await pool.exec(profile, 'ls', { cwd: '/var/www' });
  if (!seen.some((cmd) => cmd.includes("cd '/var/www' && ls"))) throw new Error(`cwd not applied: ${JSON.stringify(seen)}`);
  console.log('2. exec(cwd) quotes and prefixes cd OK');

  const searched = await pool.search(profile, { pattern: 'foo', path: '/src' });
  if (searched.count !== 2 || searched.matches[0] !== 'src/a.js:12:const foo = 1') throw new Error(`search failed: ${JSON.stringify(searched)}`);
  console.log('3. search() returns grep lines OK:', searched.count, 'matches');

  const quoteTest = await pool.search(profile, { pattern: "a'b", path: '/src' });
  const quoted = seen.find((cmd) => cmd.includes("a") && cmd.includes("grep") && cmd.includes("'b'"));
  if (quoted === undefined || !quoted.includes("\\'")) throw new Error(`pattern not shell-quoted: ${JSON.stringify(seen)}`);
  console.log('4. search() shell-quotes the pattern OK');

  const started = Date.now();
  const timedOut = await pool.exec(profile, 'sleep 10', { timeoutMs: 200 });
  if (timedOut.timedOut !== true) throw new Error(`timeout not reported: ${JSON.stringify(timedOut)}`);
  if (Date.now() - started > 2000) throw new Error('timeout did not bound the call');
  console.log('5. exec() timeout bounded OK:', Date.now() - started, 'ms');

  pool.disconnect(profile.id);
  console.log('EXEC / SEARCH TESTS PASS');
} finally {
  server.close();
}