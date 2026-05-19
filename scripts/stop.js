import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pidFiles = [join(root, '.pid'), join(root, '.app.pid')];
const port = process.env.PORT || 3000;
const isWindows = process.platform === 'win32';

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function killPid(pid) {
  if (!isRunning(pid)) return;

  if (isWindows) {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      if (isRunning(pid)) throw new Error(`无法关闭进程 ${pid}`);
    }
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    if (!isRunning(pid)) return;
    throw new Error(`无法关闭进程 ${pid}`);
  }

  let waited = 0;
  while (isRunning(pid) && waited < 1000) {
    sleep(100);
    waited += 100;
  }

  if (isRunning(pid)) {
    process.kill(pid, 'SIGKILL');
  }
}

function killByPidFiles() {
  let killed = false;
  for (const pidFile of pidFiles) {
    if (!existsSync(pidFile)) continue;

    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0) {
      unlinkSync(pidFile);
      continue;
    }

    if (!isRunning(pid)) {
      unlinkSync(pidFile);
      continue;
    }

    killPid(pid);
    unlinkSync(pidFile);
    killed = true;
  }
  return killed;
}

function getPidsOnPort() {
  if (isWindows) return getWindowsPidsOnPort();

  try {
    const out = execFileSync('lsof', [`-ti:${port}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim().split('\n').map(Number).filter(p => p > 0);
  } catch {
    return [];
  }
}

function getWindowsPidsOnPort() {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });

    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5 || parts[0] !== 'TCP') continue;

      const [, localAddress, , state, pid] = parts;
      if (state !== 'LISTENING') continue;

      const localPort = localAddress.match(/:(\d+)$/)?.[1];
      if (localPort === String(port)) pids.add(Number(pid));
    }

    return [...pids].filter(p => p > 0);
  } catch {
    return [];
  }
}

function killByPort() {
  const pids = getPidsOnPort();
  if (pids.length === 0) return false;

  for (const pid of pids) {
    killPid(pid);
  }
  return true;
}

// 主逻辑
if (killByPidFiles()) {
  console.log('服务已关闭');
  process.exit(0);
}

if (killByPort()) {
  for (const pidFile of pidFiles) {
    try { unlinkSync(pidFile); } catch {}
  }
  console.log('服务已关闭（通过端口查找）');
  process.exit(0);
}

console.log('未找到正在运行的服务');
