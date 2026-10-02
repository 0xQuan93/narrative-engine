import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonical, sha256, jobIdentity, atomicJson, verifyAssets, sourceHashes, reusableReceipt, recoverPublication, executeJob } from '../src/jobs.mjs';

test('canonical identity ignores key ordering but includes changed source and recipe', () => {
  assert.equal(canonical({ b: 2, a: 1 }), canonical({ a: 1, b: 2 }));
  assert.notEqual(jobIdentity({ source: 'a', frame: 1 }), jobIdentity({ source: 'b', frame: 1 }));
  assert.notEqual(jobIdentity({ source: 'a', frame: 1 }), jobIdentity({ source: 'a', frame: 2 }));
});
test('locked assets reject mutation and traversal', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'narrative-assets-'));
  try {
    await mkdir(path.join(dir, 'assets'));
    await writeFile(path.join(dir, 'assets/a.vrm'), 'avatar');
    const asset = { file: 'assets/a.vrm', bytes: 6, sha256: sha256('avatar') };
    const lock = { schema: 'narrative-assets/0.1', assets: { actor: asset } };
    assert.deepEqual(await verifyAssets(lock, dir, ['actor']), { actor: asset });
    await writeFile(path.join(dir, 'assets/a.vrm'), 'broken');
    await assert.rejects(verifyAssets(lock, dir, ['actor']), /mismatch/);
    asset.file = '../outside.vrm';
    await assert.rejects(verifyAssets(lock, dir, ['actor']), /Unsafe/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('renderer source and dependency lock mutations invalidate identity', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'narrative-sources-'));
  try {
    await mkdir(path.join(dir, 'src'));
    await mkdir(path.join(dir, 'scripts'));
    await writeFile(path.join(dir, 'src/renderer.jsx'), 'version-one');
    await writeFile(path.join(dir, 'package.json'), '{}');
    await writeFile(path.join(dir, 'package-lock.json'), 'lock-one');
    const first = jobIdentity(await sourceHashes(dir));
    await writeFile(path.join(dir, 'package-lock.json'), 'lock-two');
    const second = jobIdentity(await sourceHashes(dir));
    assert.notEqual(first, second);
    await writeFile(path.join(dir, 'src/renderer.jsx'), 'version-two');
    assert.notEqual(second, jobIdentity(await sourceHashes(dir)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('completed output reuse verifies identity and actual bytes; failed replacement preserves artifact', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'narrative-job-'));
  const out = path.join(dir, 'film.mp4');
  try {
    const receipt = await executeJob({ outputPath: out, identity: 'a', inputs: { version: 1 }, render: (file) => writeFile(file, 'good-video') });
    assert.equal(receipt.status, 'completed');
    assert.equal((await reusableReceipt(`${out}.receipt.json`, out, 'a')).identity, 'a');
    assert.equal(await reusableReceipt(`${out}.receipt.json`, out, 'b'), null);
    await assert.rejects(executeJob({ outputPath: out, identity: 'b', inputs: {}, render: async (file) => { await writeFile(file, 'partial'); throw new Error('worker failed'); } }), /worker failed/);
    assert.equal(await readFile(out, 'utf8'), 'good-video');
    assert.equal(JSON.parse(await readFile(`${out}.receipt.json`)).identity, 'a');
    await writeFile(out, 'tampered');
    assert.equal(await reusableReceipt(`${out}.receipt.json`, out, 'a'), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('first failure persists and post-render input change prevents publication', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'narrative-failure-'));
  const out = path.join(dir, 'film.mp4');
  try {
    await atomicJson(path.join(dir, 'nested/data.json'), { ready: true });
    await assert.rejects(executeJob({ outputPath: out, identity: 'a', inputs: {}, render: (file) => writeFile(file, 'video'), verifyUnchanged: async () => { throw new Error('changed'); } }), /changed/);
    assert.equal(JSON.parse(await readFile(`${out}.receipt.json`)).status, 'failed');
    await assert.rejects(readFile(out), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('receipt publication failures restore the previous output and completed receipt pair', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'narrative-rollback-'));
  const out = path.join(dir, 'film.mp4');
  try {
    await executeJob({ outputPath: out, identity: 'old', inputs: {}, render: (file) => writeFile(file, 'old-video') });
    for (const failAttempt of [false, true]) {
      await assert.rejects(executeJob({ outputPath: out, identity: 'new', inputs: {}, render: (file) => writeFile(file, 'new-video'), persist: async (file, value) => {
        if (value.status === 'completed' && (failAttempt ? file !== `${out}.receipt.json` : file === `${out}.receipt.json`)) throw new Error('disk receipt failure');
        await atomicJson(file, value);
      } }), /disk receipt failure/);
      assert.equal(await readFile(out, 'utf8'), 'old-video');
      assert.equal((await reusableReceipt(`${out}.receipt.json`, out, 'old')).status, 'completed');
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('interrupted publication restores backups before cache lookup', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'narrative-recover-'));
  const out = path.join(dir, 'film.mp4');
  const attemptId = '00000000-0000-4000-8000-000000000000';
  try {
    await executeJob({ outputPath: out, identity: 'old', inputs: {}, render: (file) => writeFile(file, 'old-video') });
    const outputBackup = `${out}.${attemptId}.output.bak`, receiptBackup = `${out}.${attemptId}.receipt.bak`;
    await writeFile(outputBackup, await readFile(out));
    await writeFile(receiptBackup, await readFile(`${out}.receipt.json`));
    await atomicJson(`${out}.publication.json`, { outputPath: out, attemptId, identity: 'new', outputBackup, receiptBackup });
    await writeFile(out, 'new-video-without-receipt');
    await recoverPublication(out);
    assert.equal((await reusableReceipt(`${out}.receipt.json`, out, 'old')).status, 'completed');
    await assert.rejects(readFile(`${out}.publication.json`), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('unrelated locked entries do not affect selected asset identity or readiness', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'narrative-selected-'));
  try {
    await writeFile(path.join(dir, 'actor.vrm'), 'avatar');
    const lock = { schema: 'narrative-assets/0.1', assets: { actor: { file: 'actor.vrm', bytes: 6, sha256: sha256('avatar') } } };
    const before = jobIdentity(await verifyAssets(lock, dir, ['actor']));
    lock.assets.unrelated = { file: 'missing.vrm', bytes: 123, sha256: 'a'.repeat(64) };
    assert.equal(jobIdentity(await verifyAssets(lock, dir, ['actor'])), before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
