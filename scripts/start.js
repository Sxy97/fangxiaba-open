import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from './load-env.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
loadDotEnv(root);

const legacyPidFile = join(root, '.pid');
const appPidFile = join(root, '.app.pid');
const logsDir = join(root, 'logs');

for (const pidFile of [legacyPidFile, appPidFile]) {
  if (!existsSync(pidFile)) continue;
  const oldPid = Number(readFileSync(pidFile, 'utf8').trim());
  if (Number.isInteger(oldPid) && oldPid > 0 && isProcessRunning(oldPid)) {
    console.error('服务可能已经在运行。如需重启，请先执行 npm stop。');
    process.exit(1);
  }
  unlinkSync(pidFile);
}

const buildAssets = spawnSync(process.execPath, [join(root, 'scripts', 'build-assets.js')], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
});

if (buildAssets.error) {
  console.error(`资源构建启动失败: ${buildAssets.error.message}`);
  process.exit(1);
}

if (buildAssets.status !== 0) {
  process.exit(buildAssets.status || 1);
}

const tscCli = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const buildServer = spawnSync(process.execPath, [tscCli], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
});

if (buildServer.error) {
  console.error(`构建启动失败: ${buildServer.error.message}`);
  process.exit(1);
}

if (buildServer.status !== 0) {
  process.exit(buildServer.status || 1);
}

mkdirSync(logsDir, { recursive: true });
const app = startProcess('app', 'server.js', appPidFile);

console.log(`服务已后台启动: http://localhost:${process.env.PORT || 3000}`);
console.log(`PID: ${app.pid}`);

function startProcess(name, entry, pidFile) {
  const out = openSync(join(logsDir, `${name}.out.log`), 'a');
  const err = openSync(join(logsDir, `${name}.err.log`), 'a');
  const child = spawn(process.execPath, [join(root, 'dist', entry)], {
    cwd: root,
    detached: true,
    stdio: ['ignore', out, err],
    windowsHide: true,
  });
  writeFileSync(pidFile, String(child.pid), 'utf8');
  child.unref();
  return child;
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
