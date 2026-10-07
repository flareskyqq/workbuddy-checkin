/**
 * 安全 I/O 工具：原子写文件 + 单实例锁
 *
 * 借鉴自 babygoton/WorkDaddy 的 `scripts/atomic-file-write.js` 与 `scripts/watchdog.js`。
 *
 * 解决的问题（都是我们踩过的）：
 *  1. `fs.writeFileSync` 直接覆盖 —— 写到一半进程被杀 / 断电，文件就是半截 JSON，
 *     下次读取解析失败。本项目已经为此加过"损坏则备份重来"的兜底，但那是事后补救；
 *     原子写是事前杜绝。
 *  2. 定时任务与手动点击可能同时跑，两个进程各自 read-modify-write 同一份 state.json，
 *     后写的会覆盖先写的。用回环端口做单实例锁，OS 保证进程退出即释放。
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';

/** Windows 上 rename 会被杀软/索引器短暂占用，这几个错误码值得重试 */
const TRANSIENT_CODES = new Set(['UNKNOWN', 'EPERM', 'EACCES', 'EBUSY', 'EMFILE', 'ENFILE']);

const sleepSync = (ms) => {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * 原子替换文件：先写同目录临时文件 → 设权限 → rename 覆盖。
 * rename 在同一文件系统内是原子操作，读者要么看到旧内容、要么看到新内容，不会看到半截。
 */
export function writeFileAtomic(file, content, { mode, fsImpl = fs, platform = process.platform } = {}) {
  const dir = path.dirname(file);
  fsImpl.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const maxAttempts = platform === 'win32' ? 40 : 2;
  let tmpReady = false;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (!tmpReady) {
        fsImpl.writeFileSync(tmp, content, 'utf8');
        if (mode !== undefined) {
          try { fsImpl.chmodSync(tmp, mode); } catch {}
        }
        tmpReady = true;
      }
      fsImpl.renameSync(tmp, file);
      return;
    } catch (e) {
      lastErr = e;
      const retryable = TRANSIENT_CODES.has(e?.code) && attempt < maxAttempts;
      if (!retryable) break;
      if (attempt === 1 && e?.code === 'EPERM') {
        try { fsImpl.chmodSync(file, 0o666); } catch {}
      }
      sleepSync(Math.min(250, 40 + attempt * 10));
    }
  }
  try { fsImpl.unlinkSync(tmp); } catch {}
  throw lastErr;
}

/** 原子写 JSON（自动加缩进与结尾换行，保持与现有文件一致的格式） */
export const writeJsonAtomic = (file, obj, opts = {}) =>
  writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n', opts);

/**
 * 尝试获取回环端口单实例锁。
 * 端口被占 = 已有实例在跑 → 返回 null（调用方应直接退出，不要并发改数据）。
 * 锁归 OS 管，进程退出（含被 kill）自动释放，不会留下死锁文件。
 */
export function acquireSingleInstanceLock(port, { host = '127.0.0.1' } = {}) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (e) => {
      if (e?.code === 'EADDRINUSE') return resolve(null);
      resolve(null);
    });
    server.listen({ host, port, exclusive: true }, () => resolve(server));
  });
}

export const releaseSingleInstanceLock = (server) => {
  try { server?.close(); } catch {}
};

/**
 * 包一层：拿不到锁就跳过执行。
 * @returns {Promise<{ran:boolean, result?:any}>}
 */
export async function runExclusive(port, fn, { onBusy = () => {} } = {}) {
  const lock = await acquireSingleInstanceLock(port);
  if (!lock) { onBusy(); return { ran: false }; }
  try {
    return { ran: true, result: await fn() };
  } finally {
    releaseSingleInstanceLock(lock);
  }
}
