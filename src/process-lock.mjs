import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/** Linux records the renderer as scripts/render.mjs. Without /proc, a live pid is trusted. */
export function isLiveRenderProcess(pid) {
  if (!pidAlive(pid)) return false;
  if (!existsSync('/proc')) return true;
  try {
    const args = readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').filter(Boolean);
    return args.some((arg) => arg.replaceAll('\\', '/').endsWith('scripts/render.mjs'));
  } catch { return false; }
}

async function readLock(lockPath) {
  try {
    const text = await readFile(lockPath, 'utf8');
    const parsed = JSON.parse(text);
    if (!parsed || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return { stale: true, text };
    return { stale: false, pid: parsed.pid, text };
  } catch (error) {
    if (error.code === 'ENOENT') return { missing: true };
    return { stale: true, text: null };
  }
}

/**
 * Exclusive pid lock. A lock whose process is gone is removed; a live pid is left untouched.
 * The returned handle is held until releaseProcessLock().
 */
export async function acquireProcessLock(lockPath, { isAlive = pidAlive, attempts = 4 } = {}) {
  await mkdir(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const handle = await open(lockPath, 'wx');
      const record = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
      try { await handle.writeFile(record); }
      catch (error) {
        await handle.close();
        await rm(lockPath, { force: true });
        throw error;
      }
      const current = await readLock(lockPath);
      if (current.pid === process.pid) return handle;
      await handle.close();
      continue;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const current = await readLock(lockPath);
    if (current.missing) continue;
    if (!current.stale && isAlive(current.pid)) {
      const error = new Error(`Output is locked by live process ${current.pid}: ${lockPath}. Wait for that render to finish. If that process is stuck, stop it and retry.`);
      error.code = 'ELOCKED';
      throw error;
    }
    const again = await readLock(lockPath);
    if (again.missing) continue;
    if (again.text !== current.text) continue;
    await rm(lockPath, { force: true });
  }
  const error = new Error(`Output is locked: ${lockPath}. Retry after the current render exits.`);
  error.code = 'ELOCKED';
  throw error;
}

/** Remove the lock only when it still names this process. */
export async function releaseProcessLock(handle, lockPath) {
  await handle?.close().catch(() => {});
  try {
    const current = JSON.parse(await readFile(lockPath, 'utf8'));
    if (current?.pid === process.pid) await rm(lockPath, { force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
