import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { acquireProcessLock, isLiveRenderProcess, releaseProcessLock } from '../src/process-lock.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fakeRender() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'narrative-render-proc-'));
  const script = path.join(dir, 'scripts/render.mjs');
  await mkdir(path.dirname(script), { recursive: true });
  await writeFile(script, 'setInterval(() => {}, 1 << 30);\n');
  const child = spawn(process.execPath, [script], { detached: true, stdio: 'ignore' });
  for (let i = 0; i < 50 && !isLiveRenderProcess(child.pid); i++) await sleep(10);
  return { pid: child.pid, async stop() {
    try { if (isLiveRenderProcess(child.pid)) child.kill('SIGKILL'); } catch {}
    if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => child.once('exit', resolve));
    await rm(dir, { recursive: true, force: true });
  } };
}

test('a dead or invalid render lock is replaced and a live lock is kept', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'narrative-lock-'));
  const lockPath = path.join(dir, 'video.mp4.render.lock');
  const sleeper = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  sleeper.unref();
  try {
    await writeFile(lockPath, JSON.stringify({ pid: 99999999, startedAt: '2026-01-01' }));
    const handle = await acquireProcessLock(lockPath);
    assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).pid, process.pid);
    await writeFile(lockPath, JSON.stringify({ pid: sleeper.pid }));
    await releaseProcessLock(handle, lockPath);
    assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).pid, sleeper.pid);
    await assert.rejects(acquireProcessLock(lockPath), /live process/);
    assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).pid, sleeper.pid);
    await writeFile(lockPath, '{');
    const replaced = await acquireProcessLock(lockPath);
    assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).pid, process.pid);
    await releaseProcessLock(replaced, lockPath);
    await assert.rejects(readFile(lockPath, 'utf8'), { code: 'ENOENT' });
  } finally {
    try { process.kill(sleeper.pid, 'SIGKILL'); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});

test('only a live scripts/render.mjs process counts as the narrative renderer', async () => {
  const sleeper = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  sleeper.unref();
  const renderer = await fakeRender();
  try {
    assert.equal(isLiveRenderProcess(sleeper.pid), false);
    assert.equal(isLiveRenderProcess(process.pid), false);
    assert.equal(isLiveRenderProcess(renderer.pid), true);
    assert.equal(isLiveRenderProcess(99999999), false);
  } finally {
    try { process.kill(sleeper.pid, 'SIGKILL'); } catch {}
    await renderer.stop();
  }
});
